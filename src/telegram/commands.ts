// The bot's commands and its one callback: Go's `command`, `recent` and
// `undoLast` (internal/telegram/commands.go), `syncCommand`, `counts` and
// `docList` (docs.go:40-119) and `handleCallback`'s undo half
// (bot.go:536-592). Every text is Go's, byte for byte; the delivery (durable,
// ordered, T4.3b) and the two ephemeral calls stay in `bot.ts`, which is what
// calls the functions here.
//
// Why the command logic is not in bot.ts: Go's `Bot` is a bag of methods, and
// the parts that read entries, read the index and build a string do not need
// the poll loop, the ledger or the outbox. `CommandDeps` is the same set of
// services Go's Bot holds (`Entries`, `Docs`, `Agent.Loc`, `Log`), and `send`
// is Go's `reply` after the ledger has taken the item.
//
// Deliberate differences from Go, both decided in T4.4:
// - `/recent` skips a journal record it cannot describe (Go's ChangeText
//   panics on the old `op:"meta"` record and the whole reply is lost, spec
//   §6.3). The bot's panic guard still covers every other case.
// - `/checkin` answers "The check-in isn't available yet." in a rig with no
//   check-in wired; production always has one, because both the bot and the
//   check-in need a token (main.go:124-138).

import {
	CLASS_SCANNED,
	type Doc,
	docName,
	type Index,
	STATUS_FAILED,
	STATUS_OK,
	STATUS_REMOVED,
	type Sync,
	changes as syncChanged,
} from "../docs/index.ts";
import type { Syncer } from "../docs/sync.ts";
import { ChangeText } from "../entries/changetext.ts";
import { ChangeNotFoundError, EntryNotFoundError, UndoStaleError } from "../entries/errors.ts";
import { type Change, type Entry, type Patch, STATUS_DONE } from "../entries/model.ts";
import type { EntriesService, Result } from "../entries/service.ts";
import { errorMessage, type Log } from "../log.ts";
import { validDate } from "../sched.ts";
import type { CheckinSender } from "../tasks/checkin.ts";
import {
	ALREADY_DONE_TOAST,
	ARCHIVED_TOAST,
	CHECKIN_PREFIX,
	movedToast,
	parseCheckinCallback,
	StaleAskError,
} from "./checkin.ts";
import type { InlineKeyboardMarkup } from "./client.ts";
import { truncate, undoKeyboard } from "./format.ts";

/** Go's helpText (commands.go:24-40): `/start` and `/help` answer with it verbatim. */
export const HELP_TEXT = `Tell me what's happening with the renovation and I'll keep the record: ideas, decisions, quotes, payments, dates, open questions. Ask me anything about it too.

Examples:
• Thinking of fluted glass for the dry kitchen sliding door
• Lim quoted 18k for carpentry, paid 30% today
• Electrician coming Friday 2pm to check the DB
• What did we decide for the kitchen and what did it cost?

Every change comes back with an Undo button.
/think   start a message with it when I should think it through first (slower), e.g. /think compare the two zip blind quotes
/recent  the last 10 changes
/undo    undo your last change
/sync    re-read the documents now (they also sync every night)
/checkin today's tasks and yesterday's open ones, with Done buttons (also sent every morning)
/help    this message`;

/** `/checkin`'s answer when no check-in is wired, which production never is. */
export const CHECKIN_UNAVAILABLE = "The check-in isn't available yet.";

/** How many changes `/recent` lists (commands.go:75). */
const RECENT_COUNT = 10;

/** Go's `undo:` callback data (bot.go:524); the check-in's `ci:` is routed before it (T5.1c). */
export const UNDO_PREFIX = "undo:";

/**
 * Go's syncReasonPrefix (docs.go:14): `<prefix><chat id>` says a chat asked for
 * the sync, so T5.2's group notice skips that chat and the reply is all it gets.
 */
export const SYNC_REASON_PREFIX = "telegram:";

/** Go's unknown-command line (commands.go:69-70), the command word in its own case. */
export function unknownCommand(cmd: string): string {
	return `I don't know /${cmd}. Send /help to see what I can do.`;
}

