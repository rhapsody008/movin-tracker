// The durable adapter: the one file that imports pi-durable and chord. It owns
// the harness on SQLite, the conversation directory (`web:<email>`,
// `tg:<chat_id>`), the model and connection wiring, the per-turn thinking, the
// forced final answer, the idle reset, compaction, the per-round usage log, the
// history read-back, the tool wrapper (actor, run-wide image cap, change lines,
// the `agent tool call` line), the image placeholder of earlier runs, and the
// hook points T3.4 (prompt) fills in.
//
// Nothing pi-durable-typed leaves this file: submit() answers with the neutral
// RunResult below, and the tools and hooks it is given see plain data. The two
// test helpers at the bottom are the exception (the import rule needs them):
// they hand a test the harness's own observations, which a test otherwise could
// not reach without importing pi-durable itself.
//
// Read docs/movin-v3/briefs/durable-api.md for the facts behind each call. The
// decisions the gaps took are in docs/movin-v3/briefs/T3.2.md (G1-G10), and the
// review round's in docs/movin-v3/briefs/T3.2-fixes.md.

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as background, type Context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import type { AssistantMessage, Message, Models, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type AgentChange,
	AssistantEntry,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type Cursor,
	createRegistry,
	DEFAULT_RETRY_POLICY,
	defineDoc,
	defineExtension,
	defineTool,
	type EntryId,
	type EntryQuery,
	type EntryRecord,
	GenerationTask,
	Harness,
	type HarnessSettings,
	type HookApi,
	hook,
	LiveDoc,
	type LiveState,
	type Report,
	type SettledSubmissionRecord,
	type Submission,
	type SubmissionDraft,
	type SubmissionId,
	type ToolExecutionApi,
	ToolResultEntry,
	ToolTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { IMAGE_LIMIT_REPLY } from "../docs/render.ts";
import { type Stop, stopOf, thinkingFor } from "../llm/complete.ts";
import { llmError } from "../llm/errors.ts";
import { type Image, imageContent } from "../llm/images.ts";
import { llmModels, type ModelRef, type ModelWiring, modelEntry } from "../llm/provider.ts";
import { stripSpecialTokens, textOf } from "../llm/text.ts";
import { logLLMCall, type Usage, usageOf } from "../llm/usage.ts";
import { errorMessage, type Log } from "../log.ts";
import type { LLM } from "../settings/settings.ts";

/**
 * 6 hours without a message start a new context (plan.md:53, decisions.md ·
 * Behaviour). Go's bot had this at 2 h and never set it (bot.go:459-475), so
 * that is what v1 ran; 6 h is the v3 decision.
 */
export const IDLE_RESET_MS = 6 * 60 * 60 * 1000;

/**
 * The context a conversation may reach before it is compacted, in tokens.
 *
 * pi-durable has no Go-style 12-turn trim (agent-spec §2.2): compaction is the
 * bound instead. The gateway reports no cached tokens at all (T0.3: 0 of
 * 55,194 prompt tokens), so every request pays for its whole context and this
 * budget is what keeps that cost finite. `reserveTokens` is
 * `contextWindow - CONTEXT_BUDGET_TOKENS` (types.d.ts:518-541: generation
 * compacts above `contextWindow - reserveTokens`), so the budget is absolute
 * rather than a fraction of the window.
 */
export const CONTEXT_BUDGET_TOKENS = 48_000;

/** How much of the recent context a compaction keeps verbatim (about 4.5k words). */
export const KEEP_RECENT_TOKENS = 16_000;

/** How many entries one page of history or one run scan reads (pi-durable's own window default). */
const PAGE = 100;

/** The entry kind a submitted turn is stored as: the model sees the content, the UI its `data.text`. */
const USER_ENTRY = "movin.user";

/**
 * Go's cap, per run rather than per message (plan.md:73, agent-spec §10.6): a
 * message may look at six document images, and the seventh call is answered
 * with IMAGE_LIMIT_REPLY. The count comes from the run's own durable tool
 * results, so a replay counts what the crashed attempt counted.
 */
export const MAX_IMAGES_PER_RUN = 6;

/**
 * What the model reads in place of an image from an earlier run (agent-spec
 * §10.6): an image costs about 1.8k prompt tokens in every later request
 * (T0.3), so one that an earlier run looked at is replaced before each request.
 */
export const EARLIER_IMAGE = "[image from an earlier message]";

/**
 * A write tool with no known actor is blocked with this (T3.3). Go has no such
 * check (agent-spec §2.4); v3 refuses a write it cannot attribute, because the
 * actor is what the entry and the journal record are stamped with.
 */
export const NO_ACTOR = "writes need a known person; this message has none";

/** The memo beforeTool writes on a tool task: the run's actor, durable for a rerun after a crash. */
const ACTOR_MEMO = "movin.actor";

/** How long a result the `agent tool call` line keeps, in code points (Go's truncate, tools.go:113-119). */
const LOG_RESULT_RUNES = 2000;

/**
 * The conversation directory, `G1`: a session-scoped document mapping a
 * channel key (`web:<email>`, `tg:<chat_id>`) to the conversation ID
 * pi-durable minted. There is no lookup by key in the library (durable-api.md
 * §2), so this document is the index, and it is written in the creating
 * commit so a conversation and its entry appear together.
 */
const Directory = defineDoc<{ by: Record<string, number> }>({
	kind: "movin.conversations",
	version: 1,
	scope: "session",
	initial: () => ({ by: {} }),
	checkpointWhen: () => true,
});

/**
 * The epoch, `movin.epoch` (plan.md · Tools, decisions.md T0.2 R4): a UUID
 * created with the database and rotated by the restore path. Tool task IDs are
 * small per-database counters, so a change ID built from one alone collides
 * across dev and prod and across a restored database. T3.3 builds the change ID;
 * this step only makes the epoch available to tools.
 */
const Epoch = defineDoc<{ id: string }>({
	kind: "movin.epoch",
	version: 1,
	scope: "session",
	initial: () => ({ id: "" }),
	checkpointWhen: () => true,
});

/**
 * Per-key activity, for the idle reset and for `fresh` (G6): when the
 * conversation last ran, and the context head marker that run started with.
 * `head` is what tells a run after a reset or a compaction apart from an
 * ordinary run: both write a head marker (`pi.reset`, `pi.compaction`), so a
 * changed head means the model's context begins afresh.
 */
type Activity = { by: Record<string, { at: number; head: number }> };

const ActivityDoc = defineDoc<Activity>({
	kind: "movin.activity",
	version: 1,
	scope: "session",
	initial: () => ({ by: {} }),
	checkpointWhen: () => true,
});

/**
 * What the prompt has shown the model, per conversation (`G11`): the state the
 * `userContent` hook returns, stored opaquely. The submit commit writes the
 * state the new message carries, so a crash can lose neither the message nor
 * what the model was told it contains. `afterRun` then advances it once the run
 * settles, in its own commit.
 *
 * `afterRun` is a pure function of the state stored with the message and the
 * journal records the run's own change lines name (P5a), so applying it twice
 * computes the same state and never a second step. It is not, however, applied
 * by itself after a crash: a run that recovery finishes has no `submit()`
 * caller, so nothing calls it. The state then stays at what the submit stored,
 * and the next turn echoes the run's own writes once as added/updated — one
 * turn of echo, and nothing applied twice.
 */
const PromptStateDoc = defineDoc<{ state: JsonValue | null }>({
	kind: "movin.prompt",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ state: null }),
	checkpointWhen: () => true,
});

/**
 * Who is asking: Go's `entries.Actor` (agent-spec §2.4). Both the entry and its
 * journal record are stamped with it, so a write can be attributed and undone.
 */
export type Actor = { by: string; channel: string };

