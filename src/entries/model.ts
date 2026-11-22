import { ValidationError } from "../errors.ts";
import { goMarshal } from "../gojson.ts";
import { goFields, goTrimSpace } from "../gostr.ts";
import { validDate } from "../sched.ts";

// The entries model: the shape of entries.json and the field rules every
// change must pass. Port of internal/entries/model.go; where this file and the
// Go source disagree, the Go source wins.
//
// Plain functions and plain data, no classes except ValidationError. Callers
// apply a patch to a clone, exactly as in Go, because a rejected patch leaves
// the entry half-written.

export const SCHEMA_VERSION = 1;
export const STATUS_DONE = "done";
export const KIND_TASK = "task";
export const KIND_NOTE = "note";

/** The key dates of the move; null when unset. */
export interface Meta {
	moveDate: string | null;
	keyDate: string | null;
}

/** Cost in SGD: the quote or expected price, and what has been paid so far. */
export interface Cost {
	estimate: number | null;
	actual: number | null;
}

export interface Entry {
	id: string;
	kind: string;
	title: string;
	room: string | null;
	category: string;
	status: string;
	cost: Cost;
	vendor: string;
	date: string | null;
	time: string | null;
	source: string;
	notes: string;
	tags: string[];
	archived: boolean;
	/** Marks a notable entry; it counts as a milestone once done. */
	milestone: boolean;
	/** The day (YYYY-MM-DD, in the app's time zone) the entry moved to done; null when not done. */
	completed: string | null;
	by: string;
	channel: string;
	created: string;
	updated: string;
}

/** One journal record: enough to show what happened and to undo it. */
export interface Change {
	id: string;
	at: string;
	by: string;
	channel: string;
	op: string; // create | update | delete | undo
	entryId: string;
	/** null for a create. */
	before: Entry | null;
	/** null for a delete. */
	after: Entry | null;
}

/** The whole stored document, one JSON object in S3. */
export interface Doc {
	schema: number;
	meta: Meta;
	entries: Entry[];
	changes: Change[];
}

export const KINDS: readonly string[] = ["idea", "decision", "task", "note", "question"];

// Rooms come from the Type C5 unit layout plan. Room is optional: an entry with
// no clear room leaves it empty.
export const ROOMS: readonly string[] = [
	"living",
	"dining",
	"dry kitchen",
	"wet kitchen",
	"flex",
	"master bedroom",
	"bedroom 2",
	"bedroom 3",
	"master bathroom",
	"bathroom 2",
	"balcony",
	"whole-house",
];

// TASK_STATUSES apply to kind=task; PLAN_STATUSES to every other kind. The two
// lists line up column by column on the kanban, except that tasks have no
// "decided" stage. Both are non-empty, so statusesFor(kind)[0] is a status.
export const TASK_STATUSES = ["todo", "doing", "done"] as const;
export const PLAN_STATUSES = ["idea", "shortlisted", "decided", "done"] as const;
export const CHANNELS: readonly string[] = ["web", "telegram", "system"];

/** A status list with at least one element, so [0] is always a status. */
type Statuses = readonly [string, ...string[]];

// strings.ToLower, used below through JS toLowerCase(). Two known differences
// this port does not correct: U+0130 lowercases to "i" + U+0307 in JS but to
// "i" in Go, and a final Σ lowercases to "ς" in JS but to "σ" in Go.

/** The statuses valid for a kind. */
export function statusesFor(kind: string): Statuses {
	return kind === KIND_TASK ? TASK_STATUSES : PLAN_STATUSES;
}

/** The starting status for a new entry of that kind. */
export function defaultStatus(kind: string): string {
	return statusesFor(kind)[0];
}

// remapStatus carries a status across a kind change, keeping the entry in the
// same kanban column where one exists.
function remapStatus(status: string, toKind: string): string {
	if (statusesFor(toKind).includes(status)) return status;
	if (toKind === KIND_TASK) {
		if (status === "shortlisted") return "doing";
		if (status === "done") return STATUS_DONE;
		return "todo"; // idea, decided: there is still work to do
	}
	if (status === "doing") return "shortlisted";
	if (status === STATUS_DONE) return STATUS_DONE;
	return "idea";
}

const timeRe = /^\d{2}:\d{2}$/;

