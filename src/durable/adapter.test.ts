// The durable adapter on pi-ai's faux provider (T3.2): one turn, a tool round,
// the forced answer, the idle reset, compaction, the directory, thinking,
// retries and the usage log. Every case uses a temp-file SQLite database and an
// injected clock; nothing reaches the network. The two stub cases at the end
// are the ones faux cannot show: the provider request body (pi-durable's
// beforeProviderRequest rides on pi-ai's onPayload, which the faux provider does
// not call) and the Authorization header an HTTP request really carries.
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message, ModelThinkingLevel, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { NOTES_HEADER, promptHooks } from "../agent/prompt.ts";
import { buildTools } from "../agent/tools.ts";
import { CLASS_TEXT, type Doc, emptyDoc, STATUS_OK } from "../docs/index.ts";
import { IMAGE_LIMIT_REPLY } from "../docs/render.ts";
import type { Library } from "../docs/search.ts";
import { createEntriesService, type EntriesService } from "../entries/service.ts";
import { goMarshal } from "../gojson.ts";
import { startStub } from "../llm/stub.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import {
	type Agent,
	type AgentEvent,
	type AgentHooks,
	abortDeliveries,
	abortSchedules,
	createScheduleTwice,
	EARLIER_IMAGE,
	IDLE_RESET_MS,
	INTAKE_DOC,
	type IntakeItem,
	inspectLive,
	inspectSchedules,
	isUnsettled,
	MAX_IMAGES_PER_RUN,
	markSchedules,
	NO_ACTOR,
	type Outbox,
	OutboxError,
	type OutboxJson,
	observeCommits,
	observeDocuments,
	openAgent,
	type RetryOptions,
	type RunResult,
	SCHEDULE_MAX_SLEEP_MS,
	type ScheduleInspection,
	type ScheduleSpec,
	type SettingsSource,
	scheduleOwners,
	type Timer,
	type ToolSpec,
	whenIdle,
} from "./adapter.ts";
import { createStartGuard, epochKey, type StartGuard } from "./startguard.ts";

/** One request a faux provider answered, as the test needs to see it. */
interface Request {
	messages: Message[];
	thinking: ModelThinkingLevel | undefined;
}

/** How a faux answer is chosen: the conversation so far, and which request this is. */
type Respond = (request: Request, index: number) => AssistantMessage | Promise<AssistantMessage>;

/** What one open agent needs from a test. */
interface Rig {
	agent: Agent;
	/** The file the agent runs on, so a test can open it again. */
	dbPath: string;
	faux: FauxProviderHandle;
	requests: Request[];
	lines: string[];
	close: () => Promise<void>;
}

const rigs: Rig[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const rig of rigs.splice(0)) await rig.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** source is the settings service a test hands the adapter: one fixed connection. */
function source(over: Partial<LLM> = {}): { resolve: () => Promise<LLM> } {
	const cfg: LLM = {
		...DEFAULTS,
		baseUrl: "http://faux.test/v1",
		model: "faux-1",
		apiKey: "sk-test-1234",
		...over,
	};
	return { resolve: async () => cfg };
}

/**
 * openOnStub starts one agent on src/llm/stub.ts: the only provider that shows a
 * request body (pi-durable's beforeProviderRequest) and its HTTP headers.
 */
async function openOnStub(
	origin: string,
	tools: readonly ToolSpec[],
	over: Partial<LLM> = {},
	hooks?: AgentHooks,
): Promise<Agent> {
	const dir = await mkdtemp(join(tmpdir(), "movin-t32-"));
	dirs.push(dir);
	const { log } = createTestLog();
	const agent = await openAgent({
		dbPath: join(dir, "harness.db"),
		settings: source({ baseUrl: `${origin}/v1`, apiKey: "sk-test-1234", maxToolRounds: 2, ...over }),
		log,
		tools,
		...(hooks === undefined ? {} : { hooks }),
	});
	rigs.push({ agent, dbPath: "", faux: fauxProvider(), requests: [], lines: [], close: () => agent.close() });
	return agent;
}

/**
 * open starts one agent on a fresh database, with the faux provider wired the
 * way production wires pi-ai: a Models collection, and the ref a conversation
 * stores. `answer` decides each response; `requests` records what the model saw.
 */
async function open(options: {
	answer: Respond;
	/** Reopen this database instead of a new one (a restart). */
	dbPath?: string;
	settings?: Partial<LLM>;
	/** A whole settings source, for the tests that change the connection mid-run. */
	source?: SettingsSource;
	hooks?: AgentHooks;
	tools?: readonly ToolSpec[];
	now?: () => number;
	retry?: RetryOptions;
	/** The harness's timer, when a test owns time as well as the clock. */
	setTimer?: Timer;
	/** The channel a delivery goes through; absent is a process that cannot send. */
	outbox?: Outbox;
	/** The scheduled jobs this process runs (T5.1b); absent is a process with none. */
	schedules?: readonly ScheduleSpec[];
	/** The restore guard (T5.3a); absent is a start that only creates the schedules. */
	startGuard?: StartGuard;
}): Promise<Rig> {
	const dir = await mkdtemp(join(tmpdir(), "movin-t32-"));
	dirs.push(dir);
	// A reopen (restart, crash) opens the same file again under a new agent.
	const dbPath = options.dbPath ?? join(dir, "harness.db");
	const { log, lines } = createTestLog();

	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const requests: Request[] = [];
	const factory = async (
		context: { messages: Message[] },
		streamOptions: SimpleStreamOptions | undefined,
	): Promise<AssistantMessage> => {
		const request: Request = { messages: context.messages, thinking: streamOptions?.reasoning };
		requests.push(request);
		return await options.answer(request, requests.length - 1);
	};
	// The faux provider shifts one step per request, so the script repeats.
	faux.setResponses(Array.from({ length: 64 }, () => factory));

	let agent: Agent | undefined;
	const make = async (): Promise<Agent> =>
		openAgent({
			dbPath,
			settings: options.source ?? source(options.settings ?? {}),
			log,
			...(options.now === undefined ? {} : { now: options.now }),
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.hooks === undefined ? {} : { hooks: options.hooks }),
			...(options.retry === undefined ? {} : { retry: options.retry }),
			...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
			...(options.outbox === undefined ? {} : { outbox: options.outbox }),
			...(options.schedules === undefined ? {} : { schedules: options.schedules }),
			...(options.startGuard === undefined ? {} : { startGuard: options.startGuard }),
			models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
		});
	agent = await make();
	const rig: Rig = {
		agent,
		dbPath,
		faux,
		requests,
		lines,
		close: async () => {
			await agent?.close();
		},
	};
	rigs.push(rig);
	return rig;
}

/** text of one message's content, for the assertions. */
function textOf(message: Message): string {
	if (typeof message.content === "string") return message.content;
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	return text;
}

/** texts of the tool results in a request, the way the model sees them. */
function toolResults(request: Request): string[] {
	return request.messages.filter((m) => m.role === "toolResult").map((m) => textOf(m));
}

/** userTexts of a request: the user turns the model was given. */
function userTexts(request: Request): string[] {
	return request.messages.filter((m) => m.role === "user").map((m) => textOf(m));
}

/** usageLines are the `llm call` lines the adapter logged. */
function usageLines(lines: string[]): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === "llm call");
}

/** answer is a responder that answers text and nothing else. */
function say(text: string): Respond {
	return (): AssistantMessage => fauxAssistantMessage(fauxText(text));
}

/** refusing is a content-filtered answer: pi-ai's error stop with its raw reason kept. */
function refusing(text: string): AssistantMessage {
	return {
		...fauxAssistantMessage(fauxText(text), {
			stopReason: "error",
			errorMessage: "Provider finish_reason: content_filter",
		}),
		rawStopReason: "content_filter",
	};
}

describe("one turn", () => {
	it("answers, streams deltas, logs the round and reads the history back", async () => {
		const rig = await open({ answer: say("Hello there.") });
		const events: AgentEvent[] = [];
		const result = await rig.agent.submit("web:zy@example.com", "hi", { onEvent: (e) => events.push(e) });

		expect(result).toMatchObject({ status: "answered", text: "Hello there.", stop: "end" });
		if (result.status !== "answered") throw new Error("not answered");
		// faux reports estimated usage, so the run's spend is the prompt plus the answer.
		expect(result.usage.in + result.usage.cacheRead + result.usage.cacheWrite).toBeGreaterThan(0);
		expect(result.usage.out).toBeGreaterThan(0);

		const deltas = events.filter((e) => e.type === "delta").map((e) => ("text" in e ? e.text : ""));
		expect(deltas.join("")).toBe("Hello there.");

		const page = await rig.agent.history("web:zy@example.com", { limit: 10 });
		expect(page).toMatchObject({ more: false });
		expect(page.items.map((item) => [item.role, item.text])).toEqual([
			["assistant", "Hello there."],
			["user", "hi"],
		]);
		expect(page.items.every((item) => typeof item.at === "number" && item.at > 0)).toBe(true);

		// Go's line, once per round, numbered from 1 (agent.go:181-191).
		const calls = usageLines(rig.lines);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({ kind: "openai", model: "faux-1", round: 1, stop: "end" });
	});

	it("returns the earlier answer for a repeated requestId instead of asking again", async () => {
		const rig = await open({ answer: say("once") });
		const first = await rig.agent.submit("web:zy@example.com", "hi", { requestId: "tg:1" });
		const second = await rig.agent.submit("web:zy@example.com", "hi", { requestId: "tg:1" });
		expect(second).toEqual(first);
		expect(rig.faux.state.callCount).toBe(1);
	});
});

describe("a tool round", () => {
	it("hands the tool its task id, call id, epoch and key, and its result back to the model", async () => {
		const seen: { taskId: string; callId: string; epoch: string; key: string; signal: boolean }[] = [];
		const rig = await open({
			tools: [
				{
					name: "echo",
					description: "Repeat the text back.",
					parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
					replay: "safe",
					writes: false,
					execute: async (args, ctx) => {
						seen.push({
							taskId: ctx.taskId,
							callId: ctx.callId,
							epoch: ctx.epoch,
							key: ctx.conversationKey,
							signal: ctx.signal !== undefined,
						});
						return { text: `echo: ${(args as { text: string }).text}` };
					},
				},
			],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("Saved it."))
					: fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
		});

		const result = await rig.agent.submit("tg:4242", "add it");
		expect(result).toMatchObject({ status: "answered", text: "Saved it." });

		expect(seen).toHaveLength(1);
		expect(seen[0]?.taskId).toMatch(/^\d+$/);
		expect(seen[0]?.callId).not.toBe("");
		expect(seen[0]?.epoch).toBe(rig.agent.epoch);
		expect(seen[0]?.key).toBe("tg:4242");
		expect(seen[0]?.signal).toBe(true);

		// The tool's result is in the second request, and the rounds are numbered 1, 2.
		expect(rig.requests).toHaveLength(2);
		expect(toolResults(rig.requests[1] as Request)).toEqual(["echo: hello"]);
		expect(usageLines(rig.lines).map((line) => line.round)).toEqual([1, 2]);
		expect(usageLines(rig.lines).map((line) => line.stop)).toEqual(["tool", "end"]);
	});

	it("turns a beforeTool block into an error result the model reads", async () => {
		let ran = false;
		const rig = await open({
			hooks: {
				beforeTool: async (key, call) => {
					expect(key).toBe("web:zy@example.com");
					expect(call.name).toBe("echo");
					return "not allowed from this chat";
				},
			},
			tools: [
				{
					name: "echo",
					description: "Repeat the text back.",
					parameters: { type: "object", properties: { text: { type: "string" } } },
					replay: "safe",
					writes: false,
					execute: async () => {
						ran = true;
						return { text: "should not run" };
					},
				},
			],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("Understood."))
					: fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
		});

		expect(await rig.agent.submit("web:zy@example.com", "add it")).toMatchObject({
			status: "answered",
			text: "Understood.",
		});
		expect(ran).toBe(false);
		const results = toolResults(rig.requests[1] as Request);
		expect(results).toHaveLength(1);
		expect(results[0]).toContain("Tool call blocked: not allowed from this chat");
	});

	it("gives the model an error result for a tool it does not have", async () => {
		const rig = await open({
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("No such tool."))
					: fauxAssistantMessage(fauxToolCall("teleport", {}), { stopReason: "toolUse" }),
		});
		const result = await rig.agent.submit("web:zy@example.com", "go");
		expect(result).toMatchObject({ status: "answered", text: "No such tool." });
		expect(toolResults(rig.requests[1] as Request)[0]).toContain("Tool teleport is not available");
	});
});

describe("restart", () => {
	it("keeps the history and sends the earlier turns again", async () => {
		const rig = await open({ answer: say("first answer") });
		await rig.agent.submit("web:zy@example.com", "first message");
		const before = await rig.agent.history("web:zy@example.com", { limit: 10 });

		// Close and reopen the same file: the transcript is on disk, not in memory.
		const dbPath = rig.dbPath;
		await rig.agent.close();
		const reopened = await open({ dbPath, answer: say("second answer") });
		expect(await reopened.agent.history("web:zy@example.com", { limit: 10 })).toEqual(before);

		await reopened.agent.submit("web:zy@example.com", "second message");
		const texts = userTexts(reopened.requests[0] as Request);
		expect(texts).toEqual(["first message", "second message"]);
		expect((await reopened.agent.history("web:zy@example.com", { limit: 10 })).items).toHaveLength(4);
	});
});

describe("the idle reset", () => {
	it("keeps the context below 6 hours and starts a new one above it", async () => {
		let clock = 1_700_000_000_000;
		const freshes: boolean[] = [];
		const rig = await open({
			now: () => clock,
			hooks: {
				userContent: async (_key, text, { fresh }) => {
					freshes.push(fresh);
					return { content: text, state: undefined };
				},
			},
			answer: say("ok"),
		});

		await rig.agent.submit("web:zy@example.com", "turn one");
		expect(freshes).toEqual([true]);

		// 5h59m later: still the same context, so the model sees turn one.
		clock += 5 * 60 * 60 * 1000 + 59 * 60 * 1000;
		await rig.agent.submit("web:zy@example.com", "turn two");
		expect(freshes).toEqual([true, false]);
		expect(userTexts(rig.requests[1] as Request)).toEqual(["turn one", "turn two"]);

		// 6h01m after the last activity: a reset, so the model sees only turn three.
		clock += 6 * 60 * 60 * 1000 + 60 * 1000;
		await rig.agent.submit("web:zy@example.com", "turn three");
		expect(freshes).toEqual([true, false, true]);
		const afterReset = rig.requests[2] as Request;
		expect(userTexts(afterReset)).toEqual(["turn three"]);
		expect(afterReset.messages.some((m) => m.role === "assistant")).toBe(false);

		// The history keeps what the context dropped: a reset is not a delete.
		expect((await rig.agent.history("web:zy@example.com", { limit: 10 })).items).toHaveLength(6);
	});
});

describe("reset and paging", () => {
	it("starts a new context on reset while the history keeps everything", async () => {
		const freshes: boolean[] = [];
		const rig = await open({
			hooks: {
				userContent: async (_key, text, { fresh }) => {
					freshes.push(fresh);
					return { content: text, state: undefined };
				},
			},
			answer: say("ok"),
		});
		await rig.agent.submit("web:zy@example.com", "turn one");
		await rig.agent.reset("web:zy@example.com");
		await rig.agent.submit("web:zy@example.com", "turn two");
		expect(freshes).toEqual([true, true]);
		expect(userTexts(rig.requests[1] as Request)).toEqual(["turn two"]);
		expect((await rig.agent.history("web:zy@example.com", { limit: 10 })).items.map((item) => item.text)).toEqual([
			"ok",
			"turn two",
			"ok",
			"turn one",
		]);
	});

	it("pages the history by entry id, because a frozen clock makes at repeat", async () => {
		// The harness clock is frozen for the user turns, while an answer's timestamp
		// is pi-ai's wall clock: `at` cannot order a page. The second page starts at
		// the user turn "two", whose `at` every older answer exceeds — a timestamp
		// cursor would skip the whole rest of the history.
		const clock = 1_700_000_000_000;
		const rig = await open({ answer: say("ok"), now: () => clock });
		for (const text of ["one", "two", "three"]) await rig.agent.submit("web:zy@example.com", text);

		const first = await rig.agent.history("web:zy@example.com", { limit: 4 });
		expect(first.items.map((item) => item.text)).toEqual(["ok", "three", "ok", "two"]);
		expect(first.more).toBe(true);
		expect(first.items.filter((item) => item.role === "user").map((item) => item.at)).toEqual([clock, clock]);

		const oldest = first.items.at(-1);
		if (oldest === undefined) throw new Error("no item");
		const rest = await rig.agent.history("web:zy@example.com", { limit: 10, before: oldest.id });
		expect(rest.items.map((item) => item.text)).toEqual(["ok", "one"]);
		expect(rest.more).toBe(false);
		// The cursor does not repeat the item it starts from.
		expect(rest.items.map((item) => item.id)).not.toContain(oldest.id);
	});
});

