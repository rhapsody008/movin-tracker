// Test fixture for the T3.3 crash case in crash.test.ts: one process that
// submits a turn whose add_entry WRITES the entry and then hangs inside the
// tool, so the test can SIGKILL it after the write but before the answer.
//
//   MOVIN_CRASH_DB=<dbPath> MOVIN_CRASH_MARKER=<file> MOVIN_CRASH_PREFIX=<s3 prefix>
//   node src/durable/crash-tools-child.ts
//
// The entries live in MinIO under MOVIN_CRASH_PREFIX, which is how the recovery
// process sees the write at all: a memory store would not outlive this process.
// The marker gets one line per tool execution, with the actor the tool saw, so
// the parent can prove the recovery's rerun still knows who asked.

import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildTools } from "../agent/tools.ts";
import { createEntriesService } from "../entries/service.ts";
import { createLog } from "../log.ts";
import { createS3Store } from "../objstore/s3.ts";
import { openAgent, type ToolSpec } from "./adapter.ts";

const dbPath = process.env.MOVIN_CRASH_DB ?? "";
const marker = process.env.MOVIN_CRASH_MARKER ?? "";
const prefix = process.env.MOVIN_CRASH_PREFIX ?? "";
const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";
const log = createLog({ level: "error", write: () => undefined });

const entries = createEntriesService({
	store: createS3Store({ bucket, prefix, region, endpointUrl }),
	log,
	now: () => new Date("2026-11-11T09:00:00Z"),
});

/** Hangs after the real tool wrote, so the kill lands between the write and the answer. */
function hangAfterWrite(tool: ToolSpec): ToolSpec {
	return {
		...tool,
		execute: async (args, ctx) => {
			const result = await tool.execute(args, ctx);
			appendFileSync(marker, `actor=${JSON.stringify(ctx.actor)}\n`);
			await new Promise(() => undefined);
			return result;
		},
	};
}

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses(
	Array.from(
		{ length: 16 },
		() => (context: { messages: { role: string }[] }) =>
			context.messages.at(-1)?.role === "toolResult"
				? fauxAssistantMessage(fauxText("Saved it."))
				: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
						stopReason: "toolUse",
					}),
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
	tools: buildTools({ entries }).map(hangAfterWrite),
	models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
});

await agent.submit("web:zy@example.com", "quartz for the wet kitchen", {
	actor: { by: "partner", channel: "telegram" },
});
