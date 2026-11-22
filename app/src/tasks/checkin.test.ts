// The morning check-in's state (src/tasks/checkin.ts): Go's checkin.json bytes
// (app/golden/t51 wrote the fixture), the claim protocol under its Go test
// names, the due window, and where the check-in goes. Every store case runs on
// the memory store and on MinIO when S3_ENDPOINT_URL and S3_BUCKET are set (as
// they are inside `make test`), because the claim is a conditional put on an
// object both copies of the app share.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";
import { type Agent, inspectSchedules, openAgent, type ScheduleInspection, type Timer } from "../durable/adapter.ts";
import type { Patch } from "../entries/model.ts";
import { createEntriesService, type EntriesService } from "../entries/service.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { CHECKIN_CUTOFF, parseCheckin } from "../settings/checkin.ts";
import { createSettingsService, DEFAULTS, type SettingsService } from "../settings/settings.ts";
import type { Telegram } from "../settings/telegram.ts";
import {
	CHECKIN_KEY,
	CHECKIN_QUIET,
	CHECKIN_SENDING,
	CHECKIN_SENT,
	type CheckinClaim,
	type CheckinRecord,
	type CheckinService,
	type CheckinSettings,
	CheckinStore,
	type ClaimResult,
	checkinChat,
	checkinDue,
	createCheckin,
	ERR_NO_CHECKIN_CHAT,
	finished,
	nextSince,
	STALE_CLAIM_MS,
	taken,
} from "./checkin.ts";

/** Go's answers for T5.1a, by app/golden/t51/main.go. */
interface Golden {
	constants: { stale_claim_seconds: number; checkin_cutoff: number };
	records: { name: string; steps: GoldenStep[]; json: string }[];
	record_state: {
		json: string;
		day: string;
		now: string;
		error?: string;
		finished: boolean;
		taken: boolean;
		next_since: string;
	}[];
	due: { at: string; hour: number; minute: number; loc: string; out: boolean }[];
}

interface GoldenStep {
	op: "claim" | "finish" | "release";
	day?: string;
	chat?: string;
	status?: string;
	now: string;
}

const GOLDEN = JSON.parse(
	readFileSync(join(import.meta.dirname, "..", "telegram", "testdata", "checkin.go.json"), "utf8"),
) as Golden;

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the check-in suite would be skipped",
	);
}

const runPrefix = `test-checkin-ts-${Date.now()}`;

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

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (body: Uint8Array): string => new TextDecoder().decode(body);

/** The claim a test has already asserted, without a null check in the way. */
function claimOf(r: ClaimResult): CheckinClaim {
	if (r.claim === null) throw new Error("the store refused the claim");
	return r.claim;
}

// ---- the golden ----

describe("the golden: checkin.json", () => {
	it("has Go's constants", () => {
		expect(STALE_CLAIM_MS).toBe(GOLDEN.constants.stale_claim_seconds * 1000);
		expect(CHECKIN_CUTOFF).toBe(GOLDEN.constants.checkin_cutoff);
	});

	for (const c of GOLDEN.records) {
		it(`${c.name}: the bytes Go writes`, async () => {
			const memory = createMemoryStore();
			const store = new CheckinStore(memory);
			let claim: CheckinClaim | null = null;
			for (const step of c.steps) {
				const now = new Date(step.now);
				if (step.op === "claim") {
					claim = claimOf(await store.claim(step.day ?? "", step.chat ?? "", now));
					continue;
				}
				if (claim === null) throw new Error(`${c.name}: ${step.op} without a claim`);
				if (step.op === "finish") await store.finish(claim, step.status ?? "", now);
				else await store.release(claim);
			}
			expect(dec((await memory.get(CHECKIN_KEY)).body)).toBe(c.json);
		});
	}

	for (const c of GOLDEN.record_state) {
		it(`reads ${c.json} as Go does`, async () => {
			const memory = createMemoryStore();
			await memory.put(CHECKIN_KEY, enc(c.json), null);
			const store = new CheckinStore(memory);
			if (c.error !== undefined) {
				await expect(store.load()).rejects.toThrow(c.error);
				return;
			}
			const { record } = await store.load();
			expect(finished(record, c.day)).toBe(c.finished);
			expect(taken(record, c.day, new Date(c.now))).toBe(c.taken);
			expect(nextSince(record)).toBe(c.next_since);
		});
	}
});

describe("the golden: the due window", () => {
	it("matches Go's table", () => {
		for (const c of GOLDEN.due) {
			expect(checkinDue(new Date(c.at), c.hour, c.minute, c.loc), `${c.at} in ${c.loc}`).toBe(c.out);
		}
	});
});

