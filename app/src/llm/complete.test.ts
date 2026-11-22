// complete(): one non-agent model call, from the wire Go sent to the stops Go
// mapped. Ported from internal/llm/{openai,images}_test.go where the behaviour
// matches, and pinning the differences pi-ai's openai-completions brings
// (stream:true always, chat_template_kwargs always, a content filter as an
// error) as decisions.md · T3.1 records them.
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import { complete, stopOf, THINKING_LEVEL, thinkingFor } from "./complete.ts";
import { type StubAnswer, startStub } from "./stub.ts";

function config(baseUrl: string, over: Partial<LLM> = {}): LLM {
	return { ...DEFAULTS, baseUrl, model: "movin-backend", apiKey: "sk-test-1234", timeoutSec: 5, ...over };
}

function user(text: string): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content: text, timestamp: 1_700_000_000_000 };
}

describe("the request Go sent", () => {
	it("posts one chat completion whose body has Go's fields and no sampling field", async () => {
		const stub = await startStub();
		try {
			await complete(config(`${stub.origin}/v1`), { system: "You set dates.", messages: [user("hi")] });
			expect(stub.requests).toHaveLength(1);
			const req = stub.requests[0];
			expect([req?.method, req?.path]).toEqual(["POST", "/v1/chat/completions"]);
			expect(req?.headers["content-type"]).toBe("application/json");
			// pi-ai's own fields after Go's: stream is always true, the usage chunk is
			// asked for, no server-side store, and the answer cap comes from the model
			// entry (Go sent no cap, openai_test.go:34-60 — decisions.md · T3.1).
			expect(Object.keys(req?.body ?? {})).toEqual([
				"model",
				"messages",
				"stream",
				"stream_options",
				"store",
				"max_completion_tokens",
				"chat_template_kwargs",
			]);
			expect(req?.body.model).toBe("movin-backend");
			expect(req?.body.stream).toBe(true);
			expect(req?.body.tools).toBeUndefined();
			expect(req?.body.tool_choice).toBeUndefined();
			expect(req?.body.temperature).toBeUndefined();
			expect(req?.body.max_tokens).toBeUndefined();
			expect(req?.body.max_completion_tokens).toBe(8_192);
			// The system prompt keeps Go's role, not pi-ai's auto-detected "developer".
			expect(req?.body.messages).toEqual([
				{ role: "system", content: "You set dates." },
				{ role: "user", content: "hi" },
			]);
		} finally {
			await stub.close();
		}
	});

	it("sends no system message when there is no system prompt", async () => {
		const stub = await startStub();
		try {
			await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			expect(stub.requests[0]?.body.messages).toEqual([{ role: "user", content: "hi" }]);
		} finally {
			await stub.close();
		}
	});
});

describe("thinking", () => {
	it("sends enable_thinking false only when the setting gates thinking and nobody asked", async () => {
		const stub = await startStub();
		try {
			const onDemand = config(`${stub.origin}/v1`, { thinkOnDemand: true });
			await complete(onDemand, { messages: [user("hi")] });
			await complete(onDemand, { messages: [user("/think hi")], think: true });
			await complete(config(`${stub.origin}/v1`, { thinkOnDemand: false }), { messages: [user("hi")] });
			expect(stub.requests.map((r) => r.body.chat_template_kwargs)).toEqual([
				{ enable_thinking: false, preserve_thinking: true },
				{ enable_thinking: true, preserve_thinking: true },
				// Go sent no field at all here (openai.go:150-152); pi-ai's compat always
				// sends the flag, and the level it carries is "thinking is allowed".
				{ enable_thinking: true, preserve_thinking: true },
			]);
			// pi-ai's exact kwargs, in its own order.
			expect(Object.keys((stub.requests[0]?.body.chat_template_kwargs ?? {}) as object)).toEqual([
				"enable_thinking",
				"preserve_thinking",
			]);
		} finally {
			await stub.close();
		}
	});

	it("turns the setting and the turn into pi-ai's level", () => {
		const onDemand = config("http://llm.test/v1", { thinkOnDemand: true });
		const offDemand = config("http://llm.test/v1", { thinkOnDemand: false });
		expect(thinkingFor(onDemand, false)).toBe("off");
		expect(thinkingFor(onDemand, true)).toBe(THINKING_LEVEL);
		expect(thinkingFor(offDemand, false)).toBe(THINKING_LEVEL);
		expect(thinkingFor(offDemand, true)).toBe(THINKING_LEVEL);
		expect(THINKING_LEVEL).toBe("medium");
	});
});

