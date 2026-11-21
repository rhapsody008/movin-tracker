// Port of internal/docs/render_test.go and lru_internal_test.go, plus the
// viewer half of limits_test.go (a document whose recorded size is over the
// limit is refused before it is read) and one render through the real poppler:
// the app-test image installs poppler-utils, so the viewer is exercised against
// the same sample.pdf the converter tests use.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { FakeConverter } from "./convert/fake.ts";
import { createPoppler } from "./convert/poppler.ts";
import {
	CLASS_DRAWING,
	type Doc,
	decodeIndex,
	emptyDoc,
	encodeIndex,
	INDEX_KEY,
	type Index,
	MAX_PDF_BYTES,
	type PageText,
	STATUS_OK,
	type Sync,
} from "./index.ts";
import {
	ByteLRU,
	createImageBudget,
	createViewer,
	IMAGE_LIMIT_REPLY,
	MAX_IMAGES_PER_TURN,
	MAX_VIEW_WORDS,
	NotViewableError,
	VIEW_EDGE,
} from "./render.ts";
import { createSyncer, type Syncer } from "./sync.ts";

const FIXED = new Date("2026-11-11T03:00:00Z");
/** 240 characters, so a page counts as having text (MIN_TEXT_CHARS is 100). */
const LONG = "Defrost the freezer every six months. Keep the door seal clean with warm soapy water. ".repeat(3);
const encoder = new TextEncoder();

const decoder = new TextDecoder();

interface Rig {
	store: ObjectStore;
	conv: FakeConverter;
	sync: Syncer;
	lines: string[];
	put: (key: string, body: string) => Promise<void>;
	run: () => Promise<Sync>;
	doc: (key: string) => Promise<Doc>;
}

/** The sync rig the viewer tests need: a memory store, the fake tools and a fixed clock. */
function createRig(): Rig {
	const { log, lines } = createTestLog();
	const store = createMemoryStore();
	const conv = new FakeConverter();
	const sync = createSyncer({ store, converter: conv, log, now: () => FIXED });
	return {
		store,
		conv,
		sync,
		lines,
		put: async (key, body) => {
			await store.putBlob(key, encoder.encode(body), "application/pdf");
		},
		run: async () => await sync.sync("test"),
		doc: async (key) => {
			const ix = await sync.index();
			const d = ix.docs.find((x) => x.key === key);
			if (d === undefined) throw new Error(`${key} not in the index`);
			return d;
		},
	};
}

