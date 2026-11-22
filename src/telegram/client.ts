// The Telegram Bot API client: Go's internal/telegram/client.go on global fetch
// (plan.md:123), with no dependency. Every type here is a Bot API type the bot
// reads, named as Go's struct field tags name them; unknown fields a Bot API
// answer carries are dropped on the way in (spec §1.1).
//
// The token is part of the request URL, so nothing this file throws may carry a
// URL: every failure is rebuilt as a scrubbed message — the token replaced by
// `<token>`, the text prefixed `telegram <method>: ` — and nothing keeps the
// error it came from (Go's scrubbedError unwraps only to context.Canceled /
// context.DeadlineExceeded, so an abort or a timeout keeps Node's own name and
// the URL never reaches a caller, a log or util.inspect).
//
// Requests are Go's bytes: the request bodies come out of goMarshal in Go's
// field order (a struct's declaration order for sendMessage and the keyboards,
// a map's sorted keys for the rest) and with Go's omitempty rules, and
// `src/telegram/testdata/requests.go.json` is what the real Go client sent.
// There are no retries here: backoff belongs to the callers (spec §1.5).
//
// Known differences from Go, none of them visible to Telegram:
// - a transport failure reads `telegram <method>: fetch failed` (Node's own
//   text) where Go's quotes the URL and the dial error — that URL is the reason
//   for the scrub, so the text is dropped rather than rewritten;
// - the detail after `unreadable answer: ` is this port's (`not a JSON value at
//   byte 0`) where Go's is its json scanner's;
// - a field (of a result or of the answer envelope) with the wrong type is read
//   as its zero value instead of failing the whole decode; a wrong top-level
//   shape still fails, with Go's `json: cannot unmarshal <kind> into Go value of
//   type …` text.

import { goMarshal, Ordered, scanJsonValue } from "../gojson.ts";
import { goTrimRight } from "../gostr.ts";
import { errorMessage } from "../log.ts";

export const DEFAULT_BASE_URL = "https://api.telegram.org";

/** The Bot API's limit for the files a bot may download (Go's MaxDownload). */
export const MAX_DOWNLOAD = 20 << 20;

/** How much of an answer body is read (Go's io.LimitReader(resp.Body, 8<<20)). */
const ANSWER_LIMIT = 8 << 20;

/** Go's callTimeout: every request but the long poll and a download. */
const CALL_TIMEOUT_MS = 30_000;

/** Go's 2*time.Minute around Download. */
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** getUpdates may be held open for pollSeconds; Go allows 15 s on top. */
const POLL_HEADROOM_MS = 15_000;

/** Go's http.StatusConflict: another poller or a webhook holds the token. */
const STATUS_CONFLICT = 409;

// ---------- types (the fields the bot uses; Go's zero value when absent) ----------

export interface Update {
	update_id: number;
	message?: Message;
	callback_query?: CallbackQuery;
}

export interface Message {
	message_id: number;
	from?: User;
	chat: Chat;
	date: number;
	text: string;
	caption: string;
	document?: Document;
	photo: PhotoSize[];
	voice?: Voice;
	/** The message's inline keyboard, present on the bot's own messages when a callback query returns them. */
	reply_markup?: InlineKeyboardMarkup;
	/** Set on the service message Telegram sends when a group becomes a supergroup; 0 means absent. */
	migrate_to_chat_id: number;
}

export interface User {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name: string;
	username: string;
}

export interface Chat {
	id: number;
	/** private | group | supergroup | channel */
	type: string;
	title: string;
	username: string;
	first_name: string;
}

/** Go's Chat.IsGroup: a group or a supergroup, never a channel. */
export function isGroupChat(chat: Chat): boolean {
	return chat.type === "group" || chat.type === "supergroup";
}

export interface CallbackQuery {
	id: string;
	from: User;
	message?: Message;
	data: string;
}

export interface Document {
	file_id: string;
	file_unique_id: string;
	file_name: string;
	mime_type: string;
	file_size: number;
}

export interface PhotoSize {
	file_id: string;
	width: number;
	height: number;
	file_size: number;
}

export interface Voice {
	file_id: string;
	duration: number;
	mime_type: string;
	file_size: number;
}

export interface File {
	file_id: string;
	file_size: number;
	file_path: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
	text: string;
	callback_data?: string;
}

export interface BotCommand {
	command: string;
	description: string;
}

/**
 * The subset of sendMessage parameters the bot uses, in Go's field order. Text
 * is sent as plain text (no parse_mode), so nothing in it needs escaping.
 */
export interface SendMessage {
	chat_id: number;
	text: string;
	reply_to_message_id?: number;
	reply_markup?: InlineKeyboardMarkup;
}