describe("compaction", () => {
	it("compacts a conversation past the context budget, and the next run starts fresh", async () => {
		const long = "walls and tiles and sockets and paint. ";
		const freshes: boolean[] = [];
		const rig = await open({
			hooks: {
				userContent: async (_key, text, { fresh }) => {
					freshes.push(fresh);
					return { content: text, state: undefined };
				},
			},
			answer: (request) =>
				// The summariser asks for a structured checkpoint; everything else answers.
				request.messages[0] !== undefined &&
				request.messages[0].role === "system" &&
				textOf(request.messages[0]).includes("context summarization assistant")
					? fauxAssistantMessage(fauxText("Earlier turns: the owner listed the renovation work."))
					: fauxAssistantMessage(fauxText("noted")),
		});

		// About 17k tokens a turn: the budget (48k) is crossed on the third.
		const turn = `one: ${long.repeat(2000)}`;
		const second = `two: ${long.repeat(2000)}`;
		const third = `three: ${long.repeat(2000)}`;
		await rig.agent.submit("web:zy@example.com", turn);
		await rig.agent.submit("web:zy@example.com", second);
		expect(freshes).toEqual([true, false]);

		await rig.agent.submit("web:zy@example.com", third);
		const compacted = rig.requests.some((request) =>
			request.messages.some((m) => textOf(m).includes("compacted into the following summary")),
		);
		expect(compacted).toBe(true);

		// The run after the compaction starts a fresh context: the snapshot goes again.
		await rig.agent.submit("web:zy@example.com", "four");
		expect(freshes).toEqual([true, false, false, true]);
		const last = rig.requests.at(-1) as Request;
		expect(userTexts(last).at(-1)).toBe("four");
		expect(userTexts(last)[0]).toContain("compacted into the following summary");
		expect(userTexts(last).some((text) => text.startsWith("one: "))).toBe(false);
	});
});

describe("the directory", () => {
	it("gives two keys two conversations and one key one conversation", async () => {
		const rig = await open({ answer: say("ok") });
		const conversations: (number | undefined)[] = [];
		const stop = observeDocuments(rig.agent, (change) => {
			if (change.kind === "pi.agent") conversations.push(change.conversationId);
		});
		try {
			await rig.agent.submit("web:zy@example.com", "web turn");
			await rig.agent.submit("web:zy@example.com", "web turn again");
			await rig.agent.submit("tg:99", "telegram turn");
		} finally {
			stop();
		}
		// One conversation was configured for the web key, a different one for Telegram.
		const distinct = [...new Set(conversations)];
		expect(distinct).toHaveLength(2);
		expect((await rig.agent.history("web:zy@example.com", { limit: 10 })).items.map((i) => i.text)).toEqual([
			"ok",
			"web turn again",
			"ok",
			"web turn",
		]);
		expect((await rig.agent.history("tg:99", { limit: 10 })).items.map((i) => i.text)).toEqual(["ok", "telegram turn"]);
	});
});

describe("thinking", () => {
	it("sets the level per turn and writes no configure commit when it does not change", async () => {
		const rig = await open({ settings: { thinkOnDemand: true }, answer: say("ok") });
		const agentChanges: string[] = [];
		const stop = observeDocuments(rig.agent, (change) => {
			if (change.kind === "pi.agent") agentChanges.push(change.kind);
		});
		try {
			// Creating a conversation writes its own pi.agent; this counts from the
			// second turn, which must configure nothing at all.
			await rig.agent.submit("web:zy@example.com", "plain");
			agentChanges.length = 0;
			await rig.agent.submit("web:zy@example.com", "plain again");
			expect(agentChanges).toEqual([]);
			await rig.agent.submit("web:zy@example.com", "/think", { think: true });
		} finally {
			stop();
		}
		// off, off (no commit), then medium (one commit).
		expect(rig.requests.map((request) => request.thinking)).toEqual([undefined, undefined, "medium"]);
		expect(agentChanges).toHaveLength(1);
	});

	it("thinks on every turn when the setting does not gate it", async () => {
		const rig = await open({ settings: { thinkOnDemand: false }, answer: say("ok") });
		await rig.agent.submit("web:zy@example.com", "plain");
		expect(rig.requests[0]?.thinking).toBe("medium");
	});
});

describe("retries", () => {
	it("retries a transport drop, reports it, and answers", async () => {
		const events: AgentEvent[] = [];
		const rig = await open({
			retry: { baseDelayMs: 1 },
			answer: (_request, index) =>
				index === 0
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated: other side closed" })
					: fauxAssistantMessage(fauxText("answered on the second try")),
		});
		const result = await rig.agent.submit("web:zy@example.com", "hi", { onEvent: (e) => events.push(e) });

		expect(result).toMatchObject({ status: "answered", text: "answered on the second try" });
		expect(events.some((event) => event.type === "retry")).toBe(true);
		// Two rounds were spent: the failed attempt and the answer (agent-spec §1.9).
		expect(usageLines(rig.lines).map((line) => line.round)).toEqual([1, 1]);
		expect(usageLines(rig.lines)[0]?.stop).toBe("end");
	});

	it("fails a quota error at once, with the key scrubbed out of the detail", async () => {
		const rig = await open({
			retry: { baseDelayMs: 1 },
			answer: (): AssistantMessage =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "insufficient_quota: the key sk-test-1234 is over its budget",
				}),
		});
		const result = await rig.agent.submit("web:zy@example.com", "hi");

		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("not failed");
		expect(result.reason).toBe("model_error");
		expect(result.detail).toContain("insufficient_quota");
		expect(result.detail).not.toContain("sk-test-1234");
		expect(result.detail).toContain("[redacted]");
		// Not retried: one attempt only (pi-ai's retry classifier, decisions.md · T3.1).
		expect(rig.faux.state.callCount).toBe(1);
	});

	it("counts what a failed run spent, so chateval can print its usage", async () => {
		const echo = {
			name: "echo",
			description: "Repeat the text back.",
			parameters: { type: "object", properties: { text: { type: "string" } } },
			replay: "safe" as const,
			writes: false,
			execute: async (args: unknown) => ({ text: `echo: ${(args as { text: string }).text}` }),
		};
		const rig = await open({
			retry: { baseDelayMs: 1 },
			tools: [echo],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" })
					: fauxAssistantMessage(fauxToolCall("echo", { text: "hi" }), { stopReason: "toolUse" }),
		});
		const result = await rig.agent.submit("web:zy@example.com", "hi");

		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("not failed");
		expect(result.reason).toBe("model_error");
		// Go's turn kept the usage of what it spent before the failure
		// (agent.go:181-191), which chateval prints (agent-spec §6.5).
		expect(result.usage.in + result.usage.cacheRead + result.usage.cacheWrite).toBeGreaterThan(0);
		expect(result.usage.out).toBeGreaterThan(0);
		expect(usageLines(rig.lines).map((line) => line.round)).toEqual([1, 2]);
		expect(result.toolsUsed).toEqual(["echo"]);
	});
});

// The two cases below need a request body and its headers, which only a real
// HTTP provider produces: pi-durable's beforeProviderRequest rides on pi-ai's
// onPayload callback, and the faux provider never calls it
// (providers/faux.js, stream(): only onResponse), so src/llm/stub.ts stands in.
describe("the forced final answer", () => {
	const echo = {
		name: "echo",
		description: "Repeat the text back.",
		parameters: { type: "object", properties: { text: { type: "string" } } },
		replay: "safe" as const,
		writes: false,
		execute: async (): Promise<{ text: string }> => ({ text: "echo" }),
	};

	it("sends tool_choice none on request N+1 when the model keeps calling tools", async () => {
		const stub = await startStub();
		try {
			// MaxToolRounds 2, so three requests; the third carries the flag.
			stub.answer(
				{ kind: "toolCalls", calls: [{ name: "echo", arguments: '{"text":"a"}' }] },
				{ kind: "toolCalls", calls: [{ name: "echo", arguments: '{"text":"b"}' }] },
				{ kind: "text", text: "here is the answer" },
			);
			const agent = await openOnStub(stub.origin, [echo]);
			const result = await agent.submit("web:zy@example.com", "keep going");

			expect(stub.requests).toHaveLength(3);
			expect(stub.requests.map((request) => request.body.tool_choice)).toEqual([undefined, undefined, "none"]);
			expect(result).toMatchObject({ status: "answered", text: "here is the answer" });
		} finally {
			await stub.close();
		}
	});

	it("still runs the tools a model calls on the forced round and ends turn_limit", async () => {
		// The known difference from Go, which ignores those calls (T3.2.md G2).
		const stub = await startStub();
		try {
			stub.answer({ kind: "toolCalls", calls: [{ name: "echo", arguments: '{"text":"a"}' }] });
			const agent = await openOnStub(stub.origin, [echo]);
			const result = await agent.submit("web:zy@example.com", "never stop");

			expect(stub.requests).toHaveLength(3);
			expect(stub.requests[2]?.body.tool_choice).toBe("none");
			expect(result.status).toBe("failed");
			if (result.status !== "failed") throw new Error("not failed");
			expect(result.reason).toBe("turn_limit");
		} finally {
			await stub.close();
		}
	});
});

describe("the keyless connection through the harness", () => {
	it("sends no Authorization header without a key, and a Bearer with one", async () => {
		const stub = await startStub();
		try {
			for (const apiKey of ["", "sk-test-1234"]) {
				stub.answer({ kind: "text", text: "ok" });
				const dir = await mkdtemp(join(tmpdir(), "movin-t32-"));
				dirs.push(dir);
				const { log } = createTestLog();
				const agent = await openAgent({
					dbPath: join(dir, "harness.db"),
					settings: source({ baseUrl: `${stub.origin}/v1`, apiKey }),
					log,
				});
				rigs.push({ agent, dbPath: "", faux: fauxProvider(), requests: [], lines: [], close: () => agent.close() });
				const result = await agent.submit("web:zy@example.com", "hi");
				expect(result).toMatchObject({ status: "answered", text: "ok" });
			}
			expect(stub.requests).toHaveLength(2);
			expect(stub.requests[0]?.headers.authorization).toBeUndefined();
			expect(stub.requests[1]?.headers.authorization).toBe("Bearer sk-test-1234");
		} finally {
			await stub.close();
		}
	});
});

describe("events of a second turn", () => {
	it("replays nothing from the turn before and ends without a reset", async () => {
		const rig = await open({
			answer: (request) =>
				fauxAssistantMessage(fauxText(userTexts(request).at(-1) === "first" ? "first answer" : "second answer")),
		});
		await rig.agent.submit("web:zy@example.com", "first");

		const events: AgentEvent[] = [];
		const result = await rig.agent.submit("web:zy@example.com", "second", { onEvent: (e) => events.push(e) });
		expect(result).toMatchObject({ status: "answered", text: "second answer" });
		// Exactly the new answer: the old one is not a delta, and no `reset` tells the
		// client to drop the answer it just showed.
		expect(events).toEqual([{ type: "delta", text: "second answer" }]);
	});
});

describe("errors, aborts and shutdown", () => {
	it("scrubs the key out of a retry event, in Go's error form", async () => {
		const events: AgentEvent[] = [];
		const rig = await open({
			retry: { baseDelayMs: 1 },
			answer: (_request, index) =>
				index === 0
					? fauxAssistantMessage("", {
							stopReason: "error",
							errorMessage: '503: {"message":"upstream rejected sk-test-1234"}',
						})
					: fauxAssistantMessage(fauxText("fine")),
		});
		const result = await rig.agent.submit("web:zy@example.com", "hi", { onEvent: (e) => events.push(e) });
		expect(result).toMatchObject({ status: "answered", text: "fine" });

		const retry = events.find((event) => event.type === "retry");
		if (retry === undefined || retry.type !== "retry") throw new Error("no retry event");
		expect(retry.error).toBe("endpoint returned 503: upstream rejected [redacted]");
	});

	it("aborts the run when the signal fires", { timeout: 15_000 }, async () => {
		const stub = await startStub();
		try {
			// A request that never answers: the abort is the only way out.
			stub.answer({ kind: "hang" });
			const agent = await openOnStub(stub.origin, []);
			const controller = new AbortController();
			const pending = agent.submit("web:zy@example.com", "hi", { signal: controller.signal });
			setTimeout(() => controller.abort(), 150);

			const result = await pending;
			expect(result.status).toBe("failed");
			if (result.status !== "failed") throw new Error("not failed");
			expect(result.reason).toBe("aborted");
		} finally {
			await stub.close();
		}
	});

	it("never submits a turn whose signal fired while it waited in the queue", { timeout: 20_000 }, async () => {
		const stub = await startStub();
		try {
			// The first turn hangs; the second waits behind it in the per-key chain.
			stub.answer({ kind: "hang" });
			const agent = await openOnStub(stub.origin, []);
			const first = new AbortController();
			const running = agent.submit("web:zy@example.com", "the long turn", { signal: first.signal });

			// Wait until the first turn's request is out, so the second is provably queued.
			for (let i = 0; i < 100 && stub.requests.length === 0; i++) {
				await new Promise((done) => setTimeout(done, 20));
			}
			expect(stub.requests).toHaveLength(1);
			const queued = new AbortController();
			const waiting = agent.submit("web:zy@example.com", "the abandoned turn", { signal: queued.signal });
			await new Promise((done) => setImmediate(done));
			queued.abort();

			first.abort();
			await running;

			// The queued turn was stopped before it submitted: a result, no request.
			expect(await waiting).toEqual({
				status: "failed",
				reason: "aborted",
				detail: "",
				usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
				changes: [],
				toolsUsed: [],
			});
			expect(stub.requests).toHaveLength(1);
			const texts = (await agent.history("web:zy@example.com", { limit: 10 })).items.map((item) => item.text);
			expect(texts).not.toContain("the abandoned turn");
		} finally {
			await stub.close();
		}
	});

	it("answers a run a close cut short with a failed result, not a rejection", { timeout: 15_000 }, async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const agent = await openOnStub(stub.origin, []);
			const pending = agent.submit("web:zy@example.com", "hi");
			await new Promise((done) => setTimeout(done, 50));
			await agent.close();

			const result = await pending;
			// The session rejects while the run waits, so the turn ends `closed` with
			// the scrubbed text of that rejection: a result, never a throw.
			expect(result).toMatchObject({ status: "failed", reason: "closed", detail: "Harness is closed" });
		} finally {
			await stub.close();
		}
	});

	it("logs an abort that races a close instead of crashing the process", { timeout: 15_000 }, async () => {
		const rejections: unknown[] = [];
		const onRejection = (err: unknown): void => {
			rejections.push(err);
		};
		process.on("unhandledRejection", onRejection);
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const agent = await openOnStub(stub.origin, []);
			const controller = new AbortController();
			const pending = agent.submit("web:zy@example.com", "hi", { signal: controller.signal });
			await new Promise((done) => setTimeout(done, 50));

			// The abort lands while the harness is closing: submission.abort() and
			// conversation.abort() both reject, and neither may float.
			const closing = agent.close();
			controller.abort();
			await closing;
			await expect(pending).resolves.toMatchObject({ status: "failed" });
			await new Promise((done) => setTimeout(done, 100));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
			await stub.close();
		}
	});
});

describe("one key at a time", () => {
	it("keeps two first submits for one key in one conversation, the second seeing the first", async () => {
		const rig = await open({ answer: say("ok") });
		const conversations: (number | undefined)[] = [];
		const stop = observeDocuments(rig.agent, (change) => {
			if (change.kind === "pi.agent") conversations.push(change.conversationId);
		});
		try {
			const results = await Promise.all([rig.agent.submit("tg:7", "first"), rig.agent.submit("tg:7", "second")]);
			expect(results.map((result) => result.status)).toEqual(["answered", "answered"]);
		} finally {
			stop();
		}
		expect([...new Set(conversations)]).toHaveLength(1);
		expect((await rig.agent.history("tg:7", { limit: 10 })).items.map((item) => item.text)).toEqual([
			"ok",
			"second",
			"ok",
			"first",
		]);
		// The second turn ran in the first turn's context, not in a conversation of its own.
		expect(userTexts(rig.requests[1] as Request)).toEqual(["first", "second"]);
	});

	it("applies a reset after the run it overlaps, leaving that run untouched", async () => {
		const rig = await open({ answer: say("ok") });
		const [result] = await Promise.all([
			rig.agent.submit("web:zy@example.com", "one"),
			rig.agent.reset("web:zy@example.com"),
		]);
		expect(result).toMatchObject({ status: "answered", text: "ok" });

		await rig.agent.submit("web:zy@example.com", "two");
		expect(userTexts(rig.requests[1] as Request)).toEqual(["two"]);
	});

	it("reads the history while a turn is still running, and never creates one", { timeout: 15_000 }, async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const agent = await openOnStub(stub.origin, []);
			const controller = new AbortController();
			const pending = agent.submit("web:zy@example.com", "typed while running", { signal: controller.signal });
			// The request is only sent once the input's entry is committed, so this is
			// "the run has started", without any guess about timing.
			for (let i = 0; i < 100 && stub.requests.length === 0; i++) {
				await new Promise((done) => setTimeout(done, 20));
			}
			expect(stub.requests).toHaveLength(1);

			// The read must not wait for the turn: a page reload during a 30 s turn
			// would hang on it otherwise.
			const page = await Promise.race([
				agent.history("web:zy@example.com", { limit: 10 }),
				new Promise<never>((_, fail) => {
					setTimeout(() => fail(new Error("history queued behind the running turn")), 1_000);
				}),
			]);
			expect(page.items.map((item) => [item.role, item.text])).toEqual([["user", "typed while running"]]);

			// A read of an unknown key is empty and creates nothing.
			const changes: string[] = [];
			const stop = observeDocuments(agent, (change) => changes.push(change.kind));
			try {
				expect(await agent.history("web:nobody@example.com", { limit: 10 })).toEqual({ items: [], more: false });
			} finally {
				stop();
			}
			expect(changes.filter((kind) => kind === "movin.conversations")).toEqual([]);

			controller.abort();
			await pending;
		} finally {
			await stub.close();
		}
	});

	it("shows what the user typed, not the prompt the model read", async () => {
		const rig = await open({
			hooks: { userContent: async (_key, text) => ({ content: `Snapshot: ${text}`, state: undefined }) },
			answer: say("ok"),
		});
		await rig.agent.submit("web:zy@example.com", "typed text", { actor: { by: "zy@example.com", channel: "web" } });

		expect(userTexts(rig.requests[0] as Request)).toEqual(["Snapshot: typed text"]);
		const page = await rig.agent.history("web:zy@example.com", { limit: 10 });
		expect(page.items[1]).toMatchObject({ role: "user", text: "typed text" });
	});
});

