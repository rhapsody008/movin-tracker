// The documents index and the per-page text: docs/index.json and
// docs/text/<path>.json. Port of internal/docs/index.go (docs-spec §1); where
// this file and the Go source disagree, the Go source wins.
//
// The bytes matter: the Go app is still live and reads, writes and merges the
// same two keys, so the field order (Go's struct order), the omitempty rules
// and Go's HTML escaping are all part of the format. The index is indented by
// two spaces with no trailing newline, the text blobs are compact.
//
// Go's zero values are used here instead of `undefined`: a Doc is always
// complete after a decode, and the writers leave a field out when it holds
// Go's zero value (which is what omitempty does).

import { createHash } from "node:crypto";
import { goMarshal, goMarshalIndent, Ordered } from "../gojson.ts";
import { compareBytes } from "../gostr.ts";
import type { Page, Word } from "./types.ts";

// Key layout in the bucket (no prefix: dev and production share it).
export const RAW_PREFIX = "docs/raw/";
export const TEXT_PREFIX = "docs/text/";
export const INDEX_KEY = "docs/index.json";
export const SCHEMA = 1;

// Classes of document.
export const CLASS_TEXT = "text"; // a text layer on most pages: searchable
export const CLASS_DRAWING = "drawing"; // A3 or larger pages: also viewable as images
export const CLASS_SCANNED = "scanned"; // mostly pages without text: a later phase

// Statuses of a document in the index.
export const STATUS_OK = "ok";
export const STATUS_FAILED = "failed"; // conversion failed; retried next sync
export const STATUS_REMOVED = "removed"; // the raw file is gone; kept so links explain themselves
export const STATUS_SKIPPED = "skipped"; // not a document we read (reason says why)

/**
 * ConvertVersion goes up when how documents are read or classified changes;
 * documents read with an older version are read again at the next sync
 * ("refreshed", which is not announced).
 */
export const CONVERT_VERSION = 3; // 3: garbled text layers count as no text

/** How many non-space characters a page needs to count as having text. */
export const MIN_TEXT_CHARS = 100;

/**
 * MaxPDFBytes caps the PDFs the app reads into memory (to convert or to view).
 * Go has it in render.go, which needs the same number for the viewer (T1.5c).
 */
export const MAX_PDF_BYTES = 32 << 20;

const A3_AREA = 842 * 1191;
const MB = 1 << 20;

/** docs/index.json. */
export interface Index {
	schema: number;
	docs: Doc[];
	/** null when the index has never been written by a sync. */
	lastSync: Sync | null;
	updated: string;
}

/** One file under docs/raw/. */
export interface Doc {
	/** Short and stable: what tools refer to. */
	id: string;
	/** Full bucket key: the identity. */
	key: string;
	/** The raw PDF's ETag, verbatim as S3 returns it (quoted). */
	etag: string;
	size: number;
	pages: number;
	class: string;
	status: string;
	/** Why skipped or failed. */
	reason: string;
	/** Pages with at least MIN_TEXT_CHARS. */
	textPages: number;
	/** One line, from the model. */
	summary: string;
	syncedAt: string;
	/** The ConvertVersion it was read with. */
	v: number;
	removedAt: string;
	/**
	 * The last failed read (cleared by the next good one); a readable document
	 * keeps its old record and status meanwhile.
	 */
	error: string;
	errorAt: string;
}

/** The outcome of one sync run, kept as lastSync. */
export interface Sync {
	at: string;
	reason: string; // startup, daily, /sync, web
	added: number;
	changed: number;
	removed: number;
	failed: number;
	skipped: number;
	/** Re-read for a new ConvertVersion. */
	refreshed: number;
	error: string;
}

/** docs/text/<path>.json: the text of each page. */
export interface PageText {
	/** The raw document. */
	key: string;
	/** Of the raw document this was made from. */
	etag: string;
	pages: Page[];
}

/** What classification needs to know about a page. */
export interface PageInfo {
	/** Points, as displayed (rotation applied). */
	w: number;
	h: number;
	/** Non-space characters of text. */
	chars: number;
}

/** A document record with Go's zero values. */
export function emptyDoc(key: string, id: string): Doc {
	return {
		id,
		key,
		etag: "",
		size: 0,
		pages: 0,
		class: "",
		status: "",
		reason: "",
		textPages: 0,
		summary: "",
		syncedAt: "",
		v: 0,
		removedAt: "",
		error: "",
		errorAt: "",
	};
}