/** What one tool call sees. T3.3's tools use this and nothing else. */
export interface ToolContext {
	/** The channel key this conversation belongs to. */
	conversationKey: string;
	/** The durable tool task ID, unique per database (the change ID's salt with the epoch). */
	taskId: string;
	/** The provider's call ID, stable once the assistant entry is committed. */
	callId: string;
	/** `movin.epoch`; rotated by the restore path. */
	epoch: string;
	/** The invocation's abort signal (chord's context), so a stop reaches the work. */
	signal: AbortSignal | undefined;
	/**
	 * Who asked this run, from the actor stored with the submitted input; undefined
	 * for a turn submitted without one, which the adapter blocks from writing.
	 */
	actor: Actor | undefined;
}

/** What a tool returns: text for the model, optional images, change lines, and whether it failed. */
export interface ToolResult {
	text: string;
	images?: readonly Image[];
	error?: boolean;
	/**
	 * Go's change lines for the user (agent-spec §2.6), which the adapter persists
	 * with this tool result and reports in RunResult.changes and history().
	 */
	changes?: readonly ChangeLine[];
}

/** A tool T3.3 registers. Its name, description and schema reach the model unchanged. */
export interface ToolSpec {
	name: string;
	description: string;
	/** JSON Schema. */
	parameters: object;
	/** "safe" reruns after a crash; a write tool is safe because its change ID dedupes (plan.md · Tools). */
	replay: "safe" | "unsafe";
	/** A write tool (agent-spec §2.4): a run with no actor is blocked from calling it. */
	writes: boolean;
	/**
	 * Offered only to a connection that takes images (cfg.vision, agent-spec §2.5). It
	 * is registered either way, because the setting can change between turns and the
	 * registry is fixed when the harness opens: configure({tools}) drops it per turn.
	 */
	needsVision?: boolean;
	execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * The hook points T3.3 (tools, images) and T3.4 (prompt) fill in. Every one is
 * optional; T3.2 supplies no hooks at all, so the adapter runs on plain text.
 */
export interface AgentHooks {
	/** A reason blocks the call: the model gets an error result instead of an execution. */
	beforeTool?(key: string, call: { name: string; args: unknown }): Promise<string | undefined>;
	/**
	 * Rewrites the system text: the rules, the documents list, and the group line
	 * (agent-spec §3.1-3.4). Both options are per turn: `group` from the submit,
	 * `vision` from the connection this turn resolved.
	 */
	instructions?(key: string, options: { group: boolean; vision: boolean }): Promise<string>;
	/**
	 * The text actually submitted: the snapshot on a fresh context, the delta
	 * after it, and the date line every time (agent-spec §3.5). History shows what
	 * the user typed; this is what the model reads. `state` is the opaque JSON
	 * `userContent` returned last time, and the returned state is stored with this
	 * submission (G11).
	 */
	userContent?(key: string, text: string, options: UserContentOptions): Promise<UserContentResult>;
	/**
	 * Advances the prompt state once the run settled: the entries this run's own
	 * changes touched are what `seen` needs after it, so they are not echoed back
	 * as deltas next turn. A pure function of the state it is given and the
	 * journal records the run's change lines name, so a repeat computes the same
	 * state; it runs only when a `submit()` settles the run, which is why a run
	 * that recovery finishes re-echoes its own writes once (see PromptStateDoc).
	 */
	afterRun?(key: string, result: RunResult, state: unknown): Promise<unknown>;
}

/** What `userContent` is told about the turn it is preparing. */
export interface UserContentOptions {
	/** This turn starts a new context (the first, a reset or a compaction). */
	fresh: boolean;
	/** A Telegram group: each message starts with the speaker's name, and NO_REPLY may silence it. */
	group: boolean;
	/** What `userContent` returned for this conversation last time; null when it has not run yet. */
	state: unknown;
}

/** What `userContent` gives the adapter: the content for the model, and the state to store with it. */
export interface UserContentResult {
	content: string;
	state: unknown;
}

/**
 * What a run reports while it is going. `delta` is incremental: each event is
 * the text appended since the previous one, so a client concatenates them.
 * `reset` means "drop what you showed": a preamble before a tool call (Go's
 * `reset`, agent-spec §2.1), or a partial the model's retry discarded. `retry`
 * carries Go's error text, scrubbed of the key like every other error. `change`
 * is Go's change line, emitted when the tool result that made it is committed,
 * so the page shows its Undo chip while the turn is still running.
 */
export type AgentEvent =
	| { type: "delta"; text: string }
	| { type: "tool"; name: string; status: string }
	| { type: "change"; text: string; id?: string }
	| { type: "reset" }
	| { type: "retry"; at: number; error: string };

/**
 * Go's ChangeLine (`agent.go:54-57`), for the history's change rows (T3.3 fills
 * them). `id` is the journal record's id — the Undo chip, and the record the
 * prompt reads to advance `seen` (G11).
 */
export type ChangeLine = { id?: string; text: string };

/** G8: what a turn produced, or why it failed. T3.5 builds Go's replies from this. */
export type RunResult =
	| {
			status: "answered";
			text: string;
			stop: Stop;
			usage: Usage;
			/** Go's change lines, in call order; `[]` when there are none. */
			changes: ChangeLine[];
			/** The tools this run called, in call order; T3.5 reads it for `lookedInDocs`. */
			toolsUsed: string[];
	  }
	| {
			status: "failed";
			reason: string;
			detail: string;
			/**
			 * What the run spent before it failed: Go's turn accumulated it whatever
			 * ended the turn, and chateval prints it (agent-spec §6.5). Zero when no
			 * request was made at all.
			 */
			usage: Usage;
			/** What was saved before the failure: the user still gets its Undo (agent-spec §2.1). */
			changes: ChangeLine[];
			toolsUsed: string[];
	  };

/** One row of a chat transcript. */
export interface HistoryItem {
	/** The paging cursor: pass it as `before` to read the page under this one. */
	id: number;
	role: "user" | "assistant";
	/**
	 * A user row is what the person typed. An assistant row is what the model
	 * said, before the channel's rules — the route applies `reply.ts` to it, so a
	 * reload shows what the live turn showed (Q1).
	 */
	text: string;
	/** The message's timestamp, epoch milliseconds; display only, it can repeat. */
	at: number;
	/** The run's change lines, on its answer row (or on its user row when it failed). */
	changes?: readonly ChangeLine[];
	/** Assistant rows: how the answer stopped, for the channel's reply rules (Q1). */
	stop?: Stop;
	/** Assistant rows: the tools the run called, for Go's documents-not-found rule (Q1). */
	toolsUsed?: readonly string[];
}

export interface HistoryOptions {
	/** How many items to return at most. */
	limit: number;
	/** Only items older than the one with this id: the `id` of a page's last item. */
	before?: number;
}

export interface HistoryPage {
	/** Newest first. */
	items: HistoryItem[];
	/** Whether older items exist beyond this page. */
	more: boolean;
}

export interface SubmitOptions {
	/** Idempotency key, scoped to the conversation; T4 sends `tg:<update_id>`. */
	requestId?: string;
	/** This turn asked for thinking (a `/think` message). */
	think?: boolean;
	/**
	 * Stops the run when it aborts: a submission not yet placed is withdrawn, one
	 * already running has its conversation aborted.
	 */
	signal?: AbortSignal;
	/** Who typed this turn (`by` in Go): stamped on every write and on the journal record (agent-spec §2.4). */
	actor?: Actor;
	/** A Telegram group chat: the system prompt gets Go's group line (agent-spec §3.4). Web is never a group. */
	group?: boolean;
	/**
	 * What the person typed, when `text` is not it. The web chat strips a `/think`
	 * command before submitting, and the transcript — and every other tab — still
	 * shows the message as typed (P4). Absent means `text` is what was typed.
	 */
	display?: string;
	onEvent?: (event: AgentEvent) => void;
}

/** How the session ended. `failed` means the storage failed and the pod should restart (main.ts). */
export type AgentEnd = { kind: "closed" } | { kind: "failed"; error?: unknown };

export interface Agent {
	/** `movin.epoch`, for the change IDs T3.3 builds. */
	readonly epoch: string;
	readonly closed: Promise<AgentEnd>;
	submit(key: string, text: string, options?: SubmitOptions): Promise<RunResult>;
	history(key: string, options: HistoryOptions): Promise<HistoryPage>;
	/** Start a new context for this key, keeping storage and history. */
	reset(key: string): Promise<void>;
	close(): Promise<void>;
}

/** What openAgent needs from the settings service: one `resolve()` per use. */
export interface SettingsSource {
	resolve(): Promise<LLM>;
}

/** The retry policy as an option: pi-ai's `settings.retry` (durable-api.md §5), baseDelayMs small in tests. */
export interface RetryOptions {
	enabled?: boolean;
	maxRetries?: number;
	baseDelayMs?: number;
	maxAgentDelayMs?: number;
}

export interface OpenAgentOptions {
	/** The SQLite file, e.g. `<dataDir>/harness.db`. One process per database. */
	dbPath: string;
	settings: SettingsSource;
	log: Log;
	/** The harness clock, epoch milliseconds; the idle reset compares against it. */
	now?: () => number;
	tools?: readonly ToolSpec[];
	hooks?: AgentHooks;
	retry?: RetryOptions;
	/**
	 * Test seam: the pi-ai wiring a request goes through. Production uses
	 * llmModels(cfg); T3.2's tests hand in pi-ai's faux provider, which is how a
	 * scripted conversation is proven without a gateway.
	 */
	models?: (cfg: LLM) => ModelWiring;
}

/** AgentChange with its fields writable, so the adapter can fill in only what changed. */
type MutableChange = { -readonly [K in keyof AgentChange]: AgentChange[K] };

/** The harnesses behind the agents, for the test helpers below. */
const harnesses = new WeakMap<object, Harness>();

/** openAgent opens the harness on `dbPath` and hands back the neutral adapter. */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const now = options.now ?? ((): number => Date.now());
	const hooks = options.hooks ?? {};
	const log = options.log;
	const buildModels = options.models ?? llmModels;

