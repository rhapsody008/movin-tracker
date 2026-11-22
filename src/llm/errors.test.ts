// The one error surface: pi-ai's failure texts turned into Go's, scrubbed of the
// key, and classified for retry exactly as pi-ai classified the raw text.
//
// The retry table is the point of the step (agent-spec §1.7): pi-durable retries
// a failed generation when isRetryableAssistantError says so, and the app's own
// mapping must not change that answer — a mapped 503 that stopped looking
// retryable would turn a gateway hiccup into a dead conversation.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { describe, expect, it } from "vitest";
import { llmError } from "./errors.ts";

/** The texts pi-ai composes for a failed request (api/openai-completions.js, utils/error-body.js). */
const MAPPED: { raw: string; text: string }[] = [
	{ raw: '401: {"message":"Invalid API key"}', text: "endpoint returned 401: Invalid API key" },
	{ raw: '429: {"message":"rate limit exceeded"}', text: "endpoint returned 429: rate limit exceeded" },
	{ raw: '500: {"message":"boom"}', text: "endpoint returned 500: boom" },
	{ raw: '503: {"message":"service unavailable"}', text: "endpoint returned 503: service unavailable" },
	{ raw: '500: {"type":"upstream"}', text: 'endpoint returned 500: {"type":"upstream"}' },
	{ raw: "503: {}", text: "endpoint returned 503: {}" },
	{ raw: "500 plain failure", text: "endpoint returned 500: plain failure" },
	{ raw: "terminated: other side closed (UND_ERR_SOCKET)", text: "terminated: other side closed (UND_ERR_SOCKET)" },
	{ raw: "fetch failed", text: "fetch failed" },
	{ raw: "No API key for provider: movin", text: "No API key for provider: movin" },
];

describe("llmError", () => {
	it("rebuilds Go's endpoint returned <status>: <message> from pi-ai's text", () => {
		for (const one of MAPPED) {
			expect(llmError(failed(one.raw), "sk-test-1234").message).toBe(one.text);
		}
	});

	it("keeps pi-ai's text when there is no status in it", () => {
		expect(llmError(new Error("fetch failed"), "").message).toBe("fetch failed");
	});

	it("cuts the message at 300 bytes and marks the cut, as Go does (openai.go:86-88)", () => {
		const long = "x".repeat(400);
		const text = llmError(failed(`500: {"message":"${long}"}`), "").message;
		expect(text).toBe(`endpoint returned 500: ${"x".repeat(300)}\u2026`);
	});

	it("scrubs a key the endpoint echoes, in the body and in a thrown error", () => {
		expect(llmError(failed('401: {"message":"bad key sk-test-1234"}'), "sk-test-1234").message).toBe(
			"endpoint returned 401: bad key [redacted]",
		);
		expect(llmError(new Error("boom sk-test-1234"), "sk-test-1234").message).toBe("boom [redacted]");
		// Nothing to scrub, nothing changed.
		expect(llmError(new Error("boom"), "sk-test-1234").message).toBe("boom");
	});
});

describe("the retry classification", () => {
	const retryable = [
		'429: {"message":"rate limit exceeded"}',
		'429: {"message":"too many requests"}',
		'500: {"message":"boom"}',
		'502: {"message":"upstream request failed"}',
		'503: {"message":"Service Temporarily Unavailable"}',
		"terminated: other side closed (UND_ERR_SOCKET)",
		"fetch failed",
		"TypeError: fetch failed: socket hang up",
	];
	const notRetryable = ['401: {"message":"Invalid API key"}', '429: {"message":"insufficient_quota"}'];

	it("retries a transient status or a transport drop", () => {
		for (const raw of retryable) {
			expect({ raw, retryable: retryableOf(llmError(failed(raw), "k").message) }).toEqual({ raw, retryable: true });
		}
	});

	it("does not retry a bad key or an exhausted quota", () => {
		for (const raw of notRetryable) {
			expect({ raw, retryable: retryableOf(llmError(failed(raw), "k").message) }).toEqual({
				raw,
				retryable: false,
			});
		}
	});

	it("gives the same answer for every mapped text as for pi-ai's raw text", () => {
		for (const one of MAPPED) {
			expect({ raw: one.raw, retryable: retryableOf(llmError(failed(one.raw), "k").message) }).toEqual({
				raw: one.raw,
				retryable: retryableOf(one.raw),
			});
		}
	});
});

/** retryableOf is pi-ai's classifier on one error text, as pi-durable asks it. */
function retryableOf(text: string): boolean {
	return isRetryableAssistantError(failed(text));
}

/** failed is the AssistantMessage pi-ai reports a broken request as. */
function failed(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: "error",
		errorMessage: text,
		timestamp: 0,
	};
}
