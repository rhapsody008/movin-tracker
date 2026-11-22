// The durable adapter: the one file that imports pi-durable and chord. It owns
// the harness on SQLite, the conversation directory (`web:<email>`,
// `tg:<chat_id>`), the model and connection wiring, the per-turn thinking, the
// forced final answer, the idle reset, compaction, the per-round usage log, the
// history read-back, the tool wrapper (actor, run-wide image cap, change lines,
// the `agent tool call` line), the image placeholder of earlier runs, the hook
// points T3.4 (prompt) fills in, the outbox: the `movin.outbox.delivery` task
// that hands a reply to a channel and survives a crash between its parts
// (T4.3b, durable-delivery.md §3), and the intake ledger: the channel-neutral
// `movin.intake` document a poll accepts a batch into, and the items a chat's
// worker submits, takes or settles (T4.2a, T4-plan.md §2.2-2.6), the generic
// scheduled task — one looping task per name, owned by the dedicated
// conversation `sys:schedule` — and the pending notes a delivery leaves for the
// chat's next message (T5.1b, T5-plan.md §2.1, §2.3).
//
// Nothing pi-durable-typed leaves this file: submit() answers with the neutral
// RunResult below, and the tools and hooks it is given see plain data. The test
// helpers at the bottom are the exception (the import rule needs them): they
// hand a test the harness's own observations, which a test otherwise could not
// reach without importing pi-durable itself.
//
// Read docs/movin-v3/briefs/durable-api.md for the facts behind each call. The
// decisions the gaps took are in docs/movin-v3/briefs/T3.2.md (G1-G10), and the
// review round's in docs/movin-v3/briefs/T3.2-fixes.md.

import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT as background, type Context, withAbortSignal } from "@earendil-works/chord/context";
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
	defineTask,
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
	type Task,
	type TaskId,
	type ToolExecutionApi,
	ToolResultEntry,
	ToolTask,
	type Tx,
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
import type { StartGuard } from "./startguard.ts";

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
 * The delivery task's kind (`movin.outbox.delivery`). It is a constant because it
 * is also the name a later step has to search storage by: T5.3's restore path
 * aborts the unfinished deliveries of a database it restores.
 */
const OUTBOX_TASK = "movin.outbox.delivery";

/**
 * How often one part may fail before its delivery ends `failed` and the parts
 * after it are dropped (decisions.md · T4 plan change).
 */
const OUTBOX_MAX_ATTEMPTS = 6;

/**
 * The wait before a part's next attempt, by the attempt that failed: 1, 2, 4, 8
 * and 16 s. There is one wait fewer than there are attempts: the last attempt
 * ends the delivery instead of sleeping.
 */
const OUTBOX_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

/**
 * The scheduled task's kind (`movin.schedule`): one looping task per schedule
 * name. Exported like INTAKE_DOC because it is the name a later step searches
 * storage by: T5.3's restore path recreates every schedule task.
 */
export const SCHEDULE_TASK = "movin.schedule";

/**
 * The conversation every scheduled task belongs to (T5-plan §2.1): one of its
 * own, so a chat change in settings needs no task recreation and no chat's abort
 * can reach it. Its tasks are `background: true`, so they never hold a
 * conversation's idle (t5-spec §13.2).
 */
const SCHEDULE_KEY = "sys:schedule";

/**
 * The longest one sleep may be, in milliseconds: 15 minutes (t5-spec §13.12). A
 * wake before the target runs the spec again with the same target, so a changed
 * setting or date is seen within the quarter hour without trusting that a sleep
 * elapsed on time.
 */
export const SCHEDULE_MAX_SLEEP_MS = 15 * 60 * 1000;

/** How long a schedule waits after its spec threw: the task is not faulted, it tries again. */
const SCHEDULE_RETRY_MS = 60_000;

/** Telegram's `retry_after` plus a second of margin, as Go waits it out (decisions.md · T4 plan change). */
const OUTBOX_RETRY_MARGIN_MS = 1000;

/**
 * How long a delivery waits when the process that opened the database has no
 * outbox: the task kind is registered, so such a database opens and its pending
 * deliveries are parked, not faulted. The task wakes, logs, and sleeps again.
 */
const OUTBOX_UNCONFIGURED_MS = 30_000;

/**
 * The intake ledger's doc kind (`movin.intake`). Exported because it is also the
 * name a later step has to search storage by: T5.3's restore path clears the
 * ledger of a database it restores.
 */
export const INTAKE_DOC = "movin.intake";

/**
 * How many accepted item ids the ledger remembers. Dedupe must not depend on an
 * item still being queued (a settled one is gone by design), so the ids of the
 * last accepts are kept: they are what stops a redelivery — and the restore
 * path, which drops the cursor — from running an update twice.
 */
const INTAKE_RECENT = 256;

/**
 * How many items one chat may have accepted and not yet submitted or taken
 * (Go's per-chat queue cap, telegram chat queue full). A chat that floods the
 * bot is dropped rather than growing the ledger without bound.
 */
const INTAKE_PER_KEY = 64;

/** What one delivery sends: the channel's address, its parts in order, and what it must wait for. */
type DeliveryInput = {
	address: OutboxJson;
	parts: OutboxJson[];
	/**
	 * The newest delivery task of this conversation when this one was created, or
	 * null for the first (see DeliveryTail): a chat's deliveries reach the channel
	 * in the order they were created, however their callers interleave.
	 */
	after: number | null;
};

/**
 * How far a delivery got: the part it is on, and how many attempts that part has
 * used. `next` moves only in the commit that follows a successful send, so a
 * crash resends at most the part that was in flight.
 */
type DeliveryCheckpoint = { phase: "send"; next: number; attempts: number };

/** A delivery that reached the end of its parts. */
type DeliveryResult = { sent: number };

/** What a scheduled task is: its name, the key of its guard entry and of its spec. */
type ScheduleInput = { name: string };

/**
 * Where a scheduled task is: the phase it runs, and the target its spec last
 * answered (epoch milliseconds; null before the first run and while a failed run
 * or a parking task keeps the one it had).
 */
type ScheduleCheckpoint = { phase: "run"; target: number | null };

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
 * The newest delivery task of each conversation (`movin.outbox`), written in the
 * commit that creates one. A delivery reads it inside that commit to learn which
 * task it has to wait for, so two deliveries for one chat cannot overtake each
 * other even when their callers create them at once: commits are serialised, so
 * the second creator reads the task the first one left behind.
 */
const DeliveryTail = defineDoc<{ task: number | null }>({
	kind: "movin.outbox",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ task: null }),
	checkpointWhen: () => true,
});

/**
 * The tasks that already exist, by schedule name (`movin.schedule`), written in
 * the commit that creates one. It is what makes `ensureSchedules()` idempotent:
 * an open reuses the task it finds here unless that task ended, and a restore
 * clears the document and starts over (T5-plan §2.1).
 */
const ScheduleGuard = defineDoc<{ by: Record<string, number> }>({
	kind: SCHEDULE_TASK,
	version: 1,
	scope: "session",
	initial: () => ({ by: {} }),
	checkpointWhen: () => true,
});

/**
 * A note a delivery leaves for a chat's next message (`movin.notes`): the check-in
 * of 09:30 reaches the model with the message of 10:00 (T5-plan §2.3). `tag` is
 * how a later note replaces an earlier one — a second check-in of the same day
 * must not stack up. The text is the host's, verbatim: the adapter knows nothing
 * of check-ins.
 */