export function validTime(s: string): boolean {
	if (!timeRe.test(s)) return false;
	return Number(s.slice(0, 2)) <= 23 && Number(s.slice(3, 5)) <= 59;
}

/** Lowercases and trims a room name, returning null when it is not one of ROOMS. */
export function normRoom(s: string): string | null {
	const room = goFields(s).join(" ").toLowerCase();
	return ROOMS.includes(room) ? room : null;
}

function kindOrNote(kind: string): string {
	return kind === "" ? KIND_NOTE : kind;
}

function runeCount(s: string): number {
	return [...s].length;
}

function maxLen(k: string, s: string, n: number): void {
	if (runeCount(s) > n) throw new ValidationError(`${k} must be at most ${n} characters`);
}

// normTags lowercases, collapses inner spaces, drops empties and duplicates
// (first wins, order kept) and enforces the per-tag and total limits.
export function normTags(tags: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of tags) {
		const tag = goFields(raw).join(" ").toLowerCase();
		if (tag === "" || out.includes(tag)) continue;
		maxLen("each tag", tag, 40);
		out.push(tag);
	}
	if (out.length > 20) throw new ValidationError("at most 20 tags");
	return out;
}

function zeroEntry(): Entry {
	return {
		id: "",
		kind: "",
		title: "",
		room: null,
		category: "",
		status: "",
		cost: { estimate: null, actual: null },
		vendor: "",
		date: null,
		time: null,
		source: "",
		notes: "",
		tags: [],
		archived: false,
		milestone: false,
		completed: null,
		by: "",
		channel: "",
		created: "",
		updated: "",
	};
}

/** An entry with defaults for its kind, before a patch is applied. An empty kind means note. */
export function newEntry(kind: string): Entry {
	const k = kind === "" ? KIND_NOTE : kind;
	return { ...zeroEntry(), kind: k, status: defaultStatus(k) };
}

/** Whether the entry is flagged and done. */
export function isMilestone(e: Entry): boolean {
	return e.milestone && e.status === STATUS_DONE;
}

/** A deep copy of an entry; its tags are always an array, never shared. */
export function cloneEntry(e: Entry): Entry {
	return { ...e, cost: { ...e.cost }, tags: [...e.tags] };
}

/** A deep copy of the document, journal included. */
export function cloneDoc(d: Doc): Doc {
	return {
		schema: d.schema,
		meta: { ...d.meta },
		entries: d.entries.map(cloneEntry),
		changes: d.changes.map((c) => ({
			...c,
			before: c.before === null ? null : cloneEntry(c.before),
			after: c.after === null ? null : cloneEntry(c.after),
		})),
	};
}

/** A copy of the entry with that id, or null. */
export function findEntry(d: Doc, id: string): Entry | null {
	for (const e of d.entries) {
		if (e.id === id) return cloneEntry(e);
	}
	return null;
}

export function emptyDoc(): Doc {
	return { schema: SCHEMA_VERSION, meta: { moveDate: null, keyDate: null }, entries: [], changes: [] };
}

/**
 * encodeDocView is Go's View as the wire spells it: schema, meta, entries, with
 * the entries in Go's struct order and its omitempty fields left out. Without
 * the second part a milestone:false or completed:null would go out, which Go
 * never writes.
 */
export function encodeDocView(d: Doc): Record<string, unknown> {
	return {
		schema: d.schema,
		meta: { moveDate: d.meta.moveDate, keyDate: d.meta.keyDate },
		entries: d.entries.map(encodeEntry),
	};
}

// A set of field changes: values are already-parsed JSON, as the HTTP body or
// the tool args give them. A key that is present with null clears a nullable
// field; an absent key leaves the field alone.
export type Patch = Readonly<Record<string, unknown>>;

// The text limits, keyed by field so a missing or misspelled limit is a compile
// error rather than a silent 0.
const TEXT_LIMITS = { vendor: 200, source: 500, notes: 4000, category: 40 } as const;
type TextField = keyof typeof TEXT_LIMITS;

// The patchable fields besides kind, which is applied first. One table serves the
// unknown-field check and the dispatch, as in model.go.
type Setter = (e: Entry, p: Patch, v: unknown) => void;