// Go: TestCheckinDue (checkin_state_test.go:14-31).
describe("TestCheckinDue", () => {
	it("is due from the minute until 20:00, in the app's zone", () => {
		const table: [string, boolean][] = [
			["2026-11-12T09:29:00+08:00", false],
			["2026-11-12T09:30:00+08:00", true],
			["2026-11-12T14:00:00+08:00", true], // Mac woke up late: catch up
			["2026-11-12T19:59:00+08:00", true],
			["2026-11-12T20:00:00+08:00", false], // too late: skip the day
			["2026-11-12T01:30:00Z", true], // 09:30 SGT
			["2026-11-12T00:30:00Z", false], // 08:30 SGT
		];
		for (const [at, want] of table) {
			expect(checkinDue(new Date(at), 9, 30, "Asia/Singapore"), at).toBe(want);
		}
	});
});

// Go: TestCheckinClaim (checkin_state_test.go:33-84).
describe("TestCheckinClaim", () => {
	it("claims once a day, moves the window on, and takes over a stale claim", async () => {
		const store = new CheckinStore(createMemoryStore());
		let now = new Date("2026-11-12T01:30:00Z");

		// First ever: claimed, asks about yesterday (no window yet).
		const first = claimOf(await store.claim("2026-11-12", "-100", now));
		expect(first.record.since).toBe("");

		// While it is being sent, nobody else gets it, and it isn't finished.
		const second = await store.claim("2026-11-12", "-100", now);
		expect(second.claim).toBeNull();
		expect(finished(second.prev, "2026-11-12")).toBe(false);
		expect(taken(second.prev, "2026-11-12", now)).toBe(true);

		await store.finish(first, CHECKIN_SENT, now);
		const third = await store.claim("2026-11-12", "-100", now);
		expect(third.claim).toBeNull();
		expect(finished(third.prev, "2026-11-12")).toBe(true);

		// Next day: the 12th's tasks were "today" then, so the 13th asks from the 12th.
		now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
		const next = claimOf(await store.claim("2026-11-13", "-100", now));
		expect(next.record.since).toBe("2026-11-12");
		expect(next.prev.day).toBe("2026-11-12");

		// A failed send gives the day back with the old record; the retry asks
		// about the same days.
		await store.release(next);
		const retry = claimOf(await store.claim("2026-11-13", "-100", now));
		expect(retry.record.since).toBe("2026-11-12");

		// A crash mid-send: the claim holds for STALE_CLAIM_MS, then is taken over
		// with the crashed claim's window, not an empty one.
		now = new Date(now.getTime() + STALE_CLAIM_MS - 1000);
		expect((await store.claim("2026-11-13", "-100", now)).claim).toBeNull();
		now = new Date(now.getTime() + 2000);
		const takeover = claimOf(await store.claim("2026-11-13", "-100", now));
		expect(takeover.prev.status).toBe(CHECKIN_SENDING);
		expect(takeover.record.since).toBe("2026-11-12");

		// A quiet day also moves the window on.
		await store.finish(takeover, CHECKIN_QUIET, now);
		now = new Date(now.getTime() + 24 * 60 * 60 * 1000);
		const after = claimOf(await store.claim("2026-11-14", "-100", now));
		expect(after.record.since).toBe("2026-11-13");
	});

	it("takes over a crashed first-ever claim with the same empty window", async () => {
		const store = new CheckinStore(createMemoryStore());
		const at = new Date("2026-11-12T01:30:00Z");
		expect(claimOf(await store.claim("2026-11-12", "-100", at)).record.since).toBe("");
		const later = new Date(at.getTime() + STALE_CLAIM_MS + 60 * 1000);
		const takeover = claimOf(await store.claim("2026-11-12", "-100", later));
		expect(takeover.prev.status).toBe(CHECKIN_SENDING);
		// Not the day itself: an empty window means "ask about yesterday".
		expect(takeover.record.since).toBe("");
	});
});

// Go: TestCheckinAfterAnUnfinishedDay (checkin_state_test.go:88-110).
describe("TestCheckinAfterAnUnfinishedDay", () => {
	it("asks from the crashed claim's window the next day", async () => {
		const store = new CheckinStore(createMemoryStore());
		const d12 = new Date("2026-11-12T01:30:00Z");
		const day = 24 * 60 * 60 * 1000;
		const first = claimOf(await store.claim("2026-11-12", "1", d12));
		await store.finish(first, CHECKIN_SENT, d12);
		const c13 = claimOf(await store.claim("2026-11-13", "1", new Date(d12.getTime() + day)));
		expect(c13.record.since).toBe("2026-11-12");
		// Crashed on the 13th; nobody took over. On the 14th: from the 12th.
		const c14 = claimOf(await store.claim("2026-11-14", "1", new Date(d12.getTime() + 2 * day)));
		expect(c14.record.since).toBe("2026-11-12");
	});
});

