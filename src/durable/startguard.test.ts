// The restore guard (T5.3a): the S3 counter's decision, its retries, and the
// conditional write that keeps the higher number when two instances start at
// once. The memory store has S3's conditional-write rules, so everything here is
// the real code path; the MinIO case at the end proves the same race against the
// store the app really uses.
import { describe, expect, it } from "vitest";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { createStartGuard, epochKey, type StartGuard } from "./startguard.ts";

/** A guard over a fresh store, with the log a test reads its warnings from. */
function guardOn(
	store: ObjectStore,
	options: {
		instance?: string;
		restoreId?: string;
		signal?: AbortSignal;
		sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	} = {},
): { guard: StartGuard; lines: string[] } {
	const { log, lines } = createTestLog({ level: "debug" });
	const guard = createStartGuard({
		store,
		instance: options.instance ?? "dev",
		restoreId: options.restoreId ?? "",
		log,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		...(options.sleep === undefined ? {} : { sleep: options.sleep }),
	});
	return { guard, lines };
}

/** until polls for a line another promise writes, so the tests need no fake clock. */
async function until(done: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (Date.now() < deadline) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** logged are the lines with one msg, parsed. */
function logged(lines: string[], msg: string): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg);
}

/** body is what the counter object holds, as text. */
async function body(store: ObjectStore, instance = "dev"): Promise<string> {
	const got = await store.get(epochKey(instance));
	return new TextDecoder().decode(got.body);
}

/** seed writes one counter object unconditionally, as another instance would. */
async function seed(store: ObjectStore, starts: number, instance = "dev"): Promise<string> {
	return await store.put(
		epochKey(instance),
		new TextEncoder().encode(JSON.stringify({ schema: 1, starts, at: "2026-11-11T09:00:00Z" })),
		null,
	);
}

/** ticking is a store whose reads fail the first `failures` times, then work. */
function faulty(store: ObjectStore, failures: number, error: () => Error): ObjectStore {
	let left = failures;
	return {
		...store,
		get: async (key, signal) => {
			if (left > 0) {
				left--;
				throw error();
			}
			return await store.get(key, signal);
		},
	};
}

describe("the start guard's decision", () => {
	it("treats a missing counter as 0 and a new database as no restore", async () => {
		const store = createMemoryStore();
		const { guard, lines } = guardOn(store);
		expect(await guard.check({ starts: 0, restoreId: "" })).toEqual({ restore: false, starts: 1, restoreId: "" });
		// A missing object is not a failure: nothing is warned, and nothing is retried.
		expect(lines).toEqual([]);
	});

	it("records the start in Go's field order, with the time to the second", async () => {
		const store = createMemoryStore();
		const { guard } = guardOn(store);
		await guard.check({ starts: 0, restoreId: "" });
		await guard.committed(1);
		expect(await body(store)).toMatch(/^\{"schema":1,"starts":1,"at":"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ"\}$/);
	});

	it("is not a restore when the counters are equal, and carries the next number", async () => {
		const store = createMemoryStore();
		await seed(store, 4);
		const { guard } = guardOn(store);
		expect(await guard.check({ starts: 4, restoreId: "" })).toEqual({ restore: false, starts: 5, restoreId: "" });
	});

	it("reports a restore by counter when SQLite is behind S3", async () => {
		const store = createMemoryStore();
		await seed(store, 7);
		const { guard } = guardOn(store);
		// The snapshot's database last acknowledged start 3; S3 has seen 7.
		expect(await guard.check({ starts: 3, restoreId: "" })).toEqual({ restore: "counter", starts: 8, restoreId: "" });
	});

	it("reports a restore by id when the environment's id differs, and records it", async () => {
		const store = createMemoryStore();
		await seed(store, 2);
		const { guard } = guardOn(store, { restoreId: "r1" });
		expect(await guard.check({ starts: 2, restoreId: "" })).toEqual({ restore: "id", starts: 3, restoreId: "r1" });
	});

	it("is a normal start when the id is the one this database recorded", async () => {
		const store = createMemoryStore();
		await seed(store, 2);
		const { guard } = guardOn(store, { restoreId: "r1" });
		expect(await guard.check({ starts: 2, restoreId: "r1" })).toEqual({ restore: false, starts: 3, restoreId: "r1" });
	});

	it("keeps the recorded id when the environment has none", async () => {
		const store = createMemoryStore();
		const { guard } = guardOn(store, { restoreId: "" });
		expect(await guard.check({ starts: 1, restoreId: "r1" })).toEqual({ restore: false, starts: 2, restoreId: "r1" });
	});

	it("never calls a new database a restore, even with S3 far ahead", async () => {
		const store = createMemoryStore();
		await seed(store, 9);
		const { guard } = guardOn(store, { restoreId: "r1" });
		// S3 ahead and a different id both say "restored", but a database with no
		// start of its own has nothing to lose: it takes the higher number instead.
		expect(await guard.check({ starts: 0, restoreId: "" })).toEqual({ restore: false, starts: 10, restoreId: "r1" });
	});

	it("keeps dev's and prod's counters apart", async () => {
		const store = createMemoryStore();
		const dev = guardOn(store, { instance: "dev" }).guard;
		await dev.check({ starts: 0, restoreId: "" });
		await dev.committed(1);

		// prod's object does not exist yet, so prod's twice-started database is not
		// behind anything: the two deployments never read each other's counter.
		const prod = guardOn(store, { instance: "prod" }).guard;
		expect(await prod.check({ starts: 2, restoreId: "" })).toEqual({ restore: false, starts: 3, restoreId: "" });
		await prod.committed(3);
		expect(await body(store, "dev")).toContain('"starts":1');
		expect(await body(store, "prod")).toContain('"starts":3');
	});
});