describe("the history's rows", () => {
	it("shows the final answer of a tool round, not its preamble", async () => {
		const rig = await open({
			tools: [
				{
					name: "echo",
					description: "Repeat the text back.",
					parameters: { type: "object", properties: { text: { type: "string" } } },
					replay: "safe",
					writes: false,
					execute: async (): Promise<{ text: string }> => ({ text: "echo" }),
				},
			],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("Saved it."))
					: fauxAssistantMessage([fauxText("Let me save that. "), fauxToolCall("echo", { text: "a" })], {
							stopReason: "toolUse",
						}),
		});
		await rig.agent.submit("web:zy@example.com", "add it");

		// The preamble was dropped live with a `reset`, so it is not a row either.
		expect((await rig.agent.history("web:zy@example.com", { limit: 10 })).items.map((item) => item.text)).toEqual([
			"Saved it.",
			"add it",
		]);
	});

	it("shows one answer after a retried mid-stream error", async () => {
		const rig = await open({
			retry: { baseDelayMs: 1 },
			answer: (_request, index) =>
				index === 0
					? fauxAssistantMessage(fauxText("a draft that died"), {
							stopReason: "error",
							errorMessage: "terminated: other side closed",
						})
					: fauxAssistantMessage(fauxText("the answer")),
		});
		await rig.agent.submit("web:zy@example.com", "hi");

		// The failed attempt's text is stored by pi-durable, but it is a draft.
		expect((await rig.agent.history("web:zy@example.com", { limit: 10 })).items.map((item) => item.text)).toEqual([
			"the answer",
			"hi",
		]);
	});

	it("keeps the model's own words and the stop, so the channel can apply its rules (Q1)", async () => {
		const rig = await open({ answer: () => refusing("I can't help with that.") });
		await rig.agent.submit("web:zy@example.com", "hi");

		// The adapter is the neutral layer: it says how the answer stopped, and
		// reply.ts turns that into the declined text on both the live turn and a
		// reload (decisions.md · T3 phase review round 2, Q1).
		const items = (await rig.agent.history("web:zy@example.com", { limit: 10 })).items;
		expect(items.map((item) => [item.role, item.text])).toEqual([
			["assistant", "I can't help with that."],
			["user", "hi"],
		]);
		expect(items[0]?.stop).toBe("refusal");
		expect(items[0]?.toolsUsed).toEqual([]);
	});

	it("keeps an answer that said nothing, with the run's tools (Q1)", async () => {
		const { tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText(""))
					: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
							stopReason: "toolUse",
						}),
		});
		const result = await rig.agent.submit("web:zy@example.com", "quartz", { actor: { by: "zy", channel: "web" } });
		expect(result).toMatchObject({ status: "answered", text: "" });

		// The row is kept with its empty text and its stop: the route turns it into
		// `Done.` (the run made a change), exactly as the live bubble did.
		const items = (await rig.agent.history("web:zy@example.com", { limit: 10 })).items;
		expect(items.map((item) => [item.role, item.text])).toEqual([
			["assistant", ""],
			["user", "quartz"],
		]);
		expect(items[0]?.stop).toBe("end");
		expect(items[0]?.changes?.map((line) => line.text)).toEqual(["Saved: idea · Quartz"]);
		expect(items[0]?.toolsUsed).toEqual(["add_entry"]);
	});
});

describe("a refusal (P1)", () => {
	it("is an answered run with stop refusal, not a failed one", async () => {
		// pi-ai turns finish_reason content_filter into an error stop, and pi-durable
		// ends such a run model_error; Go answers its declined text with 200
		// (agent-spec §10.12, agent.go:193-196).
		const rig = await open({ answer: () => refusing("I can't help with that.") });
		const result = await rig.agent.submit("web:zy@example.com", "hi");

		expect(result.status).toBe("answered");
		if (result.status !== "answered") throw new Error("not answered");
		expect(result.stop).toBe("refusal");
		expect(result.text).toBe("I can't help with that.");
	});

	it("keeps the changes the run made before the model declined", async () => {
		const { entries, tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? refusing("I can't help with that.")
					: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
							stopReason: "toolUse",
						}),
		});
		const result = await rig.agent.submit("web:zy@example.com", "quartz", { actor: { by: "zy", channel: "web" } });

		expect(result).toMatchObject({ status: "answered", stop: "refusal" });
		expect(result.changes.map((line) => line.text)).toEqual(["Saved: idea · Quartz"]);
		expect(result.usage.out).toBeGreaterThan(0);
		expect((await entries.current()).doc.entries).toHaveLength(1);
	});
});

describe("the transcript's text (P4)", () => {
	it("stores the typed text when the model was given a stripped one", async () => {
		const rig = await open({ answer: say("ok") });
		await rig.agent.submit("web:zy@example.com", "why?", { display: "/think why?" });

		const page = await rig.agent.history("web:zy@example.com", { limit: 10 });
		expect(page.items.map((item) => [item.role, item.text])).toEqual([
			["assistant", "ok"],
			["user", "/think why?"],
		]);
		// The model read the stripped text: `display` is for the transcript only.
		const first = rig.requests[0];
		if (first === undefined) throw new Error("no request");
		expect(userTexts(first)).toEqual(["why?"]);
	});
});

describe("the settings cache", () => {
	it("resolves once for concurrent turns, and applies a change to the next turn", async () => {
		let release: (() => void) | undefined;
		let gate: Promise<void> | undefined;
		let calls = 0;
		let config: LLM = { ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", thinkOnDemand: false };
		const settings: SettingsSource = {
			resolve: async () => {
				calls += 1;
				if (gate !== undefined) await gate;
				return config;
			},
		};
		const rig = await open({ answer: say("ok"), source: settings });
		expect(calls).toBe(1);

		gate = new Promise<void>((done) => {
			release = done;
		});
		const both = Promise.all([rig.agent.submit("web:a", "one"), rig.agent.submit("tg:b", "two")]);
		await new Promise((done) => setTimeout(done, 20));
		// Two turns, one resolve: the second shares the in-flight one.
		expect(calls).toBe(2);
		release?.();
		expect((await both).map((result) => result.status)).toEqual(["answered", "answered"]);
		// thinkOnDemand off means the level is the thinking one for both.
		expect(rig.requests.map((request) => request.thinking)).toEqual(["medium", "medium"]);

		// A saved change resolves again and reaches the next request.
		config = { ...config, thinkOnDemand: true };
		await rig.agent.submit("web:a", "three");
		expect(calls).toBe(3);
		expect(rig.requests[2]?.thinking).toBeUndefined();
	});
});

describe("an open that fails", () => {
	it("rejects when the database cannot be opened", async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t32-open-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		await writeFile(dbPath, "this is not a SQLite database");

		await expect(
			openAgent({
				dbPath,
				settings: source(),
				log: createTestLog().log,
			}),
		).rejects.toThrow(/not a database/i);
	});
});

// ---- T3.3: the tools through the adapter ----
//
// Go's golden for the five tool declarations, the actor of a write, the change
// lines of a run (kept on a failure, in the history, and behind `toolsUsed`),
// the run-wide image cap, the placeholder for an earlier run's images, the
// `agent tool call` line, and what the model receives for an unknown tool and
// unparseable arguments.

const GOLDEN_TOOLS = readFileSync(join(import.meta.dirname, "..", "agent", "testdata", "tools.go.json"), "utf8");

/** entries is one service on a memory store, with Go's five tools over it. */
function toolRig(): { entries: EntriesService; tools: ToolSpec[] } {
	const { log } = createTestLog();
	const entries = createEntriesService({
		store: createMemoryStore(),
		log,
		now: () => new Date("2026-11-11T09:00:00Z"),
	});
	return { entries, tools: buildTools({ entries }) };
}

/** documentsLibrary is one searchable document, enough for a search -> read chain. */
function documentsLibrary(): Library {
	const fridge: Doc = {
		...emptyDoc("docs/raw/4.0 Manuals/Fridge.pdf", "fridge"),
		pages: 2,
		class: CLASS_TEXT,
		status: STATUS_OK,
	};
	return {
		search: async () => [
			{ doc: "fridge", name: "Fridge.pdf", folder: "4.0 Manuals", page: 2, score: 1.5, snippet: "…defrost…" },
		],
		page: async (id, n) =>
			id !== fridge.id || n !== 2
				? { doc: null, page: null }
				: { doc: fridge, page: { n: 2, w: 595, h: 842, text: "Defrost every six months." } },
	};
}

/** toolCalls answers with n calls to one tool, all in one round. */
function toolCalls(name: string, args: Record<string, never>, n: number, round: number): AssistantMessage {
	return fauxAssistantMessage(
		Array.from({ length: n }, (_, i) => fauxToolCall(name, args, { id: `c${round}-${i}` })),
		{ stopReason: "toolUse" },
	);
}

/** imageParts counts the image parts in a request's tool results. */
function imageParts(request: Request): number {
	let images = 0;
	for (const message of request.messages) {
		if (Array.isArray(message.content)) for (const part of message.content) if (part.type === "image") images++;
	}
	return images;
}

describe("the tools on the wire", () => {
	it("sends Go's five tool declarations, byte for byte", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "ok" });
			const { entries } = toolRig();
			const agent = await openOnStub(stub.origin, buildTools({ entries }));
			await agent.submit("web:zy@example.com", "hi");

			const body = stub.requests[0]?.body as { tools?: Record<string, never>[] } | undefined;
			const tools = (body?.tools ?? []) as unknown as {
				type: string;
				function: { name: string; description: string; parameters: object; strict?: boolean };
			}[];
			expect(tools).toHaveLength(5);
			// This model's compat has `supportsStrictMode: false` (pi-ai's default
			// for an OpenAI-compatible endpoint), so pi-ai adds no `strict` key and
			// the declarations are Go's bytes exactly.
			expect(tools.map((tool) => Object.keys(tool.function))).toEqual(
				Array.from({ length: 5 }, () => ["name", "description", "parameters"]),
			);
			expect(stub.requests[0]?.raw).not.toContain('"strict"');
			expect(goMarshal(body?.tools)).toBe(GOLDEN_TOOLS);
		} finally {
			await stub.close();
		}
	});

	it("gives the model pi-durable's words for an unknown tool and for bad arguments", async () => {
		// Known difference from Go's `unknown tool "teleport"` and `arguments are
		// not valid JSON: …`: the library writes those two results, before our
		// tools run, with its own wording (durable-api.md §7).
		const stub = await startStub();
		try {
			stub.answer(
				{
					kind: "toolCalls",
					calls: [
						{ name: "teleport", arguments: "{}" },
						{ name: "add_entry", arguments: "not json" },
					],
				},
				{ kind: "text", text: "sorry" },
			);
			const { entries } = toolRig();
			const agent = await openOnStub(stub.origin, buildTools({ entries }));
			const result = await agent.submit("web:zy@example.com", "hi");
			expect(result).toMatchObject({ status: "answered", text: "sorry" });
			const results = (stub.requests[1]?.body.messages ?? []) as { role: string; content: string }[];
			const toolTexts = results.filter((message) => message.role === "tool").map((message) => message.content);
			expect(toolTexts[0]).toContain("Tool teleport is not available");
			// Known difference from Go's `unknown tool "teleport"` and `arguments
			// are not valid JSON: …`: pi-durable writes both results, with its own
			// wording, before our tools run (durable-api.md §7).
			expect(toolTexts[1]).toContain('Invalid arguments for tool "add_entry"');
			expect(toolTexts[1]).toContain("is not valid JSON");
			expect((await entries.current()).doc.entries).toHaveLength(0);
		} finally {
			await stub.close();
		}
	});
});

describe("the actor", () => {
	it("stamps a write with who asked and logs the tool call with the channel", async () => {
		const { entries, tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("Saved it."))
					: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
							stopReason: "toolUse",
						}),
		});
		const result = await rig.agent.submit("tg:4242", "quartz", { actor: { by: "partner", channel: "telegram" } });
		expect(result).toMatchObject({ status: "answered", text: "Saved it." });
		if (result.status !== "answered") throw new Error("not answered");
		expect(result.changes.map((line) => line.text)).toEqual(["Saved: idea · Quartz"]);
		expect(result.changes[0]?.id).toBeDefined();
		const snapshot = await entries.current();
		expect(snapshot.doc.entries.map((entry) => [entry.by, entry.channel])).toEqual([["partner", "telegram"]]);
		expect(snapshot.doc.changes).toHaveLength(1);

		// Go's `agent tool call` line, with by, channel, tool, args and result (tools.go:106-107).
		const logged = rig.lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.msg === "agent tool call");
		expect(logged).toHaveLength(1);
		expect(logged[0]).toMatchObject({
			by: "partner",
			channel: "telegram",
			tool: "add_entry",
			args: '{"entries":[{"kind":"idea","title":"Quartz"}]}',
		});
		expect(String(logged[0]?.result)).toContain('"created"');
	});

	it("blocks a write with no actor, and lets a read with none run", async () => {
		const { entries, tools } = toolRig();
		await entries.create({ by: "zy", channel: "web" }, [{ kind: "idea", title: "Known" }]);

		const rig = await open({
			tools,
			answer: (request) => {
				const results = request.messages.filter((message) => message.role === "toolResult");
				if (results.length >= 2) return fauxAssistantMessage(fauxText("Understood."));
				if (results.length === 0) {
					return fauxAssistantMessage(
						[fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "New" }] }, { id: "c1" })],
						{
							stopReason: "toolUse",
						},
					);
				}
				return fauxAssistantMessage([fauxToolCall("search_entries", { text: "known" }, { id: "c2" })], {
					stopReason: "toolUse",
				});
			},
		});
		const result = await rig.agent.submit("web:zy@example.com", "add one");
		expect(result.status).toBe("answered");
		if (result.status !== "answered") throw new Error("not answered");
		expect(result.changes).toEqual([]);
		const texts = toolResults(rig.requests[2] as Request);
		expect(texts[0]).toContain(`Tool call blocked: ${NO_ACTOR}`);
		// The read ran: its result names the entry it found.
		expect(texts[1]).toContain('"total":1');
		expect((await entries.current()).doc.entries.map((entry) => entry.title)).toEqual(["Known"]);
	});

	it("never borrows an earlier turn's actor", async () => {
		const { entries, tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) => {
				const users = request.messages.filter((message) => message.role === "user").length;
				const results = request.messages.filter((message) => message.role === "toolResult").length;
				if (users === 1) {
					return results === 0
						? fauxAssistantMessage(
								[fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Mine" }] }, { id: "c1" })],
								{
									stopReason: "toolUse",
								},
							)
						: fauxAssistantMessage(fauxText("Saved it."));
				}
				return results === 1
					? fauxAssistantMessage(
							[fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Theirs" }] }, { id: "c2" })],
							{
								stopReason: "toolUse",
							},
						)
					: fauxAssistantMessage(fauxText("nothing to save"));
			},
		});
		await rig.agent.submit("web:zy@example.com", "mine", { actor: { by: "partner", channel: "telegram" } });
		const second = await rig.agent.submit("web:zy@example.com", "theirs");
		expect(second).toMatchObject({ status: "answered", text: "nothing to save", changes: [] });

		// The second turn's write was blocked, and nothing carries the first turn's person.
		expect(toolResults(rig.requests[3] as Request).at(-1)).toContain(`Tool call blocked: ${NO_ACTOR}`);
		const snapshot = await entries.current();
		expect(snapshot.doc.entries.map((entry) => [entry.title, entry.by])).toEqual([["Mine", "partner"]]);
		expect(snapshot.doc.changes).toHaveLength(1);
	});

	it("answers the blocked write with Go's words and writes nothing", async () => {
		const { entries, tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("ok"))
					: fauxAssistantMessage(fauxToolCall("set_dates", { move_in: "2026-12-05" }), { stopReason: "toolUse" }),
		});
		await rig.agent.submit("web:zy@example.com", "we move in on 5 Dec");
		expect(toolResults(rig.requests[1] as Request)[0]).toContain(`Tool call blocked: ${NO_ACTOR}`);
		expect((await entries.current()).doc.meta).toEqual({ moveDate: null, keyDate: null });
	});
});

