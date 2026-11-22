// One non-agent model call: the docs summariser and the chat-eval helpers use
// it. Port of the parts of internal/llm/openai.go that need no tool loop:
// Complete for a single request, stopOf and the think flag.
//
// pi-ai has no non-streaming chat call for this API — `stream:true` always goes
// out — so "not streamed" here means the caller gets the finished text and
// never a delta (decisions.md · T3.1).
//
// completeSimple is the pi-ai entry with a thinking *level*: `complete()` wants
// a provider-specific `reasoningEffort` and would ignore `reasoning`, which is
// how the wire keeps `enable_thinking:false` (probe, T3.1).

import type { AssistantMessage, Message, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { LLM } from "../settings/settings.ts";
import { llmError } from "./errors.ts";
import { llmModels, modelEntry } from "./provider.ts";
import { stripSpecialTokens, textOf } from "./text.ts";
import { type Usage, usageOf } from "./usage.ts";

/** Go's llm.Stop (llm.go:100-107). */
export type Stop = "end" | "tool" | "max_tokens" | "refusal";

/**
 * What "the model may think" means on this gateway: the level T0.3 ran. pi-ai
 * takes a level per turn and the gateway turns it into a boolean.
 */
export const THINKING_LEVEL: ModelThinkingLevel = "medium";

export interface CompleteOptions {
	/** The system prompt; "" sends none, as an empty Go Section join did. */
	system?: string;
	messages: readonly Message[];
	/** This turn asked for thinking (a /think message). */
	think?: boolean;
	signal?: AbortSignal;
}

export interface CompleteResult {
	text: string;
	stop: Stop;
	usage: Usage;
}

/**
 * complete runs one chat completion: one request, no tools, the answer as text.
 * A stop that ends the turn early (cut off, refusal) is a result, not an error;
 * a failed request throws llmError, which never carries the key.
 */
export async function complete(cfg: LLM, o: CompleteOptions): Promise<CompleteResult> {
	const { models } = llmModels(cfg);
	const system = o.system ?? "";
	const level = thinkingFor(cfg, o.think ?? false);
	let message: AssistantMessage;
	try {
		message = await models.completeSimple(
			modelEntry(cfg),
			{ ...(system === "" ? {} : { systemPrompt: system }), messages: [...o.messages] },
			{
				// The key and the keyless fetch live in the provider llmModels built.
				// pi-ai's SimpleStreamOptions has no "off": the level is left out and
				// streamSimple then sends no reasoning effort at all.
				...(level === "off" ? {} : { reasoning: level }),
				timeoutMs: cfg.timeoutSec * 1000,
				signal: o.signal,
			},
		);
	} catch (err) {
		throw llmError(err, cfg.apiKey);
	}
	const stop = stopOf(message);
	// A content filter arrives as stopReason "error" with rawStopReason
	// "content_filter" (api/openai-completions.js); that is a refusal, not a failure.
	if (message.stopReason === "aborted" || (message.stopReason === "error" && stop !== "refusal")) {
		throw llmError(message, cfg.apiKey);
	}
	return { text: stripSpecialTokens(textOf(message.content)), stop, usage: usageOf(message) };
}

/**
 * thinkingFor is the per-turn thinking level. Off only when the setting gates
 * thinking and this turn did not ask; otherwise the level thinking means here.
 * Go's third state (no field at all, the server's own default) does not exist
 * on pi-ai: the compat always sends the flag.
 */
export function thinkingFor(cfg: LLM, think: boolean): ModelThinkingLevel {
	return cfg.thinkOnDemand && !think ? "off" : THINKING_LEVEL;
}

/**
 * stopOf maps pi-ai's stop to Go's stopOf (openai.go:254-266): tool calls win
 * over the reason, then length, then a content filter, else the end.
 */
export function stopOf(message: AssistantMessage): Stop {
	if (message.content.some((block) => block.type === "toolCall")) return "tool";
	if (message.stopReason === "length" || message.rawStopReason === "length") return "max_tokens";
	if (message.rawStopReason === "content_filter") return "refusal";
	return "end";
}
