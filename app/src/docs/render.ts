// The viewer: renders a document's page (or a region of it) on demand for a
// model to look at. Port of internal/docs/render.go (docs-spec §5).
//
// Nothing is pre-rendered or stored: the raw PDF is read once and kept for a
// few documents, and recent renders are kept too, so an overview followed by
// crops of the same sheet reads the bucket once. Both caches are bounded in
// bytes, because the app runs in 256 MiB and one A1 render can be a megabyte.
//
// The image is always the page's long edge at ViewEdge pixels (or the region's),
// PNG, and the words inside the region come back with it so the model can name
// what a crop shows.

import { goQuote } from "../gostr.ts";
import { errorMessage } from "../log.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { type Doc, docName, find, MAX_PDF_BYTES, mbUp, STATUS_OK } from "./index.ts";
import type { Syncer } from "./sync.ts";
import { type Page, type Region, regionValid, type Word } from "./types.ts";

/** Renders PDF pages (docs/convert/poppler.ts). */
export interface Renderer {
	/** A PNG of page `page` (1-based) or of `region` of it, `longEdge` pixels on its longer side. */
	render: (
		pdf: Uint8Array,
		page: number,
		region: Region | null,
		longEdge: number,
		signal?: AbortSignal,
	) => Promise<Uint8Array>;
}

/** The long edge of a view in pixels: enough to read room names on an overview and socket labels on a crop, and a size models take well. */
export const VIEW_EDGE = 1568;

/** Caps the words returned with a view. */
export const MAX_VIEW_WORDS = 300;

/** Caps the images one user message may look at (Go's agent.MaxImagesPerTurn). */
export const MAX_IMAGES_PER_TURN = 6;

/** The tool result once a message has looked at enough images (Go's agent.go:224). */
export const IMAGE_LIMIT_REPLY = '{"error":"image limit for this message reached; answer from what you have seen"}';

/**
 * imageBudget counts the images one user message has looked at: take() answers
 * false once the cap is reached, and the tool result becomes IMAGE_LIMIT_REPLY.
 * Go keeps the same counter on its turn (agent.go:223-226).
 */
export function createImageBudget(): { take: () => boolean } {
	let shown = 0;
	return {
		take: () => {
			if (shown + 1 > MAX_IMAGES_PER_TURN) return false;
			shown++;
			return true;
		},
	};
}

/** A document that can't be shown: no such document, no such page, too large, or replaced and not re-read yet. */
export class NotViewableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`not viewable: ${message}`, options);
		this.name = "NotViewableError";
	}
}

/** Cache limits: a few PDFs (the largest today is 14 MB) and a couple of dozen renders (each 0.1–1 MB). */
const MAX_CACHED_PDFS = 3;
const MAX_CACHED_PDF_BYTES = 32 << 20;
/** Bigger PDFs are read again each time rather than held in memory. */
const MAX_PDF_TO_CACHE = 16 << 20;
const MAX_CACHED_VIEWS = 24;
const MAX_CACHED_VIEW_BYTES = 16 << 20;

const REGION_MESSAGE = "region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1";

/** One rendered page or region. */
export interface View {
	doc: Doc;
	page: number;
	region: Region | null;
	png: Uint8Array;
	/** The words inside the region (drawings only). */
	words: string[];
	/** The page, in points as displayed. */
	w: number;
	h: number;
}

/** Renders document pages on demand. */
export interface Viewer {
	/** Page n of document id, the whole page or a region of it; throws NotViewableError or the store's error. */
	view: (id: string, n: number, region?: Region | null, signal?: AbortSignal) => Promise<View>;
	/** What the two caches hold; read by the tests, as Go's export_test.go's CacheSize is. */
	cache: () => CacheCounters;
}

/** How much the viewer holds: PDFs and renders, in entries and in bytes. */
export interface CacheCounters {
	pdfs: number;
	pdfBytes: number;
	views: number;
	viewBytes: number;
}

/** What the viewer needs from the syncer; a Syncer satisfies it. */
export type ViewSource = Pick<Syncer, "index" | "pageText">;

export interface ViewerOptions {
	source: ViewSource;
	/** Where the raw PDFs are. */
	store: ObjectStore;
	conv: Renderer;
}