/** Go's Decode of an empty body: schema 1 and no documents. */
export function emptyIndex(): Index {
	return { schema: SCHEMA, docs: [], lastSync: null, updated: "" };
}

/** Changes reports whether the run changed anything worth telling people. */
export function changes(s: Sync): boolean {
	return s.added + s.changed + s.removed > 0;
}

/** The file name without folders. */
export function docName(d: Doc): string {
	return baseName(d.key);
}

/** The folder path under docs/raw/ ("" at the top level). */
export function docFolder(d: Doc): string {
	const rel = trimPrefix(d.key, RAW_PREFIX);
	const cut = rel.lastIndexOf("/");
	return cut < 0 ? "" : rel.slice(0, cut);
}

/** Where the document's per-page text is stored. */
export function docTextKey(d: Doc): string {
	return textKeyFor(d.key);
}

/** Maps docs/raw/<path> to docs/text/<path>.json. */
export function textKeyFor(rawKey: string): string {
	return `${TEXT_PREFIX}${trimPrefix(rawKey, RAW_PREFIX)}.json`;
}

/**
 * SkipReason says why a key under docs/raw/ is not read, or "" if it is.
 * Go's path.Base and path.Ext work on slash-separated paths on every OS; these
 * two do the same, so a Windows-style key is still read as written.
 */
export function skipReason(key: string): string {
	if (key.endsWith("/")) return "folder marker";
	const name = baseName(key);
	if (name.startsWith("._")) return "macOS metadata file, not a document";
	const ext = extName(key);
	if (ext.toLowerCase() !== ".pdf") return `not a PDF (${ext.replace(/^\./, "").toLowerCase()})`;
	return "";
}

/**
 * Garbled reports whether a page's text layer is unusable: fonts without a
 * proper character map come out as control characters and shifted letters
 * ("Dimensions" → "'LPHQVLRQV"). Such pages count as having no text.
 */
export function garbled(text: string): boolean {
	let chars = 0;
	let ctrl = 0;
	for (const ch of text) {
		const r = ch.codePointAt(0) ?? 0;
		if (r === 0x0a || r === 0x09 || r === 0x0d || r === 0x0c || r === 0x20) continue;
		if (r < 0x20) ctrl++;
		chars++;
	}
	if (chars === 0) return false;
	if (ctrl / chars > 0.02) return true;
	let words = 0;
	let novowel = 0;
	for (const w of text.split(/[^a-zA-Z]+/)) {
		if (w.length < 3) continue;
		words++;
		if (!/[aeiouyAEIOUY]/.test(w)) novowel++;
	}
	return words >= 10 && novowel / words > 0.3;
}

/**
 * Classify decides a document's class from its pages and counts the pages with
 * text. A big sheet with some text is a drawing to look at; big pages with no
 * text at all (a scanned leaflet) are a scan.
 */
export function classify(pages: readonly PageInfo[]): { class: string; textPages: number } {
	let big = false;
	let textPages = 0;
	for (const p of pages) {
		if (p.chars >= MIN_TEXT_CHARS) textPages++;
		if (p.w * p.h >= 0.95 * A3_AREA) big = true;
	}
	if (pages.length === 0) return { class: CLASS_SCANNED, textPages: 0 };
	if (big && textPages > 0) return { class: CLASS_DRAWING, textPages };
	if (textPages * 2 < pages.length) return { class: CLASS_SCANNED, textPages };
	return { class: CLASS_TEXT, textPages };
}

/**
 * AssignID gives a key its short id: the first 8 hex digits of its SHA-256,
 * with -2, -3… on the rare collision with an id another key already has. The
 * same key always gets the same id within an index.
 */
export function assignID(key: string, taken: ReadonlyMap<string, string>): string {
	const base = createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8);
	let id = base;
	for (let n = 2; ; n++) {
		const owner = taken.get(id);
		if (owner === undefined || owner === key) return id;
		id = `${base}-${n}`;
	}
}

/** The documents keyed by their bucket key. The records are the index's own. */
export function byKey(ix: Index): Map<string, Doc> {
	return new Map(ix.docs.map((d) => [d.key, d]));
}

