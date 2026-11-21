// Entries search: the port of internal/entries/search.go. Plain functions over
// a document, no index and no scoring — "ranking" is recency only.
import { ValidationError } from "../errors.ts";
import { goFields, goTrimSpace } from "../gostr.ts";
import { cloneEntry, type Doc, type Entry, isMilestone } from "./model.ts";

/**
 * A structured query over entries; the JSON names are the agent's
 * search_entries tool arguments. Empty fields match anything. List fields match
 * any of their values (kinds, rooms, statuses) except tags, where an entry must
 * carry every listed tag.
 */
export interface Filter {
	kinds?: readonly string[];
	rooms?: readonly string[];
	statuses?: readonly string[];
	category?: string;
	tags?: readonly string[];
	/** Case-insensitive substring. */
	vendor?: string;
	/** Every word must appear somewhere. */
	text?: string;
	date_from?: string;
	date_to?: string;
	include_archived?: boolean;
	/** true keeps only milestones; false leaves them out; absent is no filter. */
	milestone?: boolean;
	limit?: number;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** The first `limit` matches, newest update first, and how many matched. */
export interface SearchResult {
	entries: Entry[];
	total: number;
}

// Go's lowerAll: lowercase and collapse inner whitespace, dropping empties.
function lowerAll(inList: readonly string[] | undefined): string[] {
	const out: string[] = [];
	for (const s of inList ?? []) {
		const t = goFields(s).join(" ").toLowerCase();
		if (t !== "") out.push(t);
	}
	return out;
}

/** A Filter normalised once for matching. */
interface Query {
	f: Filter;
	kinds: string[];
	rooms: string[];
	statuses: string[];
	tags: string[];
	category: string;
	vendor: string;
	words: string[];
}

function newQuery(f: Filter): Query {
	return {
		f,
		kinds: lowerAll(f.kinds),
		rooms: lowerAll(f.rooms),
		statuses: lowerAll(f.statuses),
		tags: lowerAll(f.tags),
		// Unlike the list fields, category and vendor keep inner spaces.
		category: goTrimSpace(f.category ?? "").toLowerCase(),
		vendor: goTrimSpace(f.vendor ?? "").toLowerCase(),
		words: goFields((f.text ?? "").toLowerCase()),
	};
}

function matches(q: Query, e: Entry): boolean {
	const f = q.f;
	if (e.archived && !(f.include_archived ?? false)) return false;
	if (q.kinds.length > 0 && !q.kinds.includes(e.kind)) return false;
	if (q.rooms.length > 0 && (e.room === null || !q.rooms.includes(e.room))) return false;
	if (q.statuses.length > 0 && !q.statuses.includes(e.status)) return false;
	if (f.milestone !== undefined && isMilestone(e) !== f.milestone) return false;
	if (q.category !== "" && e.category !== q.category) return false;
	if (!hasAll(e.tags, q.tags)) return false;
	if (q.vendor !== "" && !e.vendor.toLowerCase().includes(q.vendor)) return false;
	if (!inDates(q, e)) return false;
	if (q.words.length === 0) return true;
	const hay = haystack(e);
	for (const w of q.words) {
		if (!hay.includes(w)) return false;
	}
	return true;
}

// Dates are YYYY-MM-DD, so string order is date order. With no range, undated
// entries match too.
function inDates(q: Query, e: Entry): boolean {
	const from = q.f.date_from ?? "";
	const to = q.f.date_to ?? "";
	if (from === "" && to === "") return true;
	if (e.date === null) return false;
	return (from === "" || e.date >= from) && (to === "" || e.date <= to);
}

function hasAll(have: readonly string[], want: readonly string[]): boolean {
	for (const w of want) {
		if (!have.includes(w)) return false;
	}
	return true;
}

// Go's haystack: lowercased title, notes, vendor, category, source, kind, tags
// and then the room, joined with "\n". A word match is a plain substring test.
function haystack(e: Entry): string {
	const parts = [e.title, e.notes, e.vendor, e.category, e.source, e.kind, e.tags.join(" ")];
	if (e.room !== null) parts.push(e.room);
	return parts.join("\n").toLowerCase();
}

/**
 * Runs f over the document. It never errors: bad values simply match nothing.
 * Total counts every match; entries holds the first limit of them, clones
 * sorted by updated descending.
 */
export function searchEntries(doc: Doc, f: Filter): SearchResult {
	const q = newQuery(f);
	let limit = f.limit ?? 0;
	if (limit <= 0) limit = DEFAULT_LIMIT;
	limit = Math.min(limit, MAX_LIMIT);
	const hits = doc.entries.filter((e) => matches(q, e));
	// Array.prototype.sort is stable (ES2019), so equal updated values keep
	// document order, as sort.SliceStable does in Go.
	hits.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
	return { entries: hits.slice(0, limit).map(cloneEntry), total: hits.length };
}

function isArgs(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function filterText(k: string, v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new ValidationError(`${k} must be a string`);
	return v;
}

function filterBool(k: string, v: unknown): boolean | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "boolean") throw new ValidationError(`${k} must be true or false`);
	return v;
}

function filterStrings(k: string, v: unknown): string[] | undefined {
	if (v === undefined || v === null) return undefined;
	if (!Array.isArray(v)) throw new ValidationError(`${k} must be a list of strings`);
	const out: string[] = [];
	for (const item of v) {
		if (typeof item !== "string") throw new ValidationError(`${k} must be a list of strings`);
		out.push(item);
	}
	return out;
}

/**
 * decodeFilter reads the agent tool's arguments: Go unmarshals the same JSON
 * into Filter, so a value of the wrong type is an error and a null is a
 * missing field. Unknown keys are ignored, as Go does.
 *
 * Go's message here is a raw encoding/json error that the agent wraps, so the
 * wording is ours: a model reads it, so each says which field is wrong and what
 * it wants ("limit must be a whole number"), matching the model's own patch
 * messages. Keys are matched exactly; Go would also accept a different case,
 * which the tool schema never sends.
 */
export function decodeFilter(args: unknown): Filter {
	if (!isArgs(args)) throw new ValidationError("search arguments must be an object");
	return {
		kinds: filterStrings("kinds", args.kinds),
		rooms: filterStrings("rooms", args.rooms),
		statuses: filterStrings("statuses", args.statuses),
		category: filterText("category", args.category),
		tags: filterStrings("tags", args.tags),
		vendor: filterText("vendor", args.vendor),
		text: filterText("text", args.text),
		date_from: filterText("date_from", args.date_from),
		date_to: filterText("date_to", args.date_to),
		include_archived: filterBool("include_archived", args.include_archived),
		milestone: filterBool("milestone", args.milestone),
		limit: filterLimit(args.limit),
	};
}

function filterLimit(v: unknown): number | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "number" || !Number.isInteger(v)) throw new ValidationError("limit must be a whole number");
	return v;
}
