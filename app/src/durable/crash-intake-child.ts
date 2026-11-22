// Test fixture for the T4.2a intake crash cases in crash.test.ts: one process
// that accepts a poll batch (and, by mode, submits its first item) and then
// hangs, so the test can SIGKILL it at the window that case is about
// (T4-plan.md §2.6, W3-W5).
//
//   MOVIN_CRASH_DB=<dbPath> MOVIN_CRASH_MARKER=<file> MOVIN_CRASH_MODE=accept|tool|settled
//   MOVIN_CRASH_PREFIX=<s3 prefix, `tool` only>
//   node src/durable/crash-intake-child.ts
//
// `accept`: the batch is accepted and nothing is submitted (W3).
// `tool`: the batch is accepted, the first item is submitted, and its add_entry
// writes and then hangs inside the tool (W4). The entries live in MinIO under
// MOVIN_CRASH_PREFIX, because the recovery process has to see the write.
// `settled`: the first item's turn runs to its answer and the item is left open,
// because the settle that would drop it never runs (W5).
//
// The marker gets one line per step so the parent knows the window is open: the
// accepted ids, `written` (the tool's write landed) and `recovered` is the
// recovery's own line, which the parent's tool writes instead.
//
// It imports the adapter and nothing of pi-durable, so the rule that only
// src/durable/adapter.ts may import pi-durable still holds.

import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildTools } from "../agent/tools.ts";
import { createEntriesService } from "../entries/service.ts";
import { createLog } from "../log.ts";
import { createS3Store } from "../objstore/s3.ts";
import { type IntakeItem, openAgent, type ToolSpec } from "./adapter.ts";

const dbPath = process.env.MOVIN_CRASH_DB ?? "";
const marker = process.env.MOVIN_CRASH_MARKER ?? "";
const mode = process.env.MOVIN_CRASH_MODE ?? "accept";
const prefix = process.env.MOVIN_CRASH_PREFIX ?? "";
const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

/** The chat key the items belong to; the parent uses the same one. */
const KEY = "tg:4242";

const log = createLog({ level: "error", write: () => undefined });

/** hang is a promise that never settles: the process is killed while awaiting it. */
function hang(): Promise<void> {
	return new Promise(() => undefined);
}

/**
 * stay keeps this process alive for the kill. A phase that hangs in its tool arms
 * no referenced timer, and the harness's own are background, so without this the
 * event loop would empty and Node would exit on its own instead of being killed.
 */
function stay(): void {
	setInterval(() => undefined, 60_000);
}

/** items are the updates a poll took in: two for W4, where the second must stay queued. */
const items: IntakeItem[] = (mode === "tool" ? [10, 11] : [10]).map((id) => ({
	id,
	key: KEY,
	address: { chat: 4242, group: false },
	payload: { text: `message ${id}` },
	at: 1_000 + id,
}));

/** hangAfterWrite is the tool W4 kills: the write lands, and then the tool waits. */
function hangAfterWrite(tool: ToolSpec): ToolSpec {
	return {
		...tool,
		execute: async (args, ctx) => {
			const result = await tool.execute(args, ctx);
			appendFileSync(marker, `written actor=${JSON.stringify(ctx.actor)}\n`);
			await hang();
			return result;
		},
	};
}

const tools: ToolSpec[] =
	mode === "tool"
		? buildTools({
				entries: createEntriesService({
					store: createS3Store({ bucket, prefix, region, endpointUrl }),
					log,
					now: () => new Date("2026-11-11T09:00:00Z"),
				}),
			}).map(hangAfterWrite)
		: [];

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses(
	Array.from(
		{ length: 16 },
		() => (context: { messages: { role: string }[] }) =>
			context.messages.at(-1)?.role === "toolResult"
				? fauxAssistantMessage(fauxText("Run one answered."))
				: mode === "tool"
					? fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage(fauxText("Run one answered.")),
	),
);

const agent = await openAgent({
	dbPath,
	settings: {
		resolve: async () => ({
			kind: "openai",
			vision: false,
			baseUrl: "http://faux.test/v1",
			apiKey: "",
			model: "faux-1",
			timeoutSec: 60,
			maxToolRounds: 3,
			streaming: true,
			thinkOnDemand: false,
		}),
	},
	log,
	tools,
	models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
});

// The batch is durable before anything acts on it: this is the commit every mode
// starts from, and the one W3 dies right after.
const accepted = await agent.intake.accept({ cursor: 11, items });
appendFileSync(marker, `accepted ${accepted.map((item) => item.id).join(",")}\n`);

if (mode !== "accept") {
	const first = items[0] as IntakeItem;
	const submitting = {
		requestId: `tg:${first.id}`,
		intake: { id: first.id, deadlineAt: Date.now() + 15 * 60 * 1000 },
		...(mode === "tool" ? { actor: { by: "partner", channel: "telegram" } } : {}),
	};
	if (mode === "tool") {
		// The run hangs inside its tool, so the kill lands between the write and the
		// answer — with item 11 still queued behind it.
		void agent.submit(KEY, `message ${first.id}`, submitting);
	} else {
		// The run settles, and the item stays `open`: no settle ever runs.
		await agent.submit(KEY, `message ${first.id}`, submitting);
		appendFileSync(marker, "settled\n");
	}
}

stay();
await hang();