/**
 * counts is Go's `counts` (docs.go:81-95): the non-zero counts in added,
 * changed, removed, failed order, or `nothing changed`. The two sentences that
 * use it punctuate it differently on purpose (spec §11 trap 24).
 */
export function counts(r: Sync): string {
	const parts: string[] = [];
	for (const part of [
		{ n: r.added, what: "added" },
		{ n: r.changed, what: "changed" },
		{ n: r.removed, what: "removed" },
		{ n: r.failed, what: "failed" },
	]) {
		if (part.n > 0) parts.push(`${part.n} ${part.what}`);
	}
	return parts.length === 0 ? "nothing changed" : parts.join(", ");
}

/**
 * docList is Go's `docList` (docs.go:97-119): one `• name state` line per
 * document, at most max of them, then `…and n more`.
 */
export function docList(docs: readonly Doc[], max: number): string {
	const lines: string[] = [];
	for (const [i, d] of docs.entries()) {
		if (i === max) {
			lines.push(`…and ${docs.length - max} more`);
			break;
		}
		lines.push(`• ${docName(d)}${docState(d)}`);
	}
	return lines.join("\n");
}

/** docState is the suffix docList puts after a name, in Go's order (docs.go:104-118). */
function docState(d: Doc): string {
	let state = "";
	if (d.status === STATUS_REMOVED) state = " (removed)";
	else if (d.status === STATUS_FAILED) state = " (couldn't be read)";
	else if (d.error !== "") state = " (the new version couldn't be read; the previous one is still used)";
	// A scanned document's own line wins over the empty error case, as Go's
	// second `if` does.
	if (d.class === CLASS_SCANNED && d.status === STATUS_OK && d.error === "") {
		state = " (pictures only: not searchable yet)";
	}
	return state;
}

/** Go's time.RFC3339 as time.Parse reads it: seconds required, fraction and offset optional. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * recentAt is the timestamp `/recent` shows: Go parses `c.At` with
 * time.RFC3339 and formats it `Mon 2 Jan 15:04` in the app's zone
 * (commands.go:86-89); an `at` that does not parse is shown as it is.
 */
export function recentAt(at: string, timeZone: string): string {
	const millis = parseRFC3339(at);
	if (millis === null) return at;
	const parts = formatterFor(timeZone).formatToParts(new Date(millis));
	const field = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
	return `${field("weekday")} ${field("day")} ${field("month")} ${field("hour")}:${field("minute")}`;
}

// One formatter per zone: an invalid zone throws here, as Intl always does, and
// only a misconfigured TZ can get this far.
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	const known = zoneFormatters.get(timeZone);
	if (known !== undefined) return known;
	const made = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		day: "numeric", // Go's "2" is unpadded
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23", // not h24, which prints midnight as 24
	});
	zoneFormatters.set(timeZone, made);
	return made;
}

/** parseRFC3339 is Go's time.Parse(time.RFC3339, s) as a millisecond instant, or null when Go would fail. */
function parseRFC3339(s: string): number | null {
	const m = RFC3339.exec(s);
	if (m === null) return null;
	const year = Number(m[1]);
	const month = Number(m[2]);
	const day = Number(m[3]);
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	const zone = m[7] ?? "";
	// Go refuses a day the month does not have, and a time out of range; Date
	// would roll 31 February over into March.
	if (!validDate(s.slice(0, 10))) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	const utc = new Date(0);
	utc.setUTCFullYear(year, month - 1, day);
	utc.setUTCHours(hour, minute, second, 0);
	if (zone === "Z") return utc.getTime();
	const offsetMs = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
	return utc.getTime() - (zone.startsWith("-") ? -offsetMs : offsetMs);
}

/**
 * recentLine is one line of `/recent` (commands.go:90-96): `• <change> — <who>
 * (web)?, <when>`, or null for a record Go's ChangeText cannot describe — the
 * old `op:"meta"` one (spec §6.3), which is skipped instead of losing the whole
 * reply as Go's panic did.
 */
export function recentLine(change: Change, timeZone: string): string | null {
	if (!renderable(change.op)) return null;
	const via = change.channel === "web" ? " (web)" : "";
	return `• ${ChangeText(change)} — ${change.by}${via}, ${recentAt(change.at, timeZone)}`;
}

