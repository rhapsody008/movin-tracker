// Test fixture for T4.2b's two bot crash cases in `src/telegram/crash.test.ts`:
// one process that really polls a Bot API, accepts the update into the ledger and
// runs its turn — and then hangs, so the test can SIGKILL it mid-turn and watch
// the next process finish the turn and send its reply exactly once.
//
//   MOVIN_CRASH_DB=<dbPath> MOVIN_CRASH_MARKER=<file> MOVIN_CRASH_API=<fake Bot API url>
//   MOVIN_CRASH_LLM=<scripted LLM url> MOVIN_CRASH_MODE=tool|model
//   MOVIN_CRASH_PREFIX=<s3 prefix>   (mode `tool`, where the write must be shared)
//   S3_ENDPOINT_URL/S3_BUCKET/AWS_REGION
//   node src/telegram/crash-bot-child.ts
//
// `tool`: the model asks for a write, the tool's write lands in the bucket and
// then hangs; the marker says `written`. That is the T3.3/T4.2a W4 window.
// `model`: the model never answers at all, so the kill lands inside the request;
// the marker says `open` once the ledger holds the turn and the request is out.
// Its entries are in memory, because nothing has to be shared.
//
// It imports the adapter and this package only, never pi-durable: the rule that
// `src/durable/adapter.ts` is the only importer still holds.

import { appendFileSync } from "node:fs";
import { buildTools } from "../agent/tools.ts";
import { openAgent, type ToolSpec } from "../durable/adapter.ts";
import { createEntriesService } from "../entries/service.ts";
import { createLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { createSettingsService, DEFAULTS } from "../settings/settings.ts";
import { createBot, createBotState } from "./bot.ts";
import { createClient } from "./client.ts";
import { FAKE_TOKEN } from "./fake-api.ts";
import { createOutbox } from "./outbox.ts";

const dbPath = process.env.MOVIN_CRASH_DB ?? "";
const marker = process.env.MOVIN_CRASH_MARKER ?? "";
const api = process.env.MOVIN_CRASH_API ?? "";
const llm = process.env.MOVIN_CRASH_LLM ?? "";
const mode = process.env.MOVIN_CRASH_MODE ?? "tool";
const prefix = process.env.MOVIN_CRASH_PREFIX ?? "";
const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

const log = createLog({ level: "error", write: () => undefined });

/** hang is a promise that never settles: the process is killed while awaiting it. */
function hang(): Promise<void> {
	return new Promise(() => undefined);
}

/** stay keeps this process alive for the kill: a hanging request does, but not on every path. */
function stay(): void {
	setInterval(() => undefined, 60_000);
}

const store: ObjectStore =
	mode === "tool" ? createS3Store({ bucket, prefix, region, endpointUrl }) : createMemoryStore();
const clock = (): Date => new Date("2026-11-11T09:00:00Z");
const entries = createEntriesService({ store, log, now: clock });
const settings = createSettingsService({
	store,
	log,
	env: { ...DEFAULTS, baseUrl: llm, model: "m", timeoutSec: 60, maxToolRounds: 3 },
	telegramEnv: { users: [{ id: "111", name: "ZY" }], groups: [], fromEnv: true },
	now: clock,
});
const state = createBotState(true);
const client = createClient({ token: FAKE_TOKEN, baseUrl: api });

/** hangAfterWrite is the tool `tool` mode kills: the write lands, and then it waits. */
function hangAfterWrite(tool: ToolSpec): ToolSpec {
	return {
		...tool,
		execute: async (args, ctx) => {
			const result = await tool.execute(args, ctx);
			appendFileSync(marker, "written\n");
			await hang();
			return result;
		},
	};
}

const plain = buildTools({ entries, docs: null, viewer: null });
const tools = mode === "tool" ? plain.map(hangAfterWrite) : plain;

// The adapter keeps the real clock: pi-durable arms a retry's sleep in real
// milliseconds, so a frozen clock would make a retry never come due
// (generation.js's `retry` phase: "A run before `until` … sleeps again").
const agent = await openAgent({
	dbPath,
	settings,
	log,
	tools,
	outbox: createOutbox({ client, log, state }),
});
const bot = createBot({ client, settings, agent, entries, syncer: null, timeZone: "UTC", state, log, pollSeconds: 1 });
void bot.run();

// The window: the turn is open in the ledger — submitted, with its submission
// durable — and the process is inside the work it cannot finish.
for (;;) {
	const ledger = await agent.intake.state();
	if (ledger.open.length > 0) break;
	await new Promise((done) => setTimeout(done, 20));
}
if (mode === "model") appendFileSync(marker, "open\n");

stay();
await new Promise(() => undefined);