/** The width and height in a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { w: number; h: number } {
	if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
		throw new Error(`not a PNG (${png.length} bytes)`);
	}
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { w: view.getUint32(16), h: view.getUint32(20) };
}

describe("viewer", () => {
	it("renders a page, cuts a region out of it and knows the words inside", async () => {
		const r = createRig();
		r.conv.pages.set("pdf-sheet", [
			{
				n: 1,
				w: 1000,
				h: 500,
				text: `POWER LEGEND ${LONG}`,
				words: [
					{ t: "BALCONY", b: [100, 50, 160, 60] }, // top-left
					{ t: "DB", b: [800, 400, 820, 410] }, // bottom-right
				],
			},
		]);
		await r.put("docs/raw/1.0 Plans/Sheet.pdf", "pdf-sheet");
		await r.run();
		const id = (await r.doc("docs/raw/1.0 Plans/Sheet.pdf")).id;
		const v = createViewer({ source: r.sync, store: r.store, conv: r.conv });

		const full = await v.view(id, 1);
		expect(decoder.decode(full.png)).toContain("page=1 region=<nil> edge=1568");
		expect(full.words).toEqual(["BALCONY", "DB"]);
		expect({ page: full.page, region: full.region, w: full.w, h: full.h }).toEqual({
			page: 1,
			region: null,
			w: 1000,
			h: 500,
		});
		expect(full.doc.id).toBe(id);

		const crop = await v.view(id, 1, { x0: 0.5, y0: 0.5, x1: 1, y1: 1 });
		expect(crop.words).toEqual(["DB"]);
		expect(decoder.decode(crop.png)).toContain("page=1 region=&{0.5 0.5 1 1} edge=1568");

		// The same view again comes from the cache.
		const renders = r.conv.renders;
		await v.view(id, 1);
		expect(r.conv.renders).toBe(renders);

		await expect(v.view("nope", 1)).rejects.toBeInstanceOf(NotViewableError);
		await expect(v.view("nope", 1)).rejects.toThrow('not viewable: no document "nope"');
		await expect(v.view(id, 2)).rejects.toThrow("not viewable: Sheet.pdf has 1 pages; there is no page 2");
		await expect(v.view(id, 1, { x0: 0.6, y0: 0, x1: 0.5, y1: 1 })).rejects.toThrow(
			"region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1",
		);

		// A document removed from the bucket can't be viewed any more.
		await r.store.delete("docs/raw/1.0 Plans/Sheet.pdf");
		await r.run();
		await expect(v.view(id, 1)).rejects.toBeInstanceOf(NotViewableError);
	});

	it("keeps at most MAX_VIEW_WORDS words of a region", async () => {
		const r = createRig();
		const words = Array.from({ length: MAX_VIEW_WORDS + 5 }, (_, i) => ({
			t: `W${i}`,
			b: [10 + i, 10, 20 + i, 20] as [number, number, number, number],
		}));
		r.conv.pages.set("pdf-many", [{ n: 1, w: 595, h: 842, text: LONG, words }]);
		await r.put("docs/raw/many.pdf", "pdf-many");
		await r.run();
		const v = createViewer({ source: r.sync, store: r.store, conv: r.conv });
		const view = await v.view((await r.doc("docs/raw/many.pdf")).id, 1);
		expect(view.words).toHaveLength(MAX_VIEW_WORDS);
		expect(view.words[MAX_VIEW_WORDS - 1]).toBe(`W${MAX_VIEW_WORDS - 1}`);
	});

	it("does not cache a PDF bigger than 16 MiB, and caches a small one", { timeout: 30_000 }, async () => {
		const r = createRig();
		const huge = `pdf-huge${"x".repeat(17 << 20)}`;
		r.conv.pages.set(huge, [{ n: 1, w: 595, h: 842, text: LONG }]);
		r.conv.pages.set("pdf-small", [{ n: 1, w: 595, h: 842, text: LONG }]);
		await r.put("docs/raw/huge.pdf", huge);
		await r.put("docs/raw/small.pdf", "pdf-small");
		await r.run();
		const v = createViewer({ source: r.sync, store: r.store, conv: r.conv });
		await v.view((await r.doc("docs/raw/huge.pdf")).id, 1);
		expect(v.cache().pdfs).toBe(0);
		await v.view((await r.doc("docs/raw/small.pdf")).id, 1);
		expect(v.cache().pdfs).toBe(1);
		expect(v.cache().pdfBytes).toBe("pdf-small".length);
		expect(v.cache().views).toBe(2);
		expect(v.cache().viewBytes).toBeGreaterThan(0);
	});

	it("refuses a new version the index has not read yet, and caches nothing", async () => {
		const r = createRig();
		r.conv.pages.set("pdf-drawing-v1", [{ n: 1, w: 2384, h: 1684, text: LONG }]);
		r.conv.pages.set("pdf-drawing-v2", [{ n: 1, w: 2384, h: 1684, text: `${LONG}Version two.` }]);
		await r.put("docs/raw/1.0 Plans/Sheet.pdf", "pdf-drawing-v1");
		await r.run();
		const id = (await r.doc("docs/raw/1.0 Plans/Sheet.pdf")).id;
		await r.put("docs/raw/1.0 Plans/Sheet.pdf", "pdf-drawing-v2"); // uploaded, no sync yet
		const v = createViewer({ source: r.sync, store: r.store, conv: r.conv });
		await expect(v.view(id, 1)).rejects.toBeInstanceOf(NotViewableError);
		await expect(v.view(id, 1)).rejects.toThrow("waiting to be re-read");
		expect(v.cache()).toEqual({ pdfs: 0, pdfBytes: 0, views: 0, viewBytes: 0 });
	});

	it("refuses a document a size limit says is too large to view", async () => {
		const r = createRig();
		r.conv.pages.set("pdf-sheet", [{ n: 1, w: 1000, h: 500, text: `POWER LEGEND ${LONG}` }]);
		await r.put("docs/raw/Sheet.pdf", "pdf-sheet");
		await r.run();
		// A readable sheet whose recorded size is over the limit (the index says
		// so, after a replacement say): the viewer refuses before reading it.
		const { body, etag } = await r.store.get(INDEX_KEY);
		const ix = decodeIndex(decoder.decode(body));
		const d = ix.docs.find((x) => x.key === "docs/raw/Sheet.pdf");
		if (d === undefined) throw new Error("Sheet.pdf not in the index");
		d.size = MAX_PDF_BYTES + 1;
		await r.store.put(INDEX_KEY, encoder.encode(encodeIndex(ix, "2026-11-11T03:00:00Z")), etag);
		await r.sync.refresh();
		const v = createViewer({ source: r.sync, store: r.store, conv: r.conv });
		await expect(v.view(d.id, 1)).rejects.toBeInstanceOf(NotViewableError);
		await expect(v.view(d.id, 1)).rejects.toThrow(
			"not viewable: Sheet.pdf is too large to view (33 MB; the limit is 32 MB)",
		);
	});

	it("renders with the real poppler at the view edge", { timeout: 60_000 }, async () => {
		const store = createMemoryStore();
		const key = "docs/raw/Sample.pdf";
		const sample = readFileSync(fileURLToPath(new URL("./convert/testdata/sample.pdf", import.meta.url)));
		await store.putBlob(key, sample, "application/pdf");
		const conv = createPoppler();
		const pages = await conv.text(sample);
		const { etag } = await store.stat(key);
		const d: Doc = {
			...emptyDoc(key, "5a3b1e01"),
			etag,
			size: sample.length,
			pages: pages.length,
			class: CLASS_DRAWING,
			status: STATUS_OK,
		};
		const ix: Index = { schema: 1, docs: [d], lastSync: null, updated: "" };
		const pt: PageText = { key, etag, pages };
		const v = createViewer({
			source: { index: async () => ix, pageText: async () => pt },
			store,
			conv,
		});

		// Page 2 is the A3 sheet, rotated: 1191 × 842 as displayed.
		const full = await v.view(d.id, 2);
		expect({ w: full.w, h: full.h }).toEqual({ w: 1191, h: 842 });
		expect(full.words).toContain("BALCONY");
		const whole = pngSize(full.png); // 1568 on the long edge
		expect(whole.w).toBe(VIEW_EDGE);
		expect(whole.h).toBeGreaterThanOrEqual(1100);
		expect(whole.h).toBeLessThanOrEqual(1115);

		// A crop of the top-right quarter, upscaled to the same long edge.
		const crop = pngSize((await v.view(d.id, 2, { x0: 0.5, y0: 0, x1: 1, y1: 0.5 })).png);
		expect(Math.max(crop.w, crop.h)).toBeLessThanOrEqual(VIEW_EDGE);
		expect(Math.max(crop.w, crop.h)).toBeGreaterThanOrEqual(VIEW_EDGE - 2);
	});
});

describe("byteLRU", () => {
	it("touches on get, evicts the oldest by bytes and by entries, and keeps its count right", () => {
		const c = new ByteLRU();
		const put = (k: string, n: number): void => c.put(k, new Uint8Array(n), 3, 100);
		put("a", 40);
		put("b", 40);
		expect(c.get("a")).toBeDefined(); // a is now the most recent
		put("c", 40); // 120 > 100: the oldest (b) goes
		expect(c.get("b")).toBeUndefined();
		expect(c.bytes).toBe(80);
		put("d", 10);
		put("e", 10); // 4 entries > 3: the oldest (a) goes
		expect(c.get("a")).toBeUndefined();
		expect(c.size).toBe(3);
		put("huge", 101); // bigger than the whole budget: not cached, nothing evicted
		expect(c.get("huge")).toBeUndefined();
		expect(c.size).toBe(3);
		put("d", 30); // replacing an entry keeps the byte count right
		expect(c.bytes).toBe(40 + 30 + 10);
	});

	it("evicts the oldest entry, never the newest", () => {
		const c = new ByteLRU();
		c.put("first", new Uint8Array(10), 2, 100);
		c.put("second", new Uint8Array(10), 2, 100);
		c.put("third", new Uint8Array(10), 2, 100);
		expect(c.get("first")).toBeUndefined();
		expect(c.get("third")).toBeDefined();
	});
});

describe("images per turn", () => {
	it("stops a message after six images and says so", () => {
		expect(MAX_IMAGES_PER_TURN).toBe(6);
		expect(IMAGE_LIMIT_REPLY).toBe('{"error":"image limit for this message reached; answer from what you have seen"}');
		const budget = createImageBudget();
		for (let i = 1; i <= MAX_IMAGES_PER_TURN; i++) expect(budget.take()).toBe(true);
		expect(budget.take()).toBe(false); // the seventh image of one message
	});
});
