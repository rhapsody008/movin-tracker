// The bot against a fake Bot API and a scripted LLM: Go's bot_test.go ported
// under its own names, and the cases the durable intake adds (duplicates, the
// watchdog across a reopen, the update-id reset, the second auth check, a
// command for another bot, the migration row, 429, and the status bytes).
//
// Nothing reaches the network: the Bot API is `fake-api.ts` on 127.0.0.1, and
// the LLM is a scripted SSE endpoint beside it, Go's stubLLM (bot_test.go:196-250)
// — it answers by the last message, can be slowed down to prove a chat's turns
// do not overlap, and can be told to never answer so a watchdog has something
// to stop.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptHooks, SILENT_REPLY } from "../agent/prompt.ts";
import { NO_CONNECTION_MESSAGE } from "../agent/reply.ts";
import { buildTools } from "../agent/tools.ts";
import { FakeConverter } from "../docs/convert/fake.ts";
import { createSyncer, type Syncer } from "../docs/sync.ts";
import { type Agent, openAgent, type ScheduleSpec, type Timer } from "../durable/adapter.ts";
import { type Change, cloneDoc, type Entry, type Patch } from "../entries/model.ts";
import { createEntriesService, type EntriesService } from "../entries/service.ts";
import { goMarshal } from "../gojson.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { createSettingsService, DEFAULTS, type LLM, type SettingsService } from "../settings/settings.ts";
import type { Telegram } from "../settings/telegram.ts";
import {
	CHECKIN_KEY,
	type CheckinService,
	type CheckinSettings,
	CheckinStore,
	createCheckin,
} from "../tasks/checkin.ts";
import { createDocsNotifier } from "../tasks/docsync.ts";
import {
	BOT_COMMANDS,
	type Bot,
	type BotState,
	checkinView,
	createBot,
	createBotState,
	statusJSON,
	UPDATE_ID_RESET_MS,
} from "./bot.ts";
import { type Chat, type Client, createClient, type Message, type Update, type User } from "./client.ts";
import { HELP_TEXT } from "./commands.ts";
import { FAKE_TOKEN, type FakeBotApi, startFakeBotApi } from "./fake-api.ts";
import { NON_TEXT_REPLY, THINK_HINT, TIMED_OUT_DETAIL } from "./format.ts";
import { createOutbox } from "./outbox.ts";

const ZY = 111;
const PARTNER = 222;
const STRANGER = 333;
const GROUP = -1001;
const OTHER_GROUP = -2002;

/** Go's env allowlist (bot_test.go:309-311): ZY and Partner, one group called Reno. */
const ALLOW: Telegram = {
	users: [
		{ id: `${ZY}`, name: "ZY" },
		{ id: `${PARTNER}`, name: "Partner" },
	],
	groups: [`${GROUP}`],
	fromEnv: true,
};

// ---------- the scripted LLM ----------

interface LlmRequest {
	messages: { role: string; content: unknown }[];
	kwargs: Record<string, unknown> | undefined;
}

interface LlmStub {
	/** The connection's base URL: `${origin}/v1`. */
	baseUrl: string;
	requests: LlmRequest[];
	/** How long each answer waits: the serialisation test orders turns with it. */
	delay: number;
	/** The most requests in flight at once since the last resetMax. */
	maxInFlight: number;
	resetMax: () => void;
	/** Answer nothing at all: the turn cannot finish, so only the watchdog ends it. */
	hang: boolean;
	/** Call a tool on every request, ignoring the forced answer, so a turn ends `turn_limit`. */
	toolLoop: boolean;
	close: () => Promise<void>;
}

/** startLlmStub is Go's stubLLM: the same three answers, plus a delay and a hang. */
async function startLlmStub(): Promise<LlmStub> {
	let inFlight = 0;
	const stub: LlmStub = {
		baseUrl: "",
		requests: [],
		delay: 0,
		maxInFlight: 0,
		resetMax: () => undefined,
		hang: false,
		toolLoop: false,
		close: async () => undefined,
	};
	const server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			void (async () => {
				inFlight++;
				stub.maxInFlight = Math.max(stub.maxInFlight, inFlight);
				try {
					const body = jsonObject(Buffer.concat(chunks).toString("utf8"));
					const messages = Array.isArray(body.messages) ? (body.messages as LlmRequest["messages"]) : [];
					const kwargs = body.chat_template_kwargs;
					stub.requests.push({
						messages,
						kwargs: typeof kwargs === "object" && kwargs !== null ? (kwargs as Record<string, unknown>) : undefined,
					});
					if (stub.delay > 0) await new Promise((done) => setTimeout(done, stub.delay));
					// A hanging answer keeps the request open until the socket is cut: the
					// watchdog is the only way out of such a turn.
					if (stub.hang) return;
					answer(res, messages.at(-1), stub.toolLoop);
				} finally {
					inFlight--;
				}
			})();
		});
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	stub.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
	stub.resetMax = () => {
		stub.maxInFlight = inFlight;
	};
	stub.close = async () => {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	};
	return stub;
}

/** answer is Go's script: a tool result says Saved., "record X" records X, "chat" keeps quiet. */
function answer(res: ServerResponse, last: LlmRequest["messages"][number] | undefined, loop = false): void {
	// A model that ignores the forced answer and calls a tool again for ever: the only
	// way this rig reaches pi-durable's `turn_limit` (its turn budget is four).
	if (loop) {
		sse(res, toolCallEvents("Kitchen"));
		return;
	}
	if (last?.role === "tool" || last?.role === "toolResult") {
		sse(res, textEvents("Saved."));
		return;
	}
	const content = typeof last?.content === "string" ? last.content : "";
	const at = content.indexOf("record ");
	if (at >= 0) {
		sse(res, toolCallEvents(content.slice(at + "record ".length)));
		return;
	}
	sse(res, textEvents(content.includes("chat") ? SILENT_REPLY : "ok"));
}

/** toolCallEvents is one `add_entry` call and its stop. */
function toolCallEvents(title: string): unknown[] {
	const args = JSON.stringify({ entries: [{ kind: "note", title }] });
	return [
		{
			choices: [
				{
					delta: {
						role: "assistant",
						tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "add_entry", arguments: args } }],
					},
				},
			],
		},
		{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
		"[DONE]",
	];
}

/** textEvents is one answer as two deltas and a stop, so a lost fragment is caught. */
function textEvents(text: string): unknown[] {
	const split = Math.floor(text.length / 2);
	const events: unknown[] = [];
	if (text !== "") {
		events.push({ choices: [{ delta: { role: "assistant", content: text.slice(0, split) } }] });
		events.push({ choices: [{ delta: { content: text.slice(split) } }] });
	}
	events.push({ choices: [{ delta: {}, finish_reason: "stop" }] });
	events.push("[DONE]");
	return events;
}

