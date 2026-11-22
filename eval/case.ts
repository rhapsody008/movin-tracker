// Go's chat-eval case format and check helpers, ported from
// cmd/chateval/main.go:36-98, :238-247 and :466-523 (agent-spec §6.2).
//
// A check gets the document before and after the message, the turn's reply and
// the log written during the case, and answers a failure reason or null — Go's
// `check` returning an error. The texts are Go's, with one recorded difference
// (below): Go prints a struct with `%+v`, which for pointer fields is a memory
// address, so the two places that did are the entry and the cost as JSON here.
//
// Everything is a plain function of the entries model: no agent, no store.

import { type Doc, type Entry, isMilestone } from "../src/entries/model.ts";
import { goMarshal } from "../src/gojson.ts";
import { goQuote } from "../src/gostr.ts";

/** One calendar day in the app's zone: what Go's time.Time answered for the checks. */
export interface Day {
	/** Go's `Format("2006-01-02")`: what a date field holds. */
	iso: string;
	/** Go's `time.Weekday`: 0 is Sunday. */
	weekday: number;
	year: number;
	/** 1-12. */
	month: number;
	/** 1-31. */
	day: number;
}

/** What a check sees of the turn. */
export interface CaseResult {
	reply: string;
	/** Go's `res.Silent`: the channel sends nothing (a group chat, nothing recorded). */
	silent: boolean;
}

/** A check fails the case with the reason it returns; null passes (Go's `error`). */
export type Check = (before: Doc, after: Doc, res: CaseResult, toolLog: string) => string | null;

/** One eval case: the message, whether it comes from a group, and its check. */
export interface EvalCase {
	msg: string;
	group?: boolean;
	check: Check;
}

/** live is every non-archived entry whose title, vendor or notes match the pattern (main.go:49-59). */
export function live(d: Doc, re: string): Entry[] {
	const rx = new RegExp(re, "i");
	return d.entries.filter((e) => !e.archived && (rx.test(e.title) || rx.test(e.vendor) || rx.test(e.notes)));
}

/** added are the entries present in after but not in before (main.go:61-69). */
export function added(before: Doc, after: Doc): Entry[] {
	return after.entries.filter((e) => findById(before, e.id) === null);
}

/** eq is Go's `p != nil && *p == v`. */
export function eq(p: number | null, v: number): boolean {
	return p !== null && p === v;
}

/**
 * deref is Go's deref: the value, or the string `<nil>` for a nil pointer, which
 * is what `%v` prints (main.go:250-255). It is a value and never null, so a
 * message can interpolate it directly.
 */
export function deref<T>(p: T | null): T | "<nil>" {
	return p === null ? "<nil>" : p;
}

/** unchanged requires the diff to be exactly `(no change)` (main.go:73-79). */
export function unchanged(before: Doc, after: Doc): string | null {
	const d = diff(before, after);
	if (d.length !== 1 || d[0] !== "(no change)") return `expected no change, got: ${d.join("; ")}`;
	return null;
}

/** nextDec5 is the 5 Dec on or after today (main.go:81-88). */
export function nextDec5(now: Day): string {
	const d = `${now.year}-12-05`;
	return d < now.iso ? `${now.year + 1}-12-05` : d;
}

/** FRIDAY is Go's Friday in `time.Weekday`. */
const FRIDAY = 5;

/**
 * fridays are the dates "Friday" can reasonably mean: the coming Friday (today
 * if it is Friday) and the one after (main.go:90-98).
 */
export function fridays(now: Day): [string, string] {
	let wait = 0;
	while ((now.weekday + wait) % 7 !== FRIDAY) wait++;
	return [addDays(now.iso, wait), addDays(now.iso, wait + 7)];
}

