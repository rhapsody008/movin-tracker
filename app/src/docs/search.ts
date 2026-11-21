// The search library: a BM25 index over the documents' pages, built from
// docs/text/ on first use and rebuilt after each sync. Port of
// internal/docs/search.go (docs-spec §4).
//
// Scanned documents (no text layer) are left out until the OCR phase, and a
// document whose text cannot be read is left out with a warning. The index is
// rebuilt whenever the syncer's generation moves, which is Go's pointer-identity
// check (docs-spec §9.7): a sync or a refresh makes a new index object, even
// when its bytes are the same.
//
// The tokenizer, the stopword set and the stemmer are ports of the Go ones,
// and the snippet is cut in code points: a query word Ⱥ lowercases to ⱥ, which
// is a different number of bytes but the same number of characters.

import { compareBytes, goFields, goTrim } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { CLASS_SCANNED, type Doc, docFolder, docName, find, type Index, type PageText, STATUS_OK } from "./index.ts";
import type { Syncer } from "./sync.ts";
import type { Page } from "./types.ts";

/** What the library needs from the syncer; a Syncer satisfies it. */
export type SearchSource = Pick<Syncer, "index" | "pageText" | "generation">;

/** One search result, the shape the `search_documents` tool returns. */
export interface Hit {
	/** The document's id. */
	doc: string;
	/** The file name. */
	name: string;
	/** The folder under docs/raw/; left out at the top level. */
	folder?: string;
	page: number;
	score: number;
	snippet: string;
}

/** Narrows a search. */
export interface SearchOptions {
	/** A document id. */
	doc?: string;
	/** A folder under docs/raw/ (prefix match, case-insensitive). */
	folder?: string;
	/** Default 8, max 20. */
	limit?: number;
}

/** One document's page, as `read_document_page` returns it. */
export interface PageResult {
	/** The document, when the id names a readable one; null otherwise. */
	doc: Doc | null;
	/** The page with that number, or null when the document has no such page. */
	page: Page | null;
}

/** Answers questions about the documents' text. */
export interface Library {
	/** Ranks pages by BM25 for the query's words; throws on a store error. */
	search: (query: string, options?: SearchOptions, signal?: AbortSignal) => Promise<Hit[]>;
	/** One page of a document in the current index. */
	page: (docID: string, n: number, signal?: AbortSignal) => Promise<PageResult>;
}

export interface LibraryOptions {
	source: SearchSource;
	log: Log;
}

/** How the score weighs term frequency against page length (Go's bm25K1/bm25B). */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** Hits returned when the caller doesn't say, and the cap on what it may ask for. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

/** A snippet is at most this many code points, starting this far before the match. */
const SNIPPET_BEFORE = 80;
const SNIPPET_LEN = 240;

/** One page of text, with what scoring needs precomputed. */
interface IndexedPage {
	doc: Doc;
	n: number;
	text: string;
	tf: Map<string, number>;
	/** Terms on the page, stopwords removed. */
	terms: number;
}

export function createLibrary(o: LibraryOptions): Library {
	const { source, log } = o;
	// Go compares the index pointer a build came from (docs-spec §9.7); the
	// syncer's generation is that pointer's port.
	let builtGen: number | null = null;
	let pages: IndexedPage[] = [];
	let df = new Map<string, number>();
	let avg = 0;

	/** Builds the search data for the current index if it is stale. */
	async function ensure(signal: AbortSignal | undefined): Promise<void> {
		// Read the generation first: a sync landing in between then costs one
		// more rebuild later instead of leaving a stale build in place.
		const gen = source.generation();
		const ix: Index = await source.index(signal);
		if (builtGen === gen) return;
		const fresh: IndexedPage[] = [];
		const freshDf = new Map<string, number>();
		let total = 0;
		for (const d of ix.docs) {
			if (d.status !== STATUS_OK || d.class === CLASS_SCANNED) continue;
			let pt: PageText;
			try {
				pt = await source.pageText(d, signal);
			} catch (err) {
				log.warn("document text unreadable; left out of search", { key: d.key, err: errorMessage(err) });
				continue;
			}
			for (const p of pt.pages) {
				const toks = tokens(p.text);
				if (toks.length === 0) continue; // not indexed, and not counted in avg
				const tf = new Map<string, number>();
				for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
				for (const t of tf.keys()) freshDf.set(t, (freshDf.get(t) ?? 0) + 1);
				total += toks.length;
				fresh.push({ doc: d, n: p.n, text: p.text, tf, terms: toks.length });
			}
		}
		pages = fresh;
		df = freshDf;
		avg = fresh.length > 0 ? total / fresh.length : 0;
		builtGen = gen;
	}

	async function search(query: string, options: SearchOptions = {}, signal?: AbortSignal): Promise<Hit[]> {
		await ensure(signal);
		let limit = options.limit ?? 0;
		if (limit <= 0) limit = DEFAULT_LIMIT;
		limit = Math.min(limit, MAX_LIMIT);
		const q = uniq(tokens(query));
		const wantDoc = options.doc ?? "";
		const wantFolder = goTrim(options.folder ?? "", "/").toLowerCase();
		const n = pages.length;
		const hits: Hit[] = [];
		for (const p of pages) {
			if (wantDoc !== "" && p.doc.id !== wantDoc) continue;
			if (wantFolder !== "" && !docFolder(p.doc).toLowerCase().startsWith(wantFolder)) continue;
			let score = 0;
			for (const t of q) {
				const f = p.tf.get(t) ?? 0;
				if (f === 0) continue;
				const seen = df.get(t) ?? 0;
				const idf = Math.log(1 + (n - seen + 0.5) / (seen + 0.5));
				score += (idf * f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + (BM25_B * p.terms) / avg));
			}
			if (score <= 0) continue;
			const folder = docFolder(p.doc);
			hits.push({
				doc: p.doc.id,
				name: docName(p.doc),
				...(folder === "" ? {} : { folder }),
				page: p.n,
				score: Math.round(score * 100) / 100,
				snippet: snippet(p.text, q),
			});
		}
		// Stable, so equal scores keep page order: score down, then name, then page.
		hits.sort((a, b) => {
			if (a.score !== b.score) return b.score - a.score;
			const byName = compareBytes(a.name, b.name);
			return byName !== 0 ? byName : a.page - b.page;
		});
		return hits.length > limit ? hits.slice(0, limit) : hits;
	}

	async function page(docID: string, n: number, signal?: AbortSignal): Promise<PageResult> {
		const ix = await source.index(signal);
		const d = find(ix, docID);
		if (d === null || d.status !== STATUS_OK) return { doc: null, page: null };
		const pt = await source.pageText(d, signal);
		return { doc: d, page: pt.pages.find((p) => p.n === n) ?? null };
	}

	return { search, page };
}