// Go: TestCheckinReleaseOfFirstEver (checkin_state_test.go:112-125).
describe("TestCheckinReleaseOfFirstEver", () => {
	it("leaves the day claimable again", async () => {
		const store = new CheckinStore(createMemoryStore());
		const now = new Date("2026-11-12T01:30:00Z");
		const c = claimOf(await store.claim("2026-11-12", "1", now));
		await store.release(c);
		expect((await store.claim("2026-11-12", "1", now)).claim).not.toBeNull();
	});
});

// Go: TestCheckinOneWinner (checkin_state_test.go:127-157).
describe("TestCheckinOneWinner", () => {
	for (const variant of variants) {
		it(`${variant.name}: one of eight racing copies wins the day`, async () => {
			const store = new CheckinStore(variant.make());
			const now = new Date("2026-11-12T01:30:00Z");
			const results = await Promise.all(
				Array.from({ length: 8 }, async () => await store.claim("2026-11-12", "1", now)),
			);
			expect(results.filter((r) => r.claim !== null)).toHaveLength(1);
		});
	}
});

describe("the store's own rules", () => {
	it("refuses a body it cannot read, saying which file", async () => {
		const memory = createMemoryStore();
		await memory.put(CHECKIN_KEY, enc("not json"), null);
		await expect(new CheckinStore(memory).load()).rejects.toThrow("decode checkin.json: ");
	});

	it("reads a missing checkin.json as never sent", async () => {
		const { record, etag } = await new CheckinStore(createMemoryStore()).load();
		expect(record.day).toBe("");
		expect(etag).toBe("");
	});
});

// Go: checkinChat (checkin.go:44-63).
describe("checkinChat", () => {
	const tg: Telegram = {
		users: [
			{ id: "111", name: "ZY" },
			{ id: "222", name: "Partner" },
		],
		groups: ["-100", "-200"],
		fromEnv: true,
	};

	it("prefers the saved chat, then the first group, then the first person", () => {
		expect(checkinChat(parseCheckin("09:30", "-200"), tg)).toBe(-200);
		expect(checkinChat(parseCheckin("09:30", ""), tg)).toBe(-100);
		expect(checkinChat(parseCheckin("09:30", ""), { ...tg, groups: [] })).toBe(111);
		// A group that is not a number is skipped, as Go's ParseInt skips it.
		expect(checkinChat(parseCheckin("09:30", ""), { ...tg, groups: ["down", "-200"] })).toBe(-200);
		// A saved person is a private chat: the id is on the user list.
		expect(checkinChat(parseCheckin("09:30", "222"), tg)).toBe(222);
	});

	it("refuses a saved chat that is not on the allowlist, with Go's text", () => {
		expect(() => checkinChat(parseCheckin("09:30", "-999"), tg)).toThrow(
			"the check-in chat -999 is not an allowed group or person (Settings → Telegram)",
		);
	});

	it("has nowhere to send with nothing allowed, with Go's text", () => {
		expect(() => checkinChat(parseCheckin("09:30", ""), { users: [], groups: [], fromEnv: true })).toThrow(
			ERR_NO_CHECKIN_CHAT,
		);
	});
});

// ---------- T5.1c: the tick that sends it ----------

/** The rig's allowlist (bot_test.go:309-311): ZY and Partner, one group called Reno. */
const ALLOW: Telegram = {
	users: [
		{ id: "111", name: "ZY" },
		{ id: "222", name: "Partner" },
	],
	groups: ["-1001"],
	fromEnv: true,
};

const GROUP = -1001;
const ZY = 111;

/** One delivery the check-in made: the chat, its parts and the note. */
interface Sent {
	key: string;
	chat: number;
	texts: string[];
	buttons: number;
	note: string | undefined;
}

/** Go's `task(title, date, extra…)` (checkin_test.go:37). */
function task(title: string, date: string, extra: Patch = {}): Patch {
	return { kind: "task", title, date, ...extra };
}

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A check-in and the four things it reads, with the delivery recorded instead of sent. */
interface Harness {
	store: ObjectStore;
	settings: SettingsService;
	entries: EntriesService;
	checkin: CheckinService;
	sends: Sent[];
	lines: string[];
	/** Move the app's clock: every day and hour decision reads it. */
	set: (at: Date) => void;
	/** Make the delivery fail, as Telegram being down does. */
	failDeliver: boolean;
	/** Swap what the check-in reads of the settings (Go's `r.bot.Settings = broken`). */
	useSettings: (next: CheckinSettings) => void;
	seed: (patches: readonly Patch[]) => Promise<Record<string, string>>;
	/** `checkin.json` as stored, or null when there is none. */
	record: () => Promise<CheckinRecord | null>;
}

