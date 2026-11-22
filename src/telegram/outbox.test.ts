// The outbox the adapter's delivery task sends through (src/telegram/outbox.ts):
// one part is one sendMessage, and a failure is what decides the retry — Go's
// `retry_after` for a 429, permanent for any other 4xx, transient otherwise
// (T4 plan change; bot.go:596-613's error path is the lastError it sets).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OutboxError } from "../durable/adapter.ts";
import { createTestLog } from "../log.ts";
import { createBotState } from "./bot.ts";
import { createClient, TelegramApiError } from "./client.ts";
import { FAKE_TOKEN, type FakeBotApi, startFakeBotApi } from "./fake-api.ts";
import { createOutbox, failureOf, replyPart } from "./outbox.ts";

const ADDRESS = { chat: 111, messageId: 1, group: false };

const apis: FakeBotApi[] = [];
const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
	for (const api of apis.splice(0)) await api.close();
	for (const server of servers.splice(0)) await server.close();
});

async function fakeApi(): Promise<FakeBotApi> {
	const api = await startFakeBotApi();
	apis.push(api);
	return api;
}

/** openOutbox is one outbox over one fake Bot API, with the status it reports into. */
function openOutbox(api: FakeBotApi): {
	outbox: ReturnType<typeof createOutbox>;
	state: ReturnType<typeof createBotState>;
	lines: string[];
} {
	const { log, lines } = createTestLog();
	const state = createBotState(true);
	const client = createClient({ token: FAKE_TOKEN, baseUrl: api.url });
	const now = (): Date => new Date("2026-11-22T10:00:00Z");
	return { outbox: createOutbox({ client, log, state, now }), state, lines };
}

/** sent is one message the delivery task would hand to `send`. */
const sent = (text: string) => replyPart({ chat_id: 111, text });

describe("the outbox", () => {
	it("sends one part as one sendMessage, and the address is not needed for it", async () => {
		const api = await fakeApi();
		const { outbox, state } = openOutbox(api);
		await outbox.send(ADDRESS, sent("hello there"));

		expect(api.calls.map((call) => call.method)).toEqual(["sendMessage"]);
		expect(api.sent).toEqual([{ chatId: 111, text: "hello there", replyTo: 0, buttons: [], markup: null }]);
		expect(state.lastError).toBe("");
	});

	it("waits Telegram's retry_after on a 429, and never calls it permanent", async () => {
		const api = await fakeApi();
		api.failSend(1, 429);
		const { outbox, state, lines } = openOutbox(api);

		const failure = await outbox.send(ADDRESS, sent("x")).catch((err: unknown) => err);
		expect(failure).toBeInstanceOf(OutboxError);
		if (!(failure instanceof OutboxError)) throw new Error("not an OutboxError");
		// The fake answers retry_after 3, and the delivery task adds its own margin.
		expect(failure.retryAfterMs).toBe(3_000);
		expect(failure.permanent).toBeUndefined();
		// Go's sendMessage failure line, and the error as the admin page shows it.
		expect(state.lastError).toBe("telegram sendMessage: 429 Too Many Requests: retry later");
		expect(state.lastErrorAt).toEqual(new Date("2026-11-22T10:00:00Z"));
		expect(lines.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ level: "WARN", msg: "telegram sendMessage failed", chatId: 111 }),
		]);
	});

	it("gives up on any other 4xx, which no retry can fix", () => {
		// A blocked bot and a malformed request: retrying changes nothing.
		expect(
			failureOf(new TelegramApiError("sendMessage", 403, "Forbidden: bot was blocked by the user", 0)),
		).toMatchObject({
			permanent: true,
		});
		expect(failureOf(new TelegramApiError("sendMessage", 400, "Bad Request: message is empty", 0))).toMatchObject({
			permanent: true,
		});
	});

	it("keeps a 5xx and a transport failure as worth another attempt", async () => {
		const api = await fakeApi();
		api.failSend(1, 502);
		const { outbox } = openOutbox(api);
		const failure = await outbox.send(ADDRESS, sent("x")).catch((err: unknown) => err);
		if (!(failure instanceof OutboxError)) throw new Error("not an OutboxError");
		expect(failure.permanent).toBeUndefined();
		expect(failure.retryAfterMs).toBeUndefined();

		// A closed port is Go's transport error: transient, and still no token in it.
		const closed = createServer();
		await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((done) => closed.close(() => done()));
		const { log } = createTestLog();
		const state = createBotState(true);
		const down = createOutbox({
			client: createClient({ token: FAKE_TOKEN, baseUrl: `http://127.0.0.1:${port}` }),
			log,
			state,
		});
		const lost = await down.send(ADDRESS, sent("x")).catch((err: unknown) => err);
		if (!(lost instanceof OutboxError)) throw new Error("not an OutboxError");
		expect(lost.permanent).toBeUndefined();
		expect(lost.message).toContain("telegram sendMessage:");
		expect(lost.message).not.toContain(FAKE_TOKEN);
		expect(state.lastError).not.toContain(FAKE_TOKEN);
	});
});