// ---------- errors ----------

/** A Bot API answer with ok=false: Go's APIError, its message Go's Error(). */
export class TelegramApiError extends Error {
	readonly method: string;
	/** error_code, or the HTTP status when the answer carried none; 409 is another poller. */
	readonly code: number;
	readonly description: string;
	/** parameters.retry_after in seconds, 0 when absent: 429 flood control. */
	readonly retryAfter: number;

	constructor(method: string, code: number, description: string, retryAfter: number) {
		super(`telegram ${method}: ${code} ${description}`);
		this.name = "TelegramApiError";
		this.method = method;
		this.code = code;
		this.description = description;
		this.retryAfter = retryAfter;
	}
}

/** Go's IsConflict: another getUpdates poller (or a webhook) is using the token. */
export function isConflict(err: unknown): boolean {
	return err instanceof TelegramApiError && err.code === STATUS_CONFLICT;
}

/**
 * Everything else the client throws: Go's scrubbedError. The message is the
 * failure with the token replaced by `<token>` and Go's `telegram <method>: `
 * in front, and there is no cause chain to the original error — that one quotes
 * the URL. An abort or a deadline keeps Node's own `name`, which is what Go's
 * unwrap to context.Canceled / context.DeadlineExceeded is for.
 */
export class TelegramError extends Error {
	readonly method: string;

	constructor(
		method: string,
		message: string,
		name: "TelegramError" | "AbortError" | "TimeoutError" = "TelegramError",
	) {
		super(`telegram ${method}: ${message}`);
		this.name = name;
		this.method = method;
	}
}

/** True for the client's own deadline (Go's context.DeadlineExceeded) after the scrub. */
export function isTimeout(err: unknown): boolean {
	return err instanceof Error && err.name === "TimeoutError";
}

