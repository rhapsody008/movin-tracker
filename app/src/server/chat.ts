// The web chat: POST /api/chat (server.go:435-481) and, new in v3, GET
// /api/chat/history. One conversation per signed-in email, held by the durable
// agent under the key `web:<email>` (T3.2's directory), so a reload shows the
// server's history and two tabs stay in step.
//
// The request body is Go's, and only its newest turn is used: v1's page sent
// the whole conversation on every message because the server kept nothing, and
// v3 keeps everything, so an older turn would be a second copy of what the
// conversation already holds. The `turns` wrapper stays, so a v1 page (and
// curl) still speak it.
//
// The two responses are Go's byte for byte (agent-spec §4.2): the JSON Result,
// or an SSE stream of `delta`, `reset`, `change` frames and a final `done` or
// `error`. Every turn also goes onto the `/api/events` stream of the same email
// as a `chat` frame, tagged with the request's id, which is how a second tab
// follows the conversation (T3.5).

import { randomUUID } from "node:crypto";
import { type ChatResult, chatReply, cutOffBeforeText, parseThink, replyText, wireChanges } from "../agent/reply.ts";
import type { Agent, AgentEvent, ChangeLine } from "../durable/adapter.ts";
import { goMarshal, Ordered } from "../gojson.ts";
import { goTrimSpace } from "../gostr.ts";
import type { Log } from "../log.ts";
import type { SettingsService } from "../settings/settings.ts";
import { startSSE } from "./events.ts";
import { decodeBody, decodeFailed, fieldOf, header, requestPath, writeErr, writeJSON } from "./http.ts";
import type { Handler } from "./router.ts";

/** Go's InputError for a connection with no endpoint or model (agent.go:161-163). */
export const NO_CONNECTION_MESSAGE = "no LLM endpoint or model is configured; set one in Settings → LLM";

/** Go's InputError for a body whose last turn is not the person speaking (agent.go:157-159). */
export const LAST_TURN_MESSAGE = "the last turn must be a user message";

/**
 * v3 only: the answer while serve() is still opening the harness (Go has no such
 * state). 503 is Go's code for "not ready": GET /readyz answers it with
 * `S3 not reachable` (server.go:470-480), and this is the chat's own body.
 */
export const NOT_READY_MESSAGE = "the assistant is still starting; try again in a moment";

/** A history page's default size, and the most one may ask for. */
export const HISTORY_LIMIT = 50;
export const HISTORY_MAX = 200;

/** The key one person's web conversation is stored under: Go's web channel plus the email. */
export function conversationKey(email: string): string {
	return `web:${email}`;
}

/** One turn of Go's `{"turns":[…]}` body (history.go:10-13). */
interface Turn {
	role: string;
	content: string;
}

export interface ChatOptions {
	/** The durable agent, or null while serve() is still opening it. */
	agent: () => Agent | null;
	/** The connection: the model line, the streaming choice and the missing-connection 400 come from it. */
	settings: SettingsService;
	/** One `chat` frame for the other tabs of this email (events.ts). */
	chatStream: (email: string, payload: string) => void;
	log: Log;
}

export interface ChatRoutes {
	/** POST /api/chat. */
	chat: Handler;
	/** GET /api/chat/history. */
	history: Handler;
}