function sse(res: ServerResponse, events: readonly unknown[]): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of events) {
		res.write(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`);
	}
	res.end();
}

function jsonObject(raw: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return {};
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ---------- updates ----------

function person(id: number, first = "Zhou"): User {
	return { id, is_bot: false, first_name: first, last_name: "", username: "" };
}

function chat(id: number, type: string, title = ""): Chat {
	return { id, type, title, username: "", first_name: "" };
}

function message(id: number, from: User | undefined, c: Chat, text: string, extra: Partial<Message> = {}): Message {
	return {
		message_id: id,
		...(from === undefined ? {} : { from }),
		chat: c,
		date: 1,
		text,
		caption: "",
		photo: [],
		migrate_to_chat_id: 0,
		...extra,
	};
}

/**
 * private is Go's `private(from, first, text)`, except that Telegram's message ids
 * are per chat and never reused, and the bot's request id is built from one
 * (`tg:<chat>:<message_id>`, B2). Go's helper always sent message 1, which would
 * make every later message attach to the first turn here.
 */
const privateIds = new Map<number, number>();
function privateMessage(from: number, first: string, text: string, extra: Partial<Message> = {}): Update {
	const id = (privateIds.get(from) ?? 0) + 1;
	privateIds.set(from, id);
	return { update_id: 0, message: message(id, person(from, first), chat(from, "private"), text, extra) };
}

/** inGroup is Go's `inGroup`: a supergroup message with its own id, threaded by the reply. */
function groupMessage(chatId: number, from: number, first: string, text: string, messageId: number): Update {
	return { update_id: 0, message: message(messageId, person(from, first), chat(chatId, "supergroup", "Reno"), text) };
}

// ---------- the rig ----------

interface Env {
	api: FakeBotApi;
	llm: LlmStub;
	store: ObjectStore;
}

const rigs: Rig[] = [];
const dirs: string[] = [];
const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.close();
	for (const server of servers.splice(0)) await server.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** newEnv is one fake Bot API, one scripted LLM and a fresh in-memory bucket. */
async function newEnv(): Promise<Env> {
	const api = await startFakeBotApi();
	const llm = await startLlmStub();
	servers.push(api, llm);
	return { api, llm, store: createMemoryStore() };
}

/**
 * What a test can do to the ledger read the rebuild makes (`agent.intake.state()`):
 * fail it, or hold it open until the test lets go. The startup recovery has its own
 * switch (`failRecover`); this one is for the resync paths (R3-1, R3-2).
 */
interface LedgerControl {
	/** Fail this many further reads, then let them through. */
	failNext: (n: number) => void;
	/** Hold every read until `release()`; a rebuild in flight stays in flight. */
	hold: () => void;
	release: () => void;
}

interface Rig {
	env: Env;
	/** The update ids the bot handed to `intake.accept`, in order: a refusal must never be there. */
	accepted: number[];
	/** The item ids the bot settled successfully, in order: one entry per handled item. */
	settles: number[];
	/** The ledger reads the rebuild makes, on demand. */
	ledger: LedgerControl;
	client: Client;
	agent: Agent;
	bot: Bot;
	state: BotState;
	entries: EntriesService;
	settings: SettingsService;
	/** The morning check-in (T5.1c), or null when the rig has none. */
	checkin: CheckinService | null;
	/** Where its `checkin.json` lives: a store of its own, as Go's `scheduled` gave it. */
	checkinStore: ObjectStore;
	lines: string[];
	dbPath: string;
	/** Stands in for a shutdown: polling stops and the agent closes, and the file stays. */
	shutdown: () => Promise<void>;
	/** Closes the rig; the fake servers belong to the test's env and close after it. */
	close: () => Promise<void>;
}

interface RigOptions {
	dbPath?: string;
	/** The documents `/sync` re-reads: the real syncer over a fake converter, or none (the default). */
	syncer?: Syncer;
	allow?: Telegram;
	/** Overrides of the connection every turn resolves (the missing-connection case, M1). */
	llm?: Partial<LLM>;
	/**
	 * Update ids a second waker takes from the ledger just before the bot's own
	 * `take` runs, so the bot's take answers false (M2).
	 */
	stolen?: readonly number[];
	/** The ledger read `recover()` makes: this many times it throws, then it works (M4). */
	failRecover?: number;
	/**
	 * Item ids whose `settle` throws once, so a turn job fails after its run: the item
	 * is submitted and must stay durable, and the chat's worker must stop (M3).
	 */
	failSettle?: readonly number[];
	turnTimeoutMs?: number;
	conflictWaitMs?: number;
	pollSeconds?: number;
	now?: () => Date;
	/**
	 * The morning check-in (T5.1c): its `checkin.json` store, the settings it reads and
	 * the zone it reads its clock in. Giving it at all is what wires `/checkin` and the
	 * `ci:` buttons.
	 */
	checkin?: CheckinOptions;
	/**
	 * Give the agent the prompt of T3.4 (`promptHooks`): the pending note the check-in
	 * leaves reaches the model only through `userContent` (T5-plan §2.3). Off by
	 * default, so the other cases keep asserting on the bare message.
	 */
	prompt?: boolean;
	/** The scheduled jobs handed to `openAgent` (the check-in's spec is added when it is scheduled). */
	schedules?: readonly ScheduleSpec[];
	/** The harness's timer, for a test with a manual clock (the schedule's sleeps). */
	setTimer?: Timer;
	/**
	 * Another writer's edit, made inside `updateIf` before the write it precedes: what
	 * a web page saving while a button press is in flight looks like, and the only way
	 * to prove the check-in's precondition runs *inside* the write (T5.1c).
	 */
	raceEntries?: (inner: EntriesService) => Promise<void>;
}

/** What a rig's check-in is built from; every field has the production default. */
interface CheckinOptions {
	store?: ObjectStore;
	/** The settings the check-in reads: Go's `r.bot.Settings`, swappable in a test. */
	settings?: CheckinSettings;
	timeZone?: string;
	/**
	 * Hand its spec to the agent, so the harness ticks it (T5.1b). Off by default:
	 * Go's tests called `CheckinTick` by hand and never started `CheckinLoop`.
	 */
	scheduled?: boolean;
}

/** startRig opens the entries, the settings, the durable agent and the bot, and starts it polling. */
async function startRig(env: Env, o: RigOptions = {}): Promise<Rig> {
	let dbPath = o.dbPath;
	if (dbPath === undefined) {
		const dir = await mkdtemp(join(tmpdir(), "movin-t42b-"));
		dirs.push(dir);
		dbPath = join(dir, "harness.db");
	}
	const now = o.now ?? ((): Date => new Date());
	const { log, lines } = createTestLog();
	const plain = createEntriesService({ store: env.store, log, now });
	await plain.load();
	const race = o.raceEntries;
	const entries: EntriesService =
		race === undefined
			? plain
			: {
					...plain,
					updateIf: async (actor, id, check, patch, replay) => {
						// The other writer's edit lands after the caller's own read, before its write.
						await race(plain);
						return await plain.updateIf(actor, id, check, patch, replay);
					},
				};
	const settings = createSettingsService({
		store: env.store,
		log,
		env: { ...DEFAULTS, baseUrl: env.llm.baseUrl, model: "m", thinkOnDemand: true, maxToolRounds: 3, ...o.llm },
		telegramEnv: o.allow ?? ALLOW,
		now,
	});
	const client = createClient({ token: FAKE_TOKEN, baseUrl: env.api.url });
	const state = createBotState(true);
	const checkinStore = o.checkin?.store ?? createMemoryStore();
	/** The check-in's spec, handed to the agent only when the case wants the harness to tick it. */
	const scheduled: ScheduleSpec[] = [];
	const checkin =
		o.checkin === undefined
			? null
			: createCheckin({
					store: checkinStore,
					settings: o.checkin.settings ?? settings,
					entries,
					deliver: async (key, address, parts, options) => await agent.deliver(key, address, parts, options),
					now,
					timeZone: o.checkin.timeZone ?? "UTC",
					log,
				});
	if (checkin !== null && o.checkin?.scheduled === true) scheduled.push(checkin.spec);
	const agent = await openAgent({
		dbPath,
		settings,
		log,
		// One clock for the ledger's `acceptedAt` and the bot's status: the reset
		// guard compares the two.
		now: () => now().getTime(),
		tools: buildTools({ entries, docs: null, viewer: null }),
		outbox: createOutbox({ client, log, state, now }),
		...(o.setTimer === undefined ? {} : { setTimer: o.setTimer }),
		...(o.prompt === true
			? {
					hooks: promptHooks({ entries, docs: null, viewer: false, timeZone: "UTC", now, log }),
				}
			: {}),
		...((o.schedules ?? []).length === 0 && scheduled.length === 0
			? {}
			: { schedules: [...(o.schedules ?? []), ...scheduled] }),
	});
	// The wrapper records what is accepted, which no document kind can show: a
	// refused update must never reach the ledger (T4-plan §2.5, mutation 1). It also
	// stands in for the things only a second waker or a failing store can show: a
	// `take` that was already made elsewhere (M2), a ledger read that throws before
	// the bot starts polling (M4), a settlement that throws after the run (M3), and a
	// ledger read the rebuild cannot finish (R3-1, R3-2).
	const accepted: number[] = [];
	const settles: number[] = [];
	const stolen = new Set(o.stolen ?? []);
	const failingSettle = new Set(o.failSettle ?? []);
	let recoverFailures = o.failRecover ?? 0;
	let stateFailures = 0;
	let gate: Promise<void> | null = null;
	let openGate: () => void = () => undefined;
	const ledger: LedgerControl = {
		failNext: (n: number): void => {
			stateFailures = n;
		},
		hold: (): void => {
			gate = new Promise((done) => {
				openGate = done;
			});
		},
		release: (): void => {
			gate = null;
			openGate();
		},
	};
	const watched: Agent = {
		...agent,
		intake: {
			...agent.intake,
			accept: async (batch) => {
				accepted.push(...batch.items.map((item) => item.id));
				return await agent.intake.accept(batch);
			},
			state: async () => {
				if (recoverFailures > 0) {
					recoverFailures--;
					throw new Error("the ledger could not be read");
				}
				if (stateFailures > 0) {
					stateFailures--;
					throw new Error("the ledger could not be read");
				}
				const held = gate;
				if (held !== null) await held;
				return await agent.intake.state();
			},
			take: async (id) => {
				// The other waker takes it first, so the bot's own take finds nothing.
				if (stolen.delete(id)) await agent.intake.take(id);
				return await agent.intake.take(id);
			},
			settle: async (id, key, address, parts) => {
				// A settlement that fails after the run: the turn is over but the item is
				// still in the ledger, which is what a failing store looks like here.
				if (failingSettle.delete(id)) throw new Error("the settlement could not be stored");
				// Recorded only when it succeeded, so the sequence is exactly the items the
				// bot handled once each, in order (R3-2).
				settles.push(id);
				await agent.intake.settle(id, key, address, parts);
			},
		},
	};
	const bot = createBot({
		client,
		settings,
		agent: watched,
		entries,
		syncer: o.syncer ?? null,
		checkin,
		timeZone: "UTC",
		state,
		log,
		now,
		pollSeconds: o.pollSeconds ?? 1,
		conflictWaitMs: o.conflictWaitMs ?? 50,
		...(o.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: o.turnTimeoutMs }),
	});
	let closed = false;
	const shutdown = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		await bot.stop();
		await agent.close();
	};
	const rig: Rig = {
		env,
		accepted,
		settles,
		ledger,
		client,
		agent,
		bot,
		state,
		entries,
		settings,
		checkin,
		checkinStore,
		lines,
		dbPath,
		shutdown,
		close: shutdown,
	};
	rigs.push(rig);
	void bot.run();
	await until(() => state.running, "the bot to start");
	return rig;
}

/** until waits for a condition the bot reaches in the background. */
async function until(predicate: () => boolean, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((done) => setTimeout(done, 10));
	}
	throw new Error(`waited for ${what}`);
}

/** untilAsync is `until` for a condition only a read can answer (the ledger). */
async function untilAsync(predicate: () => Promise<boolean>, what: string, ms = 5_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((done) => setTimeout(done, 10));
	}
	throw new Error(`waited for ${what}`);
}

/** entriesOf reads the stored document. */
async function entriesOf(rig: Rig): Promise<{ title: string; by: string; channel: string }[]> {
	return (await rig.entries.current()).doc.entries;
}

// ---------- the ported tests ----------

describe("TestPrivateMessageSavesEntryAndUndoButtonWorks (the message half)", () => {
	it("answers privately, saves the entry under the configured name, and offers Undo", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		expect(rig.bot.status()).toMatchObject({
			tokenSet: true,
			running: true,
			botUsername: "movin_test_bot",
		});

		env.api.push(privateMessage(ZY, "Zhou", "record Fluted glass door"));
		const [sent] = await env.api.waitSent(1);
		if (sent === undefined) throw new Error("no reply");

		expect(sent.chatId).toBe(ZY);
		expect(sent.text).toContain("Saved.");
		expect(sent.text).toContain("• Saved: note · Fluted glass door");
		// A private chat is never threaded (bot_test.go:318).
		expect(sent.replyTo).toBe(0);
		expect(sent.buttons).toHaveLength(1);
		expect(sent.buttons[0]?.text).toBe("Undo");

		const stored = await entriesOf(rig);
		expect(stored).toMatchObject([{ title: "Fluted glass door", by: "ZY", channel: "telegram" }]);
		// The button undoes the journal record the write made (T4.4 presses it).
		const [change] = await rig.entries.recent(1);
		expect(sent.buttons[0]?.callback_data).toBe(`undo:${change?.id ?? ""}`);
	});
});

describe("TestAuthorisation", () => {
	it("answers only the allowed person in the allowed group and records three refusals", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(
			privateMessage(STRANGER, "Stranger", "record should not happen"),
			groupMessage(OTHER_GROUP, ZY, "Zhou", "record wrong group", 5),
			groupMessage(GROUP, STRANGER, "Stranger", "record stranger in group", 6),
			groupMessage(GROUP, PARTNER, "P", "record Lift booking", 7),
		);
		await env.api.waitSent(1);
		// Give any wrongly accepted message time to show up (bot_test.go:361).
		await new Promise((done) => setTimeout(done, 300));

		expect(env.api.sent).toHaveLength(1);
		expect(env.api.sent[0]).toMatchObject({ chatId: GROUP, replyTo: 7 });
		expect(await entriesOf(rig)).toMatchObject([{ title: "Lift booking", by: "Partner" }]);

		const rows = rig.state.rejected.map((row) => [`${row.chatId}/${row.fromId}`, row.reason]);
		// Only the allowed group message was accepted: the three refusals never reached
		// the ledger, because auth check 1 runs before the commit.
		expect(rig.accepted).toHaveLength(1);
		expect(Object.fromEntries(rows)).toEqual({
			[`${STRANGER}/${STRANGER}`]: "user not on the allowlist",
			[`${OTHER_GROUP}/${ZY}`]: "group not on the allowlist",
			[`${GROUP}/${STRANGER}`]: "user not on the allowlist",
		});
		expect(rig.lines.join("\n")).toContain('"msg":"telegram message ignored"');
	});

	it("records an update with no sender as fromId 0, and a bot's not at all", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(
			// Go's reject is called whenever `from == nil || !from.IsBot` (bot.go:309):
			// an update with no sender at all still leaves a row, with `fromId 0`.
			{ update_id: 0, message: message(8, undefined, chat(GROUP, "supergroup", "Reno"), "record no sender") },
			// A bot's update is refused with no row and no log line.
			{
				update_id: 0,
				message: message(9, { ...person(ZY, "Robot"), is_bot: true }, chat(ZY, "private"), "record from a bot"),
			},
		);
		await until(() => rig.state.rejected.length > 0, "the from-less row");
		await new Promise((done) => setTimeout(done, 300));

		expect(env.api.sent).toHaveLength(0);
		expect(rig.state.rejected).toHaveLength(1);
		expect(rig.state.rejected[0]).toMatchObject({ chatId: `${GROUP}`, chatTitle: "Reno", fromId: "0" });
		// Go's row keeps no `fromName` for a missing sender either (omitempty).
		expect(rig.state.rejected[0]?.fromName).toBeUndefined();
		expect(rig.state.rejected[0]?.reason).toBe("not from a person");
		// One log line, for the from-less update: the bot's wrote none.
		expect(linesWith(rig.lines, "telegram message ignored")).toHaveLength(1);
	});
});

describe("TestConflictBacksOffThenRecovers", () => {
	it("waits ConflictWait after a 409, then answers and keeps the error", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { conflictWaitMs: 300 });
		env.api.conflict(2);
		const started = Date.now();
		env.api.push(privateMessage(ZY, "Zhou", "record After conflict"));

		const [sent] = await env.api.waitSent(1);
		expect(sent?.text).toContain("After conflict");
		// Two 409s, each followed by the pause: the recovery is not a busy retry.
		expect(Date.now() - started).toBeGreaterThanOrEqual(2 * 300 - 50);
		expect(rig.state.lastError).toContain("409");
		expect(rig.lines.join("\n")).toContain("another poller");
	});
});

describe("TestBotWritesReachSubscribers", () => {
	it("pushes a snapshot for a bot write, so the web page updates", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		const snapshots: { title: string; channel: string }[][] = [];
		rig.entries.subscribe((snapshot) => {
			snapshots.push(snapshot.doc.entries.map((entry) => ({ title: entry.title, channel: entry.channel })));
		});

		env.api.push(privateMessage(PARTNER, "P", "record Sofa from Castlery"));
		await env.api.waitSent(1);
		await until(() => snapshots.length > 0, "the entries snapshot");
		expect(snapshots.at(-1)).toEqual([{ title: "Sofa from Castlery", channel: "telegram" }]);
	});
});

describe("TestOneChatIsSerialisedTwoChatsRunInParallel", () => {
	it("runs one chat's turns one at a time with the shared history, and two chats at once", async () => {
		const env = await newEnv();
		await startRig(env);
		env.llm.delay = 250;

		// Two people in the group at once: the second waits for the first.
		env.api.push(
			groupMessage(GROUP, ZY, "Zhou", "first thought", 10),
			groupMessage(GROUP, PARTNER, "P", "second thought", 11),
		);
		await env.api.waitSent(2);
		expect(env.llm.maxInFlight).toBe(1);

		// The second turn's request carries the first, with speakers (spec §4.4).
		const last = env.llm.requests.at(-1);
		const users = (last?.messages ?? [])
			.filter((message) => message.role === "user")
			.map((message) => String(message.content));
		expect(users.join(" | ")).toBe("ZY: first thought | Partner: second thought");

		// Two different chats may overlap.
		env.llm.resetMax();
		env.api.push(privateMessage(ZY, "Zhou", "private one"), privateMessage(PARTNER, "P", "private two"));
		await env.api.waitSent(4);
		expect(env.llm.maxInFlight).toBeGreaterThanOrEqual(2);
	});
});

describe("TestGroupChatterGetsNoReply", () => {
	it("sends nothing for chatter and one threaded reply for the question", async () => {
		const env = await newEnv();
		await startRig(env);
		env.api.push(
			groupMessage(GROUP, PARTNER, "P", "chat about dinner", 20),
			groupMessage(GROUP, ZY, "Zhou", "what's up?", 21),
		);
		await env.api.waitSent(1);
		await new Promise((done) => setTimeout(done, 200));

		expect(env.api.sent).toHaveLength(1);
		expect(env.api.sent[0]).toMatchObject({ replyTo: 21, text: "ok" });
	});
});

describe("TestAllowlistChangeAppliesWithoutRestart", () => {
	it("applies a saved allowlist at once, for the added and for the removed person", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(privateMessage(444, "Helper", "record too early"));
		await new Promise((done) => setTimeout(done, 400));
		expect(env.api.sent).toHaveLength(0);

		// A save through the admin page replaces the whole list.
		await rig.settings.saveTelegram("zy@example.com", {
			users: [
				{ id: "444", name: "Helper" },
				{ id: `${ZY}`, name: "ZY" },
			],
			groups: [],
			useEnv: false,
		});
		env.api.push(privateMessage(444, "Helper", "record Paint samples"));
		await env.api.waitSent(1);
		expect(await entriesOf(rig)).toMatchObject([{ title: "Paint samples", by: "Helper" }]);

		// Partner was dropped by that save and is refused right away.
		env.api.push(privateMessage(PARTNER, "P", "record dropped"));
		await new Promise((done) => setTimeout(done, 400));
		expect(env.api.sent).toHaveLength(1);
	});
});

describe("TestNonTextAndStatusHasNoToken", () => {
	it("answers a document once, writes nothing, and keeps the token out of the status and the log", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		const document: Partial<Message> = {
			document: { file_id: "F", file_unique_id: "U", file_name: "E1.pdf", mime_type: "", file_size: 1 },
		};
		env.api.push(privateMessage(ZY, "Zhou", "", document));
		const [sent] = await env.api.waitSent(1);
		await new Promise((done) => setTimeout(done, 200));

		expect(env.api.sent).toHaveLength(1);
		expect(sent?.text).toBe(NON_TEXT_REPLY);
		expect(await entriesOf(rig)).toHaveLength(0);
		expect(goMarshal(rig.bot.status())).not.toContain(FAKE_TOKEN);
		expect(rig.lines.join("\n")).not.toContain(FAKE_TOKEN);
	});
});

describe("TestThinkCommand", () => {
	it("thinks only for /think, strips the command, and answers a bare /think with the hint", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "hello"));
		await env.api.waitSent(1);
		env.api.push(privateMessage(ZY, "Zhou", "/think\nrecord Compare quotes"));
		await env.api.waitSent(2);
		env.api.push(privateMessage(ZY, "Zhou", "/think"));
		const sent = await env.api.waitSent(3);
		expect(sent[2]?.text).toBe(THINK_HINT);

		// hello: 1 request; /think record: tool round + answer = 2; the bare /think: none.
		expect(env.llm.requests.map((request) => request.kwargs?.enable_thinking)).toEqual([false, true, true]);
		const asked = env.llm.requests[1]?.messages.at(-1)?.content;
		// The model never sees the command (decisions.md:167).
		expect(asked).toBe("record Compare quotes");
		expect(await entriesOf(rig)).toMatchObject([{ title: "Compare quotes" }]);
	});

	it("treats /think@botname as /think, and a bare one as the hint", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		// A group's command menu sends the command with the bot's name attached
		// (commands.go:41-58): Go cuts the word at `@` and uses the rest.
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/think@movin_test_bot record Compare blinds", 60));
		await env.api.waitSent(1);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/think@movin_test_bot", 61));
		const sent = await env.api.waitSent(2);

		expect(sent[1]?.text).toBe(THINK_HINT);
		expect(sent[1]?.replyTo).toBe(61);
		// One thinking turn with the command gone, and no turn for the bare command.
		expect(env.llm.requests.map((request) => request.kwargs?.enable_thinking)).toEqual([true, true]);
		expect(env.llm.requests[0]?.messages.at(-1)?.content).toBe("ZY: record Compare blinds");
		expect(await entriesOf(rig)).toMatchObject([{ title: "Compare blinds" }]);
	});
});

describe("TestShutdownFinishesTakenTurns", () => {
	it("closes mid-turn and reopens: both updates are answered once and both entries saved", async () => {
		const env = await newEnv();
		const first = await startRig(env);
		// The model never answers, so the close provably cuts the turn short — that is
		// the `failed/closed` result `isUnsettled` is about.
		env.llm.hang = true;
		env.api.push(privateMessage(ZY, "Zhou", "record First"), privateMessage(ZY, "Zhou", "record Second"));
		// Both are polled and accepted by now; the first turn is inside its request.
		await until(() => env.llm.requests.length > 0, "the first turn");
		await first.shutdown();
		// Nothing was sent, and the chat's worker stopped instead of pushing the next
		// item into the closed session: that is what `isUnsettled` decides.
		expect(env.api.sent).toHaveLength(0);
		expect(first.lines.join("\n")).not.toContain("telegram handler panicked");

		// A restart: the open turn is attached and the queued message runs after it.
		env.llm.hang = false;
		const second = await startRig(env, { dbPath: first.dbPath });
		await env.api.waitSent(2);
		await until(() => env.llm.requests.length >= 3, "both recovered turns");

		const titles = (await entriesOf(second)).map((entry) => entry.title);
		expect(titles.sort()).toEqual(["First", "Second"]);
		// Exactly one reply each: no turn was answered twice.
		expect(env.api.sent).toHaveLength(2);
		expect(env.api.sent.map((sent) => sent.text.split("\n")[0])).toEqual(["Saved.", "Saved."]);
		expect(await second.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});
});

// ---------- the cases the durable intake adds ----------

describe("a duplicate update", () => {
	it("is one turn and one reply when it arrives in a second batch", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		const update = { ...privateMessage(ZY, "Zhou", "record Only once"), update_id: 7 };
		env.api.push(update);
		await env.api.waitSent(1);
		expect((await rig.agent.intake.state()).cursor).toBe(8);

		// Telegram hands the same update out again — a restore that dropped the
		// cursor, or a crash before the offset moved.
		env.api.redeliver(update);
		await new Promise((done) => setTimeout(done, 400));

		expect(env.api.sent).toHaveLength(1);
		expect(await entriesOf(rig)).toHaveLength(1);
		// The router's own record: one turn was ever submitted for that update.
		expect((await rig.agent.intake.state()).open).toEqual([]);
	});
});

describe("the watchdog", () => {
	it("stops a turn at its deadline and sends Go's failure line instead", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { turnTimeoutMs: 100 });
		env.llm.hang = true;

		env.api.push(privateMessage(ZY, "Zhou", "the long turn"));
		const [sent] = await env.api.waitSent(1);
		expect(sent?.text).toBe(`Sorry, that didn't go through: ${TIMED_OUT_DETAIL}`);
		// Go logs a failed turn with who and where (bot.go:440).
		expect(linesWith(rig.lines, "telegram agent turn failed")).toEqual([
			expect.objectContaining({ level: "WARN", by: "ZY", chatId: ZY }),
		]);
		// The detail the log carries is the reply's own text, the watchdog's.
		expect(linesWith(rig.lines, "telegram agent turn failed")).toEqual([
			expect.objectContaining({ err: TIMED_OUT_DETAIL }),
		]);
		// The item is settled: the watchdog ending the turn is an outcome, not a crash.
		const ledger = await rig.agent.intake.state();
		expect(ledger.queue).toEqual([]);
		expect(ledger.open).toEqual([]);
	});

	it("fires at the stored deadline after a reopen, not a fresh 15 minutes", async () => {
		const env = await newEnv();
		env.llm.hang = true;
		const first = await startRig(env, { turnTimeoutMs: 60_000 });
		env.api.push(privateMessage(ZY, "Zhou", "still going"));
		await until(() => env.llm.requests.length > 0, "the turn to start");
		const [open] = (await first.agent.intake.state()).open;
		if (open === undefined) throw new Error("no open turn");
		// Its deadline has passed by the time the restart happens, so the recovery
		// must use the stored one: waiting another 15 minutes would be the bug.
		expect(open.deadlineAt).toBeGreaterThan(0);
		await first.shutdown();

		env.llm.hang = true;
		const second = await startRig(env, {
			dbPath: first.dbPath,
			turnTimeoutMs: 60_000,
			now: () => new Date(open.deadlineAt + 1_000),
		});
		const [sent] = await env.api.waitSent(1);
		expect(sent?.text).toBe(`Sorry, that didn't go through: ${TIMED_OUT_DETAIL}`);
		expect((await second.agent.intake.state()).open).toEqual([]);
	});
});

