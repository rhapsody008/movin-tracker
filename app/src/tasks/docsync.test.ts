// T5.2: the "Documents updated" group notice (Go's DocsChanged, docs.go:18-37,
// and the notice half of `TestDocumentSyncAndNotices`) and the daily document
// sync as a durable `movin.schedule` spec (T5-plan §4 T5.2). The notice is
// driven by the real syncer, so "only on change, never the first import" is the
// engine's rule and is proven through the notifier, as Go's tests did.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeConverter } from "../docs/convert/fake.ts";
import type { Sync } from "../docs/index.ts";
import { createSyncer } from "../docs/sync.ts";
import { type Agent, inspectSchedules, openAgent, type ScheduleInspection, type Timer } from "../durable/adapter.ts";
import { createTestLog, type Log } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { DEFAULTS } from "../settings/settings.ts";
import type { Telegram } from "../settings/telegram.ts";
import { createDocsNotifier, type DocsDeliver, docsyncSpec } from "./docsync.ts";

const GROUPS = ["-1001", "-2002", "-3003"];
const ONE_GROUP = ["-1001"];
const FIXED = new Date("2026-11-12T03:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** 240 characters, so a page counts as having text (MIN_TEXT_CHARS is 100). */
const LONG = "Defrost the freezer every six months. Keep the door seal clean with warm soapy water. ".repeat(3);

const encoder = new TextEncoder();

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function allow(groups: readonly string[] = ONE_GROUP): Telegram {
	return { users: [], groups: [...groups], fromEnv: true };
}

function result(reason: string): Sync {
	return {
		at: "2026-11-11T03:00:00Z",
		reason,
		added: 0,
		changed: 0,
		removed: 0,
		failed: 0,
		skipped: 0,
		refreshed: 0,
		error: "",
	};
}

/** until polls for work the notifier or the schedule does in the background. */
async function until(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((done) => setTimeout(done, 5));
	}
	throw new Error(`waited for ${what}`);
}

/** logged is the test log's lines as objects. */
function logged(lines: readonly string[]): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** One notice as the delivery received it. */
interface Notice {
	key: string;
	address: unknown;
	texts: string[];
}

interface DocsRig {
	store: ReturnType<typeof createMemoryStore>;
	conv: FakeConverter;
	log: Log;
	lines: string[];
	notifier: ReturnType<typeof createDocsNotifier>;
	syncer: ReturnType<typeof createSyncer>;
	/** Where the notifier delivers, once attached. */
	deliver: DocsDeliver;
	notices: Notice[];
	/** Keys whose delivery fails, as Telegram refusing one group. */
	failing: Set<string>;
	put: (key: string, body: string) => Promise<void>;
}

/** docsRig is one real syncer over a fake converter, with the notice recorded. */
function docsRig(o: { groups?: readonly string[]; now?: () => Date } = {}): DocsRig {
	const store = createMemoryStore();
	const conv = new FakeConverter();
	conv.pages.set("pdf-fridge-v1", [{ n: 1, w: 595, h: 842, text: LONG }]);
	conv.pages.set("pdf-fridge-v2", [{ n: 1, w: 595, h: 842, text: `${LONG}Version two.` }]);
	conv.pages.set("pdf-oven-v1", [{ n: 1, w: 595, h: 842, text: `Oven manual ${LONG}` }]);
	conv.pages.set("pdf-power-v1", [{ n: 1, w: 2384, h: 1684, text: `POWER LEGEND ${LONG}` }]);
	const { log, lines } = createTestLog();
	const notices: Notice[] = [];
	const failing = new Set<string>();
	const deliver: DocsDeliver = async (key, address, parts) => {
		if (failing.has(key)) throw new Error(`send to ${key} failed`);
		notices.push({
			key,
			address,
			texts: parts.map((part) => String((part as { text?: string }).text ?? "")),
		});
	};
	const notifier = createDocsNotifier({ settings: { resolveTelegram: async () => allow(o.groups) }, log });
	const syncer = createSyncer({ store, converter: conv, notify: notifier, log, now: o.now ?? (() => FIXED) });
	return {
		store,
		conv,
		log,
		lines,
		notifier,
		syncer,
		deliver,
		notices,
		failing,
		put: async (key, body) => {
			await store.putBlob(key, encoder.encode(body), "application/pdf");
		},
	};
}