/** renderable is ChangeText's op switch (tools.go:355-372); Go has no branch for anything else. */
function renderable(op: string): boolean {
	switch (op) {
		case "create":
		case "update":
		case "delete":
		case "undo":
			return true;
		default:
			return false;
	}
}

/** recentText is `/recent`'s whole answer (commands.go:74-98). */
export async function recentText(entries: EntriesService, timeZone: string): Promise<string> {
	let journal: Change[];
	try {
		journal = await entries.recent(RECENT_COUNT);
	} catch {
		return "Couldn't read the history right now.";
	}
	if (journal.length === 0) return "Nothing has been recorded yet.";
	const lines: string[] = [];
	for (const change of journal) {
		const line = recentLine(change, timeZone);
		if (line !== null) lines.push(line);
	}
	if (lines.length === 0) return "Nothing has been recorded yet.";
	return `Last changes, newest first:\n${lines.join("\n")}`;
}

/** What a command needs: the services Go's Bot holds, and the one way it answers. */
export interface CommandDeps {
	entries: EntriesService;
	/** Go's `b.Docs`: null when the documents are switched off (MOVIN_DOCS=off). */
	syncer: Syncer | null;
	/** The zone `/recent` shows its times in (Go's `Agent.Loc`). */
	timeZone: string;
	log: Log;
	/**
	 * Queues one message to the chat being answered: durable, and ordered behind
	 * that chat's earlier replies. Go's `reply` sent it inside the turn.
	 */
	send: (text: string, keyboard?: InlineKeyboardMarkup | null) => Promise<void>;
	/** Go's `b.Checkin` (T5.1c): null in a bot without one, which `/checkin` says. */
	checkin?: CheckinSender | null;
}

/**
 * runCommand is Go's `command` switch (commands.go:50-71) after the `/think`
 * branch, which is a message and stays in `bot.ts`. An unknown command echoes
 * its own case, as Go's default branch does.
 */
export async function runCommand(deps: CommandDeps, cmd: string, name: string, chatId: number): Promise<void> {
	switch (cmd.toLowerCase()) {
		case "start":
		case "help":
			await deps.send(HELP_TEXT);
			return;
		case "recent":
			await deps.send(await recentText(deps.entries, deps.timeZone));
			return;
		case "undo":
			await undoLast(deps, name);
			return;
		case "sync":
			await syncNow(deps, chatId);
			return;
		case "checkin": {
			const checkin = deps.checkin ?? null;
			if (checkin === null) {
				await deps.send(CHECKIN_UNAVAILABLE);
				return;
			}
			// Go's checkinCommand sends to the chat that asked, and never advances the day
			// (checkin.go:191-192).
			await checkin.sendNow(`tg:${chatId}`, chatId, async (text) => await deps.send(text));
			return;
		}
		default:
			await deps.send(unknownCommand(cmd));
	}
}

/**
 * undoLast undoes the caller's own latest change, never someone else's
 * (commands.go:100-116). Go's four answers, and the confirmation carries no
 * speaker prefix even in a group, unlike the button's (§6.2).
 */
async function undoLast(deps: CommandDeps, name: string): Promise<void> {
	let mine: Change[] = [];
	try {
		// Only this person's changes: `c.By ==` the configured name (trap 14).
		mine = await deps.entries.recent(1, name);
	} catch {
		// Go's read failure and "nothing of mine" are the same answer (:102-105).
	}
	const last = mine[0];
	if (last === undefined) {
		await deps.send("You have no recent change to undo.");
		return;
	}
	let res: Result;
	try {
		res = await deps.entries.undo({ by: name, channel: "telegram" }, last.id);
	} catch (err) {
		await deps.send(
			err instanceof UndoStaleError
				? "Your last change was to an entry that has been changed again since, so I left it alone."
				: "Couldn't undo that right now.",
		);
		return;
	}
	const change = requireChange(res.changes);
	const line = ChangeText(change);
	await deps.send(`↩ ${line}`, undoKeyboard([{ id: change.id, text: line }]));
}

/**
 * syncNow is Go's `syncCommand` (docs.go:40-79). The "Syncing…" line goes out
 * before the run, so a slow sync is not a silent chat, and the answer after it
 * says what the run did.
 */