describe("a 429 on getUpdates", () => {
	it("waits Telegram's retry_after and then polls again", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.flood(2, 1);
		const started = Date.now();
		env.api.push(privateMessage(ZY, "Zhou", "record After the flood"));

		await env.api.waitSent(1);
		// Two floods, each a whole second; the answer cannot have come sooner.
		expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
		expect(rig.state.lastError).toContain("429");
	});
});

describe("the migration row", () => {
	it("records the new chat id of an upgraded group and sends nothing", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push({
			update_id: 0,
			message: message(9, person(ZY), chat(GROUP, "group", "Reno"), "", { migrate_to_chat_id: -1001234 }),
		});
		// Nothing is sent; the row is how the operator learns the new id.
		await until(() => rig.state.rejected.length > 0, "the migration row");
		await new Promise((done) => setTimeout(done, 200));

		expect(env.api.sent).toHaveLength(0);
		expect(rig.state.rejected[0]).toMatchObject({
			chatId: "-1001234",
			chatType: "supergroup",
			chatTitle: "Reno",
			reason: "group upgraded: new chat ID",
		});
		expect(rig.lines.join("\n")).toContain("telegram group was upgraded to a supergroup");
	});
});

describe("the status", () => {
	it("is Go's JSON, in Go's field order, with Go's omissions", async () => {
		const env = await newEnv();
		// One fixed instant, so the poll, the update and the row share it.
		const clock = new Date("2026-11-22T10:00:00Z");
		const rig = await startRig(env, { now: () => clock });
		// A refusal is the only way to get a row without waiting on a write.
		env.api.push(privateMessage(STRANGER, "Stranger", "hello"));
		await until(() => rig.state.rejected.length > 0, "the refusal");

		// bot.go:74-83: tokenSet, running, botUsername, lastPollAt, lastUpdateAt,
		// lastError, lastErrorAt, rejected — omitted while empty, the two ids as
		// strings, and `at` as Go's time.Time JSON (app/golden/t42 is the same shape
		// from Go's own json.Marshal).
		expect(goMarshal(rig.bot.status())).toBe(
			'{"tokenSet":true,"running":true,"botUsername":"movin_test_bot",' +
				'"lastPollAt":"2026-11-22T10:00:00Z",' +
				'"lastUpdateAt":"2026-11-22T10:00:00Z",' +
				'"rejected":[{"chatId":"333","chatType":"private","fromId":"333","fromName":"Stranger",' +
				'"reason":"user not on the allowlist","at":"2026-11-22T10:00:00Z"}]}',
		);
		// Go's CheckinView with no check-in is `{"on":false}` (checkin.go:450-453);
		// the server appends the editable `setting` (admin.ts:147).
		expect(goMarshal(await rig.bot.checkinStatus())).toBe('{"on":false}');
		expect(goMarshal(checkinView())).toBe('{"on":false}');
		// A bot that has not started yet: Go's `tokenSet rung:false`, rejected as [].
		expect(goMarshal(statusJSON(createBotState(true)))).toBe('{"tokenSet":true,"running":false,"rejected":[]}');
		expect(goMarshal(statusJSON(createBotState(false)))).toBe('{"tokenSet":false,"running":false,"rejected":[]}');
	});
});