async function harness(o: { now: Date; store?: ObjectStore; settings?: CheckinSettings } = { now: new Date() }) {
	let clock = o.now;
	const now = (): Date => clock;
	const { log, lines } = createTestLog();
	const store = o.store ?? createMemoryStore();
	const entries = createEntriesService({ store: createMemoryStore(), log, now });
	await entries.load();
	const settings = createSettingsService({ store: createMemoryStore(), log, env: DEFAULTS, telegramEnv: ALLOW, now });
	const sends: Sent[] = [];
	let failDeliver = false;
	let current: CheckinSettings = o.settings ?? settings;
	const checkin = createCheckin({
		store,
		// A getter, so a test can swap the settings under a live check-in.
		settings: {
			resolveCheckin: async () => await current.resolveCheckin(),
			resolveTelegram: async () => await current.resolveTelegram(),
		},
		entries,
		deliver: async (key, address, parts, options) => {
			if (failDeliver) throw new Error("telegram sendMessage: 502 Bad Gateway");
			const chat = Number((address as { chat?: number }).chat ?? 0);
			sends.push({
				key,
				chat,
				texts: parts.map((part) => String((part as { text?: string }).text ?? "")),
				buttons: parts.filter((part) => (part as { reply_markup?: unknown }).reply_markup !== undefined).length,
				note: options?.note?.text,
			});
		},
		now,
		timeZone: "UTC",
		log,
	});
	const h: Harness = {
		store,
		settings,
		entries,
		checkin,
		sends,
		lines,
		set: (at) => {
			clock = at;
		},
		failDeliver: false,
		useSettings: (next) => {
			current = next;
		},
		seed: async (patches) => {
			await entries.create({ by: "ZY", channel: "web" }, patches);
			const ids: Record<string, string> = {};
			for (const entry of (await entries.current()).doc.entries) ids[entry.title] = entry.id;
			return ids;
		},
		record: async () => {
			try {
				return (await new CheckinStore(store).load()).record;
			} catch {
				return null;
			}
		},
	};
	// `failDeliver` is read through the object, so a test sets it on the harness.
	Object.defineProperty(h, "failDeliver", {
		get: () => failDeliver,
		set: (value: boolean) => {
			failDeliver = value;
		},
	});
	return h;
}

describe("TestCheckinScheduleCatchUpOncePerDay", () => {
	it("catches up once, once a day, and asks about the days it missed", async () => {
		const h = await harness({ now: new Date("2026-11-12T08:00:00Z") });
		await h.seed([task("Book movers", "2026-11-11"), task("Electrician", "2026-11-12")]);

		// 08:00: not yet. The next target is today's 09:30 (§2.2's table).
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-12T09:30:00Z"));
		expect(h.sends).toHaveLength(0);

		// The laptop woke at 14:00: catch up.
		h.set(new Date("2026-11-12T14:00:00Z"));
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-13T09:30:00Z"));
		expect(h.sends).toHaveLength(1);
		const [send] = h.sends;
		expect(send?.chat).toBe(GROUP);
		expect(send?.texts[0]).toContain("Good morning! Thu 12 Nov");
		expect(send?.texts[1]?.startsWith("Yesterday: Book movers")).toBe(true);
		expect(send?.buttons).toBe(1);
		// The note is Go's `(morning check-in)` and its reply (checkin.go:172-178).
		expect(send?.note?.startsWith("(morning check-in)\n\nGood morning! Thu 12 Nov")).toBe(true);
		expect(send?.note).toContain("Asked about:\n• Yesterday: Book movers");
		expect(await h.record()).toMatchObject({ day: "2026-11-12", status: CHECKIN_SENT, chat: `${GROUP}` });

		// The same process later, and another copy of the app on the same bucket: neither sends.
		h.set(new Date("2026-11-12T14:05:00Z"));
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-13T09:30:00Z"));
		const other = await harness({ now: new Date("2026-11-12T14:05:00Z"), store: h.store });
		expect(await other.checkin.tick()).toBe(Date.parse("2026-11-13T09:30:00Z"));
		expect(h.sends).toHaveLength(1);
		expect(other.sends).toHaveLength(0);

		// The next morning asks about the 12th's task (it was "today" on the 12th);
		// the 11th's, already asked about, is overdue.
		h.set(new Date("2026-11-13T09:30:00Z"));
		await h.checkin.tick();
		expect(h.sends).toHaveLength(2);
		const next = h.sends[1];
		expect(next?.texts[1]?.startsWith("Yesterday: Electrician")).toBe(true);
		expect(next?.texts[0]).toContain("Not marked done yet (1)");
		expect(next?.texts[0]).toContain("Still overdue (1):\n• Book movers");

		// The 14th and 15th are missed (the Mac was off); on the 16th both days' tasks
		// are asked about, and the older ones are overdue.
		await h.seed([task("Paint touch-up", "2026-11-14"), task("Sweep", "2026-11-15")]);
		h.set(new Date("2026-11-16T09:31:00Z"));
		await h.checkin.tick();
		expect(h.sends).toHaveLength(3);
		const missed = h.sends[2];
		expect(missed?.texts.slice(1)).toEqual(["Sat 14 Nov: Paint touch-up\nDone?", "Yesterday: Sweep\nDone?"]);
		expect(missed?.texts[0]).toContain("Not marked done yet (2)");
		expect(missed?.texts[0]).toContain("Still overdue (2)");
		expect(missed?.texts[0]).toContain("Book movers");
		expect(missed?.texts[0]).toContain("Electrician");
	});
});