describe("TestDocumentSyncAndNotices (the notice half)", () => {
	it("is silent for the first import, posts one Documents updated notice for a change, and none for a no-op", async () => {
		const r = docsRig();
		r.notifier.attach(r.deliver);

		// The first import: one document read, nobody told (docs.go:18-23).
		await r.put("docs/raw/Fridge.pdf", "pdf-fridge-v1");
		const first = await r.syncer.sync("daily");
		expect(first.added).toBe(1);
		expect(r.notices).toEqual([]);

		// A document the nightly sync finds: exactly one notice, Go's text.
		await r.put("docs/raw/Oven.pdf", "pdf-oven-v1");
		const later = await r.syncer.sync("daily");
		expect(later.added).toBe(1);
		await until(() => r.notices.length === 1, "the notice");
		expect(r.notices[0]).toEqual({
			key: "tg:-1001",
			// Go's plain SendMessage: no keyboard, no thread (messageId 0 is never sent).
			address: { chat: -1001, messageId: 0, group: true },
			texts: ["Documents updated: 1 added\n• Oven.pdf"],
		});

		// Nothing to do: no second notice, and no second message of any kind.
		await r.syncer.sync("daily");
		await new Promise((done) => setTimeout(done, 50));
		expect(r.notices).toHaveLength(1);
	});
});

describe("the notice's recipients", () => {
	it("skips the chat that asked for the sync, and a group that is not a chat id", async () => {
		const r = docsRig({ groups: ["-1001", "-2002", "ops"] });
		r.notifier.attach(r.deliver);
		await r.put("docs/raw/Fridge.pdf", "pdf-fridge-v1");
		await r.syncer.sync("startup");

		await r.put("docs/raw/Oven.pdf", "pdf-oven-v1");
		// `/sync` passes `telegram:<chat id>`: that chat gets the reply, not the notice.
		await r.syncer.sync("telegram:-1001");
		await until(() => r.notices.length === 1, "the notice");
		await new Promise((done) => setTimeout(done, 50));
		expect(r.notices.map((n) => n.key)).toEqual(["tg:-2002"]);
	});

	it("keeps sending after one group's delivery fails", async () => {
		const r = docsRig({ groups: GROUPS });
		r.failing.add("tg:-1001");
		r.notifier.attach(r.deliver);
		await r.put("docs/raw/Fridge.pdf", "pdf-fridge-v1");
		await r.syncer.sync("startup");

		await r.put("docs/raw/Oven.pdf", "pdf-oven-v1");
		await r.syncer.sync("daily");
		await until(() => r.notices.length === 2, "the other two groups");
		expect(r.notices.map((n) => n.key)).toEqual(["tg:-2002", "tg:-3003"]);
		expect(logged(r.lines)).toContainEqual(
			expect.objectContaining({
				level: "WARN",
				msg: "telegram documents notice failed",
				chatId: -1001,
				err: "send to tg:-1001 failed",
			}),
		);
	});
});

describe("TestFailedThenFixedImportStaysSilent (through the notifier)", () => {
	it("says nothing while nothing was ever readable, then announces the first change", async () => {
		const r = docsRig();
		r.notifier.attach(r.deliver);
		await r.put("docs/raw/Fridge.pdf", "pdf-fridge-v1");
		await r.put("docs/raw/Power.pdf", "pdf-power-v1");
		r.conv.fail.set("pdf-fridge-v1", new Error("pdfinfo: not installed"));
		r.conv.fail.set("pdf-power-v1", new Error("pdfinfo: not installed"));

		// Both documents fail: a failed import is not a change worth announcing.
		const failed = await r.syncer.sync("daily");
		expect({ failed: failed.failed, notices: r.notices.length }).toEqual({ failed: 2, notices: 0 });

		// Fixed the same day: the first readable import is still silent.
		r.conv.fail.clear();
		const fixed = await r.syncer.sync("daily");
		expect({ added: fixed.added, notices: r.notices.length }).toEqual({ added: 2, notices: 0 });

		// From now on changes are announced, naming the document.
		await r.put("docs/raw/Fridge.pdf", "pdf-fridge-v2");
		const changed = await r.syncer.sync("daily");
		expect(changed.changed).toBe(1);
		await until(() => r.notices.length === 1, "the changed document's notice");
		expect(r.notices[0]?.texts).toEqual(["Documents updated: 1 changed\n• Fridge.pdf"]);
	});
});

describe("a notice raised before the agent is open", () => {
	it("is held, at most eight of them, and sent in order on attach", async () => {
		const r = docsRig();
		// The startup sync runs before the agent opens (main.ts). Ten syncs: the first
		// is the silent first import, so nine notices are held.
		for (let i = 0; i < 10; i++) {
			await r.put(`docs/raw/Doc ${i}.pdf`, "pdf-fridge-v1");
			await r.syncer.sync("daily");
		}
		expect(r.notices).toEqual([]);

		r.notifier.attach(r.deliver);
		await until(() => r.notices.length === 8, "the held notices");
		// The newest eight: the notice for Doc 1 is the one dropped.
		expect(r.notices.map((n) => n.texts[0])).toEqual(
			Array.from({ length: 8 }, (_, i) => `Documents updated: 1 added\n• Doc ${i + 2}.pdf`),
		);
		expect(r.notices[0]?.key).toBe("tg:-1001");
	});
});