describe("the answer", () => {
	it("reassembles streamed text and reads the usage chunk", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "Hello there", usage: { prompt: 11, completion: 2, cached: 7 } });
			const res = await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			expect(res.text).toBe("Hello there");
			expect(res.stop).toBe("end");
			// pi-ai reports input without the cached prompt tokens (11 - 7); Go's In was
			// the whole prompt. Go's own totals formula, In + CacheRead + CacheWrite,
			// still gives the true prompt count either way (decisions.md · T3.1).
			expect(res.usage).toEqual({ in: 4, out: 2, cacheRead: 7, cacheWrite: 0 });
		} finally {
			await stub.close();
		}
	});

	it("reassembles tool calls split across fragments, by index", async () => {
		const stub = await startStub();
		try {
			stub.answer({
				kind: "toolCalls",
				text: "Looking.",
				calls: [
					{ name: "set_dates", arguments: '{"move_in":"2026-12-05"}', id: "call_a" },
					{ name: "add_entry", arguments: '{"title":"Fridge","kind":"task"}', id: "call_b" },
				],
			});
			const res = await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			// A tool call wins over any finish reason, as Go's stopOf does.
			expect(res.stop).toBe("tool");
			expect(res.text).toBe("Looking.");
		} finally {
			await stub.close();
		}
	});

	it("strips leaked chat-template tokens from the text", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "Saved it.<|im_end|>" });
			const res = await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			expect(res.text).toBe("Saved it.");
		} finally {
			await stub.close();
		}
	});

	it("maps length to max_tokens and keeps the partial text", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "cut off here", finish: "length" });
			const res = await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			expect([res.stop, res.text]).toEqual(["max_tokens", "cut off here"]);
		} finally {
			await stub.close();
		}
	});

	it("maps content_filter to a refusal, not a failure (pi-ai reports it as an error)", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "", finish: "content_filter" });
			const res = await complete(config(`${stub.origin}/v1`), { messages: [user("hi")] });
			expect(res).toEqual({ text: "", stop: "refusal", usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 } });
		} finally {
			await stub.close();
		}
	});

	it("maps an unknown finish reason to end", () => {
		expect(stopOf(assistant({ stopReason: "stop", rawStopReason: "stop" }))).toBe("end");
		expect(stopOf(assistant({ stopReason: "length" }))).toBe("max_tokens");
		expect(stopOf(assistant({ stopReason: "toolUse" }))).toBe("tool");
		expect(stopOf(assistant({ stopReason: "error", rawStopReason: "content_filter" }))).toBe("refusal");
	});
});

describe("failures", () => {
	const cases: { status: number; message: string }[] = [
		{ status: 401, message: "Invalid API key" },
		{ status: 429, message: "rate limit exceeded" },
		{ status: 500, message: "boom" },
		{ status: 503, message: "service unavailable" },
	];

	it("turns a non-2xx answer into Go's endpoint returned <status>: <message>", async () => {
		const stub = await startStub();
		try {
			stub.answer(...cases.map((c): StubAnswer => ({ kind: "error", status: c.status, message: c.message })));
			const seen: string[] = [];
			for (const c of cases) {
				const failure = await failureOf(complete(config(`${stub.origin}/v1`), { messages: [user("hi")] }));
				seen.push(failure.message);
				expect(failure.message).toBe(`endpoint returned ${c.status}: ${c.message}`);
			}
			expect(seen).toHaveLength(4);
		} finally {
			await stub.close();
		}
	});

	it("never lets a key the endpoint echoes out in the error", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "error", status: 401, message: "Invalid API key: sk-test-1234" });
			const failure = await failureOf(complete(config(`${stub.origin}/v1`), { messages: [user("hi")] }));
			expect(failure.message).toBe("endpoint returned 401: Invalid API key: [redacted]");
			expect(failure.message.includes("sk-test-1234")).toBe(false);
		} finally {
			await stub.close();
		}
	});

	it("reports a mid-stream error with the upstream text", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "midStreamError", text: "par", message: "upstream exploded" });
			const failure = await failureOf(complete(config(`${stub.origin}/v1`), { messages: [user("hi")] }));
			expect(failure.message).toBe("upstream exploded");
		} finally {
			await stub.close();
		}
	});

	it("reports a dropped connection as the transport text it is", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "destroy", text: "par" });
			const failure = await failureOf(complete(config(`${stub.origin}/v1`), { messages: [user("hi")] }));
			expect(failure.message).toMatch(/other side closed|terminated/);
		} finally {
			await stub.close();
		}
	});

	it("gives up at the connection's own timeout, which is what timeoutSec is for", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const cfg = config(`${stub.origin}/v1`, { timeoutSec: 0.2 });
			const failure = await failureOf(complete(cfg, { messages: [user("hi")] }));
			expect(failure.message.toLowerCase()).toMatch(/timed out|timeout/);
		} finally {
			await stub.close();
		}
	});

	it("reports an aborted turn instead of an answer", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const controller = new AbortController();
			const started = complete(config(`${stub.origin}/v1`), { messages: [user("hi")], signal: controller.signal });
			controller.abort();
			const failure = await failureOf(started);
			expect(failure).toBeInstanceOf(Error);
		} finally {
			await stub.close();
		}
	});
});

/** failureOf awaits a call that must throw, and hands back what it threw. */
async function failureOf(p: Promise<unknown>): Promise<Error> {
	try {
		await p;
	} catch (err) {
		if (err instanceof Error) return err;
		throw new Error("expected an Error");
	}
	throw new Error("expected the call to fail, it answered");
}

/** assistant is the smallest AssistantMessage stopOf reads. */
function assistant(stop: { stopReason: StopReason; rawStopReason?: string }): AssistantMessage {
	return {
		role: "assistant" as const,
		content: stop.stopReason === "toolUse" ? [{ type: "toolCall" as const, id: "c", name: "n", arguments: {} }] : [],
		api: "openai-completions",
		provider: "movin",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: stop.stopReason,
		...(stop.rawStopReason === undefined ? {} : { rawStopReason: stop.rawStopReason }),
		timestamp: 0,
	};
}