/** The document with this id, or null. */
export function find(ix: Index, id: string): Doc | null {
	return ix.docs.find((d) => d.id === id) ?? null;
}

/** Whether any record was read by a newer CONVERT_VERSION than this build's. */
export function newerThanThisBuild(ix: Index): boolean {
	return ix.docs.some((d) => d.v > CONVERT_VERSION);
}

/**
 * Encode writes the index with documents sorted by key, exactly as Go's
 * Index.Encode does: it sets schema and updated, sorts in place, and marshals
 * with MarshalIndent(…, "", "  ") — two spaces, Go's HTML escaping, no
 * trailing newline.
 *
 * Go takes a time.Time; this takes the run's stamp instead, so every field an
 * attempt writes carries the same instant (docs-spec §9.5).
 */
export function encodeIndex(ix: Index, at: string): string {
	ix.schema = SCHEMA;
	ix.updated = at;
	ix.docs.sort((a, b) => compareBytes(a.key, b.key));
	const entries: (readonly [string, unknown])[] = [
		["schema", ix.schema],
		["docs", ix.docs.map(encodeDocValue)],
	];
	if (ix.lastSync !== null) entries.push(["lastSync", encodeSyncValue(ix.lastSync)]);
	// omitempty, and unreachable after the line above unless `at` is "".
	if (ix.updated !== "") entries.push(["updated", ix.updated]);
	return goMarshalIndent(new Ordered(entries));
}

function encodeDocValue(d: Doc): Ordered {
	const e: (readonly [string, unknown])[] = [
		["id", d.id],
		["key", d.key],
		["etag", d.etag],
		["size", d.size],
	];
	if (d.pages !== 0) e.push(["pages", d.pages]);
	if (d.class !== "") e.push(["class", d.class]);
	e.push(["status", d.status]);
	if (d.reason !== "") e.push(["reason", d.reason]);
	if (d.textPages !== 0) e.push(["textPages", d.textPages]);
	if (d.summary !== "") e.push(["summary", d.summary]);
	if (d.syncedAt !== "") e.push(["syncedAt", d.syncedAt]);
	if (d.v !== 0) e.push(["v", d.v]);
	if (d.removedAt !== "") e.push(["removedAt", d.removedAt]);
	if (d.error !== "") e.push(["error", d.error]);
	if (d.errorAt !== "") e.push(["errorAt", d.errorAt]);
	return new Ordered(e);
}

function encodeSyncValue(s: Sync): Ordered {
	const e: (readonly [string, unknown])[] = [
		["at", s.at],
		["reason", s.reason],
		["added", s.added],
		["changed", s.changed],
		["removed", s.removed],
		["failed", s.failed],
		["skipped", s.skipped],
	];
	if (s.refreshed !== 0) e.push(["refreshed", s.refreshed]);
	if (s.error !== "") e.push(["error", s.error]);
	return new Ordered(e);
}

/**
 * Decode reads docs/index.json; an empty body is an empty index. Unknown fields
 * are dropped (they are on the next write), which is why Doc.v exists.
 */
export function decodeIndex(body: string): Index {
	const ix = emptyIndex();
	if (body === "") return ix;
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch (err) {
		throw decodeError(err instanceof Error ? err.message : String(err));
	}
	if (!isObject(raw)) {
		throw decodeError(`json: cannot unmarshal ${goJsonKind(raw)} into Go value of type docs.Index`);
	}
	for (const [name, value] of Object.entries(raw)) {
		switch (name.toLowerCase()) {
			case "schema":
				ix.schema = integer(value, "Index", "schema", "int");
				break;
			case "docs":
				ix.docs = decodeDocs(value);
				break;
			case "lastsync":
				ix.lastSync = value === null ? null : decodeSync(value);
				break;
			case "updated":
				ix.updated = str(value, "Index", "updated");
				break;
			default:
				break; // Go drops what the struct doesn't know
		}
	}
	if (ix.schema !== SCHEMA) throw new Error(`${INDEX_KEY}: schema ${ix.schema}, this build reads ${SCHEMA}`);
	return ix;
}

const DOC_STRING_FIELDS = [
	"id",
	"key",
	"etag",
	"class",
	"status",
	"reason",
	"summary",
	"syncedAt",
	"removedAt",
	"error",
	"errorAt",
] as const;

