// The Bot API client (src/telegram/client.ts): every test of Go's
// internal/telegram/client_test.go under its Go name, plus the request bytes
// against Go's own golden. Everything runs against a fake Bot API on node:http
// (Go's client_test.go:30-80), so nothing here touches the network or a real
// bot, and no test sleeps for a real deadline.
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
	type Client,
	createClient,
	isAborted,
	isConflict,
	isGroupChat,
	isTimeout,
	type SendMessage,
	TelegramApiError,
	TelegramError,
	TooLargeError,
} from "./client.ts";

/** Go's client_test.go token: shaped like a real one, worth nothing. */
const TOKEN = "123456789:AAFakeTokenForTestsOnly-abcdefghijk";

/** The request bodies the real Go client sent, by app/golden/t41/main.go. */
const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "requests.go.json"), "utf8")) as Record<
	string,
	string
>;

/** An item a test has already counted, without noUncheckedIndexedAccess in the way. */
function at<T>(list: T[], i: number): T {
	const value = list[i];
	if (value === undefined) throw new Error(`no element ${i} of ${list.length}`);
	return value;
}

// ---------- the fake Bot API ----------

interface Call {
	method: string;
	/** The body exactly as it arrived: the golden test compares these bytes. */
	raw: string;
	body: Record<string, unknown>;
}

interface Answer {
	status: number;
	body: string;
}

interface Fake {
	base: string;
	calls: Call[];
	/** A per-method answer; the default is Go's `{"ok":true,"result":true}`-shaped one. */
	reply: Map<string, (body: Record<string, unknown>) => Answer>;
	files: Map<string, Uint8Array>;
	last(): Call;
	close(): Promise<void>;
}

/**
 * fakeAPI is Go's client_test.go fake: paths /bot<token>/<method> and
 * /file/bot<token>/<path>, bodies recorded (raw and decoded), per-method
 * handlers, and a 401 for any other path (a wrong token included).
 */
async function fakeApi(): Promise<Fake> {
	const calls: Call[] = [];
	const reply: Fake["reply"] = new Map();
	const files: Fake["files"] = new Map();
	const stub = await origin((req, res) => {
		const path = req.url ?? "";
		const fileAt = path.startsWith(`/file/bot${TOKEN}/`) ? path.slice(`/file/bot${TOKEN}/`.length) : null;
		if (fileAt !== null) {
			const data = files.get(fileAt);
			if (data === undefined) {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200, { "Content-Length": String(data.length) });
			res.end(Buffer.from(data));
			return;
		}
		const method = path.startsWith(`/bot${TOKEN}/`) ? path.slice(`/bot${TOKEN}/`.length) : null;
		if (method === null) {
			res.writeHead(401);
			res.end(`{"ok":false,"error_code":401,"description":"Unauthorized"}`);
			return;
		}
		void read(req).then((raw) => {
			const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
			calls.push({ method, raw, body });
			const handler = reply.get(method);
			const answer = handler === undefined ? { status: 200, body: `{"ok":true,"result":null}` } : handler(body);
			res.writeHead(answer.status, { "Content-Type": "application/json" });
			res.end(answer.body);
		});
	});
	return {
		base: stub.base,
		calls,
		reply,
		files,
		last: () => {
			const last = calls[calls.length - 1];
			if (last === undefined) throw new Error("the client sent nothing");
			return last;
		},
		close: stub.close,
	};
}

