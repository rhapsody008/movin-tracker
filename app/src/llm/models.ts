// The endpoint calls the settings drawer makes with a key: the model list
// (GET {baseUrl}/models) and, through `call`, the chat completions probe.ts
// sends. Port of openAI.do and openAI.Models (internal/llm/openai.go:46-131)
// plus llm.APIError (internal/llm/llm.go:59-66).
//
// Three rules from the Go code are load-bearing and easy to lose:
// - an empty key means NO Authorization header at all, never an empty Bearer,
//   because the key only ever goes to the origin its configuration named;
// - a failing endpoint's answer is cut to 300 characters, so a proxy's HTML
//   error page never reaches the settings drawer whole;
// - no error text is ever copied from a body parser or from the key: V8's
//   `JSON.parse` quotes its input, so a body that IS the key would print it
//   (decisions.md, T2 review round 1). Decode failures get a fixed tail, and
//   every error that leaves this module is scrubbed of the key as a backstop.
//
// Go's net/http writes `Get "http://…": dial tcp 127.0.0.1:9: connect:
// connection refused` for a dead endpoint; fetch cannot reproduce the middle,
// so this port writes `Get "<url>": <cause>`, with the verb from Go's
// urlErrorOp (client.go:546-553) and the rest marked as a known difference.
//
// This file holds the request code both modules share because src/llm is two
// files until T3.1 brings the full client.

import { compareBytes, goQuote, goTrimRight, goTrimSpace } from "../gostr.ts";
import { errorMessage } from "../log.ts";

/** How much of a failing endpoint's answer is read (openai.go:78). */
const ERROR_BODY_LIMIT = 2000;

/** How much of that answer is shown, and what follows the cut (openai.go:86-88). */
const ERROR_TEXT_LIMIT = 300;

/** One endpoint to talk to: a resolved connection, or the one the drawer is testing. */
export interface Connection {
	/** No trailing "/" needed; Go trims it before appending the path. */
	baseUrl: string;
	apiKey: string;
	/** The whole request's budget, Go's http.Client Timeout. */
	timeoutMs: number;
	/** Aborted when the browser goes away: the call is then pointless (§F7). */
	signal?: AbortSignal;
}

/** llm.APIError: a non-2xx answer, kept short for the UI. */
export class ApiError extends Error {
	readonly status: number;
	readonly body: string;