const SETTERS: Readonly<Record<string, Setter>> = {
	title: (e, _p, v) => {
		setTitle(e, v);
	},
	vendor: (e, _p, v) => {
		setText(e, "vendor", v);
	},
	source: (e, _p, v) => {
		setText(e, "source", v);
	},
	notes: (e, _p, v) => {
		setText(e, "notes", v);
	},
	category: (e, _p, v) => {
		setText(e, "category", v);
	},
	room: (e, _p, v) => {
		setRoom(e, v);
	},
	status: (e, _p, v) => {
		setStatus(e, v);
	},
	date: (e, p, v) => {
		setDateTime(p, e, "date", v);
	},
	time: (e, p, v) => {
		setDateTime(p, e, "time", v);
	},
	cost: (e, _p, v) => {
		setCost(e, v);
	},
	tags: (e, _p, v) => {
		setTags(e, v);
	},
	archived: (e, _p, v) => {
		setBool(e, "archived", v);
	},
	milestone: (e, _p, v) => {
		setBool(e, "milestone", v);
	},
	completed: (e, _p, v) => {
		setCompleted(e, v);
	},
};

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && !isNumberLiteral(v);
}

// str reads a string field; null reads as "".
function str(k: string, v: unknown): string {
	if (v === null) return "";
	if (typeof v !== "string") throw new ValidationError(`${k} must be a string`);
	return v;
}

/**
 * applyPatch validates every field in p and writes it onto e. Kind is applied
 * first so a status in the same patch is checked against the new kind; a kind
 * change without a status remaps the old one. Go iterates the remaining keys in
 * random map order so its outcome for several bad fields is random too; this
 * port uses the patch's own key order. On error e is left half-written, so
 * callers apply to a copy.
 */
export function applyPatch(e: Entry, p: Patch): void {
	const keys = Object.keys(p);
	for (const k of keys) {
		if (k !== "kind") setterFor(k);
	}
	if (Object.hasOwn(p, "kind")) applyKind(e, p);
	for (const k of keys) {
		if (k === "kind") continue;
		setterFor(k)(e, p, p[k]);
	}
	if (e.time !== null && e.date === null) throw new ValidationError("time needs a date");
}

// setterFor is the only way to reach a setter, so an unknown key cannot slip
// through: applyPatch calls it for every key before it applies anything.
function setterFor(k: string): Setter {
	const set = Object.hasOwn(SETTERS, k) ? SETTERS[k] : undefined;
	if (set === undefined) throw new ValidationError(`unknown field ${JSON.stringify(k)}`);
	return set;
}

function applyKind(e: Entry, p: Patch): void {
	const kind = goTrimSpace(str("kind", p.kind)).toLowerCase();
	if (!KINDS.includes(kind)) throw new ValidationError(`kind must be one of ${KINDS.join(", ")}`);
	if (e.kind !== kind) {
		e.kind = kind;
		if (!Object.hasOwn(p, "status")) e.status = remapStatus(e.status, kind);
	}
}

function setTitle(e: Entry, v: unknown): void {
	const title = goTrimSpace(str("title", v));
	const n = runeCount(title);
	if (n < 1 || n > 200) throw new ValidationError("title must be 1\u2013200 characters");
	e.title = title;
}

function setText(e: Entry, k: TextField, v: unknown): void {
	const s = goTrimSpace(str(k, v));
	maxLen(k, s, TEXT_LIMITS[k]);
	switch (k) {
		case "vendor":
			e.vendor = s;
			return;
		case "source":
			e.source = s;
			return;
		case "notes":
			e.notes = s;
			return;
		case "category":
			// Only category is lowercased, after the trim.
			e.category = s.toLowerCase();
	}
}

function setRoom(e: Entry, v: unknown): void {
	const s = str("room", v);
	if (goTrimSpace(s) === "") {
		e.room = null;
		return;
	}
	const room = normRoom(s);
	if (room === null) throw new ValidationError(`room must be one of ${ROOMS.join(", ")}, or empty`);
	e.room = room;
}

function setStatus(e: Entry, v: unknown): void {
	const s = goTrimSpace(str("status", v)).toLowerCase();
	if (!statusesFor(e.kind).includes(s)) {
		throw new ValidationError(`status for a ${kindOrNote(e.kind)} must be one of ${statusesFor(e.kind).join(", ")}`);
	}
	e.status = s;
}