async function syncNow(deps: CommandDeps, chatId: number): Promise<void> {
	const syncer = deps.syncer;
	if (syncer === null) {
		await deps.send("Documents aren't switched on, so there's nothing to sync.");
		return;
	}
	if (syncer.running()) await deps.send("A sync is already running; I'll post the result when it's done.");
	else await deps.send("Syncing the documents…");
	let res: Sync;
	try {
		res = await syncer.sync(SYNC_REASON_PREFIX + String(chatId));
	} catch (err) {
		await deps.send(`The sync didn't finish: ${truncate(errorMessage(err), 300)}`);
		return;
	}
	const ix = await indexOf(syncer);
	const total = ix === null ? 0 : ix.docs.filter((d) => d.status === STATUS_OK).length;
	if (!syncChanged(res) && res.failed === 0) {
		await deps.send(`No changes. ${total} documents are readable.`);
		return;
	}
	let msg = `Synced: ${counts(res)}. ${total} documents are readable.`;
	if (ix !== null) {
		const touched = ix.docs.filter((d) => d.syncedAt === res.at || d.removedAt === res.at || d.errorAt === res.at);
		msg += `\n${docList(touched, 15)}`;
	}
	await deps.send(msg);
}

/** indexOf is `ix, _ := b.Docs.Index(ctx)` (docs.go:65): an unreadable index is no list, not a failure. */
async function indexOf(syncer: Syncer): Promise<Index | null> {
	try {
		return await syncer.index();
	} catch {
		return null;
	}
}

/**
 * What one callback does, as the effects `bot.ts` makes: the toast for
 * answerCallbackQuery, the keyboard edit on the pressed message, and the
 * confirmation when there is one. `edit` absent means "do not edit"; `edit:
 * null` sends Go's empty keyboard, which is how the last button goes.
 */
export interface CallbackPlan {
	/** The toast; "" is Go's bare acknowledgement (bot.go:546-550). */
	toast: string;
	edit?: InlineKeyboardMarkup | null;
	confirmation?: { text: string; keyboard: InlineKeyboardMarkup | null };
}

/** One button press, as the ledger kept it. */
export interface ButtonPress {
	/** The configured name auth check 2 returned: the undo is recorded under it. */
	name: string;
	/** The button's data (`undo:<change id>`, or `ci:<op>:…`). */
	data: string;
	/** `cb.Message.ReplyMarkup` as Telegram sent it back; null when it carried none (or an old ledger item). */
	markup: InlineKeyboardMarkup | null;
	/** A group: the confirmation names who pressed it. */
	group: boolean;
}

/** What a button press needs: the entries it changes, and the clock a `Tomorrow` press reads. */
export interface CallbackDeps {
	entries: EntriesService;
	log: Log;
	/** The zone `ci:r:<id>:<date>:<days>` counts days in (Go's `loc`, checkin.go:249-250). */
	timeZone: string;
	now: () => Date;
}

/**
 * checkinButton is Go's checkinCallback (checkin.go:221-291): done, done + ★, or
 * move the date, with the precondition evaluated **inside** the write, so an edit
 * made meanwhile (web, chat) cannot be overwritten (checkin.go:254-266).
 */
async function checkinButton(deps: CallbackDeps, press: ButtonPress): Promise<CallbackPlan> {
	const button = parseCheckinCallback(press.data, deps.now(), deps.timeZone);
	if (button.op === "ack") return { toast: "" };
	let patch: Patch;
	switch (button.op) {
		case "done":
			patch = { status: STATUS_DONE };
			break;
		case "milestone":
			patch = { status: STATUS_DONE, milestone: true };
			break;
		case "move":
			patch = { date: button.date };
			break;
	}
	const check = (e: Entry): void => {
		if (e.archived) throw new StaleAskError(ARCHIVED_TOAST);
		if (e.status === STATUS_DONE) throw new StaleAskError(ALREADY_DONE_TOAST);
		// The date as asked, so a press after the task moved elsewhere changes nothing.
		if (e.date === null || e.date !== button.asked) throw new StaleAskError(movedToast(e.date));
	};
	let res: Result;
	try {
		res = await deps.entries.updateIf({ by: press.name, channel: "telegram" }, button.id, check, patch);
	} catch (err) {
		// Go's three toasts, in its order (:281-290). The first two close the ask;
		// the last leaves the buttons, so the press can be tried again (:288-290).
		if (err instanceof StaleAskError) return closeAsk(press, err.message);
		if (err instanceof EntryNotFoundError) return closeAsk(press, "That entry is gone.");
		deps.log.warn("telegram check-in update failed", { by: press.name, entryId: button.id, err: errorMessage(err) });
		return { toast: "Couldn't save that; try again or tell me in words." };
	}
	const change = requireChange(res.changes);
	const line = ChangeText(change);
	const who = press.group ? `${press.name}: ` : "";
	return {
		// The toast is the line cut to 190 runes; the message carries all of it (:270-279).
		toast: truncate(line, 190),
		edit: closeEdit(press),
		confirmation: { text: `✓ ${who}${line}`, keyboard: undoKeyboard([{ id: change.id, text: line }]) },
	};
}