const DOC_INT_FIELDS = ["size", "pages", "textPages", "v"] as const;

const SYNC_INT_FIELDS = ["added", "changed", "removed", "failed", "skipped", "refreshed"] as const;

function decodeDocs(v: unknown): Doc[] {
	if (v === null) return [];
	if (!Array.isArray(v)) throw fieldError(v, "Index", "docs", "[]docs.Doc");
	return v.map((item, i) => decodeDoc(item, i));
}

function decodeDoc(v: unknown, i: number): Doc {
	if (!isObject(v)) throw fieldError(v, "Doc", `docs.${i}`, "docs.Doc");
	const d = emptyDoc("", "");
	for (const [name, value] of Object.entries(v)) {
		const s = matchField(DOC_STRING_FIELDS, name);
		if (s !== null) {
			d[s] = str(value, "Doc", `docs.${i}.${s}`);
			continue;
		}
		const n = matchField(DOC_INT_FIELDS, name);
		if (n !== null) d[n] = integer(value, "Doc", `docs.${i}.${n}`, n === "size" ? "int64" : "int");
	}
	return d;
}

function decodeSync(v: unknown): Sync {
	if (!isObject(v)) throw fieldError(v, "Index", "lastSync", "docs.Sync");
	const s: Sync = {
		at: "",
		reason: "",
		added: 0,
		changed: 0,
		removed: 0,
		failed: 0,
		skipped: 0,
		refreshed: 0,
		error: "",
	};
	for (const [name, value] of Object.entries(v)) {
		const field = matchField(["at", "reason", "error"] as const, name);
		if (field !== null) {
			s[field] = str(value, "Sync", `lastSync.${field}`);
			continue;
		}
		const n = matchField(SYNC_INT_FIELDS, name);
		if (n !== null) s[n] = integer(value, "Sync", `lastSync.${n}`, "int");
	}
	return s;
}

/**
 * encodePageText is the compact bytes of a text blob (Go's json.Marshal, no
 * indentation, no trailing newline). Words are omitted when a page has none,
 * as Go's omitempty does for a nil or empty slice.
 */
export function encodePageText(pt: PageText): string {
	return goMarshal({
		key: pt.key,
		etag: pt.etag,
		pages: pt.pages.map((p) => ({
			n: p.n,
			w: p.w,
			h: p.h,
			text: p.text,
			...(p.words === undefined || p.words.length === 0 ? {} : { words: p.words.map(encodeWord) }),
		})),
	});
}

function encodeWord(w: Word): Record<string, unknown> {
	return { t: w.t, b: w.b };
}

/** Decode a text blob; pageText in sync.ts adds the key to the error. */
export function decodePageText(body: string): PageText {
	let raw: unknown;
	try {
		raw = JSON.parse(body);
	} catch (err) {
		throw new Error(err instanceof Error ? err.message : String(err));
	}
	if (!isObject(raw)) throw new Error(`json: cannot unmarshal ${goJsonKind(raw)} into Go value of type docs.PageText`);
	const pt: PageText = { key: "", etag: "", pages: [] };
	for (const [name, value] of Object.entries(raw)) {
		switch (name.toLowerCase()) {
			case "key":
				pt.key = pageTextStr(value, "key");
				break;
			case "etag":
				pt.etag = pageTextStr(value, "etag");
				break;
			case "pages":
				pt.pages = value === null ? [] : decodePages(value);
				break;
			default:
				break;
		}
	}
	return pt;
}

function decodePages(v: unknown): Page[] {
	if (!Array.isArray(v)) throw new Error(`json: cannot unmarshal ${goJsonKind(v)} into Go struct field PageText.pages`);
	return v.map((item, i) => {
		if (!isObject(item)) throw new Error(`json: cannot unmarshal ${goJsonKind(item)} into Go value of type docs.Page`);
		const p: Page = { n: 0, w: 0, h: 0, text: "" };
		for (const [name, value] of Object.entries(item)) {
			switch (name.toLowerCase()) {
				case "n":
					p.n = pageTextNumber(value, `pages.${i}.n`, true);
					break;
				case "w":
					p.w = pageTextNumber(value, `pages.${i}.w`, false);
					break;
				case "h":
					p.h = pageTextNumber(value, `pages.${i}.h`, false);
					break;
				case "text":
					p.text = pageTextStr(value, `pages.${i}.text`);
					break;
				case "words":
					// Go's omitempty writes no words for a page without any.
					if (value !== null) p.words = decodeWords(value, i);
					break;
				default:
					break;
			}
		}
		return p;
	});
}

