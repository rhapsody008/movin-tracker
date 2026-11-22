// A fake Bot API on node:http for the bot's tests (T4.1's client.test.ts and
// Go's `fakeTG`, bot_test.go:30-180): the paths `/bot<token>/<method>`, the
// bodies decoded, one handler per method, and every call recorded in the order
// it arrived.
//
// It models the one Telegram behaviour the ledger depends on: an update stays
// deliverable until a `getUpdates` with a **higher** offset confirms it, so a
// crash before the accept commit really does get the batch again — and
// `redeliver` hands an update out whatever the offset, which is what a restored
// cursor, or a duplicate in a second batch, looks like from here.
//
// Nothing reaches the network: it listens on 127.0.0.1 and port 0.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update } from "./client.ts";

/** One request as the fake saw it: the method after `/bot<token>/`, and its body. */
export interface ApiCall {
	method: string;
	body: Record<string, unknown>;
}

/** One message the bot sent, the fields the tests read. */
export interface SentMessage {
	chatId: number;
	text: string;
	/** 0 when the request carried no reply_to_message_id. */
	replyTo: number;
	/** Every button of every row, flattened. */
	buttons: InlineKeyboardButton[];
	markup: InlineKeyboardMarkup | null;
}

/** The bot's default token in the tests; the fake accepts any, and never logs one. */
export const FAKE_TOKEN = "AAFakeTokenForTests";

export interface FakeBotApi {
	/** The base URL a client points at. */
	url: string;
	/** Every call, in order. */
	calls: ApiCall[];
	/** The offsets the polls that answered were made with, in order. */
	offsets: number[];
	/** The ids Telegram still holds unconfirmed: a higher offset takes them away. */
	pendingIds: () => number[];
	sent: SentMessage[];
	answers: { id: string; text: string }[];
	edits: { chatId: number; messageId: number; markup: InlineKeyboardMarkup | null }[];
	/** The chats a "typing…" action went to, in order (one per call). */
	actions: number[];
	/** The menu setMyCommands registered, one list per call. */
	menus: BotCommand[][];
	/** Queue updates: Telegram hands them out, and keeps them until confirmed. */
	push: (...updates: Update[]) => void;
	/** Hand an update out again whatever the offset: a redelivery. */
	redeliver: (update: Update) => void;
	/** Answer the next n getUpdates with 409, as a second poller would. */
	conflict: (n: number) => void;
	/** Answer the next n getUpdates with 429 flood control, waiting retryAfter seconds. */
	flood: (n: number, retryAfter: number) => void;
	/** Answer the next n sendMessage calls with an error. */
	failSend: (n: number, code?: number) => void;
	/** Answer the next n getMe calls with an error, as Telegram does when it is down. */
	failGetMe: (n: number) => void;
	/**
	 * Resolves once no getUpdates request is in flight: a long poll the client gave up
	 * on is still finishing on the server when the bot has already stopped, and a test
	 * that counts or captures polls has to know that chapter is closed (T4 fixes m1).
	 */
	pollsIdle: () => Promise<void>;
	/** Resolves when at least n messages were sent (Go's fakeTG.waitSent). */
	waitSent: (n: number, what?: string) => Promise<SentMessage[]>;
	/** Resolves when at least n calls of a method arrived. */
	waitCalls: (method: string, n: number) => Promise<ApiCall[]>;
	close: () => Promise<void>;
}

/** How long a getUpdates may be held before an empty answer; short, because tests wait on it. */
const POLL_HOLD_MS = 250;

/** How long waitSent/waitCalls wait before they give up. */
const WAIT_MS = 5_000;

