// Test fixture for T5.2's crash case in `src/telegram/crash.test.ts`: the daily
// document sync as a durable schedule reaches 03:00, starts the sync and is
// killed inside it, so the next process has to run the day again.
//
//   MOVIN_CRASH_DB=<sqlite path> MOVIN_CRASH_MARKER=<file>
//   node src/telegram/crash-docsync-child.ts
//
// The clock starts at 02:00 and every armed sleep moves it forward by the delay
// it was given, so the task's 15-minute sleeps reach 03:00 in a few milliseconds
// without waiting for them. The "sync" writes the marker and never returns: that
// is the moment the test kills this one. The store is this process's own memory;
// the database is what the two processes share.

import { appendFileSync } from "node:fs";
import { openAgent } from "../durable/adapter.ts";
import { createLog } from "../log.ts";
import { DEFAULTS } from "../settings/settings.ts";
import { docsyncSpec } from "../tasks/docsync.ts";

const dbPath = process.env.MOVIN_CRASH_DB ?? "";
const marker = process.env.MOVIN_CRASH_MARKER ?? "";

/** The day the run is about: 2026-11-12, 02:00 UTC, an hour before the schedule. */
let clock = Date.parse("2026-11-12T02:00:00Z");

const log = createLog({ level: "error", write: () => undefined });

await openAgent({
	dbPath,
	settings: { resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "m" }) },
	log,
	now: () => clock,
	setTimer: (callback, delayMs) => {
		// Each armed sleep moves the clock exactly that far, as if it had elapsed.
		const handle = setTimeout(() => {
			clock += Math.max(delayMs, 1);
			callback();
		}, 0);
		return () => clearTimeout(handle);
	},
	schedules: [
		docsyncSpec({
			syncer: {
				sync: async (reason) => {
					appendFileSync(marker, `${reason}\n`);
					return await new Promise<never>(() => undefined);
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => new Date(clock),
			log,
		}),
	],
});

// Nothing on every other path: stay alive for the kill.
setInterval(() => undefined, 60_000);