// setDateTime sets date or time. An empty string clears the field, same as null;
// date and time inputs in the browser send "" when blank.
function setDateTime(p: Patch, e: Entry, k: string, v: unknown): void {
	const s = str(k, v);
	let value: string | null = null;
	if (s !== "") {
		if (k === "date" && !validDate(s)) throw new ValidationError("date must be YYYY-MM-DD");
		if (k === "time" && !validTime(s)) throw new ValidationError("time must be HH:MM (24h)");
		value = s;
	}
	if (k === "time") {
		e.time = value;
		return;
	}
	e.date = value;
	// Clearing the date clears its time too, unless the same patch sets a time
	// (then applyPatch refuses the time without a date).
	if (value === null && !Object.hasOwn(p, "time")) e.time = null;
}

function setCost(e: Entry, v: unknown): void {
	if (v === null) {
		e.cost = { estimate: null, actual: null };
		return;
	}
	if (!isObject(v)) throw new ValidationError("cost must be an object with estimate and/or actual");
	for (const k of Object.keys(v)) {
		if (k !== "estimate" && k !== "actual") throw new ValidationError(`unknown cost field ${JSON.stringify(k)}`);
		const raw = v[k];
		let cost: number | null = null;
		if (raw !== null) {
			if (typeof raw !== "number") throw new ValidationError(`cost.${k} must be a number or null`);
			// JSON.parse reads 1e400 as Infinity: a number JS has, JSON cannot
			// write and Go cannot decode, so it is not an amount.
			if (!Number.isFinite(raw)) throw new ValidationError(`cost.${k} must be a number or null`);
			if (raw < 0) throw new ValidationError(`cost.${k} must be 0 or more`);
			cost = raw;
		}
		if (k === "estimate") e.cost.estimate = cost;
		else e.cost.actual = cost;
	}
}

function setTags(e: Entry, v: unknown): void {
	const tags: string[] = [];
	if (v !== null) {
		if (!Array.isArray(v)) throw new ValidationError("tags must be a list of strings");
		for (const tag of v) {
			// Go reads a null element of a []string as "", which normTags drops.
			if (tag !== null && typeof tag !== "string") throw new ValidationError("tags must be a list of strings");
			tags.push(typeof tag === "string" ? tag : "");
		}
	}
	e.tags = normTags(tags);
}

function setBool(e: Entry, k: string, v: unknown): void {
	if (typeof v !== "boolean") throw new ValidationError(`${k} must be true or false`);
	if (k === "archived") e.archived = v;
	else e.milestone = v;
}

function setCompleted(e: Entry, v: unknown): void {
	const s = str("completed", v);
	if (s !== "" && !validDate(s)) throw new ValidationError("completed must be YYYY-MM-DD");
	e.completed = s === "" ? null : s;
}

/**
 * settleCompleted keeps completed in step with the status after p was applied to
 * e (before is the entry as it was; null for a new one): moving to done stamps
 * today unless p sets a day itself; clearing the day of a done entry keeps the
 * day it had; leaving done clears it; a day on an entry that isn't done is
 * refused.
 */
export function settleCompleted(before: Entry | null, e: Entry, p: Patch, today: string): void {
	const explicit = Object.hasOwn(p, "completed");
	if (e.status !== STATUS_DONE) {
		if (explicit && e.completed !== null) throw new ValidationError("completed needs status done");
		e.completed = null;
		return;
	}
	const wasDone = before !== null && before.status === STATUS_DONE;
	if (!wasDone && (!explicit || e.completed === null)) {
		e.completed = today;
		return;
	}
	if (explicit && e.completed === null && before !== null) {
		// A done entry keeps the day it had.
		e.completed = before.completed;
	}
}

/** Changes the key dates; a key present with null or "" clears one. */
export interface MetaPatch {
	moveDate?: string | null;
	keyDate?: string | null;
}

export function applyMetaPatch(m: Meta, mp: MetaPatch): void {
	if (Object.hasOwn(mp, "moveDate")) m.moveDate = metaDate(mp.moveDate, "moveDate");
	if (Object.hasOwn(mp, "keyDate")) m.keyDate = metaDate(mp.keyDate, "keyDate");
}

function metaDate(v: string | null | undefined, name: string): string | null {
	if (v === null || v === undefined || v === "") return null;
	if (!validDate(v)) throw new ValidationError(`${name} must be YYYY-MM-DD`);
	return v;
}