export async function startFakeBotApi(o: { username?: string; pollHoldMs?: number } = {}): Promise<FakeBotApi> {
	const username = o.username ?? "movin_test_bot";
	const pollHoldMs = o.pollHoldMs ?? POLL_HOLD_MS;
	const calls: ApiCall[] = [];
	const offsets: number[] = [];
	const sent: SentMessage[] = [];
	const answers: { id: string; text: string }[] = [];
	const edits: { chatId: number; messageId: number; markup: InlineKeyboardMarkup | null }[] = [];
	const actions: number[] = [];
	const menus: BotCommand[][] = [];

	/** What Telegram still holds: delivered but not confirmed by a higher offset. */
	let pending: Update[] = [];
	/** Updates handed out whatever the offset: a redelivery. */
	let forced: Update[] = [];
	let conflicts = 0;
	let floods = 0;
	let floodAfter = 0;
	let failing = 0;
	let failCode = 502;
	let failingGetMe = 0;
	let inFlightPolls = 0;
	let nextId = 1;
	let messageId = 1_000;
	let closing = false;
	const waiters = new Set<() => void>();

	function wake(): void {
		for (const waiter of waiters) waiter();
		waiters.clear();
	}

	/** held waits for a push, or for the poll window to close. */
	function held(deadline: number): Promise<void> {
		return new Promise((done) => {
			const finish = (): void => {
				clearTimeout(timer);
				waiters.delete(finish);
				done();
			};
			const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
			waiters.add(finish);
		});
	}

	/**
	 * getUpdates hands out what Telegram holds, and holds the request open when
	 * there is nothing — until a push wakes it, the poll window closes, or the
	 * caller's socket goes away (an aborted long poll). A request whose client
	 * has gone must not confirm or consume anything.
	 */
	async function getUpdates(offset: number, gone: () => boolean): Promise<Update[]> {
		inFlightPolls++;
		try {
			return await heldUpdates(offset, gone);
		} finally {
			inFlightPolls--;
			wake();
		}
	}

	/** heldUpdates is the poll itself: what `getUpdates` answers, once the counter is up. */
	async function heldUpdates(offset: number, gone: () => boolean): Promise<Update[]> {
		const deadline = Date.now() + pollHoldMs;
		for (;;) {
			if (gone()) return [];
			if (conflicts > 0) {
				conflicts--;
				throw {
					status: 409,
					body: { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request" },
				};
			}
			if (floods > 0) {
				floods--;
				throw {
					status: 429,
					body: {
						ok: false,
						error_code: 429,
						description: "Too Many Requests: retry later",
						parameters: { retry_after: floodAfter },
					},
				};
			}
			const handed = [...pending.filter((update) => update.update_id >= offset), ...forced];
			forced = [];
			if (handed.length > 0 || Date.now() >= deadline || closing) {
				// Recorded only now, by a poll that really answered: a request the client
				// gave up on says nothing about what the bot asked for, and its offset
				// arriving late is what made the reset-guard case flake (M5).
				if (!gone()) offsets.push(offset);
				// Confirmed: what is below the offset is gone from Telegram for good.
				pending = pending.filter((update) => update.update_id >= offset);
				return handed.sort((a, b) => a.update_id - b.update_id);
			}
			await held(deadline);
		}
	}

	function sendMessage(body: Record<string, unknown>): unknown {
		const markup = (body.reply_markup ?? null) as InlineKeyboardMarkup | null;
		sent.push({
			chatId: Number(body.chat_id ?? 0),
			text: String(body.text ?? ""),
			replyTo: Number(body.reply_to_message_id ?? 0),
			buttons: (markup?.inline_keyboard ?? []).flat(),
			markup,
		});
		messageId++;
		return { message_id: messageId, chat: { id: body.chat_id, type: "private" }, date: 1, text: body.text };
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		// A long poll the client gave up on: the response closes with nothing sent,
		// and that request must not consume or confirm an update.
		let gone = false;
		res.on("close", () => {
			if (!res.writableEnded) gone = true;
			wake();
		});
		const raw = await readBody(req);
		const path = (req.url ?? "").split("?")[0] ?? "";
		const method = /^\/bot[^/]+\/(\w+)$/.exec(path)?.[1] ?? "";
		let body: Record<string, unknown> = {};
		try {
			const value: unknown = raw === "" ? {} : JSON.parse(raw);
			if (typeof value === "object" && value !== null && !Array.isArray(value)) body = value as Record<string, unknown>;
		} catch {
			body = {};
		}
		calls.push({ method, body });
		try {
			let answer: unknown;
			switch (method) {
				case "getMe":
					if (failingGetMe > 0) {
						failingGetMe--;
						reply(res, 502, { ok: false, error_code: 502, description: "Bad Gateway" });
						return;
					}
					answer = { id: 999, is_bot: true, first_name: "Movin", username };
					break;
				case "getUpdates":
					answer = await getUpdates(Number(body.offset ?? 0), () => gone);
					break;
				case "sendMessage":
					if (failing > 0) {
						failing--;
						reply(res, failCode, {
							ok: false,
							error_code: failCode,
							description: failCode === 429 ? "Too Many Requests: retry later" : "Bad Gateway",
							...(failCode === 429 ? { parameters: { retry_after: 3 } } : {}),
						});
						return;
					}
					answer = sendMessage(body);
					break;
				case "answerCallbackQuery":
					answers.push({ id: String(body.callback_query_id ?? ""), text: String(body.text ?? "") });
					answer = true;
					break;
				case "editMessageReplyMarkup":
					edits.push({
						chatId: Number(body.chat_id ?? 0),
						messageId: Number(body.message_id ?? 0),
						markup: (body.reply_markup ?? null) as InlineKeyboardMarkup | null,
					});
					answer = true;
					break;
				case "sendChatAction":
					actions.push(Number(body.chat_id ?? 0));
					answer = true;
					break;
				case "setMyCommands":
					menus.push((body.commands ?? []) as BotCommand[]);
					answer = true;
					break;
				default:
					reply(res, 401, { ok: false, error_code: 401, description: "Unauthorized", result: null });
					return;
			}
			reply(res, 200, { ok: true, result: answer });
		} catch (err) {
			const failure = err as { status?: number; body?: unknown };
			reply(res, failure.status ?? 500, failure.body ?? { ok: false, error_code: 500, description: "fake failure" });
		}
	}

	const server: Server = createServer((req, res) => {
		void handle(req, res);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${port}`,
		calls,
		offsets,
		pendingIds: () => pending.map((update) => update.update_id),
		sent,
		answers,
		edits,
		actions,
		menus,
		push: (...updates: Update[]): void => {
			for (const update of updates) {
				const kept = update.update_id === 0 ? { ...update, update_id: nextId++ } : update;
				pending.push(kept);
			}
			wake();
		},
		redeliver: (update: Update): void => {
			forced.push(update);
			wake();
		},
		conflict: (n: number): void => {
			conflicts = n;
			wake();
		},
		flood: (n: number, retryAfter: number): void => {
			floods = n;
			floodAfter = retryAfter;
			wake();
		},
		failSend: (n: number, code = 502): void => {
			failing = n;
			failCode = code;
		},
		failGetMe: (n: number): void => {
			failingGetMe = n;
		},
		pollsIdle: async (): Promise<void> => {
			await waitUntil(() => inFlightPolls === 0, "the in-flight getUpdates to finish");
		},
		waitSent: async (n: number, what = `${n} sent messages`): Promise<SentMessage[]> => {
			await waitUntil(() => sent.length >= n, what);
			return [...sent];
		},
		waitCalls: async (method: string, n: number): Promise<ApiCall[]> => {
			await waitUntil(() => calls.filter((call) => call.method === method).length >= n, `${n} ${method} calls`);
			return calls.filter((call) => call.method === method);
		},
		close: async (): Promise<void> => {
			closing = true;
			wake();
			// A keep-alive connection would otherwise hold close() open for the whole
			// client's idle timeout.
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		},
	};

	async function waitUntil(predicate: () => boolean, what: string): Promise<void> {
		const deadline = Date.now() + WAIT_MS;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await new Promise((done) => setTimeout(done, 10));
		}
		throw new Error(`waited for ${what}`);
	}
}

function reply(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}
