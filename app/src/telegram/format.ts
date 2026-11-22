// Telegram's reply formatting: Go's `reply`, `split`, `truncate`, `changeText`
// and `undoKeyboard` (internal/telegram/bot.go:496-644) as pure functions. No
// I/O: the delivery task (T4.3b) is what actually calls Telegram.
//
// Every byte the user sees is Go's, and the messages are shaped as Go's `reply`
// shapes them — the text split at 4000 runes, the first part threaded under the
// message in a group only, the Undo keyboard on the last part only. The one
// check Go does not have is Telegram's 64-byte `callback_data` limit on the
// buttons (spec §11 trap 9).
//
// Known differences from Go, all deliberate (decisions.md · T4.3a):
// - leading blank lines are trimmed before sending, where Go sends `res.Reply`
//   as it is (T0.3 saw a /think reply begin with blank lines; spec §5.7).
//   `reply.ts`'s `shownText` already trims, so no `channelReply` answer starts
//   with one — the trim is pinned against a hand-built reply all the same.
// - a turn the 15-minute watchdog stopped says TIMED_OUT_DETAIL where Go says
//   `context deadline exceeded` (the poll's own wording for the same thing).
// - `undoKeyboard` throws when one `callback_data` would exceed 64 bytes, so a
//   longer change id fails here rather than as a 400 from Telegram.
//
// The failure line is Go's `Sorry, that didn't go through: ` plus the detail, and
// the one detail this file has a fixed text for is the missing connection: the
// bot checks `baseUrl`/`model` before it submits and settles with
// `FAILURE_PREFIX + NO_CONNECTION_MESSAGE` (Go's prepare refuses that connection
// at internal/agent/agent.go:152-154 and converse prints the error at
// bot.go:440-447; T4 fixes M1). The text lives in `src/agent/reply.ts`, which
// this file may not import — `bot.ts` does, and this file only reads it through
// the failure line it is given.

import type { ChannelReply, ChatOutcome, WireChange } from "../agent/reply.ts";
import { goTrimRight } from "../gostr.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup, SendMessage } from "./client.ts";

/** Go's maxMessage: Telegram allows 4096, and Go leaves 96 of room (bot.go:85-94). */
export const MAX_MESSAGE = 4000;

/** Go's maxUndoButtons. */
const MAX_UNDO_BUTTONS = 8;

/** Go's four-buttons-per-row keeps them tappable on a phone (bot.go:526). */
const UNDO_PER_ROW = 4;

/** Telegram's limit for `callback_data`, counted in UTF-8 bytes (spec §11 trap 9). */
const MAX_CALLBACK_BYTES = 64;

/** Go's reply to a document, a photo or a voice note (bot.go:395-397). */
export const NON_TEXT_REPLY = "I can only read text for now. Drawings, photos and voice notes are coming.";

/** Go's answer to a bare /think, which calls no model (commands.go:54-57). */
export const THINK_HINT = "Put your question after /think, e.g. /think which countertop fits our budget better?";

/** Go's failure line's opening, trailing space included (bot.go:441). */
export const FAILURE_PREFIX = "Sorry, that didn't go through: ";

/** Go's change block after a failure (bot.go:443). */
const CHANGES_SAVED_PREFIX = "\n\nSome changes were saved before it failed:\n";

/** Where a turn's answer goes: Go's `m.Chat.ID`, `m.MessageID` and `m.Chat.IsGroup()`. */
export interface ReplyAddress {
	chat: number;
	messageId: number;
	group: boolean;
}

export interface ReplyOptions {
	/**
	 * The 15-minute watchdog stopped the turn, so the detail says so instead of
	 * Go's `context deadline exceeded` (plan.md:125, spec §4.5).
	 */
	timedOut?: boolean;
}

/** The watchdog's detail: what the failure line says in place of Go's deadline text. */
export const TIMED_OUT_DETAIL = "the turn took longer than 15 minutes and was stopped";

/**
 * Go's split (bot.go:615-636): parts of at most n runes, cut at the last line
 * break in the second half of the window when there is one. Runes are code
 * points, never UTF-16 units (spec §11 trap 3) — Go's `[]rune` is `[...s]`.
 *
 * A break's newline is consumed from both sides, so the parts do not rejoin to
 * the input, and `split("", n)` is one empty part (traps 4 and 5).
 */
export function split(text: string, n: number): string[] {
	const runes = [...text];
	const out: string[] = [];
	while (runes.length > n) {
		let cut = n;
		// Go's `for i := n; i > n/2; i--`, integer division included.
		for (let i = n; i > Math.floor(n / 2); i--) {
			if (runes[i] === "\n") {
				cut = i;
				break;
			}
		}
		out.push(goTrimRight(runes.slice(0, cut).join(""), "\n"));
		runes.splice(0, cut);
		while (runes.length > 0 && runes[0] === "\n") runes.shift();
	}
	if (runes.length > 0 || out.length === 0) out.push(runes.join(""));
	return out;
}