describe("the start guard's write", () => {
	it("keeps the higher number when another instance started in between", async () => {
		const store = createMemoryStore();
		await seed(store, 2);
		const { guard } = guardOn(store);
		// This start read 2 and would write 3.
		expect(await guard.check({ starts: 2, restoreId: "" })).toMatchObject({ starts: 3 });
		// The other instance started first and moved the object to 9, so this write
		// loses its precondition: the retry re-reads and keeps the higher number.
		const current = await store.get(epochKey("dev"));
		await store.put(epochKey("dev"), new TextEncoder().encode('{"schema":1,"starts":9}'), current.etag);
		await guard.committed(3);
		expect(await body(store)).toContain('"starts":9');
	});

	it("warns and keeps going when the write fails for another reason", async () => {
		const store: ObjectStore = {
			...createMemoryStore(),
			put: async () => {
				throw new Error("S3 is down");
			},
		};
		const { guard, lines } = guardOn(store);
		await guard.check({ starts: 0, restoreId: "" });
		// SQLite is already ahead of S3 here: the start stands, and the next one heals.
		await guard.committed(1);
		expect(logged(lines, "harness start counter not saved")).toEqual([
			expect.objectContaining({ key: "harness/dev/epoch.json", starts: 1, err: "S3 is down" }),
		]);
	});

	it("warns and returns when the read after a lost precondition fails", async () => {
		const memory = createMemoryStore();
		await seed(memory, 2);
		let reads = 0;
		const store: ObjectStore = {
			...memory,
			get: async (key, signal) => {
				reads += 1;
				// check()'s read works; the one plain retry after the precondition does not.
				if (reads > 1) throw new Error("S3 is down");
				return await memory.get(key, signal);
			},
			put: async () => {
				throw new PreconditionError(epochKey("dev"));
			},
		};
		const { guard, lines } = guardOn(store);
		expect(await guard.check({ starts: 2, restoreId: "" })).toMatchObject({ starts: 3 });
		// A retrying read would hold resume() through an S3 outage: this one warns and
		// returns, and the next start heals it through `max()`.
		await guard.committed(3);
		expect(logged(lines, "harness start counter not saved")).toEqual([
			expect.objectContaining({ key: "harness/dev/epoch.json", starts: 3, err: "S3 is down" }),
		]);
		expect(reads).toBe(2);
	});
});

