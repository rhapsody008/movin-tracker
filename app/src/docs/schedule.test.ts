// The documents background work (internal/docs/schedule.go): the startup sync,
// the minute refresh and the daily timer. The clock and the timer are injected,
// so the tests move time instead of waiting for it.
import { describe, expect, it, vi } from "vitest";
import { createTestLog } from "../log.ts";
import type { Sync } from "./index.ts";
import type { SetTimer } from "./schedule.ts";
import { DEFAULT_SYNC_SCHEDULE, startDocsBackground } from "./schedule.ts";

const FIXED = new Date("2026-11-11T00:00:00Z"); // 08:00 in Singapore

function result(reason: string): Sync {
	return {
		at: "2026-11-11T00:00:00Z",
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

/** A syncer that records what it was asked to do and can be made to fail. */
function fakeSyncer(): {
	syncer: { sync: (reason: string) => Promise<Sync>; refresh: () => Promise<void> };
	reasons: string[];
	refreshes: number;
	fail: (reason: string, err: Error) => void;
} {
	const reasons: string[] = [];
	let refreshes = 0;
	const failures = new Map<string, Error>();
	return {
		reasons: reasons,
		get refreshes() {
			return refreshes;
		},
		syncer: {
			sync: async (reason: string): Promise<Sync> => {
				reasons.push(reason);
				const err = failures.get(reason);
				if (err !== undefined) throw err;
				return result(reason);
			},
			refresh: async (): Promise<void> => {
				refreshes++;
			},
		},
		fail: (reason, err) => void failures.set(reason, err),
	};
}

interface Armed {
	run: () => void;
	afterMs: number;
}

/**
 * The injected timer: nothing fires until the test says so, and a run takes its
 * timer out of the list the way a real one-shot timer does.
 */
function fakeTimers(): { armed: Armed[]; setTimer: SetTimer } {
	const armed: Armed[] = [];
	const setTimer: SetTimer = (fn, afterMs) => {
		const timer: Armed = {
			afterMs,
			run: () => {
				const at = armed.indexOf(timer);
				if (at >= 0) armed.splice(at, 1);
				fn();
			},
		};
		armed.push(timer);
		return () => {
			const at = armed.indexOf(timer);
			if (at >= 0) armed.splice(at, 1);
		};
	};
	return { armed, setTimer };
}

/** Lets every pending promise run (the startup sync is detached). */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function logged(lines: readonly string[]): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("startDocsBackground", () => {
	it("runs the startup sync, then a refresh every minute", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log } = createTestLog();
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		expect(fake.reasons).toEqual(["startup"]);
		// One minute timer and the daily one.
		expect(timers.armed.map((t) => t.afterMs)).toEqual([60_000, 19 * 3_600_000]);

		const refresh = timers.armed[0];
		refresh?.run();
		await flush();
		expect(fake.refreshes).toBe(1);
		// The next check is armed again, and the daily timer is untouched.
		expect(timers.armed.map((t) => t.afterMs)).toEqual([19 * 3_600_000, 60_000]);
		stop();
	});

	it("arms the daily sync for the next scheduled time and re-arms it after the run", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log, lines } = createTestLog();
		let clock = FIXED;
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => clock,
			setTimer: timers.setTimer,
		});
		await flush();
		expect(logged(lines)).toContainEqual(
			expect.objectContaining({ level: "INFO", msg: "next daily document sync", at: "2026-11-12T03:00:00+08:00" }),
		);
		const daily = timers.armed.find((t) => t.afterMs > 60_000);
		expect(daily?.afterMs).toBe(19 * 3_600_000);

		// The daily run happens at 03:00 on the 12th: the next one is a day later.
		clock = new Date("2026-11-11T19:00:00Z");
		daily?.run();
		await flush();
		expect(fake.reasons).toEqual(["startup", "daily"]);
		const rearmed = timers.armed.find((t) => t.afterMs > 60_000);
		expect(rearmed?.afterMs).toBe(24 * 3_600_000);
		stop();
	});

	it("has no daily timer when the schedule is off, but still syncs and refreshes", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log, lines } = createTestLog();
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "OFF",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		expect(fake.reasons).toEqual(["startup"]);
		expect(timers.armed.map((t) => t.afterMs)).toEqual([60_000]);
		expect(logged(lines).filter((l) => l.msg === "next daily document sync")).toEqual([]);
		stop();
	});

	it("leaves the daily run to the durable schedule when asked, and still syncs and refreshes", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log, lines } = createTestLog();
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
			// T5.2: the agent's `docsync` spec is the one daily run in production.
			daily: false,
		});
		await flush();
		expect(fake.reasons).toEqual(["startup"]);
		// The minute refresh only: no daily timer, and no line saying one was armed.
		expect(timers.armed.map((t) => t.afterMs)).toEqual([60_000]);
		expect(logged(lines).filter((l) => l.msg === "next daily document sync")).toEqual([]);
		timers.armed[0]?.run();
		await flush();
		expect(fake.refreshes).toBe(1);
		expect(fake.reasons).toEqual(["startup"]);
		stop();
		expect(timers.armed).toEqual([]);
	});

	it("stops every timer", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log } = createTestLog();
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		expect(timers.armed).toHaveLength(2);
		stop();
		expect(timers.armed).toEqual([]);
		const reasons = [...fake.reasons];
		await flush();
		expect(fake.reasons).toEqual(reasons); // nothing fires after the stop
	});

	it("logs a failing sync and keeps the loop going", async () => {
		const fake = fakeSyncer();
		fake.fail("startup", new Error("boom"));
		fake.fail("daily", new Error("later"));
		const timers = fakeTimers();
		const { log, lines } = createTestLog();
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		expect(logged(lines)).toContainEqual(
			expect.objectContaining({ level: "WARN", msg: "startup document sync failed", err: "boom" }),
		);
		timers.armed.find((t) => t.afterMs > 60_000)?.run();
		await flush();
		expect(logged(lines)).toContainEqual(
			expect.objectContaining({ level: "WARN", msg: "daily document sync failed", err: "later" }),
		);
		// A failed daily run re-arms too.
		expect(timers.armed.filter((t) => t.afterMs > 60_000)).toHaveLength(1);
		stop();
	});

	it("logs a failing refresh at debug level only", async () => {
		const timers = fakeTimers();
		const { log, lines } = createTestLog();
		const stop = startDocsBackground({
			syncer: {
				sync: async (reason: string) => result(reason),
				refresh: async () => {
					throw new Error("etag");
				},
			},
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		timers.armed[0]?.run();
		await flush();
		expect(logged(lines)).toContainEqual(
			expect.objectContaining({ level: "DEBUG", msg: "documents index refresh failed", err: "etag" }),
		);
		stop();
	});

	it("refuses a schedule that is not HH:MM or off, before anything starts", () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log } = createTestLog();
		expect(() =>
			startDocsBackground({
				syncer: fake.syncer,
				schedule: "noon",
				timeZone: "Asia/Singapore",
				log,
				now: () => FIXED,
				setTimer: timers.setTimer,
			}),
		).toThrow('DOCS_SYNC_SCHEDULE must be HH:MM (24 h) or off, not "noon"');
		expect(fake.reasons).toEqual([]);
		expect(timers.armed).toEqual([]);
	});

	it("takes 03:00 when the schedule is empty", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log } = createTestLog();
		expect(DEFAULT_SYNC_SCHEDULE).toBe("03:00");
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		expect(timers.armed.map((t) => t.afterMs)).toEqual([60_000, 19 * 3_600_000]);
		stop();
	});

	// F2 f: a run that finishes after stop() must not arm another timer.
	it("arms no timer once stopped, even when a run finishes after the stop", async () => {
		const fake = fakeSyncer();
		const timers = fakeTimers();
		const { log } = createTestLog();
		const stop = startDocsBackground({
			syncer: fake.syncer,
			schedule: "03:00",
			timeZone: "Asia/Singapore",
			log,
			now: () => FIXED,
			setTimer: timers.setTimer,
		});
		await flush();
		const daily = timers.armed.find((t) => t.afterMs > 60_000);
		if (daily === undefined) throw new Error("no daily timer was armed");
		daily.run(); // it fires just as the app is shutting down
		stop();
		await flush(); // the run finishes after the stop
		expect(timers.armed).toEqual([]);
	});

	it("unrefs its timers, so a pending sync can't keep the process alive", () => {
		const fake = fakeSyncer();
		const { log } = createTestLog();
		const original = globalThis.setTimeout;
		const made: NodeJS.Timeout[] = [];
		const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((run: () => void, afterMs: number) => {
			const timer = original(run, afterMs);
			made.push(timer);
			return timer;
		}) as typeof setTimeout);
		let stop: () => void = () => undefined;
		try {
			stop = startDocsBackground({
				syncer: fake.syncer,
				schedule: "03:00",
				timeZone: "Asia/Singapore",
				log,
				now: () => FIXED,
			});
			expect(made).toHaveLength(2);
			expect(made.map((t) => t.hasRef())).toEqual([false, false]);
		} finally {
			stop();
			spy.mockRestore();
		}
	});
});