/** The stopwords dropped before scoring (Go's `stopwords`). */
const STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"of",
	"to",
	"in",
	"on",
	"for",
	"is",
	"are",
	"be",
	"with",
	"by",
	"it",
	"at",
	"as",
	"this",
	"that",
	"from",
	"what",
	"where",
	"how",
	"do",
	"does",
	"our",
	"we",
	"my",
	"i",
	"you",
	"your",
	"can",
	"which",
]);

// unicode.IsLetter or unicode.IsDigit: everything else splits a field.
const WORD = /[\p{L}\p{Nd}]/u;

/**
 * tokens lowercases, splits on anything but letters and digits, drops stopwords
 * and folds simple plurals ("sockets" finds "socket").
 */
function tokens(s: string): string[] {
	const out: string[] = [];
	for (const f of fieldsFunc(lower(s))) {
		if (STOPWORDS.has(f)) continue;
		out.push(stem(f));
	}
	return out;
}

/** strings.FieldsFunc(s, func(r) { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }). */
function fieldsFunc(s: string): string[] {
	const out: string[] = [];
	let field = "";
	for (const ch of s) {
		if (WORD.test(ch)) {
			field += ch;
			continue;
		}
		if (field !== "") out.push(field);
		field = "";
	}
	if (field !== "") out.push(field);
	return out;
}

/**
 * Go's two-rule stem, on byte lengths as Go's len() counts them: a token that
 * ends in "ies" (and is longer than 4 bytes) folds to "…y", and one ending in a
 * lone "s" (longer than 3, not "ss", not "us") loses it.
 */
function stem(t: string): string {
	const size = Buffer.byteLength(t, "utf8");
	if (size > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
	if (size > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us")) return t.slice(0, -1);
	return t;
}

function uniq(ts: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of ts) {
		if (seen.has(t)) continue;
		seen.add(t);
		out.push(t);
	}
	return out;
}

/**
 * snippet returns about 240 characters around the first query word on the page,
 * whitespace collapsed. Positions are code points: lowercasing a string can
 * change its byte length, but taking it a character at a time keeps them aligned.
 */
function snippet(text: string, q: readonly string[]): string {
	const r = [...goFields(text).join(" ")]; // Go's []rune(...)
	const low = r.map(lowerRune);
	const lows = low.join("");
	let at = -1;
	for (const t of q) {
		const i = lows.indexOf(t); // Go's strings.Index on the lowered text
		if (i < 0) continue;
		const ri = [...lows.slice(0, i)].length; // the byte index as a rune index
		if (at < 0 || ri < at) at = ri;
	}
	if (at < 0) at = 0;
	const start = Math.max(0, at - SNIPPET_BEFORE);
	const end = Math.min(r.length, start + SNIPPET_LEN);
	let out = r.slice(start, end).join("");
	if (start > 0) out = `…${out}`;
	if (end < r.length) out = `${out}…`;
	return out;
}

/**
 * One character lowercased, as unicode.ToLower does it: a mapping that never
 * expands U+0130 to two characters the way JS does (that one stays as typed).
 */
function lowerRune(ch: string): string {
	const low = ch.toLowerCase();
	return [...low].length === 1 ? low : ch;
}

/** strings.ToLower, a character at a time so positions never move. */
function lower(s: string): string {
	let out = "";
	for (const ch of s) out += lowerRune(ch);
	return out;
}
