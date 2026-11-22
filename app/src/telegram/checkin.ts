// The morning check-in's texts, buttons and `ci:` callback parsing: the port of
// internal/telegram/checkin.go, the part that touches no I/O. T5.1b schedules it
// and T5.1c sends and answers it.
//
// Every byte here is Go's, and the Go v1 code, tag v1.0.1, golden t51 wrote the fixture it is compared
// with. The rules worth knowing:
// - the summary counts the asks it has (ag.ask), not the eight it asks about
//   (checkin.go:103), so "Not marked done yet (10)" can head eight messages;
// - the buttons carry the date the task had **when it was asked**, so a press
//   after the task moved elsewhere changes nothing (checkin.go:133-135);
// - `ci:` is a wire format: buttons sitting in a chat since v1 must keep
//   working, so the prefix, the ops and the date form never change.
//
// Go carries the check-in into the chat's history as two turns, `(morning
// check-in)` and the reply (checkin.go:172-189). v3 delivers it as one pending
// note instead (decisions.md · T5): note.text is that literal and Go's reply
// joined by a blank line, which is the one byte-level addition this file makes.

import type { Agenda } from "../entries/agenda.ts";
import type { Entry } from "../entries/model.ts";
import { addDays, day, validDate } from "../sched.ts";
import { parseInt64 } from "../settings/text.ts";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./client.ts";
import { MAX_MESSAGE, split } from "./format.ts";

/** The callback data prefix (checkin.go:29). Buttons from v1 must keep working. */
export const CHECKIN_PREFIX = "ci:";

/** Go's maxAskMessages: the rest of the asks are listed, not messaged (checkin.go:25). */
export const MAX_ASK_MESSAGES = 8;

/** Go's maxOverdueTitles: the overdue list stops at five (checkin.go:27). */
export const MAX_OVERDUE_TITLES = 5;

/** The tag of the note the check-in leaves for the model. */
export const CHECKIN_NOTE_TAG = "checkin";

/** Go's `(morning check-in)`: the user turn sendCheckin remembers (checkin.go:178). */
export const MORNING_CHECKIN = "(morning check-in)";

/** Go's stale-ask answers (checkin.go:256-264, :281-283). */
export const ARCHIVED_TOAST = "That entry was archived.";
export const ALREADY_DONE_TOAST = "Already done.";

/**
 * Why a `ci:` press no longer applies: Go's `staleAsk` (`checkin.go:294-296`), an
 * error from the precondition that runs inside the write, whose text is the
 * toast the press gets.
 */
export class StaleAskError extends Error {}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Go's shortDay: "Wed 11 Nov" (checkin.go:66-72). A day that is not
 * YYYY-MM-DD is returned unchanged, as Go returns time.Parse's failure.
 */
export function shortDay(value: string): string {
	if (!validDate(value)) return value;
	// Date.UTC maps years 0-99 to 1900-1999, so set the date before reading it.
	const at = new Date(0);
	at.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
	const weekday = WEEKDAYS[at.getUTCDay()] ?? "";
	const month = MONTHS[Number(value.slice(5, 7)) - 1] ?? "";
	return `${weekday} ${Number(value.slice(8, 10))} ${month}`;
}

/**
 * Go's agendaLine: the title, with the time in front and the room in brackets
 * (checkin.go:74-83). "14:00 Electrician", "Measure windows (living)".
 */
export function agendaLine(e: Entry): string {
	let s = e.title;
	if (e.time !== null) s = `${e.time} ${s}`;
	if (e.room !== null) s += ` (${e.room})`;
	return s;
}

/** The agenda only puts dated entries in ask and overdue (agenda.ts:41-52). */
function dateOf(e: Entry): string {
	return e.date ?? "";
}

/**
 * Go's checkinText (checkin.go:86-123): the summary, and the asks to message
 * one by one (at most MAX_ASK_MESSAGES of them).
 */
export function checkinText(today: string, ag: Agenda): { summary: string; asks: Entry[] } {
	const out: string[] = [`Good morning! ${shortDay(today)}\n`];
	if (ag.today.length > 0) {
		out.push("\nToday:\n");
		for (const e of ag.today) out.push(`• ${agendaLine(e)}\n`);
	} else {
		out.push("\nNothing dated for today.\n");
	}
	const asks = ag.ask.slice(0, MAX_ASK_MESSAGES);
	const more = ag.ask.slice(MAX_ASK_MESSAGES);
	if (asks.length > 0) {
		// The count is of every ask, not of the ones messaged below it.
		out.push(`\nNot marked done yet (${ag.ask.length}), below. Tap a button or just tell me.\n`);
	}
	if (more.length > 0) {
		out.push("Also open from earlier days:\n");
		for (const e of more) out.push(`• ${agendaLine(e)} — ${shortDay(dateOf(e))}\n`);
	}
	const overdue = ag.overdue.length;
	if (overdue > 0) {
		out.push(`\nStill overdue (${overdue}):\n`);
		for (let i = 0; i < ag.overdue.length; i++) {
			if (i === MAX_OVERDUE_TITLES) {
				out.push(`…and ${overdue - MAX_OVERDUE_TITLES} more\n`);
				break;
			}
			const e = ag.overdue[i];
			if (e === undefined) break;
			out.push(`• ${agendaLine(e)} — ${shortDay(dateOf(e))}\n`);
		}
	}
	out.push('\nAnything else, just say it, e.g. "move the tiler to Friday".');
	return { summary: out.join(""), asks };
}