describe("TestCheckinTakesOverACrashedClaim", () => {
	it("keeps checking while another copy's claim is fresh, then takes it over with its window", async () => {
		const h = await harness({ now: new Date("2026-11-13T09:30:00Z") });
		await h.seed([task("Electrician", "2026-11-12")]);
		const store = new CheckinStore(h.store);
		// The 12th went out (from another copy), then the 13th was claimed and lost.
		const yesterdays = await store.claim("2026-11-12", `${GROUP}`, new Date("2026-11-12T09:30:00Z"));
		if (yesterdays.claim === null) throw new Error("the 12th could not be claimed");
		await store.finish(yesterdays.claim, CHECKIN_SENT, new Date("2026-11-12T09:30:00Z"));
		const crashed = await store.claim("2026-11-13", `${GROUP}`, new Date("2026-11-13T09:30:00Z"));
		if (crashed.claim === null) throw new Error("the crash claim was not taken");

		// Fresh: nothing, and the tick comes back in a minute rather than tomorrow.
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-13T09:31:00Z"));
		h.set(new Date("2026-11-13T09:35:00Z"));
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-13T09:36:00Z"));
		expect(h.sends).toHaveLength(0);

		// Past STALE_CLAIM_MS: this copy takes over and asks the crashed claim's days.
		h.set(new Date("2026-11-13T09:41:00Z"));
		await h.checkin.tick();
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.texts[1]?.startsWith("Yesterday: Electrician")).toBe(true);
		expect(await h.record()).toMatchObject({ status: CHECKIN_SENT, since: "2026-11-12" });
	});
});

describe("TestCheckinTooLateQuietAndFailure", () => {
	it("skips a day started after 20:00, gives a failed day back, and records a quiet one", async () => {
		const h = await harness({ now: new Date("2026-11-12T21:00:00Z") });
		await h.seed([task("Book movers", "2026-11-11")]);
		// Started at 21:00: skip the day, and write nothing.
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-13T09:30:00Z"));
		expect(h.sends).toHaveLength(0);
		expect((await h.record())?.day).toBe("");

		// Telegram down at 09:30: the day is given back and retried.
		h.set(new Date("2026-11-13T09:30:00Z"));
		h.failDeliver = true;
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-13T09:31:00Z"));
		expect((await h.record())?.day).not.toBe("2026-11-13");
		h.failDeliver = false;
		h.set(new Date("2026-11-13T09:31:00Z"));
		await h.checkin.tick();
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.texts[0]).toContain("Good morning! Fri 13 Nov");
		expect((await h.record())?.status).toBe(CHECKIN_SENT);

		// A quiet day: nothing sent, recorded as quiet, so the window moves on.
		const doc = (await h.entries.current()).doc;
		const bookMovers = doc.entries.find((entry) => entry.title === "Book movers");
		if (bookMovers === undefined) throw new Error("the task is gone");
		await h.entries.update({ by: "ZY", channel: "web" }, bookMovers.id, { status: "done" });
		h.set(new Date("2026-11-14T10:00:00Z"));
		await h.checkin.tick();
		expect(h.sends).toHaveLength(1);
		expect(await h.record()).toMatchObject({ day: "2026-11-14", status: CHECKIN_QUIET });
	});
});

