// The bot: Go's `Bot.Run`, `start`, `pollRetry`, `dispatch`, `work`, `handle`,
// `converse`, `historyFor`'s replacement, `typing` and `Status`
// (internal/telegram/bot.go:25-209, :294-405, :409-494, :74-120) on the v3
// pieces: the intake ledger (T4.2a), the per-turn submit and the durable outbox
// (T4.3b), and the reply plan `format.ts` (T4.3a) assembles.
//
// What changed and why (T4-plan.md §2, decisions.md · T4 plan change):
// - the poll **accepts** a batch into `movin.intake` before anything else happens,
//   and the stored cursor moves in that one commit; Go advanced an in-memory
//   offset before handling. So a crash cannot lose an update, and no turn holds
//   polling up.
// - one worker loop per chat drains the ledger's items in order; a chat's second
//   message therefore starts only after the first turn *and its reply* are done
//   (`agent.idle`). Different chats run in parallel, as Go's per-chat goroutines
//   did.
// - Go kept the chat's turns in memory (`chatHistory`) and replayed them into
//   every request; v3's conversation is the adapter's (`tg:<chat_id>`), so this
//   file keeps no history at all.
// - a crash or a shutdown leaves the turn's item `open`; the next start attaches
//   to it, waits its own 15-minute watchdog and settles it, exactly as the live
//   worker would have.
//
// Both auth checks are Go's, down to what each records. `reject` writes the one
// log line and the bounded row (bot.go:276-292); `dispatch` skips a bot's update
// (bot.go:308-310); a migration goes through `reject` too (bot.go:302-304). The
// second check in `handleCallback` sends **only** the toast — no row and no log
// line (bot.go:536-541) — so a pressed button never keeps its spinner (trap 16).
//
// Commands and the Undo button are T4.4's, and their logic is `commands.ts`
// (Go's commands.go, docs.go's two formatters and handleCallback's undo half).
// This file owns what must be at-most-once and durable: the item is `take`n
// before a command or a callback acts, the replies go out through
// `agent.deliver`, and the two ephemeral calls (answerCallbackQuery,
// editMessageReplyMarkup) go straight to the client with their errors logged
// and ignored, as Go's `_ =` did.

import { channelReply, NO_CONNECTION_MESSAGE } from "../agent/reply.ts";
import type { Syncer } from "../docs/sync.ts";
import {
	type Agent,
	type IntakeItem,
	isUnsettled,
	type OpenTurn,
	type OutboxJson,
	type RunResult,
} from "../durable/adapter.ts";
import type { EntriesService } from "../entries/service.ts";
import { goFields, goTimeJSON, goTrimSpace } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import type { SettingsService } from "../settings/settings.ts";
import type { CheckinService } from "../tasks/checkin.ts";
import {
	addRejected,
	authorise,
	displayName,
	MIGRATION_LOG,
	MIGRATION_REASON,
	migratedChat,
	NOT_ON_LIST_TOAST,
	type Rejected,
	rejectionOf,
} from "./auth.ts";
import {
	type BotCommand,
	type Chat,
	type Client,
	type InlineKeyboardMarkup,
	isConflict,
	isGroupChat,
	type Message,
	type SendMessage,
	TelegramApiError,
	type Update,
	type User,
} from "./client.ts";
import { planCallback, runCommand } from "./commands.ts";
import {
	FAILURE_PREFIX,
	NON_TEXT_REPLY,
	type ReplyAddress,
	replyMessages,
	THINK_HINT,
	TIMED_OUT_DETAIL,
	textMessages,
} from "./format.ts";
import { replyPart } from "./outbox.ts";

/** Go's PollSeconds (bot.go:123-125): how long getUpdates may be held open. */
export const POLL_SECONDS = 50;

/** Go's ConflictWait (bot.go:126-128): another poller answered 409. */
export const CONFLICT_WAIT_MS = 15_000;

/** Go's turnTimeout (bot.go:85-94): one message's work, which shutdown does not cancel. */
export const TURN_TIMEOUT_MS = 15 * 60_000;

/** Go's typing refresh (bot.go:479-494): Telegram drops the indicator after ~5 s. */
const TYPING_MS = 4_000;

/**
 * Telegram picks a random update_id again after a week without updates, so a
 * stored cursor could hide every new one. Six days is the margin the plan asks
 * for (T4.2b, spec §2.1).
 */
export const UPDATE_ID_RESET_MS = 6 * 24 * 60 * 60_000;

/**
 * Go's start(): getMe retries with a doubling backoff to a minute (bot.go:183-209).
 * A chat whose worker stopped rebuilds its items on the same curve (M-R1).
 */
const START_BACKOFF_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

/** Go's menu, in Go's order (commands.go:15-22); /start is not in it, and /think is. */
export const BOT_COMMANDS: readonly BotCommand[] = [
	{ command: "think", description: "Think it through first (slower), e.g. /think compare the quotes" },
	{ command: "recent", description: "Show the last 10 changes" },
	{ command: "undo", description: "Undo my last change" },
	{ command: "sync", description: "Re-read the documents now" },
	{ command: "checkin", description: "Today's and yesterday's tasks, now" },
	{ command: "help", description: "What I can do" },
];

/**
 * One accepted update as the ledger keeps it (T4.2b): everything the worker
 * needs after a restart. The kind is decided at poll time, before the commit, so
 * nothing that must not happen twice happens after it.
 */
