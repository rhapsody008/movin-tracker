// The sync engine: brings docs/index.json and docs/text/ in line with the
// bucket listing under docs/raw/. Port of internal/docs/sync.go (docs-spec §2).
//
// One run at a time per syncer: a second caller joins the running flight and
// gets its result instead of queueing (docs-spec §9.8). Change detection is
// ETag-only; the index write is guarded by the ETag it read, and a lost race is
// redone on top of the other writer's index. Everything a run has already
// converted or summarised per file is memoised, so a redo converts nothing
// twice.

import { goStamp } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectInfo, type ObjectStore, PreconditionError } from "../objstore/store.ts";
import {
	assignID,
	byKey,
	CLASS_SCANNED,
	CONVERT_VERSION,
	changes,
	classify,
	type Doc,
	decodeIndex,
	decodePageText,
	docTextKey,
	emptyDoc,
	emptyIndex,
	encodeIndex,
	encodePageText,
	garbled,
	INDEX_KEY,
	type Index,
	MAX_PDF_BYTES,
	mbUp,
	newerThanThisBuild,
	type PageInfo,
	type PageText,
	RAW_PREFIX,
	STATUS_FAILED,
	STATUS_OK,
	STATUS_REMOVED,
	STATUS_SKIPPED,
	type Sync,
	skipReason,
	textKeyFor,
} from "./index.ts";
import { firstText, memoKey, retrySummary, SUMMARY_TEXT_CHARS, type Summariser, type SummaryMemo } from "./summary.ts";
import type { Page } from "./types.ts";

/** What a sync needs from the PDF tools (internal/docs/convert). */
export interface Converter {
	/** Every page's size and text; word boxes come with the drawings. */
	text(pdf: Uint8Array, signal?: AbortSignal): Promise<Page[]>;
}

/**
 * Hears about syncs that changed something: not no-op runs, and not the first
 * import (while no document was readable yet). It must not block for long.
 */
export interface Notifier {
	docsChanged(result: Sync, changed: Doc[]): void;
}

/** Brings docs/index.json and docs/text/ in line with docs/raw/. */
export interface Syncer {
	/** Runs one sync, or joins the one running. Throws ConflictError / NewerIndexError / the store's error. */
	sync: (reason: string, signal?: AbortSignal) => Promise<Sync>;
	/** Whether a sync is in progress (the UI and Telegram say so). */
	running: () => boolean;
	/** Called after every run; returns the unsubscribe function. */
	subscribe: (listener: () => void) => () => void;
	/** The cached index, read from the bucket on first use. Never fails for a missing index. */
	index: (signal?: AbortSignal) => Promise<Index>;
	/** Re-reads the index only if the stored ETag moved (another replica or a manual edit). */
	refresh: (signal?: AbortSignal) => Promise<void>;
	/** One document's stored per-page text. */
	pageText: (d: Doc, signal?: AbortSignal) => Promise<PageText>;
	/**
	 * Goes up whenever the cached index is replaced, even with identical bytes:
	 * Go's search library rebuilds when the index *pointer* changes (docs-spec
	 * §9.7), and this is the port of that trigger.
	 */
	generation: () => number;
}

export interface SyncerOptions {
	store: ObjectStore;
	converter: Converter;
	/** Without one, summaries stay empty. */
	summariser?: Summariser;
	notify?: Notifier;
	log: Log;
	/** The clock; tests pass their own. */
	now?: () => Date;
}

/** How often a sync re-reads and redoes its index write after another writer got there first. */
export const MAX_INDEX_RETRIES = 3;

/** The index kept changing under this sync (another copy of the app writing it). */
export class ConflictError extends Error {
	constructor() {
		super("documents index changed by someone else; try the sync again");
		this.name = "ConflictError";
	}
}

/**
 * The index holds records from a newer build. This build doesn't write over
 * them (it would drop what it doesn't know).
 */
export class NewerIndexError extends Error {
	constructor() {
		super("documents index was written by a newer version of the app; this one leaves it alone");
		this.name = "NewerIndexError";
	}
}

/** One conversion's outcome, kept per key|etag so a redo does not read it again. */
interface ConvOutcome {
	doc: Doc;
	err: Error | null;
}

/** What a run has already done per file; it survives a redo (failures included). */
interface RunMemo {
	converted: Map<string, ConvOutcome>;
	summaries: SummaryMemo;
}