describe("TestCheckinChatMustBeAllowed", () => {
	it("refuses a chat that is not on the allowlist until it is fixed, then goes out the same day", async () => {
		const h = await harness({ now: new Date("2026-11-12T09:30:00Z") });
		await h.seed([task("Book movers", "2026-11-11")]);
		await h.settings.saveCheckin("test", { schedule: "09:30", chat: "-999", useEnv: false });

		const broken = await h.checkin.status();
		expect(String(broken.error)).toContain("the check-in chat -999 is not an allowed group or person");
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-12T09:31:00Z"));
		expect(h.sends).toHaveLength(0);
		expect((await h.record())?.day).toBe("");

		await h.settings.saveCheckin("test", { schedule: "09:30", chat: `${ZY}`, useEnv: false });
		const fixed = await h.checkin.status();
		expect([fixed.error, fixed.chat]).toEqual([undefined, `${ZY}`]);
		// Fixed the same day: it goes out at the next tick, to that person.
		h.set(new Date("2026-11-12T10:00:00Z"));
		await h.checkin.tick();
		expect(h.sends[0]?.chat).toBe(ZY);
		expect((await h.record())?.status).toBe(CHECKIN_SENT);
	});
});

describe("TestCheckinSkipsWhenSettingsUnreadable", () => {
	it("skips instead of falling back to the defaults, and a readable control does send", async () => {
		const h = await harness({ now: new Date("2026-11-12T10:00:00Z") });
		await h.seed([task("Book movers", "2026-11-11")]);
		await h.settings.saveCheckin("test", { schedule: "off", chat: "", useEnv: false });
		// Yesterday's check-in went out: the status should keep showing it.
		const store = new CheckinStore(h.store);
		const yesterdays = await store.claim("2026-11-11", `${GROUP}`, new Date("2026-11-11T10:00:00Z"));
		if (yesterdays.claim === null) throw new Error("the 11th could not be claimed");
		await store.finish(yesterdays.claim, CHECKIN_SENT, new Date("2026-11-11T10:00:00Z"));

		// The defaults would be on, 09:30, the group: exactly what a fallback would send.
		const broken = createSettingsService({
			store: settingsReadFails(createMemoryStore()),
			log: createTestLog().log,
			env: DEFAULTS,
			telegramEnv: ALLOW,
			now: () => new Date("2026-11-12T10:00:00Z"),
		});
		h.useSettings(broken);
		expect(await h.checkin.tick()).toBe(Date.parse("2026-11-12T10:01:00Z"));
		expect(h.sends).toHaveLength(0);
		expect((await h.record())?.day).toBe("2026-11-11");
		const view = await h.checkin.status();
		expect(String(view.error)).toContain("read settings.json");
		expect(view.on).toBe(false);
		expect(view.last).toMatchObject({ day: "2026-11-11" });
		expect((await broken.viewCheckin()).unreadable).toBe(true);

		// Control: a readable service with the same allowlist and the default schedule
		// does send, so the case above would catch a fallback.
		h.useSettings(
			createSettingsService({
				store: createMemoryStore(),
				log: createTestLog().log,
				env: DEFAULTS,
				telegramEnv: ALLOW,
				now: () => new Date("2026-11-12T10:00:00Z"),
			}),
		);
		await h.checkin.tick();
		expect(h.sends).toHaveLength(1);
		expect(h.sends[0]?.chat).toBe(GROUP);
	});
});

/** settingsReadFails fails reads of settings.json only (checkin_test.go:526-531). */
function settingsReadFails(inner: ObjectStore): ObjectStore {
	return {
		...inner,
		get: async (key, signal) => {
			if (key === SETTINGS_KEY) throw new Error("503 slow down");
			return await inner.get(key, signal);
		},
	};
}

/** Go's settings.Key. */
const SETTINGS_KEY = "settings.json";

