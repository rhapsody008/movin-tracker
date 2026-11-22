// The pi-ai wiring: the model entry the app synthesises for a connection it only
// knows an id for, the Models collection T3.2 gets, and the key as pi-ai wants it.
// Every case runs against src/llm/stub.ts, so none of it touches the network.
import { describe, expect, it } from "vitest";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import { complete } from "./complete.ts";
import { llmModels, modelEntry, PROVIDER_ID } from "./provider.ts";
import { startStub } from "./stub.ts";

function config(baseUrl: string, over: Partial<LLM> = {}): LLM {
	return { ...DEFAULTS, baseUrl, model: "movin-backend", apiKey: "sk-test-1234", timeoutSec: 5, ...over };
}

describe("modelEntry", () => {
	it("synthesises the entry pi-ai needs from the id the app saved", () => {
		expect(modelEntry(config("http://llm.test/v1"))).toEqual({
			id: "movin-backend",
			name: "movin-backend",
			api: "openai-completions",
			provider: "movin",
			baseUrl: "http://llm.test/v1",
			input: ["text"],
			reasoning: true,
			compat: { thinkingFormat: "qwen-chat-template", supportsDeveloperRole: false },
			contextWindow: 128_000,
			maxTokens: 8_192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("takes images only when the saved connection passed the vision probe", () => {
		expect(modelEntry(config("http://llm.test/v1", { vision: true })).input).toEqual(["text", "image"]);
		expect(modelEntry(config("http://llm.test/v1", { vision: false })).input).toEqual(["text"]);
	});
});

describe("llmModels", () => {
	it("registers the one provider and hands back the model ref T3.2 stores", () => {
		const { models, modelRef } = llmModels(config("http://llm.test/v1"));
		expect(modelRef).toEqual({ provider: PROVIDER_ID, modelId: "movin-backend" });
		expect(modelRef.provider).toBe("movin");
		expect(models.getModel(PROVIDER_ID, "movin-backend")?.api).toBe("openai-completions");
		expect(models.getModels(PROVIDER_ID)).toHaveLength(1);
	});
});

describe("the Authorization header", () => {
	it("is a Bearer with the saved key, and never x-api-key or anthropic-version", async () => {
		const stub = await startStub();
		try {
			await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			expect(stub.requests).toHaveLength(1);
			const headers = stub.requests[0]?.headers;
			expect(headers?.authorization).toBe("Bearer sk-test-1234");
			expect(headers?.["x-api-key"]).toBeUndefined();
			expect(headers?.["anthropic-version"]).toBeUndefined();
		} finally {
			await stub.close();
		}
	});

	it("is absent entirely with no saved key, which Go also never sent (openai.go:58-60)", async () => {
		const stub = await startStub();
		try {
			// pi-ai refuses a request with no key at all, so the provider is handed a
			// placeholder key and a chat API whose fetch removes the header it builds.
			await complete(config(`${stub.origin}/v1`, { apiKey: "" }), { messages: [user("hi")] });
			expect(stub.requests).toHaveLength(1);
			const headers = stub.requests[0]?.headers;
			expect(headers?.authorization).toBeUndefined();
			expect(headers?.["x-api-key"]).toBeUndefined();
			expect(headers?.["anthropic-version"]).toBeUndefined();
		} finally {
			await stub.close();
		}
	});

	it("survives a request the harness makes, not just complete()", async () => {
		const stub = await startStub();
		try {
			// pi-durable's ConversationStreamOptions has no apiKey and no fetch
			// (durable-api.md §4), so this is the path with no per-request override at
			// all: the wrapper on the provider is what keeps the header off.
			const { models } = llmModels(config(`${stub.origin}/v1`, { apiKey: "" }));
			const message = await models.streamSimple(modelEntry(config(`${stub.origin}/v1`, { apiKey: "" })), {
				messages: [user("hi")],
			});
			expect((await message.result()).stopReason).toBe("stop");
			expect(stub.requests).toHaveLength(1);
			expect(stub.requests[0]?.headers.authorization).toBeUndefined();
		} finally {
			await stub.close();
		}
	});
});

/** One user turn, as complete() takes it. */
function user(text: string): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: text, timestamp: 1_700_000_000_000 };
}