/** True when the caller's signal ended the request (Go's context.Canceled) after the scrub. */
export function isAborted(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

/** Go's ErrTooLarge: a download over the limit, reported as it is (not scrubbed, not an API answer). */
export class TooLargeError extends Error {
	constructor() {
		super("file is larger than the download limit");
		this.name = "TooLargeError";
	}
}

// ---------- client ----------

export interface ClientOptions {
	token: string;
	/** Default DEFAULT_BASE_URL; tests point it at a fake server. */
	baseUrl?: string;
	/** Default the global fetch. */
	fetch?: typeof fetch;
	/** Download limit in bytes; MAX_DOWNLOAD when absent or 0. */
	maxDownload?: number;
}

export interface Client {
	/**
	 * Long-polls for updates after offset. pollSeconds is how long Telegram may
	 * hold the request open when there is nothing new.
	 */
	getUpdates(offset: number, pollSeconds: number, signal?: AbortSignal): Promise<Update[]>;
	getMe(signal?: AbortSignal): Promise<User>;
	sendMessage(m: SendMessage, signal?: AbortSignal): Promise<Message>;
	/** Shows "typing…" (the only action the bot sends) for about five seconds. */
	sendChatAction(chatId: number, signal?: AbortSignal): Promise<void>;
	/** Acknowledges a button press; text, when set, shows as a small toast in the client. */
	answerCallbackQuery(id: string, text?: string, signal?: AbortSignal): Promise<void>;
	/** Replaces a message's inline keyboard; null removes it, which is sent as the empty keyboard. */
	editMessageReplyMarkup(
		chatId: number,
		messageId: number,
		markup: InlineKeyboardMarkup | null,
		signal?: AbortSignal,
	): Promise<void>;
	setMyCommands(commands: BotCommand[], signal?: AbortSignal): Promise<void>;
	getFile(fileId: string, signal?: AbortSignal): Promise<File>;
	/** Fetches a file by the path getFile returned, refusing anything over the limit. */
	download(filePath: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export function createClient(o: ClientOptions): Client {
	const token = o.token;
	const baseUrl = goTrimRight(o.baseUrl ?? DEFAULT_BASE_URL, "/");
	const doFetch = o.fetch ?? fetch;
	const maxDownload = o.maxDownload !== undefined && o.maxDownload > 0 ? o.maxDownload : MAX_DOWNLOAD;

	/**
	 * One scrubbed failure: the token out of detail, Go's prefix on, and Node's
	 * ending kept from the error it came from (a deadline that fires while the
	 * body is being read is still a deadline, as Go's %w keeps it).
	 */
	function scrubbed(method: string, err: unknown, detail: string = errorMessage(err)): TelegramError {
		const text = token === "" ? detail : detail.split(token).join("<token>");
		return new TelegramError(method, text, abortName(err) ?? "TelegramError");
	}

	/** POSTs body to method and decodes the answer's result with decode (Go's call). */
	async function call<T>(
		method: string,
		body: Ordered,
		timeoutMs: number,
		decode: (value: unknown) => T,
		signal?: AbortSignal,
	): Promise<T> {
		let payload: string;
		try {
			payload = goMarshal(body);
		} catch (err) {
			throw scrubbed(method, err);
		}
		let resp: Response;
		try {
			resp = await doFetch(`${baseUrl}/bot${token}/${method}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: payload,
				signal: deadline(timeoutMs, signal),
			});
		} catch (err) {
			throw scrubbed(method, err);
		}
		let answer: Envelope;
		try {
			answer = envelopeOf(await readAtMost(resp, ANSWER_LIMIT));
		} catch (err) {
			throw scrubbed(method, err, `HTTP ${resp.status}, unreadable answer: ${errorMessage(err)}`);
		}
		if (!answer.ok) {
			// error_code falls back to the HTTP status; the description is scrubbed like any text.
			const code = answer.error_code === 0 ? resp.status : answer.error_code;
			const description = token === "" ? answer.description : answer.description.split(token).join("<token>");
			throw new TelegramApiError(method, code, description, answer.retry_after);
		}
		try {
			// Go's json.Unmarshal of a missing result is `unexpected end of JSON input`.
			if (!answer.hasResult) throw new TypeError("unexpected end of JSON input");
			return decode(answer.result);
		} catch (err) {
			throw scrubbed(method, err, `decode result: ${errorMessage(err)}`);
		}
	}

	return {
		async getUpdates(offset, pollSeconds, signal) {
			// Go marshals a map, so its keys come out sorted: allowed_updates first.
			const body = new Ordered([
				["allowed_updates", ["message", "callback_query"]],
				["offset", offset],
				["timeout", pollSeconds],
			]);
			return await call("getUpdates", body, pollSeconds * 1000 + POLL_HEADROOM_MS, updatesOf, signal);
		},

		async getMe(signal) {
			// Go sends the empty struct, which is `{}`.
			return await call("getMe", new Ordered([]), CALL_TIMEOUT_MS, userOf, signal);
		},

		async sendMessage(m, signal) {
			return await call("sendMessage", sendMessageBody(m), CALL_TIMEOUT_MS, messageOf, signal);
		},

		async sendChatAction(chatId, signal) {
			const body = new Ordered([
				["action", "typing"],
				["chat_id", chatId],
			]);
			return await call("sendChatAction", body, CALL_TIMEOUT_MS, nothing, signal);
		},

		async answerCallbackQuery(id, text, signal) {
			const fields: (readonly [string, unknown])[] = [["callback_query_id", id]];
			if (text !== undefined && text !== "") fields.push(["text", text]);
			return await call("answerCallbackQuery", new Ordered(fields), CALL_TIMEOUT_MS, nothing, signal);
		},

		async editMessageReplyMarkup(chatId, messageId, markup, signal) {
			const body = new Ordered([
				["chat_id", chatId],
				["message_id", messageId],
				// A null markup is Go's empty keyboard, so the field is always sent: omitting
				// it would be a different request (spec §11 trap 15).
				["reply_markup", markupJSON(markup ?? { inline_keyboard: [] })],
			]);
			return await call("editMessageReplyMarkup", body, CALL_TIMEOUT_MS, nothing, signal);
		},

		async setMyCommands(commands, signal) {
			const list = commands.map(
				(c) =>
					new Ordered([
						["command", c.command],
						["description", c.description],
					]),
			);
			return await call("setMyCommands", new Ordered([["commands", list]]), CALL_TIMEOUT_MS, nothing, signal);
		},

		async getFile(fileId, signal) {
			return await call("getFile", new Ordered([["file_id", fileId]]), CALL_TIMEOUT_MS, fileOf, signal);
		},

		async download(filePath, signal) {
			// Go's strings.TrimLeft(filePath, "/"): every leading slash off.
			const url = `${baseUrl}/file/bot${token}/${filePath.replace(/^\/+/, "")}`;
			let resp: Response;
			try {
				resp = await doFetch(url, { signal: deadline(DOWNLOAD_TIMEOUT_MS, signal) });
			} catch (err) {
				throw scrubbed("download", err);
			}
			if (resp.status !== 200) throw scrubbed("download", new Error(`HTTP ${resp.status}`));
			// The declared length is checked before reading and the read length after,
			// as Go does: a stream without Content-Length can only be caught by the read.
			const declared = resp.headers.get("content-length");
			if (declared !== null && Number.parseInt(declared, 10) > maxDownload) throw new TooLargeError();
			let data: Uint8Array;
			try {
				data = await readAtMost(resp, maxDownload + 1);
			} catch (err) {
				throw scrubbed("download", err);
			}
			if (data.length > maxDownload) throw new TooLargeError();
			return data;
		},
	};
}

// ---------- request bodies ----------

/** Go's SendMessage as bytes: chat_id and text always, the two optional fields only when set. */
function sendMessageBody(m: SendMessage): Ordered {
	const fields: (readonly [string, unknown])[] = [
		["chat_id", m.chat_id],
		["text", m.text],
	];
	if (m.reply_to_message_id !== undefined && m.reply_to_message_id !== 0) {
		fields.push(["reply_to_message_id", m.reply_to_message_id]);
	}
	if (m.reply_markup !== undefined) fields.push(["reply_markup", markupJSON(m.reply_markup)]);
	return new Ordered(fields);
}

/** Go's InlineKeyboardMarkup as bytes: one array of rows of buttons. */
function markupJSON(markup: InlineKeyboardMarkup): Ordered {
	const rows = markup.inline_keyboard.map((row) => row.map(buttonJSON));
	return new Ordered([["inline_keyboard", rows]]);
}

/** Go's InlineKeyboardButton as bytes: text always, callback_data when not empty. */
function buttonJSON(button: InlineKeyboardButton): Ordered {
	const fields: (readonly [string, unknown])[] = [["text", button.text]];
	if (button.callback_data !== undefined && button.callback_data !== "") {
		fields.push(["callback_data", button.callback_data]);
	}
	return new Ordered(fields);
}

// ---------- the answer ----------

interface Envelope {
	ok: boolean;
	hasResult: boolean;
	result: unknown;
	error_code: number;
	description: string;
	retry_after: number;
}

/**
 * The answer envelope `{ok, result, error_code, description, parameters}`, read
 * the way Go's json.Decoder reads it: the first JSON value only, so trailing
 * bytes are ignored. A body that is not one object throws — a proxy's HTML error
 * page lands here — and "null" is Go's no-op decode of a struct: an empty answer.
 */
function envelopeOf(bytes: Uint8Array): Envelope {
	const text = new TextDecoder().decode(bytes);
	const value: unknown = JSON.parse(text.slice(0, scanJsonValue(text, 0)));
	if (value === null) {
		return { ok: false, hasResult: false, result: undefined, error_code: 0, description: "", retry_after: 0 };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`not a JSON object: ${kindOf(value)}`);
	}
	const fields = value as Record<string, unknown>;
	const declared = fields.parameters;
	const parameters = typeof declared === "object" && declared !== null ? (declared as Record<string, unknown>) : {};
	return {
		ok: fields.ok === true,
		hasResult: Object.hasOwn(fields, "result"),
		result: fields.result,
		error_code: numberField(fields.error_code),
		description: stringField(fields.description),
		retry_after: numberField(parameters.retry_after),
	};
}

// ---------- decoding (Go's json.Unmarshal rules for the types above) ----------

function updatesOf(value: unknown): Update[] {
	if (value === null) return [];
	if (!Array.isArray(value)) throw typeError(value, "[]telegram.Update");
	return value.map(updateOf);
}

function updateOf(value: unknown): Update {
	const fields = objectOf(value, "telegram.Update");
	return {
		update_id: numberField(fields.update_id),
		message: optional(fields.message, messageOf),
		callback_query: optional(fields.callback_query, callbackQueryOf),
	};
}

function messageOf(value: unknown): Message {
	const fields = objectOf(value, "telegram.Message");
	return {
		message_id: numberField(fields.message_id),
		from: optional(fields.from, userOf),
		chat: chatOf(fields.chat),
		date: numberField(fields.date),
		text: stringField(fields.text),
		caption: stringField(fields.caption),
		document: optional(fields.document, documentOf),
		// Go's nil slice for an absent photo list is the empty array here.
		photo: Array.isArray(fields.photo) ? fields.photo.map(photoOf) : [],
		voice: optional(fields.voice, voiceOf),
		reply_markup: optional(fields.reply_markup, keyboardOf),
		migrate_to_chat_id: numberField(fields.migrate_to_chat_id),
	};
}

function userOf(value: unknown): User {
	const fields = objectOf(value, "telegram.User");
	return {
		id: numberField(fields.id),
		is_bot: fields.is_bot === true,
		first_name: stringField(fields.first_name),
		last_name: stringField(fields.last_name),
		username: stringField(fields.username),
	};
}

function chatOf(value: unknown): Chat {
	const fields = objectOf(value, "telegram.Chat");
	return {
		id: numberField(fields.id),
		type: stringField(fields.type),
		title: stringField(fields.title),
		username: stringField(fields.username),
		first_name: stringField(fields.first_name),
	};
}

function callbackQueryOf(value: unknown): CallbackQuery {
	const fields = objectOf(value, "telegram.CallbackQuery");
	return {
		id: stringField(fields.id),
		// Go's struct field, not a pointer: a zero User when the query carries none.
		from: userOf(fields.from),
		message: optional(fields.message, messageOf),
		data: stringField(fields.data),
	};
}

function documentOf(value: unknown): Document {
	const fields = objectOf(value, "telegram.Document");
	return {
		file_id: stringField(fields.file_id),
		file_unique_id: stringField(fields.file_unique_id),
		file_name: stringField(fields.file_name),
		mime_type: stringField(fields.mime_type),
		file_size: numberField(fields.file_size),
	};
}

function photoOf(value: unknown): PhotoSize {
	const fields = objectOf(value, "telegram.PhotoSize");
	return {
		file_id: stringField(fields.file_id),
		width: numberField(fields.width),
		height: numberField(fields.height),
		file_size: numberField(fields.file_size),
	};
}

function voiceOf(value: unknown): Voice {
	const fields = objectOf(value, "telegram.Voice");
	return {
		file_id: stringField(fields.file_id),
		duration: numberField(fields.duration),
		mime_type: stringField(fields.mime_type),
		file_size: numberField(fields.file_size),
	};
}

function fileOf(value: unknown): File {
	const fields = objectOf(value, "telegram.File");
	return {
		file_id: stringField(fields.file_id),
		file_size: numberField(fields.file_size),
		file_path: stringField(fields.file_path),
	};
}

function keyboardOf(value: unknown): InlineKeyboardMarkup {
	const fields = objectOf(value, "telegram.InlineKeyboardMarkup");
	const rows = Array.isArray(fields.inline_keyboard) ? fields.inline_keyboard : [];
	return { inline_keyboard: rows.map((row) => (Array.isArray(row) ? row.map(buttonOf) : [])) };
}

function buttonOf(value: unknown): InlineKeyboardButton {
	const fields = objectOf(value, "telegram.InlineKeyboardButton");
	return { text: stringField(fields.text), callback_data: stringField(fields.callback_data) };
}

/** A pointer field: absent or null is Go's nil, anything else is decoded (and checked). */
function optional<T>(value: unknown, decode: (v: unknown) => T): T | undefined {
	if (value === undefined || value === null) return undefined;
	return decode(value);
}

/**
 * One Go struct: an object, whose unknown keys the callers' field reads drop, or
 * null (and an absent field, which Go never passes to Unmarshal) for its zero
 * value.
 */
function objectOf(value: unknown, goType: string): Record<string, unknown> {
	if (value === null || value === undefined) return {};
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	throw typeError(value, goType);
}

/** Go's unmarshal error for a value of the wrong shape. */
function typeError(value: unknown, goType: string): TypeError {
	return new TypeError(`json: cannot unmarshal ${kindOf(value)} into Go value of type ${goType}`);
}

/** Go's name for a JSON value's kind, as its unmarshal error spells it. */
function kindOf(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (Array.isArray(value)) return "array";
	switch (typeof value) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "bool";
		default:
			return "object";
	}
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A result this client reads nothing out of: Go's out == nil. */
function nothing(): void {
	// Nothing to decode: the Bot API still answers `ok:true`.
}

// ---------- transport ----------

/**
 * The request's signal: the caller's and the per-call deadline combined. The
 * composed signal ends with the reason of whichever fired first, so the
 * rejection is Node's TimeoutError for a deadline and AbortError for the caller
 * — the kinds Go keeps across its scrub.
 */
function deadline(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const limit = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? limit : AbortSignal.any([signal, limit]);
}

/** Node's name for an ending this client must not lose, or null for any other failure. */
function abortName(err: unknown): "AbortError" | "TimeoutError" | null {
	if (!(err instanceof Error)) return null;
	if (err.name === "AbortError" || err.name === "TimeoutError") return err.name;
	return null;
}

/**
 * At most limit bytes of a body, then the rest is dropped and the stream
 * cancelled: Go's io.LimitReader and resp.Body.Close.
 */
async function readAtMost(resp: Response, limit: number): Promise<Uint8Array> {
	const reader = resp.body?.getReader();
	if (reader === undefined) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < limit) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		const part = value.length > limit - size ? value.subarray(0, limit - size) : value;
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