export function createSyncer(o: SyncerOptions): Syncer {
	const { store, converter, log } = o;
	const summariser = o.summariser ?? null;
	const notify = o.notify ?? null;
	const now = o.now ?? ((): Date => new Date());
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();

	let flight: Promise<Sync> | null = null;
	let current: Index | null = null;
	let etag = "";
	let gen = 0;
	const listeners = new Set<() => void>();

	/** Replaces the cached index and marks it new for the search library. */
	function setIndex(ix: Index, tag: string): void {
		current = ix;
		etag = tag;
		gen++;
	}

	async function load(signal: AbortSignal | undefined): Promise<{ ix: Index; etag: string }> {
		let got: { body: Uint8Array; etag: string };
		try {
			got = await store.get(INDEX_KEY, signal);
		} catch (err) {
			// A missing index is an empty one; the first sync writes it.
			if (err instanceof NotFoundError) return { ix: emptyIndex(), etag: "" };
			throw err;
		}
		return { ix: decodeIndex(decoder.decode(got.body)), etag: got.etag };
	}

	async function index(signal?: AbortSignal): Promise<Index> {
		const cached = current;
		if (cached !== null) return cached;
		const loaded = await load(signal);
		// A sync may have set the index while this read was in flight; its copy
		// is newer.
		const newer = current;
		if (newer !== null) return newer;
		setIndex(loaded.ix, loaded.etag);
		return loaded.ix;
	}

	async function refresh(signal?: AbortSignal): Promise<void> {
		let info: ObjectInfo;
		try {
			info = await store.stat(INDEX_KEY, signal);
		} catch (err) {
			if (err instanceof NotFoundError) return;
			throw err;
		}
		if (current !== null && info.etag === etag) return;
		const loaded = await load(signal);
		setIndex(loaded.ix, loaded.etag);
	}

	async function pageText(d: Doc, signal?: AbortSignal): Promise<PageText> {
		const key = docTextKey(d);
		const got = await store.get(key, signal);
		try {
			return decodePageText(decoder.decode(got.body));
		} catch (err) {
			throw new Error(`decode ${key}: ${errorMessage(err)}`, { cause: err });
		}
	}

	async function sync(reason: string, signal?: AbortSignal): Promise<Sync> {
		const running = flight;
		// Single flight, not a queue: the second caller gets that run's result,
		// or its own signal's error if it ends first.
		if (running !== null) return await join(running, signal);
		const promise = (async (): Promise<Sync> => {
			try {
				return await run(reason, signal);
			} finally {
				flight = null;
				notifySubscribers();
			}
		})();
		flight = promise;
		return await promise;
	}

	function join(pending: Promise<Sync>, signal: AbortSignal | undefined): Promise<Sync> {
		if (signal === undefined) return pending;
		if (signal.aborted) return Promise.reject(signal.reason);
		return new Promise<Sync>((resolve, reject) => {
			const onAbort = (): void => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			void pending.then(
				(res) => {
					signal.removeEventListener("abort", onAbort);
					resolve(res);
				},
				(err: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	/** Go's buffered channels of size 1: one signal per run, and a listener that throws cannot stop the others. */
	function notifySubscribers(): void {
		for (const listener of [...listeners]) {
			try {
				listener();
			} catch (err) {
				log.warn("documents subscriber failed", { err: errorMessage(err) });
			}
		}
	}

	async function run(reason: string, signal: AbortSignal | undefined): Promise<Sync> {
		const memo: RunMemo = { converted: new Map(), summaries: new Map() };
		// One stamp per run, shared by every field it writes: Telegram finds the
		// documents a run touched by comparing syncedAt/removedAt/errorAt with
		// at (docs-spec §9.5).
		const at = goStamp(now());
		for (let attempt = 0; attempt <= MAX_INDEX_RETRIES; attempt++) {
			try {
				const loaded = await load(signal);
				if (newerThanThisBuild(loaded.ix)) throw new NewerIndexError();
				const objs = await store.list(RAW_PREFIX, signal);
				const { res, changed, first } = await apply(loaded.ix, objs, reason, at, memo, signal);
				const body = encoder.encode(encodeIndex(loaded.ix, at));
				// "" means "create only", which the store spells null.
				const newTag = await store.put(INDEX_KEY, body, loaded.etag === "" ? null : loaded.etag, signal);
				setIndex(loaded.ix, newTag);
				log.info("documents synced", {
					reason,
					added: res.added,
					changed: res.changed,
					removed: res.removed,
					failed: res.failed,
					skipped: res.skipped,
					refreshed: res.refreshed,
					firstImport: first,
				});
				if (changes(res) && !first && notify !== null) notify.docsChanged(res, changed);
				return res;
			} catch (err) {
				if (err instanceof PreconditionError) {
					// Another writer got there first: read their index and redo
					// on top of it. The memo keeps this from paying twice.
					log.info("documents index changed while syncing; redoing", { attempt: attempt + 1 });
					continue;
				}
				throw failed(log, err);
			}
		}
		throw failed(log, new ConflictError());
	}

	/**
	 * apply brings ix in line with the listing of docs/raw/ and returns what
	 * changed. It writes per-document text but not the index.
	 */
	async function apply(
		ix: Index,
		objs: readonly ObjectInfo[],
		reason: string,
		at: string,
		memo: RunMemo,
		signal: AbortSignal | undefined,
	): Promise<{ res: Sync; changed: Doc[]; first: boolean }> {
		const res: Sync = { at, reason, added: 0, changed: 0, removed: 0, failed: 0, skipped: 0, refreshed: 0, error: "" };
		const changed: Doc[] = [];
		// First import: nothing was readable before (an empty index, or one where
		// every document failed, e.g. before poppler was installed).
		const first = !ix.docs.some((d) => d.status === STATUS_OK);
		const taken = new Map(ix.docs.map((d) => [d.id, d.key]));
		const known = byKey(ix);
		const seen = new Set<string>();
		for (const obj of objs) {
			seen.add(obj.key);
			let existing = known.get(obj.key);
			const isKnown = existing !== undefined;
			if (existing === undefined) {
				const id = assignID(obj.key, taken);
				taken.set(id, obj.key);
				existing = emptyDoc(obj.key, id);
				ix.docs.push(existing);
				known.set(obj.key, existing);
			}
			const d: Doc = existing;
			const why = skipReason(obj.key);
			if (why !== "") {
				if (d.status !== STATUS_SKIPPED || d.etag !== obj.etag) res.skipped++;
				d.status = STATUS_SKIPPED;
				d.reason = why;
				d.etag = obj.etag;
				d.size = obj.size;
				d.removedAt = "";
				continue;
			}
			if (isKnown && d.status === STATUS_OK && d.etag === obj.etag && d.v >= CONVERT_VERSION) {
				// Unchanged; a missing summary gets one try per run.
				if (summariser !== null) d.summary = await retrySummaryFor(d, memo, signal);
				continue;
			}
			await update(d, obj, at, memo, res, changed, signal);
		}
		for (const d of ix.docs) {
			if (seen.has(d.key) || d.status === STATUS_REMOVED) continue;
			d.status = STATUS_REMOVED;
			d.removedAt = at;
			d.reason = "";
			// A removed file that was never read (a .mp4, a ._ file) is not a change.
			if (skipReason(d.key) === "") {
				res.removed++;
				changed.push({ ...d });
			}
		}
		ix.lastSync = res;
		return { res, changed, first };
	}

	/**
	 * summarise returns a summary from the first ~3000 characters of text, or ""
	 * when the model fails (tried again at the next sync).
	 */
	async function summarise(
		sum: Summariser,
		d: Doc,
		pages: readonly Page[],
		signal: AbortSignal | undefined,
	): Promise<string> {
		try {
			return await sum.summarise(d, firstText(pages, SUMMARY_TEXT_CHARS), signal);
		} catch (err) {
			log.warn("document summary failed", { key: d.key, err: errorMessage(err) });
			return "";
		}
	}

	/** One summary attempt for an unchanged document, or the one a conversion already bought. */
	async function retrySummaryFor(d: Doc, memo: RunMemo, signal: AbortSignal | undefined): Promise<string> {
		const conv = memo.converted.get(memoKey(d.key, d.etag));
		const bought = conv !== undefined && conv.err === null ? conv.doc.summary : "";
		return await retrySummary({
			d,
			memo: memo.summaries,
			bought,
			readPages: async () => (await pageText(d, signal)).pages,
			summarise: async (pages) => (summariser === null ? "" : await summarise(summariser, d, pages, signal)),
		});
	}

	/** update reads a new, changed, failed, re-added or older-version document. */
	async function update(
		d: Doc,
		obj: ObjectInfo,
		at: string,
		memo: RunMemo,
		res: Sync,
		changed: Doc[],
		signal: AbortSignal | undefined,
	): Promise<void> {
		const wasOK = d.status === STATUS_OK;
		// Readable before (not counting a removal): decides changed vs added.
		const readable = d.pages > 0 && d.status !== STATUS_REMOVED;
		const refresh = wasOK && d.etag === obj.etag; // same file, older reader
		const k = memoKey(obj.key, obj.etag);
		let out = memo.converted.get(k);
		if (out === undefined) {
			const nd = { ...d }; // Go reads into a copy of the record
			const err = await convert(nd, obj, signal).then(
				() => null,
				(e: unknown) => asError(e),
			);
			out = { doc: nd, err };
			memo.converted.set(k, out);
		}
		if (out.err !== null) {
			res.failed++;
			log.warn("document sync failed", { key: obj.key, err: out.err.message, keptPrevious: wasOK });
			if (wasOK) {
				// Keep the readable record; the next sync tries again. Say why on
				// the record so the admin sees which file it was.
				d.error = `couldn't read the new version: ${out.err.message}`;
				d.errorAt = at;
				return;
			}
			d.status = STATUS_FAILED;
			d.reason = out.err.message;
			d.etag = obj.etag;
			d.size = obj.size;
			d.syncedAt = at;
			d.error = out.err.message;
			d.errorAt = at;
			return;
		}
		const id = d.id;
		Object.assign(d, out.doc);
		d.id = id;
		d.syncedAt = at;
		d.removedAt = "";
		d.v = CONVERT_VERSION;
		d.error = "";
		d.errorAt = "";
		if (refresh) {
			res.refreshed++; // not announced
			return;
		}
		if (readable) res.changed++;
		else res.added++;
		changed.push({ ...d });
	}

	/**
	 * convert reads one PDF, extracts its pages, stores their text and fills the
	 * document's fields. The summary is redone when a Summariser is set.
	 */
	async function convert(d: Doc, obj: ObjectInfo, signal: AbortSignal | undefined): Promise<void> {
		if (obj.size > MAX_PDF_BYTES) {
			throw new Error(`too large to read (${mbUp(obj.size)} MB; the limit is ${MAX_PDF_BYTES >> 20} MB)`);
		}
		let got: { body: Uint8Array; etag: string };
		try {
			got = await store.get(obj.key, signal);
		} catch (err) {
			throw new Error(`read: ${errorMessage(err)}`, { cause: err });
		}
		const pages = await converter.text(got.body, signal);
		for (const p of pages) {
			if (!garbled(p.text)) continue;
			// An unusable text layer counts as no text: it keeps the page out of search.
			p.text = "";
			delete p.words;
		}
		const info: PageInfo[] = pages.map((p) => ({ w: p.w, h: p.h, chars: nonSpace(p.text) }));
		const { class: cls, textPages } = classify(info);
		const body = encoder.encode(encodePageText({ key: obj.key, etag: got.etag, pages }));
		try {
			await store.putBlob(textKeyFor(obj.key), body, "application/json", signal);
		} catch (err) {
			throw new Error(`write text: ${errorMessage(err)}`, { cause: err });
		}
		d.etag = got.etag;
		d.size = obj.size;
		d.pages = pages.length;
		d.class = cls;
		d.textPages = textPages;
		d.status = STATUS_OK;
		d.reason = "";
		d.summary = "";
		if (summariser !== null && cls !== CLASS_SCANNED) d.summary = await summarise(summariser, d, pages, signal);
	}

	return {
		sync,
		running: () => flight !== null,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		index,
		refresh,
		pageText,
		generation: () => gen,
	};
}

/** Go's fail: one warn line, then the error goes to the caller. */
function failed(log: Log, err: unknown): Error {
	log.warn("documents sync failed", { err: errorMessage(err) });
	return asError(err);
}

function asError(err: unknown): Error {
	return err instanceof Error ? err : new Error(String(err));
}

/** Non-space characters, as Go's nonSpace counts them (docs.Classify's Chars). */
function nonSpace(s: string): number {
	let n = 0;
	for (const ch of s) {
		if (ch !== " " && ch !== "\n" && ch !== "\t" && ch !== "\r" && ch !== "\f") n++;
	}
	return n;
}