	let epoch = "";
	/** The connection in effect; a change of it rebuilds the wiring below. */
	let cfg: LLM | undefined;
	let wiring: ModelWiring | undefined;
	let settings: HarnessSettings = {};
	let models: Models = createModels();
	const keys = new Map<number, string>();
	/** The per-key serialisation tails (see `serial`). */
	const tails = new Map<string, Promise<unknown>>();
	/** The in-flight settings resolve (see `refresh`). */
	let inFlight: Promise<LLM> | undefined;
	/** Set by close(), so a rejection while shutting down is labelled `closed`, not `faulted`. */
	let closing = false;
	/** The names of the write tools, for the actor check before a call is committed (see beforeTool). */
	const writes = new Set((options.tools ?? []).filter((spec) => spec.writes).map((spec) => spec.name));
	/** Every tool with the spec that defines it, so a turn can offer a subset of them (see offeredTools). */
	const tools = (options.tools ?? []).map((spec) => ({ spec, registration: registerTool(spec) }));

	const registry = createRegistry();
	registry.install(
		defineExtension({
			name: "movin.agent",
			tools: tools.map((tool) => tool.registration),
			hooks: agentHooks(),
		}),
	);
	const storage = await openNodeSqliteStorage(options.dbPath, { busyTimeoutMs: 5_000 });
	const harness = await openedHarness();

	try {
		await refresh();
	} catch (err) {
		// A settings read failure must not keep the server from starting: the next
		// submit resolves again, and reports the failure as a `settings_error`.
		log.warn("the saved LLM connection could not be read", { err: errorMessage(err) });
	}

	// G7: resume() straight after open. The restore path (abort live work before
	// scheduling) is T5.3's, and abort()/waitForIdle() would start scheduling
	// before it runs (durable-api.md §8). Here nothing has run yet, so a resume
	// is all a reopened database needs: it reconciles the tasks a crash left.
	harness.resume();

	const agent: Agent = {
		epoch,
		closed: harness.closed,
		submit,
		history,
		reset,
		close,
	};
	harnesses.set(agent, harness);
	return agent;

	/**
	 * openedHarness opens the harness on the storage and creates the epoch. A
	 * failed open closes what it opened — the harness, or just the file when the
	 * harness itself never came up — so a process that then exits (main.ts's
	 * serve) does not leave the database locked behind it.
	 */
	async function openedHarness(): Promise<Harness> {
		let opened: Harness | undefined;
		try {
			opened = await Harness.open(
				storage,
				{
					models: () => models,
					registry,
					// Read at each use (types.d.ts:648), so a settings change needs no reopen.
					settings: () => settings,
					now,
					onReport: (report: Report) => {
						log.error("harness report", { kind: report.kind, err: errorMessage(report.error) });
					},
				},
				background,
			);
			// The session document that makes change IDs unique across databases (T0.2 R4).
			epoch = await opened.commit(async (tx) => {
				const doc = await tx.doc(Epoch);
				if (doc.id === "") doc.id = randomUUID();
				return doc.id;
			}, background);
			return opened;
		} catch (err) {
			const report = (closeError: unknown): void => {
				log.warn("closing after a failed open failed", { err: errorMessage(closeError) });
			};
			if (opened === undefined) await storage.close(background).catch(report);
			else await opened.close(background).catch(report);
			throw err;
		}
	}

	/**
	 * refresh returns the connection in effect, resolving settings at most once at
	 * a time (single flight): overlapping callers share the one resolve, so its
	 * result can neither be overtaken nor applied twice.
	 */
	function refresh(): Promise<LLM> {
		if (inFlight !== undefined) return inFlight;
		const pending = options.settings
			.resolve()
			.then((next) => {
				apply(next);
				return next;
			})
			.finally(() => {
				if (inFlight === pending) inFlight = undefined;
			});
		inFlight = pending;
		return pending;
	}

	/** apply rebuilds the models and the harness settings for one resolved connection. */
	function apply(next: LLM): void {
		if (cfg !== undefined && sameSettings(cfg, next)) return;
		cfg = next;
		wiring = buildModels(next);
		models = wiring.models;
		const model = models.getModel(wiring.modelRef.provider, wiring.modelRef.modelId);
		const contextWindow = model?.contextWindow ?? modelEntry(next).contextWindow;
		settings = {
			// Go's per-request timeout (cfg.TimeoutSec, openai.go:40-42).
			stream: { timeoutMs: next.timeoutSec * 1000 },
			retry: { ...DEFAULT_RETRY_POLICY, ...options.retry },
			compaction: {
				enabled: true,
				// A window under the budget compacts as soon as anything is there;
				// the subtraction must not go negative (types.d.ts:518-541 validates).
				reserveTokens: Math.max(contextWindow - CONTEXT_BUDGET_TOKENS, 0),
				keepRecentTokens: KEEP_RECENT_TOKENS,
				// 0: no background compactions, so a context is compacted at the blocking
				// threshold the budget sets, not at a fraction of the window.
				backgroundTokens: 0,
			},
		};
	}

	/** maxRounds is Go's max(cfg.MaxToolRounds, 1): the tool rounds one turn may take (agent.go:114-117). */
	function maxRounds(): number {
		return Math.max(cfg?.maxToolRounds ?? 1, 1);
	}