describe("the second auth check", () => {
	it("refuses a message queued before the allowlist changed, and answers a callback's toast", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		// A slow first turn holds the chat's worker, so the next item is queued.
		env.llm.delay = 600;
		env.api.push(privateMessage(ZY, "Zhou", "record First"));
		await until(() => env.llm.requests.length > 0, "the first turn");
		env.api.push(privateMessage(ZY, "Zhou", "record queued too early"));
		await untilAsync(async () => (await rig.agent.intake.state()).queue.length === 1, "the queued item");
		// A callback waiting behind the same turn: its button is pressed before the
		// list changes too, so the second check is what refuses it.
		env.api.push({
			update_id: 0,
			callback_query: {
				id: "cb1",
				from: person(ZY),
				message: message(5, undefined, chat(ZY, "private"), ""),
				data: "undo:x",
			},
		});
		await untilAsync(async () => (await rig.agent.intake.state()).queue.length === 2, "the queued callback");

		// ZY is off the list while both wait.
		await rig.settings.saveTelegram("zy@example.com", {
			users: [{ id: `${PARTNER}`, name: "Partner" }],
			groups: [],
			useEnv: false,
		});
		const asked = env.llm.requests.length;

		// The first turn's reply, then both refusals: one model call each, no more.
		await env.api.waitSent(1);
		await untilAsync(
			async () => (await rig.agent.intake.state()).queue.length === 0,
			"the refused items to be dropped",
		);
		await until(() => env.api.answers.length > 0, "the refusal toast");

		// One reply only: the queued message never reached the model, and the
		// callback got Go's toast instead (bot.go:538-542).
		expect(env.api.sent).toHaveLength(1);
		expect(env.llm.requests.length).toBe(asked + 1);
		expect(env.api.answers).toEqual([{ id: "cb1", text: "You're not on this bot's list." }]);
		expect(await entriesOf(rig)).toHaveLength(1);
		// One row and one log line, both for the message: Go's check 2 for a callback
		// sends only the toast, and records nothing (bot.go:536-541).
		expect(rig.state.rejected.filter((row) => row.reason === "user not on the allowlist")).toHaveLength(1);
		expect(linesWith(rig.lines, "telegram message ignored")).toHaveLength(1);
	});

	it("records nothing when the second check's own item was taken already", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { stolen: [21, 22] });
		// The same two items, both taken by another worker before the second check runs.
		env.llm.delay = 600;
		env.api.push(privateMessage(ZY, "Zhou", "record First"));
		await until(() => env.llm.requests.length > 0, "the first turn");
		env.api.push({
			update_id: 21,
			message: message(21, person(ZY), chat(ZY, "private"), "record queued too early"),
		});
		await untilAsync(async () => (await rig.agent.intake.state()).queue.length === 1, "the queued item");
		env.api.push({
			update_id: 22,
			callback_query: {
				id: "cb2",
				from: person(ZY),
				message: message(22, undefined, chat(ZY, "private"), ""),
				data: "undo:x",
			},
		});
		await untilAsync(async () => (await rig.agent.intake.state()).queue.length === 2, "the queued callback");
		await rig.settings.saveTelegram("zy@example.com", {
			users: [{ id: `${PARTNER}`, name: "Partner" }],
			groups: [],
			useEnv: false,
		});

		await env.api.waitSent(1);
		await untilAsync(async () => (await rig.agent.intake.state()).queue.length === 0, "the taken items to be gone");
		await new Promise((done) => setTimeout(done, 300));

		// Neither the row nor the toast happened: the items were not this worker's.
		expect(rig.state.rejected).toEqual([]);
		expect(linesWith(rig.lines, "telegram message ignored")).toEqual([]);
		expect(env.api.answers).toEqual([]);
	});
});

describe("a command for another bot", () => {
	it("is dropped before any side effect: no turn, no reply, nothing taken", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/record@some_other_bot Kitchen", 30));
		await new Promise((done) => setTimeout(done, 300));

		expect(env.api.sent).toHaveLength(0);
		expect(env.llm.requests).toHaveLength(0);
		expect(await entriesOf(rig)).toHaveLength(0);
		const ledger = await rig.agent.intake.state();
		expect(ledger.queue).toEqual([]);
		expect(ledger.open).toEqual([]);
		// Refused or dropped, a command for another bot is never a rejected row either.
		expect(rig.state.rejected).toEqual([]);
	});

	it("answers an unknown command with Go's line, echoing the case, and /help with the help text", async () => {
		const env = await newEnv();
		await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "/Foo"));
		await env.api.waitSent(1);
		env.api.push(privateMessage(ZY, "Zhou", "/help"));
		const sent = await env.api.waitSent(2);

		expect(sent[0]?.text).toBe("I don't know /Foo. Send /help to see what I can do.");
		expect(sent[1]?.text).toBe(HELP_TEXT);
		// The menu is Go's, in Go's order.
		expect(env.api.menus[0]).toEqual([...BOT_COMMANDS]);
	});
});

describe("the update-id reset guard", () => {
	it("polls from 0 while nothing has been accepted for six days", { timeout: 20_000 }, async () => {
		const env = await newEnv();
		let clock = new Date("2026-11-01T09:00:00Z");
		const first = await startRig(env, { now: () => clock });
		// Five updates accepted with ids 10, 20 … 50, so the stored cursor is 51,
		// and the next poll confirms them to Telegram.
		for (let i = 1; i <= 5; i++) {
			env.api.push({ ...privateMessage(ZY, "Zhou", `record First ${i}`), update_id: i * 10 });
		}
		await env.api.waitSent(5);
		// The next poll confirms them to Telegram: nothing is left pending.
		await until(() => env.api.pendingIds().length === 0, "the confirming poll");
		expect((await first.agent.intake.state()).cursor).toBe(51);
		await first.shutdown();

		// A week later Telegram restarts update ids at random: id 3 is new (never
		// accepted, and below the cursor), and the stored cursor of 51 would hide it
		// for ever.
		clock = new Date(clock.getTime() + UPDATE_ID_RESET_MS + 60_000);
		// The stopped bot's last poll may still be finishing on the server; its offset is
		// not this process's, so nothing is captured until it is done (T4 fixes m1).
		await env.api.pollsIdle();
		const before = env.api.offsets.length;
		const second = await startRig(env, { dbPath: first.dbPath, now: () => clock });
		// The restart's first poll is at 0 although the ledger says 51.
		await until(() => env.api.offsets.length > before, "the first poll after the restart");
		expect(env.api.offsets[before]).toBe(0);

		env.api.push({ update_id: 3, message: message(6, person(ZY), chat(ZY, "private"), "record Random id") });
		await env.api.waitSent(6);
		// The cursor followed the batch back to 4 instead of staying at 51 (B1): without
		// that, the next poll would be at 51 and Telegram would drop 4 … 50 unseen.
		await until(() => env.api.offsets.slice(before).includes(4), "the cursor back after the accept");
		// The ids the new sequence goes on with are answered too, and the poll after
		// them asks from 6.
		env.api.push(
			{ update_id: 4, message: message(7, person(ZY), chat(ZY, "private"), "record After the reset") },
			{ update_id: 5, message: message(8, person(ZY), chat(ZY, "private"), "record After the reset too") },
		);
		await env.api.waitSent(8);
		await until(() => env.api.offsets.slice(before).includes(6), "the poll at 6 after the new ids");
		expect(env.api.sent).toHaveLength(8);
		// One entry each, and nothing answered twice: Telegram confirmed 10 … 50 for good
		// before the reset, so the stale poll cannot hand them out again — which is what
		// keeps the `fresh` batch (it clears `recent`) from running them a second time.
		expect(await entriesOf(second)).toHaveLength(8);
	});

	it("uses the stored cursor when a batch was accepted recently", async () => {
		const env = await newEnv();
		const clock = new Date("2026-11-01T09:00:00Z");
		const first = await startRig(env, { now: () => clock });
		env.api.push(privateMessage(ZY, "Zhou", "record Kept"));
		await env.api.waitSent(1);
		await until(() => env.api.offsets.includes(2), "the cursor at 2");
		await first.shutdown();

		await env.api.pollsIdle();
		const before = env.api.offsets.length;
		await startRig(env, { dbPath: first.dbPath, now: () => clock });
		await until(() => env.api.offsets.length > before, "the first poll after the restart");
		expect(env.api.offsets[before]).toBe(2);
	});
});

/** press is one button press as Telegram sends it: the callback, and the message it was on. */
function press(
	id: string,
	from: number,
	first: string,
	chatId: number,
	type: string,
	messageId: number,
	data: string,
	buttons: { text: string; callback_data?: string }[] = [],
): Update {
	return {
		update_id: 0,
		callback_query: {
			id,
			from: person(from, first),
			message: message(messageId, undefined, chat(chatId, type, type === "private" ? "" : "Reno"), "", {
				...(buttons.length === 0 ? {} : { reply_markup: { inline_keyboard: [buttons] } }),
			}),
			data,
		},
	};
}

/** injectChange puts one journal record into the stored document, as an older app or a hand edit would. */
async function injectChange(rig: Rig, change: Change): Promise<void> {
	const doc = cloneDoc((await rig.entries.current()).doc);
	doc.changes.push(change);
	await rig.entries.replace(doc);
}

// ---------- T4.4: the commands and the Undo button ----------

describe("TestCommands", () => {
	it("answers /help, /recent and /undo with Go's texts, on the caller's own change only", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		// Go's three journal changes (bot_test.go:485-487): ZY's, a web write, and
		// Partner's newer one.
		await rig.entries.create({ by: "ZY", channel: "telegram" }, [{ title: "Mine" }]);
		await rig.entries.create({ by: "zy@example.com", channel: "web" }, [{ title: "From web" }]);
		await rig.entries.create({ by: "Partner", channel: "telegram" }, [{ title: "Theirs" }]);

		env.api.push(privateMessage(ZY, "Zhou", "/help"));
		let sent = await env.api.waitSent(1);
		expect(sent[0]?.text).toBe(HELP_TEXT);
		expect(sent[0]?.text).toContain("Undo button");

		env.api.push(privateMessage(ZY, "Zhou", "/recent"));
		sent = await env.api.waitSent(2);
		const recent = sent[1]?.text ?? "";
		expect(recent.startsWith("Last changes, newest first:\n• Saved: note · Theirs — Partner, ")).toBe(true);
		expect(recent).toContain("From web — zy@example.com (web)");
		expect(recent).toContain("Saved: note · Mine — ZY");
		// No keyboard on /recent (commands.go:96).
		expect(sent[1]?.buttons).toEqual([]);

		// /undo takes ZY's own latest change, not Partner's newer one.
		env.api.push(privateMessage(ZY, "Zhou", "/undo"));
		sent = await env.api.waitSent(3);
		expect(sent[2]?.text).toBe("↩ Undone: removed Mine");
		expect(sent[2]?.buttons).toHaveLength(1);
		// A private chat is never threaded (bot_test.go:318).
		expect(sent[2]?.replyTo).toBe(0);
		expect((await entriesOf(rig)).map((entry) => entry.title)).toEqual(["From web", "Theirs"]);

		// A command for another bot is ignored; one for us answers, threaded.
		env.api.push(
			groupMessage(GROUP, ZY, "Zhou", "/recent@some_other_bot", 30),
			groupMessage(GROUP, ZY, "Zhou", "/sync@movin_test_bot", 31),
		);
		sent = await env.api.waitSent(4);
		await new Promise((done) => setTimeout(done, 200));
		expect(env.api.sent).toHaveLength(4);
		expect(sent[3]).toMatchObject({ chatId: GROUP, replyTo: 31 });
		expect(sent[3]?.text).toBe("Documents aren't switched on, so there's nothing to sync.");
	});
});