/**
 * Go's askText (checkin.go:125-131): "Yesterday: Book movers\nDone?", or the
 * day itself for an older task.
 */
export function askText(e: Entry, today: string): string {
	const date = dateOf(e);
	const when = date === addDays(today, -1) ? "Yesterday" : shortDay(date);
	return `${when}: ${agendaLine(e)}\nDone?`;
}

/**
 * Go's askKeyboard (checkin.go:136-144): one row of four, the task's date as
 * asked. At most 44 bytes of callback_data (Telegram allows 64).
 */
export function askKeyboard(e: Entry): InlineKeyboardMarkup {
	const base = `${e.id}:${dateOf(e).replaceAll("-", "")}`;
	const button = (text: string, data: string): InlineKeyboardButton => ({ text, callback_data: data });
	return {
		inline_keyboard: [
			[
				button("Done", `${CHECKIN_PREFIX}d:${base}`),
				button("Done ★", `${CHECKIN_PREFIX}m:${base}`),
				button("Tomorrow", `${CHECKIN_PREFIX}r:${base}:1`),
				button("+1 week", `${CHECKIN_PREFIX}r:${base}:7`),
			],
		],
	};
}

/**
 * The answer to a stale `ci:` press, Go's `orNone` included (checkin.go:298-303):
 * "That task was moved since (Fri 13 Nov), so I left it."
 */
export function movedToast(date: string | null): string {
	return `That task was moved since (${date === null ? "no date" : shortDay(date)}), so I left it.`;
}

/** What a `ci:` press asks for: a bare ack, or the one change it makes. */
export type CheckinCallback =
	| { op: "ack" }
	| { op: "done" | "milestone"; id: string; asked: string }
	| { op: "move"; id: string; asked: string; days: number; date: string };

const ACK: CheckinCallback = { op: "ack" };

// strconv.Atoi: an optionally signed run of decimal digits, 0 where Go errors
// (checkinCallback ignores the error, checkin.go:246). The range test that
// follows makes a clamped out-of-range value behave the same.
function atoi(s: string): number {
	const n = parseInt64(s);
	return n === null ? 0 : Number(n);
}

/**
 * Go's checkinCallback's parsing (checkin.go:223-253): the data is
 * `ci:<op>:<id>:<YYYYMMDD>[:<days>]`, and anything it does not understand is a
 * bare ack — a touched button is answered with an empty toast, nothing else.
 * `move`'s date is today plus days, in the app's zone.
 */
export function parseCheckinCallback(data: string, now: Date, timeZone: string): CheckinCallback {
	const parts = (data.startsWith(CHECKIN_PREFIX) ? data.slice(CHECKIN_PREFIX.length) : data).split(":");
	const stamp = parts[2];
	if (parts.length < 3 || stamp === undefined || stamp.length !== 8) return ACK;
	const [op = "", id = ""] = parts;
	const asked = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6)}`;
	if (!validDate(asked)) return ACK;
	switch (op) {
		case "d":
			return { op: "done", id, asked };
		case "m":
			return { op: "milestone", id, asked };
		case "r": {
			const days = parts.length === 4 ? atoi(parts[3] ?? "") : 0;
			if (days < 1 || days > 31) return ACK;
			return { op: "move", id, asked, days, date: addDays(day(now, timeZone), days) };
		}
		default:
			return ACK;
	}
}

/** One message the check-in sends: the text, and the buttons it carries (if any). */
export interface CheckinPart {
	text: string;
	keyboard: InlineKeyboardMarkup | null;
}

/** The note the check-in leaves for the model: Go's `(morning check-in)` and its reply. */
export interface CheckinNote {
	tag: string;
	text: string;
}

export interface CheckinMessages {
	parts: CheckinPart[];
	note: CheckinNote;
}

/**
 * Go's sendCheckin (checkin.go:149-180) as values: the summary split at 4000
 * runes, then one message per ask with its keyboard, and the note that says what
 * was asked. Go drops an ask whose send failed from the note; here every ask is
 * sent or the delivery fails as a whole (decisions.md · T5).
 */
export function checkinMessages(today: string, ag: Agenda): CheckinMessages {
	const { summary, asks } = checkinText(today, ag);
	const parts: CheckinPart[] = split(summary, MAX_MESSAGE).map((text) => ({ text, keyboard: null }));
	const lead = parts.map((p) => p.text).join("");
	const asked: string[] = [];
	for (const e of asks) {
		const text = askText(e, today);
		parts.push({ text, keyboard: askKeyboard(e) });
		asked.push(`• ${text.replaceAll("\nDone?", "")}`);
	}
	let reply = lead;
	if (asked.length > 0) reply += `\n\nAsked about:\n${asked.join("\n")}`;
	return { parts, note: { tag: CHECKIN_NOTE_TAG, text: `${MORNING_CHECKIN}\n\n${reply}` } };
}