	/** registerTool is one ToolSpec as the library's registration: the fields it keeps, and the wrapper. */
	function registerTool(spec: ToolSpec): ReturnType<typeof defineTool> {
		return defineTool({
			name: spec.name,
			description: spec.description,
			parameters: spec.parameters,
			replay: spec.replay,
			// Go runs the calls of one round one after another in call order
			// (agent.go:136-141), and the image cap counts what the earlier calls of
			// the round looked at, so a round must not run its calls at once.
			executionMode: "sequential",
			execute: async (args, api, invokeContext) => {
				// The actor beforeTool put on this tool task. It is a memo, so it is
				// durable: the recovery after a crash starts a safe tool again at its
				// execute phase, where beforeTool does not run again (durable-api.md §7).
				const actor = await api.memo<Actor>(ACTOR_MEMO, invokeContext);
				const result = await spec.execute(args, {
					conversationKey: await keyOf(api.conversationId),
					taskId: String(api.taskId),
					callId: api.callId,
					epoch,
					signal: invokeContext.abortSignal,
					actor,
				});
				logToolCall(actor, spec.name, args, result.text);
				if (result.error === true) {
					return { output: [{ type: "text" as const, text: result.text }], isError: true, ...detailsOf(result) };
				}
				if (result.images !== undefined && result.images.length > 0) {
					// The cap counts the images of this run only, read from its durable
					// tool results, and Go replaces the whole result when a call would
					// exceed it (agent.go:172-232).
					if ((await imagesInRun(api, invokeContext)) + result.images.length > MAX_IMAGES_PER_RUN) {
						return { output: [{ type: "text" as const, text: IMAGE_LIMIT_REPLY }], ...detailsOf(result) };
					}
				}
				const output = [{ type: "text" as const, text: result.text }, ...(result.images ?? []).map(imageContent)];
				return { output, ...detailsOf(result) };
			},
		});
	}

	/**
	 * offeredTools is what a turn offers: every registered tool except the ones the
	 * connection cannot use. The registry is fixed when the harness opens, so a
	 * setting that changes (vision) is applied per turn through configure({tools}),
	 * which the library resolves from the next request on (durable-api.md §2).
	 */
	function offeredTools(next: LLM): ReturnType<typeof defineTool>[] {
		return tools.filter((tool) => tool.spec.needsVision !== true || next.vision).map((tool) => tool.registration);
	}

	function agentHooks(): ReturnType<typeof hook>[] {
		return [
			hook(GenerationTask, {
				// The image placeholder (agent-spec §10.6) rewrites the messages of one
				// request only, so the transcript keeps every image.
				beforeRequest: ({ messages }) => {
					const replaced = replaceEarlierImages(messages);
					return replaced === undefined ? undefined : { messages: replaced };
				},
				// G2, the forced final answer: once N tool rounds are done, the next
				// request carries tool_choice "none", which is Go's ForceAnswer
				// (openai.go:147-149). pi.live.run.turns is committed before the request
				// is prepared, so this sees "N rounds are done" on the forced request.
				beforeProviderRequest: async ({ model, payload }, api, requestContext) => {
					if (model.api !== "openai-completions") return undefined;
					const live = await api.snapshot(LiveDoc, api.conversationId, requestContext);
					if ((live?.run?.turns ?? 0) < maxRounds()) return undefined;
					return { payload: { ...(payload as Record<string, unknown>), tool_choice: "none" } };
				},
				// Go's `llm call` line, once per round (agent.go:181-191); rounds start at 1.
				afterResponse: async (message, api, requestContext) => {
					const live = await api.snapshot(LiveDoc, api.conversationId, requestContext);
					logLLMCall(log, {
						model: message.model,
						round: (live?.run?.turns ?? 0) + 1,
						stop: stopOf(message),
						usage: usageOf(message),
					});
				},
			}),
			hook(ToolTask, {
				// Authorisation before the intent is committed (durable-api.md §7). The
				// block becomes an error result for the model. The actor is read from the
				// run's input entry and kept on the tool task, so a rerun after a crash
				// still stamps the write with who asked (see the execute() memo above).
				beforeTool: async (call, api, requestContext) => {
					const actor = await actorOf(api, requestContext);
					if (actor !== undefined) await api.memo(ACTOR_MEMO, actor, requestContext);
					if (actor === undefined && writes.has(call.name)) return { block: NO_ACTOR };
					if (hooks.beforeTool === undefined) return undefined;
					const reason = await hooks.beforeTool(await keyOf(api.conversationId), {
						name: call.name,
						args: call.arguments,
					});
					return reason === undefined ? undefined : { block: reason };
				},
			}),
		];
	}

	/** keyOf maps a conversation back to its channel key, from the directory. */
	async function keyOf(id: ConversationId): Promise<string> {
		const known = keys.get(id);
		if (known !== undefined) return known;
		const directory = await harness.snapshot(Directory, background);
		for (const [key, value] of Object.entries(directory?.by ?? {})) keys.set(value, key);
		return keys.get(id) ?? "";
	}