describe("TestUndoButtonRefusedForStrangerInGroup", () => {
	it("answers a stranger's press with Go's toast and changes nothing", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "record Keep me", 40));
		const [sent] = await env.api.waitSent(1);
		const button = sent?.buttons[0];
		if (button === undefined) throw new Error("no undo button");

		env.api.push(press("cbx", STRANGER, "Stranger", GROUP, "supergroup", 1001, button.callback_data ?? ""));
		await env.api.waitCalls("answerCallbackQuery", 1);
		// Already `accept` answers a refused press (T4.2b, bot.go:315-317), so the
		// button never keeps its spinner (trap 16).
		expect(env.api.answers).toEqual([{ id: "cbx", text: "You're not on this bot's list." }]);
		expect((await entriesOf(rig)).map((entry) => entry.title)).toEqual(["Keep me"]);
		// Nothing was sent and no keyboard was edited.
		expect(env.api.sent).toHaveLength(1);
		expect(env.api.edits).toHaveLength(0);
	});
});

describe("TestPrivateMessageSavesEntryAndUndoButtonWorks (the Undo button)", () => {
	it("undos the entry, toasts the line, drops the pressed button and offers Undo again", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "record Fluted glass door"));
		const [sent] = await env.api.waitSent(1);
		const button = sent?.buttons[0];
		if (button === undefined) throw new Error("no undo button");

		env.api.push(press("cb1", ZY, "Zhou", ZY, "private", 1001, button.callback_data ?? "", [button]));
		const after = await env.api.waitSent(2);
		const confirmation = after[1];
		expect(confirmation?.text.startsWith("↩ Undone: removed Fluted glass door")).toBe(true);
		// The confirmation is a new message with one Undo button of its own.
		expect(confirmation?.buttons).toHaveLength(1);
		expect(confirmation?.replyTo).toBe(0);
		expect(await entriesOf(rig)).toHaveLength(0);

		// The toast is the change line (bot_test.go:325-332).
		expect(env.api.answers).toEqual([{ id: "cb1", text: "Undone: removed Fluted glass door" }]);
		// Exactly one edit, and it is Go's empty keyboard (bot.go:582-585, trap 15).
		expect(env.api.edits).toHaveLength(1);
		expect(env.api.edits[0]?.markup).toEqual({ inline_keyboard: [] });
		expect(env.api.edits[0]?.messageId).toBe(1001);

		// The undo is recorded as ZY's, through Telegram, and its button undoes it.
		const [newest] = await rig.entries.recent(1);
		expect(newest).toMatchObject({ by: "ZY", channel: "telegram", op: "undo" });
		expect(confirmation?.buttons[0]?.callback_data).toBe(`undo:${newest?.id ?? ""}`);
	});
});

describe("the undo confirmation in a group", () => {
	it("names who pressed the button and threads under the bot's message", async () => {
		const env = await newEnv();
		await startRig(env);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "record Keep me", 40));
		const [sent] = await env.api.waitSent(1);
		const button = sent?.buttons[0];
		if (button === undefined) throw new Error("no undo button");

		// Partner presses ZY's button; anyone on the list may.
		env.api.push(press("cbg", PARTNER, "P", GROUP, "supergroup", 1001, button.callback_data ?? "", [button]));
		const after = await env.api.waitSent(2);
		expect(after[1]?.text.startsWith("↩ Partner: Undone: removed Keep me")).toBe(true);
		expect(after[1]?.replyTo).toBe(1001);
		expect(env.api.answers).toEqual([{ id: "cbg", text: "Undone: removed Keep me" }]);
	});
});

describe("/undo is per person and at-most-once", () => {
	it("undos two different changes for two /undo updates in one batch", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		await rig.entries.create({ by: "ZY", channel: "telegram" }, [{ title: "First" }]);
		await rig.entries.create({ by: "ZY", channel: "telegram" }, [{ title: "Second" }]);

		env.api.push(privateMessage(ZY, "Zhou", "/undo"), privateMessage(ZY, "Zhou", "/undo"));
		const sent = await env.api.waitSent(2);
		expect(sent[0]?.text).toBe("↩ Undone: removed Second");
		// The second /undo works on the undo record, not on the same change again:
		// "my latest change" moved, so the button data differs (plan.md:129, trap 14).
		expect(sent[1]?.text).toBe("↩ Undone: restored Second");
		expect(sent[1]?.buttons[0]?.callback_data).not.toBe(sent[0]?.buttons[0]?.callback_data);
		expect((await entriesOf(rig)).map((entry) => entry.title)).toEqual(["First", "Second"]);
	});

	it("does nothing more when the same /undo update is handed out again", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		await rig.entries.create({ by: "ZY", channel: "telegram" }, [{ title: "Once" }]);
		const update = { ...privateMessage(ZY, "Zhou", "/undo"), update_id: 900 };
		env.api.push(update);
		await env.api.waitSent(1);

		// A crash before the offset moved, or a restored cursor: Telegram hands the
		// same update out again (plan.md:76).
		env.api.redeliver(update);
		await new Promise((done) => setTimeout(done, 400));
		expect(env.api.sent).toHaveLength(1);
		const journal = await rig.entries.recent(10);
		expect(journal.filter((change) => change.op === "undo")).toHaveLength(1);
		// One undo, so the entry stays removed: a second one would have restored it.
		expect(await entriesOf(rig)).toHaveLength(0);
	});
});

describe("the Undo button is at-most-once", () => {
	it("answers a redelivered callback once and undoes once", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "record Once"));
		const [sent] = await env.api.waitSent(1);
		const button = sent?.buttons[0];
		if (button === undefined) throw new Error("no undo button");
		const update = {
			...press("cbd", ZY, "Zhou", ZY, "private", 1001, button.callback_data ?? "", [button]),
			update_id: 500,
		};
		env.api.push(update);
		await env.api.waitSent(2);
		await env.api.waitCalls("answerCallbackQuery", 1);

		env.api.redeliver(update);
		await new Promise((done) => setTimeout(done, 400));
		expect(env.api.answers).toHaveLength(1);
		expect(env.api.edits).toHaveLength(1);
		expect(env.api.sent).toHaveLength(2);
		const journal = await rig.entries.recent(10);
		expect(journal.filter((change) => change.op === "undo")).toHaveLength(1);
	});

	it("answers a second press on the same button with the stale toast and writes nothing", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "record Twice"));
		const [sent] = await env.api.waitSent(1);
		const button = sent?.buttons[0];
		if (button === undefined) throw new Error("no undo button");
		const markup = [button];

		env.api.push(press("cb1", ZY, "Zhou", ZY, "private", 1001, button.callback_data ?? "", markup));
		await env.api.waitSent(2);
		// The same button pressed again: the record is still there, the entry is not
		// (bot_test.go:339-341, spec §7.2).
		env.api.push(press("cb2", ZY, "Zhou", ZY, "private", 1001, button.callback_data ?? "", markup));
		await env.api.waitCalls("answerCallbackQuery", 2);
		expect(env.api.answers[1]).toEqual({
			id: "cb2",
			text: "That entry was changed again since, so it can't be undone.",
		});
		// Nothing written, nothing sent, no second edit (Go returns before the edit).
		expect(env.api.sent).toHaveLength(2);
		expect(env.api.edits).toHaveLength(1);
		const journal = await rig.entries.recent(10);
		expect(journal.filter((change) => change.op === "undo")).toHaveLength(1);
	});
});

describe("the undo toast", () => {
	it("is the change line cut to 190 runes while the message carries all of it", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		// The longest title an entry may have: the line is then 216 runes, well over 190.
		const title = "T".repeat(200);
		const created = await rig.entries.create({ by: "ZY", channel: "telegram" }, [{ title }]);
		const id = created.changes[0]?.id ?? "";

		env.api.push(
			press("cbl", ZY, "Zhou", ZY, "private", 1001, `undo:${id}`, [{ text: "Undo", callback_data: `undo:${id}` }]),
		);
		const [sent] = await env.api.waitSent(1);
		const toast = env.api.answers[0]?.text ?? "";
		expect([...toast]).toHaveLength(190);
		expect(toast.endsWith("…")).toBe(true);
		// The message has the whole line: 2 for "↩ ", 16 for "Undone: removed ", then
		// the title (bot.go:567, trap 8).
		expect([...(sent?.text ?? "")]).toHaveLength(2 + 16 + title.length);
		expect(sent?.text.endsWith(title)).toBe(true);
	});
});

describe("/HELP and a bare slash", () => {
	it("matches the command word case-insensitively and answers / with Go's line", async () => {
		const env = await newEnv();
		await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "/HELP"));
		let sent = await env.api.waitSent(1);
		expect(sent[0]?.text).toBe(HELP_TEXT);

		// Just "/" is an empty command word, which Go's default branch answers (trap 13).
		env.api.push(privateMessage(ZY, "Zhou", "/"));
		sent = await env.api.waitSent(2);
		expect(sent[1]?.text).toBe("I don't know /. Send /help to see what I can do.");

		env.api.push(privateMessage(ZY, "Zhou", "/Foo"));
		sent = await env.api.waitSent(3);
		expect(sent[2]?.text).toBe("I don't know /Foo. Send /help to see what I can do.");
	});
});

describe("/recent with a Go-written meta record", () => {
	it("skips the record instead of losing the answer", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		await rig.entries.create({ by: "ZY", channel: "telegram" }, [{ title: "Mine" }]);
		// The old journaled `set_dates` meta record Go 1.0.x still writes while a
		// rollback runs: no sides, an op this build does not know (spec §6.3).
		await injectChange(rig, {
			id: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6E",
			at: "2026-11-12T14:00:00Z",
			by: "ZY",
			channel: "telegram",
			op: "meta",
			entryId: "",
			before: null,
			after: null,
		});

		env.api.push(privateMessage(ZY, "Zhou", "/recent"));
		const [sent] = await env.api.waitSent(1);
		const text = sent?.text ?? "";
		expect(text.startsWith("Last changes, newest first:\n• Saved: note · Mine — ZY, ")).toBe(true);
		// One line only: the meta record contributed nothing, and the reply survived.
		expect(text.split("\n")).toHaveLength(2);
		expect(rig.lines.join("\n")).not.toContain("telegram handler panicked");
	});
});

describe("a command that throws", () => {
	it("logs telegram handler panicked and keeps the chat working", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		// A journal record no reader can describe (a create with no entry): Go's
		// ChangeText panics on it, and the bot must survive that (bot.go:377-381).
		await injectChange(rig, {
			id: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6F",
			at: "2026-11-12T14:00:00Z",
			by: "ZY",
			channel: "telegram",
			op: "create",
			entryId: "",
			before: null,
			after: null,
		});

		env.api.push(privateMessage(ZY, "Zhou", "/recent"));
		await until(() => rig.lines.some((line) => line.includes("telegram handler panicked")), "the panic log");
		expect(env.api.sent).toHaveLength(0);

		// The item was taken before it threw, and the chat's worker is still there.
		expect((await rig.agent.intake.state()).queue).toEqual([]);
		env.api.push(privateMessage(ZY, "Zhou", "/help"));
		const [sent] = await env.api.waitSent(1);
		expect(sent?.text).toBe(HELP_TEXT);
	});
});