// Decoding follows Go's json.Unmarshal closely enough to be compatible: a
// missing or null field gets the Go zero value, unknown keys are dropped, and a
// field with the wrong JSON type fails the whole decode. The messages copy
// Go's, including the field path; the JSON parser's own wording (after the
// `decode entries.json: ` prefix) is V8's, not Go's.
//
// encoding/json walks an object's keys in the order the document writes them,
// matching each key to a field by exact name first and then case-insensitively,
// so a later key overwrites an earlier one and the first type error in the
// document wins. The walk below does the same. Object.keys keeps that order for
// these names; only array-index names would be reordered, and no field is one.
// JS toLowerCase is not Go's fold: Go also matches "ſ" to "s" and "K" to
// "k". One difference cannot be copied without writing a JSON parser of our
// own: Go merges two keys that both name a struct field, so
// {"cost":{"estimate":1},"cost":{"actual":2}} sets both parts, while
// JSON.parse keeps only the last.

// A number with the literal text the document used, kept by keepLiteral.
const LITERAL = Symbol("json.number");

interface NumberLiteral {
	readonly [LITERAL]: true;
	readonly literal: string;
	readonly value: number;
}

function isNumberLiteral(v: unknown): v is NumberLiteral {
	return typeof v === "object" && v !== null && LITERAL in v;
}

// JSON.parse's third reviver argument is the "source text access" feature. The
// lib here (typescript 7.0.2, node_modules/@typescript/typescript-linux-arm64/
// lib/lib.es5.d.ts:1161) still declares the two-argument reviver, and @types/node
// does not override it, so the shape is typed here; an optional third parameter
// is assignable to that signature. Node has it since v22.4. It hands back the
// literal of a primitive, which is what Go quotes when a number does not fit.
interface ParseContext {
	readonly source?: string;
}

function keepLiteral(_key: string, value: unknown, context?: ParseContext): unknown {
	if (typeof value === "number" && context?.source !== undefined) {
		return { [LITERAL]: true, literal: context.source, value };
	}
	return value;
}

// matchField maps a document key to a field name the way encoding/json does:
// exact first, then case-insensitive.
function matchField<K extends string>(fields: readonly K[], key: string): K | null {
	const exact = fields.find((f) => f === key);
	if (exact !== undefined) return exact;
	const lower = key.toLowerCase();
	const folded = fields.find((f) => f.toLowerCase() === lower);
	return folded ?? null;
}

function goJsonKind(v: unknown): string {
	if (Array.isArray(v)) return "array";
	if (isNumberLiteral(v)) return "number";
	switch (typeof v) {
		case "string":
			return "string";
		case "number":
			return "number";
		case "boolean":
			return "bool";
		case "object":
			return v === null ? "null" : "object";
		default:
			return typeof v;
	}
}

function decodeError(message: string, options?: ErrorOptions): Error {
	return new Error(`decode entries.json: ${message}`, options);
}

function fieldError(v: unknown, path: string, goType: string): Error {
	return decodeError(`json: cannot unmarshal ${goJsonKind(v)} into Go struct field ${path} of type ${goType}`);
}

function numberError(literal: string, path: string, goType: string): Error {
	return decodeError(`json: cannot unmarshal number ${literal} into Go struct field ${path} of type ${goType}`);
}

// Slice elements of a non-struct type get no "struct field" in Go's message.
function valueError(v: unknown, path: string, goType: string): Error {
	return decodeError(`json: cannot unmarshal ${goJsonKind(v)} into ${path} of type ${goType}`);
}

function decodeString(v: unknown, path: string): string {
	if (v === undefined || v === null) return "";
	if (typeof v !== "string") throw fieldError(v, path, "string");
	return v;
}

function decodeStringOrNull(v: unknown, path: string): string | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== "string") throw fieldError(v, path, "string");
	return v;
}

function decodeBool(v: unknown, path: string): boolean {
	if (v === undefined || v === null) return false;
	if (typeof v !== "boolean") throw fieldError(v, path, "bool");
	return v;
}

