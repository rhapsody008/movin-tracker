// The entries service and its journal: the port of service_test.go, plus the
// milestone tests that exercise it, plus the replay-safety tests the Go app
// never had. Every case runs on the memory store and on MinIO when
// S3_ENDPOINT_URL and S3_BUCKET are set (as they are inside `make test`).
import { randomUUID } from "node:crypto";
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { ValidationError } from "../errors.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import { type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { ChangeNotFoundError, ConflictError, EntryNotFoundError, UndoStaleError } from "./errors.ts";
import { replayChangeId } from "./ids.ts";
import { type Actor, MAX_CHANGES } from "./journal.ts";
import { type Doc, decodeDoc, type Entry, findEntry, isMilestone, type Patch } from "./model.ts";
import { createEntriesService, type EntriesService, KEY, type Replay, type Result, snapshotJson } from "./service.ts";

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the entries suite would be skipped",
	);
}

const zyWeb: Actor = { by: "zy@x", channel: "web" };
const ptTg: Actor = { by: "partner", channel: "telegram" };

function patch(json: string): Patch {
	return JSON.parse(json);
}

const runPrefix = `test-entries-ts-${Date.now()}`;

interface Variant {
	name: string;
	/** A store nothing else in the suite uses. */
	make: () => ObjectStore;
}

const variants: Variant[] = [{ name: "memory", make: () => createMemoryStore() }];

if (endpointUrl !== "" && bucket !== "") {
	await createBucket();
	variants.push({
		name: "s3",
		make: () => createS3Store({ bucket, prefix: `${runPrefix}/${randomUUID()}`, region, endpointUrl }),
	});
}

async function createBucket(): Promise<void> {
	const client = new S3Client({ region, endpoint: endpointUrl, forcePathStyle: true });
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (err) {
		const name = typeof err === "object" && err !== null && "name" in err ? err.name : undefined;
		if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
	}
	await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
	client.destroy();
}

interface Started {
	svc: EntriesService;
	store: ObjectStore;
	logLines: string[];
	/** Moves the clock; every new call reads the current value. */
	setNow: (iso: string) => void;
}

/** A service on a fresh store, loaded and ready, with a test log and its own clock. */
async function start(
	store: ObjectStore = createMemoryStore(),
	opts: { timeZone?: string; now?: string } = {},
): Promise<Started> {
	const { log, lines } = createTestLog();
	let at = opts.now ?? "2026-11-12T10:00:00Z";
	const svc = createEntriesService({
		store,
		log,
		timeZone: opts.timeZone,
		now: () => new Date(at),
	});
	await svc.load();
	return {
		svc,
		store,
		logLines: lines,
		setNow: (iso) => {
			at = iso;
		},
	};
}

function loaded(store: ObjectStore): EntriesService {
	const { log } = createTestLog();
	return createEntriesService({ store, log, now: () => new Date("2026-11-12T10:00:00Z") });
}

/** The single entry a create/update/undo/delete result carries. */
function only(res: { entries: Entry[] }): Entry {
	const e = res.entries[0];
	if (e === undefined) throw new Error("the call returned no entry");
	return e;
}

async function errorOf(fn: () => Promise<unknown>): Promise<Error> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}

async function createOne(svc: EntriesService, actor: Actor, json: string, replay?: Replay): Promise<Result> {
	return await svc.create(actor, [patch(json)], replay);
}

interface Counted {
	store: ObjectStore;
	puts: () => number;
}

/** Wraps a store and counts the puts, to prove a replay does not write. */
function countingStore(inner: ObjectStore): Counted {
	let puts = 0;
	const store: ObjectStore = {
		...inner,
		put: (key, body, ifMatch, signal) => {
			puts++;
			return inner.put(key, body, ifMatch, signal);
		},
	};
	return { store, puts: () => puts };
}

/** The milliseconds a ULID was made at, from its 10-char time prefix. */
function ulidTime(id: string): number {
	const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let ms = 0;
	for (const char of id.slice(0, 10)) ms = ms * 32 + alphabet.indexOf(char);
	return ms;
}