describe("TestDocumentSyncAndNotices", () => {
	it("runs /sync on the real syncer and answers with Go's counts and document list", async () => {
		const env = await newEnv();
		// Go's fake converter and two PDFs (bot_test.go:695-703).
		const pad = " text of the manual".repeat(10);
		const conv = new FakeConverter();
		conv.pages.set("pdf-a", [{ n: 1, w: 595, h: 842, text: `Fridge manual${pad}` }]);
		conv.pages.set("pdf-b", [{ n: 1, w: 595, h: 842, text: `Oven manual${pad}` }]);
		const syncer = createSyncer({
			store: env.store,
			converter: conv,
			log: createTestLog().log,
			now: () => new Date("2026-11-12T03:00:00Z"),
		});
		await startRig(env, { syncer });
		await env.store.put("docs/raw/Fridge.pdf", new TextEncoder().encode("pdf-a"), null);

		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/sync", 50));
		// "Syncing…" first, so a slow sync is not a silent chat, then the result.
		const sent = await env.api.waitSent(2);
		expect(sent[0]?.text).toBe("Syncing the documents…");
		expect(sent[0]?.replyTo).toBe(50);
		expect(sent[1]?.text.startsWith("Synced: 1 added. 1 documents are readable.\n• Fridge.pdf")).toBe(true);
		expect(sent[1]?.replyTo).toBe(50);

		// A second document, found by a later sync.
		await env.store.put("docs/raw/Oven.pdf", new TextEncoder().encode("pdf-b"), null);
		await syncer.sync("daily");
		expect(conv.calls).toBe(2);

		// Nothing to do: the no-op answer counts what is readable (docs.go:67-70).
		env.api.push(privateMessage(ZY, "Zhou", "/sync"));
		const all = await env.api.waitSent(4);
		expect(all[2]?.text).toBe("Syncing the documents…");
		expect(all[3]?.text).toBe("No changes. 2 documents are readable.");
	});

	// The notice half (T5.2): DocsChanged posts `Documents updated: …` to every
	// allowed group after a sync that changed something, never for the first import
	// (docs.go:18-38). `/sync`'s reason `telegram:<chat id>` is what it skips on.
	it("posts one Documents updated notice to the group, and skips the chat that asked", async () => {
		const env = await newEnv();
		const pad = " text of the manual".repeat(10);
		const conv = new FakeConverter();
		conv.pages.set("pdf-a", [{ n: 1, w: 595, h: 842, text: `Fridge manual${pad}` }]);
		conv.pages.set("pdf-b", [{ n: 1, w: 595, h: 842, text: `Oven manual${pad}` }]);
		conv.pages.set("pdf-c", [{ n: 1, w: 595, h: 842, text: `Kettle manual${pad}` }]);
		// Two groups, so the one that asked for the sync is visibly the one left out.
		const allow: Telegram = { ...ALLOW, groups: [`${GROUP}`, `${OTHER_GROUP}`] };
		const { log } = createTestLog();
		const notifier = createDocsNotifier({ settings: { resolveTelegram: async () => allow }, log });
		const syncer = createSyncer({
			store: env.store,
			converter: conv,
			notify: notifier,
			log,
			now: () => new Date("2026-11-12T03:00:00Z"),
		});
		const rig = await startRig(env, { syncer, allow });
		// The agent is open, so each notice is a durable delivery to a group (T5-plan §4).
		notifier.attach(async (key, address, parts) => await rig.agent.deliver(key, address, parts));
		const pdf = (body: string): Uint8Array => new TextEncoder().encode(body);
		const notices = (): { chatId: number; text: string }[] =>
			env.api.sent
				.filter((m) => m.text.startsWith("Documents updated:"))
				.map((m) => ({ chatId: m.chatId, text: m.text }));
		await env.store.put("docs/raw/Fridge.pdf", pdf("pdf-a"), null);

		// The first import is silent: `/sync` answers in its chat only.
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/sync", 50));
		const sent = await env.api.waitSent(2);
		expect(sent[0]?.text).toBe("Syncing the documents…");
		expect(sent[1]?.text.startsWith("Synced: 1 added. 1 documents are readable.\n• Fridge.pdf")).toBe(true);
		await new Promise((done) => setTimeout(done, 200));
		expect(notices()).toEqual([]);

		// A document a later sync finds, from `/sync` in the group: its reply, and the
		// notice to the other group only (docs.go:29-33).
		await env.store.put("docs/raw/Oven.pdf", pdf("pdf-b"), null);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/sync", 51));
		await env.api.waitSent(5);
		expect(notices()).toEqual([{ chatId: OTHER_GROUP, text: "Documents updated: 1 added\n• Oven.pdf" }]);
		// Go's plain SendMessage: no keyboard, and no thread (messageId 0 is never sent).
		expect(env.api.sent.find((m) => m.text.startsWith("Documents updated:"))).toMatchObject({
			replyTo: 0,
			buttons: [],
		});

		// The nightly run tells every group: one delivery per group, the second to a
		// group that has never spoken to the bot.
		await env.store.put("docs/raw/Kettle.pdf", pdf("pdf-c"), null);
		await syncer.sync("daily");
		await env.api.waitSent(7);
		await new Promise((done) => setTimeout(done, 200));
		expect(notices()).toEqual([
			{ chatId: OTHER_GROUP, text: "Documents updated: 1 added\n• Oven.pdf" },
			{ chatId: GROUP, text: "Documents updated: 1 added\n• Kettle.pdf" },
			{ chatId: OTHER_GROUP, text: "Documents updated: 1 added\n• Kettle.pdf" },
		]);

		// A no-op `/sync` says so and posts no notice (bot_test.go:727-734).
		env.api.push(privateMessage(ZY, "Zhou", "/sync"));
		await env.api.waitSent(9);
		expect(env.api.sent.some((m) => m.text === "No changes. 3 documents are readable.")).toBe(true);
		await new Promise((done) => setTimeout(done, 200));
		expect(notices()).toHaveLength(3);
	});
});

// ---------- T4 fixes, phase review round 1 ----------

/** linesWith are the test log's lines for one message, as the fields they carry. */
function linesWith(lines: string[], msg: string): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg);
}

describe("the request id", () => {
	it("answers a new message whose update_id an older one already used", { timeout: 20_000 }, async () => {
		const env = await newEnv();
		let clock = new Date("2026-11-01T09:00:00Z");
		const first = await startRig(env, { now: () => clock });
		env.api.push({ update_id: 7, message: message(1, person(ZY), chat(ZY, "private"), "record Before the reset") });
		await env.api.waitSent(1);
		await until(() => env.api.pendingIds().length === 0, "the confirming poll");
		await first.shutdown();

		// Six quiet days: Telegram picks update ids again, and this one happens to be
		// the id the chat already used. Its message_id is a new one, which Telegram
		// never reuses in a chat, so the request id is a new one too (B2).
		clock = new Date(clock.getTime() + UPDATE_ID_RESET_MS + 60_000);
		const second = await startRig(env, { dbPath: first.dbPath, now: () => clock });
		env.api.push({ update_id: 7, message: message(2, person(ZY), chat(ZY, "private"), "record After the reset") });
		await env.api.waitSent(2);

		// Two turns, so four requests (a tool round and its answer each): the second
		// message ran its own turn instead of being attached to the first one's
		// settled reply, which is what a `tg:<update_id>` id would have done.
		expect(env.llm.requests).toHaveLength(4);
		expect(env.llm.requests[2]?.messages.at(-1)?.content).toBe("record After the reset");
		expect((await entriesOf(second)).map((entry) => entry.title)).toEqual(["Before the reset", "After the reset"]);
		expect((await second.agent.intake.state()).open).toEqual([]);
	});
});

describe("no LLM configured", () => {
	it("answers Go's failure line without a model call, and logs the failed turn", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { llm: { model: "" } });
		env.api.push(privateMessage(ZY, "Zhou", "record Nothing to run it on"));

		const [sent] = await env.api.waitSent(1);
		// Go's prepare refuses the connection before any request (agent.go:152-154) and
		// converse prints the error through the failure line (bot.go:440-447).
		expect(sent?.text).toBe(`Sorry, that didn't go through: ${NO_CONNECTION_MESSAGE}`);
		expect(env.llm.requests).toHaveLength(0);
		expect(await entriesOf(rig)).toHaveLength(0);
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
		expect(linesWith(rig.lines, "telegram agent turn failed")).toEqual([
			expect.objectContaining({ level: "WARN", by: "ZY", chatId: ZY, err: NO_CONNECTION_MESSAGE }),
		]);
	});
});

describe("a take another worker made first", () => {
	it("acts on nothing, for a command and for a callback", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { stolen: [31, 32] });
		env.api.push(
			{ update_id: 31, message: message(31, person(ZY), chat(ZY, "private"), "/help") },
			{
				update_id: 32,
				callback_query: {
					id: "cbs",
					from: person(ZY),
					message: message(32, undefined, chat(ZY, "private"), ""),
					data: "undo:01K8ZQ4R7S9T2V5W8X1Y3Z5A6E",
				},
			},
		);
		// The items were queued and taken by the other worker first, so this one found
		// nothing to take and did nothing: no reply, no toast, no edit, no panic (M2).
		await new Promise((done) => setTimeout(done, 400));

		expect(env.api.sent).toHaveLength(0);
		expect(env.api.answers).toEqual([]);
		expect(env.api.edits).toEqual([]);
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
		expect(rig.lines.join("\n")).not.toContain("telegram handler panicked");
	});
});

describe("a getMe that fails", () => {
	it("retries with Go's field name `in`, as bot.go:196 writes it", { timeout: 15_000 }, async () => {
		const env = await newEnv();
		env.api.failGetMe(1);
		const rig = await startRig(env);

		expect(rig.bot.status()).toMatchObject({ running: true, botUsername: "movin_test_bot" });
		// Go's `log.Warn("telegram getMe failed, retrying", "err", err, "in", backoff)`: the
		// field is `in`, not `retryIn` (T4 fixes M8).
		const failed = linesWith(rig.lines, "telegram getMe failed, retrying");
		expect(failed).toHaveLength(1);
		expect(failed[0]).toMatchObject({ level: "WARN", in: 1_000 });
		expect(failed[0]).not.toHaveProperty("retryIn");
		expect(rig.state.lastError).toContain("Bad Gateway");
	});
});

