// The documents background work: the startup sync, a once-a-minute check for
// index changes made by another copy of the app (dev and production share the
// bucket), and the daily sync at DOCS_SYNC_SCHEDULE. Port of
// internal/docs/schedule.go.
//
// The daily run is one timer, re-armed after each run at the next time the
// app's zone shows the scheduled clock; "off" means there is no daily timer
// (the startup sync and the refresh still run). It can also be left out
// entirely (`daily: false`), which is what production does: the daily run is the
// agent's durable `docsync` schedule there (T5.2), and two of them would sync
// twice. Every timer is unref'd: the server keeps the process alive, not this.
//
// The clock and the timer are injected so a test can move time instead of
// waiting for it.

import { errorMessage, type Log } from "../log.ts";
import { nextRun, parseSchedule, rfc3339 } from "../sched.ts";
import type { Syncer } from "./sync.ts";

/** DOCS_SYNC_SCHEDULE's default (Go's docs.DefaultSyncSchedule). */
export const DEFAULT_SYNC_SCHEDULE = "03:00";

/** How often the cached index is checked against the bucket's ETag. */
const REFRESH_MS = 60_000;

/** Arms `run` after `afterMs`; the returned function cancels it. */
export type SetTimer = (run: () => void, afterMs: number) => () => void;

export interface DocsBackgroundOptions {
	/** The sync itself; a Syncer satisfies it. */
	syncer: Pick<Syncer, "sync" | "refresh">;
	/** DOCS_SYNC_SCHEDULE as written: HH:MM in timeZone, or off. */
	schedule: string;
	/** The TZ name the schedule is read in. */
	timeZone: string;
	log: Log;
	/** The clock; tests pass their own. */
	now?: () => Date;
	/** The timer; tests pass their own. */
	setTimer?: SetTimer;
	/**
	 * Run the daily timer here. False when the daily run is the durable schedule
	 * instead (T5.2), so exactly one of them runs it; the startup sync and the
	 * minute refresh are unaffected. Default true.
	 */
	daily?: boolean;
}

/**
 * Background starts the startup sync, the minute refresh and the daily timer,
 * and returns the function that stops all of them. Throws when the schedule is
 * not "HH:MM" or off, before anything starts.
 */
export function startDocsBackground(o: DocsBackgroundOptions): () => void {
	const at = parseSchedule("DOCS_SYNC_SCHEDULE", o.schedule, DEFAULT_SYNC_SCHEDULE);
	const now = o.now ?? ((): Date => new Date());
	const setTimer = o.setTimer ?? unrefTimer;
	const daily = o.daily ?? true;
	let stopped = false;
	const armed = new Set<() => void>();

	async function run(reason: string, failure: string): Promise<void> {
		try {
			await o.syncer.sync(reason);
		} catch (err) {
			if (!stopped) o.log.warn(failure, { err: errorMessage(err) });
		}
	}

	async function refresh(): Promise<void> {
		try {
			await o.syncer.refresh();
		} catch (err) {
			if (!stopped) o.log.debug("documents index refresh failed", { err: errorMessage(err) });
		}
	}

	/** Arms one timer and remembers how to cancel it. */
	function arm(run: () => void, afterMs: number): void {
		let cancel: () => void = () => undefined;
		cancel = setTimer(() => {
			armed.delete(cancel);
			run();
		}, afterMs);
		armed.add(cancel);
	}

	function armRefresh(): void {
		arm(() => {
			void refresh();
			armRefresh(); // the next check, whatever this one did
		}, REFRESH_MS);
	}

	function armDaily(): void {
		if (!daily || !at.on || stopped) return;
		const from = now();
		const next = nextRun(from, at.hour, at.minute, o.timeZone);
		o.log.info("next daily document sync", { at: rfc3339(next, o.timeZone) });
		arm(() => {
			void run("daily", "daily document sync failed").then(() => armDaily());
		}, next.getTime() - from.getTime());
	}

	void run("startup", "startup document sync failed");
	armRefresh();
	armDaily();

	return () => {
		stopped = true;
		for (const cancel of [...armed]) cancel();
		armed.clear();
	};
}

/** setTimeout, unref'd: a pending sync timer must not keep the process alive. */
function unrefTimer(run: () => void, afterMs: number): () => void {
	const timer = setTimeout(run, afterMs);
	timer.unref();
	return () => clearTimeout(timer);
}