function decodeWords(v: unknown, page: number): Word[] {
	if (!Array.isArray(v))
		throw new Error(`json: cannot unmarshal ${goJsonKind(v)} into Go struct field Page.pages.words`);
	return v.map((item, i) => {
		if (!isObject(item)) throw new Error(`json: cannot unmarshal ${goJsonKind(item)} into Go value of type docs.Word`);
		const w: Word = { t: "", b: [0, 0, 0, 0] };
		for (const [name, value] of Object.entries(item)) {
			switch (name.toLowerCase()) {
				case "t":
					w.t = pageTextStr(value, `pages.${page}.words.${i}.t`);
					break;
				case "b": {
					if (!Array.isArray(value) || value.length !== 4) {
						throw new Error(
							`json: cannot unmarshal ${goJsonKind(value)} into Go struct field Word.pages.words.b of type [4]float64`,
						);
					}
					w.b = [boxNumber(value[0]), boxNumber(value[1]), boxNumber(value[2]), boxNumber(value[3])];
					break;
				}
				default:
					break;
			}
		}
		return w;
	});
}

function boxNumber(v: unknown): number {
	if (typeof v !== "number" || !Number.isFinite(v))
		throw new Error(`json: cannot unmarshal ${goJsonKind(v)} into a word box`);
	return v;
}

function pageTextStr(v: unknown, path: string): string {
	if (typeof v !== "string")
		throw new Error(`json: cannot unmarshal ${goJsonKind(v)} into Go struct field PageText.${path}`);
	return v;
}

function pageTextNumber(v: unknown, path: string, integral: boolean): number {
	const ok = typeof v === "number" && Number.isFinite(v) && (!integral || Number.isInteger(v));
	if (!ok) throw new Error(`json: cannot unmarshal ${goJsonKind(v)} into Go struct field Page.${path}`);
	return v;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Go's encoding/json field match: an exact key wins, else a case-insensitive
 * one ("ID" and "id" both set id).
 */
function matchField<K extends string>(fields: readonly K[], key: string): K | null {
	for (const f of fields) if (f === key) return f;
	const lower = key.toLowerCase();
	for (const f of fields) if (f.toLowerCase() === lower) return f;
	return null;
}

/** Go's wording for a value that does not fit the field. */
function goJsonKind(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	switch (typeof v) {
		case "string":
			return "string";
		case "boolean":
			return "bool";
		case "number":
			return "number";
		default:
			return "object";
	}
}

function decodeError(message: string): Error {
	return new Error(`decode ${INDEX_KEY}: ${message}`);
}

function fieldError(v: unknown, struct: string, path: string, goType: string): Error {
	return decodeError(
		`json: cannot unmarshal ${goJsonKind(v)} into Go struct field ${struct}.${path} of type ${goType}`,
	);
}

function str(v: unknown, struct: string, path: string): string {
	if (typeof v !== "string") throw fieldError(v, struct, path, "string");
	return v;
}

function integer(v: unknown, struct: string, path: string, goType: string): number {
	if (typeof v !== "number" || !Number.isInteger(v)) throw fieldError(v, struct, path, goType);
	return v;
}

/** strings.TrimPrefix: at most one prefix, and only when it is there. */
function trimPrefix(s: string, prefix: string): string {
	return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** Go's path.Base. */
function baseName(key: string): string {
	if (key === "") return ".";
	let path = key;
	while (path.endsWith("/")) path = path.slice(0, -1);
	const cut = path.lastIndexOf("/");
	if (cut >= 0) path = path.slice(cut + 1);
	return path === "" ? "/" : path;
}

/** Go's path.Ext: from the final dot of the final element. */
function extName(path: string): string {
	for (let i = path.length - 1; i >= 0 && path[i] !== "/"; i--) {
		if (path[i] === ".") return path.slice(i);
	}
	return "";
}

/** n bytes in whole MiB, rounded up (so just over the limit never reads as the limit). */
export function mbUp(n: number): number {
	return Math.trunc((n + MB - 1) / MB);
}
