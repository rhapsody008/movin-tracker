// The one-line description of a change: what the page shows in its banner
// ("Saved: …", "Updated: … (…)") and what Telegram replies with. Port of
// internal/agent/tools.go:288-372 (fmtDate, Money, Summary, ChangeText).
//
// It sits next to the entries model rather than with the agent because it is a
// pure function of an entry, and the HTTP layer needs it without constructing
// an agent (server-spec §1.4). T3 and T4 import it from here.

import { validDate } from "../sched.ts";
import type { Change, Entry } from "./model.ts";

const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * fmtDate is Go's Time.Format("Mon, 2 Jan") of a "2006-01-02" day, or the
 * string unchanged when it is not one (Go ignores the parse error).
 */
export function fmtDate(s: string): string {
	// time.Parse validates the calendar; validDate does the same and rejects
	// "2026-2-3" and "2026-02-29" as Go does.
	if (!validDate(s)) return s;
	const day = Number(s.slice(8, 10));
	const month = Number(s.slice(5, 7));
	// Date.UTC maps years 0-99 to 1900-1999, so set the date before reading the
	// weekday, as sched.addDays does.
	const at = new Date(0);
	at.setUTCFullYear(Number(s.slice(0, 4)), month - 1, day);
	const weekday = WEEKDAYS[at.getUTCDay()] ?? "";
	const name = MONTHS[month - 1] ?? "";
	return `${weekday}, ${day} ${name}`;
}

/**
 * Money formats SGD as "$3,000" or "$1,234.50". The floor, the rounded cents
 * and the carry from 100 cents to a whole dollar are Go's exactly, including
 * its arithmetic on negative values (which the entries model never allows).
 */
export function Money(f: number): string {
	let whole = Math.floor(f);
	let cents = Math.round((f - whole) * 100);
	if (cents === 100) {
		whole += 1;
		cents = 0;
	}
	let s = String(whole);
	// Go's loop: the index runs from the original length - 3 downwards, and
	// each insertion lengthens the string.
	for (let i = s.length - 3; i > 0; i -= 3) {
		s = `${s.slice(0, i)},${s.slice(i)}`;
	}
	if (cents > 0) s += `.${String(cents).padStart(2, "0")}`;
	return `$${s}`;
}

/** Summary is the one-line description of an entry: "wet kitchen · idea · Quartz countertop · est $3,000". */
export function Summary(e: Entry): string {
	const parts: string[] = [];
	if (e.room !== null) parts.push(e.room);
	parts.push(e.kind, e.title);
	if (e.date !== null) {
		let d = fmtDate(e.date);
		if (e.time !== null) d += ` ${e.time}`;
		parts.push(d);
	}
	if (e.cost.estimate !== null) parts.push(`est ${Money(e.cost.estimate)}`);
	if (e.cost.actual !== null) parts.push(`paid ${Money(e.cost.actual)}`);
	if (e.vendor !== "") parts.push(e.vendor);
	if (e.completed !== null) parts.push(`done ${fmtDate(e.completed)}`);
	if (e.milestone) parts.push("★ milestone");
	return parts.join(" · ");
}

/** ptrStr is Go's helper: a nullable string prints as its value or "none". */
function ptrStr(p: string | null): string {
	return p ?? "none";
}

/** money is Go's helper: a nullable amount prints as Money(...) or "none". */
function money(p: number | null): string {
	return p === null ? "none" : Money(p);
}

/**
 * ChangeText is the human line for one journal change. The order of the diff
 * entries is Go's, and so is every branch: archive and restore come before the
 * diff list, and the completed day only counts when the status did not move.
 */
export function ChangeText(c: Change): string {
	if (c.op === "create") return `Saved: ${Summary(created(c))}`;
	if (c.op === "delete") return `Deleted: ${deleted(c).title}`;
	if (c.op === "undo") {
		if (c.after === null) return `Undone: removed ${deleted(c).title}`;
		if (c.before === null) return `Undone: restored ${c.after.title}`;
		return `Undone: ${c.after.title}`;
	}
	// Only an update is left, and it always has both sides (Go would panic on a
	// record that has not).
	if (c.after === null || c.before === null) throw new TypeError("update change record without both sides");
	const a = c.after;
	const b = c.before;
	if (a.archived && !b.archived) return `Archived: ${a.title}`;
	if (!a.archived && b.archived) return `Restored: ${a.title}`;
	const diff: string[] = [];
	const add = (changed: boolean, s: string): void => {
		if (changed) diff.push(s);
	};
	add(a.title !== b.title, `renamed from ${b.title}`);
	add(a.kind !== b.kind, `now a ${a.kind}`);
	add(a.status !== b.status, `status ${a.status}`);
	add(ptrStr(a.room) !== ptrStr(b.room), `room ${ptrStr(a.room)}`);
	add(a.category !== b.category, `category ${a.category}`);
	add(money(a.cost.estimate) !== money(b.cost.estimate), `est ${money(a.cost.estimate)}`);
	add(money(a.cost.actual) !== money(b.cost.actual), `paid ${money(a.cost.actual)}`);
	add(ptrStr(a.date) !== ptrStr(b.date), `date ${ptrStr(a.date)}`);
	add(ptrStr(a.time) !== ptrStr(b.time), `time ${ptrStr(a.time)}`);
	add(a.vendor !== b.vendor, `vendor ${a.vendor}`);
	add(a.source !== b.source, "source");
	add(a.notes !== b.notes, "notes");
	add(a.tags.join(",") !== b.tags.join(","), "tags");
	add(a.milestone && !b.milestone, "★ milestone");
	add(!a.milestone && b.milestone, "no longer a milestone");
	// The done day moves with the status; only a day changed by itself is news.
	add(a.status === b.status && ptrStr(a.completed) !== ptrStr(b.completed), `done on ${ptrStr(a.completed)}`);
	if (diff.length === 0) return `Updated: ${a.title}`;
	return `Updated: ${a.title} (${diff.join(", ")})`;
}

/** created is c.after for the lines that show it; a missing side is a bug in the journal. */
function created(c: Change): Entry {
	if (c.after === null) throw new TypeError("change record without an after entry");
	return c.after;
}

/** deleted is c.before for the lines that show it. */
function deleted(c: Change): Entry {
	if (c.before === null) throw new TypeError("change record without a before entry");
	return c.before;
}
