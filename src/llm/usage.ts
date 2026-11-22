// Token counts and the one log line a model round writes. Port of llm.Usage
// (internal/llm/llm.go:110-113) and turn.usage (internal/agent/agent.go:181-191).
//
// The line is Go's, field for field and in its order, so a log shipper sees the
// same shape as v1. `cacheRead` is what the endpoint reports as cached prompt
// tokens; the gateway reported none as of T0.3 (progress.md:42), and the field
// stays so a gateway that starts caching helps for free.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Log } from "../log.ts";
import type { Stop } from "./complete.ts";

/** Go's llm.Usage: the four counts a turn sums over its rounds (T3.2). */
export interface Usage {
	in: number;
	out: number;
	cacheRead: number;
	cacheWrite: number;
}

/** The usage of one pi-ai answer. `CacheWrite` was always 0 on the OpenAI path (openai.go:188). */
export function usageOf(message: AssistantMessage): Usage {
	return {
		in: message.usage.input,
		out: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
	};
}

/** What one `llm call` line needs: the round it was, and what it cost. */
interface CallLog {
	model: string;
	round: number;
	stop: Stop;
	usage: Usage;
}

/**
 * logLLMCall writes Go's `llm call` line at Info. `kind` is Go's cfg.Kind, which
 * is "openai" always in v2 (settings.ts rejects "claude").
 */
export function logLLMCall(log: Log, call: CallLog): void {
	log.info("llm call", {
		kind: "openai",
		model: call.model,
		round: call.round,
		stop: call.stop,
		in: call.usage.in,
		out: call.usage.out,
		cacheRead: call.usage.cacheRead,
		cacheWrite: call.usage.cacheWrite,
	});
}