/** isoParts reads YYYY-MM-DD as numbers. */
function isoParts(iso: string): { year: number; month: number; day: number } {
	return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

/** addDays is Go's AddDate(0, 0, n) on a date: a calendar step, no clock involved. */
export function addDays(iso: string, n: number): string {
	const { year, month, day } = isoParts(iso);
	// setUTCFullYear first: Date.UTC maps years 0-99 to 1900-1999.
	const at = new Date(0);
	at.setUTCFullYear(year, month - 1, day + n);
	return at.toISOString().slice(0, 10);
}

/** milestones are the done, flagged entries, oldest change first (main.go:238-247). */
export function milestones(d: Doc): Entry[] {
	const out = d.entries.filter((e) => !e.archived && isMilestone(e));
	// Go's sort.SliceStable on `updated` ascending: equal stamps keep their order.
	return out.sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0));
}

/** gv is Go's `%v` of the values the diff compares (a deref'd pointer included). */
function gv(v: unknown): string {
	return v === null || v === undefined ? "<nil>" : String(v);
}

/**
 * diff describes what changed between two documents, field by field
 * (main.go:466-523): the two meta dates, then per entry `+`, `~` and `-` lines.
 */
export function diff(a: Doc, b: Doc): string[] {
	const out: string[] = [];
	if (gv(deref(a.meta.moveDate)) !== gv(deref(b.meta.moveDate))) {
		out.push(`meta.moveDate: ${deref(a.meta.moveDate)} → ${deref(b.meta.moveDate)}`);
	}
	if (gv(deref(a.meta.keyDate)) !== gv(deref(b.meta.keyDate))) {
		out.push(`meta.keyDate: ${deref(a.meta.keyDate)} → ${deref(b.meta.keyDate)}`);
	}
	const old = new Map(a.entries.map((e) => [e.id, e]));
	const seen = new Set<string>();
	for (const e of b.entries) {
		seen.add(e.id);
		const prev = old.get(e.id);
		if (prev === undefined) {
			out.push(`+ ${goQuote(e.title)} ${newEntryJson(e)}`);
			continue;
		}
		const ch: string[] = [];
		const cmp = (name: string, x: unknown, y: unknown): void => {
			if (gv(x) !== gv(y)) ch.push(`${name}: ${gv(x)} → ${gv(y)}`);
		};
		cmp("title", prev.title, e.title);
		cmp("kind", prev.kind, e.kind);
		cmp("room", deref(prev.room), deref(e.room));
		cmp("category", prev.category, e.category);
		cmp("status", prev.status, e.status);
		cmp("date", deref(prev.date), deref(e.date));
		cmp("time", deref(prev.time), deref(e.time));
		cmp("vendor", prev.vendor, e.vendor);
		cmp("estimate", deref(prev.cost.estimate), deref(e.cost.estimate));
		cmp("actual", deref(prev.cost.actual), deref(e.cost.actual));
		cmp("notes", prev.notes, e.notes);
		cmp("archived", prev.archived, e.archived);
		cmp("milestone", prev.milestone, e.milestone);
		cmp("completed", deref(prev.completed), deref(e.completed));
		if (ch.length > 0) out.push(`~ ${goQuote(prev.title)} ${ch.join(", ")}`);
	}
	for (const e of a.entries) {
		if (!seen.has(e.id)) out.push(`- ${goQuote(e.title)} (hard-deleted)`);
	}
	return out.length === 0 ? ["(no change)"] : out;
}

/**
 * newEntryJson is the map Go marshals for a `+` line (main.go:487). Go's
 * encoding/json sorts a map's keys, so they are written in that order here.
 */
function newEntryJson(e: Entry): string {
	return goMarshal({
		actual: e.cost.actual,
		category: e.category,
		completed: e.completed,
		date: e.date,
		estimate: e.cost.estimate,
		kind: e.kind,
		milestone: e.milestone,
		room: e.room,
		status: e.status,
		time: e.time,
		vendor: e.vendor,
	});
}

/** entryJson is Go's `%+v` of an entry for a failure reason, as JSON (see the header). */
export function entryJson(e: Entry): string {
	return goMarshal(e);
}

/** findById is Go's `Doc.Find` without the copy: the check helpers only read. */
function findById(d: Doc, id: string): Entry | null {
	return d.entries.find((e) => e.id === id) ?? null;
}