/**
 * Go's truncate (bot.go:638-644): at most n runes, the last one replaced by an
 * ellipsis, so `truncate(s, 300)` keeps 299 of the input (spec §11 trap 8).
 */
export function truncate(s: string, n: number): string {
	const runes = [...s];
	if (runes.length <= n) return s;
	return `${runes.slice(0, n - 1).join("")}…`;
}

/** Go's changeText (bot.go:496-503): one `• ` line per change, joined with a newline. */
export function changeText(changes: readonly WireChange[]): string {
	return changes.map((c) => `• ${c.text}`).join("\n");
}

/**
 * Go's undoKeyboard (bot.go:505-534): one Undo button per journaled change, the
 * key dates (no id) getting none, at most eight buttons, four per row, labelled
 * `Undo` when there is exactly one and `Undo 1`…`Undo 8` otherwise.
 *
 * Throws instead of sending a button Telegram would refuse: `undo:` plus v3's
 * 26-character change id is 31 bytes, and anything over 64 is a 400 that
 * spoils the whole message.
 */
export function undoKeyboard(changes: readonly WireChange[]): InlineKeyboardMarkup | null {
	const ids = changes.flatMap((c) => (c.id === undefined || c.id === "" ? [] : [c.id]));
	if (ids.length === 0) return null;
	const shown = ids.slice(0, MAX_UNDO_BUTTONS);
	const buttons = shown.map((id, i) => {
		const data = `undo:${id}`;
		const size = Buffer.byteLength(data, "utf8");
		if (size > MAX_CALLBACK_BYTES) {
			throw new Error(`undo button data is ${size} bytes, over Telegram's ${MAX_CALLBACK_BYTES}: ${data}`);
		}
		const button: InlineKeyboardButton = { text: shown.length > 1 ? `Undo ${i + 1}` : "Undo", callback_data: data };
		return button;
	});
	const rows: InlineKeyboardButton[][] = [];
	for (let i = 0; i < buttons.length; i += UNDO_PER_ROW) rows.push(buttons.slice(i, i + UNDO_PER_ROW));
	return { inline_keyboard: rows };
}

/**
 * textMessages is Go's `reply` for text that is not a turn's outcome — a
 * command's answer, the fixed line for a non-text message, a document notice
 * (bot.go:596-613) — so there is one assembly for both it and `replyMessages`.
 * The first part is a reply to the triggering message in a group only, and the
 * keyboard, when there is one, goes on the last part only (trap 10).
 */
export function textMessages(
	text: string,
	address: ReplyAddress,
	keyboard: InlineKeyboardMarkup | null = null,
): SendMessage[] {
	const parts = split(trimLeadingBlankLines(text), MAX_MESSAGE);
	return parts.map((part, i) => {
		const message: SendMessage = { chat_id: address.chat, text: part };
		if (i === 0 && address.group) message.reply_to_message_id = address.messageId;
		if (i === parts.length - 1 && keyboard !== null) message.reply_markup = keyboard;
		return message;
	});
}

/**
 * replyMessages is Go's `reply` over a finished turn (bot.go:596-613 with
 * converse's two text shapes, :440-456): the messages to send, in order, or
 * `null` when the turn is silent and nothing at all goes out (spec §5.5).
 */
export function replyMessages(
	reply: ChannelReply,
	address: ReplyAddress,
	options: ReplyOptions = {},
): SendMessage[] | null {
	if (reply.silent) return null;
	const outcome = reply.outcome;
	const changes = outcome.ok ? outcome.result.changes : outcome.changes;
	return textMessages(textOf(outcome, changes, options), address, undoKeyboard(changes));
}

/** textOf is the text Go's converse hands to `reply`: the answer, or the failure line. */
function textOf(outcome: ChatOutcome, changes: readonly WireChange[], options: ReplyOptions): string {
	if (outcome.ok) {
		const answered = outcome.result.reply;
		return changes.length > 0 ? `${answered}\n\n${changeText(changes)}` : answered;
	}
	// Go's detail is `err.Error()`; v3's is the run's scrubbed detail, and the
	// watchdog's abort is the one case that is not the person stopping it.
	const detail = options.timedOut === true ? TIMED_OUT_DETAIL : outcome.error;
	const line = FAILURE_PREFIX + truncate(detail, 300);
	return changes.length > 0 ? line + CHANGES_SAVED_PREFIX + changeText(changes) : line;
}

/**
 * The one v3 change to the bytes: blank lines at the start go (Go sends them;
 * T0.3's /think answer began with two). A blank line is one that holds nothing
 * but spaces or carriage returns; a line with text keeps its own whitespace.
 */
function trimLeadingBlankLines(text: string): string {
	return text.replace(/^(?:[ \t\r]*\n)+/, "");
}