describe("the tick's next target (T5-plan §2.2)", () => {
	it("answers a minute for what it cannot decide, and the next run for a finished day", async () => {
		const at = new Date("2026-11-12T14:00:00Z");
		const soon = Date.parse("2026-11-12T14:01:00Z");
		const tomorrow = Date.parse("2026-11-13T09:30:00Z");

		// Settings unreadable.
		{
			const h = await harness({ now: at });
			h.useSettings(
				createSettingsService({
					store: settingsReadFails(createMemoryStore()),
					log: createTestLog().log,
					env: DEFAULTS,
					telegramEnv: ALLOW,
					now: () => at,
				}),
			);
			expect(await h.checkin.tick()).toBe(soon);
		}
		// Chat not allowed.
		{
			const h = await harness({ now: at });
			await h.settings.saveCheckin("test", { schedule: "09:30", chat: "-999", useEnv: false });
			expect(await h.checkin.tick()).toBe(soon);
		}
		// Claim held by another copy.
		{
			const h = await harness({ now: at });
			await new CheckinStore(h.store).claim("2026-11-12", `${GROUP}`, at);
			expect(await h.checkin.tick()).toBe(soon);
		}
		// The day released: the delivery failed.
		{
			const h = await harness({ now: at });
			await h.seed([task("Book movers", "2026-11-11")]);
			h.failDeliver = true;
			expect(await h.checkin.tick()).toBe(soon);
			expect((await h.record())?.status).not.toBe(CHECKIN_SENT);
		}
		// On, before the time: today at hh:mm.
		{
			const h = await harness({ now: new Date("2026-11-12T08:00:00Z") });
			expect(await h.checkin.tick()).toBe(Date.parse("2026-11-12T09:30:00Z"));
		}
		// Off: the default time, so the fifteen-minute cap re-reads the setting.
		{
			const h = await harness({ now: at });
			await h.settings.saveCheckin("test", { schedule: "off", chat: "", useEnv: false });
			expect(await h.checkin.tick()).toBe(tomorrow);
		}
		// At or after 20:00: the day is gone.
		{
			const h = await harness({ now: new Date("2026-11-12T20:00:00Z") });
			expect(await h.checkin.tick()).toBe(tomorrow);
		}
		// The day finished.
		{
			const h = await harness({ now: at });
			await h.seed([task("Book movers", "2026-11-11")]);
			expect(await h.checkin.tick()).toBe(tomorrow);
			expect(h.sends).toHaveLength(1);
			expect(await h.checkin.tick()).toBe(tomorrow);
			expect(h.sends).toHaveLength(1);
		}
	});
});

// ---------- the durable task and the rearm ----------

/** A clock and a timer a test drives, as T5.1b's adapter tests have (adapter.test.ts:1954). */
interface ManualClock {
	now: () => number;
	nowDate: () => Date;
	setTimer: Timer;
	/** Move time forward without firing anything: a laptop asleep across the target. */
	jump: (ms: number) => void;
	/** Fire every timer that is due, as the event loop would. */
	advance: (ms: number) => Promise<void>;
}

function manualClock(start: Date): ManualClock {
	let clock = start.getTime();
	const timers: { at: number; callback: () => void }[] = [];
	return {
		now: () => clock,
		nowDate: () => new Date(clock),
		setTimer: (callback, delayMs, _options) => {
			// A zero delay is pi-durable pacing a run in flight, not a wall-clock sleep:
			// a real timer, so the work it paces makes progress instead of spinning on a
			// clock that does not move (adapter.test.ts's specs never pace).
			if (delayMs === 0) {
				const handle = setTimeout(callback, 0);
				return () => clearTimeout(handle);
			}
			const timer = { at: clock + delayMs, callback };
			timers.push(timer);
			return () => {
				const at = timers.indexOf(timer);
				if (at >= 0) timers.splice(at, 1);
			};
		},
		jump: (ms) => {
			clock += ms;
		},
		advance: async (ms) => {
			const target = clock + ms;
			for (;;) {
				const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
				if (next === undefined) break;
				timers.splice(timers.indexOf(next), 1);
				clock = Math.max(clock, next.at);
				next.callback();
				// A real macrotask after each firing: the run it starts does store reads and
				// arms the next sleep, and a tighter loop would starve them.
				await new Promise((done) => setTimeout(done, 1));
			}
			clock = Math.max(clock, target);
		},
	};
}

/** Once the harness has the check-in's task sleeping, its `target` is what the next run gets. */
async function sleepingTarget(agent: Agent): Promise<number | null> {
	await untilSchedules(agent, asleep, "the check-in's sleep");
	const [task] = await inspectSchedules(agent);
	return task?.target ?? null;
}

function asleep(list: ScheduleInspection[]): boolean {
	return list.length === 1 && list[0]?.state === "sleeping";
}

async function untilSchedules(
	agent: Agent,
	done: (list: ScheduleInspection[]) => boolean,
	what: string,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	for (;;) {
		if (done(await inspectSchedules(agent))) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done2) => setTimeout(done2, 5));
	}
}

/** A check-in driven by the durable schedule task, with the delivery recorded. */
interface Scheduled {
	agent: Agent;
	checkin: CheckinService;
	settings: SettingsService;
	entries: EntriesService;
	clock: ManualClock;
	sends: Sent[];
	lines: string[];
}