describe("stop", () => {
	it("starts no further job, and the reopen answers both queued updates", { timeout: 20_000 }, async () => {
		const env = await newEnv();
		// A slow model, so the stop lands while the first turn is in flight and that
		// turn still finishes on its own: it is what the next job would follow.
		env.llm.delay = 600;
		const first = await startRig(env);
		env.api.push(privateMessage(ZY, "Zhou", "record Stopped one"), privateMessage(ZY, "Zhou", "record Stopped two"));
		await until(() => env.llm.requests.length > 0, "the first turn");
		await untilAsync(async () => (await first.agent.intake.state()).queue.length === 1, "the queued item");
		const queued = (await first.agent.intake.state()).queue.map((item) => item.id);

		await first.bot.stop();
		// The turn in flight finishes and its reply goes out. Nothing new starts after
		// the stop: the second item is still in the ledger, and no request is made for
		// it (M3).
		await env.api.waitSent(1);
		await new Promise((done) => setTimeout(done, 700));
		expect(env.api.sent).toHaveLength(1);
		expect(env.llm.requests).toHaveLength(2);
		expect((await first.agent.intake.state()).queue.map((item) => item.id)).toEqual(queued);

		// Closing under a worker that is waiting for its list is not a panic either.
		await first.shutdown();
		expect(first.lines.join("\n")).not.toContain("telegram handler panicked");

		// The next start answers what was left: the queued item alone, once.
		env.llm.delay = 0;
		const second = await startRig(env, { dbPath: first.dbPath });
		await env.api.waitSent(2);
		const titles = (await entriesOf(second)).map((entry) => entry.title);
		expect(titles.sort()).toEqual(["Stopped one", "Stopped two"]);
		expect(env.api.sent).toHaveLength(2);
		expect(await second.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});
});

describe("a turn that hits the tool limit", () => {
	it("logs nothing, because reply.ts answers it like Go's forced answer", async () => {
		const env = await newEnv();
		const rig = await startRig(env);
		// A model that calls a tool on every request: pi-durable's turn budget ends the
		// run `turn_limit`, which `channelReply` answers as an outcome, not a failure.
		env.llm.toolLoop = true;
		env.api.push(privateMessage(ZY, "Zhou", "record Keep going"));

		const [sent] = await env.api.waitSent(1);
		expect(sent?.text.startsWith("Done.")).toBe(true);
		expect(linesWith(rig.lines, "telegram agent turn failed")).toEqual([]);
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});
});

describe("a job that throws", () => {
	it("logs it, stops that chat's worker, and leaves the item durable", async () => {
		const env = await newEnv();
		// ZY's first turn settles, but the settlement cannot be stored: the turn is
		// over and its item stays `open` for the next start (M3).
		const rig = await startRig(env, { failSettle: [51] });
		env.api.push(
			{ update_id: 51, message: message(51, person(ZY), chat(ZY, "private"), "record Throws") },
			{ update_id: 52, message: message(52, person(ZY), chat(ZY, "private"), "record Never starts") },
			// Another chat is a worker of its own and carries on.
			{ update_id: 53, message: message(53, person(PARTNER), chat(PARTNER, "private"), "record Other chat") },
		);

		await until(() => linesWith(rig.lines, "telegram handler panicked").length > 0, "the failed job's log line");
		await env.api.waitSent(1);
		// Nothing may start after the throw: ZY's second item is still queued.
		await new Promise((done) => setTimeout(done, 400));

		expect(linesWith(rig.lines, "telegram handler panicked")).toEqual([
			expect.objectContaining({ level: "ERROR", panic: "the settlement could not be stored" }),
		]);
		// Only the other chat answered, and its entry is saved.
		expect(env.api.sent).toHaveLength(1);
		expect(env.api.sent[0]).toMatchObject({ chatId: PARTNER });
		// The failed turn's own writes stay (they were committed before the settle) and
		// only its reply never went out: a reopen settles it from the open item.
		expect((await entriesOf(rig)).map((entry) => entry.title)).toEqual(["Throws", "Other chat"]);
		// Both of ZY's items are still in the ledger: one submitted and unfinished, one
		// never started — a reopen attaches to the first and queues the second.
		const ledger = await rig.agent.intake.state();
		expect(ledger.open.map((turn) => turn.id)).toEqual([51]);
		expect(ledger.queue.map((item) => item.id)).toEqual([52]);
	});
});

describe("a chat whose worker stopped", () => {
	it("answers its stranded item before the next one, once each", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { failSettle: [61] });
		env.api.push({ update_id: 61, message: message(61, person(ZY), chat(ZY, "private"), "record Throws") });
		await until(() => linesWith(rig.lines, "telegram handler panicked").length === 1, "the failed job");

		// The next update rebuilds the chat from the ledger, so the stranded turn is
		// answered first and the new one last (M-R1).
		env.api.push({ update_id: 62, message: message(62, person(ZY), chat(ZY, "private"), "record Second") });
		await env.api.waitSent(2);
		await new Promise((done) => setTimeout(done, 400));

		expect(env.api.sent).toHaveLength(2);
		expect(env.api.sent[0]?.text).toContain("· Throws");
		expect(env.api.sent[1]?.text).toContain("· Second");
		// Each turn ran once: the stranded one is attached to, not submitted again.
		expect(await entriesOf(rig)).toHaveLength(2);
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});

	it("handles each item of one batch once while the chat is stale", async () => {
		const env = await newEnv();
		// No model configured: every message item answers Go's failure line and settles,
		// so one log line and one settle per item count the work without a model turn.
		const rig = await startRig(env, { failSettle: [101], llm: { model: "" } });
		env.api.push({ update_id: 101, message: message(101, person(ZY), chat(ZY, "private"), "record Throws") });
		await until(() => linesWith(rig.lines, "telegram handler panicked").length === 1, "the failed job");

		// One batch, so both wakes run while the chat is stale: the first one's rebuild
		// already holds both items, and the second must not queue its own again (R4-1).
		env.api.push(
			{ update_id: 102, message: message(102, person(ZY), chat(ZY, "private"), "record First") },
			{ update_id: 103, message: message(103, person(ZY), chat(ZY, "private"), "record Second") },
		);
		await until(() => rig.settles.length >= 3, "all three items");
		await new Promise((done) => setTimeout(done, 400));

		// Each item handled once, in ledger order.
		expect(rig.settles).toEqual([101, 102, 103]);
		// One failed-turn line per attempt: 101 threw and was rebuilt, 102 and 103 ran once
		// each. A duplicate wake turns these four into five.
		expect(linesWith(rig.lines, "telegram agent turn failed")).toHaveLength(4);
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});

	it("starts no worker while the rebuild cannot read the ledger, then answers both in order", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { failSettle: [81] });
		env.api.push({ update_id: 81, message: message(81, person(ZY), chat(ZY, "private"), "record Throws") });
		await until(() => linesWith(rig.lines, "telegram handler panicked").length === 1, "the failed job");

		// The new update's rebuild fails: it must not start a worker of its own, because
		// its item would then run ahead of the stranded one (R3-1).
		rig.ledger.failNext(1);
		env.api.push({ update_id: 82, message: message(82, person(ZY), chat(ZY, "private"), "record Second") });
		await until(() => linesWith(rig.lines, "telegram ledger rebuild failed").length === 1, "the failed rebuild");
		await new Promise((done) => setTimeout(done, 300));
		expect(env.api.sent).toHaveLength(0);

		// The retry (1 s) rebuilds and answers both, the stranded turn first.
		await env.api.waitSent(2);
		await new Promise((done) => setTimeout(done, 400));
		expect(env.api.sent).toHaveLength(2);
		expect(env.api.sent[0]?.text).toContain("· Throws");
		expect(env.api.sent[1]?.text).toContain("· Second");
		// Each item handled once, in ledger order.
		expect(rig.settles).toEqual([81, 82]);
		expect(await entriesOf(rig)).toHaveLength(2);
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});

	it("runs one worker when the retry and a new update rebuild at once", { timeout: 20_000 }, async () => {
		const env = await newEnv();
		const rig = await startRig(env, { failSettle: [91] });
		env.api.push({ update_id: 91, message: message(91, person(ZY), chat(ZY, "private"), "record Throws") });
		await until(() => linesWith(rig.lines, "telegram handler panicked").length === 1, "the failed job");

		// The retry's rebuild is held inside the ledger read; a new update then joins it
		// instead of starting a second one (R3-2).
		rig.ledger.hold();
		await new Promise((done) => setTimeout(done, 1_200));
		env.api.push({ update_id: 92, message: message(92, person(ZY), chat(ZY, "private"), "record Second") });
		// Long enough for the accept, the wake and its wait on the same rebuild.
		await new Promise((done) => setTimeout(done, 300));
		rig.ledger.release();

		await env.api.waitSent(2);
		await new Promise((done) => setTimeout(done, 500));
		// One worker, so each item is handled once: a second rebuild would leave the
		// same two ids here twice.
		expect(rig.settles).toEqual([91, 92]);
		expect(env.api.sent).toHaveLength(2);
		expect(env.api.sent[0]?.text).toContain("· Throws");
		expect(env.api.sent[1]?.text).toContain("· Second");
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
	});

	it("answers the stranded item on the retry, with no further update", { timeout: 20_000 }, async () => {
		const env = await newEnv();
		const rig = await startRig(env, { failSettle: [71] });
		env.api.push({ update_id: 71, message: message(71, person(ZY), chat(ZY, "private"), "record Alone") });
		await until(() => linesWith(rig.lines, "telegram handler panicked").length === 1, "the failed job");
		expect(env.api.sent).toHaveLength(0);

		// Nothing else arrives: the 1 s retry rebuilds the chat and settles the turn.
		const [sent] = await env.api.waitSent(1);
		expect(sent?.text).toContain("· Alone");
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
		// It was attached to, so the model was not asked again: two requests, one turn.
		expect(env.llm.requests).toHaveLength(2);
	});
});

describe("startup recovery", () => {
	it("logs a failed ledger read and retries it instead of rejecting run()", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { failRecover: 1 });

		// It started, so the retry worked; the failure is a log line, not a rejection.
		expect(rig.bot.status()).toMatchObject({ running: true });
		expect(linesWith(rig.lines, "telegram recovery failed")).toEqual([
			expect.objectContaining({ level: "WARN", err: "the ledger could not be read", retryIn: 1_000 }),
		]);
		env.api.push(privateMessage(ZY, "Zhou", "record After the retry"));
		const [sent] = await env.api.waitSent(1);
		expect(sent?.text).toContain("After the retry");
	});
});

// ---------- T5.1c: the morning check-in, end to end ----------

/** Go's `ciNow` (checkin_test.go:17): 2026-11-12, a Thursday, 09:30 UTC. */
const CI_NOW = new Date("2026-11-12T09:30:00Z");

/** seedTasks creates entries as the web page does, and answers title → id. */
async function seedTasks(rig: Rig, items: readonly Patch[]): Promise<Record<string, string>> {
	await rig.entries.create({ by: "ZY", channel: "web" }, items);
	const ids: Record<string, string> = {};
	for (const entry of (await rig.entries.current()).doc.entries) ids[entry.title] = entry.id;
	return ids;
}

/** task is Go's `task(title, date, extra…)` (checkin_test.go:37). */
function task(title: string, date: string, extra: Patch = {}): Patch {
	return { kind: "task", title, date, ...extra };
}

/** checkinOf is the rig's check-in, which the tests that use it always wire. */
function checkinOf(rig: Rig): CheckinService {
	if (rig.checkin === null) throw new Error("this rig has no check-in");
	return rig.checkin;
}

/** theCheckinRecord is `checkin.json` as the store keeps it. */
async function theCheckinRecord(rig: Rig): Promise<string> {
	// The bytes matter: they are Go's, and a Go app on the same bucket reads them.
	return new TextDecoder().decode((await rig.checkinStore.get(CHECKIN_KEY)).body);
}

describe("TestCheckinCommandAndButtons", () => {
	it("sends the summary and three asks, answers Done, Done ★ and +1 week, and never asks the model", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { now: () => CI_NOW, checkin: {} });
		const ids = await seedTasks(rig, [
			{ kind: "task", title: "Electrician", date: "2026-11-12", time: "14:00" },
			{ kind: "question", title: "Pick grout colour", date: "2026-11-12" },
			task("Book movers", "2026-11-11"),
			task("Order tiles", "2026-11-11"),
			task("Measure windows", "2026-11-11", { room: "living" }),
			task("Already done", "2026-11-11", { status: "done" }),
			task("Old one", "2026-11-07"),
			task("Next week", "2026-11-19"),
		]);

		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/checkin", 50));
		const sent = await env.api.waitSent(4);
		const sum = sent[0]?.text ?? "";
		for (const want of [
			"Good morning! Thu 12 Nov",
			"• 14:00 Electrician",
			"• Pick grout colour",
			"Not marked done yet (3)",
			"Still overdue (1):\n• Old one — Sat 7 Nov",
		]) {
			expect(sum).toContain(want);
		}
		// A done task and a future one are not the morning's business.
		expect(sum).not.toContain("Already done");
		expect(sum).not.toContain("Next week");

		// One message per ask, yesterday's date said as "Yesterday", four buttons.
		const asks = sent.slice(1, 4);
		expect(asks.map((ask) => ask.text)).toEqual([
			"Yesterday: Book movers\nDone?",
			"Yesterday: Order tiles\nDone?",
			"Yesterday: Measure windows (living)\nDone?",
		]);
		for (const [i, ask] of asks.entries()) {
			const title = ["Book movers", "Order tiles", "Measure windows"][i] ?? "";
			const base = `${ids[title] ?? ""}:20261111`;
			const want = [`ci:d:${base}`, `ci:m:${base}`, `ci:r:${base}:1`, `ci:r:${base}:7`];
			expect(ask.chatId).toBe(GROUP);
			expect(ask.buttons.map((button) => button.callback_data)).toEqual(want);
		}

		// Done, Done ★, +1 week: one journaled change each, with an Undo.
		env.api.push(
			press(
				"cb2001",
				ZY,
				"Zhou",
				GROUP,
				"supergroup",
				2001,
				`ci:d:${ids["Book movers"] ?? ""}:20261111`,
				asks[0]?.buttons ?? [],
			),
			press(
				"cb2002",
				PARTNER,
				"Pat",
				GROUP,
				"supergroup",
				2002,
				`ci:m:${ids["Order tiles"] ?? ""}:20261111`,
				asks[1]?.buttons ?? [],
			),
			press(
				"cb2003",
				ZY,
				"Zhou",
				GROUP,
				"supergroup",
				2003,
				`ci:r:${ids["Measure windows"] ?? ""}:20261111:7`,
				asks[2]?.buttons ?? [],
			),
		);
		const after = await env.api.waitSent(7);
		const wantReplies = [
			"✓ ZY: Updated: Book movers (status done)",
			"✓ Partner: Updated: Order tiles (status done, ★ milestone)",
			"✓ ZY: Updated: Measure windows (date 2026-11-19)",
		];
		for (const [i, want] of wantReplies.entries()) {
			const reply = after[4 + i];
			expect(reply?.text).toBe(want);
			expect(reply?.buttons).toHaveLength(1);
			expect(reply?.buttons[0]?.callback_data?.startsWith("undo:")).toBe(true);
		}
		// Re-read every time: a write after this line would otherwise be invisible.
		const entryOf = async (title: string): Promise<Entry | undefined> =>
			(await rig.entries.current()).doc.entries.find((entry) => entry.id === ids[title]);
		expect(await entryOf("Book movers")).toMatchObject({
			status: "done",
			milestone: false,
			by: "ZY",
			channel: "telegram",
			completed: "2026-11-12",
		});
		expect(await entryOf("Order tiles")).toMatchObject({ status: "done", milestone: true, by: "Partner" });
		expect(await entryOf("Measure windows")).toMatchObject({ date: "2026-11-19", status: "todo" });
		// Each pressed message lost its buttons.
		expect(env.api.edits).toHaveLength(3);
		for (const edit of env.api.edits) expect(edit.markup).toEqual({ inline_keyboard: [] });

		// A second press on an answered task writes nothing.
		const changes = (await rig.entries.current()).doc.changes.length;
		env.api.push(
			press(
				"cb2004",
				ZY,
				"Zhou",
				GROUP,
				"supergroup",
				2001,
				`ci:d:${ids["Book movers"] ?? ""}:20261111`,
				asks[0]?.buttons ?? [],
			),
		);
		await env.api.waitCalls("answerCallbackQuery", 4);
		expect(env.api.answers[3]).toEqual({ id: "cb2004", text: "Already done." });

		// A stranger in the group can't press them: the first auth check answers.
		env.api.push(
			press("cb2005", STRANGER, "Stranger", GROUP, "supergroup", 2004, `ci:d:${ids["Old one"] ?? ""}:20261107`, []),
		);
		await env.api.waitCalls("answerCallbackQuery", 5);
		expect(env.api.answers[4]?.text).toContain("not on this bot's list");
		expect((await rig.entries.current()).doc.changes).toHaveLength(changes);

		// The Undo under a Done reply puts the task back.
		const undo = after[4]?.buttons[0]?.callback_data ?? "";
		env.api.push(press("cb2006", ZY, "Zhou", GROUP, "supergroup", 2005, undo, after[4]?.buttons ?? []));
		await env.api.waitSent(8);
		expect(await entryOf("Book movers")).toMatchObject({ status: "todo", completed: null });

		// None of this asked the model.
		expect(env.llm.requests).toHaveLength(0);
		// And the day's record was left alone: `/checkin` is not the scheduled one (§13.5).
		await expect(theCheckinRecord(rig)).rejects.toThrow();
		expect(checkinOf(rig)).toBeDefined();
	});
});