export function createViewer(o: ViewerOptions): Viewer {
	const { source, store, conv } = o;
	const pdfs = new ByteLRU();
	const views = new ByteLRU();

	async function view(id: string, n: number, region: Region | null = null, signal?: AbortSignal): Promise<View> {
		const ix = await source.index(signal);
		const d = find(ix, id);
		if (d === null || d.status !== STATUS_OK) throw new NotViewableError(`no document ${goQuote(id)}`);
		if (n < 1 || n > d.pages) {
			throw new NotViewableError(`${docName(d)} has ${d.pages} pages; there is no page ${n}`);
		}
		if (region !== null && !regionValid(region)) throw new Error(REGION_MESSAGE);
		const out: View = { doc: d, page: n, region, png: new Uint8Array(0), words: [], w: 0, h: 0 };
		// Best effort: the sizes and words are a bonus, the render still works.
		const pt = await source.pageText(d, signal).catch(() => null);
		if (pt !== null && n <= pt.pages.length) {
			const p = pt.pages[n - 1];
			if (p !== undefined) {
				out.w = p.w;
				out.h = p.h;
				out.words = wordsIn(p, region);
			}
		}
		const key = viewKey(d, n, region);
		const cached = views.get(key);
		if (cached !== undefined) {
			out.png = cached;
			return out;
		}
		const pdf = await readPDF(d, signal);
		out.png = await conv.render(pdf, n, region, VIEW_EDGE, signal);
		views.put(key, out.png, MAX_CACHED_VIEWS, MAX_CACHED_VIEW_BYTES);
		return out;
	}

	/** The raw PDF, cached when it is small enough; refuses one the index says is too large or that was replaced since. */
	async function readPDF(d: Doc, signal: AbortSignal | undefined): Promise<Uint8Array> {
		const key = `${d.key}|${d.etag}`;
		const cached = pdfs.get(key);
		if (cached !== undefined) return cached;
		if (d.size > MAX_PDF_BYTES) {
			throw new NotViewableError(
				`${docName(d)} is too large to view (${mbUp(d.size)} MB; the limit is ${MAX_PDF_BYTES >> 20} MB)`,
			);
		}
		const got = await store.get(d.key, signal).catch((err: unknown) => {
			throw new Error(`read ${docName(d)}: ${errorMessage(err)}`, { cause: err });
		});
		if (got.etag !== d.etag) {
			// A newer upload the index hasn't read yet (or failed to read): its
			// pages wouldn't match the stored text and word boxes.
			throw new NotViewableError(
				`${docName(d)} was replaced and is waiting to be re-read; try again after the next sync (/sync)`,
			);
		}
		if (got.body.length <= MAX_PDF_TO_CACHE) pdfs.put(key, got.body, MAX_CACHED_PDFS, MAX_CACHED_PDF_BYTES);
		return got.body;
	}

	return {
		view,
		cache: () => ({
			pdfs: pdfs.size,
			pdfBytes: pdfs.bytes,
			views: views.size,
			viewBytes: views.bytes,
		}),
	};
}

/** A deterministic key for the render cache (Go prints the region with %v; nothing persists it). */
function viewKey(d: Doc, n: number, region: Region | null): string {
	const where = region === null ? "<nil>" : `${region.x0} ${region.y0} ${region.x1} ${region.y1}`;
	return `${d.key}|${d.etag}|${n}|${where}`;
}

/** The words whose centre lies inside the region (all words without one), in reading order, capped. */
function wordsIn(p: Page, r: Region | null): string[] {
	const out: string[] = [];
	for (const w of p.words ?? []) {
		if (r !== null && p.w > 0 && p.h > 0 && !inside(w, p, r)) continue;
		out.push(w.t);
		if (out.length === MAX_VIEW_WORDS) break;
	}
	return out;
}

function inside(w: Word, p: Page, r: Region): boolean {
	const cx = (w.b[0] + w.b[2]) / 2 / p.w;
	const cy = (w.b[1] + w.b[3]) / 2 / p.h;
	return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
}

/**
 * byteLRU is a small least-recently-used cache of byte slices, bounded by
 * entries and by total bytes. Getting a key makes it the most recent; a value
 * bigger than the whole budget is not cached and evicts nothing.
 */
export class ByteLRU {
	private keys: string[] = [];
	private readonly vals = new Map<string, Uint8Array>();
	private held = 0;

	/** The bytes held, for the tests that check the budget. */
	get bytes(): number {
		return this.held;
	}

	/** How many entries are held. */
	get size(): number {
		return this.keys.length;
	}

	get(k: string): Uint8Array | undefined {
		const v = this.vals.get(k);
		if (v === undefined) return undefined;
		this.touch(k);
		return v;
	}

	put(k: string, v: Uint8Array, maxEntries: number, maxBytes: number): void {
		if (v.length > maxBytes) return;
		const old = this.vals.get(k);
		if (old !== undefined) {
			this.held -= old.length;
			this.drop(k);
		}
		while (this.keys.length > 0 && (this.keys.length >= maxEntries || this.held + v.length > maxBytes)) {
			const oldest = this.keys[0];
			if (oldest === undefined) break;
			this.held -= this.vals.get(oldest)?.length ?? 0;
			this.vals.delete(oldest);
			this.keys.shift();
		}
		this.vals.set(k, v);
		this.held += v.length;
		this.keys.push(k);
	}

	private touch(k: string): void {
		this.drop(k);
		this.keys.push(k);
	}

	private drop(k: string): void {
		const at = this.keys.indexOf(k);
		if (at >= 0) this.keys.splice(at, 1);
	}
}