	/**
	 * actorOf is who asked this run: the actor stored with the submitted input, read
	 * back from the transcript, so it survives a crash and a replay. A run places
	 * one input entry and none of its rounds places another, so the newest
	 * `movin.user` entry is this run's input; a turn submitted without an actor
	 * stops there and has none — an earlier turn's person must not be borrowed.
	 */
	async function actorOf(api: HookApi, requestContext: Context): Promise<Actor | undefined> {
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await api.entries({ order: "descending" }, PAGE, cursor, requestContext);
			for (const entry of page.items) {
				if (entry.kind === USER_ENTRY) return actorIn(entry.data);
			}
			cursor = page.next;
			if (cursor === undefined) return undefined;
		}
	}

	/**
	 * imagesInRun counts the images this run's earlier calls looked at, from its
	 * durable tool results (agent-spec §2.5): the range starts at the run's first
	 * entry, which the boundary that placed its input recorded, so a replay counts
	 * what the crashed attempt counted. Called only by a call that returned an
	 * image, and the read commits nothing.
	 */
	async function imagesInRun(api: ToolExecutionApi, invokeContext: Context): Promise<number> {
		const live = await api.snapshot(LiveDoc, api.conversationId, invokeContext);
		const first = live?.run?.first;
		if (first === undefined) return 0;
		return await api.commit(async (tx) => {
			let images = 0;
			let cursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanEntries(
					{ conversationId: api.conversationId, order: "ascending", minEntryId: first },
					PAGE,
					cursor,
				);
				for (const entry of page.items) {
					if (entry.kind !== ToolResultEntry.kind) continue;
					for (const part of toolResultOf(entry)?.content ?? []) if (part.type === "image") images++;
				}
				cursor = page.next;
				if (cursor === undefined) return images;
			}
		}, invokeContext);
	}

	/**
	 * logToolCall is Go's `agent tool call` line (tools.go:106-107): who, which
	 * channel, the tool, its arguments and its result cut to 2000 code points. It
	 * never carries the key, and images are not logged.
	 */
	function logToolCall(actor: Actor | undefined, tool: string, args: unknown, result: string): void {
		log.info("agent tool call", {
			by: actor?.by ?? "",
			channel: actor?.channel ?? "",
			tool,
			args: typeof args === "string" ? args : JSON.stringify(args),
			result: cutLogRunes(result),
		});
	}

	/**
	 * conversationFor gets or creates one conversation per key (G1). A new one is
	 * created together with its directory entry in the creating commit, so the two
	 * can never disagree; a second creator — another process on the same volume —
	 * makes that commit throw, and its key is looked up again.
	 */
	async function conversationFor(key: string): Promise<Conversation> {
		const known = await lookup(key);
		if (known !== undefined) return known;
		try {
			const created = await harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					init: async (tx, conversationId) => {
						const directory = await tx.doc(Directory);
						if (directory.by[key] !== undefined) {
							throw new Error(`a conversation for ${key} already exists`);
						}
						directory.by[key] = conversationId;
					},
				},
				background,
			);
			keys.set(created.id, key);
			return created;
		} catch (err) {
			const raced = await lookup(key);
			if (raced !== undefined) return raced;
			throw err;
		}
	}

	/** lookup is conversationFor without the creation: a read must not make a conversation. */
	async function lookup(key: string): Promise<Conversation | undefined> {
		const directory = await harness.snapshot(Directory, background);
		const id = directory?.by[key];
		if (id === undefined) return undefined;
		const conversationId = id as ConversationId;
		const found = await harness.conversation(conversationId, background);
		if (found === undefined) return undefined;
		keys.set(conversationId, key);
		return found;
	}

	/**
	 * headOf is the newest head marker of a conversation: a `pi.reset` or a
	 * compaction summary starts a new context, and an ordinary run has none.
	 */
	async function headOf(conversation: Conversation): Promise<number> {
		const view = await conversation.context(background);
		return view.head?.id ?? 0;
	}

	/** configure sets what a conversation's next request must use, and only what changed (G10). */
	async function configure(
		conversation: Conversation,
		key: string,
		next: LLM,
		think: boolean,
		group: boolean,
	): Promise<void> {
		const agent = await conversation.agent(background);
		const change: MutableChange = {};
		const ref: ModelRef | undefined = wiring?.modelRef;
		if (ref !== undefined && (agent.model?.provider !== ref.provider || agent.model?.modelId !== ref.modelId)) {
			change.model = { provider: ref.provider, modelId: ref.modelId };
		}
		const level = thinkingFor(next, think);
		if (agent.thinkingLevel !== level) change.thinkingLevel = level;
		// G2's backstop: Go's N tool rounds plus the forced answer round.
		const maxTurns = maxRounds() + 1;
		if (agent.maxTurns !== maxTurns) change.maxTurns = maxTurns;
		// The offered tools follow the connection, so a settings change reaches the
		// next request; nothing is committed while the list is the same.
		const offered = offeredTools(next);
		if (!sameNames(agent.tools, offered)) change.tools = offered;
		if (hooks.instructions !== undefined) {
			const instructions = await hooks.instructions(key, { group, vision: next.vision });
			if ((agent.instructions ?? "") !== instructions) change.instructions = instructions;
		}
		if (Object.keys(change).length > 0) await conversation.configure(change, background);
	}

	/**
	 * recordActivity stores when this key was last active, and the head marker the
	 * finished run started with, for the idle reset and the next `fresh`. It runs
	 * after the run, so `at` is the gap's other end: "6 h with no message".
	 */
	async function recordActivity(key: string, head: number): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(ActivityDoc);
			doc.by[key] = { at: now(), head };
		}, background);
	}

	/** submitted is what the run actually sees: text, or the hook's snapshot/delta/date version of it. */
	async function submitted(key: string, text: string, options: UserContentOptions): Promise<UserContentResult> {
		if (hooks.userContent === undefined) return { content: text, state: options.state };
		return hooks.userContent(key, text, options);
	}

	/**
	 * promptState is the state stored with this conversation's last message, or
	 * null. The draft is copied out: a document value is a live overlay, and it
	 * must not escape its commit.
	 */
	async function promptState(conversation: Conversation): Promise<unknown> {
		return await harness.commit(
			async (tx) => plainJson((await tx.doc(PromptStateDoc, conversation.id)).state),
			background,
		);
	}

	/**
	 * commitSubmitted writes the message's prompt state and admits the message in
	 * one commit: a crash keeps both or neither, so the model can never receive a
	 * snapshot whose `seen` was not stored with it. Documents may be written
	 * before the admission (durable-api.md §3), only table writes may not, and
	 * admission comes first for that rule.
	 */
	async function commitSubmitted(
		conversation: Conversation,
		draft: SubmissionDraft,
		state: unknown,
	): Promise<SubmissionId> {
		return await harness.commit(async (tx) => {
			const id = await conversation.submit(tx, draft);
			if (state !== undefined) {
				const doc = await tx.doc(PromptStateDoc, conversation.id);
				if (!sameJson(plainJson(doc.state), state)) doc.state = state as JsonValue;
			}
			return id;
		}, background);
	}

	/** savePromptState stores what `afterRun` returned, in its own commit after the run. */
	async function savePromptState(conversation: Conversation, state: unknown): Promise<void> {
		await harness.commit(async (tx) => {
			const doc = await tx.doc(PromptStateDoc, conversation.id);
			doc.state = state as JsonValue;
		}, background);
	}

	/**
	 * settlePrompt advances the state once the run settled. `afterRun` derives the
	 * next state from the state stored with this message and the run's own change
	 * lines — its journal records, never the live entries — so a repeat computes
	 * the same state instead of applying a second step. It is called only here:
	 * a run that recovery finishes after a crash has no caller, so the next turn
	 * echoes that run's own writes once and nothing is applied twice. A storage
	 * failure is logged: the answer stands, and the state stays at the submit's.
	 */
	async function settlePrompt(
		conversation: Conversation,
		key: string,
		state: unknown,
		result: RunResult,
	): Promise<void> {
		if (hooks.afterRun === undefined) return;
		const next = await hooks.afterRun(key, result, state);
		if (next === undefined || sameJson(state, next)) return;
		await savePromptState(conversation, next).catch((err: unknown) => {
			log.warn("recording the prompt state failed", { err: errorMessage(err) });
		});
	}

	/**
	 * runOf scans one run's entries once: what every round of it spent, the way
	 * Go's turn.usage did, the answer it last committed, the change lines of the
	 * tools it called, and which tools those were. One scan, no commit: entries()
	 * is a read. `to` is absent for a run that failed, which has no answer, so the
	 * scan runs to the newest entry: what it saved is still the user's to undo
	 * (agent-spec §2.1).
	 */
	async function runOf(
		conversation: Conversation,
		from: EntryId,
		to: EntryId | undefined,
	): Promise<{ usage: Usage; answer: AssistantMessage | undefined; changes: ChangeLine[]; tools: string[] }> {
		const usage: Usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
		const changes: ChangeLine[] = [];
		const tools: string[] = [];
		let answer: AssistantMessage | undefined;
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await conversation.entries(
				{ order: "ascending", minEntryId: from, ...(to === undefined ? {} : { maxEntryId: to }) },
				PAGE,
				cursor,
				background,
			);
			for (const entry of page.items) {
				const result = toolResultOf(entry);
				if (result !== undefined) {
					changes.push(...changeLinesIn(result.details));
					tools.push(result.toolName);
				}
				const message = entry.model?.[0];
				if (message?.role !== "assistant") continue;
				answer = message;
				const spent = usageOf(message);
				usage.in += spent.in;
				usage.out += spent.out;
				usage.cacheRead += spent.cacheRead;
				usage.cacheWrite += spent.cacheWrite;
			}
			cursor = page.next;
			if (cursor === undefined) return { usage, answer, changes, tools };
		}
	}

	async function submit(key: string, text: string, submitOptions: SubmitOptions = {}): Promise<RunResult> {
		return serial(key, async () => {
			// A signal that fired while this turn waited in the chain (behind another
			// run, say) must not submit at all: nothing is written and no request is
			// paid for.
			if (stopped(submitOptions.signal)) return aborted();
			let next: LLM;
			try {
				next = await refresh();
			} catch (err) {
				return { status: "failed" as const, reason: "settings_error", detail: errorMessage(err), ...noRun };
			}
			const conversation = await conversationFor(key);

			// G6, the idle reset: before a submit, a gap over 6 h starts a new context.
			// The history stays in storage; only the model's view restarts.
			const activity = (await harness.snapshot(ActivityDoc, background))?.by[key];
			if (activity !== undefined && now() - activity.at > IDLE_RESET_MS) {
				await conversation.reset(undefined, background);
			}
			const head = await headOf(conversation);
			const fresh = activity === undefined || activity.head !== head;

			const group = submitOptions.group === true;
			await configure(conversation, key, next, submitOptions.think === true, group);
			// The state is read before the message is prepared: a restart reads what
			// the last committed message stored, so a crash can neither lose it nor
			// apply it twice.
			const state =
				hooks.userContent === undefined && hooks.afterRun === undefined ? undefined : await promptState(conversation);
			const input = await submitted(key, text, { fresh, group, state });
			const draft: SubmissionDraft = {
				type: "input",
				content: input.content,
				entry: {
					kind: USER_ENTRY,
					data: {
						text: submitOptions.display ?? text,
						...(submitOptions.actor === undefined ? {} : { actor: submitOptions.actor }),
					},
				},
				...(submitOptions.requestId === undefined ? {} : { requestId: submitOptions.requestId }),
			};

			const events = createEvents({ emit: submitOptions.onEvent, apiKey: next.apiKey });
			const watch = await conversation.watch(background);
			events.initialise(watch.value);
			watch.start(async (call) => {
				if (call.kind === "value") events.advance(call.value);
			});
			let settled: SettledSubmissionRecord;
			try {
				// Checked again here: the reset, the configure and the hook above all
				// await, and a client may be gone by now.
				if (stopped(submitOptions.signal)) return aborted();
				let submission: Submission;
				try {
					// The message's state is stored in the same commit as the message
					// (G11), so the two can never disagree after a crash.
					const submissionId = await commitSubmitted(conversation, draft, input.state);
					const admitted = await harness.submission(submissionId, background);
					if (admitted === undefined) return ended(next, new Error("the submitted turn could not be reacquired"));
					submission = admitted;
				} catch (err) {
					// The session is closing or failed: the turn ends rather than throws.
					return ended(next, err);
				}
				const stop = (): void => {
					abortRun(submission, conversation);
				};
				if (stopped(submitOptions.signal)) stop();
				submitOptions.signal?.addEventListener("abort", stop, { once: true });
				try {
					settled = await submission.wait(background);
				} catch (err) {
					return ended(next, err);
				} finally {
					submitOptions.signal?.removeEventListener("abort", stop);
				}
			} finally {
				await watch.stop();
			}
			// A closed session cannot store the activity; the run is what mattered.
			await recordActivity(key, head).catch((err: unknown) => {
				log.warn("recording the conversation activity failed", { err: errorMessage(err) });
			});

			// submit() only ever admits input; a write record here would be a library bug.
			if (settled.type !== "input") {
				return { status: "failed", reason: "faulted", detail: "the submission was not an input", ...noRun };
			}
			// One scan answers what the run spent, what it said, what it changed and
			// which tools it used — for a failed run too, whose changes stay.
			const run =
				settled.entry === undefined
					? { usage: emptyUsage(), answer: undefined, changes: [], tools: [] }
					: await runOf(conversation, settled.entry, settled.status === "done" ? settled.answer : undefined);
			if (settled.status !== "done") {
				// A refusal is an answer (P1, agent-spec §10.12). pi-ai turns
				// finish_reason content_filter into an error stop, and pi-durable ends
				// such a run `model_error`, where Go answers Go's refused text with 200
				// after a reset (agent.go:193-196). runOf scanned past the answer for a
				// failed run, so the last assistant message is here.
				if (settled.reason === "model_error" && run.answer !== undefined && stopOf(run.answer) === "refusal") {
					const refused: RunResult = {
						status: "answered",
						text: stripSpecialTokens(textOf(run.answer.content)),
						stop: "refusal",
						usage: run.usage,
						changes: run.changes,
						toolsUsed: run.tools,
					};
					await settlePrompt(conversation, key, input.state, refused);
					return refused;
				}
				// G8: the detail goes through llmError so a failed request's text is
				// scrubbed of the key, as everything leaving src/llm is.
				const result: RunResult = {
					status: "failed",
					reason: settled.reason,
					detail: llmError(new Error(detailText(settled.detail)), next.apiKey).message,
					usage: run.usage,
					changes: run.changes,
					toolsUsed: run.tools,
				};
				await settlePrompt(conversation, key, input.state, result);
				return result;
			}
			if (run.answer === undefined) {
				const result: RunResult = {
					status: "failed",
					reason: "faulted",
					detail: "the run committed no answer message",
					usage: run.usage,
					changes: run.changes,
					toolsUsed: run.tools,
				};
				await settlePrompt(conversation, key, input.state, result);
				return result;
			}
			const result: RunResult = {
				status: "answered",
				text: stripSpecialTokens(textOf(run.answer.content)),
				stop: stopOf(run.answer),
				usage: run.usage,
				changes: run.changes,
				toolsUsed: run.tools,
			};
			await settlePrompt(conversation, key, input.state, result);
			return result;
		});
	}

	/**
	 * abortRun stops the run a signal belongs to: a submission still queued is
	 * withdrawn, and one already placed — the normal case, admission places an
	 * idle input at once — is stopped through its conversation. Nothing here may
	 * become an unhandled rejection: a close or a failed session is only logged.
	 */
	function abortRun(submission: Submission, conversation: Conversation): void {
		submission
			.abort(background)
			.then(async (outcome) => {
				if (outcome !== "already_placed") return;
				await conversation.abort(background);
			})
			.catch((err: unknown) => {
				log.warn("aborting the run failed", { err: errorMessage(err) });
			});
	}

	/** stopped is whether a caller's signal fired; a helper, so TS does not narrow the property at the call site. */
	function stopped(signal: AbortSignal | undefined): boolean {
		return signal?.aborted === true;
	}

	/** aborted is a turn a signal stopped before it submitted anything. */
	function aborted(): RunResult {
		return { status: "failed", reason: "aborted", detail: "", ...noRun };
	}

	/**
	 * ended turns a rejection into a result, so a shutdown or a fault never
	 * surfaces as an exception in a chat route: `closed` while close() runs,
	 * `faulted` otherwise, with this turn's key scrubbed out of the text. The
	 * activity record is skipped: the session that would store it is gone.
	 */
	function ended(next: LLM, err: unknown): RunResult {
		return {
			status: "failed",
			reason: closing ? "closed" : "faulted",
			detail: llmError(new Error(errorMessage(err)), next.apiKey).message,
			...noRun,
		};
	}

	/**
	 * serial runs one task at a time per key: creation, reset, configure and the
	 * run itself must not overlap for the same conversation (two tabs, a Telegram
	 * double send). Its tail is dropped once it settles.
	 */
	function serial<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = tails.get(key) ?? Promise.resolve();
		const run = previous.then(task, task);
		const tail = run.then(
			() => undefined,
			() => undefined,
		);
		tails.set(key, tail);
		void tail.then(() => {
			if (tails.get(key) === tail) tails.delete(key);
		});
		return run;
	}

	/**
	 * history is a read: it never queues behind a run (a page reload during a 30 s
	 * turn must not wait for it) and never creates a conversation (an unknown key
	 * is empty). A turn in flight shows what is committed of it so far.
	 *
	 * A page ends at a run's edge (P2): one turn's rows are held back until its
	 * input entry arrives — a run's tool results, where its change lines live, come
	 * between the two in entry order and this scan reads downwards — and the whole
	 * run is emitted or none of it is. That is what keeps the cursor on a user row
	 * and each change line on exactly one row, however the pages fall.
	 */
	async function history(key: string, historyOptions: HistoryOptions): Promise<HistoryPage> {
		const conversation = await lookup(key);
		if (conversation === undefined) return { items: [], more: false };
		const query: Omit<EntryQuery, "conversationId"> = {
			order: "descending",
			// The bound is the last item's own entry id: exact, unlike a timestamp,
			// which repeats (a frozen clock, two roles in one millisecond).
			...(historyOptions.before === undefined ? {} : { maxEntryId: historyOptions.before as EntryId }),
		};
		const items: HistoryItem[] = [];
		let more = false;
		let cursor: Cursor | undefined;
		/** This run's answer row, if it left one: the scan sees it before its input entry. */
		let answer: { item: HistoryItem; id: number } | null = null;
		/** This run's tool results with their change lines and tool names, oldest first. */
		let results: { id: number; lines: ChangeLine[]; tool: string }[] = [];
		const linesBetween = (lower: number, upper: number): ChangeLine[] => {
			const lines: ChangeLine[] = [];
			for (const result of results) {
				if (result.id > lower && result.id < upper) lines.push(...result.lines);
			}
			return lines;
		};
		/** commit emits one whole run, its answer then its input, in the list's newest-first order. */
		const commit = (user: { item: HistoryItem; id: number }): boolean => {
			const rows: HistoryItem[] = [];
			if (answer !== null) {
				// The answer row carries the run's own tools, so the route applies Go's
				// documents-not-found rule to a reloaded turn too (Q1).
				rows.push({
					...answer.item,
					changes: linesBetween(user.id, answer.id),
					toolsUsed: results.map((result) => result.tool),
				});
			}
			// A run that left no answer row is a run that did not answer (or one whose
			// only message was a draft), so what it saved goes on its own user row: the
			// Undo chips for it survive a reload, as Go keeps the changes of a run that
			// then errored (agent-spec §2.1, decisions.md · T3.3).
			rows.push(
				answer === null && results.length > 0
					? { ...user.item, changes: linesBetween(user.id, Number.POSITIVE_INFINITY) }
					: user.item,
			);
			// Nothing of a run reaches a page unless all of it does: a page that already
			// has rows ends before this run instead. The first run of a page is always
			// emitted, so a page is never empty while `more` is true — it can be one row
			// over the limit when the limit is smaller than a run.
			if (items.length > 0 && items.length + rows.length > historyOptions.limit) {
				more = true;
				// The run is dropped whole, not left half-collected for the trailing
				// emit below to pick up.
				answer = null;
				results = [];
				return false;
			}
			items.push(...rows);
			answer = null;
			results = [];
			return true;
		};
		outer: for (;;) {
			const page = await conversation.entries(query, PAGE, cursor, background);
			for (const entry of page.items) {
				if (historyOptions.before !== undefined && entry.id >= historyOptions.before) continue;
				if (entry.kind === ToolResultEntry.kind) {
					const result = toolResultOf(entry);
					results.unshift({
						id: entry.id,
						lines: changeLinesIn(result?.details),
						tool: result?.toolName ?? "",
					});
					continue;
				}
				const item = historyItem(entry);
				if (item === undefined) continue;
				if (entry.kind === USER_ENTRY) {
					if (!commit({ item, id: entry.id })) break outer;
					continue;
				}
				answer = { item, id: entry.id };
			}
			cursor = page.next;
			if (cursor === undefined) break;
		}
		// A `before` that starts inside a run (a hand-made cursor; every cursor this
		// route hands out is a user row) still answers what it can see.
		if (answer !== null) {
			items.push({
				...answer.item,
				changes: linesBetween(0, answer.id),
				toolsUsed: results.map((result) => result.tool),
			});
		}
		return { items, more };
	}

	async function reset(key: string): Promise<void> {
		return serial(key, async () => {
			const conversation = await conversationFor(key);
			await conversation.reset(undefined, background);
		});
	}

	async function close(): Promise<void> {
		closing = true;
		await harness.close(background);
	}
}