// Go reads 1e400 as an error, because strconv.ParseFloat overflows; JSON.parse
// reads it as Infinity.
function decodeNumberOrNull(v: unknown, path: string): number | null {
	if (v === undefined || v === null) return null;
	if (typeof v === "number") return v;
	if (!isNumberLiteral(v)) throw fieldError(v, path, "float64");
	if (!Number.isFinite(v.value)) throw numberError(v.literal, path, "float64");
	return v.value;
}

// Go parses the literal with strconv.ParseInt, so 1.0 and 1e0 are not ints, and
// it refuses a value outside int64; both errors quote the literal.
const INT_LITERAL = /^-?\d+$/;
const INT64_MAX = 9223372036854775807n;
const INT64_MIN = -9223372036854775808n;

function decodeInt(v: unknown, path: string): number {
	if (v === undefined || v === null) return 0;
	if (!isNumberLiteral(v)) throw fieldError(v, path, "int");
	const literal = v.literal;
	if (!INT_LITERAL.test(literal) || !fitsInt64(literal)) throw numberError(literal, path, "int");
	return v.value;
}

// A value above 2^53 loses precision here where Go would keep it. Only schema
// uses this, and no version number that large is meaningful.
function fitsInt64(literal: string): boolean {
	const n = BigInt(literal);
	return n >= INT64_MIN && n <= INT64_MAX;
}

const META_FIELDS: readonly (keyof Meta)[] = ["moveDate", "keyDate"];

function decodeMeta(v: unknown): Meta {
	const m: Meta = { moveDate: null, keyDate: null };
	if (v === undefined || v === null) return m;
	if (!isObject(v)) throw fieldError(v, "Doc.meta", "entries.Meta");
	for (const src of Object.keys(v)) {
		const field = matchField(META_FIELDS, src);
		if (field === null) continue;
		m[field] = decodeStringOrNull(v[src], `Doc.meta.${field}`);
	}
	return m;
}

const COST_FIELDS: readonly (keyof Cost)[] = ["estimate", "actual"];

function decodeCost(v: unknown, path: string): Cost {
	const cost: Cost = { estimate: null, actual: null };
	if (v === undefined || v === null) return cost;
	if (!isObject(v)) throw fieldError(v, path, "entries.Cost");
	for (const src of Object.keys(v)) {
		const field = matchField(COST_FIELDS, src);
		if (field === null) continue;
		cost[field] = decodeNumberOrNull(v[src], `${path}.${field}`);
	}
	return cost;
}

function decodeTags(v: unknown, path: string): string[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw fieldError(v, path, "[]string");
	const out: string[] = [];
	for (let i = 0; i < v.length; i++) {
		const tag = v[i];
		// Go reads a null element of a []string as "", which normTags drops.
		if (tag === null) {
			out.push("");
			continue;
		}
		if (typeof tag !== "string") throw valueError(tag, `${path}.${i}`, "string");
		out.push(tag);
	}
	return out;
}

type EntryField =
	| "id"
	| "kind"
	| "title"
	| "room"
	| "category"
	| "status"
	| "cost"
	| "vendor"
	| "date"
	| "time"
	| "source"
	| "notes"
	| "tags"
	| "archived"
	| "milestone"
	| "completed"
	| "by"
	| "channel"
	| "created"
	| "updated";

const ENTRY_FIELDS: readonly EntryField[] = [
	"id",
	"kind",
	"title",
	"room",
	"category",
	"status",
	"cost",
	"vendor",
	"date",
	"time",
	"source",
	"notes",
	"tags",
	"archived",
	"milestone",
	"completed",
	"by",
	"channel",
	"created",
	"updated",
];

type EntryDecoder = (e: Entry, v: unknown, path: string) => void;