export interface IntakePayload {
	/** `command` is text starting with `/` that is this bot's; `nontext` is an empty text with an attachment. */
	kind: "message" | "command" | "callback" | "nontext";
	/** Go's `strings.TrimSpace(m.Text)`: empty for a callback or a non-text message. */
	text: string;
	/** Go's `Message.From`, or the callback's `From`; absent when the update carried none. */
	from?: User;
	/** Go's `Message.Chat`: the type decides private vs group, the id is the key's. */
	chat: Chat;
	/** A button press: its id for the answer, its data, and the keyboard the message carried (T4.4's undo flow). */
	callback?: { id: string; data: string; markup?: InlineKeyboardMarkup | null };
}

/**
 * Go's Status (bot.go:74-83) as the state it is built from. The poll loop, the
 * workers and the outbox all write it, and `statusJSON` is the one place it
 * becomes JSON — so a failed send and a failed poll report the same way.
 */
export interface BotState {
	/** Go's `API != nil && API.token != ""`: a bot is only built with a token. */
	readonly tokenSet: boolean;
	running: boolean;
	botUsername: string;
	lastPollAt: Date | null;
	lastUpdateAt: Date | null;
	/** Go's lastError is never cleared (trap 18): an old 409 lingers. */
	lastError: string;
	lastErrorAt: Date | null;
	/** Newest first, at most MAX_REJECTED; always an array in the JSON. */
	rejected: Rejected[];
}

export function createBotState(tokenSet: boolean): BotState {
	return {
		tokenSet,
		running: false,
		botUsername: "",
		lastPollAt: null,
		lastUpdateAt: null,
		lastError: "",
		lastErrorAt: null,
		rejected: [],
	};
}

/** statusJSON is Go's Status in its field order, with Go's omitempty/omitzero rules (bot.go:74-83). */
export function statusJSON(state: BotState): Record<string, unknown> {
	// A plain object, written in this order: goMarshal keeps insertion order, which
	// is how a Go struct's field order is spelled (gojson.ts).
	const out: Record<string, unknown> = { tokenSet: state.tokenSet, running: state.running };
	if (state.botUsername !== "") out.botUsername = state.botUsername;
	if (state.lastPollAt !== null) out.lastPollAt = goTimeJSON(state.lastPollAt);
	if (state.lastUpdateAt !== null) out.lastUpdateAt = goTimeJSON(state.lastUpdateAt);
	if (state.lastError !== "") out.lastError = state.lastError;
	if (state.lastErrorAt !== null) out.lastErrorAt = goTimeJSON(state.lastErrorAt);
	out.rejected = state.rejected.map(rejectedJSON);
	return out;
}

/** One rejected row, Go's field order and omitempty (bot.go:62-72). */
export function rejectedJSON(row: Rejected): Record<string, unknown> {
	const out: Record<string, unknown> = { chatId: row.chatId, chatType: row.chatType };
	if (row.chatTitle !== undefined && row.chatTitle !== "") out.chatTitle = row.chatTitle;
	out.fromId = row.fromId;
	if (row.fromName !== undefined && row.fromName !== "") out.fromName = row.fromName;
	out.reason = row.reason;
	out.at = goTimeJSON(row.at);
	return out;
}

/**
 * checkinView is Go's CheckinView for a bot with no check-in state: `&CheckinView{}`
 * (checkin.go:450-453), which is `{"on":false}` — `until` is only set once there
 * is state (:456). The server appends the editable `setting` after these fields
 * (admin.ts). A bot with a check-in asks it for this view instead (T5.1c).
 *
 * telegram-spec.md §9.1 says `{"until":"20:00"}`; that is the shape *with* state,
 * and the main session ruled the source wins (decisions.md · T4.2b).
 */
export function checkinView(): Record<string, unknown> {
	return { on: false };
}

/** The watchdog: the turn's own 15 minutes, and whether it is what stopped the turn. */
interface Watchdog {
	signal: AbortSignal;
	fired: boolean;
	clear: () => void;
}

export interface BotOptions {
	client: Client;
	/** Who may talk to it, and the connection each turn resolves (Go's Settings). */
	settings: SettingsService;
	/** The durable agent: the intake ledger, the turns and the deliveries. */
	agent: Agent;
	/** Go's `Entries`: `/recent` and `/undo` read and undo through it. */
	entries: EntriesService;
	/** Go's `Docs`: null when the documents are switched off (MOVIN_DOCS=off), which `/sync` says. */
	syncer: Syncer | null;
	/** Go's `b.Checkin` (T5.1c): the tick, `/checkin`, the `ci:` buttons and the admin view. Null without one. */
	checkin?: CheckinService | null;
	/** The zone `/recent` shows its times in (Go's `Agent.Loc`). */
	timeZone: string;
	/** Go's Status, shared with the outbox so a failed send lands on the admin page. */
	state: BotState;
	log: Log;
	now?: () => Date;
	/** Go's PollSeconds. */
	pollSeconds?: number;
	/** Go's ConflictWait. */
	conflictWaitMs?: number;
	/** Go's turnTimeout; tests use a short one instead of waiting out 15 minutes. */
	turnTimeoutMs?: number;
}

export interface Bot {
	/** Polls, recovers and serves until `stop()`: Go's Run, resolving when it stopped. */
	run: () => Promise<void>;
	/** Stops polling and waits for the loop. Turns in flight stay durable (spec §2.3). */
	stop: () => Promise<void>;
	/** Go's Status, for the admin page. */
	status: () => Record<string, unknown>;
	/** Go's CheckinView, for the admin page: one `checkin.json` read and one settings read (T5.1c). */
	checkinStatus: () => Promise<Record<string, unknown> | null>;
}