describe("TestCheckinCapsAskMessages", () => {
	it("sends the summary and eight asks, and lists the rest", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { now: () => CI_NOW, checkin: {} });
		const items: Patch[] = [];
		for (let i = 1; i <= 10; i++) items.push(task(`Task ${String(i).padStart(2, "0")}`, "2026-11-11"));
		await seedTasks(rig, items);

		env.api.push(privateMessage(ZY, "Zhou", "/checkin"));
		const sent = await env.api.waitSent(9);
		await new Promise((done) => setTimeout(done, 200));
		// The summary plus eight asks: the ninth and tenth are only listed.
		expect(env.api.sent).toHaveLength(9);
		const sum = sent[0]?.text ?? "";
		expect(sum).toContain("Not marked done yet (10)");
		expect(sum).toContain("Also open from earlier days:\n• Task 09 — Wed 11 Nov\n• Task 10 — Wed 11 Nov");
	});
});

describe("TestCheckinQuietDayAndTypedReply", () => {
	it("says there is nothing to report, and a reply in words reaches the agent with the check-in", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { now: () => CI_NOW, checkin: {}, prompt: true });
		env.api.push(privateMessage(ZY, "Zhou", "/checkin"));
		const quiet = await env.api.waitSent(1);
		expect(quiet[0]?.text).toBe("Nothing dated for today, and no open tasks from before.");

		await seedTasks(rig, [task("Book movers", "2026-11-11")]);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/checkin", 60));
		await env.api.waitSent(3);
		// A reply in words reaches the agent together with the check-in it answers.
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "booked them yesterday", 61));
		// The request, not the reply: the note's own header says "chat", which the
		// scripted model answers with silence (a group turn needs nothing recorded).
		await until(() => env.llm.requests.length >= 1, "the reply's turn");

		expect(env.llm.requests).toHaveLength(1);
		const asked = (env.llm.requests[0]?.messages ?? []).map((m) => String(m.content)).join("\n");
		expect(asked).toContain("Good morning!");
		expect(asked).toContain("Asked about:\n• Yesterday: Book movers");
	});
});

describe("TestCheckinButtonAfterTheTaskMoved", () => {
	it("changes nothing for a task that moved, and answers with Go's toast", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { now: () => CI_NOW, checkin: {} });
		const ids = await seedTasks(rig, [task("Book movers", "2026-11-11")]);

		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/checkin", 70));
		const sent = await env.api.waitSent(2);
		const tomorrow = sent[1]?.buttons[2]?.callback_data ?? "";
		expect(tomorrow).toBe(`ci:r:${ids["Book movers"] ?? ""}:20261111:1`);

		// Moved to Friday in the chat or on the web page.
		const id = ids["Book movers"] ?? "";
		await rig.entries.update({ by: "Partner", channel: "web" }, id, { date: "2026-11-13" });
		const changes = (await rig.entries.current()).doc.changes.length;

		env.api.push(press("cb3001", ZY, "Zhou", GROUP, "supergroup", 3001, tomorrow, sent[1]?.buttons ?? []));
		await env.api.waitCalls("answerCallbackQuery", 1);
		expect(env.api.answers[0]).toEqual({
			id: "cb3001",
			text: "That task was moved since (Fri 13 Nov), so I left it.",
		});

		env.api.push(press("cb3002", ZY, "Zhou", GROUP, "supergroup", 3002, `ci:d:${id}:20261111`, sent[1]?.buttons ?? []));
		await env.api.waitCalls("answerCallbackQuery", 2);
		// Malformed data (an old button without the date) does nothing either.
		env.api.push(press("cb3003", ZY, "Zhou", GROUP, "supergroup", 3003, `ci:d:${id}`, sent[1]?.buttons ?? []));
		await env.api.waitCalls("answerCallbackQuery", 3);
		expect(env.api.answers[2]).toEqual({ id: "cb3003", text: "" });
		await new Promise((done) => setTimeout(done, 200));

		// Nothing was written, and the entry is still the moved one.
		const doc = (await rig.entries.current()).doc;
		expect(doc.changes).toHaveLength(changes);
		expect(doc.entries.find((entry) => entry.id === id)).toMatchObject({ date: "2026-11-13", status: "todo" });
	});
});

describe("the check-in's precondition runs inside the write", () => {
	it("refuses a press whose task was moved while the press was in flight", async () => {
		const env = await newEnv();
		let id = "";
		let moved = false;
		// The web page saves the new date between the press's read and its write.
		const rig = await startRig(env, {
			now: () => CI_NOW,
			checkin: {},
			raceEntries: async (inner) => {
				if (moved) return;
				moved = true;
				await inner.update({ by: "Partner", channel: "web" }, id, { date: "2026-11-13" });
			},
		});
		const ids = await seedTasks(rig, [task("Book movers", "2026-11-11")]);
		id = ids["Book movers"] ?? "";

		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/checkin", 95));
		const sent = await env.api.waitSent(2);
		const changes = (await rig.entries.current()).doc.changes.length;

		env.api.push(press("cbr1", ZY, "Zhou", GROUP, "supergroup", 1002, `ci:d:${id}:20261111`, sent[1]?.buttons ?? []));
		await env.api.waitCalls("answerCallbackQuery", 1);
		// The check sees the entry as the write found it — moved — so nothing is saved.
		expect(env.api.answers[0]).toEqual({
			id: "cbr1",
			text: "That task was moved since (Fri 13 Nov), so I left it.",
		});
		const doc = (await rig.entries.current()).doc;
		// One change for the other writer's edit, and none for the press.
		expect(doc.changes).toHaveLength(changes + 1);
		expect(doc.entries.find((entry) => entry.id === id)).toMatchObject({ status: "todo", date: "2026-11-13" });
	});
});

describe("TestCheckinDuringAnAgentTurnKeepsBoth", () => {
	it("keeps the hello and the check-in when the tick lands mid-turn", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { now: () => CI_NOW, checkin: {}, prompt: true });
		await seedTasks(rig, [task("Book movers", "2026-11-11")]);
		env.llm.delay = 400;

		env.api.push(groupMessage(GROUP, ZY, "Zhou", "hello there", 80));
		await until(() => env.llm.requests.length > 0, "the agent turn to start");
		// The check-in lands while the turn is still answering: both its messages go out.
		await checkinOf(rig).tick();
		await env.api.waitSent(2);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "booked them", 81));
		await until(() => env.llm.requests.length >= 2, "the next turn");

		const last = (env.llm.requests.at(-1)?.messages ?? []).map((m) => String(m.content)).join("\n");
		expect(last).toContain("hello there");
		expect(last).toContain("Good morning!");
	});
});

describe("the check-in's buttons are at-most-once", () => {
	it("answers a redelivered press once and writes once", async () => {
		const env = await newEnv();
		const rig = await startRig(env, { now: () => CI_NOW, checkin: {} });
		const ids = await seedTasks(rig, [task("Book movers", "2026-11-11")]);
		env.api.push(groupMessage(GROUP, ZY, "Zhou", "/checkin", 90));
		const sent = await env.api.waitSent(2);

		const id = ids["Book movers"] ?? "";
		const update = {
			...press("cbd1", ZY, "Zhou", GROUP, "supergroup", 1001, `ci:d:${id}:20261111`, sent[1]?.buttons ?? []),
			update_id: 500,
		};
		env.api.push(update);
		await env.api.waitSent(3);
		await env.api.waitCalls("answerCallbackQuery", 1);

		// Telegram hands the same press out again: a crash before the offset moved.
		env.api.redeliver(update);
		await new Promise((done) => setTimeout(done, 400));
		expect(env.api.answers).toHaveLength(1);
		expect(env.api.edits).toHaveLength(1);
		expect(env.api.sent).toHaveLength(3);
		const journal = await rig.entries.recent(10);
		expect(journal.filter((change) => change.op === "update")).toHaveLength(1);
	});
});

describe("the check-in's view on the admin page", () => {
	it("is Go's CheckinView in Go's field order", async () => {
		const env = await newEnv();
		// Yesterday's record, written before the rig opens: a bot that has sent a
		// check-in already shows it as `last`. The clock is before 09:30 so nothing
		// writes one behind the test's back.
		const store = createMemoryStore();
		const before = new CheckinStore(store);
		const claimed = await before.claim("2026-11-11", `${GROUP}`, new Date("2026-11-11T09:30:00Z"));
		if (claimed.claim === null) throw new Error("the record could not be claimed");
		await before.finish(claimed.claim, "sent", new Date("2026-11-11T09:30:05Z"));
		const rig = await startRig(env, { now: () => new Date("2026-11-12T08:00:00Z"), checkin: { store } });
		await rig.settings.saveCheckin("zy@example.com", { schedule: "10:00", chat: "", useEnv: false });
		// on, at, until, chat: the order Go's struct has (checkin.go:434-445).
		expect(goMarshal(await rig.bot.checkinStatus())).toBe(
			'{"on":true,"at":"10:00","until":"20:00","chat":"-1001",' +
				'"last":{"schema":1,"day":"2026-11-11","status":"sent","at":"2026-11-11T09:30:05Z","chat":"-1001"}}',
		);

		// The record the day left comes last, with Go's own field order inside it.
		expect(goMarshal(await rig.bot.checkinStatus())).toBe(
			'{"on":true,"at":"10:00","until":"20:00","chat":"-1001",' +
				'"last":{"schema":1,"day":"2026-11-11","status":"sent","at":"2026-11-11T09:30:05Z","chat":"-1001"}}',
		);

		// A chat that is not on the allowlist is an error, and there is no `chat` then.
		await rig.settings.saveCheckin("zy@example.com", { schedule: "10:00", chat: "-999", useEnv: false });
		expect(goMarshal(await rig.bot.checkinStatus())).toBe(
			'{"on":true,"at":"10:00","until":"20:00",' +
				'"error":"the check-in chat -999 is not an allowed group or person (Settings → Telegram)",' +
				'"last":{"schema":1,"day":"2026-11-11","status":"sent","at":"2026-11-11T09:30:05Z","chat":"-1001"}}',
		);

		// Off: nothing but the cutoff and the record.
		await rig.settings.saveCheckin("zy@example.com", { schedule: "off", chat: "", useEnv: false });
		expect(goMarshal(await rig.bot.checkinStatus())).toBe(
			'{"on":false,"until":"20:00",' +
				'"last":{"schema":1,"day":"2026-11-11","status":"sent","at":"2026-11-11T09:30:05Z","chat":"-1001"}}',
		);
	});
});
