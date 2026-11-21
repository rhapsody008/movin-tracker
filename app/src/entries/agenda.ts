// The morning check-in's agenda: the port of internal/entries/agenda.go. Pure
// date arithmetic on YYYY-MM-DD strings — no time zone and no clock, because the
// caller supplies today. AddDays itself lives in sched.ts (Go's internal/sched).
import { addDays, validDate } from "../sched.ts";
import { cloneEntry, type Doc, type Entry, KIND_TASK, STATUS_DONE } from "./model.ts";

/**
 * How far back the morning check-in asks about undone tasks when earlier
 * check-ins were missed; older ones count as overdue.
 */
export const MAX_ASK_DAYS = 7;

/** What the morning check-in reports for one day. */
export interface Agenda {
	/** Undone entries of any kind dated today, by time. */
	today: Entry[];
	/** Undone tasks dated since the last check-in up to yesterday. */
	ask: Entry[];
	/** Undone tasks dated before that window, oldest first. */
	overdue: Entry[];
}

/** Whether the day has nothing to say. */
export function isQuiet(a: Agenda): boolean {
	return a.today.length + a.ask.length + a.overdue.length === 0;
}

/**
 * Picks the check-in's entries for today (YYYY-MM-DD). since is the first day
 * not yet asked about (the day after the last check-in); "" or an invalid day
 * means yesterday, and it is clamped to at most MAX_ASK_DAYS back. Archived,
 * done and undated entries are left out. An invalid today gives an empty
 * agenda.
 */
export function agenda(doc: Doc, today: string, since: string): Agenda {
	const a: Agenda = { today: [], ask: [], overdue: [] };
	if (!validDate(today)) return a;
	const yesterday = addDays(today, -1);
	const floor = addDays(today, -MAX_ASK_DAYS);
	let from = since;
	if (from === "" || !validDate(from)) from = yesterday;
	if (from < floor) from = floor;
	for (const e of doc.entries) {
		if (e.archived || e.status === STATUS_DONE || e.date === null) continue;
		const day = e.date;
		if (day === today) {
			a.today.push(cloneEntry(e));
			continue;
		}
		if (e.kind !== KIND_TASK || day > today) continue;
		if (day >= from && day <= yesterday) a.ask.push(cloneEntry(e));
		else if (day < from) a.overdue.push(cloneEntry(e));
	}
	// Stable sort, so equal keys keep document order, as sort.SliceStable does.
	for (const list of [a.today, a.ask, a.overdue]) {
		list.sort((x, y) => (when(x) < when(y) ? -1 : when(x) > when(y) ? 1 : 0));
	}
	return a;
}

// Orders entries by date, then time (untimed last), then creation.
function when(e: Entry): string {
	return `${e.date ?? ""} ${e.time ?? "99:99"} ${e.created}`;
}