export type PendingNote = { tag: string; text: string };

/**
 * The pending notes of one conversation, read by the next `submit` and cleared in
 * its admission commit. A document and not a transcript entry on purpose: the 6 h
 * idle reset would hide an entry, an entry appended mid-run could end a context or
 * split a tool call from its result, and web history must not show the note at all
 * (T5-plan §2.3).
 */
const Notes = defineDoc<{ pending: PendingNote[] }>({
	kind: "movin.notes",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ pending: [] }),
	checkpointWhen: () => true,
});

/**
 * The start counter and the restore id (`movin.start`, T5.3a): what this
 * database last acknowledged. `starts` is the number its S3 counter was set to
 * on its last start, `restoreId` the HARNESS_RESTORE_ID that start recorded. A
 * restored copy finds them behind the S3 counter — or the id different — and
 * runs the restore path; the record is written before S3 on purpose, so a crash
 * between the two reruns the path instead of skipping it (T5-plan §2.4).
 */
const Start = defineDoc<{ starts: number; restoreId: string }>({
	kind: "movin.start",
	version: 1,
	scope: "session",
	initial: () => ({ starts: 0, restoreId: "" }),
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
 * The stored intake ledger: the state a worker reads, plus the ids already
 * accepted (`recent`, which `state()` keeps to itself). Every write to it is
 * stored as a complete base: it is a small document read whole, never rewound.
 *
 * `acceptedAt` is when the last batch was accepted (epoch milliseconds, 0 when
 * none ever was). Telegram picks a random `update_id` again after a week of
 * silence, so the bot needs it to know whether a stored cursor may be hiding
 * new updates (T4.2b).
 */
type IntakeLedger = IntakeState & { recent: number[] };

/**
 * The intake ledger, `movin.intake` (T4.2a, T4-plan.md §2.1): the offset a poll
 * is at, the ids it has accepted, the items accepted and not yet submitted or
 * taken, and the turns submitted and not yet settled. Session-scoped, because
 * one poll feeds every chat.
 *
 * It is what makes polling independent of a turn: the batch is one commit, and
 * the turn runs afterwards on its chat's own queue. `recent` is why dedupe is
 * durable — a settled item is gone from `queue` and `open` by design, so only
 * the id list can tell a redelivery from a new update.
 */
const Intake = defineDoc<IntakeLedger>({
	kind: INTAKE_DOC,
	version: 1,
	scope: "session",
	initial: () => ({ cursor: 0, acceptedAt: 0, recent: [], queue: [], open: [] }),
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
	/**
	 * The notes sent to this chat since its last message, oldest first, which this
	 * turn is the last reader of: `commitSubmitted` clears them with the message.
	 * Absent when there are none.
	 */
	notes?: readonly PendingNote[];
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

/**
 * G8: what a turn produced, or why it failed. T3.5 builds Go's replies from this.
 *
 * `failed` is not always an outcome. A caller must treat `failed` with reason
 * `closed` (the session was shutting down) or `faulted` (the storage failed) as
 * **not settled** — see `isUnsettled`: the turn is still durable and unanswered,
 * so a channel worker stops and leaves its intake item `open` rather than
 * rendering that as the turn's reply. The restart's `attach` reports what really
 * happened.
 */
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

/**
 * What an outbox carries: the address a channel needs to answer, and one part of
 * a reply. It is JSON and nothing more, so the adapter never learns what a
 * channel puts in it.
 */
export type OutboxJson = null | boolean | number | string | OutboxJson[] | { [key: string]: OutboxJson };

/**
 * Where a reply goes; T4.2b supplies it from the Telegram client. The send runs
 * outside every commit — it is the one effect the delivery task cannot make
 * durable, which is why a delivery is at-least-once per part.
 */
export interface Outbox {
	/** Sends one part. Throws OutboxError to steer the retry; any other error counts as transient. */
	send(address: OutboxJson, part: OutboxJson, signal?: AbortSignal): Promise<void>;
}

/**
 * A send's failure, as the delivery task reads it. Anything else a send throws is
 * transient: it backs off and tries the same part again.
 */
export class OutboxError extends Error {
	/** Wait this long before this part's next attempt (Telegram's 429 `retry_after`, in milliseconds). */
	retryAfterMs?: number;
	/** This part can never be sent: the delivery ends `failed` and the parts after it are dropped. */
	permanent?: boolean;
}

/**
 * One accepted update: what a channel's poll took in. Everything but the id, the
 * key and the clock is opaque to the adapter — `payload` is the update itself
 * (its text or its command) and `address` is where its reply goes.
 */
export type IntakeItem = {
	/** The channel's own id for the update (Telegram's `update_id`); dedupe is on it. */
	id: number;
	/** The conversation key the update belongs to (`tg:<chat_id>`); the per-chat cap and worker order use it. */
	key: string;
	/** Where a reply to this item goes, as the channel understands it. */
	address: OutboxJson;
	/** What was accepted, as the channel understands it. */
	payload: OutboxJson;
	/** When it was accepted, epoch milliseconds. */
	at: number;
};

/**
 * An item whose turn has been submitted: which submission to attach to after a
 * restart, and when the watchdog has to stop waiting for it. `submission` is the
 * id as a plain number, the ledger's own and the one `attach` takes, so nothing
 * converts it back and forth.
 */
export type OpenTurn = IntakeItem & { submission: number; deadlineAt: number };

/** What the ledger holds: the next poll's offset, the last accept, and the items still to work on. */
export type IntakeState = {
	cursor: number;
	/** When a batch was last accepted, epoch milliseconds; 0 when none ever was. */
	acceptedAt: number;
	queue: IntakeItem[];
	open: OpenTurn[];
};

/**
 * The intake ledger (T4.2a): a poll batch is accepted durably before the offset
 * moves, so no turn ever holds polling up, and each accepted item becomes exactly
 * one turn or one command across a crash. Nothing here is Telegram's: the key,
 * the address and the payload are the channel's.
 */
export interface Intake {
	/**
	 * Takes one poll batch in one commit: the ids it has not accepted before go to
	 * `queue` and `recent`, the cursor moves to the batch's own offset, and what it
	 * actually added is returned. A chat already holding INTAKE_PER_KEY queued
	 * items drops the rest with a warning; the dropped ids still count as accepted,
	 * so a redelivery is dropped again rather than queued late. It also records
	 * `acceptedAt`, so a channel can tell a stale cursor from a fresh one.
	 *
	 * `fresh` is for the batch a stale poll brings back (Telegram picks a new
	 * random `update_id` after a week of silence, and drops updates after a day):
	 * the ids `recent` remembers are ones Telegram no longer has, so the batch is
	 * not deduped against them. What is queued or open is still deduped, because
	 * that is work this ledger is holding.
	 */
	accept(batch: { cursor: number; items: readonly IntakeItem[]; fresh?: boolean }): Promise<IntakeItem[]>;
	/** What is accepted and unfinished, and the next offset. A read: it commits nothing. */
	state(): Promise<IntakeState>;
	/**
	 * Removes an item and answers whether this call was the one: at-most-once, for
	 * commands, callbacks, refusals and the fixed non-text lines. A crash after the
	 * take loses the item rather than repeating it.
	 */
	take(id: number): Promise<boolean>;
	/**
	 * Drops an item and, in the same commit, queues its reply: `parts` non-empty
	 * creates exactly one delivery and one send however often this is called, and
	 * `null` settles silently. An id it no longer holds does nothing.
	 */
	settle(id: number, key: string, address: OutboxJson, parts: readonly OutboxJson[] | null): Promise<void>;
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
	/**
	 * The intake ledger item this turn is the run of (T4.2a): the submit commit
	 * moves it from `queue` to `open` with this submission, so a crash after it
	 * leaves a turn to attach and settle, never a second one to submit.
	 */
	intake?: { id: number; deadlineAt: number };
	onEvent?: (event: AgentEvent) => void;
}

/** How the session ended. `failed` means the storage failed and the pod should restart (main.ts). */
export type AgentEnd = { kind: "closed" } | { kind: "failed"; error?: unknown };

/**
 * One scheduled job's host half (T5-plan §2.1): the check-in's tick (T5.1c), the
 * daily document sync (T5.2). The adapter knows nothing of what a spec does; it
 * only calls it and sleeps until the target it answers.
 */
export interface ScheduleSpec {
	/** The name of the task and of its entry in `movin.schedule` ("checkin", "docsync"). */
	name: string;
	/**
	 * Runs one tick and answers the next target, epoch milliseconds. `target` is the
	 * target the last run stored, null for the first.
	 */
	run(ctx: { target: number | null; signal?: AbortSignal }): Promise<number>;
}

/** What one scheduled task is doing, for the tests and for a restore's log line. */
export interface ScheduleInspection {
	/** The schedule name (`movin.schedule`'s key). */
	name: string;
	/** The scheduler's view of it: `running`, `pending`, `sleeping`, `waiting`, `completing` or `blocked`. */
	state: string;
	/** When it wakes, for a sleeping task. */
	until?: number;
	/** The target its checkpoint holds; null before its first run. */
	target: number | null;
}

export interface Agent {
	/** `movin.epoch`, for the change IDs T3.3 builds. */
	readonly epoch: string;
	readonly closed: Promise<AgentEnd>;
	/** The channel-neutral intake ledger (T4.2a): accept a poll batch, take a command, settle a turn. */
	readonly intake: Intake;
	submit(key: string, text: string, options?: SubmitOptions): Promise<RunResult>;
	/**
	 * Resolves to the result of a turn already submitted (`intake.state().open[].submission`):
	 * how a restart picks up the turns a crash left running, and how the watchdog
	 * waits one out. Unlike `submit` it does not advance the prompt state (P5b: the
	 * model hears its own writes once more after a crash), and `signal` stops the
	 * turn the way `submit`'s does.
	 */
	attach(key: string, submissionId: number, options?: { signal?: AbortSignal }): Promise<RunResult>;
	/**
	 * Resolves once the conversation behind `key` has no live run and no live
	 * conversation-owned task — deliveries included, so a chat's next turn starts
	 * after the previous reply is out. An unknown key is idle at once.
	 */
	idle(key: string): Promise<void>;
	/**
	 * Queue one reply for the channel behind `key`, as parts sent in order. Resolves
	 * once the delivery task is stored, not once it is sent: at-least-once per part,
	 * and durable across a restart. Needs `OpenAgentOptions.outbox`.
	 *
	 * `note` leaves a pending note for this chat's next message in the same commit
	 * (T5-plan §2.3): a check-in sent at 09:30 reaches the model with the chat's
	 * message of 10:00. A note with the same tag replaces the one before it.
	 */
	deliver(
		key: string,
		address: OutboxJson,
		parts: readonly OutboxJson[],
		options?: { note?: PendingNote },
	): Promise<void>;
	/** The schedules this process runs: ask one to run again now (a setting changed). */
	readonly schedule: { rearm(name: string): Promise<void> };
	history(key: string, options: HistoryOptions): Promise<HistoryPage>;
	/** Start a new context for this key, keeping storage and history. */
	reset(key: string): Promise<void>;
	close(): Promise<void>;
}

/**
 * How the harness arms a timer, as `HarnessOptions.setTimer` takes it: call
 * `callback` about `delayMs` from now, and return the way to disarm it.
 */
export type Timer = (
	callback: () => void,
	delayMs: number,
	options: { readonly background: boolean },
) => (() => void) | undefined;

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
	/**
	 * The restore guard (T5.3a): present, this open decides whether the database was
	 * restored and runs the restore path before `resume()`. Absent (tests, eval), a
	 * start is what it always was: the schedules, then `resume()`.
	 */
	startGuard?: StartGuard;
	settings: SettingsSource;
	log: Log;
	/** The harness clock, epoch milliseconds; the idle reset compares against it. */
	now?: () => number;
	tools?: readonly ToolSpec[];
	hooks?: AgentHooks;
	/**
	 * Test seam: the channel a delivery goes through. Without one, `deliver()` throws
	 * and a delivery a database already holds waits instead of sending (see
	 * OUTBOX_UNCONFIGURED_MS).
	 */
	outbox?: Outbox;
	retry?: RetryOptions;
	/**
	 * The scheduled jobs this process runs (`ScheduleSpec`). A task of a name that is
	 * not here — one a process with the spec created — parks and warns instead of
	 * faulting, so the kind stays registered everywhere.
	 */
	schedules?: readonly ScheduleSpec[];
	/**
	 * Test seam, tests only: production uses pi-durable's `setTimeout`. A later
	 * step's sleeps (the outbox's backoff) are stored on `now` but armed in real
	 * milliseconds, so a test with a manual clock needs to own the timer too.
	 */
	setTimer?: Timer;
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

/** The creating commit behind each agent, for the compare-and-set test helper below. */
const creates = new WeakMap<object, (name: string, was: TaskId | undefined) => Promise<TaskId | undefined>>();

/** openAgent opens the harness on `dbPath` and hands back the neutral adapter. */
export async function openAgent(options: OpenAgentOptions): Promise<Agent> {
	const now = options.now ?? ((): number => Date.now());
	const hooks = options.hooks ?? {};
	const log = options.log;
	const outbox = options.outbox;
	const delivery = deliveryTask();
	const schedule = scheduleTask();
	const buildModels = options.models ?? llmModels;
	/** The specs this process runs, by name (a name it has no spec for parks, see scheduleTask). */
	const schedules = new Map((options.schedules ?? []).map((spec) => [spec.name, spec]));
	/** The names `rearm()` was called on while their task was running: the current run sleeps 0. */
	const rearmed = new Set<string>();
	/** The names already warned about: a process without a spec warns once, not every quarter hour. */
	const warned = new Set<string>();

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
			tasks: [delivery, schedule],
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

	// T5.3a: the restore guard's decision, the restore path, the one acknowledging
	// commit and the scheduled tasks — every commit a start needs, before anything
	// is scheduled. A failure here closes what was opened and fails the start (the
	// pod restarts) rather than resuming a database it could not make safe.
	try {
		await startUp();
	} catch (err) {
		await harness.close(background).catch(async (closeError: unknown) => {
			log.warn("closing after a failed open failed", { err: errorMessage(closeError) });
		});
		throw err;
	}

	// G7: resume() comes last. The restore path before it only marks records (the
	// aborts it commits run nothing), and resume() is what turns scheduling on and
	// runs the handlers the crash left (durable-api.md §8).
	harness.resume();

	const agent: Agent = {
		epoch,
		closed: harness.closed,
		intake: { accept, state, take, settle },
		submit,
		attach,
		idle,
		deliver,
		schedule: { rearm },
		history,
		reset,
		close,
	};
	harnesses.set(agent, harness);
	creates.set(agent, createSchedule);
	return agent;

	/**
	 * startUp is everything a start does before `resume()` (T5.3a, T5-plan §2.4):
	 * the guard's decision, the restore path, one acknowledging commit, the
	 * scheduled tasks, and then the S3 half of the counter. Without a guard — tests,
	 * eval — only the schedules happen, as they did before T5.3a.
	 */
	async function startUp(): Promise<void> {
		const guard = options.startGuard;
		if (guard === undefined) {
			// T5.1b: every schedule this process runs has its task before anything is
			// scheduled, so a reopened database neither runs one twice nor leaves one
			// missing, and `rearm()` finds the task it is asked about.
			await ensureSchedules();
			return;
		}
		const recorded = await harness.snapshot(Start, background);
		// Nothing is resumed while this waits: a restored database may not send, and
		// a wrong "nothing happened" drops every pending reply (decision 13.15).
		const decision = await guard.check({ starts: recorded?.starts ?? 0, restoreId: recorded?.restoreId ?? "" });
		const aborted = decision.restore === false ? { tasks: 0, submissions: 0 } : await abortLiveWork();
		// A new epoch, so a change ID minted after the restore cannot collide with the
		// lost timeline's (T5-plan §5.2).
		const rotated = decision.restore === false ? undefined : randomUUID();
		// One commit acknowledges: the counter and the id this database now carries,
		// and on a restore the dropped intake, the new epoch and the cleared schedule
		// guard. SQLite before S3 on purpose: the other order turns a crash between the
		// two into a false restore at the next start.
		const dropped = await harness.commit(async (tx) => {
			const start = await tx.doc(Start);
			start.starts = decision.starts;
			start.restoreId = decision.restoreId;
			if (rotated === undefined) return 0;
			const intake = await tx.doc(Intake);
			const count = intake.queue.length + intake.open.length;
			// The queue and the open turns are the timeline's: both go, and the cursor
			// with them (Telegram's own pending queue is used again). `recent`
			// stays, so a redelivered known update is still dropped (decision 13.14).
			intake.queue.length = 0;
			intake.open.length = 0;
			intake.cursor = 0;
			(await tx.doc(Epoch)).id = rotated;
			// "Recreate from settings": the tasks themselves were aborted above, and
			// `ensureSchedules()` starts over from an empty guard.
			(await tx.doc(ScheduleGuard)).by = {};
			return count;
		}, background);
		if (rotated !== undefined) epoch = rotated;
		await ensureSchedules();
		log.info("harness start", {
			starts: decision.starts,
			restore: decision.restore === false ? "none" : decision.restore,
			...(decision.restore === false
				? {}
				: { tasksAborted: aborted.tasks, submissionsAborted: aborted.submissions, intakeDropped: dropped }),
		});
		// SQLite is already the truth: a failed write here only leaves S3 behind, and
		// the next start heals it through `max()`.
		await guard.committed(decision.starts);
	}

	/**
	 * abortLiveWork aborts every live task and unsettled submission by id (T5-plan
	 * §5.2): a restored database must not resend an old reply, replay a tool or
	 * start an input the lost timeline accepted. Background tasks are included —
	 * `inspect()` lists them, `conversation.abort()` would not — and `terminal` is
	 * fine: a task already ending is one this start must not continue. Never
	 * `conversation.abort()` or `waitForIdle()` here: both start scheduling (G7).
	 * A failure is the caller's: the start fails and the pod restarts.
	 */
	async function abortLiveWork(): Promise<{ tasks: number; submissions: number }> {
		const inspection = await harness.inspect(background);
		let submissions = 0;
		for (const record of inspection.submissions) {
			const outcome = await harness.abortSubmission(record.id, background);
			if (outcome === "aborted" || outcome === "already_placed") submissions++;
		}
		let tasks = 0;
		for (const task of inspection.tasks) {
			await harness.abortTask(task.record.id, background);
			tasks++;
		}
		return { tasks, submissions };
	}

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
					...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
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
	 *
	 * It is also where an intake item becomes an open turn (T4.2a): the same commit
	 * that admits the message moves the item from `queue` to `open`, so a crash
	 * either leaves the item queued (nothing submitted) or leaves a turn to attach
	 * and settle — never a second run of the same update.
	 */
	async function commitSubmitted(
		conversation: Conversation,
		draft: SubmissionDraft,
		state: unknown,
		intake: SubmitOptions["intake"],
		notes: readonly PendingNote[],
	): Promise<SubmissionId> {
		return await harness.commit(async (tx) => {
			const id = await conversation.submit(tx, draft);
			if (state !== undefined) {
				const doc = await tx.doc(PromptStateDoc, conversation.id);
				if (!sameJson(plainJson(doc.state), state)) doc.state = state as JsonValue;
			}
			// The notes this message just carried are consumed with it (T5-plan §2.3):
			// the message and their removal are one commit, so a crash can neither show
			// a note twice nor lose one that was never shown. Only the notes this turn
			// read go: `deliver` does not wait for the turn, so a check-in that landed
			// while `userContent` ran is committed here and belongs to the next turn.
			if (notes.length > 0) {
				const doc = await tx.doc(Notes, conversation.id);
				doc.pending = doc.pending.filter(
					(left) => !notes.some((note) => note.tag === left.tag && note.text === left.text),
				);
			}
			if (intake !== undefined) {
				const doc = await tx.doc(Intake);
				const queued = doc.queue.findIndex((item) => item.id === intake.id);
				const item = queued < 0 ? undefined : doc.queue.splice(queued, 1)[0];
				// Not queued means it is already open or settled: the submit stands, and
				// the item is left where it is (the requestId check is what makes the
				// duplicate case a no-op in the first place).
				if (item !== undefined) doc.open.push({ ...item, submission: id, deadlineAt: intake.deadlineAt });
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
	 * deliver queues one reply and resolves once it is stored. The send itself is
	 * the delivery task's work: it must not happen inside the creating commit, and
	 * the caller must not wait for it (durable-delivery.md §3). An empty reply
	 * stores nothing, and a process with no channel to send through says so — the
	 * task cannot fall back on one.
	 */
	async function deliver(
		key: string,
		address: OutboxJson,
		parts: readonly OutboxJson[],
		options: { note?: PendingNote } = {},
	): Promise<void> {
		if (parts.length === 0) return;
		if (outbox === undefined) throw new Error("no outbox configured");
		const conversation = await conversationFor(key);
		await harness.commit(async (tx) => {
			await createDelivery(tx, conversation.id, address, parts);
			const note = options.note;
			// The note rides in the creating commit (T5-plan §2.3): a crash leaves the
			// reply queued with its note, or neither, so the chat's next message never
			// reads a note whose check-in was never sent.
			if (note === undefined) return;
			const doc = await tx.doc(Notes, conversation.id);
			const existing = doc.pending.findIndex((pending) => pending.tag === note.tag);
			if (existing >= 0) doc.pending.splice(existing, 1);
			doc.pending.push({ tag: note.tag, text: note.text });
		}, background);
	}

	/**
	 * createDelivery is the one place a delivery task is created, inside the
	 * caller's commit: `deliver()` owns that commit, and T4.2a's settle commit
	 * creates the reply of a turn together with the ledger change that settles it,
	 * so a crash can lose neither. It also records the task as the conversation's
	 * newest delivery, so the next one waits for this one instead of overtaking it.
	 */
	async function createDelivery(
		tx: Tx,
		conversationId: ConversationId,
		address: OutboxJson,
		parts: readonly OutboxJson[],
	): Promise<TaskId<DeliveryResult>> {
		const tail = await tx.doc(DeliveryTail, conversationId);
		const id = await tx.createTask(
			delivery,
			{ address, parts: [...parts], after: tail.task },
			{ ownership: { kind: "conversation" }, conversationId },
		);
		tail.task = id;
		return id;
	}

	/**
	 * pendingNotes is the notes this chat's next message carries, oldest first. It
	 * commits nothing, and the copy leaves the overlay behind.
	 */
	async function pendingNotes(conversation: Conversation): Promise<PendingNote[]> {
		const doc = await harness.snapshot(Notes, conversation.id, background);
		return (doc?.pending ?? []).map((note) => ({ tag: note.tag, text: note.text }));
	}

	/**
	 * ensureSchedules creates the task of every spec this process runs (T5-plan
	 * §2.1): once per open, before resume(). The guard document is what makes it
	 * idempotent — an open reuses the task it finds there, and only a task that
	 * ended is replaced. `abortRequested` counts as ended: the abort is its own
	 * commit (pi-durable's `Tx` has no abort, `types.d.ts:895-960`), so a crash
	 * between the abort and the replacement leaves a mark the guard still names,
	 * and keeping it would leave this process with no check-in task at all.
	 */
	async function ensureSchedules(): Promise<void> {
		if (schedules.size === 0) return;
		const guard = await harness.snapshot(ScheduleGuard, background);
		for (const name of schedules.keys()) {
			const recorded = guard?.by[name];
			const id = recorded === undefined ? undefined : (recorded as TaskId);
			const task = id === undefined ? undefined : await harness.getTask(id, background);
			if (task !== undefined && task.state.status !== "terminal" && !task.abortRequested) continue;
			await createSchedule(name, id);
		}
	}

	/**
	 * createSchedule creates one schedule task and records it, in one commit: the
	 * document and the task can never disagree, so a crash between two commits
	 * cannot leave a second task behind. `was` is the task it replaces, if any, and
	 * the commit compares the guard against it: a rearm that overlapped this one
	 * (or an open that got there first) has already made the replacement, and that
	 * task is the live one — creating a second would leave one nothing looks at
	 * again, looping for ever. It answers the id the guard now holds (undefined
	 * only if the guard lost the name meanwhile, which only a restore does).
	 */
	async function createSchedule(name: string, was: TaskId | undefined): Promise<TaskId | undefined> {
		const conversation = await conversationFor(SCHEDULE_KEY);
		const outcome = await harness.commit(async (tx) => {
			const guard = await tx.doc(ScheduleGuard);
			const current = guard.by[name];
			// The guard stores the id as a plain number; it is the TaskId it was made from.
			if (current !== was) return { id: current as TaskId | undefined, created: false };
			const created = await tx.createTask(
				schedule,
				{ name },
				{ ownership: { kind: "conversation" }, conversationId: conversation.id, background: true },
			);
			guard.by[name] = created;
			return { id: created, created: true };
		}, background);
		// Logged only by the call that made the replacement, not by one the
		// compare-and-set turned away.
		if (outcome.created && was !== undefined) log.info("schedule task replaced", { name, was: String(was) });
		return outcome.id;
	}

	/**
	 * rearm makes one schedule run now: a setting it reads changed (T5-plan §2.1).
	 * A sleeping task is aborted and replaced — pi-durable has no call that wakes a
	 * sleeping task, and the new task runs at once with no target. A running task is
	 * never aborted (that would leave its work half done): it sleeps 0 after the run
	 * it is in, so the next run starts at once and reads the new setting.
	 *
	 * One name at a time: two overlapping rearms (a double-click, two tabs) would
	 * otherwise both see the same sleeping task and both replace it. An
	 * abort-marked task is gone, as it is for `ensureSchedules()`: its abort already
	 * committed, so the replacement is all that is left to do.
	 */
	async function rearm(name: string): Promise<void> {
		await serial(`${SCHEDULE_KEY}:${name}`, async () => {
			const recorded = (await harness.snapshot(ScheduleGuard, background))?.by[name];
			const id = recorded === undefined ? undefined : (recorded as TaskId);
			const task = id === undefined ? undefined : await harness.getTask(id, background);
			if (task !== undefined && task.state.status !== "terminal" && !task.abortRequested) {
				if (task.state.status !== "sleeping") {
					rearmed.add(name);
					return;
				}
				await harness.abortTask(task.id, background);
			}
			await createSchedule(name, id);
		});
	}

	/**
	 * accept takes one poll batch in one commit (T4.2a): the cursor and every item
	 * it adds are durable together, so polling never waits for a turn, and a crash
	 * between two batches can neither lose one nor process one twice.
	 */
	async function accept(batch: {
		cursor: number;
		items: readonly IntakeItem[];
		fresh?: boolean;
	}): Promise<IntakeItem[]> {
		return await harness.commit(async (tx) => {
			const doc = await tx.doc(Intake);
			// A stale poll's ids may be ones Telegram dropped long ago, so `recent` says
			// nothing about them (B2); the queue and the open turns still do.
			if (batch.fresh === true) doc.recent.length = 0;
			const known = new Set(doc.recent);
			for (const queued of doc.queue) known.add(queued.id);
			for (const turn of doc.open) known.add(turn.id);
			const added: IntakeItem[] = [];
			for (const item of batch.items) {
				if (known.has(item.id)) continue;
				known.add(item.id);
				// Accepted whether or not it is queued: a redelivery is dropped the same way.
				doc.recent.push(item.id);
				if (doc.queue.filter((queued) => queued.key === item.key).length >= INTAKE_PER_KEY) {
					// Go's "telegram chat queue full, dropping update": the chat is behind, and
					// the cursor still moves, so the poll is never stuck on this batch.
					log.warn("intake queue full, dropping update", { key: item.key, id: item.id });
					continue;
				}
				// Copied field by field: the caller's object outlives this commit, and a
				// document value must not.
				const kept: IntakeItem = {
					id: item.id,
					key: item.key,
					address: item.address,
					payload: item.payload,
					at: item.at,
				};
				doc.queue.push(kept);
				added.push(kept);
			}
			// Only the newest ids are kept: a settled item is gone from `queue` and `open`
			// by design, so its id has to outlive it for a redelivery to be recognised.
			if (doc.recent.length > INTAKE_RECENT) doc.recent.splice(0, doc.recent.length - INTAKE_RECENT);
			// The batch's own offset, forwards or back: a poll at 0 after six quiet days
			// returns ids below the stored cursor, and keeping the higher one would hide
			// everything between them for ever (B1). A batch polled at the stored cursor
			// can only move it forward, so nothing else needs a guard.
			doc.cursor = batch.cursor;
			// Every accept moves the clock, even one that added nothing: Telegram's
			// update_id reset is about silence, and a batch of known ids is not silence.
			doc.acceptedAt = now();
			return added;
		}, background);
	}

	/** state is a read of the ledger, so the poll loop and a chat's worker never queue behind each other. */
	async function state(): Promise<IntakeState> {
		const stored = await harness.snapshot(Intake, background);
		if (stored === undefined) return { cursor: 0, acceptedAt: 0, queue: [], open: [] };
		// The snapshot is a live overlay: copy it out before it leaves this read.
		const ledger = plainJson(stored) as IntakeLedger;
		return { cursor: ledger.cursor, acceptedAt: ledger.acceptedAt, queue: ledger.queue, open: ledger.open };
	}

	/**
	 * take removes an item and answers whether this call was the one (T4.2a). A
	 * command, a callback, a refusal and the fixed non-text lines are at-most-once:
	 * a crash after the take loses the item instead of repeating it.
	 */
	async function take(id: number): Promise<boolean> {
		return await harness.commit(async (tx) => {
			const doc = await tx.doc(Intake);
			const queued = doc.queue.findIndex((item) => item.id === id);
			if (queued < 0) return false;
			doc.queue.splice(queued, 1);
			return true;
		}, background);
	}

	/**
	 * settle drops an item and queues its reply in the same commit (T4-plan §2.3):
	 * the removal is what makes exactly one delivery, so settling twice creates one
	 * task, and a crash before it leaves the item open for the restart to settle.
	 */
	async function settle(
		id: number,
		key: string,
		address: OutboxJson,
		parts: readonly OutboxJson[] | null,
	): Promise<void> {
		// The read first: an id the ledger no longer holds is nothing to do, and must
		// not even create the conversation a reply would go to.
		if (!ledgered(await harness.snapshot(Intake, background), id)) return;
		const conversation = parts === null || parts.length === 0 ? undefined : await conversationFor(key);
		await harness.commit(async (tx) => {
			const doc = await tx.doc(Intake);
			// Lost to a concurrent settle since the read: that one creates the task.
			if (!dropLedgered(doc, id)) return;
			if (conversation !== undefined && parts !== null) await createDelivery(tx, conversation.id, address, parts);
		}, background);
	}

	/**
	 * deliveryTask is the outbox's one task: it sends the parts one at a time, and
	 * the checkpoint moves only in the commit after a part went out. A crash
	 * before a send sends it after the restart; a crash during one resends that
	 * part and never an earlier one. It is conversation-owned and not background,
	 * so the conversation's idle wait covers it: a reply is out before the chat's
	 * next turn starts (T4-plan §2.4).
	 */
	function deliveryTask(): Task<DeliveryInput, DeliveryCheckpoint, DeliveryResult, object> {
		return defineTask<DeliveryInput, DeliveryCheckpoint, DeliveryResult>({
			name: OUTBOX_TASK,
			version: 1,
			initial: () => ({ phase: "send", next: 0, attempts: 0 }),
			phases: {
				send: async (task, runtime, context) => {
					const { address, parts, after } = task.input;
					const { next, attempts } = task.state.checkpoint;
					// A chat's deliveries are sent in the order they were created: this one
					// parks until the delivery before it has its outcome, which is a wait
					// without an invocation, and not a sleep that would guess a deadline.
					const previous = after === null ? undefined : await runtime.getTask(after as TaskId, context);
					if (previous !== undefined && previous.state.status !== "terminal") {
						await runtime.commit(
							() => ({
								status: "waiting",
								checkpoint: task.state.checkpoint,
								on: [after as TaskId],
								policy: "allSettled",
							}),
							context,
						);
						return;
					}
					if (next >= parts.length) {
						await runtime.commit(
							() => ({ status: "terminal", outcome: { status: "completed", result: { sent: parts.length } } }),
							context,
						);
						return;
					}
					if (outbox === undefined) {
						// Nobody in this process can send: the delivery waits for a process that
						// can, instead of faulting and losing the reply.
						log.warn("no outbox is configured; the delivery waits", { part: next, of: parts.length });
						await runtime.sleepUntil(now() + OUTBOX_UNCONFIGURED_MS, task.state.checkpoint, context);
						return;
					}
					// The checkpoint said this part is inside the list, so the list has it.
					const part = parts[next] as OutboxJson;
					let failure: { message: string; permanent: boolean; retryAfterMs?: number } | undefined;
					try {
						await outbox.send(address, part, context.abortSignal);
					} catch (err) {
						failure = sendFailure(err);
					}
					if (failure === undefined) {
						// The part is out. Only the checkpoint move is committed: the send is
						// not, and cannot be, so a crash here is at least once, not twice.
						await runtime.commit(
							() => ({ status: "running", checkpoint: { phase: "send", next: next + 1, attempts: 0 } }),
							context,
						);
						return;
					}
					const attempt = attempts + 1;
					const wait =
						failure.retryAfterMs === undefined
							? OUTBOX_BACKOFF_MS[attempt - 1]
							: failure.retryAfterMs + OUTBOX_RETRY_MARGIN_MS;
					if (failure.permanent || attempt >= OUTBOX_MAX_ATTEMPTS || wait === undefined) {
						// The part is given up on, and with it the rest of the delivery: a partly
						// sent reply that then continued would read as nonsense in the chat.
						log.warn("outbox delivery failed", {
							part: next,
							of: parts.length,
							attempts: attempt,
							permanent: failure.permanent,
							err: failure.message,
						});
						await runtime.commit(
							() => ({ status: "terminal", outcome: { status: "failed", error: { message: failure.message } } }),
							context,
						);
						return;
					}
					// The same part runs again at the same phase, once the wait is over.
					await runtime.sleepUntil(now() + wait, { phase: "send", next, attempts: attempt }, context);
				},
			},
			// T5.3's restore path aborts what the restored database must not send.
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
		});
	}

	/**
	 * scheduleTask is the adapter's one generic scheduled task (T5-plan §2.1): one
	 * looping task per name, so whatever a host wants to run on a clock — the
	 * check-in's tick, the nightly document sync — costs a spec and no new
	 * mechanism. Each wake calls the spec's `run` and sleeps until the target it
	 * answers, capped at SCHEDULE_MAX_SLEEP_MS, so a changed setting or a moved
	 * clock is seen within the quarter hour and no sleep is trusted to elapse on
	 * time (t5-spec §13.12). A wake before the target calls `run` again with the
	 * same target, and the spec decides what that means.
	 *
	 * It is conversation-owned by `sys:schedule` and `background`, so it holds no
	 * chat's idle (t5-spec §13.2). A phase never throws — a throwing phase faults
	 * the task, and a faulted schedule is one nothing would wake again — so a spec
	 * that throws is logged and retried after a minute, with the target it had.
	 */
	function scheduleTask(): Task<ScheduleInput, ScheduleCheckpoint, number, object> {
		return defineTask<ScheduleInput, ScheduleCheckpoint, number>({
			name: SCHEDULE_TASK,
			version: 1,
			initial: () => ({ phase: "run", target: null }),
			phases: {
				run: async (task, runtime, context) => {
					const name = task.input.name;
					const target = task.state.checkpoint.target;
					// A rearm that arrived while this run waited was for a run that is
					// starting now, which already reads the new setting.
					rearmed.delete(name);
					const spec = schedules.get(name);
					let next: number | undefined;
					let wait = SCHEDULE_MAX_SLEEP_MS;
					if (spec === undefined) {
						// The kind is registered everywhere, so a database a process with the
						// spec created opens here too: it parks instead of faulting, and wakes
						// once per cap in case the host wired the spec meanwhile.
						if (!warned.has(name)) {
							warned.add(name);
							log.warn("no schedule spec; the task parks", { name });
						}
					} else {
						try {
							next = await spec.run({ target, signal: context.abortSignal });
						} catch (err) {
							log.error("schedule run failed", { name, err: errorMessage(err) });
							wait = SCHEDULE_RETRY_MS;
						}
					}
					const at = now();
					const until = next === undefined ? at + wait : Math.min(next, at + SCHEDULE_MAX_SLEEP_MS);
					// The one sleep this run may cut short: rearm() on a running task. The
					// flag is consumed here, so a rearm after this commit waits for the next run.
					const sleep = rearmed.delete(name) ? at : until;
					await runtime.sleepUntil(sleep, { phase: "run", target: next ?? target }, context);
				},
			},
			// T5.3's restore path and rearm() abandon a schedule this way; both then
			// create a new task, which starts at once.
			abort: async (_task, runtime, context) => {
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
			},
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

			// Gap 2 (T4.2a): a turn this conversation already admitted under the same
			// requestId is attached to, not submitted again. pi-durable would hand back
			// the same admission by itself (submissions.js:173-180), but by then the idle
			// reset, the configure and the prompt state would already have been written.
			const requestId = submitOptions.requestId;
			if (requestId !== undefined) {
				const existing = await harness.commit((tx) => tx.submissionByRequest(conversation.id, requestId), background);
				if (existing !== undefined) return await attachTo(conversation, existing.id, submitOptions.signal);
			}

			// Gap 1 (T4.2a): this chat's earlier run and its reply must be over before the
			// prompt state is read, the conversation configured and the reset decided.
			// After a restart the serial chain is empty, so nothing else orders them; the
			// wait covers the deliveries too, because they are conversation-owned. The
			// caller's signal ends it: a Stop (or a watchdog) while the chat is busy
			// answers `aborted` without submitting anything.
			if (!(await idleWait(conversation, submitOptions.signal))) return aborted();

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
			// Read before the content is prepared and cleared in the admission commit
			// below, so a note reaches exactly one message (T5-plan §2.3).
			const notes = hooks.userContent === undefined ? [] : await pendingNotes(conversation);
			const input = await submitted(key, text, {
				fresh,
				group,
				state,
				...(notes.length === 0 ? {} : { notes }),
			});
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
					const submissionId = await commitSubmitted(conversation, draft, input.state, submitOptions.intake, notes);
					const admitted = await harness.submission(submissionId, background);
					if (admitted === undefined) return ended(new Error("the submitted turn could not be reacquired"));
					submission = admitted;
				} catch (err) {
					// The session is closing or failed: the turn ends rather than throws.
					return ended(err);
				}
				const stop = (): void => {
					abortRun(submission, conversation);
				};
				if (stopped(submitOptions.signal)) stop();
				submitOptions.signal?.addEventListener("abort", stop, { once: true });
				try {
					settled = await submission.wait(background);
				} catch (err) {
					return ended(err);
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

			const result = await resultOf(conversation, settled);
			// A turn this process submitted advances the prompt state once it settled; a
			// run that recovery finished has no caller here, which is why `attach` does
			// not (P5b: the model hears its own writes once more, and nothing twice).
			await settlePrompt(conversation, key, input.state, result);
			return result;
		});
	}

	/**
	 * idleWait is `conversation.waitForIdle` for the caller's signal: pi-durable's
	 * own waiters take `Context.abortSignal` (`dist/harness/util.js`'s `Waiters.add`
	 * rejects with the signal's reason), and `withAbortSignal` is what derives such
	 * a context from a plain `AbortSignal` (`docs/movin-v3/briefs/durable-api.md`).
	 * It answers false only when that signal fired: a close or a fault under the
	 * wait is still the caller's to see.
	 */
	async function idleWait(conversation: Conversation, signal: AbortSignal | undefined): Promise<boolean> {
		if (signal === undefined) {
			await conversation.waitForIdle(background);
			return true;
		}
		try {
			await conversation.waitForIdle(withAbortSignal(signal, background));
			return true;
		} catch (err) {
			if (stopped(signal)) return false;
			throw err;
		}
	}

	/**
	 * resultOf is what a settled submission means to a caller: what the run
	 * answered, or why it did not. `submit` and `attach` share it, so a turn a
	 * restart recovered reports exactly what a turn this process ran reports.
	 */
	async function resultOf(conversation: Conversation, settled: SettledSubmissionRecord): Promise<RunResult> {
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
				return {
					status: "answered",
					text: stripSpecialTokens(textOf(run.answer.content)),
					stop: "refusal",
					usage: run.usage,
					changes: run.changes,
					toolsUsed: run.tools,
				};
			}
			// G8: the detail goes through llmError so a failed request's text is
			// scrubbed of the key, as everything leaving src/llm is.
			return {
				status: "failed",
				reason: settled.reason,
				detail: llmError(new Error(detailText(settled.detail)), cfg?.apiKey ?? "").message,
				usage: run.usage,
				changes: run.changes,
				toolsUsed: run.tools,
			};
		}
		if (run.answer === undefined) {
			return {
				status: "failed",
				reason: "faulted",
				detail: "the run committed no answer message",
				usage: run.usage,
				changes: run.changes,
				toolsUsed: run.tools,
			};
		}
		return {
			status: "answered",
			text: stripSpecialTokens(textOf(run.answer.content)),
			stop: stopOf(run.answer),
			usage: run.usage,
			changes: run.changes,
			toolsUsed: run.tools,
		};
	}

	/** attachTo is `attach` and submit's duplicate case: wait an admitted submission out and report it. */
	async function attachTo(
		conversation: Conversation,
		id: SubmissionId,
		signal: AbortSignal | undefined,
	): Promise<RunResult> {
		const submission = await harness.submission(id, background);
		if (submission === undefined) {
			return { status: "failed", reason: "faulted", detail: "the submitted turn could not be reacquired", ...noRun };
		}
		const stop = (): void => {
			abortRun(submission, conversation);
		};
		if (stopped(signal)) stop();
		signal?.addEventListener("abort", stop, { once: true });
		let settled: SettledSubmissionRecord;
		try {
			settled = await submission.wait(background);
		} catch (err) {
			// A close or a fault while waiting: the turn is not settled, and the item
			// stays open for the restart (isUnsettled).
			return ended(err);
		} finally {
			signal?.removeEventListener("abort", stop);
		}
		return await resultOf(conversation, settled);
	}

	/**
	 * attach waits a turn submitted earlier out, as `submit` would have: after a
	 * restart for the ledger's `open` items, and by the watchdog. It runs no
	 * `settlePrompt` (P5b), and it is not serialised per key, because a turn that
	 * takes its whole 15 minutes must not hold the chat's next item up.
	 */
	async function attach(key: string, submissionId: number, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
		const conversation = await conversationFor(key);
		return await attachTo(conversation, submissionId as SubmissionId, options.signal);
	}

	/**
	 * idle resolves once the chat has nothing running — no turn, no delivery, no
	 * other conversation-owned task — so a worker can start its next item without
	 * disturbing a recovered run (T4-plan §2.2). An unknown key is idle at once.
	 */
	async function idle(key: string): Promise<void> {
		const conversation = await lookup(key);
		if (conversation === undefined) return;
		await conversation.waitForIdle(background);
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
	function ended(err: unknown): RunResult {
		const result: RunResult = {
			status: "failed",
			reason: closing ? "closed" : "faulted",
			detail: llmError(new Error(errorMessage(err)), cfg?.apiKey ?? "").message,
			...noRun,
		};
		interrupted.add(result);
		return result;
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

/** The results `ended()` built: the session closed or failed under the turn. */
const interrupted = new WeakSet<RunResult>();

/**
 * isUnsettled is whether a run stopped before it settled, so its result is not
 * the turn's outcome (T4.2a, T4-plan §2.2): only what `ended()` returns — the
 * session closing (`closed`) or failing (`faulted`) under the turn. The turn is
 * still durable, so a channel worker leaves its intake item `open` and the
 * restart's `attach` reports what really happened. A `faulted` that `resultOf`
 * builds from a settled submission (no answer committed, not an input) is an
 * outcome: the channel renders its failure line and settles, or the item would
 * stay open forever.
 */
export function isUnsettled(result: RunResult): boolean {
	return interrupted.has(result);
}

/**
 * Test helper (T4.2a): every stored commit's changes, one call per commit, so a
 * test can prove that two writes were one commit — the admission of a turn and
 * its intake move, say — which `observeDocuments` cannot show. A change is its
 * `type` and, where it has one, the document's or the entry's kind. Returns the
 * way to stop listening.
 */
export function observeCommits(
	agent: Agent,
	listener: (changes: readonly { type: string; kind: string }[]) => void,
): () => void {
	const harness = harnessOf(agent);
	const observation = harness.observeCommits({
		advance: (publication) => {
			listener(
				publication.changes.map((change) => {
					if (change.type === "document") return { type: change.type, kind: change.record.kind };
					if (change.type === "entry") return { type: change.type, kind: change.value.kind };
					return { type: change.type, kind: "" };
				}),
			);
		},
		end: () => undefined,
	});
	return observation.detach;
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

/**
 * Test helper: abort the live deliveries of a key, as T5.3's restore path will,
 * and resolve once their abort handlers have settled. Only the test needs this:
 * the host has no other way to abandon a queue it no longer wants.
 */
export async function abortDeliveries(agent: Agent, key: string): Promise<void> {
	const harness = harnessOf(agent);
	const directory = await harness.snapshot(Directory, background);
	const id = directory?.by[key];
	if (id === undefined) return;
	for (const task of (await harness.inspect(background)).tasks) {
		if (task.record.kind !== OUTBOX_TASK || task.record.conversationId !== id) continue;
		await harness.abortTask(task.record.id, background);
	}
}

/**
 * Test helper (T5.1b): what every scheduled task is doing — its name, the
 * scheduler's view of it, when it wakes, and the target its checkpoint holds —
 * so a test can prove a wake, a cap or a rearm without importing pi-durable.
 */
export async function inspectSchedules(agent: Agent): Promise<ScheduleInspection[]> {
	const inspection = await harnessOf(agent).inspect(background);
	const found: ScheduleInspection[] = [];
	for (const task of inspection.tasks) {
		if (task.record.kind !== SCHEDULE_TASK) continue;
		const state = task.record.state;
		const checkpoint = state.status === "terminal" || state.status === "completing" ? undefined : state.checkpoint;
		const item: ScheduleInspection = {
			name: (task.record.input as ScheduleInput).name,
			state: task.state.kind,
			target: (checkpoint as ScheduleCheckpoint | undefined)?.target ?? null,
		};
		if (task.state.kind === "sleeping") item.until = task.state.until;
		found.push(item);
	}
	return found;
}

/**
 * Test helper (T5.3a): every live task's kind and state, so a test can prove what
 * the restore path left behind — no delivery, one schedule per name — without
 * importing pi-durable.
 */
export async function inspectLive(agent: Agent): Promise<{ kind: string; state: string }[]> {
	const inspection = await harnessOf(agent).inspect(background);
	return inspection.tasks.map((task) => ({ kind: task.record.kind, state: task.state.kind }));
}

/**
 * Test helper: abort a key's schedule tasks, as `rearm()` and T5.3's restore path
 * do, and resolve once their abort handlers have settled. Only a test needs it:
 * the host asks for a new run through `agent.schedule.rearm()`.
 */
export async function abortSchedules(agent: Agent): Promise<void> {
	const harness = harnessOf(agent);
	for (const task of (await harness.inspect(background)).tasks) {
		if (task.record.kind !== SCHEDULE_TASK) continue;
		// Waited out, so the record really is terminal before the test reopens: a
		// task only abort-marked at the close would settle after the next open's
		// `ensureSchedules()` has already decided to keep it.
		await harness.abortTask(task.record.id, background);
		await harness.waitForTask(task.record.id, background);
	}
}

/**
 * Test helper: mark every schedule task aborted and return without waiting, then
 * close. That is the state a crash between `rearm()`'s abort commit and its
 * creating commit leaves: the guard still names a task whose only change is the
 * mark, and the abort handler has not run.
 */
export async function markSchedules(agent: Agent): Promise<void> {
	const harness = harnessOf(agent);
	for (const task of (await harness.inspect(background)).tasks) {
		if (task.record.kind !== SCHEDULE_TASK) continue;
		await harness.abortTask(task.record.id, background);
	}
}

/**
 * Test helper: run the creating commit twice with the same `was` id, which is what
 * two rearms do when nothing serialises them. The compare-and-set in that commit
 * is the only thing that stops the second from leaving a task nothing looks at.
 * It answers both ids, so a test can see they are one.
 */
export async function createScheduleTwice(agent: Agent, name: string): Promise<(number | undefined)[]> {
	const create = creates.get(agent);
	if (create === undefined) throw new Error("not an agent this module opened");
	const was = (await scheduleOwners(agent)).guard[name] as TaskId | undefined;
	return [await create(name, was), await create(name, was)];
}

/**
 * Test helper: the live schedule tasks' ids and the ids the guard document holds,
 * so a test can prove the adapter will look at the task it left running —
 * `inspectSchedules()` carries no ids.
 */
export async function scheduleOwners(agent: Agent): Promise<{ live: number[]; guard: Record<string, number> }> {
	const harness = harnessOf(agent);
	const live = (await harness.inspect(background)).tasks
		.filter((task) => task.record.kind === SCHEDULE_TASK)
		.map((task) => task.record.id);
	return { live, guard: { ...(await harness.snapshot(ScheduleGuard, background))?.by } };
}

/** harnessOf is the harness behind an agent the test helpers take. */
function harnessOf(agent: Agent): Harness {
	const harness = harnesses.get(agent);
	if (harness === undefined) throw new Error("not an agent this module opened");
	return harness;
}

/** ledgered is whether the ledger still holds an id, in its queue or its open turns. */
function ledgered(ledger: IntakeState | undefined, id: number): boolean {
	if (ledger === undefined) return false;
	return ledger.queue.some((item) => item.id === id) || ledger.open.some((turn) => turn.id === id);
}

/**
 * dropLedgered removes an id from wherever the ledger holds it and answers whether
 * it was there: the one check that makes a second settle create no second task.
 */
function dropLedgered(doc: IntakeLedger, id: number): boolean {
	const queued = doc.queue.findIndex((item) => item.id === id);
	if (queued >= 0) {
		doc.queue.splice(queued, 1);
		return true;
	}
	const open = doc.open.findIndex((turn) => turn.id === id);
	if (open >= 0) {
		doc.open.splice(open, 1);
		return true;
	}
	return false;
}

/**
 * sendFailure reads a send's throw the way the delivery task retries on it: only
 * an `OutboxError` steers, and everything else is transient.
 */
function sendFailure(err: unknown): { message: string; permanent: boolean; retryAfterMs?: number } {
	const message = errorMessage(err);
	if (!(err instanceof OutboxError)) return { message, permanent: false };
	const failure: { message: string; permanent: boolean; retryAfterMs?: number } = {
		message,
		permanent: err.permanent === true,
	};
	if (typeof err.retryAfterMs === "number") failure.retryAfterMs = err.retryAfterMs;
	return failure;
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