for (const variant of variants) {
	describe(`entries service on ${variant.name}`, () => {
		it("creates, updates, deletes and persists the journal (TestCRUD)", async () => {
			const { svc, store } = await start(variant.make());
			const first = await svc.current();
			expect(first.doc.entries).toEqual([]);
			expect(first.etag).not.toBe("");

			const made = await createOne(svc, zyWeb, `{"title":"Carpentry","kind":"task","cost":{"estimate":18000}}`);
			const e = made.entries[0];
			if (e === undefined) throw new Error("create returned no entry");
			expect(e.id.length).toBe(26);
			expect(e.kind).toBe("task");
			expect(e.status).toBe("todo");
			expect(e.by).toBe("zy@x");
			expect(e.channel).toBe("web");
			expect(e.created).toBe("2026-11-12T10:00:00Z");
			const created = made.changes[0];
			expect(created?.op).toBe("create");
			expect(created?.entryId).toBe(e.id);
			expect(created?.before).toBeNull();
			expect(created?.after).toEqual(e);
			expect(created?.channel).toBe("web");

			const updated = await svc.update(ptTg, e.id, patch(`{"status":"doing","cost":{"actual":5400}}`));
			const up = updated.entries[0];
			if (up === undefined) throw new Error("update returned no entry");
			expect(up.status).toBe("doing");
			expect(up.cost).toEqual({ estimate: 18000, actual: 5400 });
			expect(up.by).toBe("partner");
			expect(up.channel).toBe("telegram");
			const changed = updated.changes[0];
			expect(changed?.op).toBe("update");
			expect(changed?.before?.status).toBe("todo");
			expect(changed?.after?.status).toBe("doing");

			// An invalid update fails, and the cache and the journal stay as they were.
			const bad = await errorOf(() => svc.update(zyWeb, e.id, patch(`{"status":"nope"}`)));
			expect(bad).toBeInstanceOf(ValidationError);
			expect(bad.message).toBe("status for a task must be one of todo, doing, done");
			const got = await svc.current();
			expect(got.doc.entries[0]?.status).toBe("doing");
			expect(got.doc.changes.length).toBe(2);

			const missing = await errorOf(() => svc.update(zyWeb, "missing", patch(`{"status":"done"}`)));
			expect(missing).toBeInstanceOf(EntryNotFoundError);
			expect(missing.message).toBe("no entry with that id: missing");

			const noTitle = await errorOf(() => svc.create(zyWeb, [patch(`{"kind":"idea"}`)]));
			expect(noTitle).toBeInstanceOf(ValidationError);
			expect(noTitle.message).toBe("title is required");

			await svc.setMeta({ moveDate: "2026-12-05", keyDate: null });
			await svc.delete(zyWeb, e.id);

			// A fresh service (a restarted pod) sees the persisted state.
			const fresh = await loaded(store).current();
			expect(fresh.doc.entries).toEqual([]);
			expect(fresh.doc.meta).toEqual({ moveDate: "2026-12-05", keyDate: null });
			expect(fresh.doc.changes.length).toBe(3);
			expect(fresh.doc.changes[0]?.op).toBe("create");
			expect(fresh.doc.changes[2]?.op).toBe("delete");
		});

		it("creates several entries in one call, and nothing when one patch is bad (TestCreateMany)", async () => {
			const { svc } = await start(variant.make());
			const res = await svc.create(ptTg, [
				patch(`{"title":"Quartz top","kind":"idea","room":"wet kitchen"}`),
				patch(`{"title":"Electrician visit","kind":"task","date":"2026-11-14","time":"14:00"}`),
			]);
			expect(res.entries.length).toBe(2);
			expect(res.changes.length).toBe(2);
			expect(res.changes[0]?.id).not.toBe(res.changes[1]?.id);
			expect(res.changes[0]?.entryId).toBe(res.entries[0]?.id);
			expect(res.changes[1]?.entryId).toBe(res.entries[1]?.id);

			// One bad patch rejects the whole batch.
			const bad = await errorOf(() =>
				svc.create(ptTg, [patch(`{"title":"ok"}`), patch(`{"title":"bad","room":"garage"}`)]),
			);
			expect(bad).toBeInstanceOf(ValidationError);
			const snap = await svc.current();
			expect(snap.doc.entries.length).toBe(2);
			expect(snap.doc.changes.length).toBe(2);
		});
	});
}

for (const variant of variants) {
	describe(`undo on ${variant.name}`, () => {
		it("undoes creates, updates, deletes and the undo itself (TestUndo)", async () => {
			const { svc } = await start(variant.make());

			// An undo of a create removes the entry again.
			const made = await createOne(svc, ptTg, `{"title":"Fluted panels","room":"dry kitchen"}`);
			const created = made.changes[0];
			if (created === undefined) throw new Error("no create record");
			await svc.undo(ptTg, created.id);
			expect((await svc.current()).doc.entries).toEqual([]);
			// The same change cannot be undone twice.
			const twice = await errorOf(() => svc.undo(ptTg, created.id));
			expect(twice).toBeInstanceOf(UndoStaleError);
			expect(twice.message).toBe("that entry has changed since, so undo was refused");

			// An undo of an update restores the old fields and stamps the undoer.
			const sofaRes = await createOne(svc, zyWeb, `{"title":"Sofa","kind":"idea","cost":{"estimate":2000}}`);
			const sofa = sofaRes.entries[0];
			if (sofa === undefined) throw new Error("no sofa");
			const updated = await svc.update(ptTg, sofa.id, patch(`{"status":"decided","cost":{"estimate":2500}}`));
			const updateChange = updated.changes[0];
			if (updateChange === undefined) throw new Error("no update record");
			const ures = await svc.undo(zyWeb, updateChange.id);
			const got = ures.entries[0];
			if (got === undefined) throw new Error("undo returned no entry");
			expect(got.status).toBe("idea");
			expect(got.cost).toEqual({ estimate: 2000, actual: null });
			expect(got.by).toBe("zy@x");
			expect(got.channel).toBe("web");
			const undoRecord = ures.changes[0];
			expect(undoRecord?.op).toBe("undo");
			expect(undoRecord?.before?.status).toBe("decided");
			expect(undoRecord?.after?.status).toBe("idea");

			// Undoing the undo re-applies the update.
			if (undoRecord === undefined) throw new Error("no undo record");
			await svc.undo(zyWeb, undoRecord.id);
			const afterRedo = await svc.current();
			expect(findEntry(afterRedo.doc, sofa.id)?.status).toBe("decided");

			// An undo of a delete puts the entry back.
			const deleted = await svc.delete(zyWeb, sofa.id);
			const deleteChange = deleted.changes[0];
			if (deleteChange === undefined) throw new Error("no delete record");
			await svc.undo(zyWeb, deleteChange.id);
			const restored = await svc.current();
			expect(findEntry(restored.doc, sofa.id)?.title).toBe("Sofa");

			const nope = await errorOf(() => svc.undo(zyWeb, "nope"));
			expect(nope).toBeInstanceOf(ChangeNotFoundError);
			expect(nope.message).toBe("that change is no longer in the history: nope");
		});
	});

	describe(`two replicas on ${variant.name}`, () => {
		it("keeps both changes when the second write loses the ETag race (TestConflictBothChangesSurvive)", async () => {
			const store = variant.make();
			const made = await createOne(await start(store).then((s) => s.svc), zyWeb, `{"title":"Carpentry","kind":"task"}`);
			const e = made.entries[0];
			if (e === undefined) throw new Error("no entry");

			const a = loaded(store);
			const b = loaded(store);
			const sa = await a.current();
			const sb = await b.current();
			expect(sa.etag).toBe(sb.etag);

			await a.update(zyWeb, e.id, patch(`{"cost":{"estimate":18000}}`));
			// b's cached ETag is stale now: this write gets 412 and has to retry.
			await b.update(ptTg, e.id, patch(`{"cost":{"actual":5400}}`));

			const got = await loaded(store).current();
			expect(findEntry(got.doc, e.id)?.cost).toEqual({ estimate: 18000, actual: 5400 });
			expect(got.doc.changes.length).toBe(3);
		});

		it("keeps every acknowledged write from two writers at once (TestConcurrentWriters)", async () => {
			const store = variant.make();
			const reps = [await start(store).then((s) => s.svc), loaded(store)];
			const ok = new Set<string>();
			let conflicts = 0;
			const writes: Promise<void>[] = [];
			for (let i = 0; i < 10; i++) {
				for (const [ri, rep] of reps.entries()) {
					const title = `r${ri}-entry${i}`;
					writes.push(
						rep.create(zyWeb, [patch(`{"title":"${title}"}`)]).then(
							() => {
								ok.add(title);
							},
							(err: unknown) => {
								if (err instanceof ConflictError) conflicts++;
								else throw err;
							},
						),
					);
				}
			}
			await Promise.all(writes);

			const got = await loaded(store).current();
			const present = new Set(got.doc.entries.map((e) => e.title));
			for (const title of ok) expect(present.has(title)).toBe(true);
			expect(got.doc.entries.length).toBe(ok.size);
			expect(got.doc.changes.length).toBe(ok.size);
			expect(ok.size + conflicts).toBe(20);
		});
	});
}

