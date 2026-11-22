// "Test connection": the three calls the settings drawer's button makes.
// Port of testSettings and probeVision (internal/server/server.go:503-571) on
// top of the request code in models.ts.
//
// One call decides everything: a chat completion whose first choice carries a
// tool call. The model list is informational (a failure is shown, not fatal),
// and the image probe only runs when tool calling worked. `latencyMs` covers
// that one call and nothing else, as Go measures it around Complete alone.

import { goMarshal, Ordered } from "../gojson.ts";
import { errorMessage } from "../log.ts";
import type { LLM } from "../settings/settings.ts";
import { type Connection, call, listModels, scrubKey } from "./models.ts";

/** Go's text when the endpoint answered but called no tool (server.go:551). */
export const NO_TOOL_CALLS =
	"The endpoint answered but did not return tool_calls. Pick a model that supports tool calling.";

/** The one question the probe asks (server.go:538). */
const PROBE_QUESTION = "We move in on 2026-12-05.";
const PROBE_SYSTEM = "You set dates on a board. Always use the tool.";
const VISION_QUESTION = "Reply with one word: what colour is this square?";

/**
 * probePNG is Go's 1×1 red pixel literal (server.go:558-559), base64 as the
 * data URL carries it. Copied from what the Go server sent the harness's fake
 * endpoint (the Go v1 code, tag v1.0.1, golden t22), never retyped from the Go escape sequence.
 */
export const PROBE_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** testResult (server.go:503-519), in Go struct order below. */
export interface TestResult {
	ok: boolean;
	latencyMs: number;
	toolCalls: boolean;
	models?: string[];
	modelsError?: string;
	vision: boolean;
	error?: string;
}

/**
 * The response body: Go struct order, and `omitempty` the way Go reads it — an
 * empty list and an empty string are left out, not written as [] or "".
 */
export function encodeTestResult(res: TestResult): Ordered {
	const e: (readonly [string, unknown])[] = [
		["ok", res.ok],
		["latencyMs", res.latencyMs],
		["toolCalls", res.toolCalls],
	];
	if (res.models !== undefined && res.models.length > 0) e.push(["models", res.models]);
	if (res.modelsError !== undefined && res.modelsError !== "") e.push(["modelsError", res.modelsError]);
	e.push(["vision", res.vision]);
	if (res.error !== undefined && res.error !== "") e.push(["error", res.error]);
	return new Ordered(e);
}

/**
 * probe tries the connection the drawer is showing, without saving it: list
 * the models, then ask one tool-calling question, then (if that worked) show
 * the model a picture.
 */
export async function probe(cfg: LLM, signal?: AbortSignal): Promise<TestResult> {
	const conn: Connection = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, timeoutMs: cfg.timeoutSec * 1000, signal };
	const res: TestResult = { ok: false, latencyMs: 0, toolCalls: false, vision: false };
	try {
		res.models = await listModels(conn);
	} catch (err) {
		// Informational only: the probe goes on. Scrubbed, like every src/llm text.
		res.modelsError = errorMessage(scrubKey(err, cfg.apiKey));
	}
	const start = Date.now();
	let calls: number | null = null;
	let failure = "";
	try {
		calls = await toolCallsOf(conn, probeChatBody(cfg));
	} catch (err) {
		failure = errorMessage(scrubKey(err, cfg.apiKey));
	}
	res.latencyMs = Date.now() - start;
	if (failure !== "") {
		res.error = failure;
		return res;
	}
	if (calls === null || calls === 0) {
		res.error = NO_TOOL_CALLS;
		return res;
	}
	res.ok = true;
	res.toolCalls = true;
	res.vision = await probeVision(conn, cfg);
	return res;
}

/** probeVision sends one tiny image; an endpoint that takes it can be given drawing crops. */
async function probeVision(conn: Connection, cfg: LLM): Promise<boolean> {
	try {
		await toolCallsOf(conn, visionBody(cfg));
		return true;
	} catch {
		return false;
	}
}

/** One chat completion; the number of tool calls in the first choice, which Go only counts. */
async function toolCallsOf(conn: Connection, body: Ordered): Promise<number> {
	const raw = await call(conn, "POST", "/chat/completions", goMarshal(body));
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(raw));
	} catch {
		// Never the parser's own message: it quotes the body (decisions.md).
		throw new Error("decode completion: invalid JSON");
	}
	const choices = typeof value === "object" && value !== null ? (value as { choices?: unknown }).choices : undefined;
	if (!Array.isArray(choices) || choices.length === 0) throw new Error("endpoint returned no choices");
	const first: unknown = choices[0];
	const message = typeof first === "object" && first !== null ? (first as { message?: unknown }).message : undefined;
	const toolCalls =
		typeof message === "object" && message !== null ? (message as { tool_calls?: unknown }).tool_calls : undefined;
	return Array.isArray(toolCalls) ? toolCalls.length : 0;
}

/** probeChatBody is Go's request struct with its `omitempty` fields left out (openai.go:24-35). */
function probeChatBody(cfg: LLM): Ordered {
	return new Ordered([
		["model", cfg.model],
		[
			"messages",
			[
				new Ordered([
					["role", "system"],
					["content", PROBE_SYSTEM],
				]),
				new Ordered([
					["role", "user"],
					["content", PROBE_QUESTION],
				]),
			],
		],
		["tools", [probeTool()]],
		...thinking(cfg),
	]);
}

/** visionBody is one user turn whose content is the question and the pixel. */
function visionBody(cfg: LLM): Ordered {
	return new Ordered([
		["model", cfg.model],
		[
			"messages",
			[
				new Ordered([
					["role", "user"],
					[
						"content",
						[
							new Ordered([
								["type", "text"],
								["text", VISION_QUESTION],
							]),
							new Ordered([
								["type", "image_url"],
								["image_url", new Ordered([["url", `data:image/png;base64,${PROBE_PNG_BASE64}`]])],
							]),
						],
					],
				]),
			],
		],
		...thinking(cfg),
	]);
}

/** chat_template_kwargs is sent only when thinking is on demand (openai.go:153-155). */
function thinking(cfg: LLM): (readonly [string, unknown])[] {
	if (!cfg.thinkOnDemand) return [];
	return [["chat_template_kwargs", new Ordered([["enable_thinking", false]])]];
}

/** probeTool is server.go:514-517: one tool, so the answer can only be a call. */
function probeTool(): Ordered {
	return new Ordered([
		["type", "function"],
		[
			"function",
			new Ordered([
				["name", "set_dates"],
				["description", "Set the move-in date (YYYY-MM-DD)."],
				[
					"parameters",
					new Ordered([
						["type", "object"],
						["properties", new Ordered([["move_in", new Ordered([["type", "string"]])]])],
						["required", ["move_in"]],
					]),
				],
			]),
		],
	]);
}
