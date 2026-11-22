// The LLM summariser. Port of TestLLMSummariser (internal/docs/summary_test.go:70-92)
// against src/llm/stub.ts: the prompt, the one user message, the tidied answer and
// the error without a connection. Go's `Stream` assertion has no port — pi-ai's
// chat call always streams on the wire (decisions.md · T3.1) — so what is pinned
// instead is that no tool is offered and no delta ever reaches the caller.
import { describe, expect, it } from "vitest";
import { type Stub, startStub } from "../llm/stub.ts";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import { emptyDoc } from "./index.ts";
import { createLLMSummariser, NO_CONNECTION } from "./llmsummary.ts";
import { SUMMARY_PROMPT } from "./summary.ts";

const DOC = emptyDoc("docs/raw/4.0 Manuals/Fridge.pdf", "");

/** The saved connection v1 runs: thinking on demand, so the summariser asks for none. */
function config(baseUrl: string, over: Partial<LLM> = {}): LLM {
	return {
		...DEFAULTS,
		baseUrl,
		model: "movin-backend",
		apiKey: "sk-test-1234",
		timeoutSec: 5,
		thinkOnDemand: true,
		...over,
	};
}

/** settingsFor is the one method the summariser uses of the settings service. */
function settingsFor(cfg: LLM): { resolve: () => Promise<LLM> } {
	return { resolve: async () => cfg };
}

/** summaryStub answers every request with a quoted two-line reply, as Go's fake did. */
async function summaryStub(): Promise<Stub> {
	const stub = await startStub();
	stub.answer({ kind: "text", text: '"SMEG fridge manual: settings, defrosting and cleaning."\nSecond line.' });
	return stub;
}

describe("createLLMSummariser", () => {
	it("sends the prompt and one user message, and tidies the answer", async () => {
		const stub = await summaryStub();
		try {
			const summariser = createLLMSummariser({ settings: settingsFor(config(`${stub.origin}/v1`)) });
			const summary = await summariser.summarise(DOC, "Defrosting\u2026");
			// tidySummary: the first line, without its quotes.
			expect(summary).toBe("SMEG fridge manual: settings, defrosting and cleaning.");
			expect(stub.requests).toHaveLength(1);
			const body = stub.requests[0]?.body ?? {};
			expect(body.messages).toEqual([
				{ role: "system", content: SUMMARY_PROMPT },
				{
					role: "user",
					content: "File: 4.0 Manuals/Fridge.pdf\n\nStart of the text:\nDefrosting\u2026",
				},
			]);
			expect(body.messages).toHaveLength(2);
			expect(String((body.messages as { content: string }[])[0]?.content)).toContain("no personal details");
			// No tools, and thinking off: Go's summariser never asked for either.
			expect(body.tools).toBeUndefined();
			expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
		} finally {
			await stub.close();
		}
	});

	it("names a file at the top of docs/raw without a folder", async () => {
		const stub = await summaryStub();
		try {
			const summariser = createLLMSummariser({ settings: settingsFor(config(`${stub.origin}/v1`)) });
			await summariser.summarise(emptyDoc("docs/raw/letter.pdf", ""), "text");
			const messages = stub.requests[0]?.body.messages as { content: string }[];
			expect(messages[1]?.content).toBe("File: letter.pdf\n\nStart of the text:\ntext");
		} finally {
			await stub.close();
		}
	});

	it("errors instead of calling when no connection is configured", async () => {
		const stub = await summaryStub();
		try {
			for (const empty of [config(""), config(`${stub.origin}/v1`, { model: "" })]) {
				const summariser = createLLMSummariser({ settings: settingsFor(empty) });
				await expect(summariser.summarise(DOC, "text")).rejects.toThrow(NO_CONNECTION);
			}
			expect(stub.requests).toHaveLength(0);
		} finally {
			await stub.close();
		}
	});

	it("resolves the connection on every call", async () => {
		const first = await summaryStub();
		const second = await summaryStub();
		try {
			let current = config(`${first.origin}/v1`, { model: "model-a" });
			const summariser = createLLMSummariser({
				settings: {
					resolve: async () => current,
				},
			});
			await summariser.summarise(DOC, "text");
			current = config(`${second.origin}/v1`, { model: "model-b" });
			await summariser.summarise(DOC, "text");
			expect(first.requests[0]?.body.model).toBe("model-a");
			expect(second.requests[0]?.body.model).toBe("model-b");
		} finally {
			await first.close();
			await second.close();
		}
	});
});