describe("a run's change lines", () => {
	it("go out as change events when the tool result is committed, before the answer", async () => {
		// Go emits the `change` event from the tool round, so the page can show the
		// Undo chip while the turn is still running (agent-spec §4.2). The lines come
		// from the tool result's details, not from the answer's.
		const { tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("Saved it."))
					: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "task", title: "Electrician" }] }), {
							stopReason: "toolUse",
						}),
		});
		const events: AgentEvent[] = [];
		const result = await rig.agent.submit("web:zy@example.com", "electrician", {
			actor: { by: "zy", channel: "web" },
			onEvent: (event) => events.push(event),
		});
		const changes = events.filter((event) => event.type === "change");
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ type: "change", text: "Saved: task · Electrician" });
		if (result.status !== "answered") throw new Error("not answered");
		// The same id the result carries, and the frame arrives before the answer's text.
		expect(changes[0]?.id).toBe(result.changes[0]?.id);
		const at = events.findIndex((event) => event.type === "change");
		const text = events.findIndex((event) => event.type === "delta");
		expect(at).toBeGreaterThan(-1);
		expect(at).toBeLessThan(text);
	});

	it("are kept on a failed run, as Go keeps them for the Undo buttons", async () => {
		const { entries, tools } = toolRig();
		const rig = await open({
			tools,
			retry: { baseDelayMs: 1 },
			answer: (_request, index) =>
				index === 0
					? fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota: no budget" }),
		});
		const result = await rig.agent.submit("web:zy@example.com", "quartz", { actor: { by: "zy", channel: "web" } });
		expect(result.status).toBe("failed");
		if (result.status !== "failed") throw new Error("not failed");
		expect(result.reason).toBe("model_error");
		expect(result.changes.map((line) => line.text)).toEqual(["Saved: idea · Quartz"]);
		expect(result.toolsUsed).toEqual(["add_entry"]);
		expect((await entries.current()).doc.entries).toHaveLength(1);
	});

	it("go to the user row of a run that failed instead, so its Undo survives a reload", async () => {
		const { entries, tools } = toolRig();
		const rig = await open({
			tools,
			retry: { baseDelayMs: 1 },
			answer: (_request, index) =>
				index === 0
					? fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota: no budget" }),
		});
		const result = await rig.agent.submit("web:zy@example.com", "quartz", { actor: { by: "zy", channel: "web" } });
		expect(result.status).toBe("failed");
		// No answer row exists, so the run's change lines hang on its user row.
		const page = await rig.agent.history("web:zy@example.com", { limit: 10 });
		expect(page.items.map((item) => item.role)).toEqual(["user"]);
		expect(page.items[0]?.changes?.map((line) => line.text)).toEqual(["Saved: idea · Quartz"]);
		expect(page.items[0]?.changes?.[0]?.id).toBeDefined();
		expect((await entries.current()).doc.entries).toHaveLength(1);
	});

	it("reach the history with the answer they belong to", async () => {
		const { tools } = toolRig();
		const rig = await open({
			tools,
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("Saved it."))
					: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "task", title: "Electrician" }] }), {
							stopReason: "toolUse",
						}),
		});
		await rig.agent.submit("web:zy@example.com", "electrician", { actor: { by: "zy", channel: "web" } });
		const page = await rig.agent.history("web:zy@example.com", { limit: 10 });
		expect(page.items.map((item) => item.role)).toEqual(["assistant", "user"]);
		expect(page.items[0]?.changes?.map((line) => line.text)).toEqual(["Saved: task · Electrician"]);
		expect(page.items[1]?.changes).toBeUndefined();
	});

	it("stays [] when a run changed nothing, and toolsUsed names a document search", async () => {
		// T3.5 builds Go's `NotFoundInDocsReply` from this: `lookedInDocs` is set by
		// the tool NAMES search_documents and read_document_page (agent-spec §10.11).
		const docs = documentsLibrary();
		const rig = await open({
			tools: buildTools({ entries: toolRig().entries, docs }),
			answer: (request) => {
				const results = request.messages.filter((message) => message.role === "toolResult");
				if (results.length >= 2) return fauxAssistantMessage("");
				if (results.length === 0) {
					return fauxAssistantMessage([fauxToolCall("search_documents", { query: "defrost" }, { id: "c1" })], {
						stopReason: "toolUse",
					});
				}
				return fauxAssistantMessage([fauxToolCall("read_document_page", { doc: "fridge", page: 2 }, { id: "c2" })], {
					stopReason: "toolUse",
				});
			},
		});
		const result = await rig.agent.submit("web:zy@example.com", "what is the warranty?");
		expect(result).toMatchObject({
			status: "answered",
			text: "",
			changes: [],
			toolsUsed: ["search_documents", "read_document_page"],
		});
		// The chain reached the model: the hits first, then the page's text.
		expect(toolResults(rig.requests[1] as Request)[0]).toContain('"doc":"fridge"');
		expect(toolResults(rig.requests[2] as Request)[1]).toContain("Defrost every six months.");
		// The empty answer keeps its row and names the run's tools, so the route can
		// turn it into NotFoundInDocsReply on a reload too (Q1).
		const page = await rig.agent.history("web:zy@example.com", { limit: 10 });
		expect(page.items.map((item) => [item.role, item.text])).toEqual([
			["assistant", ""],
			["user", "what is the warranty?"],
		]);
		expect(page.items[0]?.toolsUsed).toEqual(["search_documents", "read_document_page"]);
	});
});

describe("the image cap", () => {
	it("sends six images of seven calls and answers the seventh with the limit text", async () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		const pic: ToolSpec = {
			name: "pic",
			description: "Look at a page.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			writes: false,
			execute: async () => ({ text: '{"page":1}', images: [{ mediaType: "image/png", data: png }] }),
		};
		const rig = await open({
			tools: [pic],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("The DB is near the entrance."))
					: toolCalls("pic", {}, 7, 0),
		});
		const result = await rig.agent.submit("web:zy@example.com", "where is the DB?");
		expect(result).toMatchObject({ status: "answered" });
		if (result.status !== "answered") throw new Error("not answered");
		expect(result.toolsUsed).toHaveLength(7);

		const second = rig.requests[1] as Request;
		// Seven calls: six images reach the model and the seventh is the limit text
		// (Go's TestViewDocumentPage).
		expect(imageParts(second)).toBe(MAX_IMAGES_PER_RUN);
		expect(imageParts(second)).toBe(6);
		const texts = toolResults(second);
		expect(texts).toHaveLength(7);
		expect(texts.filter((text) => text === IMAGE_LIMIT_REPLY)).toHaveLength(1);
		expect(IMAGE_LIMIT_REPLY).toBe('{"error":"image limit for this message reached; answer from what you have seen"}');
	});

	it("counts per run, so a second run still gets its six after six earlier images", async () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		let calls = 0;
		const pic: ToolSpec = {
			name: "pic",
			description: "Look at a page.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			writes: false,
			execute: async () => {
				calls++;
				return { text: `{"page":${calls}}`, images: [{ mediaType: "image/png", data: png }] };
			},
		};
		const rig = await open({
			tools: [pic],
			answer: (request) => {
				const results = request.messages.filter((message) => message.role === "toolResult").length;
				const users = request.messages.filter((message) => message.role === "user").length;
				if (users === 1) return results >= 6 ? fauxAssistantMessage(fauxText("ok")) : toolCalls("pic", {}, 6, 0);
				return results >= 13 ? fauxAssistantMessage(fauxText("ok again")) : toolCalls("pic", {}, 7, 1);
			},
		});
		await rig.agent.submit("web:zy@example.com", "first six pages");
		await rig.agent.submit("web:zy@example.com", "six more pages");

		// The first run looked at six images.
		expect(imageParts(rig.requests[1] as Request)).toBe(6);
		// The second run's last request: its own six images still reach the model,
		// the seventh call is the limit text, and the six of the earlier run are
		// placeholders — so the cap was counted per run, not per conversation.
		const second = rig.requests[3] as Request;
		expect(imageParts(second)).toBe(6);
		expect(toolResults(second)).toHaveLength(13);
		expect(toolResults(second).filter((text) => text === IMAGE_LIMIT_REPLY)).toHaveLength(1);
		const placeholders = second.messages.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter((part) => part.type === "text" && part.text === EARLIER_IMAGE)
				: [],
		);
		expect(placeholders).toHaveLength(6);
	});
});

describe("the images of an earlier run", () => {
	it("are replaced by the placeholder while the current run's images stay", async () => {
		const png = new Uint8Array([137, 80, 78, 71]);
		let calls = 0;
		const pic: ToolSpec = {
			name: "pic",
			description: "Look at a page.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			writes: false,
			execute: async () => {
				calls++;
				return { text: `{"page":${calls}}`, images: [{ mediaType: "image/png", data: png }] };
			},
		};
		const rig = await open({
			tools: [pic],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("ok"))
					: fauxAssistantMessage(fauxToolCall("pic", {}, { id: `c${request.messages.length}-${Date.now()}` }), {
							stopReason: "toolUse",
						}),
		});
		await rig.agent.submit("web:zy@example.com", "first look");
		// The run that made the image still sees it.
		expect(imageParts(rig.requests[1] as Request)).toBe(1);

		await rig.agent.submit("web:zy@example.com", "second look");
		const later = rig.requests[3] as Request;
		expect(imageParts(later)).toBe(1);
		const earlier = later.messages.filter(
			(message) =>
				message.role === "toolResult" &&
				Array.isArray(message.content) &&
				message.content.some((part) => part.type === "text"),
		);
		const placeholders = later.messages.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.filter((part) => part.type === "text" && part.text === EARLIER_IMAGE)
				: [],
		);
		expect(placeholders).toHaveLength(1);
		expect(earlier.length).toBeGreaterThan(0);
		expect(EARLIER_IMAGE).toBe("[image from an earlier message]");
	});
});

describe("the tool call log line", () => {
	it("cuts a long result to 2000 code points and a …, as Go's truncate does", async () => {
		const long = "ü".repeat(2050);
		const talk: ToolSpec = {
			name: "talk",
			description: "Say a lot.",
			parameters: { type: "object", properties: {} },
			replay: "safe",
			writes: false,
			execute: async () => ({ text: long }),
		};
		const rig = await open({
			tools: [talk],
			answer: (request) =>
				request.messages.at(-1)?.role === "toolResult"
					? fauxAssistantMessage(fauxText("ok"))
					: fauxAssistantMessage(fauxToolCall("talk", {}), { stopReason: "toolUse" }),
		});
		await rig.agent.submit("web:zy@example.com", "say it");
		const logged = rig.lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.find((line) => line.msg === "agent tool call");
		const result = String(logged?.result);
		expect([...result]).toHaveLength(2001);
		expect(result.endsWith("…")).toBe(true);
		expect(logged).toMatchObject({ by: "", channel: "" });
	});
});

// ---- T3.4: the prompt through the adapter ----
//
// The prompt is wired only through the hooks: the system text, the snapshot or
// delta in the submitted content, and the `movin.prompt` state stored in the
// submit commit and advanced by afterRun. The stub shows the real request bytes.

interface WireMessage {
	role: string;
	content: unknown;
}

function wireMessages(request: { body: Record<string, unknown> }): WireMessage[] {
	return (request.body.messages ?? []) as WireMessage[];
}

function lastWireUser(request: { body: Record<string, unknown> }): string {
	const message = wireMessages(request).findLast((item) => item.role === "user");
	return typeof message?.content === "string" ? message.content : "";
}

const PROMPT_KEY = "web:zy@example.com";
const PROMPT_ACTOR = { by: "zy@example.com", channel: "web" };
const PROMPT_NOW = new Date("2026-11-11T09:00:00Z");

/** promptRig is one entries service and the prompt hooks over it, both on a fixed clock. */
async function promptRig(): Promise<{
	entries: EntriesService;
	hooks: AgentHooks;
}> {
	const { log } = createTestLog();
	const entries = createEntriesService({
		store: createMemoryStore(),
		log,
		now: () => PROMPT_NOW,
		timeZone: "UTC",
	});
	const hooks = promptHooks({ entries, log, timeZone: "UTC", now: () => PROMPT_NOW });
	return { entries, hooks };
}

describe("the prompt through the adapter", () => {
	it("keeps the system text and earlier messages byte-identical, with no delta, when nothing changed", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "one" }, { kind: "text", text: "two" }, { kind: "text", text: "three" });
			const { entries, hooks } = await promptRig();
			await entries.create(PROMPT_ACTOR, [{ kind: "idea", title: "Quartz" }]);
			const agent = await openOnStub(stub.origin, [], {}, hooks);

			await agent.submit(PROMPT_KEY, "first");
			await agent.submit(PROMPT_KEY, "second");
			await agent.submit(PROMPT_KEY, "third");
			expect(stub.requests).toHaveLength(3);

			// The system message is the same bytes on every request (the cache prefix).
			const systems = stub.requests.map((request) => JSON.stringify(wireMessages(request)[0]));
			expect(new Set(systems).size).toBe(1);

			// Each request starts with everything the previous one carried.
			for (let i = 1; i < 3; i++) {
				const previous = wireMessages(stub.requests[i - 1] as { body: Record<string, unknown> });
				const next = wireMessages(stub.requests[i] as { body: Record<string, unknown> });
				expect(next.slice(0, previous.length)).toEqual(previous);
			}
			// No write between turns: no delta block, and the first message is the snapshot.
			expect(lastWireUser(stub.requests[0] as { body: Record<string, unknown> })).toContain("Entries snapshot:");
			for (let i = 1; i < 3; i++) {
				expect(lastWireUser(stub.requests[i] as { body: Record<string, unknown> })).not.toContain(
					"Changed since your last message",
				);
			}
		} finally {
			await stub.close();
		}
	});

	it("shows one edit from elsewhere as exactly one updated line, once", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "one" }, { kind: "text", text: "two" }, { kind: "text", text: "three" });
			const { entries, hooks } = await promptRig();
			const created = await entries.create(PROMPT_ACTOR, [{ kind: "idea", title: "Quartz" }]);
			const id = created.entries[0]?.id ?? "";
			const agent = await openOnStub(stub.origin, [], {}, hooks);

			await agent.submit(PROMPT_KEY, "first");
			await entries.update({ by: "partner", channel: "telegram" }, id, { title: "Granite" });
			await agent.submit(PROMPT_KEY, "second");
			const second = lastWireUser(stub.requests[1] as { body: Record<string, unknown> });
			expect(second.match(/- updated /g)).toHaveLength(1);
			expect(second).toContain(`- updated {"id":"${id}","kind":"idea","title":"Granite","status":"idea"}`);
			// The next turn has seen that line: no repeat.
			await agent.submit(PROMPT_KEY, "third");
			expect(lastWireUser(stub.requests[2] as { body: Record<string, unknown> })).not.toContain(
				"Changed since your last message",
			);
		} finally {
			await stub.close();
		}
	});

	it("does not echo the agent's own add_entry on the next turn", async () => {
		const stub = await startStub();
		try {
			stub.answer(
				{
					kind: "toolCalls",
					calls: [
						{
							name: "add_entry",
							arguments: '{"entries":[{"kind":"idea","title":"Quartz"}]}',
						},
					],
				},
				{ kind: "text", text: "Saved." },
				{ kind: "text", text: "ok" },
			);
			const { entries, hooks } = await promptRig();
			const agent = await openOnStub(stub.origin, buildTools({ entries }), {}, hooks);
			const first = await agent.submit(PROMPT_KEY, "quartz for the wet kitchen", { actor: PROMPT_ACTOR });
			expect(first).toMatchObject({ status: "answered", text: "Saved." });
			expect((await entries.current()).doc.entries.map((entry) => entry.title)).toEqual(["Quartz"]);

			await agent.submit(PROMPT_KEY, "and what next?");
			expect(lastWireUser(stub.requests[2] as { body: Record<string, unknown> })).not.toContain(
				"Changed since your last message",
			);
		} finally {
			await stub.close();
		}
	});

	it("shows an archive from elsewhere as a removed line", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "one" }, { kind: "text", text: "two" });
			const { entries, hooks } = await promptRig();
			const created = await entries.create(PROMPT_ACTOR, [{ kind: "idea", title: "Quartz" }]);
			const id = created.entries[0]?.id ?? "";
			const agent = await openOnStub(stub.origin, [], {}, hooks);

			await agent.submit(PROMPT_KEY, "first");
			await entries.update({ by: "partner", channel: "telegram" }, id, { archived: true });
			await agent.submit(PROMPT_KEY, "second");
			expect(lastWireUser(stub.requests[1] as { body: Record<string, unknown> })).toContain(
				`Changed since your last message:\n- removed ${id} "Quartz"`,
			);
		} finally {
			await stub.close();
		}
	});

	it("sends the snapshot again after a reset, with seen rebuilt", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "one" }, { kind: "text", text: "two" });
			const { entries, hooks } = await promptRig();
			await entries.create(PROMPT_ACTOR, [{ kind: "idea", title: "Quartz" }]);
			const agent = await openOnStub(stub.origin, [], {}, hooks);

			await agent.submit(PROMPT_KEY, "first");
			await agent.reset(PROMPT_KEY);
			await agent.submit(PROMPT_KEY, "second");
			const second = lastWireUser(stub.requests[1] as { body: Record<string, unknown> });
			expect(second.startsWith("Entries snapshot:")).toBe(true);
			expect(second).not.toContain("Changed since your last message");
		} finally {
			await stub.close();
		}
	});

	it("puts the group line in a group chat's system text only", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "one" }, { kind: "text", text: "two" });
			const { hooks } = await promptRig();
			const agent = await openOnStub(stub.origin, [], {}, hooks);

			await agent.submit("tg:42", "hello", { group: true });
			const group = wireMessages(stub.requests[0] as { body: Record<string, unknown> })[0];
			expect(JSON.stringify(group)).toContain("group chat");
			expect(JSON.stringify(group)).toContain("NO_REPLY");

			await agent.submit(PROMPT_KEY, "hello");
			const web = wireMessages(stub.requests[1] as { body: Record<string, unknown> })[0];
			expect(JSON.stringify(web)).not.toContain("group chat");
		} finally {
			await stub.close();
		}
	});

	it("stores the prompt state only when it changes: the submit commit, not every turn", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "one" }, { kind: "text", text: "two" }, { kind: "text", text: "three" });
			const { entries, hooks } = await promptRig();
			const created = await entries.create(PROMPT_ACTOR, [{ kind: "idea", title: "Quartz" }]);
			const id = created.entries[0]?.id ?? "";
			const agent = await openOnStub(stub.origin, [], {}, hooks);
			const changes: string[] = [];
			const stop = observeDocuments(agent, (change) => {
				if (change.kind === "movin.prompt") changes.push(change.kind);
			});
			try {
				await agent.submit(PROMPT_KEY, "first");
				// The document's creation and its first value are both changes.
				const first = changes.length;
				expect(first).toBeGreaterThan(0);
				await agent.submit(PROMPT_KEY, "second");
				expect(changes).toHaveLength(first);
				await entries.update({ by: "partner", channel: "telegram" }, id, { title: "Granite" });
				await agent.submit(PROMPT_KEY, "third");
				expect(changes).toHaveLength(first + 1);
			} finally {
				stop();
			}
		} finally {
			await stub.close();
		}
	});
});