	constructor(status: number, body: string) {
		super(`endpoint returned ${status}: ${body}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

/**
 * listModels is openAI.Models: the ids the endpoint offers, in byte order. The
 * Anthropic `?limit=1000` and its headers are gone in v2 (settings-spec §11).
 */
export async function listModels(cfg: Connection): Promise<string[]> {
	try {
		const body = await call(cfg, "GET", "/models", null);
		let value: unknown;
		try {
			value = JSON.parse(new TextDecoder().decode(body));
		} catch {
			// Never the parser's own message: it quotes the body (decisions.md).
			throw new Error("decode models list: invalid JSON");
		}
		const ids = modelIds(value);
		ids.sort(compareBytes);
		return ids;
	} catch (err) {
		throw scrubKey(err, cfg.apiKey);
	}
}

/** modelIds reads `{"data":[{"id":…}]}`; a missing id is Go's zero string. */
function modelIds(value: unknown): string[] {
	// Go decodes a top-level null into the struct as a no-op: no models at all.
	if (value === null) return [];
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("decode models list: not a JSON object");
	}
	const data = (value as { data?: unknown }).data;
	// A missing or null list is Go's nil slice: no models, not an error.
	if (data === undefined || data === null) return [];
	if (!Array.isArray(data)) throw new Error("decode models list: data must be a list");
	return data.map((item: unknown) => {
		const id = typeof item === "object" && item !== null ? (item as { id?: unknown }).id : undefined;
		return typeof id === "string" ? id : "";
	});
}

/**
 * call is openAI.do for one request: Go's headers, the 2000-byte answer read on
 * failure, and the two error forms (a network error, or an ApiError).
 */
export async function call(cfg: Connection, method: string, path: string, body: string | null): Promise<Uint8Array> {
	const url = `${goTrimRight(cfg.baseUrl, "/")}${path}`;
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	// An empty key sends no header: the stored key never leaves its own origin.
	if (cfg.apiKey !== "") headers.Authorization = `Bearer ${cfg.apiKey}`;
	const signal =
		cfg.signal === undefined
			? AbortSignal.timeout(cfg.timeoutMs)
			: AbortSignal.any([cfg.signal, AbortSignal.timeout(cfg.timeoutMs)]);
	let resp: Response;
	try {
		resp = await fetch(url, { method, headers, body: body ?? undefined, signal });
	} catch (err) {
		throw scrubKey(new Error(`${urlErrorOp(method)} ${goQuote(url)}: ${causeText(err)}`), cfg.apiKey);
	}
	if (resp.status < 200 || resp.status > 299) {
		throw scrubKey(new ApiError(resp.status, await errorText(resp)), cfg.apiKey);
	}
	return new Uint8Array(await resp.arrayBuffer());
}

/**
 * urlErrorOp is Go's: the method's first byte and the rest lower-cased, so a
 * network error reads `Get "…"` or `Post "…"` (net/http/client.go:546-553).
 */
export function urlErrorOp(method: string): string {
	if (method === "") return "Get";
	return method.slice(0, 1) + method.toLowerCase().slice(1);
}

/** The failure text for one request, as openai.go:76-89 builds it. */
async function errorText(resp: Response): Promise<string> {
	const raw = await readAtMost(resp);
	let msg = goTrimSpace(new TextDecoder().decode(raw));
	const fromJson = jsonErrorMessage(raw);
	if (fromJson !== "") msg = fromJson;
	return cut(msg);
}

/** Go prefers an OpenAI-shaped `{"error":{"message":…}}` over the raw body. */
function jsonErrorMessage(raw: Uint8Array): string {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		return "";
	}
	if (typeof value !== "object" || value === null) return "";
	const err = (value as { error?: unknown }).error;
	if (typeof err !== "object" || err === null) return "";
	const msg = (err as { message?: unknown }).message;
	return typeof msg === "string" ? msg : "";
}

/** cut is Go's `len(msg) > 300 → msg[:300] + "…"`, counted in bytes. */
function cut(msg: string): string {
	const bytes = Buffer.from(msg, "utf8");
	if (bytes.length <= ERROR_TEXT_LIMIT) return msg;
	return `${new TextDecoder().decode(bytes.subarray(0, ERROR_TEXT_LIMIT))}…`;
}

/**
 * readAtMost reads ERROR_BODY_LIMIT bytes of a failed answer and then drops the
 * rest, as io.LimitReader + resp.Body.Close do. A proxy page can be megabytes.
 */
async function readAtMost(resp: Response): Promise<Uint8Array> {
	const reader = resp.body?.getReader();
	if (reader === null || reader === undefined) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < ERROR_BODY_LIMIT) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		const part = value.length > ERROR_BODY_LIMIT - size ? value.subarray(0, ERROR_BODY_LIMIT - size) : value;
		chunks.push(part);
		size += part.length;
	}
	await reader.cancel().catch(() => undefined);
	const out = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}

/**
 * scrubKey removes the key from an error message, in case an endpoint echoes it
 * (openai.go:92-99). Every error src/llm throws goes through here, so no body or
 * log line can carry the key even when the text came from somewhere else.
 */
export function scrubKey(err: unknown, apiKey: string): Error {
	const message = errorMessage(err);
	if (apiKey === "" || !message.includes(apiKey)) return err instanceof Error ? err : new Error(message);
	return new Error(message.split(apiKey).join("[redacted]"));
}

/** fetch's own message, or the cause it wrapped; Go's net error text is the middle. */
function causeText(err: unknown): string {
	if (err instanceof Error && err.cause !== undefined && err.cause !== null) return errorMessage(err.cause);
	return errorMessage(err);
}