/**
 * closeAsk is Go's closeAsk (checkin.go:307-312): the toast, and — only when the
 * pressed message carried a keyboard — that message's buttons go, so the task
 * cannot be answered twice.
 */
function closeAsk(press: ButtonPress, text: string): CallbackPlan {
	const plan: CallbackPlan = { toast: text };
	const edit = closeEdit(press);
	if (edit !== undefined) plan.edit = edit;
	return plan;
}

/** closeEdit removes the whole keyboard, or nothing when the message had none. */
function closeEdit(press: ButtonPress): InlineKeyboardMarkup | null | undefined {
	return press.markup === null ? undefined : null;
}

/**
 * planCallback is Go's `handleCallback` (bot.go:536-592) after its auth check:
 * `ci:` is the check-in's button (T5.1c), `undo:<id>` undoes, anything else is
 * acknowledged and ignored so no button keeps its spinner (trap 16).
 */
export async function planCallback(deps: CallbackDeps, press: ButtonPress): Promise<CallbackPlan> {
	if (press.data.startsWith(CHECKIN_PREFIX)) return await checkinButton(deps, press);
	if (!press.data.startsWith(UNDO_PREFIX)) return { toast: "" };
	const entries = deps.entries;
	const log = deps.log;
	const id = press.data.slice(UNDO_PREFIX.length);
	let res: Result;
	try {
		res = await entries.undo({ by: press.name, channel: "telegram" }, id);
	} catch (err) {
		// Go's three toasts, in its order (:554-565).
		if (err instanceof UndoStaleError) return { toast: "That entry was changed again since, so it can't be undone." };
		if (err instanceof ChangeNotFoundError) return { toast: "That change is too old to undo." };
		log.warn("telegram undo failed", { by: press.name, err: errorMessage(err) });
		return { toast: "Couldn't undo that." };
	}
	const change = requireChange(res.changes);
	const line = ChangeText(change);
	const who = press.group ? `${press.name}: ` : "";
	const plan: CallbackPlan = {
		// The toast is the line cut to 190 runes; the message carries all of it (:567).
		toast: truncate(line, 190),
		confirmation: { text: `↩ ${who}${line}`, keyboard: undoKeyboard([{ id: change.id, text: line }]) },
	};
	// Drop the pressed button so it cannot be pressed twice, keeping the others (:569-586).
	if (press.markup !== null) plan.edit = withoutButton(press.markup, press.data);
	return plan;
}

/** withoutButton filters one callback_data out of a keyboard, dropping rows left empty; null when none remain. */
function withoutButton(markup: InlineKeyboardMarkup, data: string): InlineKeyboardMarkup | null {
	const rows = markup.inline_keyboard
		.map((row) => row.filter((button) => button.callback_data !== data))
		.filter((row) => row.length > 0);
	return rows.length === 0 ? null : { inline_keyboard: rows };
}

/**
 * requireChange is the record an undo wrote: exactly one, always
 * (journal.go's undo returns the undo record). A missing one is a bug in the
 * service, and throwing keeps it visible in `telegram handler panicked`.
 */
function requireChange(records: readonly Change[]): Change {
	const [change] = records;
	if (change === undefined) throw new TypeError("undo returned no change record");
	return change;
}