// The outbox (T4.3b): the `movin.outbox.delivery` task hands a reply's parts to
// a channel one at a time, and the checkpoint moves only after a part went out.
// Its waits are pi-durable sleeps: stored on the Harness clock and armed as a
// real timer for `until - now()`. A test that owns the clock therefore owns the
// timer too (OpenAgentOptions.setTimer), so no case here waits a real backoff.
const OUTBOX_KEY = "tg:4242";

/** A clock and timer a test drives: `now()` answers, and `advance()` passes time. */
interface ManualClock {
	now: () => number;
	setTimer: Timer;
	/**
	 * How many foreground timers are armed: the ones that resume work, such as a
	 * delivery's backoff. A background timer only frees memory (pi-durable arms one
	 * at open), so it is not counted.
	 */
	waiting: () => number;
	/** advance moves the clock forward, firing each timer as its time comes, and settles. */
	advance: (ms: number) => Promise<void>;
}

/** theSettle is one turn of the event loop, enough for a fired timer's work to commit. */
function theSettle(): Promise<void> {
	return new Promise((done) => setImmediate(done));
}

/**
 * manualClock is the Harness's time as a test owns it. `advance` walks the armed
 * timers in order, so a 1 s backoff costs nothing; a disarm takes the timer off
 * the list, as the Harness disarms the one it replaces.
 */
function manualClock(start = Date.parse("2026-11-11T09:00:00Z")): ManualClock {
	let clock = start;
	const timers: { at: number; callback: () => void; background: boolean }[] = [];
	return {
		now: () => clock,
		setTimer: (callback, delayMs, options) => {
			const timer = { at: clock + delayMs, callback, background: options.background };
			timers.push(timer);
			return () => {
				const at = timers.indexOf(timer);
				if (at >= 0) timers.splice(at, 1);
			};
		},
		waiting: () => timers.filter((timer) => !timer.background).length,
		advance: async (ms) => {
			const target = clock + ms;
			for (;;) {
				const next = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
				if (next === undefined) break;
				timers.splice(timers.indexOf(next), 1);
				clock = Math.max(clock, next.at);
				next.callback();
				await theSettle();
			}
			clock = Math.max(clock, target);
		},
	};
}

/** waitFor polls until a condition holds, so a test can catch a task between two steps. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 4_000;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((done) => setTimeout(done, 5));
	}
}

/** stillWaiting is whether `work` is unresolved `ms` later: the idle wait must not have finished. */
async function stillWaiting(work: Promise<void>, ms = 100): Promise<boolean> {
	const timer = new Promise<string>((done) => setTimeout(() => done("waiting"), ms));
	return (await Promise.race([work.then(() => "idle"), timer])) === "waiting";
}

/** flood is Telegram's 429, as T4.2b will map it: `retry_after` in milliseconds. */
function flood(retryAfterMs: number): OutboxError {
	const error = new OutboxError("telegram sendMessage: 429 Too Many Requests: retry after 3");
	error.retryAfterMs = retryAfterMs;
	return error;
}

describe("the outbox", () => {
	it("sends the parts in order, each once, to the address it was given", async () => {
		const sends: { address: OutboxJson; part: OutboxJson }[] = [];
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (address, part) => {
					sends.push({ address, part });
				},
			},
		});
		const address: OutboxJson = { chat: 4242, messageId: 7, group: true };

		await rig.agent.deliver(OUTBOX_KEY, address, ["one", "two", "three"]);
		await whenIdle(rig.agent, OUTBOX_KEY);

		expect(sends.map((send) => send.part)).toEqual(["one", "two", "three"]);
		expect(sends.map((send) => send.address)).toEqual([address, address, address]);
		// A delivery is not a turn: no model request was made for it.
		expect(rig.requests).toHaveLength(0);
	});

	it("waits out a 429 before it sends that part again", async () => {
		const clock = manualClock();
		const sends: { part: OutboxJson; at: number }[] = [];
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			outbox: {
				send: async (_address, part) => {
					sends.push({ part, at: clock.now() });
					if (sends.length === 1) throw flood(3000);
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["only"]);
		await waitFor(() => sends.length === 1 && clock.waiting() === 1, "the 429's sleep");
		// Nothing before `retry_after` plus the second of margin: the part is not retried early.
		await clock.advance(3999);
		expect(sends).toHaveLength(1);
		await clock.advance(1);
		await whenIdle(rig.agent, OUTBOX_KEY);

		expect(sends.map((send) => send.part)).toEqual(["only", "only"]);
		expect((sends[1]?.at ?? 0) - (sends[0]?.at ?? 0)).toBe(4000);
	});

	it("stops the rest of a delivery after a permanent failure", async () => {
		const sends: OutboxJson[] = [];
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					if (part === "b") {
						const refused = new OutboxError("telegram sendMessage: 400 Bad Request: chat not found");
						refused.permanent = true;
						throw refused;
					}
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["a", "b", "c"]);
		await whenIdle(rig.agent, OUTBOX_KEY);

		expect(sends).toEqual(["a", "b"]);
		const failed = rig.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(failed.filter((line) => line.msg === "outbox delivery failed")).toEqual([
			expect.objectContaining({ part: 1, of: 3, attempts: 1, permanent: true }),
		]);
	});

	it("ends failed after six attempts on one part, and the next part is never sent", async () => {
		const clock = manualClock();
		const sends: { part: OutboxJson; at: number }[] = [];
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			outbox: {
				send: async (_address, part) => {
					sends.push({ part, at: clock.now() });
					throw new Error("telegram sendMessage: fetch failed");
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["a", "b"]);
		await waitFor(() => clock.waiting() === 1, "the first backoff");
		// The whole schedule is 1 + 2 + 4 + 8 + 16 s of waiting, and one advance.
		await clock.advance(31_000);
		await whenIdle(rig.agent, OUTBOX_KEY);

		// Six attempts at the first part, and the delivery stopped there.
		expect(sends.map((send) => send.part)).toEqual(["a", "a", "a", "a", "a", "a"]);
		const waitBetween = sends.slice(1).map((send, index) => send.at - (sends[index]?.at ?? 0));
		expect(waitBetween).toEqual([1000, 2000, 4000, 8000, 16000]);
		const lines = rig.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(lines.filter((line) => line.msg === "outbox delivery failed")).toEqual([
			expect.objectContaining({
				part: 0,
				of: 2,
				attempts: 6,
				permanent: false,
				err: "telegram sendMessage: fetch failed",
			}),
		]);
	});

	it("sends nothing more once a delivery is aborted, and drops the parts after it", async () => {
		const clock = manualClock();
		const sends: OutboxJson[] = [];
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					throw new Error("telegram sendMessage: 502 Bad Gateway");
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["a", "b"]);
		// The first attempt failed; the delivery now sleeps out its 1 s backoff.
		await waitFor(() => clock.waiting() === 1, "the first backoff");
		await abortDeliveries(rig.agent, OUTBOX_KEY);
		await whenIdle(rig.agent, OUTBOX_KEY);
		// Even the wait it stored is not waited out: nothing more is sent.
		await clock.advance(60_000);

		expect(sends).toEqual(["a"]);
	});

	it("counts a part's attempts on its own, not the delivery's", async () => {
		const clock = manualClock();
		const sends: { part: OutboxJson; at: number }[] = [];
		let aTries = 0;
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			outbox: {
				send: async (_address, part) => {
					sends.push({ part, at: clock.now() });
					// The first part fails once and then goes out; the second never does.
					if (part === "a") {
						aTries += 1;
						if (aTries === 1) throw new Error("telegram sendMessage: fetch failed");
						return;
					}
					throw new Error("telegram sendMessage: fetch failed");
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["a", "b"]);
		await waitFor(() => clock.waiting() === 1, "the first backoff");
		await clock.advance(32_000);
		await whenIdle(rig.agent, OUTBOX_KEY);

		// The second part starts again at the first backoff: a successful send resets
		// the count, so it gets its six attempts and not the first part's leftovers.
		expect(sends.map((send) => send.part)).toEqual(["a", "a", "b", "b", "b", "b", "b", "b"]);
		// The moving part is where a part ends and the next begins: no wait there.
		const waits = sends.slice(1).map((send, index) => send.at - (sends[index]?.at ?? 0));
		expect(waits.filter((wait) => wait > 0)).toEqual([1000, 1000, 2000, 4000, 8000, 16000]);
	});

	it("does not hold the store while a send is in flight", async () => {
		const sends: string[] = [];
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(String(part));
					if (part === "slow") await held;
				},
			},
		});

		await rig.agent.deliver("tg:1", null, ["slow"]);
		await waitFor(() => sends.length === 1, "the first chat's send");
		// Another chat's delivery commits while that send is open: a send inside the
		// commit callback would make every writer wait for the channel.
		await rig.agent.deliver("tg:2", null, ["quick"]);
		await waitFor(() => sends.includes("quick"), "the second chat's part");

		release();
		await whenIdle(rig.agent, "tg:1");
		await whenIdle(rig.agent, "tg:2");
		expect(sends).toEqual(["slow", "quick"]);
	});

	it("keeps two deliveries for one key in the order they were created", async () => {
		const sends: OutboxJson[] = [];
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					if (part === "first") await held;
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["first"]);
		await rig.agent.deliver(OUTBOX_KEY, null, ["second"]);
		// The first delivery's send is still open, so the second must be waiting.
		await waitFor(() => sends.length === 1, "the first delivery's send");
		expect(await stillWaiting(whenIdle(rig.agent, OUTBOX_KEY), 50)).toBe(true);
		expect(sends).toEqual(["first"]);

		release();
		await whenIdle(rig.agent, OUTBOX_KEY);
		expect(sends).toEqual(["first", "second"]);
	});

	it("refuses to queue a delivery when no outbox is configured", async () => {
		const rig = await open({ answer: say("unused") });
		await expect(rig.agent.deliver(OUTBOX_KEY, null, ["a"])).rejects.toThrow("no outbox configured");
		// An empty reply is nothing to send, so it needs no channel either.
		await rig.agent.deliver(OUTBOX_KEY, null, []);
		expect(rig.requests).toHaveLength(0);
	});

	it("is conversation-owned and not background: the idle wait covers it running and sleeping", async () => {
		const clock = manualClock();
		const sends: OutboxJson[] = [];
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					// The first attempt holds the task in its phase, then fails so the
					// second state to prove is the retry backoff.
					if (sends.length === 1) {
						await held;
						throw new Error("telegram sendMessage: 502 Bad Gateway");
					}
				},
			},
		});

		await rig.agent.deliver(OUTBOX_KEY, null, ["a"]);
		// Running: a background task would be excluded from this wait.
		await waitFor(() => sends.length === 1, "the first send");
		expect(await stillWaiting(whenIdle(rig.agent, OUTBOX_KEY), 50)).toBe(true);

		// Sleeping: the 1 s backoff holds the conversation just as a phase does.
		release();
		await waitFor(() => clock.waiting() === 1, "the backoff");
		expect(await stillWaiting(whenIdle(rig.agent, OUTBOX_KEY), 50)).toBe(true);
		await clock.advance(1000);
		await whenIdle(rig.agent, OUTBOX_KEY);

		expect(sends).toEqual(["a", "a"]);
	});

	it("opens a database whose pending delivery has no outbox, and parks it instead of faulting", async () => {
		// A process with a channel queues a reply and stops before it went out.
		const first = await open({
			answer: say("unused"),
			outbox: {
				send: async () => {
					throw new Error("telegram sendMessage: fetch failed");
				},
			},
		});
		await first.agent.deliver(OUTBOX_KEY, null, ["a"]);
		await first.close();
		rigs.splice(rigs.indexOf(first), 1);

		// Reopened by a process that cannot send, a minute on so the backoff is due.
		// The kind is registered, so the database opens and the task runs; the phase
		// finds no channel and parks, and the reply is still there to be sent later.
		const second = await open({ answer: say("unused"), dbPath: first.dbPath, now: () => Date.now() + 60_000 });
		await waitFor(
			() => second.lines.some((line) => line.includes("no outbox is configured")),
			"the parked delivery's warning",
		);
		expect(await stillWaiting(whenIdle(second.agent, OUTBOX_KEY), 100)).toBe(true);
		expect(second.lines.filter((line) => line.includes("harness report"))).toEqual([]);
	});
});

// The intake ledger (T4.2a): a channel's poll accepts a batch in one commit, and
// a chat's worker submits, takes or settles each item afterwards, so polling
// never waits for a turn and nothing is accepted, run or replied to twice across
// a crash. Item ids are Telegram's update_ids; address and payload are opaque.
const INTAKE_KEY = "tg:4242";
const OTHER_KEY = "tg:9";

/** item is one accepted update, with only the fields a case cares about spelled out. */
function item(id: number, over: Partial<IntakeItem> = {}): IntakeItem {
	return {
		id,
		key: INTAKE_KEY,
		address: { chat: 4242, group: false },
		payload: { text: `m${id}` },
		at: 1_000 + id,
		...over,
	};
}

/** logged reads the test log's lines with one message, as the fields they carry. */
function logged(lines: string[], msg: string): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg);
}