describe("the start guard's read", () => {
	it("waits 1 s, 2 s and 4 s for a failing read, warning each time", async () => {
		const waits: number[] = [];
		const store = faulty(createMemoryStore(), 3, () => new Error("SlowDown"));
		const { guard, lines } = guardOn(store, {
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		await seed(store, 2);
		// The fourth read answers: SQLite 1 is behind S3's 2, so this is a restore.
		expect(await guard.check({ starts: 1, restoreId: "" })).toEqual({ restore: "counter", starts: 3, restoreId: "" });
		expect(waits).toEqual([1_000, 2_000, 4_000]);
		expect(logged(lines, "harness start counter unreadable")).toEqual([
			expect.objectContaining({ key: "harness/dev/epoch.json", err: "SlowDown", in: 1000 }),
			expect.objectContaining({ in: 2000 }),
			expect.objectContaining({ in: 4000 }),
		]);
	});

	it("caps the wait at 30 s", async () => {
		const waits: number[] = [];
		const store = faulty(createMemoryStore(), 6, () => new Error("SlowDown"));
		const { guard, lines } = guardOn(store, {
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		await seed(store, 0);
		expect(await guard.check({ starts: 1, restoreId: "" })).toEqual({ restore: false, starts: 2, restoreId: "" });
		expect(waits).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
		expect(logged(lines, "harness start counter unreadable").map((line) => line.in)).toEqual(waits);
	});

	it("retries a counter object it cannot read rather than trusting it", async () => {
		const store = createMemoryStore();
		await store.put(epochKey("dev"), new TextEncoder().encode("not json"), null);
		const abort = new AbortController();
		const { guard, lines } = guardOn(store, { signal: abort.signal });
		const pending = guard.check({ starts: 1, restoreId: "" });
		// A damaged object is a read failure, not a 0: guessing would skip a restore, so
		// the read warns and waits — and the shutdown ends that wait at once.
		await until(() => logged(lines, "harness start counter unreadable").length === 1, "the retry's wait");
		expect(logged(lines, "harness start counter unreadable")).toEqual([
			expect.objectContaining({ err: expect.stringContaining("not json") }),
		]);
		abort.abort(new Error("SIGTERM"));
		await expect(pending).rejects.toThrow("aborted");
	});

	it("throws when the start is aborted while it waits", async () => {
		const abort = new AbortController();
		const store = faulty(createMemoryStore(), 1, () => new Error("SlowDown"));
		const { guard, lines } = guardOn(store, { signal: abort.signal });
		const pending = guard.check({ starts: 1, restoreId: "" });
		// The wait is node's own timer, so the abort is what ends it: no fake clock.
		await until(() => logged(lines, "harness start counter unreadable").length === 1, "the retry's wait");
		abort.abort(new Error("SIGTERM"));
		await expect(pending).rejects.toThrow("the harness start counter could not be read: aborted");
	});

	it("does not warn, and stops at once, when the start is aborted during the read", async () => {
		const abort = new AbortController();
		let reads = 0;
		const store: ObjectStore = {
			...createMemoryStore(),
			get: async () => {
				reads += 1;
				// The shutdown lands while the read is in flight: the store raises, and the
				// signal is already aborted when the guard sees the failure.
				abort.abort(new Error("SIGTERM"));
				throw new Error("AbortError: the operation was aborted");
			},
		};
		const { guard, lines } = guardOn(store, { signal: abort.signal });
		const started = Date.now();
		await expect(guard.check({ starts: 1, restoreId: "" })).rejects.toThrow(
			"the harness start counter could not be read: aborted",
		);
		// The first wait is 1 s, so arriving here at all says it never slept; and no
		// line calls a shutdown an unreadable counter.
		expect(Date.now() - started).toBeLessThan(500);
		expect(reads).toBe(1);
		expect(logged(lines, "harness start counter unreadable")).toEqual([]);
	});

	it("counts a missing object as 0, and any other read error as a failure", async () => {
		const store: ObjectStore = {
			...createMemoryStore(),
			get: async (key) => {
				throw new NotFoundError(key);
			},
		};
		const { guard, lines } = guardOn(store);
		expect(await guard.check({ starts: 0, restoreId: "" })).toEqual({ restore: false, starts: 1, restoreId: "" });
		expect(lines).toEqual([]);
	});
});

// The conditional put is the one thing the memory store cannot prove on the S3
// side: MinIO answers 412/409 the same way, and the race is what the retry is
// for (T5-plan §4, "the S3 put loses a race").
const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

describe("the start guard on MinIO", () => {
	it.skipIf(endpointUrl === "")("keeps the higher number when two instances race", { timeout: 25_000 }, async () => {
		const { createS3Store } = await import("../objstore/s3.ts");
		const prefix = `test-t53a-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const store = createS3Store({ bucket, prefix, region, endpointUrl });

		// Two instances both find no object and both would write 1. One wins the
		// create; the other's If-None-Match: * fails and its retry writes 1 again.
		const first = guardOn(store).guard;
		const second = guardOn(store).guard;
		expect(await first.check({ starts: 0, restoreId: "" })).toMatchObject({ starts: 1 });
		expect(await second.check({ starts: 0, restoreId: "" })).toMatchObject({ starts: 1 });
		await first.committed(1);
		await second.committed(1);
		expect(await body(store)).toContain('"starts":1');

		// The interesting race: a stale writer whose number is lower than the one the
		// other instance has already stored.
		const late = guardOn(store).guard;
		expect(await late.check({ starts: 1, restoreId: "" })).toMatchObject({ starts: 2 });
		const current = await store.get(epochKey("dev"));
		await store.put(epochKey("dev"), new TextEncoder().encode('{"schema":1,"starts":20}'), current.etag);
		await late.committed(2);
		expect(await body(store)).toContain('"starts":20');

		// What the retry is for: the store really raises PreconditionError on a
		// conditional write whose ETag is stale, and on a create of an existing key.
		await expect(store.put(epochKey("dev"), new TextEncoder().encode("{}"), null)).rejects.toBeInstanceOf(
			PreconditionError,
		);
		await expect(store.put(epochKey("dev"), new TextEncoder().encode("{}"), current.etag)).rejects.toBeInstanceOf(
			PreconditionError,
		);
	});
});