describe("the journal's cap and the recent list (TestJournalCapAndRecent)", () => {
	it("keeps the newest MAX_CHANGES records and drops the oldest", async () => {
		const { svc } = await start();
		const first = await createOne(svc, zyWeb, `{"title":"first"}`);
		const firstChange = first.changes[0];
		const firstEntry = first.entries[0];
		if (firstChange === undefined || firstEntry === undefined) throw new Error("no first create");

		for (let i = 0; i < MAX_CHANGES; i++) {
			await createOne(svc, i % 2 === 1 ? ptTg : zyWeb, `{"title":"n${i}"}`);
		}
		const snap = await svc.current();
		expect(snap.doc.changes.length).toBe(200);
		expect(MAX_CHANGES).toBe(200);
		const dropped = await errorOf(() => svc.undo(zyWeb, firstChange.id));
		expect(dropped).toBeInstanceOf(ChangeNotFoundError);
		expect(dropped.message).toBe(`that change is no longer in the history: ${firstChange.id}`);
		// Trimming the journal never removes entries.
		expect(findEntry(snap.doc, firstEntry.id)?.title).toBe("first");

		const top = await svc.recent(3);
		expect(top.length).toBe(3);
		expect(top[0]?.after?.title).toBe(`n${MAX_CHANGES - 1}`);
		expect(top[0]?.id).toBe(snap.doc.changes[MAX_CHANGES - 1]?.id);
		const mine = await svc.recent(2, "partner");
		expect(mine.length).toBe(2);
		expect(mine[0]?.by).toBe("partner");
		expect(mine[1]?.by).toBe("partner");
		// An empty journal is [], not null.
		expect(await (await start()).svc.recent(5)).toEqual([]);
	});
});

describe("undo refusals", () => {
	it("refuses an undo after someone else edited the entry (TestUndoRefusedAfterLaterEdit)", async () => {
		const { svc } = await start();
		const made = await createOne(svc, zyWeb, `{"title":"Lights","kind":"task"}`);
		const e = made.entries[0];
		if (e === undefined) throw new Error("no entry");
		const first = await svc.update(zyWeb, e.id, patch(`{"vendor":"Lim"}`));
		await svc.update(ptTg, e.id, patch(`{"notes":"warm white"}`));

		const firstChange = first.changes[0];
		if (firstChange === undefined) throw new Error("no update record");
		const err = await errorOf(() => svc.undo(zyWeb, firstChange.id));
		expect(err).toBeInstanceOf(UndoStaleError);
		expect(err.message).toBe("that entry has changed since, so undo was refused");

		const snap = await svc.current();
		expect(findEntry(snap.doc, e.id)).toMatchObject({ notes: "warm white", vendor: "Lim" });
	});

	it("refuses a record with no entries at all (TestUndoOfAnEmptyRecordIsRefused)", async () => {
		const store = createMemoryStore();
		const doc = `{"schema":1,"entries":[],"changes":[{"id":"c1","op":"update","entryId":"x"}]}`;
		await store.put(KEY, new TextEncoder().encode(doc), null);
		const svc = loaded(store);
		const err = await errorOf(() => svc.undo(zyWeb, "c1"));
		expect(err).toBeInstanceOf(ChangeNotFoundError);
		expect(err.message).toBe("that change is no longer in the history: c1 (empty record)");
	});
});