/**
 * Test helper (T3.2-T3.5): every stored document change, by kind, so a test can
 * prove what the adapter wrote without importing pi-durable — e.g. that an
 * unchanged thinking level commits no `pi.agent` change. Returns the way to
 * stop listening.
 */
export function observeDocuments(
	agent: Agent,
	listener: (change: { kind: string; conversationId: number | undefined }) => void,
): () => void {
	const harness = harnessOf(agent);
	const observation = harness.observeCommits({
		advance: (publication) => {
			for (const change of publication.changes) {
				if (change.type !== "document" || change.kind !== "change") continue;
				listener({ kind: change.record.kind, conversationId: change.conversationId });
			}
		},
		end: () => undefined,
	});
	return observation.detach;
}

/**
 * Test helper: resolve once nothing is running for a key. A reopened database
 * resumes the tasks a crash left, and this is how a test waits for that
 * recovery to finish without importing pi-durable.
 */
export async function whenIdle(agent: Agent, key: string): Promise<void> {
	const harness = harnessOf(agent);
	const directory = await harness.snapshot(Directory, background);
	const id = directory?.by[key];
	if (id === undefined) return;
	const conversation = await harness.conversation(id as ConversationId, background);
	await conversation?.waitForIdle(background);
}

/** harnessOf is the harness behind an agent the test helpers take. */
function harnessOf(agent: Agent): Harness {
	const harness = harnesses.get(agent);
	if (harness === undefined) throw new Error("not an agent this module opened");
	return harness;
}

