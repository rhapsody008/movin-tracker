// The LLM settings routes: the view, the save, "Test connection" and the model
// list. Port of getSettings, putSettings, testSettings and listModels
// (internal/server/server.go:486-611), with v2's one-connection rule
// (settings-spec §11): a body that says `kind:"claude"` is a 400, and the view
// has no claudeOrigin.
//
// Both network routes take a URL from the request, so both go through
// SettingsService.keyFor: the typed key wins, and the stored or env key is only
// ever sent to the origin its own configuration named. An empty key means no
// Authorization header at all — server-spec §5.1, server_test.go:793.
//
// `POST …/models` is a POST for a reason: following a link must not be able to
// send the stored key to a host named in a query string (server.go:571-574).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { EntriesService } from "../entries/service.ts";
import { Ordered } from "../gojson.ts";
import { goTrimRight, goTrimSpace } from "../gostr.ts";
import { type Connection, listModels } from "../llm/models.ts";
import { encodeTestResult, probe } from "../llm/probe.ts";
import { errorMessage, type Log } from "../log.ts";
import { CLAUDE_MESSAGE, type Input, type LLM, type SettingsService, type View } from "../settings/settings.ts";
import { decodeBody, decodeFailed, fail, jsonBool, jsonString, writeErr, writeJSON } from "./http.ts";
import type { Handler } from "./router.ts";

/** Go gives this call 15 s; the drawer's spinner is waiting (server.go:604). */
const MODELS_TIMEOUT_MS = 15_000;

/** v2's one kind, in the wording the settings service uses for a save (settings.ts). */
const KIND_MESSAGE = "kind must be openai";

export interface LLMSettingsOptions {
	entries: EntriesService;
	settings: SettingsService;
	log: Log;
}

/**
 * requestSignal aborts when the browser goes away before the answer is
 * written: a drawer that was closed or reloaded must not keep an endpoint call
 * (and its key) running. The models list would otherwise wait out its 15 s
 * (server.go:604); the test probe waits out the connection's own timeoutSec
 * (server.go:530-546). The admin storage probe is deliberately not wired to it:
 * it has a 30 s budget and must clean up its scratch object (brief G5).
 */
function requestSignal(res: ServerResponse): AbortSignal {
	const controller = new AbortController();
	res.on("close", () => {
		if (!res.writableEnded) controller.abort();
	});
	return controller.signal;
}

export interface LLMSettingsRoutes {
	getSettings: Handler;
	putSettings: Handler;
	testSettings: Handler;
	models: Handler;
}

