// The pi-ai side of the saved connection: one provider built from settings.LLM,
// one synthesised model entry, and the Models collection the harness and
// complete() share. Port of what openai.go opened for Go (internal/llm/
// openai.go:24-60): one OpenAI-compatible endpoint, the key as a Bearer and
// nothing else.
//
// The app stores a model id and nothing else, so the entry pi-ai needs is made
// up here: the context window, the answer cap and the compat switches are ours,
// not the endpoint's (T0.3, progress.md). The key is resolved through pi-ai's
// `resolve`, which must hand back `{ auth: { apiKey } }` — a bare string fails
// with "reading 'apiKey'" (progress.md:35).
//
// An empty key is the one thing pi-ai cannot do by itself: it refuses a request
// with no key ("No API key for provider: movin", getClientApiKey in
// api/openai-completions.js), where Go sent no Authorization header at all
// (openai.go:58-60). llmModels() closes that gap where every caller passes
// through it: the provider is handed a placeholder key and a chat API whose
// fetch deletes the header it would build. pi-durable's
// ConversationStreamOptions carries neither `apiKey` nor `fetch`
// (durable-api.md §4), so the wrapper here is the only route the harness has.

import type { FetchFunction, Model, ProviderStreams } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import type { LLM } from "../settings/settings.ts";

/** The provider id the one saved connection is registered under (T3.2's model refs store it). */
export const PROVIDER_ID = "movin";

/**
 * What the gateway's model reads at once. The app cannot ask: there is no
 * metadata for the model it is given, and T0.3's gateway served a 4 KB prompt
 * plus an image without complaining, so 128k is the honest upper bound.
 */
const CONTEXT_WINDOW = 128_000;

/**
 * Our own cap on one answer. It reaches the wire as `max_completion_tokens`:
 * pi-ai's single-shot call always sends the model's `maxTokens` (simple-options
 * buildBaseOptions), where Go sent no cap at all (openai_test.go:34-60). The
 * gateway accepted the field in T0.3, so it stays pi-ai's default rather than
 * being stripped (decisions.md · T3.1).
 */
const MAX_TOKENS = 8_192;

/** What pi-ai is told when there is no key, so it sends anything at all (see keylessApi). */
const KEYLESS_API_KEY = "unused";

/** pi-durable's ModelRef (harness/types.d.ts:14-17). T3.1 does not import pi-durable. */
export interface ModelRef {
	readonly provider: string;
	readonly modelId: string;
}

/** The Models collection a request goes through, and the ref a conversation is given. */
export interface ModelWiring {
	models: MutableModels;
	modelRef: ModelRef;
}

/**
 * modelEntry is the model pi-ai is given for this connection: the id the app
 * saved, and the switches T0.3 needed. `reasoning` plus the qwen chat-template
 * compat is what puts `chat_template_kwargs` on the wire.
 *
 * `supportsDeveloperRole: false` keeps the system prompt a `system` message, as
 * Go sent it; pi-ai's auto-detection would send it as `developer` for a
 * reasoning model on a standard-looking URL.
 */
export function modelEntry(cfg: LLM): Model<"openai-completions"> {
	return {
		id: cfg.model,
		name: cfg.model,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: cfg.baseUrl,
		input: cfg.vision ? ["text", "image"] : ["text"],
		reasoning: true,
		compat: { thinkingFormat: "qwen-chat-template", supportsDeveloperRole: false },
		contextWindow: CONTEXT_WINDOW,
		maxTokens: MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

/**
 * llmModels wires one connection into pi-ai: the provider, the single model
 * entry and the model ref a conversation is given. Built per call, because the
 * key, the URL and the model all come from settings and can change at any time.
 *
 * The keyless case is handled here rather than at the call site: complete()
 * and pi-durable's harness both go through this Models collection, so a
 * wrapper on the provider is the one mechanism that covers both.
 */
export function llmModels(cfg: LLM): ModelWiring {
	const keyless = cfg.apiKey === "";
	const api = openAICompletionsApi();
	const provider = createProvider({
		id: PROVIDER_ID,
		baseUrl: cfg.baseUrl,
		auth: {
			apiKey: {
				name: "the saved connection's API key",
				// A placeholder for the keyless case, because pi-ai refuses to send
				// anything without one; keylessApi then takes the header off again.
				resolve: async () => ({ auth: { apiKey: keyless ? KEYLESS_API_KEY : cfg.apiKey } }),
			},
		},
		models: [modelEntry(cfg)],
		api: keyless ? keylessApi(api) : api,
	});
	const models: MutableModels = createModels();
	models.setProvider(provider);
	return { models, modelRef: { provider: PROVIDER_ID, modelId: cfg.model } };
}

/**
 * keylessApi is the chat API with the HTTP client's fetch replaced: pi-ai's
 * SDK client builds `Authorization: Bearer <placeholder>`, and this drops it,
 * so a keyless endpoint sees the request Go sent (openai.go:58-60).
 */
function keylessApi(api: ProviderStreams): ProviderStreams {
	return {
		stream: (model, requestContext, requestOptions) =>
			api.stream(model, requestContext, { ...requestOptions, fetch: withoutAuthorization }),
		streamSimple: (model, requestContext, requestOptions) =>
			api.streamSimple(model, requestContext, { ...requestOptions, fetch: withoutAuthorization }),
	};
}

/** withoutAuthorization is globalThis.fetch with the Authorization header removed. */
const withoutAuthorization: FetchFunction = (input, init) => {
	if (input instanceof Request) {
		const headers = new Headers(input.headers);
		headers.delete("authorization");
		return globalThis.fetch(new Request(input, { ...init, headers }));
	}
	const headers = new Headers(init?.headers);
	headers.delete("authorization");
	return globalThis.fetch(input, { ...init, headers });
};
