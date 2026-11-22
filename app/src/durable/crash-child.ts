// Test fixture for crash.test.ts: one process that submits a message whose
// replay-safe tool hangs, so the test can SIGKILL it inside the tool and then
// reopen the same database. It imports the adapter and pi-ai only, so the rule
// that only src/durable/adapter.ts may import pi-durable still holds.
//
//   node src/durable/crash-child.ts <dbPath> <markerFile>
//
// The tool appends "started" before it hangs: that line in the marker file is
// what the test waits for before it kills this process.

import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createLog } from "../log.ts";
import { openAgent } from "./adapter.ts";

const dbPath = process.argv[2] ?? "";
const marker = process.argv[3] ?? "";

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
faux.setResponses(
	Array.from(
		{ length: 16 },
		() => (context: { messages: { role: string }[] }) =>
			context.messages.at(-1)?.role === "toolResult"
				? fauxAssistantMessage(fauxText("done"))
				: fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
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
	log: createLog({ level: "error", write: () => undefined }),
	tools: [
		{
			name: "slow",
			description: "A tool that never finishes, so the process can be killed inside it.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			writes: false,
			execute: async () => {
				appendFileSync(marker, "started\n");
				await new Promise(() => undefined);
				return { text: "unreachable" };
			},
		},
	],
	models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
});

await agent.submit("web:zy@example.com", "go");