export function createLLMSettingsRoutes(o: LLMSettingsOptions): LLMSettingsRoutes {
	const { entries, settings, log } = o;

	async function onError(req: IncomingMessage, res: ServerResponse, err: unknown): Promise<void> {
		await fail({ entries, log }, req, res, err);
	}

	/** GET /api/settings/llm: the resolved connection, and what is stored about it. */
	const getSettings: Handler = async (_req, res) => {
		writeJSON(res, 200, encodeView(await settings.view()));
	};

	/** PUT /api/settings/llm: a full replacement except the key. */
	const putSettings: Handler = async (req, res, h) => {
		const raw = await decodeBody(req, res);
		if (raw === null) return;
		let input: Input;
		try {
			input = readInput(raw);
		} catch (err) {
			decodeFailed(res, err);
			return;
		}
		try {
			writeJSON(res, 200, encodeView(await settings.save(h.user, input)));
		} catch (err) {
			await onError(req, res, err);
		}
	};

	/** POST /api/settings/llm/test: the drawer's values, without saving them; always 200 when it parsed. */
	const testSettings: Handler = async (req, res, h) => {
		const raw = await decodeBody(req, res);
		if (raw === null) return;
		let input: Input;
		try {
			input = readInput(raw);
		} catch (err) {
			decodeFailed(res, err);
			return;
		}
		let cfg: LLM;
		try {
			cfg = await settings.forTest(input);
		} catch (err) {
			await onError(req, res, err);
			return;
		}
		// The probe is never streamed, whatever the drawer said (server.go:530).
		cfg = { ...cfg, streaming: false };
		const result = await probe(cfg, requestSignal(res));
		log.info("LLM settings test", { by: h.user, model: cfg.model, ok: result.ok, latencyMs: result.latencyMs });
		writeJSON(res, 200, encodeTestResult(result));
	};

	/** POST /api/settings/llm/models: the list for a URL the drawer may not have saved yet. */
	const models: Handler = async (req, res) => {
		const raw = await decodeBody(req, res);
		if (raw === null) return;
		let asked: { kind: string; baseUrl: string; apiKey: string };
		try {
			asked = { kind: jsonString(raw, "kind"), baseUrl: jsonString(raw, "baseUrl"), apiKey: jsonString(raw, "apiKey") };
		} catch (err) {
			decodeFailed(res, err);
			return;
		}
		// Both wordings are the settings service's own: v2 has one kind only.
		if (asked.kind === "claude") {
			writeErr(res, 400, CLAUDE_MESSAGE);
			return;
		}
		if (asked.kind !== "" && asked.kind !== "openai") {
			writeErr(res, 400, KIND_MESSAGE);
			return;
		}
		const cfg = await settings.resolve();
		// An empty URL in the request means "the saved one"; a typed one wins.
		let baseUrl = cfg.baseUrl;
		const typed = goTrimRight(goTrimSpace(asked.baseUrl), "/");
		if (typed !== "") baseUrl = typed;
		if (baseUrl === "") {
			writeErr(res, 400, "Set an endpoint URL first.");
			return;
		}
		const connection: Connection = {
			baseUrl,
			// Typed key wins; the stored or env key only goes to its own origin.
			apiKey: await settings.keyFor(baseUrl, asked.apiKey),
			timeoutMs: MODELS_TIMEOUT_MS,
			signal: requestSignal(res),
		};
		let ids: string[];
		try {
			ids = await listModels(connection);
		} catch (err) {
			writeErr(res, 502, errorMessage(err));
			return;
		}
		// A Go map with one key, and the ids already in byte order.
		writeJSON(res, 200, new Ordered([["models", ids]]));
	};

	return { getSettings, putSettings, testSettings, models };
}

/** settings.Input: every non-key field is replaced from the request, the key only if one is typed. */
function readInput(raw: Record<string, unknown>): Input {
	return {
		vision: jsonBool(raw, "vision"),
		kind: jsonString(raw, "kind"),
		baseUrl: jsonString(raw, "baseUrl"),
		apiKey: jsonString(raw, "apiKey"),
		clearKey: jsonBool(raw, "clearKey"),
		model: jsonString(raw, "model"),
		streaming: jsonBool(raw, "streaming"),
		thinkOnDemand: jsonBool(raw, "thinkOnDemand"),
	};
}

/**
 * encodeView is settings.View in Go's field order, with v2's legacyKind right
 * after kind (settings-spec §11). Field order is the struct's, which is why it
 * is spelled out here instead of trusting an object literal.
 */
export function encodeView(v: View): Ordered {
	const e: (readonly [string, unknown])[] = [
		["vision", v.vision],
		["kind", v.kind],
	];
	if (v.legacyKind !== undefined) e.push(["legacyKind", v.legacyKind]);
	e.push(["baseUrl", v.baseUrl], ["model", v.model], ["streaming", v.streaming], ["thinkOnDemand", v.thinkOnDemand]);
	e.push(["keySet", v.keySet]);
	if (v.keyLast4 !== undefined) e.push(["keyLast4", v.keyLast4]);
	e.push(["keyFromEnv", v.keyFromEnv], ["canStoreKey", v.canStoreKey]);
	if (v.updated !== undefined) e.push(["updated", v.updated]);
	if (v.by !== undefined) e.push(["by", v.by]);
	return new Ordered(e);
}