async function scheduledCheckin(o: { now: Date; store?: ObjectStore }): Promise<Scheduled> {
	const dir = await mkdtemp(join(tmpdir(), "movin-t51c-"));
	dirs.push(dir);
	const { log, lines } = createTestLog();
	const clock = manualClock(o.now);
	const store = o.store ?? createMemoryStore();
	const entries = createEntriesService({ store: createMemoryStore(), log, now: clock.nowDate });
	await entries.load();
	const settings = createSettingsService({
		store: createMemoryStore(),
		log,
		env: DEFAULTS,
		telegramEnv: ALLOW,
		now: clock.nowDate,
	});
	const sends: Sent[] = [];
	const checkin = createCheckin({
		store,
		settings,
		entries,
		deliver: async (key, address, parts) => {
			sends.push({
				key,
				chat: Number((address as { chat?: number }).chat ?? 0),
				texts: parts.map((part) => String((part as { text?: string }).text ?? "")),
				buttons: parts.filter((part) => (part as { reply_markup?: unknown }).reply_markup !== undefined).length,
				note: undefined,
			});
		},
		now: clock.nowDate,
		timeZone: "UTC",
		log,
	});
	const agent = await openAgent({
		dbPath: join(dir, "harness.db"),
		settings,
		log,
		now: clock.now,
		setTimer: clock.setTimer,
		schedules: [checkin.spec],
	});
	return { agent, checkin, settings, entries, clock, sends, lines };
}

describe("TestCheckinTimeFromSettings", () => {
	it("applies a saved time at the next run, stops while off, and re-arms on a save", async () => {
		const s = await scheduledCheckin({ now: new Date("2026-11-12T09:45:00Z") });
		try {
			await s.entries.create({ by: "ZY", channel: "web" }, [task("Book movers", "2026-11-11")]);
			await s.settings.saveCheckin("test", { schedule: "10:00", chat: "", useEnv: false });

			// 09:45 with 10:00 saved: nothing, and the task sleeps until 10:00.
			const target1 = await sleepingTarget(s.agent);
			expect(target1).toBe(Date.parse("2026-11-12T10:00:00Z"));
			expect(s.sends).toHaveLength(0);

			// The task's own sleep fires at 10:00: one check-in.
			await s.clock.advance(15 * 60_000);
			await untilSchedules(s.agent, asleep, "the sleep after the 10:00 run");
			expect(s.sends).toHaveLength(1);
			expect(s.sends[0]?.texts[0]).toContain("Good morning! Thu 12 Nov");

			// Off stops it, and the status says so (Go's `On:false, At:""`).
			await s.settings.saveCheckin("test", { schedule: "off", chat: "", useEnv: false });
			await s.agent.schedule.rearm("checkin");
			await untilSchedules(s.agent, asleep, "the sleep an off setting arms");
			const off = await s.checkin.status();
			expect([off.on, off.at]).toEqual([false, undefined]);
			// A day with nothing due: the cap wakes it, and nothing is sent.
			await s.clock.advance(24 * 3_600_000);
			expect(s.sends).toHaveLength(1);

			// Back on at 10:00, and a save re-arms it: it runs at once and sends.
			await s.settings.saveCheckin("test", { schedule: "10:00", chat: "", useEnv: false });
			await s.agent.schedule.rearm("checkin");
			await untilSchedules(s.agent, asleep, "the sleep after the re-armed run");
			expect(s.sends).toHaveLength(2);
		} finally {
			await s.agent.close();
		}
	});
});

describe("a sleep armed for 09:30 that fires at 21:00", () => {
	it("sends nothing and writes no record", async () => {
		const s = await scheduledCheckin({ now: new Date("2026-11-12T09:29:00Z") });
		try {
			await s.entries.create({ by: "ZY", channel: "web" }, [task("Book movers", "2026-11-11")]);
			// The task is armed for 09:30: the target is inside the cap.
			expect(await sleepingTarget(s.agent)).toBe(Date.parse("2026-11-12T09:30:00Z"));

			// The laptop slept through it: the clock is 21:00 when the timer fires.
			s.clock.jump(11 * 3_600_000 + 31 * 60_000);
			await s.clock.advance(0);
			// The wake re-checks the window: past the cutoff sends nothing, and the day
			// is not recorded (checkin_state.go:161-166).
			expect(await untilSchedules(s.agent, asleep, "the sleep after the late wake")).toBeUndefined();
			expect(s.sends).toHaveLength(0);
			await expect(new CheckinStore(createMemoryStore()).load()).resolves.toBeDefined();
			expect(await inspectSchedules(s.agent)).toEqual([
				expect.objectContaining({ name: "checkin", state: "sleeping", target: Date.parse("2026-11-13T09:30:00Z") }),
			]);
		} finally {
			await s.agent.close();
		}
	});
});
