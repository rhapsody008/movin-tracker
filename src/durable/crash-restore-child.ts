// Test fixture for the T5.3a restore case in crash.test.ts: one process that
// leaves a database a Velero snapshot would capture, and waits to be SIGKILLed
// (T5-plan §5.3, child A):
//
//   MOVIN_CRASH_DB      the SQLite file
//   MOVIN_CRASH_MARKER  the file this child appends its steps to
//   MOVIN_CRASH_PREFIX  the S3 prefix the entries live under
//   MOVIN_CRASH_STUB    the LLM stub's origin (src/llm/stub.ts)
//   MOVIN_CRASH_URL     the outbox recorder's URL
//
// What it leaves behind:
// - chat 111: an accepted intake batch (100 submitted, 101 queued), whose turn
//   called add_entry — the write is in S3 and the tool then hangs;
// - chat 222: a two-part delivery whose first send hangs;
// - chat 333: a delivery sleeping on a 429;
// - one sleeping `movin.schedule` task.
//
// The marker's last line is `ready <epoch>`, which is what the parent waits for
// before it kills this process. It imports the adapter and nothing of
// pi-durable, so the rule that only src/durable/adapter.ts may import pi-durable
// still holds.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { buildTools } from "../agent/tools.ts";
import { createEntriesService } from "../entries/service.ts";
import { createLog } from "../log.ts";
import { createS3Store } from "../objstore/s3.ts";
import { DEFAULTS } from "../settings/settings.ts";
import {
	type IntakeItem,
	inspectSchedules,
	OutboxError,
	type OutboxJson,
	openAgent,
	type ToolSpec,
} from "./adapter.ts";
import { createStartGuard } from "./startguard.ts";

const dbPath = process.env.MOVIN_CRASH_DB ?? "";
const marker = process.env.MOVIN_CRASH_MARKER ?? "";
const prefix = process.env.MOVIN_CRASH_PREFIX ?? "";
const stub = process.env.MOVIN_CRASH_STUB ?? "";
const recorder = process.env.MOVIN_CRASH_URL ?? "";
const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

/** The keys the case asserts on. */
const CHAT = "tg:111";
const SENDING = "tg:222";
const FLOODED = "tg:333";

const line = (text: string): void => appendFileSync(marker, `${text}\n`);

/** hang is a promise that never settles: the process is killed while awaiting it. */
function hang(): Promise<void> {
	return new Promise(() => undefined);
}

const log = createLog({ level: "error", write: () => undefined });
const store = createS3Store({ bucket, prefix, region, endpointUrl });
const entries = createEntriesService({ store, log, now: () => new Date() });

/** written is add_entry with a marker line and then the hang: the kill lands inside the tool. */
function written(tool: ToolSpec): ToolSpec {
	return {
		...tool,
		execute: async (args, ctx) => {
			const result = await tool.execute(args, ctx);
			line(`written ${result.changes?.[0]?.id ?? "no-change"}`);
			await hang();
			return result;
		},
	};
}

const items: IntakeItem[] = [100, 101].map((id) => ({
	id,
	key: CHAT,
	address: { chat: 111, group: false },
	payload: { text: `message ${String(id)}` },
	at: 1_000 + id,
}));

const agent = await openAgent({
	dbPath,
	settings: {
		resolve: async () => ({ ...DEFAULTS, baseUrl: `${stub}/v1`, model: "stub-model", apiKey: "" }),
	},
	log,
	tools: buildTools({ entries }).map((tool) => (tool.name === "add_entry" ? written(tool) : tool)),
	// 222's first part hangs, 333's part is flooded with a wait this test outlives,
	// and every other part reaches the recorder.
	outbox: {
		send: async (_address: OutboxJson, part: OutboxJson): Promise<void> => {
			if (part === "222a") {
				line("send 222a");
				await hang();
			}
			if (part === "333a") {
				line("send 333a");
				const flooded = new OutboxError("telegram sendMessage: 429 Too Many Requests");
				flooded.retryAfterMs = 60_000;
				throw flooded;
			}
			await fetch(recorder, { method: "POST", body: JSON.stringify(part) });
			line(`sent ${String(part)}`);
		},
	},
	schedules: [
		{
			name: "checkin",
			run: async () => {
				line("schedule run");
				return Date.now() + 10 * 60_000;
			},
		},
	],
	startGuard: createStartGuard({ store, instance: "dev", restoreId: "", log }),
});

// The batch is durable, and its first item becomes the open turn whose tool hangs.
line(`accepted ${(await agent.intake.accept({ cursor: 11, items })).map((item) => item.id).join(",")}`);
void agent.submit(CHAT, "message 100", {
	requestId: "tg:100",
	intake: { id: 100, deadlineAt: Date.now() + 15 * 60_000 },
	actor: { by: "partner", channel: "telegram" },
});
await agent.deliver(SENDING, { chat: 222, group: false }, ["222a", "222b"]);
await agent.deliver(FLOODED, { chat: 333, group: false }, ["333a"]);

// Everything the snapshot must carry is in place once these lines are written.
const deadline = Date.now() + 20_000;
for (;;) {
	const text = existsSync(marker) ? readFileSync(marker, "utf8") : "";
	const sleeping = (await inspectSchedules(agent)).some((task) => task.state === "sleeping");
	if (text.includes("written ") && text.includes("send 222a") && text.includes("send 333a") && sleeping) break;
	if (Date.now() > deadline) {
		line("not ready");
		break;
	}
	await new Promise((done) => setTimeout(done, 25));
}
line(`ready ${agent.epoch}`);

// The spawned tasks run in the background: keep the process up for the kill.
setInterval(() => undefined, 60_000);
await hang();