describe("the intake ledger", () => {
	it("accepts a batch once, however often it is redelivered", async () => {
		const rig = await open({ answer: say("unused") });
		const batch = { cursor: 13, items: [item(11), item(12)] };

		expect(await rig.agent.intake.accept(batch)).toEqual(batch.items);
		// The same batch again (a poll retried after a crash) adds nothing: the ids
		// are in `recent`, which is what makes dedupe independent of the queue.
		expect(await rig.agent.intake.accept(batch)).toEqual([]);
		expect(await rig.agent.intake.state()).toEqual({
			cursor: 13,
			acceptedAt: expect.any(Number),
			queue: batch.items,
			open: [],
		});
	});

	it("keeps the id of an item it settled, so a redelivery is not queued again", async () => {
		const rig = await open({ answer: say("unused") });
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });

		expect(await rig.agent.intake.take(10)).toBe(true);
		expect(await rig.agent.intake.state()).toEqual({ cursor: 11, acceptedAt: expect.any(Number), queue: [], open: [] });
		// Gone from the queue, still known: a redelivered update is dropped.
		expect(await rig.agent.intake.accept({ cursor: 11, items: [item(10)] })).toEqual([]);
		expect(await rig.agent.intake.state()).toEqual({ cursor: 11, acceptedAt: expect.any(Number), queue: [], open: [] });
	});

	it("drops the 65th queued item of one chat and still moves the cursor", async () => {
		const rig = await open({ answer: say("unused") });
		const flood = Array.from({ length: 64 }, (_unused, index) => item(100 + index));
		await rig.agent.intake.accept({ cursor: 1_001, items: flood });

		// The 65th for this chat is over the cap; another chat's item is not.
		const added = await rig.agent.intake.accept({ cursor: 1_002, items: [item(200), item(500, { key: OTHER_KEY })] });

		expect(added).toEqual([item(500, { key: OTHER_KEY })]);
		expect(logged(rig.lines, "intake queue full, dropping update")).toEqual([
			expect.objectContaining({ level: "WARN", key: INTAKE_KEY, id: 200 }),
		]);
		const state = await rig.agent.intake.state();
		expect(state.queue.filter((queued) => queued.key === INTAKE_KEY)).toHaveLength(64);
		expect(state.queue.filter((queued) => queued.key === OTHER_KEY)).toEqual([item(500, { key: OTHER_KEY })]);
		// The batch was accepted either way: the cursor moves, so the poll is not stuck.
		expect(state.cursor).toBe(1_002);
	});

	it("keeps the batch's own offset, forwards or back, so a stale poll can come back", async () => {
		const rig = await open({ answer: say("unused") });
		await rig.agent.intake.accept({ cursor: 20, items: [] });
		// A batch polled at 0 after six quiet days carries ids below the stored cursor
		// (B1): keeping the higher one would hide everything between them for ever.
		await rig.agent.intake.accept({ cursor: 5, items: [item(4)] });

		const state = await rig.agent.intake.state();
		expect(state.cursor).toBe(5);
		expect(state.queue).toEqual([item(4)]);
	});

	it("forgets the ids a stale poll brings back, but not what is still queued", async () => {
		const rig = await open({ answer: say("unused") });
		await rig.agent.intake.accept({ cursor: 13, items: [item(10), item(11)] });
		expect(await rig.agent.intake.take(10)).toBe(true);

		// Telegram dropped update 10 a day ago, and the reset gave a new one its id, so
		// the stale batch queues it again; the item still queued is not queued twice (B2).
		expect(await rig.agent.intake.accept({ cursor: 12, items: [item(10), item(11)], fresh: true })).toEqual([item(10)]);
		expect((await rig.agent.intake.state()).queue).toEqual([item(11), item(10)]);
	});

	it("records when a batch was accepted, so a stale cursor can be told from a fresh one", async () => {
		const clock = 1_700_000_000_000;
		const rig = await open({ answer: say("unused"), now: () => clock });
		// Nothing accepted yet: unknown, which is what tells the bot to poll from 0.
		expect((await rig.agent.intake.state()).acceptedAt).toBe(0);

		await rig.agent.intake.accept({ cursor: 11, items: [] });
		// Even an empty batch is an accept: the cursor moved, so the ledger is not silent.
		expect((await rig.agent.intake.state()).acceptedAt).toBe(clock);
	});

	it("takes an item exactly once, even for two callers at the same time", async () => {
		const rig = await open({ answer: say("unused") });
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });

		const takes = await Promise.all([rig.agent.intake.take(10), rig.agent.intake.take(10)]);

		// At-most-once: the first caller is the one that acts.
		expect(takes.filter((taken) => taken)).toEqual([true]);
		expect(await rig.agent.intake.take(10)).toBe(false);
	});

	it("settles a turn once: two settles make one delivery and one send", async () => {
		const sends: OutboxJson[] = [];
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
				},
			},
		});
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });
		await rig.agent.submit(INTAKE_KEY, "m10", { requestId: "tg:10", intake: { id: 10, deadlineAt: 5_000 } });

		const address: OutboxJson = { chat: 4242, group: false };
		await Promise.all([
			rig.agent.intake.settle(10, INTAKE_KEY, address, ["the reply"]),
			rig.agent.intake.settle(10, INTAKE_KEY, address, ["the reply"]),
		]);
		await whenIdle(rig.agent, INTAKE_KEY);

		// The removal and the task were one commit, so the second settle found nothing
		// to drop and created no task: one send, not two.
		expect(sends).toEqual(["the reply"]);
		expect(await rig.agent.intake.state()).toEqual({ cursor: 11, acceptedAt: expect.any(Number), queue: [], open: [] });
	});

	it("settles silently with null parts, and does nothing for an id it does not hold", async () => {
		const sends: OutboxJson[] = [];
		const conversations: string[] = [];
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
				},
			},
		});
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });
		const stop = observeDocuments(rig.agent, (change) => conversations.push(change.kind));
		try {
			// No parts: the item goes, and no delivery is created for it.
			await rig.agent.intake.settle(10, INTAKE_KEY, { chat: 4242 }, null);
			expect(await rig.agent.intake.state()).toEqual({
				cursor: 11,
				acceptedAt: expect.any(Number),
				queue: [],
				open: [],
			});
			// An id it never held: nothing removed, nothing queued, no conversation made.
			await rig.agent.intake.settle(99, INTAKE_KEY, { chat: 4242 }, ["never sent"]);
		} finally {
			stop();
		}

		expect(conversations).not.toContain("movin.conversations");
		expect(sends).toEqual([]);
	});

	it("moves the item from queue to open in the commit that admits the turn", async () => {
		const rig = await open({ answer: say("Hello.") });
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });
		const commits: { type: string; kind: string }[][] = [];
		const stop = observeCommits(rig.agent, (changes) => commits.push([...changes]));
		try {
			expect(
				await rig.agent.submit(INTAKE_KEY, "m10", { requestId: "tg:10", intake: { id: 10, deadlineAt: 7_000 } }),
			).toMatchObject({ status: "answered", text: "Hello." });
		} finally {
			stop();
		}

		const state = await rig.agent.intake.state();
		expect(state.queue).toEqual([]);
		expect(state.open).toEqual([{ ...item(10), submission: expect.any(Number), deadlineAt: 7_000 }]);
		// One commit holds the admission and the move, so a crash cannot leave a
		// submitted turn whose item is still queued (or the other way round).
		const moved = commits.filter((changes) =>
			changes.some((change) => change.type === "document" && change.kind === INTAKE_DOC),
		);
		expect(moved).toHaveLength(1);
		expect(moved[0]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "submission" })]));
	});

	it("attaches to the turn a repeated requestId already admitted, and writes nothing", async () => {
		let clock = Date.parse("2026-11-11T09:00:00Z");
		const examined: unknown[] = [];
		const rig = await open({
			now: () => clock,
			retry: { enabled: false },
			hooks: {
				userContent: async (_key, text, { state }) => {
					examined.push(state);
					return { content: text, state: { turns: 1 } };
				},
				afterRun: async (_key, _result, state) => state,
			},
			answer: (_request, index) => {
				if (index > 0) throw new Error("a repeated requestId must not reach the model");
				return fauxAssistantMessage(fauxText("once"));
			},
		});
		const first = await rig.agent.submit(INTAKE_KEY, "one", { requestId: "tg:10" });
		// Past the idle reset and with a thinking level the second turn would
		// configure: both are writes a duplicate must not make.
		clock += IDLE_RESET_MS + 1;
		const commits: { type: string; kind: string }[][] = [];
		const stop = observeCommits(rig.agent, (changes) => commits.push([...changes]));
		let second: RunResult;
		try {
			second = await rig.agent.submit(INTAKE_KEY, "one", { requestId: "tg:10", think: true });
		} finally {
			stop();
		}

		expect(second).toEqual(first);
		expect(rig.requests).toHaveLength(1);
		// The hook that builds the model's message did not run either.
		expect(examined).toHaveLength(1);
		const changes = commits.flat();
		expect(changes.filter((change) => change.type === "submission")).toEqual([]);
		expect(changes.filter((change) => change.kind === "movin.prompt")).toEqual([]);
		expect(changes.filter((change) => change.kind === "pi.agent")).toEqual([]);
		expect(changes.filter((change) => change.type === "entry" && change.kind === "pi.reset")).toEqual([]);
	});

	it("starts a chat's next turn only after the earlier turn and its reply are done", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const sends: OutboxJson[] = [];
		const rig = await open({
			answer: (_request, index) => fauxAssistantMessage(fauxText(index === 0 ? "first answer" : "second answer")),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					// The reply stays in flight until the test lets it go.
					await held;
				},
			},
		});
		await rig.agent.submit(INTAKE_KEY, "first message");
		await rig.agent.deliver(INTAKE_KEY, { chat: 4242 }, ["the reply"]);
		await waitFor(() => sends.length === 1, "the reply's send");

		const second = rig.agent.submit(INTAKE_KEY, "second message");
		// The delivery holds the chat (it is conversation-owned), so run 2 waits.
		expect(
			await stillWaiting(
				second.then(() => undefined),
				100,
			),
		).toBe(true);
		expect(rig.requests).toHaveLength(1);

		release();
		expect(await second).toMatchObject({ status: "answered", text: "second answer" });
		expect(rig.requests).toHaveLength(2);
		// Run 2 sees run 1, and only started once reply 1 was out.
		const request = rig.requests[1] as Request;
		expect(userTexts(request)).toEqual(["first message", "second message"]);
		expect(request.messages.some((message) => textOf(message) === "first answer")).toBe(true);
	});

	it("reports a recovered turn exactly as the submit reported it", async () => {
		const rig = await open({ answer: say("Saved it.") });
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });
		const submitted = await rig.agent.submit(INTAKE_KEY, "m10", {
			requestId: "tg:10",
			intake: { id: 10, deadlineAt: 5_000 },
		});

		const [turn] = (await rig.agent.intake.state()).open;
		const attached = await rig.agent.attach(INTAKE_KEY, turn?.submission ?? 0);

		expect(attached).toEqual(submitted);
		expect(attached).toMatchObject({ status: "answered", text: "Saved it." });
		// Attaching waits the run out; it does not run it again.
		expect(rig.requests).toHaveLength(1);
	});

	it("reports a failed turn the same way, with the key still scrubbed", async () => {
		const rig = await open({
			answer: () =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "insufficient_quota: the key sk-test-1234 is over its budget",
				}),
		});
		await rig.agent.intake.accept({ cursor: 11, items: [item(10)] });
		const submitted = await rig.agent.submit(INTAKE_KEY, "m10", {
			requestId: "tg:10",
			intake: { id: 10, deadlineAt: 5_000 },
		});

		const [turn] = (await rig.agent.intake.state()).open;
		const attached = await rig.agent.attach(INTAKE_KEY, turn?.submission ?? 0);

		expect(submitted).toMatchObject({ status: "failed", reason: "model_error" });
		expect(attached).toEqual(submitted);
	});

	it("is idle at once for an unknown key, and waits for a running delivery", async () => {
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const sends: OutboxJson[] = [];
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					await held;
				},
			},
		});
		// A chat the adapter has never seen has nothing running.
		await rig.agent.idle(OTHER_KEY);

		await rig.agent.deliver(INTAKE_KEY, { chat: 4242 }, ["the reply"]);
		await waitFor(() => sends.length === 1, "the reply's send");
		expect(await stillWaiting(rig.agent.idle(INTAKE_KEY), 50)).toBe(true);

		release();
		await rig.agent.idle(INTAKE_KEY);
		expect(sends).toEqual(["the reply"]);
	});

	it("returns aborted when the caller's signal fires during the idle wait", async () => {
		const sends: OutboxJson[] = [];
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const rig = await open({
			answer: say("unused"),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					await held;
				},
			},
		});
		await rig.agent.deliver(INTAKE_KEY, { chat: 4242 }, ["the reply"]);
		await waitFor(() => sends.length === 1, "the reply's send");

		// A Stop while the chat is busy with the delivery: the wait is the caller's, so
		// the turn ends `aborted` and nothing is submitted (minor 4).
		const controller = new AbortController();
		const turn = rig.agent.submit(INTAKE_KEY, "hi", { signal: controller.signal });
		expect(
			await stillWaiting(
				turn.then(() => undefined),
				50,
			),
		).toBe(true);
		controller.abort(new Error("the person stopped it"));

		expect(await turn).toMatchObject({ status: "failed", reason: "aborted" });
		// No run was created: the model was never asked, and nothing was admitted.
		expect(rig.requests).toHaveLength(0);
		expect(await rig.agent.history(INTAKE_KEY, { limit: 10 })).toMatchObject({ items: [] });

		release();
		await rig.agent.idle(INTAKE_KEY);
	});
});

describe("an unsettled result", () => {
	it("is what a close cut short returns, and a channel must not settle it", { timeout: 15_000 }, async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const agent = await openOnStub(stub.origin, []);
			const pending = agent.submit("web:zy@example.com", "hi");
			await new Promise((done) => setTimeout(done, 50));
			await agent.close();

			// The turn is still durable and unanswered, so a worker leaves its item
			// open and the restart's attach reports the real result (T4-plan §2.2).
			expect(isUnsettled(await pending)).toBe(true);
		} finally {
			await stub.close();
		}
	});

	it("is neither an answered run nor one that failed with an outcome", async () => {
		const answered = await open({ answer: say("fine") });
		expect(isUnsettled(await answered.agent.submit(INTAKE_KEY, "hi"))).toBe(false);

		const failed = await open({
			answer: () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota: over budget" }),
		});
		const result = await failed.agent.submit(INTAKE_KEY, "hi");
		expect(result).toMatchObject({ status: "failed", reason: "model_error" });
		// A refusal to answer is an outcome: the channel renders it and settles.
		expect(isUnsettled(result)).toBe(false);
		// So is a `faulted` built from a settled submission (resultOf's own): only
		// what ended() returned leaves the item open, or it would stay open forever.
		const built = { ...result, reason: "faulted", detail: "the submission was not an input" } as RunResult;
		expect(isUnsettled(built)).toBe(false);
	});
});

// The generic scheduled task and the pending notes (T5.1b, T5-plan §2.1, §2.3):
// one looping task per name on the dedicated `sys:schedule` conversation, and the
// note a delivery leaves for the chat's next message. Both are the adapter's own
// mechanisms; what a spec does with a tick is T5.1c's and T5.2's.
const SCHEDULE_KEY = "sys:schedule";

/** A schedule spec that records the targets it was called with, and answers what `answer` says. */
function scheduleSpec(name: string, answer: () => number): ScheduleSpec & { calls: (number | null)[] } {
	const calls: (number | null)[] = [];
	const spec: ScheduleSpec = {
		name,
		run: async ({ target }) => {
			calls.push(target);
			return answer();
		},
	};
	return { ...spec, calls };
}

/** untilSchedules polls the agent's scheduled tasks until `done` accepts them. */
async function untilSchedules(
	agent: Agent,
	done: (list: ScheduleInspection[]) => boolean,
	what: string,
): Promise<void> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		if (done(await inspectSchedules(agent))) return;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** asleep is the predicate every case here waits on: the one task, sleeping. */
function asleep(list: ScheduleInspection[]): boolean {
	return list.length === 1 && list[0]?.state === "sleeping";
}