export function createChatRoutes(o: ChatOptions): ChatRoutes {
	const chat: Handler = async (req, res, h) => {
		const body = await decodeBody(req, res);
		if (body === null) return;
		let turns: Turn[];
		try {
			turns = turnsOf(body);
		} catch (err) {
			decodeFailed(res, err);
			return;
		}
		// Go resolves the connection first (server.go:441), before it knows how the
		// answer will be shaped, so the streaming choice is part of every check
		// below: an input error is a 400 in the JSON form and an `error` frame on the
		// stream, as Go's InputError is (server.go:459-476, P6).
		const cfg = await o.settings.resolve();
		const wantStream = cfg.streaming && header(req, "accept").includes("text/event-stream");
		if (wantStream) startSSE(res);
		const email = h.user;
		const requestId = requestOf(body);
		/** send writes one frame of this request's own stream, and nothing in the JSON form. */
		const send = (event: string, payload: string): void => {
			if (!wantStream || res.writableEnded || res.destroyed) return;
			res.write(`event: ${event}\ndata: ${payload}\n\n`);
		};
		/**
		 * failTurn answers a turn that cannot start. Go's stream branch sends Run's
		 * zero `Result` on a `prepare` error — `Changes` is nil there, so the frame
		 * carries `"changes":null` — and logs the same WARN line the 502 path does
		 * (server.go:472-476); the JSON form is the 400 and logs nothing.
		 */
		const failTurn = (status: number, message: string): void => {
			if (!wantStream) {
				writeErr(res, status, message);
				return;
			}
			o.log.warn("chat failed", { by: email, model: cfg.model, err: message });
			send("error", goMarshal(new Ordered(failureParts({ changes: null, error: message, model: cfg.model }))));
			res.end();
		};

		// Only the newest turn is this request's: the rest of the conversation is
		// already in the harness (decisions.md · T3.5). Go's rule for the last turn
		// is kept, and a blank one cannot be it (CleanTurns would have dropped it).
		const newest = turns.at(-1);
		if (newest === undefined || newest.role !== "user" || goTrimSpace(newest.content) === "") {
			failTurn(400, LAST_TURN_MESSAGE);
			return;
		}
		// The page keeps "/think …" in what it shows; the model never sees the command.
		const { text, think } = parseThink(newest.content);
		// "/think" on its own is Go's blank turn: it thinks about nothing, CleanTurns
		// drops it, and prepare answers the last-turn 400 (P3).
		if (goTrimSpace(text) === "") {
			failTurn(400, LAST_TURN_MESSAGE);
			return;
		}
		if (cfg.baseUrl === "" || cfg.model === "") {
			failTurn(400, NO_CONNECTION_MESSAGE);
			return;
		}
		const agent = o.agent();
		if (agent === null) {
			failTurn(503, NOT_READY_MESSAGE);
			return;
		}

		// A closed request ends the turn, as Go's request context does: the Stop
		// button aborts the fetch, and a reload during a turn closes it.
		const controller = new AbortController();
		res.on("close", () => controller.abort());

		/** broadcast is one `chat` frame for the other tabs: the same payload, tagged with this request. */
		const broadcast = (parts: readonly (readonly [string, unknown])[]): void => {
			o.chatStream(email, goMarshal(new Ordered([...parts, ["request", requestId]])));
		};

		// The other tabs see the message as it was typed, `/think` and all: the
		// transcript keeps that text too (P4), and only the model loses the command.
		broadcast([
			["type", "user"],
			["text", newest.content],
		]);
		const result = await agent.submit(conversationKey(email), text, {
			think,
			display: newest.content,
			actor: { by: email, channel: "web" },
			signal: controller.signal,
			onEvent: (event) => {
				const parts = wireEvent(event);
				// `tool` and `retry` are the adapter's own; Go's page has no frame for them.
				if (parts === null) return;
				send(event.type, goMarshal(new Ordered(parts)));
				broadcast(parts);
			},
		});

		const outcome = chatReply(result, cfg.model);
		if (outcome.ok) {
			// Go drops a partial answer the model then declined (agent.go:193-196).
			if (result.status === "answered" && result.stop === "refusal") {
				send("reset", goMarshal(new Ordered([["type", "reset"]])));
				broadcast([["type", "reset"]]);
			}
			const parts = doneParts(outcome.result);
			broadcast([["type", "done"], ...parts]);
			if (wantStream) {
				send("done", goMarshal(new Ordered(parts)));
				res.end();
			} else {
				writeJSON(res, 200, new Ordered(parts));
			}
			return;
		}
		// Go's WARN line, except for a Stop: that is the user's own doing, not a fault.
		if (result.status === "failed" && result.reason !== "aborted") {
			o.log.warn("chat failed", { by: email, model: cfg.model, err: outcome.error });
		}
		const failure = failureParts(outcome);
		broadcast([["type", "error"], ...failure]);
		if (wantStream) {
			send("error", goMarshal(new Ordered(failure)));
			res.end();
		} else {
			writeJSON(res, 502, new Ordered(failure));
		}
	};

	const history: Handler = async (req, res, h) => {
		const agent = o.agent();
		// A page that loads while the harness is still opening gets an empty
		// conversation rather than an error: the run it starts once the agent is up
		// is the one that matters, and a reload shows the history anyway.
		if (agent === null) {
			writeJSON(res, 200, pageBody([], false, ""));
			return;
		}
		const query = new URLSearchParams(requestPath(req.url).query);
		const limit = intOr(query.get("limit"), HISTORY_LIMIT);
		const before = intOr(query.get("before"), Number.NaN);
		const page = await agent.history(conversationKey(h.user), {
			limit: Math.min(Math.max(limit, 1), HISTORY_MAX),
			...(Number.isNaN(before) ? {} : { before }),
		});
		// The adapter reads newest first; a transcript reads oldest first. An answer
		// row goes through the same rules the live turn used — `replyText`, applied to
		// its stop and the tools the run had — so a reload shows `Done.`, the declined
		// text, the cut-off note or the documents line exactly as the bubble did (Q1).
		// A user row is what the person typed.
		type Row = { role: "user" | "assistant"; text: string; at: number; changes: ChangeLine[] };
		const rows: Row[] = [];
		/** The user row that opened the current run, or -1 when this page starts inside one. */
		let opened = -1;
		for (const item of page.items.toReversed()) {
			const changes = [...(item.changes ?? [])];
			if (item.role === "user") {
				rows.push({ role: "user", text: item.text, at: item.at, changes });
				opened = rows.length - 1;
				continue;
			}
			// Go reports a turn cut off before it said anything as an error, not an
			// answer (agent.go:196-204): live, the page showed that line and the changes
			// kept before it, and a reload shows the same — no assistant row, its
			// changes on the message that started the turn, exactly as a failed run's
			// are (R2). A page that starts inside a run (a hand-made cursor) has no such
			// row to hang them on, so that answer is dropped rather than shown as a
			// bubble of its own.
			if (cutOffBeforeText(item.stop ?? "end", item.text)) {
				const user = rows[opened];
				if (user !== undefined) user.changes.push(...changes);
				continue;
			}
			rows.push({
				role: "assistant",
				text: replyText({
					text: item.text,
					stop: item.stop ?? "end",
					changes: wireChanges(changes),
					toolsUsed: item.toolsUsed ?? [],
				}),
				at: item.at,
				changes,
			});
		}
		const items = rows.map(
			(row) =>
				new Ordered([
					["role", row.role],
					["text", row.text],
					["at", row.at],
					["changes", changeJson(row.changes)],
				]),
		);
		// The cursor is this page's oldest row: pass it as `before` to read the page
		// under it. Absent when there is nothing older.
		const cursor = page.more && items.length > 0 ? String(page.items.at(-1)?.id ?? "") : "";
		writeJSON(res, 200, pageBody(items, page.more, cursor));
	};

	return { chat, history };

	/** requestOf is the id this turn's `chat` frames carry; the page makes it, curl gets one. */
	function requestOf(body: Record<string, unknown>): string {
		const { value } = fieldOf(body, "request");
		return typeof value === "string" && value !== "" ? value : randomUUID();
	}
}