/** The request body as text, once the whole thing has arrived. */
async function read(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

/** An HTTP server on a free port: `base` is its origin, `close` stops it. */
async function origin(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{
	base: string;
	close: () => Promise<void>;
}> {
	const server = createServer(handler);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

/** An origin whose port nothing listens on: Go's net.Listen then Close. */
async function closedPort(): Promise<string> {
	const server = createNetServer();
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	await new Promise<void>((resolve) => {
		server.close(() => resolve());
	});
	return `http://127.0.0.1:${address.port}`;
}

// ---------- Go's tests ----------

/** A pause for a test that asks what has not happened yet. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("TestGetUpdatesDecodesAndSendsOffset", () => {
	it("decodes three updates and sends the offset, the timeout and the allowed list", async () => {
		const fake = await fakeApi();
		try {
			fake.reply.set("getUpdates", () => ({
				status: 200,
				body: `{"ok":true,"result":[
				  {"update_id":10,"message":{"message_id":1,"from":{"id":111,"is_bot":false,"first_name":"ZY"},"chat":{"id":-1001,"type":"supergroup","title":"Reno"},"date":1,"text":"quartz for wet kitchen"}},
				  {"update_id":11,"callback_query":{"id":"cb1","from":{"id":222,"first_name":"P"},"message":{"message_id":2,"chat":{"id":-1001,"type":"supergroup"},"date":2},"data":"undo:01ABC"}},
				  {"update_id":12,"message":{"message_id":3,"from":{"id":111,"first_name":"ZY"},"chat":{"id":111,"type":"private"},"date":3,"document":{"file_id":"F1","file_unique_id":"U1","file_name":"E1 Electrical.pdf","mime_type":"application/pdf","file_size":2048}}}
				]}`,
			}));
			const c = createClient({ token: TOKEN, baseUrl: fake.base });
			const updates = await c.getUpdates(10, 1);
			expect(updates).toHaveLength(3);

			const first = at(updates, 0).message;
			expect(first?.text).toBe("quartz for wet kitchen");
			expect(first?.from?.id).toBe(111);
			expect(first?.chat.id).toBe(-1001);
			expect(first === undefined ? false : isGroupChat(first.chat)).toBe(true);

			const callback = at(updates, 1).callback_query;
			expect(callback?.data).toBe("undo:01ABC");
			expect(callback?.from.id).toBe(222);
			expect(callback?.message?.chat.id).toBe(-1001);

			const third = at(updates, 2).message;
			expect(third?.document?.file_name).toBe("E1 Electrical.pdf");
			expect(third?.document?.file_size).toBe(2048);
			// Only group and supergroup are groups: a private chat is not.
			expect(third === undefined ? true : isGroupChat(third.chat)).toBe(false);

			const body = fake.last().body;
			expect([body.offset, body.timeout]).toEqual([10, 1]);
			expect(body.allowed_updates).toEqual(["message", "callback_query"]);
		} finally {
			await fake.close();
		}
	});

	it("gives the long poll pollSeconds plus 15 s, not pollSeconds", async () => {
		// pollSeconds 0 is Go's 15 s deadline: a request the fake holds open is
		// still open after 50 ms. Without the headroom the deadline is 0 and the
		// call has already failed with TimeoutError.
		const hold: typeof fetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (signal === undefined || signal === null) return;
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		const controller = new AbortController();
		const poll = createClient({ token: TOKEN, baseUrl: "http://127.0.0.1:1", fetch: hold })
			.getUpdates(0, 0, controller.signal)
			.then(
				() => "answered",
				() => "failed",
			);
		const settled = await Promise.race([poll, sleep(50).then(() => "waiting")]);
		controller.abort();
		expect(settled).toBe("waiting");
		await poll;
	});
});

describe("TestSendMessageAndButtons", () => {
	it("sends the message, its keyboard, the toast and the other methods", async () => {
		const fake = await fakeApi();
		try {
			fake.reply.set("sendMessage", (body) => ({
				status: 200,
				body: JSON.stringify({
					ok: true,
					result: { message_id: 77, chat: { id: body.chat_id, type: "private" }, date: 1, text: body.text },
				}),
			}));
			const c: Client = createClient({ token: TOKEN, baseUrl: fake.base });
			const message: SendMessage = {
				chat_id: -1001,
				text: "Saved: wet kitchen · idea · Quartz top",
				reply_to_message_id: 5,
				reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: "undo:01ABC" }]] },
			};
			const sent = await c.sendMessage(message);
			expect(sent.message_id).toBe(77);

			const body = fake.last().body;
			expect([body.chat_id, body.reply_to_message_id]).toEqual([-1001, 5]);
			// Plain text only: no parse_mode, so nothing in the text needs escaping.
			expect(body.parse_mode).toBeUndefined();
			const keyboard = body.reply_markup as { inline_keyboard: Record<string, unknown>[][] };
			expect(at(at(keyboard.inline_keyboard, 0), 0)).toEqual({ text: "Undo", callback_data: "undo:01ABC" });

			await c.answerCallbackQuery("cb1", "Undone");
			expect(fake.last().body.text).toBe("Undone");

			await c.editMessageReplyMarkup(-1001, 77, null);
			const markup = fake.last().body.reply_markup as { inline_keyboard: unknown[] };
			expect(markup.inline_keyboard).toHaveLength(0);

			await c.sendChatAction(-1001);
			expect(fake.last().method).toBe("sendChatAction");

			await c.setMyCommands([{ command: "undo", description: "Undo my last change" }]);
			expect(fake.last().method).toBe("setMyCommands");
		} finally {
			await fake.close();
		}
	});
});

describe("TestAPIErrors", () => {
	it("falls back to the HTTP status when the answer carries no error_code", async () => {
		const fake = await fakeApi();
		try {
			// Go's `if ae.Code == 0 { ae.Code = resp.StatusCode }`.
			fake.reply.set("getMe", () => ({ status: 404, body: `{"ok":false,"description":"Not Found"}` }));
			const err = await createClient({ token: TOKEN, baseUrl: fake.base })
				.getMe()
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(TelegramApiError);
			expect((err as TelegramApiError).code).toBe(404);
			expect((err as TelegramApiError).retryAfter).toBe(0);
			expect((err as Error).message).toBe("telegram getMe: 404 Not Found");
		} finally {
			await fake.close();
		}
	});

	it("maps 409, 429 with retry_after, 400 and a wrong token's 401", async () => {
		const fake = await fakeApi();
		try {
			fake.reply.set("getUpdates", () => ({
				status: 409,
				body: `{"ok":false,"error_code":409,"description":"Conflict: terminated by other getUpdates request; make sure that only one bot instance is running"}`,
			}));
			fake.reply.set("sendMessage", () => ({
				status: 429,
				body: `{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}`,
			}));
			fake.reply.set("getMe", () => ({
				status: 400,
				body: `{"ok":false,"error_code":400,"description":"Bad Request: group chat was upgraded to a supergroup chat","parameters":{"migrate_to_chat_id":-1009}}`,
			}));
			const c = createClient({ token: TOKEN, baseUrl: fake.base });

			const conflict = await c.getUpdates(0, 1).catch((err: unknown) => err);
			expect(isConflict(conflict)).toBe(true);
			expect((conflict as Error).message).toBe(
				"telegram getUpdates: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running",
			);

			const throttled = await c.sendMessage({ chat_id: 1, text: "x" }).catch((err: unknown) => err);
			expect(throttled).toBeInstanceOf(TelegramApiError);
			expect((throttled as TelegramApiError).code).toBe(429);
			expect((throttled as TelegramApiError).retryAfter).toBe(7);
			expect(isConflict(throttled)).toBe(false);

			const upgraded = await c.getMe().catch((err: unknown) => err);
			expect((upgraded as TelegramApiError).code).toBe(400);

			// A wrong token is just another API error.
			const wrong = createClient({ token: "999:wrong", baseUrl: fake.base });
			const refused = await wrong.getMe().catch((err: unknown) => err);
			expect((refused as TelegramApiError).code).toBe(401);
		} finally {
			await fake.close();
		}
	});
});

describe("TestTokenNeverInErrors", () => {
	it("leaks no part of the token through message, stack, String, inspect or any cause", async () => {
		const dead = await closedPort();
		const slow = await origin((_req, res) => {
			const hold = setTimeout(() => res.end(`{"ok":true,"result":null}`), 3000);
			hold.unref();
		});
		const html = await origin((req, res) => {
			res.writeHead(502);
			res.end(`<html>bad gateway for ${req.url ?? ""}</html>`);
		});
		const badResult = await origin((_req, res) => {
			res.end(`{"ok":true,"result":"not a user"}`);
		});
		// An answer that echoes the token back in its description, which Go scrubs too.
		const echoed = await origin((_req, res) => {
			res.end(`{"ok":false,"error_code":400,"description":"Bad Request: ${TOKEN} is not a valid token"}`);
		});
		const client = (baseUrl: string): Client => createClient({ token: TOKEN, baseUrl });

		// Each case answers the error it got, as Go's cases return err.
		const cases: Record<string, () => Promise<unknown>> = {
			// A port nothing listens on.
			refused: async () =>
				await client(dead)
					.getMe()
					.catch((e: unknown) => e),
			// The caller's own deadline, which must stay readable after the scrub.
			timeout: async () => {
				const err = await client(slow.base)
					.getMe(AbortSignal.timeout(100))
					.catch((e: unknown) => e);
				expect(isTimeout(err)).toBe(true);
				return err;
			},
			// A proxy's HTML error page, which quotes the request path.
			"non-json": async () =>
				await client(html.base)
					.getMe()
					.catch((e: unknown) => e),
			"bad result": async () =>
				await client(badResult.base)
					.getMe()
					.catch((e: unknown) => e),
			"download refused": async () =>
				await client(dead)
					.download("documents/x.pdf")
					.catch((e: unknown) => e),
			"download 404": async () =>
				await client(html.base)
					.download("documents/x.pdf")
					.catch((e: unknown) => e),
			"description echoed": async () =>
				await client(echoed.base)
					.getMe()
					.catch((e: unknown) => e),
		};
		try {
			for (const [name, run] of Object.entries(cases)) {
				const err = await run();
				expect(err, `${name}: want an error`).toBeInstanceOf(Error);
				expect(causesOf(err), `${name}: no cause chain, which quotes the URL`).toEqual([]);
				expect(leaked(err), `${name}: ${inspect(err, { depth: 10 })}`).toEqual([]);
			}
		} finally {
			await slow.close();
			await html.close();
			await badResult.close();
			await echoed.close();
		}
	});

	it("keeps the kind of ending: an abort and a deadline name themselves after the scrub", async () => {
		// No headers, so the fetch itself is aborted.
		const held = await origin((_req, res) => {
			const hold = setTimeout(() => res.end(`{"ok":true,"result":null}`), 3000);
			hold.unref();
		});
		// Headers and half an answer, then nothing: the deadline fires during the read.
		const half = await origin((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.write(`{"ok":true,"result":`);
			const hold = setTimeout(() => res.end("null}"), 3000);
			hold.unref();
		});
		try {
			const controller = new AbortController();
			const call = createClient({ token: TOKEN, baseUrl: held.base }).getMe(controller.signal);
			setTimeout(() => controller.abort(), 50);
			const aborted = await call.catch((e: unknown) => e);
			expect(isAborted(aborted)).toBe(true);
			expect(isTimeout(aborted)).toBe(false);
			expect(aborted).toBeInstanceOf(TelegramError);
			expect(leaked(aborted)).toEqual([]);

			const late = await createClient({ token: TOKEN, baseUrl: half.base })
				.getMe(AbortSignal.timeout(100))
				.catch((e: unknown) => e);
			expect(isTimeout(late)).toBe(true);
			expect(leaked(late)).toEqual([]);
		} finally {
			await held.close();
			await half.close();
		}
	});
});

describe("TestGetFileAndDownload", () => {
	it("returns the file's path and bytes, and refuses one over the declared limit", async () => {
		const fake = await fakeApi();
		try {
			const bytes = new TextEncoder().encode("%PDF-1.7 fake");
			fake.files.set("documents/file_3.pdf", bytes);
			fake.reply.set("getFile", (body) => ({
				status: 200,
				body: JSON.stringify({
					ok: true,
					result: { file_id: body.file_id, file_size: bytes.length, file_path: "documents/file_3.pdf" },
				}),
			}));
			const c = createClient({ token: TOKEN, baseUrl: fake.base });
			const file = await c.getFile("F1");
			expect(file.file_path).toBe("documents/file_3.pdf");

			const data = await c.download(file.file_path);
			expect(new TextDecoder().decode(data)).toBe("%PDF-1.7 fake");

			// The fake declares the length, so this is Go's Content-Length check.
			const small = createClient({ token: TOKEN, baseUrl: fake.base, maxDownload: 5 });
			const err = await small.download(file.file_path).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(TooLargeError);
			expect((err as Error).message).toBe("file is larger than the download limit");
		} finally {
			await fake.close();
		}
	});

	it("refuses a stream over the limit on the read, when no Content-Length says so", async () => {
		// A Response this size sends no Content-Length: only the read can catch it.
		const streamed: typeof fetch = async () => new Response(new Uint8Array(13), { status: 200 });
		const c = createClient({ token: TOKEN, baseUrl: "http://127.0.0.1:1", fetch: streamed, maxDownload: 5 });
		const err = await c.download("documents/file_3.pdf").catch((e: unknown) => e);
		expect(err).toBeInstanceOf(TooLargeError);
		expect((err as Error).message).toBe("file is larger than the download limit");
	});
});

describe("TestScrubControl", () => {
	it("shows what does quote the token, so the leak test is meaningful", async () => {
		// Node's transport error for the same URL is `TypeError: fetch failed` with
		// the URL nowhere in it (only the host and port are in the cause), where
		// Go's net/http error quotes the URL: this is why the client rebuilds every
		// failure instead of wrapping one. Two of Node's own errors for that URL do
		// quote it in full, and those are what the scrub is up against.
		const url = `http://127.0.0.1:1/bot${TOKEN}/getMe`;
		const unparseable = `not a url /bot${TOKEN}/getMe`;

		const parseFailure = await fetch(unparseable).catch((err: unknown) => err);
		expect((parseFailure as Error).message).toContain(TOKEN);

		let urlFailure: unknown;
		try {
			new URL(`http://127.0.0.1:99999999/bot${TOKEN}/getMe`);
		} catch (err) {
			urlFailure = err;
		}
		expect(inspect(urlFailure, { depth: 10 })).toContain(TOKEN);

		// And the transport failure of the real URL, for the record: no token.
		const transport = await fetch(url, { method: "POST" }).catch((err: unknown) => err);
		expect(inspect(transport, { depth: 10 })).not.toContain(TOKEN);
	});
});

// ---------- the bytes Go sends ----------

describe("request bodies", () => {
	it("sends Go's exact bytes for every method", async () => {
		const fake = await fakeApi();
		try {
			const c = createClient({ token: TOKEN, baseUrl: fake.base });
			await c.getUpdates(10, 1);
			await c.getMe();
			await c.sendMessage({
				chat_id: -1001,
				text: "Saved: wet kitchen · idea · Quartz top",
				reply_to_message_id: 5,
				reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: "undo:01ABC" }]] },
			});
			await c.sendMessage({ chat_id: 111, text: `plain "quotes" & <angle> brackets` });
			await c.sendChatAction(-1001);
			await c.answerCallbackQuery("cb1", "Undone: removed Fluted glass door");
			await c.answerCallbackQuery("cb1");
			await c.editMessageReplyMarkup(-1001, 77, {
				inline_keyboard: [
					[{ text: "Undo", callback_data: "undo:01ABC" }],
					[{ text: "Undo 2", callback_data: "undo:0DEF" }],
				],
			});
			await c.editMessageReplyMarkup(-1001, 77, null);
			await c.setMyCommands([
				{ command: "undo", description: "Undo my last change" },
				{ command: "help", description: "What I can do" },
			]);
			await c.getFile("F1");

			const names = [
				"getUpdates",
				"getMe",
				"sendMessage",
				"sendMessagePlain",
				"sendChatAction",
				"answerCallbackQuery",
				"answerCallbackQueryNoText",
				"editMessageReplyMarkup",
				"editMessageReplyMarkupNil",
				"setMyCommands",
				"getFile",
			];
			expect(fake.calls.map((call) => call.method)).toEqual([
				"getUpdates",
				"getMe",
				"sendMessage",
				"sendMessage",
				"sendChatAction",
				"answerCallbackQuery",
				"answerCallbackQuery",
				"editMessageReplyMarkup",
				"editMessageReplyMarkup",
				"setMyCommands",
				"getFile",
			]);
			// One request per call: no retries in the client (spec §1.5).
			expect(fake.calls).toHaveLength(names.length);
			for (const [i, name] of names.entries()) {
				const expected = GOLDEN[name] ?? `<the golden has no ${name}>`;
				expect(at(fake.calls, i).raw, name).toBe(expected);
			}
		} finally {
			await fake.close();
		}
	});
});

describe("the answer body", () => {
	it("reads one JSON value and only 8 MiB of it", async () => {
		// Go's json.Decoder reads the first value and ignores what follows it.
		const trailing: typeof fetch = async () =>
			new Response(`{"ok":true,"result":{"id":111,"is_bot":true,"first_name":"bot"}} and then garbage`, {
				status: 200,
			});
		const me = await createClient({ token: TOKEN, baseUrl: "http://127.0.0.1:1", fetch: trailing }).getMe();
		expect([me.id, me.is_bot, me.first_name]).toEqual([111, true, "bot"]);

		// A value that runs past the limit is cut, so the answer is unreadable
		// (Go's io.LimitReader(8<<20)) rather than silently half-read.
		const long = `{"ok":true,"result":"${"x".repeat(9 << 20)}"}`;
		const cut: typeof fetch = async () => new Response(long, { status: 200 });
		const err = await createClient({ token: TOKEN, baseUrl: "http://127.0.0.1:1", fetch: cut })
			.getMe()
			.catch((e: unknown) => e);
		expect((err as Error).message).toMatch(/^telegram getMe: HTTP 200, unreadable answer: /);
		expect(leaked(err)).toEqual([]);
	});
});

// ---------- the leak check ----------

/**
 * Every text an error can be read through: its message, its stack, String(err),
 * what util.inspect shows at depth 10, and the same for every cause in the
 * chain. Go's TestTokenNeverInErrors walks %v, %+v, %#v and every Unwrap level;
 * these are the four ways a JavaScript caller sees an error.
 */
function textsOf(err: unknown): string[] {
	const texts: string[] = [];
	let value: unknown = err;
	for (let depth = 0; value !== undefined && value !== null && depth < 10; depth++) {
		texts.push(String(value), inspect(value, { depth: 10 }));
		if (value instanceof Error) texts.push(value.message, value.stack ?? "");
		value = value instanceof Error ? value.cause : undefined;
	}
	return texts;
}

/** The token and every substring of it 8 characters or longer (Go checks it and `AAFakeToken`). */
function needles(token: string): string[] {
	const out: string[] = [];
	for (let length = 8; length <= token.length; length++) {
		for (let start = 0; start + length <= token.length; start++) out.push(token.slice(start, start + length));
	}
	return out;
}

/** Every piece of the token that one of the error's texts carries: none, in a passing test. */
function leaked(err: unknown): string[] {
	const texts = textsOf(err);
	return needles(TOKEN).filter((needle) => texts.some((text) => text.includes(needle)));
}

/**
 * Every cause in the chain. Go's scrubbedError cannot keep one: the error it came
 * from quotes the URL, so the token would ride along with it.
 */
function causesOf(err: unknown): unknown[] {
	const causes: unknown[] = [];
	let value: unknown = err;
	while (value instanceof Error && value.cause !== undefined) {
		causes.push(value.cause);
		value = value.cause;
	}
	return causes;
}
