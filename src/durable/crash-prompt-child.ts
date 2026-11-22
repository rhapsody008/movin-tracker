// Test fixture for the T3.4 crash case in crash.test.ts: one process whose
// prompt hook stores a state with the submit, then hangs inside a replay-safe
// tool so the test can SIGKILL it after the submission commit but before the
// run settled (and so before afterRun could advance the state).
//
//   node src/durable/crash-prompt-child.ts <dbPath> <markerFile>
//
// The marker holds the state the hook returned, one JSON line, so the parent
// can prove the submit commit kept it.

import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createLog } from "../log.ts";
import { type AgentHooks, openAgent } from "./adapter.ts";

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

const hooks: AgentHooks = {
	userContent: async (_key, text, { state }) => {
		const previous = (state ?? {}) as { runs?: number };
		const next = { runs: (previous.runs ?? 0) + 1, seen: { a: "line-a" } };
		appendFileSync(marker, `${JSON.stringify({ at: "submit", state: next })}\n`);
		return { content: text, state: next };
	},
	afterRun: async (_key, _result, state) => {
		const previous = (state ?? {}) as { after?: number };
		const next = { ...(state as object), after: (previous.after ?? 0) + 1 };
		appendFileSync(marker, `${JSON.stringify({ at: "after", state: next })}\n`);
		return next;
	},
};

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
	hooks,
	tools: [
		{
			name: "slow",
			description: "A tool that never finishes, so the process can be killed after the submit.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			writes: false,
			execute: async () => {
				appendFileSync(marker, `${JSON.stringify({ at: "tool" })}\n`);
				await new Promise(() => undefined);
				return { text: "unreachable" };
			},
		},
	],
	models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
});

await agent.submit("web:zy@example.com", "one");