const ENTRY_DECODERS: Readonly<Record<EntryField, EntryDecoder>> = {
	id: (e, v, path) => {
		e.id = decodeString(v, path);
	},
	kind: (e, v, path) => {
		e.kind = decodeString(v, path);
	},
	title: (e, v, path) => {
		e.title = decodeString(v, path);
	},
	room: (e, v, path) => {
		e.room = decodeStringOrNull(v, path);
	},
	category: (e, v, path) => {
		e.category = decodeString(v, path);
	},
	status: (e, v, path) => {
		e.status = decodeString(v, path);
	},
	cost: (e, v, path) => {
		e.cost = decodeCost(v, path);
	},
	vendor: (e, v, path) => {
		e.vendor = decodeString(v, path);
	},
	date: (e, v, path) => {
		e.date = decodeStringOrNull(v, path);
	},
	time: (e, v, path) => {
		e.time = decodeStringOrNull(v, path);
	},
	source: (e, v, path) => {
		e.source = decodeString(v, path);
	},
	notes: (e, v, path) => {
		e.notes = decodeString(v, path);
	},
	tags: (e, v, path) => {
		e.tags = decodeTags(v, path);
	},
	archived: (e, v, path) => {
		e.archived = decodeBool(v, path);
	},
	milestone: (e, v, path) => {
		e.milestone = decodeBool(v, path);
	},
	completed: (e, v, path) => {
		e.completed = decodeStringOrNull(v, path);
	},
	by: (e, v, path) => {
		e.by = decodeString(v, path);
	},
	channel: (e, v, path) => {
		e.channel = decodeString(v, path);
	},
	created: (e, v, path) => {
		e.created = decodeString(v, path);
	},
	updated: (e, v, path) => {
		e.updated = decodeString(v, path);
	},
};

function decodeEntry(v: unknown, path: string): Entry {
	if (v === null) return zeroEntry();
	if (!isObject(v)) throw valueError(v, path, "entries.Entry");
	const e = zeroEntry();
	for (const src of Object.keys(v)) {
		const field = matchField(ENTRY_FIELDS, src);
		if (field === null) continue;
		ENTRY_DECODERS[field](e, v[src], `${path}.${field}`);
	}
	return e;
}

function decodeEntryOrNull(v: unknown, path: string): Entry | null {
	if (v === undefined || v === null) return null;
	if (!isObject(v)) throw fieldError(v, path, "entries.Entry");
	return decodeEntry(v, path);
}

type ChangeField = "id" | "at" | "by" | "channel" | "op" | "entryId" | "before" | "after";

const CHANGE_FIELDS: readonly ChangeField[] = ["id", "at", "by", "channel", "op", "entryId", "before", "after"];

type ChangeDecoder = (c: Change, v: unknown, path: string) => void;

const CHANGE_DECODERS: Readonly<Record<ChangeField, ChangeDecoder>> = {
	id: (c, v, path) => {
		c.id = decodeString(v, path);
	},
	at: (c, v, path) => {
		c.at = decodeString(v, path);
	},
	by: (c, v, path) => {
		c.by = decodeString(v, path);
	},
	channel: (c, v, path) => {
		c.channel = decodeString(v, path);
	},
	op: (c, v, path) => {
		c.op = decodeString(v, path);
	},
	entryId: (c, v, path) => {
		c.entryId = decodeString(v, path);
	},
	before: (c, v, path) => {
		c.before = decodeEntryOrNull(v, path);
	},
	after: (c, v, path) => {
		c.after = decodeEntryOrNull(v, path);
	},
};

function decodeChange(v: unknown, path: string): Change {
	if (v === null) return zeroChange();
	if (!isObject(v)) throw valueError(v, path, "entries.Change");
	const c = zeroChange();
	for (const src of Object.keys(v)) {
		const field = matchField(CHANGE_FIELDS, src);
		if (field === null) continue;
		CHANGE_DECODERS[field](c, v[src], `${path}.${field}`);
	}
	return c;
}

function decodeEntries(v: unknown): Entry[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw fieldError(v, "Doc.entries", "[]entries.Entry");
	return v.map((item, i) => decodeEntry(item, `Doc.entries.${i}`));
}

function decodeChanges(v: unknown): Change[] {
	if (v === undefined || v === null) return [];
	if (!Array.isArray(v)) throw fieldError(v, "Doc.changes", "[]entries.Change");
	return v.map((item, i) => decodeChange(item, `Doc.changes.${i}`));
}

// normalise fixes fields written by older or hand-edited files, in the order
// model.go uses. Title, id, cost signs and created/updated are not validated.
function normalise(e: Entry): void {
	if (!KINDS.includes(e.kind)) e.kind = KIND_NOTE;
	if (!statusesFor(e.kind).includes(e.status)) e.status = remapStatus(e.status, e.kind);
	if (e.room !== null) e.room = normRoom(e.room);
	if (e.date !== null && !validDate(e.date)) e.date = null;
	if (e.time !== null && (e.date === null || !validTime(e.time))) e.time = null;
	if (e.completed !== null && (e.status !== STATUS_DONE || !validDate(e.completed))) e.completed = null;
	try {
		e.tags = normTags(e.tags);
	} catch {
		// Too many tags (or one too long) wipes them all, as in Go.
		e.tags = [];
	}
	if (!CHANNELS.includes(e.channel)) e.channel = "web";
}