/** One thing a chat's worker does, in ledger order: a recovered open turn, or a queued item. */
type Job = { kind: "item"; item: IntakeItem } | { kind: "recover"; turn: OpenTurn };

export function createBot(o: BotOptions): Bot {
	const { client, settings, agent, entries, syncer, timeZone, state, log } = o;
	const checkin: CheckinService | null = o.checkin ?? null;
	const now = o.now ?? ((): Date => new Date());
	const pollSeconds = o.pollSeconds ?? POLL_SECONDS;
	const conflictWaitMs = o.conflictWaitMs ?? CONFLICT_WAIT_MS;
	const turnTimeoutMs = o.turnTimeoutMs ?? TURN_TIMEOUT_MS;

	/** The stop button: it ends getUpdates, a backoff's sleep and the poll loop. */
	const stopping = new AbortController();
	/** The per-chat job lists and their one running loop (Go's `workers`, bot.go:320-333). */
	const jobs = new Map<string, Job[]>();
	/**
	 * Chats whose worker stopped after a throw. Their items are out of order with the
	 * one that threw, so the next `wake` — or the retry `scheduleResync` starts —
	 * rebuilds them from the ledger before anything else runs (M-R1).
	 */
	const stale = new Set<string>();
	/** The chats whose resync retry is running, so one throw starts one retry. */
	const resyncs = new Set<string>();
	/** The chats whose ledger rebuild is in flight; `wake` and the retry share it. */
	const rebuilding = new Map<string, Promise<Job[] | undefined>>();
	/** The `chat:id` of every job some worker's list holds or is running, so none is handled twice. */
	const inHand = new Set<string>();
	let loop: Promise<void> | null = null;
	/** The ledger's cursor and its last accept, as this process knows them. */
	let cursor = 0;
	let acceptedAt = 0;
	/** Go's pollRetry backoff, reset by every successful getUpdates (bot.go:163). */
	let backoff = START_BACKOFF_MS;

	return {
		run: async (): Promise<void> => {
			loop ??= poll();
			await loop;
		},
		/**
		 * Stops polling and the workers' queue: `drain` checks `stopping` before each
		 * job, so nothing new starts, and whatever is left is durable in the ledger
		 * (T4-plan §2.3). It does **not** wait for a job already in flight, because a
		 * turn may take its whole 15 minutes and a shutdown does not cancel one (Go's
		 * 15 s `Wait` covers in-memory turns; this bot keeps them in the ledger). The
		 * close that follows ends such a turn as `isUnsettled`, so its worker stops at
		 * the safe point instead of pushing the next item into a closed session.
		 */
		stop: async (): Promise<void> => {
			stopping.abort();
			if (loop !== null) await loop.catch(() => undefined);
		},
		status: () => statusJSON(state),
		checkinStatus: async () => (checkin === null ? checkinView() : await checkin.status()),
	};

	/** poll is Go's Run: recover what a crash left, start, register the menu, then poll. */
	async function poll(): Promise<void> {
		// The one await here with no handler of its own: a read that fails is logged
		// and retried, never left as an unhandled rejection (M4, main.ts's `run()`).
		while (!(await recovered())) {
			if (stopping.signal.aborted) return;
			const wait = backoff;
			backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
			if (!(await sleep(wait))) return;
		}
		if (await start()) {
			try {
				await client.setMyCommands([...BOT_COMMANDS], stopping.signal);
			} catch (err) {
				// Go only warns: a stale menu after a deploy is not worth stopping for (trap 19).
				log.warn("telegram setMyCommands failed", { err: errorMessage(err) });
			}
			await pollLoop();
		}
		state.running = false;
	}

	/**
	 * recover hands the ledger's unfinished work to the chats' workers before
	 * polling starts: the open turns first (they hold their chat's queue), then
	 * what was accepted and never submitted.
	 */
	async function recover(): Promise<void> {
		const ledger = await agent.intake.state();
		cursor = ledger.cursor;
		acceptedAt = ledger.acceptedAt;
		for (const turn of ledger.open) await wake(turn.key, { kind: "recover", turn });
		for (const item of ledger.queue) await wake(item.key, { kind: "item", item });
	}

	/** recovered is `recover` with its failure logged and answered false, so poll retries it. */
	async function recovered(): Promise<boolean> {
		try {
			await recover();
			return true;
		} catch (err) {
			setErr(err);
			log.warn("telegram recovery failed", { err: errorMessage(err), retryIn: backoff });
			return false;
		}
	}

	/** start is Go's start(): getMe until it works, giving up only on a rejected token. */
	async function start(): Promise<boolean> {
		let wait = START_BACKOFF_MS;
		for (;;) {
			try {
				const me = await client.getMe(stopping.signal);
				state.botUsername = me.username;
				state.running = true;
				log.info("telegram bot started", { username: me.username });
				return true;
			} catch (err) {
				if (stopping.signal.aborted) return false;
				setErr(err);
				if (err instanceof TelegramApiError && err.code === 401) {
					log.error("telegram bot token rejected; the bot is off", { err: errorMessage(err) });
					return false;
				}
				log.warn("telegram getMe failed, retrying", { err: errorMessage(err), in: wait });
				if (!(await sleep(wait))) return false;
				wait = Math.min(wait * 2, BACKOFF_CAP_MS);
			}
		}
	}

	/** pollLoop is Go's loop body (bot.go:149-178) with the ledger's offset in place of the local one. */
	async function pollLoop(): Promise<void> {
		// The first non-empty batch of a stale poll is accepted as `fresh`: see B2 in
		// `Intake.accept` and the reset guard's comment below.
		let fresh = false;
		while (!stopping.signal.aborted) {
			// The reset guard: a week without updates gives Telegram new random ids, so
			// poll from 0 while nothing has been accepted for six days, whatever the
			// stored cursor says. It cannot loop: a non-empty batch is accepted, which
			// ends the staleness and confirms those ids with the next cursor.
			const stale = acceptedAt === 0 || now().getTime() - acceptedAt > UPDATE_ID_RESET_MS;
			const offset = stale ? 0 : cursor;
			// Going back with a stored cursor is the reset the `recent` list cannot know
			// about: Telegram drops updates after a day, so every id it remembers is one
			// Telegram no longer has.
			if (stale && offset < cursor) fresh = true;

			let updates: Update[];
			try {
				updates = await client.getUpdates(offset, pollSeconds, stopping.signal);
			} catch (err) {
				if (stopping.signal.aborted) return;
				setErr(err);
				if (!(await sleep(pollWait(err)))) return;
				continue;
			}
			backoff = START_BACKOFF_MS;
			state.lastPollAt = now();
			if (updates.length > 0) state.lastUpdateAt = now();
			try {
				await accept(updates, fresh);
			} catch (err) {
				// The storage failed under the accept: the batch is not durable, and the
				// poll retries it after a backoff, as any failed getUpdates is retried.
				setErr(err);
				log.warn("telegram intake failed", { err: errorMessage(err), retryIn: backoff });
				if (!(await sleep(backoff))) return;
				backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
				continue;
			}
			if (updates.length > 0) {
				acceptedAt = now().getTime();
				fresh = false;
			}
		}
	}

	/** pollWait is Go's pollRetry (bot.go:211-225): the 409 pause, the 429 delay, else the backoff. */
	function pollWait(err: unknown): number {
		if (isConflict(err)) {
			log.warn("another poller is using this bot token (409); is a second replica or a local copy running?", {
				retryIn: conflictWaitMs,
			});
			return conflictWaitMs;
		}
		if (err instanceof TelegramApiError && err.retryAfter > 0) return err.retryAfter * 1_000;
		const wait = backoff;
		backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
		log.warn("telegram getUpdates failed", { err: errorMessage(err), retryIn: wait });
		return wait;
	}

	/**
	 * accept classifies one batch and puts what may be handled into the ledger in
	 * one commit (T4-plan §2.5). Per update, in Go's order: the group-upgrade row,
	 * then only a message or a callback with its message, then auth check 1, then
	 * the kind. Nothing is sent before the commit — a refused callback's toast and
	 * the workers' wake-ups both come after it.
	 */
	async function accept(updates: readonly Update[], fresh = false): Promise<void> {
		if (updates.length === 0) return;
		const allow = await settings.resolveTelegram();
		const items: IntakeItem[] = [];
		const toasts: string[] = [];
		let last = 0;
		for (const update of updates) {
			last = Math.max(last, update.update_id);
			const message = update.message;
			const callback = update.callback_query;
			if (message !== undefined && message.migrate_to_chat_id !== 0) {
				// Trap 26: the old chat is on the list and the new one is not, so this is
				// recorded before auth and nothing is sent. Go logs the upgrade and then
				// goes through reject, so the row and both lines are written (bot.go:300-304).
				log.warn(MIGRATION_LOG, { oldChatId: message.chat.id, newChatId: message.migrate_to_chat_id });
				reject(migratedChat(message), message.from, MIGRATION_REASON);
				continue;
			}
			const chat = message?.chat ?? callback?.message?.chat;
			if (chat === undefined) continue; // anything else: ignored on purpose
			const from = message?.from ?? callback?.from;
			const verdict = authorise(allow, chat, from);
			if (!verdict.ok) {
				refuse(chat, from, verdict.reason);
				if (callback !== undefined) toasts.push(callback.id);
				continue;
			}
			const kind = kindOf(message, callback !== undefined);
			if (kind === null) continue;
			items.push({
				id: update.update_id,
				key: `tg:${chat.id}`,
				address: {
					chat: chat.id,
					messageId: message?.message_id ?? callback?.message?.message_id ?? 0,
					group: isGroupChat(chat),
				},
				payload: payloadJson({
					kind,
					text: kind === "callback" ? "" : goTrimSpace(message?.text ?? ""),
					...(from === undefined ? {} : { from }),
					chat,
					...(callback === undefined
						? {}
						: {
								callback: {
									id: callback.id,
									data: callback.data,
									// What the keyboard was when it was pressed: Go reads it back off
									// the callback's message (bot.go:570). An item accepted before
									// T4.4 has no markup, and `?? null` is the same as no keyboard.
									markup: callback.message?.reply_markup ?? null,
								},
							}),
				}),
				at: now().getTime(),
			});
		}
		const added = await agent.intake.accept({ cursor: last + 1, items, fresh });
		// The batch's own last id + 1, never the larger of the two: a stale poll comes
		// back with lower ids, and holding the old cursor would hide everything between
		// them (B1). A batch polled at the stored cursor can only move it forward, so
		// the next getUpdates still confirms what was just accepted.
		cursor = last + 1;
		// After the commit, and only now: a refusal's toast, and the work itself.
		for (const id of toasts) {
			try {
				await client.answerCallbackQuery(id, NOT_ON_LIST_TOAST, stopping.signal);
			} catch (err) {
				log.warn("telegram answerCallbackQuery failed", { err: errorMessage(err) });
			}
		}
		for (const item of added) await wake(item.key, { kind: "item", item });
	}

	/**
	 * kindOf is Go's `handle` classification (bot.go:393-404): a callback, an empty
	 * text with an attachment, a command, or ordinary text. `null` means dropped
	 * silently — a whitespace-only message with nothing attached (spec §4.1) or a
	 * command addressed to another bot, which must cost nothing (trap 13).
	 */
	function kindOf(message: Message | undefined, isCallback: boolean): IntakePayload["kind"] | null {
		if (isCallback) return "callback";
		const text = goTrimSpace(message?.text ?? "");
		if (text === "") {
			if (message?.document !== undefined || (message?.photo.length ?? 0) > 0 || message?.voice !== undefined) {
				return "nontext";
			}
			return null;
		}
		if (text.startsWith("/")) return commandAllowed(text, state.botUsername) ? "command" : null;
		return "message";
	}

	/** commandAllowed is Go's `target != "" && me != "" && !EqualFold(target, me)` (commands.go:46-48). */
	function commandAllowed(text: string, me: string): boolean {
		const word = goFields(text)[0] ?? "";
		const cut = word.startsWith("/") ? word.slice(1) : word;
		const at = cut.indexOf("@");
		if (at < 0) return true;
		const target = cut.slice(at + 1);
		return target === "" || me === "" || target.toLowerCase() === me.toLowerCase();
	}

	/** commandOf splits a command Go's way: the word without `/` and `@bot`, and the rest. */
	function commandOf(text: string): { cmd: string; rest: string } {
		const word = goFields(text)[0] ?? "";
		const cut = word.startsWith("/") ? word.slice(1) : word;
		const at = cut.indexOf("@");
		return {
			cmd: at < 0 ? cut : cut.slice(0, at),
			rest: goTrimSpace(text.slice(word.length)),
		};
	}

	/**
	 * reject is Go's `reject` (bot.go:276-292): the one log line, then the bounded
	 * row. Go calls it for a person, for an update that carries no `from` at all
	 * (the row keeps `fromId 0`) and for the group-upgrade row.
	 */
	function reject(chat: Chat, from: User | undefined, reason: string): void {
		log.warn("telegram message ignored", {
			reason,
			chatId: chat.id,
			chatType: chat.type,
			chatTitle: chat.title,
			fromId: from?.id ?? 0,
			from: displayName(from),
		});
		state.rejected = addRejected(state.rejected, rejectionOf(chat, from, reason, now()));
	}

	/**
	 * refuse is dispatch's condition around reject (bot.go:308-310): a bot's update
	 * is refused with no row and no log line, and anything else — a person, or an
	 * update with no `from` — is recorded.
	 */
	function refuse(chat: Chat, from: User | undefined, reason: string): void {
		if (from?.is_bot === true) return;
		reject(chat, from, reason);
	}

	/** setErr is Go's setErr (bot.go:115-120): the text and when, never cleared. */
	function setErr(err: unknown): void {
		state.lastError = errorMessage(err);
		state.lastErrorAt = now();
	}

	/**
	 * wake hands one job to its chat's worker, starting the loop when this is the first.
	 * A chat whose worker stopped after a throw is rebuilt from the ledger first, and
	 * the item this wake carries is already in it — the accept committed before the
	 * wake — so it is not pushed twice (M-R1).
	 */
	async function wake(key: string, job: Job): Promise<void> {
		if (stale.has(key) || rebuilding.has(key)) {
			const rebuilt = await rebuild(key);
			// A failed rebuild starts no worker: the item is already in the ledger (the
			// accept committed before this wake), and the retry picks it up behind the
			// stranded ones, so nothing overtakes anything (R3-1).
			if (rebuilt === undefined) {
				scheduleResync(key);
				return;
			}
		}
		// One job per item while it is in hand: a rebuild already holds every item the
		// ledger had when it read it, including this one and any later one of the same
		// batch (R4-1). Only an item the rebuild could not see is added, last.
		const id = handKey(key, job);
		if (inHand.has(id)) return;
		inHand.add(id);
		const list = jobs.get(key);
		if (list === undefined) {
			jobs.set(key, [job]);
			void drain(key);
			return;
		}
		list.push(job);
	}

	/**
	 * rebuild restarts a stale chat's worker from the ledger. One rebuild per chat at a
	 * time: `wake` and the retry timer share the in-flight promise, so one worker runs
	 * (R3-2). It answers the rebuilt list, or undefined when the ledger read failed.
	 *
	 * Invariant: no worker is live for a stale key. `stale` is set only in `drain`'s
	 * catch, with no await before that worker breaks and drops its list, so the
	 * `jobs.set` here never replaces a live worker's list. Setting `stale` anywhere
	 * else must keep that true.
	 */
	function rebuild(key: string): Promise<Job[] | undefined> {
		const inFlight = rebuilding.get(key);
		if (inFlight !== undefined) return inFlight;
		const run = (async (): Promise<Job[] | undefined> => {
			try {
				const rebuilt = await ledgerJobs(key);
				stale.delete(key);
				// An empty list is the whole answer: the throw left nothing unfinished.
				if (rebuilt.length > 0) {
					for (const j of rebuilt) inHand.add(handKey(key, j));
					jobs.set(key, rebuilt);
					void drain(key);
				}
				return rebuilt;
			} catch (err) {
				log.warn("telegram ledger rebuild failed", { key, err: errorMessage(err) });
				return undefined;
			} finally {
				rebuilding.delete(key);
			}
		})();
		rebuilding.set(key, run);
		return run;
	}

	/**
	 * ledgerJobs is one chat's unfinished work as its worker runs it: the open turns
	 * first (they hold the chat), then the queue in ledger order. The startup recovery
	 * applies the same order to every chat; this is the one chat that is out of order.
	 */
	async function ledgerJobs(key: string): Promise<Job[]> {
		const ledger = await agent.intake.state();
		return [
			...ledger.open.filter((turn) => turn.key === key).map((turn): Job => ({ kind: "recover", turn })),
			...ledger.queue.filter((item) => item.key === key).map((item): Job => ({ kind: "item", item })),
		];
	}

	/**
	 * scheduleResync starts the retry for a chat whose worker stopped after a throw, so
	 * a chat nobody writes to again still gets its stranded items answered without a
	 * restart. One retry per chat; it ends at the first rebuild, and `sleep` cancels it
	 * on `stop()` with everything else the poll loop waits on.
	 */
	function scheduleResync(key: string): void {
		if (resyncs.has(key)) return;
		resyncs.add(key);
		void resyncAfter(key);
	}

	/** resyncAfter is the retry: wait, look again, rebuild — 1 s doubling to a minute. */
	async function resyncAfter(key: string): Promise<void> {
		let wait = START_BACKOFF_MS;
		for (;;) {
			if (!(await sleep(wait))) {
				resyncs.delete(key);
				return;
			}
			if (!stale.has(key)) {
				resyncs.delete(key);
				return;
			}
			if ((await rebuild(key)) !== undefined) {
				resyncs.delete(key);
				return;
			}
			wait = Math.min(wait * 2, BACKOFF_CAP_MS);
		}
	}

	/**
	 * drain is Go's `work` (bot.go:339-363): one chat's jobs, one at a time, in
	 * ledger order. The loop is dropped the moment the list is empty, in the same
	 * turn, so a job that arrives then starts a new one.
	 */
	async function drain(key: string): Promise<void> {
		const list = jobs.get(key);
		if (list === undefined) return;
		for (;;) {
			// Nothing new starts after stop(): what is still in the list is durable, and
			// the next start's recovery answers it (spec §2.3).
			if (stopping.signal.aborted) break;
			const job = list.shift();
			if (job === undefined) break;
			try {
				// Go's `recover()` around handle (bot.go:377-381): a failed command must not
				// take the chat's queue down with it.
				const carryOn = await handle(key, job).finally(() => inHand.delete(handKey(key, job)));
				if (!carryOn) break;
			} catch (err) {
				// A close under an in-flight job is not a panic: the item is still in the
				// ledger, and the next start reports its real outcome.
				if (stopping.signal.aborted) break;
				log.error("telegram handler panicked", { panic: errorMessage(err) });
				// A command or a callback was taken before it acted, so nothing is left to
				// redo and the chat may carry on. A turn that threw is not settled: stop this
				// chat's worker, and rebuild its items from the ledger before its next job
				// runs, so a new item cannot overtake the stranded one (M-R1).
				if (!taken(job)) {
					stale.add(key);
					scheduleResync(key);
					break;
				}
			}
		}
		// What the list still holds is dropped with it and stays in the ledger; a rebuild
		// or the next start brings it back.
		for (const left of list) inHand.delete(handKey(key, left));
		jobs.delete(key);
	}

	/**
	 * handKey names a job in `inHand`: the chat and the ledger id it carries (an
	 * item's, or the open turn's). Ids repeat across chats after an update-id reset.
	 */
	function handKey(key: string, job: Job): string {
		return `${key}:${job.kind === "item" ? job.item.id : job.turn.id}`;
	}

	/** taken is whether the job's item was taken before acting, so a throw leaves nothing to redo. */
	function taken(job: Job): boolean {
		if (job.kind === "recover") return false;
		const kind = payloadOf(job.item).kind;
		return kind === "command" || kind === "callback";
	}

	/** handle runs one job; `false` means stop this worker, because the turn is not settled. */
	async function handle(key: string, job: Job): Promise<boolean> {
		if (job.kind === "recover") return await recoverTurn(key, job.turn);
		return await handleItem(key, job.item);
	}

	/**
	 * recoverTurn finishes a turn a crash left open: `attach` waits it out (the
	 * adapter resumes the run on open), then the same render and settle the live
	 * worker does. Its watchdog is the deadline the submit stored, so a turn that
	 * used up its 15 minutes before the crash fails here instead of waiting again.
	 */
	async function recoverTurn(key: string, turn: OpenTurn): Promise<boolean> {
		const address = addressOf(turn);
		const payload = payloadOf(turn);
		const model = (await settings.resolve()).model;
		const typing = startTyping(payload.chat.id);
		const watchdog = startWatchdog(turn.deadlineAt);
		let result: RunResult;
		try {
			result = await agent.attach(key, turn.submission, { signal: watchdog.signal });
		} finally {
			typing();
			watchdog.clear();
		}
		if (isUnsettled(result)) return false;
		const parts = replyMessages(channelReply(result, model, address.group), address, {
			timedOut: watchdog.fired,
		});
		await agent.intake.settle(turn.id, key, turn.address, partsOf(parts));
		return true;
	}

	/** handleItem is Go's `handle` over a queued item, with the second auth check first (trap 11). */
	async function handleItem(key: string, item: IntakeItem): Promise<boolean> {
		const payload = payloadOf(item);
		await agent.idle(key);
		const verdict = authorise(await settings.resolveTelegram(), payload.chat, payload.from);
		if (!verdict.ok) {
			// Queued before the allowlist changed: Go's second check. A callback is only
			// answered, so its button stops spinning (bot.go:536-541) and nothing is
			// recorded; a message or a command gets Go's row and log line (bot.go:391-394).
			// Both are at-most-once, so the item is taken first.
			if (!(await agent.intake.take(item.id))) return true;
			if (payload.kind === "callback") await answerCallback(payload.callback, NOT_ON_LIST_TOAST);
			else refuse(payload.chat, payload.from, verdict.reason);
			return true;
		}
		switch (payload.kind) {
			case "nontext":
				await settleText(key, item, NON_TEXT_REPLY);
				return true;
			case "callback":
				return await callback(key, item, verdict.name);
			case "command": {
				const { cmd, rest } = commandOf(payload.text);
				if (cmd.toLowerCase() === "think") {
					// Go cuts the command word at `@` and uses the rest (commands.go:41-58), so
					// `/think@botname …` is `/think …` and a bare `/think@botname` is the hint.
					// `/think <text>` is a message that thinks; `/think` alone calls no model.
					if (rest === "") {
						await settleText(key, item, THINK_HINT);
						return true;
					}
					return await message(key, item, verdict.name, { text: rest, think: true });
				}
				return await command(key, item, verdict.name);
			}
			case "message":
				// `kindOf` sends every `/…` text to the command branch above, so a message
				// here never carries `/think`: Go's converse gets the text and no thinking
				// (bot.go:404-405).
				return await message(key, item, verdict.name, { text: payload.text, think: false });
		}
	}

	/**
	 * command is Go's `/command` branch (bot.go:400-402): the item is taken first,
	 * so a redelivery or a crash can never run a command twice — `/undo` twice
	 * undoes two different changes, never the same one (trap 14). Every answer is
	 * one `commands.ts` decides, sent through the durable delivery.
	 */
	async function command(key: string, item: IntakeItem, name: string): Promise<boolean> {
		const address = addressOf(item);
		const { cmd } = commandOf(payloadOf(item).text);
		// A command another worker already took is not run again.
		if (!(await agent.intake.take(item.id))) return true;
		await runCommand(
			{
				entries,
				syncer,
				timeZone,
				log,
				checkin,
				send: async (text: string, keyboard: InlineKeyboardMarkup | null = null): Promise<void> => {
					await agent.deliver(key, item.address, textMessages(text, address, keyboard).map(replyPart));
				},
			},
			cmd,
			name,
			address.chat,
		);
		return true;
	}

	/** answerCallback is Go's `_ = b.API.AnswerCallbackQuery` (bot.go:552-566): an error is logged, never raised. */
	async function answerCallback(callback: IntakePayload["callback"], text: string): Promise<void> {
		if (callback === undefined) return;
		try {
			await client.answerCallbackQuery(callback.id, text, stopping.signal);
		} catch (err) {
			log.warn("telegram answerCallbackQuery failed", { err: errorMessage(err) });
		}
	}

	/**
	 * callback is Go's `handleCallback` (bot.go:536-592) on the ledger: the item is
	 * taken first, the toast and the keyboard edit go to the client directly (both
	 * ephemeral, both ignored on failure), and the confirmation — the Undo one, or
	 * the check-in's `✓ …` (T5.1c) — is delivered durably, threaded under the bot's
	 * message in a group.
	 */
	async function callback(key: string, item: IntakeItem, name: string): Promise<boolean> {
		const address = addressOf(item);
		const payload = payloadOf(item);
		const press = payload.callback;
		// Take first: a redelivered callback undoes once (plan.md:78, trap 14), and a
		// callback another worker already took is not acted on at all.
		if (!(await agent.intake.take(item.id))) return true;
		if (press === undefined) return true;
		const plan = await planCallback(
			{ entries, log, timeZone, now },
			{
				name,
				data: press.data,
				markup: press.markup ?? null,
				group: address.group,
			},
		);
		await answerCallback(press, plan.toast);
		if (plan.edit !== undefined) {
			try {
				await client.editMessageReplyMarkup(address.chat, address.messageId, plan.edit, stopping.signal);
			} catch (err) {
				log.warn("telegram editMessageReplyMarkup failed", { err: errorMessage(err) });
			}
		}
		if (plan.confirmation !== undefined) {
			const parts = textMessages(plan.confirmation.text, address, plan.confirmation.keyboard).map(replyPart);
			await agent.deliver(key, item.address, parts);
		}
		return true;
	}

	/**
	 * message is Go's `converse` (bot.go:409-457) on the adapter: the request id
	 * makes it once-only, the intake move is in the same commit, the actor is who
	 * wrote it, and the typing indicator covers the whole turn. `ask` is what the
	 * model is asked and whether it thinks first: the command branch passes
	 * `commandOf`'s rest for `/think`, a plain message passes its own text and no
	 * thinking (`kindOf` sends every `/…` text to the command branch).
	 *
	 * The request id is `tg:<chat_id>:<message_id>`: a `message_id` is unique in a
	 * chat for ever, while an `update_id` is re-randomised after a quiet week (B2),
	 * so a reused update id can never attach a new message to an old reply.
	 */
	async function message(
		key: string,
		item: IntakeItem,
		name: string,
		ask: { text: string; think: boolean },
	): Promise<boolean> {
		const address = addressOf(item);
		const payload = payloadOf(item);
		const typed = payload.text;
		const { text, think } = ask;
		const connection = await settings.resolve();
		const model = connection.model;
		if (connection.baseUrl === "" || model === "") {
			// Go's prepare refuses such a connection before any request (agent.go:152-154),
			// and converse prints that error through the failure line, with no changes
			// saved and no keyboard (bot.go:440-447).
			turnFailed(name, payload.chat.id, NO_CONNECTION_MESSAGE);
			await settleText(key, item, FAILURE_PREFIX + NO_CONNECTION_MESSAGE);
			return true;
		}
		const deadlineAt = now().getTime() + turnTimeoutMs;
		// Go's group rule: the model sees who said it (spec §4.3).
		const content = address.group ? `${name}: ${text}` : text;
		const typing = startTyping(payload.chat.id);
		const watchdog = startWatchdog(deadlineAt);
		let result: RunResult;
		try {
			result = await agent.submit(key, content, {
				requestId: `tg:${address.chat}:${address.messageId}`,
				intake: { id: item.id, deadlineAt },
				actor: { by: name, channel: "telegram" },
				group: address.group,
				think,
				// The transcript keeps what was typed, `/think` and all (P4).
				display: typed,
				signal: watchdog.signal,
			});
		} finally {
			typing();
			watchdog.clear();
		}
		// A session that closed or failed under the turn has not settled it: the item
		// stays open and the next start's recovery answers it.
		if (isUnsettled(result)) return false;
		const reply = channelReply(result, model, address.group);
		// Go logs the turn's error and prints it through the failure line (bot.go:440-447);
		// the watchdog's own abort is the one detail whose text is not the run's. A
		// `turn_limit` run is an answer in reply.ts, so it logs nothing (T4 fixes m2).
		if (!reply.outcome.ok) {
			turnFailed(name, payload.chat.id, watchdog.fired ? TIMED_OUT_DETAIL : reply.outcome.error);
		}
		const parts = replyMessages(reply, address, { timedOut: watchdog.fired });
		await agent.intake.settle(item.id, key, item.address, partsOf(parts));
		return true;
	}

	/** turnFailed is Go's `telegram agent turn failed` line (bot.go:440), with Go's fields and order. */
	function turnFailed(by: string, chatId: number, err: string): void {
		log.warn("telegram agent turn failed", { by, chatId, err });
	}

	/** settleText drops an item and queues the one fixed line it gets, in one commit. */
	async function settleText(key: string, item: IntakeItem, text: string): Promise<void> {
		const parts = textMessages(text, addressOf(item)).map(replyPart);
		await agent.intake.settle(item.id, key, item.address, parts);
	}

	/**
	 * startTyping is Go's typing (bot.go:479-494): "typing" at once, then every
	 * four seconds, every error ignored; the returned function stops it.
	 */
	function startTyping(chatId: number): () => void {
		const done = new AbortController();
		const beat = async (): Promise<void> => {
			try {
				await client.sendChatAction(chatId, done.signal);
			} catch {
				// Go ignores a failed chat action: it is decoration.
			}
		};
		void beat();
		const timer = setInterval(() => void beat(), TYPING_MS);
		// Neither timer may outlive the process's other work: a shutdown does not wait
		// for a turn (spec §2.3), and the event loop must not wait for it either.
		timer.unref();
		return () => {
			clearInterval(timer);
			done.abort();
		};
	}

	/**
	 * startWatchdog is Go's `context.WithTimeout(..., turnTimeout)` (bot.go:341-344):
	 * at the stored deadline the submission is withdrawn or the conversation
	 * aborted, and the reply says the watchdog stopped it (format.ts).
	 */
	function startWatchdog(deadlineAt: number): Watchdog {
		const controller = new AbortController();
		const watchdog: Watchdog = {
			signal: controller.signal,
			fired: false,
			clear: () => clearTimeout(timer),
		};
		const timer = setTimeout(
			() => {
				watchdog.fired = true;
				controller.abort(new Error("the turn took longer than 15 minutes and was stopped"));
			},
			Math.max(0, deadlineAt - now().getTime()),
		);
		timer.unref();
		return watchdog;
	}

	/** sleep waits outside the poll loop = true, or answers false when the bot is stopping. */
	function sleep(ms: number): Promise<boolean> {
		return new Promise((done) => {
			if (stopping.signal.aborted) {
				done(false);
				return;
			}
			const timer = setTimeout(() => {
				stopping.signal.removeEventListener("abort", onStop);
				done(true);
			}, ms);
			const onStop = (): void => {
				clearTimeout(timer);
				done(false);
			};
			stopping.signal.addEventListener("abort", onStop, { once: true });
		});
	}
}

/** The ledger's address, which this channel wrote: Go's chat, message and `IsGroup`. */
function addressOf(item: IntakeItem): ReplyAddress {
	return item.address as unknown as ReplyAddress;
}

/** The ledger's payload, which this channel wrote. */
function payloadOf(item: IntakeItem): IntakePayload {
	return item.payload as unknown as IntakePayload;
}

/** payloadJson is the other direction: the payload as the ledger's opaque JSON. */
function payloadJson(payload: IntakePayload): OutboxJson {
	return payload as unknown as OutboxJson;
}

/** The ledger's parts for a reply plan: `null` stays silence, and each message is one part. */
function partsOf(messages: readonly SendMessage[] | null): OutboxJson[] | null {
	return messages === null ? null : messages.map(replyPart);
}