describe("the scheduled task", () => {
	it("runs at creation with no target, then again at the target it answered", async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 5 * 60_000);
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});

		await untilSchedules(rig.agent, asleep, "the first run's sleep");
		const start = clock.now();
		expect(spec.calls).toEqual([null]);
		expect(await inspectSchedules(rig.agent)).toEqual([
			{ name: "checkin", state: "sleeping", until: start + 5 * 60_000, target: start + 5 * 60_000 },
		]);

		await clock.advance(5 * 60_000);
		await untilSchedules(rig.agent, (list) => spec.calls.length === 2 && asleep(list), "the second run");
		// The wake hands the spec the target it stored, so a spec can decide what a
		// wake before the target means.
		expect(spec.calls).toEqual([null, start + 5 * 60_000]);
	});

	it("caps a far target at fifteen minutes and keeps the same target", async () => {
		const clock = manualClock();
		const far = clock.now() + 24 * 3_600_000;
		const spec = scheduleSpec("docsync", () => far);
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});

		await untilSchedules(rig.agent, asleep, "the first run's sleep");
		const start = clock.now();
		expect(await inspectSchedules(rig.agent)).toEqual([
			{ name: "docsync", state: "sleeping", until: start + SCHEDULE_MAX_SLEEP_MS, target: far },
		]);

		await clock.advance(SCHEDULE_MAX_SLEEP_MS);
		await untilSchedules(rig.agent, (list) => spec.calls.length === 2 && asleep(list), "the capped wake");
		expect(spec.calls).toEqual([null, far]);
		expect((await inspectSchedules(rig.agent))[0]).toMatchObject({
			target: far,
			until: start + 2 * SCHEDULE_MAX_SLEEP_MS,
		});
	});

	it("logs a throwing spec, retries in a minute and never faults the task", async () => {
		const clock = manualClock();
		const calls: (number | null)[] = [];
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [
				{
					name: "checkin",
					run: async ({ target }) => {
						calls.push(target);
						throw new Error("the check-in store is unreadable");
					},
				},
			],
		});

		await untilSchedules(rig.agent, asleep, "the failed run's sleep");
		const start = clock.now();
		expect(await inspectSchedules(rig.agent)).toEqual([
			{ name: "checkin", state: "sleeping", until: start + 60_000, target: null },
		]);
		expect(logged(rig.lines, "schedule run failed")).toEqual([
			expect.objectContaining({ name: "checkin", err: "the check-in store is unreadable" }),
		]);

		await clock.advance(60_000);
		await untilSchedules(rig.agent, (list) => calls.length === 2 && asleep(list), "the retry");
		// The target it had is kept: a failed run must not lose the day it was on.
		expect(calls).toEqual([null, null]);
	});

	it("creates no second task when the database is opened again", async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 5 * 60_000);
		const first = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(first.agent, asleep, "the first open's run");
		expect(spec.calls).toEqual([null]);
		await first.agent.close();

		const second = await open({
			answer: say("unused"),
			dbPath: first.dbPath,
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await new Promise((done) => setTimeout(done, 50));
		expect(await inspectSchedules(second.agent)).toEqual([
			expect.objectContaining({ name: "checkin", state: "sleeping" }),
		]);
		// The stored sleep survived the reopen, so nothing ran before its target.
		expect(spec.calls).toEqual([null]);
		expect(logged(second.lines, "schedule task replaced")).toEqual([]);
	});

	it("replaces a task that ended", async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 5 * 60_000);
		const first = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(first.agent, asleep, "the first open's run");
		await abortSchedules(first.agent);
		await first.agent.close();

		const second = await open({
			answer: say("unused"),
			dbPath: first.dbPath,
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(second.agent, (list) => spec.calls.length === 2 && asleep(list), "the replacement");
		expect(await inspectSchedules(second.agent)).toHaveLength(1);
		expect(logged(second.lines, "schedule task replaced")).toEqual([
			expect.objectContaining({ name: "checkin", was: expect.any(String) }),
		]);
	});

	it("runs a sleeping schedule at once when it is rearmed", async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 5 * 60_000);
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(rig.agent, asleep, "the first run");
		expect(spec.calls).toEqual([null]);

		await rig.agent.schedule.rearm("checkin");
		await untilSchedules(rig.agent, (list) => spec.calls.length === 2 && asleep(list), "the rearmed run");
		// A replaced task starts from nothing, so the spec re-reads what it reads.
		expect(spec.calls).toEqual([null, null]);
		expect(await inspectSchedules(rig.agent)).toHaveLength(1);
		expect(logged(rig.lines, "schedule task replaced")).toHaveLength(1);
	});

	it("reruns once when rearmed mid-run, and aborts nothing", async () => {
		const clock = manualClock();
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const calls: (number | null)[] = [];
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [
				{
					name: "checkin",
					run: async ({ target }) => {
						calls.push(target);
						if (calls.length === 1) await held;
						return clock.now() + 5 * 60_000;
					},
				},
			],
		});
		await waitFor(() => calls.length === 1, "the first run");

		// The task is running: rearm must not abort it, only shorten its sleep.
		await rig.agent.schedule.rearm("checkin");
		release();
		await untilSchedules(rig.agent, (list) => calls.length === 2 && asleep(list), "the immediate rerun");
		expect(calls).toEqual([null, clock.now() + 5 * 60_000]);
		expect(await inspectSchedules(rig.agent)).toHaveLength(1);
		expect(logged(rig.lines, "schedule task replaced")).toEqual([]);
	});

	it("leaves one task when two rearms overlap", async () => {
		const clock = manualClock();
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		const calls: (number | null)[] = [];
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [
				{
					name: "checkin",
					run: async ({ target }) => {
						calls.push(target);
						// The replacement is held inside its run, so nothing it does changes the
						// task count while the assertions run.
						if (calls.length > 1) await held;
						return clock.now() + 5 * 60_000;
					},
				},
			],
		});
		await untilSchedules(rig.agent, asleep, "the first run's sleep");
		expect(calls).toEqual([null]);

		// A double-click, or two tabs: both calls see the one sleeping task. A second
		// replacement would loop for ever with nothing looking at it again.
		const both = Promise.all([rig.agent.schedule.rearm("checkin"), rig.agent.schedule.rearm("checkin")]);
		await waitFor(() => calls.length === 2, "the replacement's run");
		await both;
		// The aborted task's handler settles under resume(); once it has, exactly one
		// task is live — and a duplicate never settles, so this wait catches it.
		await untilSchedules(rig.agent, (list) => list.length === 1, "the aborted task to settle");
		const owners = await scheduleOwners(rig.agent);
		expect(owners.live).toHaveLength(1);
		expect(owners.guard).toEqual({ checkin: owners.live[0] });
		expect(logged(rig.lines, "schedule task replaced")).toHaveLength(1);

		release();
		await untilSchedules(rig.agent, asleep, "the replacement's sleep");
		expect(await inspectSchedules(rig.agent)).toHaveLength(1);
	});

	it("creates one task when the creating commit runs twice with the same id", async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 5 * 60_000);
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(rig.agent, asleep, "the first run's sleep");

		// The compare-and-set alone: `rearm`'s creating commit run twice with the id
		// both callers read. The second sees the guard already moved and creates
		// nothing — otherwise its task would loop with nothing ever looking at it.
		await markSchedules(rig.agent);
		const [first, second] = await createScheduleTwice(rig.agent, "checkin");
		expect(second).toBe(first);
		await untilSchedules(rig.agent, asleep, "the one replacement's sleep");
		const owners = await scheduleOwners(rig.agent);
		expect(owners.live).toEqual([first]);
		expect(owners.guard).toEqual({ checkin: first });
	});

	it("replaces a task that was only abort-marked when the database was opened again", async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 5 * 60_000);
		const first = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(first.agent, asleep, "the first open's run");
		expect(spec.calls).toEqual([null]);

		// The abort is its own commit (pi-durable's `Tx` has no abort), so a crash
		// between it and the creating commit leaves the guard naming a task whose only
		// change is the mark — the state `markSchedules` leaves, without waiting for
		// the abort handler. Nothing was created after it.
		await markSchedules(first.agent);
		await first.agent.close();

		// The mark counts as gone: the open replaces it, and the one task runs.
		const second = await open({
			answer: say("unused"),
			dbPath: first.dbPath,
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(second.agent, (list) => spec.calls.length === 2 && asleep(list), "the replacement");
		expect(await inspectSchedules(second.agent)).toHaveLength(1);
		const owners = await scheduleOwners(second.agent);
		expect(owners.live).toHaveLength(1);
		expect(owners.guard).toEqual({ checkin: owners.live[0] });
	});

	it("does not hold a chat's idle, nor its own conversation's", { timeout: 10_000 }, async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 60 * 60_000);
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
			outbox: { send: async () => undefined },
		});
		await untilSchedules(rig.agent, asleep, "the schedule's sleep");
		await rig.agent.deliver("tg:1", { chat: 1 }, ["hello"]);

		// Background: a sleeping schedule is not a chat's work, and not even its own
		// conversation's (t5-spec §13.2). Without that, this test times out.
		await rig.agent.idle("tg:1");
		await whenIdle(rig.agent, SCHEDULE_KEY);
	});

	it("parks and warns once when this process has no spec for the name", async () => {
		const clock = manualClock();
		const first = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [scheduleSpec("checkin", () => clock.now() + 5 * 60_000)],
		});
		await untilSchedules(first.agent, asleep, "the first open's run");
		const start = clock.now();
		await first.agent.close();

		// A process without the spec still opens the database: the kind is
		// registered here, so the task parks instead of faulting.
		const second = await open({
			answer: say("unused"),
			dbPath: first.dbPath,
			now: clock.now,
			setTimer: clock.setTimer,
		});
		expect(await inspectSchedules(second.agent)).toEqual([
			{ name: "checkin", state: "sleeping", until: start + 5 * 60_000, target: start + 5 * 60_000 },
		]);

		await clock.advance(5 * 60_000);
		await untilSchedules(
			second.agent,
			(list) => list[0]?.until === start + 5 * 60_000 + SCHEDULE_MAX_SLEEP_MS,
			"the parking wake",
		);
		expect(logged(second.lines, "no schedule spec; the task parks")).toEqual([
			expect.objectContaining({ name: "checkin" }),
		]);

		// Once per name, not once per cap.
		await clock.advance(SCHEDULE_MAX_SLEEP_MS);
		await untilSchedules(
			second.agent,
			(list) => list[0]?.until === start + 5 * 60_000 + 2 * SCHEDULE_MAX_SLEEP_MS,
			"the second parking wake",
		);
		expect(logged(second.lines, "no schedule spec; the task parks")).toHaveLength(1);
	});

	it("keeps the database bounded over a thousand wakes", { timeout: 120_000 }, async () => {
		const clock = manualClock();
		const spec = scheduleSpec("checkin", () => clock.now() + 60_000);
		const rig = await open({
			answer: say("unused"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
		});
		await untilSchedules(rig.agent, asleep, "the first run");
		const wal = `${rig.dbPath}-wal`;
		const total = (): number => statSync(rig.dbPath).size + (existsSync(wal) ? statSync(wal).size : 0);
		const report = (): string =>
			`${String(statSync(rig.dbPath).size)} db + ${String(existsSync(wal) ? statSync(wal).size : 0)} wal`;
		let wakes = 0;
		const wake = async (count: number): Promise<void> => {
			for (let i = 0; i < count; i++) {
				await clock.advance(60_000);
				const want = wakes + 1;
				await waitFor(() => spec.calls.length > want, "a wake");
				wakes = want;
			}
		};
		await wake(100);
		const at100 = total();
		const report100 = report();
		await wake(900);
		console.log(
			`load check: ${report100} after 100 wakes, ${report()} after 1000 wakes, runs ${String(spec.calls.length)}`,
		);
		expect(wakes).toBe(1000);
		expect(spec.calls).toHaveLength(1001);
		// pi-durable keeps no row per wake: the task record and the guard document are
		// updated in place, and the WAL is checkpointed and reused (see the report).
		expect(total()).toBeLessThanOrEqual(at100 * 2);
	});
});

describe("the pending notes", () => {
	const CHECKIN = "(morning check-in) Good morning. Today: nothing due.";

	it("writes the note in the commit that creates the delivery", async () => {
		const rig = await open({ answer: say("unused"), outbox: { send: async () => undefined } });
		const commits: { type: string; kind: string }[][] = [];
		const stop = observeCommits(rig.agent, (changes) => commits.push([...changes]));
		try {
			await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["the check-in"], {
				note: { tag: "checkin", text: CHECKIN },
			});
		} finally {
			stop();
		}

		// One commit: the chat's next message can never read a note whose check-in
		// was never queued, nor the other way round.
		const withNote = commits.filter((changes) =>
			changes.some((change) => change.type === "document" && change.kind === "movin.notes"),
		);
		expect(withNote).toHaveLength(1);
		expect(withNote[0]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "task" })]));
	});

	it("carries a delivery's note in the next turn only", async () => {
		const { hooks } = await promptRig();
		const sends: OutboxJson[] = [];
		const rig = await open({
			hooks,
			answer: say("Noted."),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
				},
			},
		});

		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, [CHECKIN], { note: { tag: "checkin", text: CHECKIN } });
		await rig.agent.submit(PROMPT_KEY, "what about the kitchen?");
		const first = userTexts(rig.requests[0] as Request).at(-1) ?? "";
		// After the delta block and before the date line, then the message itself.
		expect(first).toContain(`\n\n${NOTES_HEADER}\n${CHECKIN}\n\nToday is `);
		expect(first.endsWith("\n\nwhat about the kitchen?")).toBe(true);

		await rig.agent.submit(PROMPT_KEY, "and the bathroom?");
		expect(userTexts(rig.requests[1] as Request).at(-1) ?? "").not.toContain(NOTES_HEADER);
		expect(sends).toEqual([CHECKIN]);
	});

	it("replaces a note with the same tag and keeps the others", async () => {
		const { hooks } = await promptRig();
		const rig = await open({ hooks, answer: say("ok"), outbox: { send: async () => undefined } });
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["one"], {
			note: { tag: "checkin", text: "(morning check-in) first" },
		});
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["two"], {
			note: { tag: "checkin", text: "(morning check-in) second" },
		});
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["three"], { note: { tag: "other", text: "(other) kept" } });

		await rig.agent.submit(PROMPT_KEY, "hi");
		const text = userTexts(rig.requests[0] as Request).at(-1) ?? "";
		expect(text).toContain(`${NOTES_HEADER}\n(morning check-in) second\n\n(other) kept`);
		expect(text).not.toContain("(morning check-in) first");
	});

	it("clears the notes in the commit that admits the message", async () => {
		const { hooks } = await promptRig();
		const rig = await open({ hooks, answer: say("ok"), outbox: { send: async () => undefined } });
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, [CHECKIN], { note: { tag: "checkin", text: CHECKIN } });

		const commits: { type: string; kind: string }[][] = [];
		const stop = observeCommits(rig.agent, (changes) => commits.push([...changes]));
		try {
			await rig.agent.submit(PROMPT_KEY, "hello");
		} finally {
			stop();
		}

		const cleared = commits.filter((changes) =>
			changes.some((change) => change.type === "document" && change.kind === "movin.notes"),
		);
		expect(cleared).toHaveLength(1);
		// The admission and the clearing are one commit: a crash can neither show the
		// note twice nor lose one the model was already given.
		expect(cleared[0]).toEqual(expect.arrayContaining([expect.objectContaining({ type: "submission" })]));
	});

	it("keeps a note that lands while the message is being prepared for the next turn", async () => {
		const MORNING = "(morning check-in) Good morning.";
		const LATER = "(later check-in) Lunch is at one.";
		const { hooks } = await promptRig();
		if (hooks.userContent === undefined) throw new Error("the prompt rig has userContent");
		const content = hooks.userContent;
		let release: () => void = () => undefined;
		const held = new Promise<void>((done) => {
			release = done;
		});
		let gated = true;
		const gatedHooks: AgentHooks = {
			...hooks,
			userContent: async (key, text, turn) => {
				// The window: the notes are read before this hook and cleared in the commit
				// after it, and `deliver` does not wait for the turn.
				if (gated) {
					gated = false;
					await held;
				}
				return await content(key, text, turn);
			},
		};
		const rig = await open({ hooks: gatedHooks, answer: say("ok"), outbox: { send: async () => undefined } });
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["the check-in"], { note: { tag: "morning", text: MORNING } });

		const turn = rig.agent.submit(PROMPT_KEY, "hello");
		await waitFor(() => !gated, "the hook to hold the message");
		// A second check-in lands inside the window: it is not in the message being
		// prepared, and the admission commit must not clear it.
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["the later check-in"], {
			note: { tag: "later", text: LATER },
		});
		release();
		await turn;

		const first = userTexts(rig.requests[0] as Request).at(-1) ?? "";
		expect(first).toContain(MORNING);
		expect(first).not.toContain(LATER);
		// It reaches the next turn, and only that one.
		await rig.agent.submit(PROMPT_KEY, "next");
		expect(userTexts(rig.requests[1] as Request).at(-1) ?? "").toContain(LATER);
		await rig.agent.submit(PROMPT_KEY, "after");
		const last = userTexts(rig.requests[2] as Request).at(-1) ?? "";
		expect(last).not.toContain(LATER);
		expect(last).not.toContain(NOTES_HEADER);
	});

	it("consumes nothing on a duplicate requestId", async () => {
		const { hooks } = await promptRig();
		const rig = await open({ hooks, answer: say("ok"), outbox: { send: async () => undefined } });
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["one"], {
			note: { tag: "checkin", text: "(morning check-in) first" },
		});
		await rig.agent.submit(PROMPT_KEY, "hi", { requestId: "tg:1" });
		expect(userTexts(rig.requests[0] as Request).at(-1) ?? "").toContain("(morning check-in) first");

		// A note that arrives after that turn, then the same requestId again: the
		// attach path asks the model nothing and consumes nothing.
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, ["two"], {
			note: { tag: "checkin", text: "(morning check-in) second" },
		});
		await rig.agent.submit(PROMPT_KEY, "hi", { requestId: "tg:1" });
		expect(rig.requests).toHaveLength(1);

		await rig.agent.submit(PROMPT_KEY, "next");
		expect(userTexts(rig.requests[1] as Request).at(-1) ?? "").toContain("(morning check-in) second");
	});

	it("still carries the note after a six hour gap, in a fresh context", async () => {
		const clock = manualClock();
		const { hooks } = await promptRig();
		const rig = await open({
			hooks,
			answer: say("ok"),
			now: clock.now,
			setTimer: clock.setTimer,
			outbox: { send: async () => undefined },
		});
		await rig.agent.submit(PROMPT_KEY, "yesterday");
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, [CHECKIN], { note: { tag: "checkin", text: CHECKIN } });

		// The idle reset starts a new context, which a transcript entry would have
		// been hidden behind (T5-plan §2.3): the note rides on the message instead.
		await clock.advance(IDLE_RESET_MS + 1);
		await rig.agent.submit(PROMPT_KEY, "this morning");
		const text = userTexts(rig.requests[1] as Request).at(-1) ?? "";
		expect(text.startsWith(`Entries snapshot: []\n\n${NOTES_HEADER}\n${CHECKIN}\n\n`)).toBe(true);
	});

	it("never shows a note in the web history", async () => {
		const { hooks } = await promptRig();
		const rig = await open({ hooks, answer: say("ok"), outbox: { send: async () => undefined } });
		await rig.agent.deliver(PROMPT_KEY, { chat: 1 }, [CHECKIN], { note: { tag: "checkin", text: CHECKIN } });
		await rig.agent.submit(PROMPT_KEY, "hello");

		const page = await rig.agent.history(PROMPT_KEY, { limit: 10 });
		expect(page.items.map((item) => [item.role, item.text])).toEqual([
			["assistant", "ok"],
			["user", "hello"],
		]);
	});
});

