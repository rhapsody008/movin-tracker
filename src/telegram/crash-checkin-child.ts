// Test fixture for T5.1c's crash case in `src/telegram/crash.test.ts`: one
// process takes the day's `checkin.json` claim and then hangs before it commits
// the delivery, so the test can SIGKILL it inside that window and watch the next
// process take the stale claim over with the crashed claim's window.
//
//   MOVIN_CRASH_MARKER=<file> MOVIN_CRASH_PREFIX=<s3 prefix>
//   S3_ENDPOINT_URL/S3_BUCKET/AWS_REGION
//   node src/telegram/crash-checkin-child.ts
//
// The bucket is MinIO: `checkin.json` and the entries are what the two processes
// share, and the marker says `claimed` once the claim is in the bucket — which is
// the moment the test kills this one.
//
// It imports no pi-durable: the check-in's tick and its store are plain code.

import { appendFileSync } from "node:fs";
import { createEntriesService } from "../entries/service.ts";
import { createLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import { createSettingsService, DEFAULTS } from "../settings/settings.ts";
import { createCheckin } from "../tasks/checkin.ts";

const marker = process.env.MOVIN_CRASH_MARKER ?? "";
const prefix = process.env.MOVIN_CRASH_PREFIX ?? "";
const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

const log = createLog({ level: "error", write: () => undefined });

/** The day the crashed run is about: 2026-11-13, 09:30 UTC. */
const clock = (): Date => new Date("2026-11-13T09:30:00Z");

const store = createS3Store({ bucket, prefix, region, endpointUrl });
const entries = createEntriesService({ store, log, now: clock });
await entries.load();
const settings = createSettingsService({
	// The settings are this process's own: only `checkin.json` and the entries are shared.
	store: createMemoryStore(),
	log,
	env: DEFAULTS,
	telegramEnv: { users: [{ id: "111", name: "ZY" }], groups: ["-1001"], fromEnv: true },
	now: clock,
});

const checkin = createCheckin({
	store,
	settings,
	entries,
	// The window the test kills: the claim is durable, the delivery is not.
	deliver: async () => {
		appendFileSync(marker, "claimed\n");
		await new Promise(() => undefined);
	},
	now: clock,
	timeZone: "UTC",
	log,
});

await checkin.tick();

// Nothing on every other path: stay alive for the kill.
setInterval(() => undefined, 60_000);
await new Promise(() => undefined);