/** plainJson copies a document value out of its live overlay, so it outlives the commit. */
function plainJson(value: unknown): unknown {
	return value === null || value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** sameJson compares two opaque prompt states, so an unchanged one costs no commit. */
function sameJson(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/** sameSettings compares two resolved connections, for the models cache. */
function sameSettings(a: LLM, b: LLM): boolean {
	return (
		a.baseUrl === b.baseUrl &&
		a.apiKey === b.apiKey &&
		a.model === b.model &&
		a.vision === b.vision &&
		a.timeoutSec === b.timeoutSec &&
		a.maxToolRounds === b.maxToolRounds &&
		a.thinkOnDemand === b.thinkOnDemand
	);
}

/**
 * sameNames compares the tools a conversation is set to offer with the ones this
 * turn wants, in order: the library stores and resolves names, so the names are
 * what a per-turn configuration can be compared by.
 */
function sameNames(a: readonly { readonly name: string }[], b: readonly { readonly name: string }[]): boolean {
	return a.length === b.length && a.every((tool, index) => tool.name === b[index]?.name);
}

/** detailText is a settlement's `detail` (a JsonValue) as text. */
function detailText(detail: unknown): string {
	if (typeof detail === "string") return detail;
	if (detail === undefined) return "";
	return JSON.stringify(detail);
}

/** A turn that made no request and changed nothing: the fields every early failure carries. */
const noRun = { changes: [] as ChangeLine[], toolsUsed: [] as string[], usage: emptyUsage() };

/** Zero spend, for a run that never made a request. */
function emptyUsage(): Usage {
	return { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
}

/**
 * actorIn reads the actor a turn was submitted with (`SubmitOptions.actor`) from
 * the input entry's data. Both fields are checked: the entry is durable, so a
 * shape that changed between versions is `no actor`, not a wrong one.
 */
function actorIn(data: unknown): Actor | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const raw = (data as { actor?: unknown }).actor;
	if (typeof raw !== "object" || raw === null) return undefined;
	const { by, channel } = raw as { by?: unknown; channel?: unknown };
	return typeof by === "string" && typeof channel === "string" ? { by, channel } : undefined;
}

/** toolResultOf is a `pi.tool-result` entry's message, when it holds one; the tool task wrote it. */
function toolResultOf(entry: EntryRecord): ToolResultMessage | undefined {
	const message = entry.model?.[0];
	return message?.role === "toolResult" ? message : undefined;
}

/**
 * changesIn is the change lines a tool result carries: the adapter puts them in
 * the result's `details`, which the tool result message keeps in the transcript
 * (pi-durable's `appendToolResult`), so they survive a crash with the result.
 */
function changesIn(entry: EntryRecord): ChangeLine[] {
	return changeLinesIn(toolResultOf(entry)?.details);
}

/** changeLinesIn reads the `{changes:[{id?,text}]}` details this adapter writes. */
function changeLinesIn(details: unknown): ChangeLine[] {
	const raw = typeof details === "object" && details !== null ? (details as { changes?: unknown }).changes : undefined;
	if (!Array.isArray(raw)) return [];
	const lines: ChangeLine[] = [];
	for (const item of raw) {
		if (typeof item !== "object" || item === null) continue;
		const { id, text } = item as { id?: unknown; text?: unknown };
		if (typeof text !== "string") continue;
		const line: ChangeLine = { text };
		if (typeof id === "string" && id !== "") line.id = id;
		lines.push(line);
	}
	return lines;
}

/** detailsOf carries a result's change lines into its `details`; Go's `id,omitempty` here. */
function detailsOf(result: ToolResult): { details?: { changes: ChangeLine[] } } {
	const changes = result.changes ?? [];
	if (changes.length === 0) return {};
	return {
		details: {
			changes: changes.map((line) => {
				const kept: ChangeLine = { text: line.text };
				if (line.id !== undefined) kept.id = line.id;
				return kept;
			}),
		},
	};
}

/** cutLogRunes is Go's `truncate` (tools.go:113-119): at most n code points, then `…`. */
function cutLogRunes(s: string): string {
	const runes = [...s];
	return runes.length <= LOG_RESULT_RUNES ? s : `${runes.slice(0, LOG_RESULT_RUNES).join("")}…`;
}

/** Whether a message part is an image (the only part the placeholder replaces). */
function isImagePart(part: { readonly type: string }): boolean {
	return part.type === "image";
}

/**
 * replaceEarlierImages replaces every image part of a message older than this
 * run's input with EARLIER_IMAGE, for one request only (plan.md:73, agent-spec
 * §10.6). The run's input is the newest user message: a run places exactly one
 * user message, and the extra user message pi-ai builds from a tool result's
 * images is created after this hook runs — so the images of the current run
 * stay, and every image an earlier run looked at stops costing ~1.8k prompt
 * tokens per request (T0.3). A run continued without a new user message keeps
 * the previous input's images. Returns undefined when nothing changed, so the
 * transcript is left alone otherwise.
 */
function replaceEarlierImages(messages: readonly Message[]): Message[] | undefined {
	const cut = messages.findLastIndex((message) => message.role === "user");
	if (cut < 1) return undefined;
	let changed = false;
	const out = messages.map((message, index) => {
		if (index >= cut || !Array.isArray(message.content) || !message.content.some(isImagePart)) return message;
		changed = true;
		const content = message.content.map((part) =>
			part.type === "image" ? ({ type: "text", text: EARLIER_IMAGE } as const) : part,
		);
		return { ...message, content } as Message;
	});
	return changed ? out : undefined;
}

/** historyItem maps one committed entry to a transcript row; anything that is not a turn is skipped. */
function historyItem(entry: EntryRecord): HistoryItem | undefined {
	const message = entry.model?.[0];
	if (message === undefined) return undefined;
	if (entry.kind === USER_ENTRY) {
		// The model reads `content` (after T3.4, a snapshot or a delta); the person
		// typed `data.text` (durable-api.md §2), and that is what the page shows.
		const data = entry.data;
		const typed = typeof data === "object" && data !== null ? (data as { text?: unknown }).text : undefined;
		const text = typeof typed === "string" ? typed : textOf(message.content);
		return { id: entry.id, role: "user", text, at: message.timestamp };
	}
	if (entry.kind === AssistantEntry.kind && message.role === "assistant") {
		// Only a finished answer is a row. A tool round's preamble is dropped live
		// (the `reset` event, agent-spec §2.1), an aborted or failed attempt is a
		// draft, and the one failure the page does show is a refusal (the stopOf
		// rule complete.ts applies). An answer that said nothing keeps its row: the
		// route turns it into `Done.`, the declined text or the documents line with
		// the same rules the live turn used (Q1).
		const stop = stopOf(message);
		if (stop === "tool" || message.stopReason === "aborted") return undefined;
		if (message.stopReason === "error" && stop !== "refusal") return undefined;
		const text = stripSpecialTokens(textOf(message.content));
		return { id: entry.id, role: "assistant", text, at: message.timestamp, stop };
	}
	return undefined;
}

/**
 * createEvents turns the watch's live states into the neutral events: the
 * answer grows, tool slots appear and change status, a retry starts a backoff.
 *
 * The committed answer is as good as a partial: a provider that answers fast
 * (or a watch whose intermediate states were folded) commits no partial at all,
 * and Go's client still wants its text. `initialise` takes the watch's value at
 * acquisition, so the previous turn's answer is never replayed as a delta.
 */
function createEvents(options: { emit?: (event: AgentEvent) => void; apiKey: string }): {
	initialise: (view: ConversationView) => void;
	advance: (view: ConversationView) => void;
} {
	const emit = options.emit ?? ((): void => undefined);
	/** What the client has been shown so far. */
	let text = "";
	/** The answer entry already shown, so a later commit does not repeat it. */
	let shown = 0;
	const tools = new Map<string, string | undefined>();
	/** The newest entry the client has been shown, so its change lines are not replayed. */
	let changesShown = 0;
	let retryAt: number | undefined;

	/** grow emits the text appended since the last event; a different text replaces it. */
	const grow = (next: string): void => {
		if (next === text) return;
		if (!next.startsWith(text)) {
			if (text !== "") emit({ type: "reset" });
			text = "";
		}
		if (next.length > text.length) {
			emit({ type: "delta", text: next.slice(text.length) });
			text = next;
		}
	};

	const newestAnswer = (view: ConversationView): number =>
		view.entries.findLast((entry) => entry.kind === AssistantEntry.kind)?.id ?? 0;

	return {
		initialise: (view) => {
			// Everything up to now is history, not this turn's output.
			shown = newestAnswer(view);
			text = "";
			changesShown = view.entries.reduce((newest, item) => Math.max(newest, item.id), 0);
		},
		advance: (view) => {
			if (options.emit === undefined) return;
			const entry = view.entries.findLast((item) => item.kind === AssistantEntry.kind);
			if (entry !== undefined && entry.id !== shown) {
				shown = entry.id;
				grow(stripSpecialTokens(textOf(entry.model?.[0]?.content)));
			}
			// `pi.live` is a conversation document: its value is the type above, held
			// as JSON in the view.
			const live = view.docs["pi.live"] as LiveState | undefined;
			for (const slot of live?.tools ?? []) {
				if (tools.get(slot.callId) === slot.status) continue;
				if (text !== "") {
					// Go drops a preamble before a tool call: the page clears the bubble
					// back to "Thinking…" (agent-spec §2.1).
					text = "";
					emit({ type: "reset" });
				}
				tools.set(slot.callId, slot.status);
				emit({ type: "tool", name: slot.name, status: slot.status });
			}
			// The change lines a tool result made are in its committed entry's details
			// (T3.3), so they go out as soon as that entry arrives — Go's `change`
			// event reaches the page while the turn runs, not with `done`
			// (agent-spec §4.2). The newest entry shown is remembered, so nothing is
			// sent twice and the previous turn's results are never replayed.
			for (const item of view.entries) {
				if (item.id <= changesShown) continue;
				changesShown = item.id;
				if (item.kind !== ToolResultEntry.kind) continue;
				for (const line of changesIn(item)) {
					emit(
						line.id === undefined
							? { type: "change", text: line.text }
							: { type: "change", text: line.text, id: line.id },
					);
				}
			}
			const retry = live?.generation?.retry;
			if (retry !== undefined && retry.at !== retryAt) {
				retryAt = retry.at;
				if (text !== "") {
					// The attempt's partial is discarded; the next one starts over.
					text = "";
					emit({ type: "reset" });
				}
				emit({ type: "retry", at: retry.at, error: llmError(new Error(retry.error), options.apiKey).message });
			}
			if (retry === undefined) retryAt = undefined;
			// Only a committed partial grows the answer: an absent `generation` is the
			// end of the run, not an empty answer replacing what was shown.
			const partial = live?.generation?.message;
			if (partial !== undefined) grow(textOf(partial.content));
		},
	};
}