/** intOr is a query number: absent or not a number is `fallback`. */
function intOr(raw: string | null, fallback: number): number {
	if (raw === null || !/^-?\d+$/.test(raw)) return fallback;
	return Number.parseInt(raw, 10);
}

/** turnsOf decodes Go's `{"turns":[…]}`: a list of {role, content}, or a decode error. */
function turnsOf(body: Record<string, unknown>): Turn[] {
	const { found, value } = fieldOf(body, "turns");
	if (!found || value === null) return [];
	if (!Array.isArray(value)) throw new TypeError("turns must be a list");
	return value.map((item: unknown): Turn => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new TypeError("each turn must be an object");
		}
		const raw = item as Record<string, unknown>;
		return { role: stringField(raw, "role"), content: stringField(raw, "content") };
	});
}

/** stringField is Go's decode of one string field of a struct: absent is "", a non-string is an error. */
function stringField(raw: Record<string, unknown>, key: string): string {
	const { value } = fieldOf(raw, key);
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

/**
 * wireEvent is Go's `agent.Event` (agent.go:86-90): the type and the fields it
 * has, in that order. It answers null for the adapter's own `tool` and `retry`
 * events, which no client of Go's ever saw.
 */
function wireEvent(event: AgentEvent): (readonly [string, unknown])[] | null {
	switch (event.type) {
		case "delta":
			return [
				["type", "delta"],
				["text", event.text],
			];
		case "reset":
			return [["type", "reset"]];
		case "change":
			return event.id === undefined
				? [
						["type", "change"],
						["text", event.text],
					]
				: [
						["type", "change"],
						["text", event.text],
						["id", event.id],
					];
		default:
			return null;
	}
}

/** doneParts is Go's Result (agent.go:59-68) in struct order: reply, changes, model. */
function doneParts(result: ChatResult): (readonly [string, unknown])[] {
	return [
		["reply", result.reply],
		["changes", changeJson(result.changes)],
		["model", result.model],
	];
}

/**
 * failureParts is Go's 502 body: a map, so its keys are alphabetical (changes,
 * error, model). `changes: null` is Go's nil `Result.Changes` — what the stream
 * branch sends for an input error — and not an empty list.
 */
function failureParts(outcome: {
	changes: readonly ChangeLine[] | null;
	error: string;
	model: string;
}): (readonly [string, unknown])[] {
	return [
		["changes", outcome.changes === null ? null : changeJson(outcome.changes)],
		["error", outcome.error],
		["model", outcome.model],
	];
}

/** changeJson is Go's ChangeLine on the wire: id first when it has one, then the text. */
function changeJson(changes: readonly { id?: string; text: string }[]): Ordered[] {
	return wireChanges(changes).map(
		(line) =>
			new Ordered(
				line.id === undefined
					? [["text", line.text]]
					: [
							["id", line.id],
							["text", line.text],
						],
			),
	);
}

/** pageBody is GET /api/chat/history's answer: oldest first, with the cursor under the page. */
function pageBody(items: readonly Ordered[], more: boolean, cursor: string): Ordered {
	return new Ordered([
		["items", items],
		["more", more],
		["cursor", cursor],
	]);
}