describe("the retry cap", () => {
	it("gives up with ConflictError after MAX_RETRIES retries (TestGivesUpAfterRetries)", async () => {
		const memory = createMemoryStore();
		await start(memory);
		let puts = 0;
		const conflicting: ObjectStore = {
			...memory,
			put: async () => {
				puts++;
				throw new PreconditionError(KEY);
			},
		};
		const { log, lines } = createTestLog();
		const svc = createEntriesService({ store: conflicting, log, now: () => new Date("2026-11-12T10:00:00Z") });
		const err = await errorOf(() => createOne(svc, zyWeb, `{"title":"a"}`));
		expect(err).toBeInstanceOf(ConflictError);
		expect(err.message).toBe("someone else just changed the entries");
		// 4 PUTs: the first attempt and MAX_RETRIES retries.
		expect(puts).toBe(4);
		expect(lines.some((line) => line.includes("write gave up after ETag conflicts"))).toBe(true);
	});
});

interface Gate {
	store: ObjectStore;
	/** Makes the next get block after reading, until release() is called. */
	arm: () => void;
	entered: Promise<void>;
	release: () => void;
}

/** Wraps a store so a test can freeze one read and order a refresh around a write. */
function gatedGet(inner: ObjectStore): Gate {
	let armed = false;
	let entered = (): void => undefined;
	let release = (): void => undefined;
	const enteredPromise = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const releasePromise = new Promise<void>((resolve) => {
		release = resolve;
	});
	const store: ObjectStore = {
		...inner,
		get: async (key, signal) => {
			const got = await inner.get(key, signal);
			if (armed) {
				armed = false;
				entered();
				await releasePromise;
			}
			return got;
		},
	};
	return {
		store,
		arm: () => {
			armed = true;
		},
		entered: enteredPromise,
		release,
	};
}