type DocField = "schema" | "meta" | "entries" | "changes";

const DOC_FIELDS: readonly DocField[] = ["schema", "meta", "entries", "changes"];

type DocDecoder = (d: Doc, v: unknown) => void;

const DOC_DECODERS: Readonly<Record<DocField, DocDecoder>> = {
	schema: (d, v) => {
		d.schema = decodeInt(v, "Doc.schema");
	},
	meta: (d, v) => {
		d.meta = decodeMeta(v);
	},
	entries: (d, v) => {
		d.entries = decodeEntries(v);
	},
	changes: (d, v) => {
		d.changes = decodeChanges(v);
	},
};

/**
 * decodeDoc parses a stored document and normalises its entries, so the rest of
 * the app can trust it. Invalid JSON, a number that does not fit, and wrong
 * field types throw Error with the `decode entries.json: ` prefix, as Go's
 * Decode does; it never throws ValidationError.
 */
export function decodeDoc(text: string): Doc {
	let raw: unknown;
	try {
		raw = JSON.parse(text, keepLiteral);
	} catch (err) {
		throw decodeError(err instanceof Error ? err.message : String(err), { cause: err });
	}
	if (raw === null) return emptyDoc();
	if (!isObject(raw)) {
		throw decodeError(`json: cannot unmarshal ${goJsonKind(raw)} into Go value of type entries.Doc`);
	}
	const doc: Doc = emptyDoc();
	for (const src of Object.keys(raw)) {
		const field = matchField(DOC_FIELDS, src);
		if (field === null) continue;
		DOC_DECODERS[field](doc, raw[src]);
	}
	if (doc.schema === 0) doc.schema = SCHEMA_VERSION;
	for (const e of doc.entries) normalise(e);
	return doc;
}

function zeroChange(): Change {
	return { id: "", at: "", by: "", channel: "", op: "", entryId: "", before: null, after: null };
}

// encodeEntry builds the object field by field in Go's struct order, never from
// the input object's keys, so the bytes match the Go app. milestone and
// completed are omitempty: omitted when false/null, and placed between archived
// and by. It is exported for the journal's sameEntry comparison, which is byte
// equality in Go.
//
// The journal's before/after entries use it too, with one known difference: Go
// keeps a nil Tags slice on a journal entry and writes "tags":null, while
// Entry.tags is always an array here, so we write []. Go's normTags treats nil
// and [] alike, so either app reads the other's file unchanged.
export function encodeEntry(e: Entry): Record<string, unknown> {
	return {
		id: e.id,
		kind: e.kind,
		title: e.title,
		room: e.room,
		category: e.category,
		status: e.status,
		cost: { estimate: e.cost.estimate, actual: e.cost.actual },
		vendor: e.vendor,
		date: e.date,
		time: e.time,
		source: e.source,
		notes: e.notes,
		tags: e.tags,
		archived: e.archived,
		...(e.milestone ? { milestone: true } : {}),
		...(e.completed === null ? {} : { completed: e.completed }),
		by: e.by,
		channel: e.channel,
		created: e.created,
		updated: e.updated,
	};
}

// Change keeps before/after even when null: no omitempty on either side.
function encodeChange(c: Change): Record<string, unknown> {
	return {
		id: c.id,
		at: c.at,
		by: c.by,
		channel: c.channel,
		op: c.op,
		entryId: c.entryId,
		before: c.before === null ? null : encodeEntry(c.before),
		after: c.after === null ? null : encodeEntry(c.after),
	};
}

/** encodeDoc is the exact bytes the Go app would write for the same document. */
export function encodeDoc(doc: Doc): string {
	return goMarshal({
		schema: doc.schema,
		meta: { moveDate: doc.meta.moveDate, keyDate: doc.meta.keyDate },
		entries: doc.entries.map(encodeEntry),
		changes: doc.changes.map(encodeChange),
	});
}