// ---------------------------------------------------------------------------
// T5.3a: the restore path. The guard decides before `resume()`; on a restore
// every live task and unsettled submission is aborted by id, the intake's queue,
// open turns and cursor are dropped (recent stays), the epoch rotates and the
// schedules are recreated. Without a restore the open is what it always was.
// ---------------------------------------------------------------------------

/** guardOn is serve's guard over a memory store, so no case here needs S3. */
function guardOn(
	store: ObjectStore,
	options: { instance?: string; restoreId?: string; signal?: AbortSignal } = {},
): StartGuard {
	return createStartGuard({
		store,
		instance: options.instance ?? "dev",
		restoreId: options.restoreId ?? "",
		log: createTestLog().log,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
}

/** starts are the `harness start` lines of a rig, as the fields the log carries. */
function starts(lines: string[]): Record<string, unknown>[] {
	return logged(lines, "harness start");
}

/** untilNoDelivery waits for the restore path's abort handlers to settle every delivery. */
async function untilNoDelivery(agent: Agent): Promise<{ kind: string; state: string }[]> {
	const deadline = Date.now() + 4_000;
	for (;;) {
		const live = await inspectLive(agent);
		if (live.every((task) => task.kind !== "movin.outbox.delivery")) return live;
		if (Date.now() > deadline) throw new Error(`a delivery stayed live: ${JSON.stringify(live)}`);
		await new Promise((done) => setTimeout(done, 10));
	}
}

describe("the restore path", () => {
	/** What one seeded database leaves for the next open to find. */
	interface Seeded {
		dbPath: string;
		epoch: string;
		acceptedAt: number;
		/** Every part a send was called with, from either process. */
		sends: OutboxJson[];
		spec: ScheduleSpec & { calls: (number | null)[] };
	}

	/**
	 * seed leaves the work a restored copy must not continue, then closes the
	 * database: one accepted item that has run (an open turn nothing settled), one
	 * still queued, and two deliveries on one chat — the first sleeping on a 429,
	 * the second waiting behind it — plus one sleeping schedule.
	 */
	async function seed(clock: ManualClock, store: ObjectStore, options: { restoreId?: string } = {}): Promise<Seeded> {
		const sends: OutboxJson[] = [];
		const spec = scheduleSpec("checkin", () => clock.now() + 600_000);
		const rig = await open({
			answer: say("ok"),
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [spec],
			startGuard: guardOn(store, { restoreId: options.restoreId }),
			outbox: {
				send: async (_address, part) => {
					sends.push(part);
					throw flood(60_000);
				},
			},
		});
		await rig.agent.intake.accept({ cursor: 11, items: [item(70), item(71)] });
		// The item's turn ran and answered; no worker settled it, so it is an open
		// turn whose reply the restore path must not send.
		await rig.agent.submit(INTAKE_KEY, "message 70", {
			requestId: "tg:70",
			intake: { id: 70, deadlineAt: Date.parse("2026-11-11T09:15:00Z") },
		});
		await untilSchedules(rig.agent, asleep, "the schedule's sleep");
		await rig.agent.deliver(OUTBOX_KEY, { chat: 4242 }, ["222a"]);
		await waitFor(() => sends.length === 1 && clock.waiting() === 1, "the 429's sleep");
		// The second delivery parks behind the first, which is still live.
		await rig.agent.deliver(OUTBOX_KEY, { chat: 4242 }, ["222b"]);
		const state = await rig.agent.intake.state();
		const seeded: Seeded = { dbPath: rig.dbPath, epoch: rig.agent.epoch, acceptedAt: state.acceptedAt, sends, spec };
		await rig.agent.close();
		return seeded;
	}

	/**
	 * bump moves one instance's counter, as the start of a timeline this database
	 * never saw would: that is what a restored copy finds ahead of its own number.
	 */
	async function bump(store: ObjectStore, count: number, instance = "dev"): Promise<void> {
		const current = await store.get(epochKey(instance));
		await store.put(
			epochKey(instance),
			new TextEncoder().encode(`{"schema":1,"starts":${String(count)}}`),
			current.etag,
		);
	}

	/** reopen opens a seeded database again with a new guard and its own sends. */
	async function reopen(clock: ManualClock, seeded: Seeded, guard: StartGuard): Promise<Rig & { sent: OutboxJson[] }> {
		const sent: OutboxJson[] = [];
		const rig = await open({
			answer: say("must not be called"),
			dbPath: seeded.dbPath,
			now: clock.now,
			setTimer: clock.setTimer,
			schedules: [seeded.spec],
			startGuard: guard,
			outbox: {
				send: async (_address, part) => {
					sent.push(part);
					seeded.sends.push(part);
				},
			},
		});
		return { ...rig, sent };
	}

	it("aborts every live task and drops the intake when the S3 counter is ahead", async () => {
		const clock = manualClock();
		const store = createMemoryStore();
		const seeded = await seed(clock, store);
		// The snapshot's SQLite is at start 1; the deployment the snapshot lost has
		// started once more since, so S3 is at 2.
		await bump(store, 2);
		const second = await reopen(clock, seeded, guardOn(store));

		// One line for the start, with what the restore threw away: the two
		// deliveries and the schedule task, and the ledger's two items.
		expect(starts(second.lines)).toEqual([
			expect.objectContaining({
				starts: 3,
				restore: "counter",
				tasksAborted: 3,
				submissionsAborted: 0,
				intakeDropped: 2,
			}),
		]);

		// The ledger: no queue, no open turn, cursor 0 — and the accept clock kept, so
		// a stale cursor is still recognisable (T4.2b).
		expect(await second.agent.intake.state()).toEqual({
			cursor: 0,
			acceptedAt: seeded.acceptedAt,
			queue: [],
			open: [],
		});
		// `recent` is kept: a redelivery of the ids the lost timeline accepted is
		// still dropped rather than queued again (decision 13.14).
		expect(await second.agent.intake.accept({ cursor: 12, items: [item(70), item(71)] })).toEqual([]);

		// No send, and no model request: resume() recovered nothing that was lost.
		await new Promise((done) => setTimeout(done, 100));
		expect(second.sent).toEqual([]);
		expect(seeded.sends).toEqual(["222a"]);
		expect(second.requests).toEqual([]);

		// The epoch rotated, and the tools read the new one.
		expect(second.agent.epoch).not.toBe(seeded.epoch);
		expect(second.agent.epoch).toMatch(/^[0-9a-f-]{36}$/);

		// Nothing live but the schedule this start recreated (T5-plan §5.2: "recreate
		// from settings"), asleep towards the target its spec answered.
		expect(await untilNoDelivery(second.agent)).toEqual([{ kind: "movin.schedule", state: "sleeping" }]);
		expect(await inspectSchedules(second.agent)).toEqual([
			expect.objectContaining({ name: "checkin", state: "sleeping", target: clock.now() + 600_000 }),
		]);

		// The rotation is committed, not only held in memory: the next open reads the
		// same epoch back, so a change id minted after the restore cannot collide with
		// one the lost timeline minted.
		const rotated = second.agent.epoch;
		await second.agent.close();
		const third = await reopen(clock, seeded, guardOn(store));
		expect(starts(third.lines)).toEqual([expect.objectContaining({ restore: "none" })]);
		expect(third.agent.epoch).toBe(rotated);
		expect(third.agent.epoch).not.toBe(seeded.epoch);
	});

	it("restores on a new id, and only on a new one", async () => {
		const clock = manualClock();
		const store = createMemoryStore();
		const seeded = await seed(clock, store);

		// The runbook's new id: the counters are equal, so only the id can tell.
		const restored = await reopen(clock, seeded, guardOn(store, { restoreId: "r1" }));
		expect(starts(restored.lines)).toEqual([
			expect.objectContaining({ starts: 2, restore: "id", tasksAborted: 3, intakeDropped: 2 }),
		]);
		expect(restored.agent.epoch).not.toBe(seeded.epoch);
		expect(await restored.agent.intake.state()).toMatchObject({ cursor: 0, queue: [], open: [] });
		await new Promise((done) => setTimeout(done, 100));
		expect(restored.sent).toEqual([]);
		const epoch = restored.agent.epoch;
		await restored.agent.close();

		// Leaving it set is harmless: the id this database recorded is its own now.
		const again = await reopen(clock, seeded, guardOn(store, { restoreId: "r1" }));
		expect(starts(again.lines)).toEqual([expect.objectContaining({ starts: 3, restore: "none" })]);
		expect(starts(again.lines)[0]).not.toHaveProperty("tasksAborted");
		expect(again.agent.epoch).toBe(epoch);
		await again.agent.close();

		// A different id is a new restore, so the runbook's second drill works too.
		const third = await reopen(clock, seeded, guardOn(store, { restoreId: "r2" }));
		expect(starts(third.lines)).toEqual([expect.objectContaining({ restore: "id" })]);
		expect(third.agent.epoch).not.toBe(epoch);
	});

	it("is a normal start when the counters are equal, and keeps the ledger's work", async () => {
		const clock = manualClock();
		const store = createMemoryStore();
		const seeded = await seed(clock, store);
		const second = await reopen(clock, seeded, guardOn(store));

		expect(starts(second.lines)).toEqual([expect.objectContaining({ starts: 2, restore: "none" })]);
		expect(starts(second.lines)[0]).not.toHaveProperty("tasksAborted");
		// Nothing was dropped: the queued item, the open turn and the epoch survive.
		const state = await second.agent.intake.state();
		expect(state.queue.map((queued) => queued.id)).toEqual([71]);
		expect(state.open.map((turn) => turn.id)).toEqual([70]);
		expect(second.agent.epoch).toBe(seeded.epoch);
		// And both deliveries are still there to be sent when their waits end (their
		// exact state moves as the scheduler resumes them, so only the kinds are
		// compared), with the schedule this start kept.
		const live = (await inspectLive(second.agent)).map((task) => task.kind).sort();
		expect(live).toEqual(["movin.outbox.delivery", "movin.outbox.delivery", "movin.schedule"]);
	});

	it("never treats a new database with S3 ahead as a restore", async () => {
		const store = createMemoryStore();
		await store.put(epochKey("dev"), new TextEncoder().encode('{"schema":1,"starts":5}'), null);
		const rig = await open({ answer: say("unused"), startGuard: guardOn(store) });

		// A database with no start of its own has nothing to lose, so it takes the
		// higher number instead of dropping work it never had (T5-plan §2.4.1).
		expect(starts(rig.lines)).toEqual([expect.objectContaining({ starts: 6, restore: "none" })]);
		expect(starts(rig.lines)[0]).not.toHaveProperty("intakeDropped");
	});

	it("keeps dev's and prod's counters apart", async () => {
		const store = createMemoryStore();
		const first = await open({ answer: say("unused"), startGuard: guardOn(store, { instance: "dev" }) });
		expect(starts(first.lines)).toEqual([expect.objectContaining({ starts: 1, restore: "none" })]);
		await first.agent.close();

		// prod's object does not exist, so this database is behind nothing there: its
		// two starts carry on from SQLite, and dev's counter is left as it was.
		const prod = await open({
			dbPath: first.dbPath,
			answer: say("unused"),
			startGuard: guardOn(store, { instance: "prod" }),
		});
		expect(starts(prod.lines)).toEqual([expect.objectContaining({ starts: 2, restore: "none" })]);
		await prod.agent.close();
		const devBody = new TextDecoder().decode((await store.get(epochKey("dev"))).body);
		const prodBody = new TextDecoder().decode((await store.get(epochKey("prod"))).body);
		expect(devBody).toContain('"starts":1');
		expect(prodBody).toContain('"starts":2');
	});

	it("records in SQLite before S3, so a crash between the two is no false restore", async () => {
		const store = createMemoryStore();
		const first = await open({ answer: say("unused"), startGuard: guardOn(store) });
		await first.agent.close();
		const second = await open({ dbPath: first.dbPath, answer: say("unused"), startGuard: guardOn(store) });
		await second.agent.close();

		// The third start dies right after the S3 write — the crash the order is for.
		const real = guardOn(store);
		const crashing: StartGuard = {
			check: real.check,
			committed: async (count) => {
				await real.committed(count);
				throw new Error("the process died");
			},
		};
		await expect(open({ dbPath: first.dbPath, answer: say("unused"), startGuard: crashing })).rejects.toThrow(
			"the process died",
		);

		// SQLite already recorded start 3, so the next start is normal. The other
		// order would read 2 against S3's 3 and drop every pending reply.
		const fourth = await open({ dbPath: first.dbPath, answer: say("unused"), startGuard: guardOn(store) });
		expect(starts(fourth.lines)).toEqual([expect.objectContaining({ starts: 4, restore: "none" })]);
	});

	it("waits for the counter before it resumes anything", { timeout: 20_000 }, async () => {
		const store = createMemoryStore();
		const sends: OutboxJson[] = [];
		// One delivery whose first send fails for a reason that retries after 1 s. Both
		// opens get the outbox: a process with no channel parks the delivery instead of
		// sending it, and then the absence of a send would prove nothing at all.
		const outbox: Outbox = {
			send: async (_address, part) => {
				sends.push(part);
				if (sends.length === 1) throw new Error("socket hang up");
			},
		};
		const first = await open({ answer: say("unused"), startGuard: guardOn(store), outbox });
		await first.agent.deliver(OUTBOX_KEY, { chat: 4242 }, ["only"]);
		await waitFor(() => sends.length === 1, "the first send");
		await first.agent.close();

		// The guard's reads fail twice, so it answers after 1 s + 2 s. By then the
		// delivery's own 1 s backoff has long expired, so a resume now would send at
		// once: what follows is what the guard holds back.
		let reads = 0;
		const flaky: ObjectStore = {
			...store,
			get: async (key, signal) => {
				reads++;
				if (reads <= 2) throw new Error("SlowDown");
				return await store.get(key, signal);
			},
		};
		let opened = false;
		const pending = open({
			dbPath: first.dbPath,
			answer: say("unused"),
			startGuard: guardOn(flaky),
			outbox,
		}).then((rig) => {
			opened = true;
			return rig;
		});
		// Halfway through the guard's wait and past the backoff the delivery sleeps on:
		// nothing ran. A wake here would have called `send` at once, so the sends are the
		// evidence, and the open has not landed — a harness refuses reads once it is
		// closed, and the one this open built is out of reach until it resumes.
		await new Promise((done) => setTimeout(done, 1_500));
		expect(opened).toBe(false);
		expect(sends).toEqual(["only"]);

		// The answer came, and only then did the harness resume — and resume() wakes a
		// sleep whose `until` has already passed. The delivery the guard held back goes
		// out now: the second "only" is that catch-up, not a resend of a lost part.
		const rig = await pending;
		expect(starts(rig.lines)).toEqual([expect.objectContaining({ starts: 2, restore: "none" })]);
		await waitFor(() => sends.length === 2, "the caught-up send");
		expect(sends).toEqual(["only", "only"]);
		expect(await rig.agent.submit("tg:7", "after the wait")).toMatchObject({ status: "answered" });
	});

	it("fails the open, and closes the harness, when the counter cannot be read", async () => {
		const store = createMemoryStore();
		const first = await open({ answer: say("unused"), startGuard: guardOn(store) });
		await first.agent.close();

		// A shutdown during the wait: the read throws and nothing is resumed.
		const guard = guardOn(store, { signal: AbortSignal.abort() });
		await expect(open({ dbPath: first.dbPath, answer: say("unused"), startGuard: guard })).rejects.toThrow(
			"the harness start counter could not be read: aborted",
		);

		// The harness was closed behind the failed start, so the file opens again now.
		const again = await open({ dbPath: first.dbPath, answer: say("unused"), startGuard: guardOn(store) });
		expect(starts(again.lines)).toEqual([expect.objectContaining({ starts: 2, restore: "none" })]);
	});
});