describe("polling and refreshing", () => {
	it("notifies subscribers when a refresh picks up an outside write (TestPollPicksUpOutsideWrites)", async () => {
		const store = createMemoryStore();
		const a = await start(store).then((s) => s.svc);
		const b = await start(store).then((s) => s.svc);
		const seen: Doc[] = [];
		const stop = b.subscribe((s) => {
			seen.push(s.doc);
		});
		try {
			await createOne(a, ptTg, `{"title":"from the bot"}`);
			await b.refresh();
		} finally {
			stop();
		}
		expect(seen.length).toBe(1);
		expect(seen[0]?.entries[0]?.title).toBe("from the bot");
		expect(seen[0]?.entries[0]?.channel).toBe("telegram");
	});

	it("cannot put an older document back after a newer write (TestRefreshCannotOverwriteANewerWrite)", async () => {
		const memory = createMemoryStore();
		const gate = gatedGet(memory);
		const svc = await start(gate.store).then((s) => s.svc);
		// A write from outside moves the ETag while this service still holds [].
		await createOne(await start(memory).then((s) => s.svc), zyWeb, `{"title":"outside write"}`);

		gate.arm();
		const refreshed = svc.refresh();
		await gate.entered;
		const wrote = createOne(svc, ptTg, `{"title":"bot write"}`);
		// As in Go's test: give the write time to land while the refresh's read
		// is frozen, so a refresh that does not hold the lock would put the
		// older document back afterwards. With the lock it waits here.
		await new Promise((resolve) => setTimeout(resolve, 200));
		gate.release();
		await refreshed;
		await wrote;

		const snap = await svc.current();
		expect(snap.doc.entries.length).toBe(2);
		const stat = await memory.stat(KEY);
		expect(snap.etag).toBe(stat.etag);
	});

	it("returns at once while a write holds the lock, instead of queueing behind it (trap 13)", async () => {
		const memory = createMemoryStore();
		// Create the empty document first: the gated put below is armed after load.
		await loaded(memory).current();
		let arm = false;
		let entered = (): void => undefined;
		let release = (): void => undefined;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const releasePromise = new Promise<void>((resolve) => {
			release = resolve;
		});
		const gated: ObjectStore = {
			...memory,
			put: async (key, body, ifMatch, signal) => {
				if (arm) {
					arm = false;
					entered();
					await releasePromise;
				}
				return await memory.put(key, body, ifMatch, signal);
			},
		};
		const svc = await start(gated).then((s) => s.svc);

		arm = true;
		const write = createOne(svc, zyWeb, `{"title":"x"}`);
		await enteredPromise;

		// The write holds the lock; a refresh must skip, not wait for it.
		let returned = false;
		const refresh = svc.refresh().then(() => {
			returned = true;
		});
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(returned).toBe(true);

		release();
		await write;
		await refresh;
		expect((await svc.current()).doc.entries.length).toBe(1);
	});

	it("polls until the stop function is called", async () => {
		const store = createMemoryStore();
		const outside = await start(store).then((s) => s.svc);
		const svc = await start(store).then((s) => s.svc);
		vi.useFakeTimers();
		try {
			const stop = svc.startPolling(1000);
			await createOne(outside, ptTg, `{"title":"from the bot"}`);
			await vi.advanceTimersByTimeAsync(1000);
			expect((await svc.current()).doc.entries[0]?.title).toBe("from the bot");

			stop();
			expect(vi.getTimerCount()).toBe(0);
			await createOne(outside, ptTg, `{"title":"later"}`);
			await vi.advanceTimersByTimeAsync(5000);
			expect((await svc.current()).doc.entries.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("the wire snapshot", () => {
	it("leaves the journal out (TestSnapshotJSONLeavesOutTheJournal)", async () => {
		const { svc } = await start();
		await createOne(svc, zyWeb, `{"title":"x"}`);
		const snap = await svc.current();
		const wire = snapshotJson(snap);
		expect(wire).not.toContain('"changes"');
		// Go's field order and shape: {"doc":{"schema":1,"meta":…,"entries":[…]},"etag":"…"}
		expect(wire.startsWith('{"doc":{"schema":1,"meta":{"moveDate":null,"keyDate":null},"entries":[{"id":"')).toBe(true);
		const parsed = JSON.parse(wire) as { doc: Doc; etag: string };
		expect(parsed.etag).toBe(snap.etag);
		expect(parsed.doc.entries.length).toBe(1);
		expect(parsed.doc.entries[0]?.title).toBe("x");
	});
});

describe("the cached document", () => {
	it("is frozen, so a caller cannot corrupt the cache or the journal", async () => {
		const { svc } = await start();
		const made = await createOne(svc, zyWeb, `{"title":"Lights","tags":["warm"]}`);
		const snap = await svc.current();
		const first = snap.doc.entries[0];
		const record = snap.doc.changes[0];
		if (first === undefined || record === undefined) throw new Error("nothing cached");

		expect(Object.isFrozen(snap.doc)).toBe(true);
		expect(Object.isFrozen(snap.doc.meta)).toBe(true);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.tags)).toBe(true);
		expect(Object.isFrozen(record.after)).toBe(true);

		// ESM runs in strict mode, so writing to the frozen cache throws.
		expect(() => {
			first.title = "hacked";
		}).toThrow(TypeError);
		expect(() => {
			snap.doc.meta.moveDate = "2026-01-01";
		}).toThrow(TypeError);
		expect(() => {
			record.after?.tags.push("more");
		}).toThrow(TypeError);
		expect(() => {
			snap.doc.entries.length = 0;
		}).toThrow(TypeError);

		const again = await svc.current();
		expect(again.doc.entries[0]?.title).toBe("Lights");
		expect(again.doc.entries[0]?.tags).toEqual(["warm"]);

		// The result is a copy, not a window on the cache.
		made.entries[0]?.tags.push("mine");
		expect((await svc.current()).doc.entries[0]?.tags).toEqual(["warm"]);
	});

	it("logs a subscriber that throws and still notifies the others", async () => {
		const { svc, logLines } = await start();
		let heard = 0;
		const stopBad = svc.subscribe(() => {
			throw new Error("boom");
		});
		const stopGood = svc.subscribe(() => {
			heard++;
		});
		let res: Result;
		try {
			res = await createOne(svc, zyWeb, `{"title":"x"}`);
		} finally {
			stopBad();
			stopGood();
		}
		expect(res.entries.length).toBe(1);
		expect(heard).toBe(1);
		expect(logLines.some((line) => line.includes("entries subscriber failed") && line.includes("boom"))).toBe(true);
		const snap = await svc.current();
		expect(snap.doc.entries[0]?.title).toBe("x");
	});
});

describe("the done day follows the app's time zone", () => {
	it("reads the zone's calendar day, not UTC's", async () => {
		// 2026-11-12T23:30Z is already 13 Nov in Singapore. en-CA formats as
		// YYYY-MM-DD; the assertion below fails if the ICU data says otherwise.
		const sgt = await start(createMemoryStore(), { timeZone: "Asia/Singapore", now: "2026-11-12T23:30:00Z" });
		const utc = await start(createMemoryStore(), { now: "2026-11-12T23:30:00Z" });

		for (const [variant, want] of [
			[sgt, "2026-11-13"],
			[utc, "2026-11-12"],
		] as const) {
			const made = await createOne(variant.svc, zyWeb, `{"title":"Hack the walls","kind":"task"}`);
			const e = made.entries[0];
			if (e === undefined) throw new Error("no entry");
			const done = await variant.svc.update(zyWeb, e.id, patch(`{"status":"done"}`));
			expect(done.entries[0]?.completed).toBe(want);
		}
	});

	it("refuses an unknown time zone at construction, not on the first write", () => {
		expect(() =>
			createEntriesService({ store: createMemoryStore(), log: createTestLog().log, timeZone: "Nowhere/Bad" }),
		).toThrow(RangeError);
	});
});

for (const variant of variants) {
	describe(`replay-safe writes on ${variant.name}`, () => {
		it("writes a create once and returns the same result twice", async () => {
			const counted = countingStore(variant.make());
			const { svc } = await start(counted.store);
			const replay: Replay = { key: "epoch1|task7", args: { action: "create", titles: ["Quartz top", "Electrician"] } };
			const patches = [
				patch(`{"title":"Quartz top","kind":"idea","room":"wet kitchen"}`),
				patch(`{"title":"Electrician","kind":"task","date":"2026-11-14"}`),
			];

			const putsBefore = counted.puts();
			const first = await svc.create(ptTg, patches, replay);
			expect(counted.puts()).toBe(putsBefore + 1);
			expect(first.changes.length).toBe(2);
			// Both records carry the replay ids for index 0 and 1.
			expect(first.changes[0]?.id).toBe(replayChangeId(replay.key, 0, replay.args));
			expect(first.changes[1]?.id).toBe(replayChangeId(replay.key, 1, replay.args));
			// Created entries still get ULIDs, made with the service's clock.
			expect(ulidTime(first.entries[0]?.id ?? "")).toBe(Date.parse("2026-11-12T10:00:00Z"));

			const putsAfter = counted.puts();
			const second = await svc.create(ptTg, patches, replay);
			// A replay must not touch the store at all.
			expect(counted.puts()).toBe(putsAfter);
			expect(second.entries).toEqual(first.entries);
			expect(second.changes).toEqual(first.changes);

			const snap = await svc.current();
			expect(snap.doc.changes.length).toBe(2);
			expect(snap.doc.entries.length).toBe(2);
			expect(snap.etag).toBe(second.snapshot.etag);
		});

		// F8: the journal keeps only MAX_CHANGES records, so a batch's first record
		// can be trimmed while a later one of the same batch is still there. Any
		// hit is a replay: a rerun must not write the batch a second time.
		it("replays a batch whose first record has been trimmed off the journal", async () => {
			const counted = countingStore(variant.make());
			const { svc } = await start(counted.store);
			const replay: Replay = {
				key: "epoch1|task8",
				args: { action: "create", titles: ["Bath mat", "Towel rail"] },
			};
			const patches = [patch(`{"title":"Bath mat"}`), patch(`{"title":"Towel rail"}`)];
			const first = await svc.create(ptTg, patches, replay);
			const second = first.changes[1];
			const snap = await svc.current();
			if (second === undefined) throw new Error("the batch wrote no second record");

			// The shape a trimmed journal leaves: index 1 intact, index 0 dropped,
			// and the remaining slots filled with later records.
			const fillers = Array.from({ length: MAX_CHANGES - 1 }, (_, i) => ({
				...second,
				id: `notice-${String(i).padStart(4, "0")}`,
			}));
			await svc.replace({ ...snap.doc, changes: [second, ...fillers] });
			const seeded = await svc.current();
			expect(seeded.doc.changes.length).toBe(MAX_CHANGES);
			expect(seeded.doc.changes.some((c) => c.id === replayChangeId(replay.key, 0, replay.args))).toBe(false);
			expect(seeded.doc.changes[0]?.id).toBe(replayChangeId(replay.key, 1, replay.args));

			const puts = counted.puts();
			const again = await svc.create(ptTg, patches, replay);
			expect(counted.puts()).toBe(puts);
			// The records the journal still holds come back, in call order.
			expect(again.changes.map((c) => c.id)).toEqual([replayChangeId(replay.key, 1, replay.args)]);
			expect(again.entries.map((e) => e.title)).toEqual(["Towel rail"]);
			expect((await svc.current()).doc.changes.length).toBe(MAX_CHANGES);
		});

		// A2: a record at index 1 with the same prefix but a different args hash
		// is a collision, not a replay: warn, write fresh ULIDs, replay nothing.
		it("refuses a replay-id collision at index 1 and writes fresh records", async () => {
			const counted = countingStore(variant.make());
			const { svc, logLines } = await start(counted.store);
			const first: Replay = {
				key: "epoch1|task9",
				args: { action: "create", titles: ["Bath mat", "Towel rail"] },
			};
			const patches = [patch(`{"title":"Bath mat"}`), patch(`{"title":"Towel rail"}`)];
			const written = await svc.create(ptTg, patches, first);
			const second = written.changes[1];
			const snap = await svc.current();
			if (second === undefined) throw new Error("the batch wrote no second record");

			// The journal a trimmed batch leaves: index 1 intact, index 0 gone.
			const fillers = Array.from({ length: MAX_CHANGES - 1 }, (_, i) => ({
				...second,
				id: `notice-${String(i).padStart(4, "0")}`,
			}));
			await svc.replace({ ...snap.doc, changes: [second, ...fillers] });

			// Same task and epoch, different args: index 1's prefix is in the
			// journal, its args-hash suffix is not.
			const changed: Replay = { key: first.key, args: { action: "create", titles: ["Bath mat", "Bath mat XL"] } };
			const puts = counted.puts();
			const again = await svc.create(ptTg, patches, changed);
			expect(counted.puts()).toBeGreaterThan(puts);
			expect(again.changes).toHaveLength(2);
			for (const change of again.changes) {
				// A ULID made by this service's clock, not either replay id.
				expect(ulidTime(change.id)).toBe(Date.parse("2026-11-12T10:00:00Z"));
				expect(change.id).not.toBe(replayChangeId(changed.key, 0, changed.args));
				expect(change.id).not.toBe(replayChangeId(changed.key, 1, changed.args));
			}
			const warn = logLines.find((line) => line.includes("change id collision"));
			if (warn === undefined) throw new Error("no collision line");
			const collision = JSON.parse(warn) as Record<string, unknown>;
			expect(collision.level).toBe("WARN");
			expect(collision.id).toBe(second.id);
			// The journal's record is the one that was already there (its suffix),
			// and the wanted one is this call's args hash: a different suffix.
			expect(collision.got).toBe(second.id.slice(16));
			expect(collision.want).toBe(replayChangeId(changed.key, 1, changed.args).slice(16));
			expect(collision.got).not.toBe(collision.want);
		});

		it("replays an update, an undo and a delete without writing again", async () => {
			const counted = countingStore(variant.make());
			const { svc } = await start(counted.store);
			const made = await createOne(svc, zyWeb, `{"title":"Sofa","kind":"idea"}`);
			const e = made.entries[0];
			if (e === undefined) throw new Error("no entry");

			const updateReplay: Replay = { key: "epoch1|t1", args: { action: "update", id: e.id, status: "decided" } };
			const update = await svc.update(ptTg, e.id, patch(`{"status":"decided"}`), updateReplay);
			let puts = counted.puts();
			const updateAgain = await svc.update(ptTg, e.id, patch(`{"status":"decided"}`), updateReplay);
			expect(counted.puts()).toBe(puts);
			expect(updateAgain.entries).toEqual(update.entries);
			expect(updateAgain.changes).toEqual(update.changes);
			expect(updateAgain.entries[0]?.status).toBe("decided");

			const changeId = update.changes[0]?.id;
			if (changeId === undefined) throw new Error("no update record");
			const undoReplay: Replay = { key: "epoch1|t2", args: { action: "undo", changeId } };
			const undone = await svc.undo(zyWeb, changeId, undoReplay);
			puts = counted.puts();
			const undoneAgain = await svc.undo(zyWeb, changeId, undoReplay);
			expect(counted.puts()).toBe(puts);
			expect(undoneAgain.entries).toEqual(undone.entries);
			expect(undoneAgain.entries[0]?.status).toBe("idea");

			const deleteReplay: Replay = { key: "epoch1|t3", args: { action: "delete", id: e.id } };
			const deleted = await svc.delete(zyWeb, e.id, deleteReplay);
			puts = counted.puts();
			const deletedAgain = await svc.delete(zyWeb, e.id, deleteReplay);
			expect(counted.puts()).toBe(puts);
			expect(deletedAgain.entries).toEqual(deleted.entries);
			expect(deletedAgain.entries[0]?.title).toBe("Sofa");

			// One record per call, not two.
			const snap = await svc.current();
			const ops = snap.doc.changes.map((c) => c.op);
			expect(ops).toEqual(["create", "update", "undo", "delete"]);
			expect(snap.doc.entries).toEqual([]);
		});

		it("replays on a replica whose cache is stale, after one lost race", async () => {
			const counted = countingStore(variant.make());
			const a = await start(counted.store).then((s) => s.svc);
			const b = await start(counted.store).then((s) => s.svc);
			const replay: Replay = { key: "epoch9|task1", args: { title: "Keys" } };

			const first = await createOne(a, zyWeb, `{"title":"Keys","kind":"note"}`, replay);
			const putsAfterA = counted.puts();
			// b has not seen A's write: its attempt fails the ETag check, the retry
			// re-reads, finds the record and replays instead of writing.
			const second = await createOne(b, zyWeb, `{"title":"Keys","kind":"note"}`, replay);
			expect(counted.puts()).toBe(putsAfterA + 1);
			expect(second.entries).toEqual(first.entries);
			expect(second.changes).toEqual(first.changes);

			const stored = await b.current();
			expect(stored.doc.entries.length).toBe(1);
			expect(stored.doc.changes.length).toBe(1);
			expect(stored.etag).toBe((await counted.store.stat(KEY)).etag);
		});

		it("logs a collision and writes with a fresh ULID when the args differ", async () => {
			const counted = countingStore(variant.make());
			const { svc, logLines } = await start(counted.store);
			const key = "epoch1|task8";
			const first = await createOne(svc, zyWeb, `{"title":"A"}`, { key, args: { title: "A" } });
			const second = await createOne(svc, zyWeb, `{"title":"B"}`, { key, args: { title: "B" } });

			const firstId = first.changes[0]?.id ?? "";
			const secondId = second.changes[0]?.id ?? "";
			const wantSecond = replayChangeId(key, 0, { title: "B" });
			// Same key and index, so the same prefix; different args, so the
			// write goes ahead anyway and its id is a plain ULID.
			expect(firstId.slice(0, 16)).toBe(wantSecond.slice(0, 16));
			expect(secondId).not.toBe(wantSecond);
			expect(secondId.length).toBe(26);
			expect(ulidTime(secondId)).toBe(Date.parse("2026-11-12T10:00:00Z"));

			const warn = logLines.find((line) => line.includes("change id collision"));
			if (warn === undefined) throw new Error("no collision line");
			const logged = JSON.parse(warn) as Record<string, unknown>;
			expect(logged.level).toBe("WARN");
			expect(logged.id).toBe(firstId);
			expect(logged.want).toBe(wantSecond.slice(16));
			expect(logged.got).toBe(firstId.slice(16));

			const snap = await svc.current();
			expect(snap.doc.changes.length).toBe(2);
			expect(snap.doc.entries.length).toBe(2);
		});

		it("lands once, with the replay id, after a lost ETag race", async () => {
			const memory = createMemoryStore();
			let failNext = false;
			const flaky: ObjectStore = {
				...memory,
				put: async (key, body, ifMatch, signal) => {
					if (failNext) {
						failNext = false;
						throw new PreconditionError(key);
					}
					return await memory.put(key, body, ifMatch, signal);
				},
			};
			const counted = countingStore(flaky);
			const { svc } = await start(counted.store);
			failNext = true;
			const putsBefore = counted.puts();

			const replay: Replay = { key: "epoch2|task3", args: { action: "create", title: "Paint" } };
			const res = await createOne(svc, zyWeb, `{"title":"Paint"}`, replay);
			expect(res.changes[0]?.id).toBe(replayChangeId(replay.key, 0, replay.args));
			// One put lost the race, the retry wrote; nothing else was written.
			expect(counted.puts()).toBe(putsBefore + 2);

			const snap = await svc.current();
			expect(snap.doc.entries.length).toBe(1);
			expect(snap.doc.changes.length).toBe(1);
			// The store holds the same, decoded fresh.
			const stored = await memory.get(KEY);
			const doc = decodeDoc(new TextDecoder().decode(stored.body));
			expect(doc.changes[0]?.id).toBe(replayChangeId(replay.key, 0, replay.args));
		});
	});
}

describe("milestones (milestone_test.go)", () => {
	it("keeps the done day in step with the status (TestCompletedDayFollowsStatus)", async () => {
		const started = await start(createMemoryStore(), { timeZone: "Asia/Singapore", now: "2026-11-12T23:30:00Z" });
		const { svc } = started;
		const made = await createOne(svc, zyWeb, `{"title":"Hack the walls","kind":"task"}`);
		const e = made.entries[0];
		if (e === undefined) throw new Error("no entry");
		expect(e.completed).toBeNull();

		let res = await svc.update(zyWeb, e.id, patch(`{"status":"done"}`));
		expect(res.entries[0]?.completed).toBe("2026-11-13");

		// Another edit while still done keeps the day.
		started.setNow("2026-11-15T23:30:00Z");
		res = await svc.update(zyWeb, e.id, patch(`{"notes":"all walls"}`));
		expect(res.entries[0]?.completed).toBe("2026-11-13");

		// Leaving done clears it; coming back stamps the new day.
		res = await svc.update(zyWeb, e.id, patch(`{"status":"doing"}`));
		expect(res.entries[0]?.completed).toBeNull();
		res = await svc.update(zyWeb, e.id, patch(`{"status":"done"}`));
		expect(res.entries[0]?.completed).toBe("2026-11-16");

		// An explicit day wins.
		res = await svc.update(zyWeb, e.id, patch(`{"completed":"2026-11-10"}`));
		expect(res.entries[0]?.completed).toBe("2026-11-10");

		const milestone = await createOne(
			svc,
			zyWeb,
			`{"title":"Keys collected","kind":"note","status":"done","milestone":true,"completed":"2026-11-01"}`,
		);
		expect(only(milestone).completed).toBe("2026-11-01");
		expect(isMilestone(only(milestone))).toBe(true);

		// Created as done without a day: today.
		const paid = await createOne(svc, zyWeb, `{"title":"Paid deposit","kind":"task","status":"done"}`);
		expect(paid.entries[0]?.completed).toBe("2026-11-16");

		// A day on an entry that is not done is refused.
		const refused = await errorOf(() => svc.update(zyWeb, e.id, patch(`{"status":"todo","completed":"2026-11-10"}`)));
		expect(refused).toBeInstanceOf(ValidationError);
		expect(refused.message).toBe("completed needs status done");

		// Clearing the day of a done entry keeps the day it had.
		res = await svc.update(zyWeb, e.id, patch(`{"completed":null}`));
		expect(res.entries[0]?.completed).toBe("2026-11-10");
		res = await svc.update(zyWeb, e.id, patch(`{"completed":""}`));
		expect(res.entries[0]?.completed).toBe("2026-11-10");

		const badDate = await errorOf(() => svc.update(zyWeb, e.id, patch(`{"completed":"10/11/2026"}`)));
		expect(badDate).toBeInstanceOf(ValidationError);
		expect(badDate.message).toBe("completed must be YYYY-MM-DD");
	});

	it("restores the milestone and its day on undo (TestUndoRestoresMilestoneAndDay)", async () => {
		const { svc } = await start(createMemoryStore(), { timeZone: "Asia/Singapore", now: "2026-11-12T02:00:00Z" });
		const made = await createOne(svc, zyWeb, `{"title":"Kitchen installed","kind":"task"}`);
		const e = made.entries[0];
		if (e === undefined) throw new Error("no entry");

		const res = await svc.update(ptTg, e.id, patch(`{"status":"done","milestone":true}`));
		expect(isMilestone(only(res))).toBe(true);
		expect(only(res).completed).toBe("2026-11-12");

		const changeId = res.changes[0]?.id;
		if (changeId === undefined) throw new Error("no update record");
		const undone = await svc.undo(ptTg, changeId);
		expect(undone.entries[0]?.milestone).toBe(false);
		expect(undone.entries[0]?.completed).toBeNull();
		expect(undone.entries[0]?.status).toBe("todo");

		// Undoing the undo brings all three back.
		const undoId = undone.changes[0]?.id;
		if (undoId === undefined) throw new Error("no undo record");
		await svc.undo(ptTg, undoId);
		const got = findEntry((await svc.current()).doc, e.id);
		if (got === null) throw new Error("the entry is gone");
		expect(isMilestone(got)).toBe(true);
		expect(got.completed).toBe("2026-11-12");
	});
});

describe("updateIf", () => {
	it("re-checks after a conflict and cancels the write (TestUpdateIfRechecksAfterAConflict)", async () => {
		const store = createMemoryStore();
		const a = await start(store).then((s) => s.svc);
		const b = await start(store).then((s) => s.svc);
		const made = await createOne(a, zyWeb, `{"title":"Book movers","kind":"task","date":"2026-11-11"}`);
		const e = made.entries[0];
		if (e === undefined) throw new Error("no entry");
		await b.refresh();
		// b (web) marks it done; a (the bot) still has the old copy cached.
		await b.update(zyWeb, e.id, patch(`{"status":"done"}`));

		const errDone = new Error("already done");
		let checks = 0;
		const err = await errorOf(() =>
			a.updateIf(
				ptTg,
				e.id,
				(cur) => {
					checks++;
					if (cur.status === "done") throw errDone;
				},
				patch(`{"date":"2026-11-13"}`),
			),
		);
		expect(err).toBe(errDone);
		expect(err.message).toBe("already done");
		expect(checks).toBe(2);

		const got = findEntry((await a.current()).doc, e.id);
		expect(got?.status).toBe("done");
		expect(got?.date).toBe("2026-11-11");
	});

	it("reports an unknown id, and the check never runs", async () => {
		const { svc } = await start();
		let checks = 0;
		const err = await errorOf(() =>
			svc.updateIf(
				zyWeb,
				"nope",
				() => {
					checks++;
				},
				patch(`{"title":"x"}`),
			),
		);
		expect(err).toBeInstanceOf(EntryNotFoundError);
		expect(err.message).toBe("no entry with that id: nope");
		expect(checks).toBe(0);
	});
});