describe("the notice never breaks the sync that raised it", () => {
	it("logs a settings read failure instead of throwing into the run", async () => {
		const { log, lines } = createTestLog();
		const notifier = createDocsNotifier({
			settings: {
				resolveTelegram: async () => {
					throw new Error("settings.json is unreadable");
				},
			},
			log,
		});
		notifier.attach(async () => {
			throw new Error("nothing may be delivered");
		});
		notifier.docsChanged(result("daily"), []);
		await until(
			() => logged(lines).some((line) => line.msg === "telegram documents notice failed"),
			"the failure line",
		);
		expect(logged(lines)).toContainEqual(
			expect.objectContaining({
				level: "WARN",
				msg: "telegram documents notice failed",
				err: "settings.json is unreadable",
			}),
		);
	});
});

describe("docsyncSpec", () => {
	it("syncs once the stored target has passed, and answers the next 03:00", async () => {
		const calls: string[] = [];
		let at = new Date("2026-11-11T02:45:00Z");
		const { log } = createTestLog();
		const spec = docsyncSpec({
			syncer: {
				sync: async (reason: string) => {
					calls.push(reason);
					return result(reason);
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => at,
			log,
		});

		// Created: nothing is due, and the first target is today's 03:00.
		expect(await spec.run({ target: null })).toBe(Date.parse("2026-11-11T03:00:00Z"));
		expect(calls).toEqual([]);

		// A capped wake before the target: still nothing.
		at = new Date("2026-11-11T02:59:00Z");
		expect(await spec.run({ target: Date.parse("2026-11-11T03:00:00Z") })).toBe(Date.parse("2026-11-11T03:00:00Z"));
		expect(calls).toEqual([]);

		// At the target: one daily sync, and tomorrow's 03:00 next.
		at = new Date("2026-11-11T03:00:00Z");
		expect(await spec.run({ target: Date.parse("2026-11-11T03:00:00Z") })).toBe(Date.parse("2026-11-12T03:00:00Z"));
		expect(calls).toEqual(["daily"]);
	});

	it("targets the next morning when a run finishes at 23:59, across the month end", async () => {
		const calls: string[] = [];
		const { log } = createTestLog();
		const spec = docsyncSpec({
			syncer: {
				sync: async (reason: string) => {
					calls.push(reason);
					return result(reason);
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => new Date("2026-11-30T23:59:00Z"),
			log,
		});
		expect(await spec.run({ target: Date.parse("2026-11-30T03:00:00Z") })).toBe(Date.parse("2026-12-01T03:00:00Z"));
		expect(calls).toEqual(["daily"]);
	});

	it("answers the next 03:00 ahead, not one in the past, when the target is two days old", async () => {
		const calls: string[] = [];
		const { log } = createTestLog();
		const spec = docsyncSpec({
			syncer: {
				sync: async (reason: string) => {
					calls.push(reason);
					return result(reason);
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => new Date("2026-12-02T10:00:00Z"),
			log,
		});
		// A pod down for two nights: the target is 2026-11-30's 03:00, and the next run is
		// the coming 03:00 — the passed one would wake the task at once, a second sync.
		expect(await spec.run({ target: Date.parse("2026-11-30T03:00:00Z") })).toBe(Date.parse("2026-12-03T03:00:00Z"));
		expect(calls).toEqual(["daily"]);
	});

	it("never syncs when the schedule is off, and looks again a day later", async () => {
		const calls: string[] = [];
		const at = new Date("2026-11-11T12:00:00Z");
		const { log, lines } = createTestLog();
		const spec = docsyncSpec({
			syncer: {
				sync: async (reason: string) => {
					calls.push(reason);
					return result(reason);
				},
			},
			schedule: "off",
			timeZone: "UTC",
			now: () => at,
			log,
		});
		expect(await spec.run({ target: Date.parse("2026-11-11T03:00:00Z") })).toBe(at.getTime() + DAY_MS);
		expect(calls).toEqual([]);
		// Go armed no timer, so there is no "next daily document sync" either.
		expect(logged(lines).filter((line) => line.msg === "next daily document sync")).toEqual([]);
	});

	it("logs a failed sync and keeps the schedule", async () => {
		const { log, lines } = createTestLog();
		const spec = docsyncSpec({
			syncer: {
				sync: async () => {
					throw new Error("poppler: killed");
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => new Date("2026-11-11T03:00:00Z"),
			log,
		});
		expect(await spec.run({ target: Date.parse("2026-11-11T03:00:00Z") })).toBe(Date.parse("2026-11-12T03:00:00Z"));
		expect(logged(lines)).toContainEqual(
			expect.objectContaining({
				level: "WARN",
				msg: "daily document sync failed",
				err: "poppler: killed",
			}),
		);
	});

	it("says nothing about a sync the shutdown aborted, and still arms the next run", async () => {
		const abort = new AbortController();
		const { log, lines } = createTestLog();
		const spec = docsyncSpec({
			syncer: {
				sync: async () => {
					// The pod's SIGTERM landed inside the sync: Go's `ctx.Err() != nil` case
					// (internal/docs/schedule.go:55).
					abort.abort(new Error("SIGTERM"));
					throw new Error("context canceled");
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => new Date("2026-11-11T03:00:00Z"),
			log,
		});
		expect(await spec.run({ target: Date.parse("2026-11-11T03:00:00Z"), signal: abort.signal })).toBe(
			Date.parse("2026-11-12T03:00:00Z"),
		);
		expect(logged(lines).filter((line) => line.msg === "daily document sync failed")).toEqual([]);
	});

	it("logs the next run once per new target, as Go's re-armed timer did", async () => {
		let at = new Date("2026-11-11T02:00:00Z");
		const { log, lines } = createTestLog();
		const spec = docsyncSpec({
			syncer: { sync: async (reason: string) => result(reason) },
			schedule: "03:00",
			timeZone: "UTC",
			now: () => at,
			log,
		});
		const target = Date.parse("2026-11-11T03:00:00Z");
		expect(await spec.run({ target: null })).toBe(target);
		at = new Date("2026-11-11T02:15:00Z");
		expect(await spec.run({ target })).toBe(target);
		at = new Date("2026-11-11T02:30:00Z");
		expect(await spec.run({ target })).toBe(target);
		expect(logged(lines).filter((line) => line.msg === "next daily document sync")).toEqual([
			expect.objectContaining({ level: "INFO", at: "2026-11-11T03:00:00Z" }),
		]);
	});
});

// ---------- the durable daily trigger ----------

/** A clock and a timer a test drives, as `tasks/checkin.test.ts` has one. */
interface ManualClock {
	now: () => number;
	nowDate: () => Date;
	setTimer: Timer;
	advance: (ms: number) => Promise<void>;
}

function manualClock(start: Date): ManualClock {
	let clock = start.getTime();
	const timers: { at: number; callback: () => void }[] = [];
	return {
		now: () => clock,
		nowDate: () => new Date(clock),
		setTimer: (callback, delayMs) => {
			// A zero delay is pi-durable pacing a run in flight, not a wall-clock sleep:
			// a real timer, so the work it paces makes progress instead of spinning on a
			// clock that does not move (T5.1c's decision, decisions.md).
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
		await new Promise((done) => setTimeout(done, 5));
	}
}

describe("the daily document sync as a durable task", () => {
	it("keeps the 03:00 target across a close, and syncs the day once when it wakes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t52-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const clock = manualClock(new Date("2026-11-11T02:00:00Z"));
		const { log } = createTestLog();
		const calls: string[] = [];
		const spec = docsyncSpec({
			syncer: {
				sync: async (reason: string) => {
					calls.push(reason);
					return result(reason);
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: clock.nowDate,
			log,
		});
		const open = async (): Promise<Agent> =>
			await openAgent({
				dbPath,
				settings: { resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "m" }) },
				log,
				now: clock.now,
				setTimer: clock.setTimer,
				schedules: [spec],
			});

		// Open at 02:00: the task has never run, so it asks for today's 03:00 and sleeps
		// on the 15-minute cap with that target stored.
		const first = await open();
		try {
			await untilSchedules(first, asleep, "the first sleep");
			expect(await inspectSchedules(first)).toEqual([
				{
					name: "docsync",
					state: "sleeping",
					until: Date.parse("2026-11-11T02:15:00Z"),
					target: Date.parse("2026-11-11T03:00:00Z"),
				},
			]);
			expect(calls).toEqual([]);
		} finally {
			await first.close();
		}

		// Reopened before the target: the same one task, the same target, still no sync.
		const second = await open();
		try {
			await untilSchedules(second, asleep, "the sleep after the reopen");
			expect(await inspectSchedules(second)).toEqual([
				{
					name: "docsync",
					state: "sleeping",
					until: Date.parse("2026-11-11T02:15:00Z"),
					target: Date.parse("2026-11-11T03:00:00Z"),
				},
			]);
			expect(calls).toEqual([]);

			// 03:00: one daily sync, and the next target is the day after.
			await clock.advance(3_600_000);
			await untilSchedules(
				second,
				(list) => list[0]?.target === Date.parse("2026-11-12T03:00:00Z") && asleep(list),
				"the next day's target",
			);
			expect(calls).toEqual(["daily"]);
		} finally {
			await second.close();
		}
	});
});
