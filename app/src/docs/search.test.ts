// Port of internal/docs/search_test.go: the ranking, the filters, the plural
// folding, the snippet and the page lookup. The scoring itself is pinned
// against Go's own answers for the fixture in testdata/ (search-hits.go.json,
// written by app/golden/t15c/main.go), which covers stemming edge cases, CJK
// text, the limit cap and the ellipses of a cut snippet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { FakeConverter } from "./convert/fake.ts";
import {
	CLASS_TEXT,
	type Doc,
	decodeIndex,
	decodePageText,
	emptyDoc,
	type Index,
	type PageText,
	STATUS_OK,
} from "./index.ts";
import { createLibrary, type SearchOptions, type SearchSource } from "./search.ts";
import { createSyncer } from "./sync.ts";

const dir = join(import.meta.dirname, "testdata", "search");

/** The fixture index: eight documents, two of them not searchable. */
const fixture = decodeIndex(readFileSync(join(dir, "search-index.json"), "utf8"));

/** Its text blobs by bucket key, decoded with the app's own decoder. */
const blobs = ((): Map<string, PageText> => {
	const raw = JSON.parse(readFileSync(join(dir, "search-texts.json"), "utf8")) as Record<string, unknown>;
	const out = new Map<string, PageText>();
	for (const [key, value] of Object.entries(raw)) out.set(key, decodePageText(JSON.stringify(value)));
	return out;
})();

interface Golden {
	query: string;
	doc?: string;
	folder?: string;
	limit?: number;
	hits: unknown[];
}

const golden = JSON.parse(readFileSync(join(dir, "search-hits.go.json"), "utf8")) as Golden[];

interface StubSource extends SearchSource {
	/** Text reads so far: a rebuild shows up as more of them. */
	reads: number;
	/** Bumps the generation, as a sync or a refresh does. */
	bump: () => void;
}

/** A source that answers from an index and its text blobs. */
function stub(start: Index, texts: Map<string, PageText> = blobs): StubSource {
	const ix = start;
	let gen = 1;
	const s: StubSource = {
		reads: 0,
		index: async (): Promise<Index> => ix,
		pageText: async (d: Doc): Promise<PageText> => {
			s.reads++;
			const pt = texts.get(d.key);
			if (pt === undefined) throw new Error(`no text blob for ${d.key}`);
			return pt;
		},
		generation: (): number => gen,
		bump: (): void => {
			gen++;
		},
	};
	return s;
}

function library(source: SearchSource = stub(fixture)) {
	const { log, lines } = createTestLog();
	return { lib: createLibrary({ source, log }), lines };
}

function docByKey(ix: Index, key: string): Doc {
	const d = ix.docs.find((x) => x.key === key);
	if (d === undefined) throw new Error(`${key} not in the fixture index`);
	return d;
}

function hitJSON(hits: unknown): string {
	return JSON.stringify(hits, null, 2);
}

describe("search", () => {
	for (const q of golden) {
		const what = [
			q.query,
			q.folder === undefined ? "" : `in ${q.folder}`,
			q.doc === undefined ? "" : `in doc ${q.doc}`,
			q.limit === undefined ? "" : `limit ${q.limit}`,
		]
			.filter((s) => s !== "")
			.join(", ");
		it(`gives Go's hits for ${JSON.stringify(what)}`, async () => {
			const { lib } = library();
			const options: SearchOptions = q.doc === undefined ? {} : { doc: q.doc };
			if (q.folder !== undefined) options.folder = q.folder;
			if (q.limit !== undefined) options.limit = q.limit;
			expect(hitJSON(await lib.search(q.query, options))).toBe(hitJSON(q.hits));
		});
	}

	it("puts the fridge's defrost page first, with the snippet, folder and page", async () => {
		const { lib } = library();
		const hits = await lib.search("how do I defrost the freezer?");
		expect(hits).toHaveLength(1);
		const top = hits[0];
		expect(top?.name).toBe("Fridge.pdf");
		expect(top?.page).toBe(2);
		expect(top?.folder).toBe("4.0 Manuals/4.2 Kitchen");
		expect(top?.snippet).toContain("defrost the freezer");
	});

	it("folds plurals and takes a folder with or without slashes in any case", async () => {
		const { lib } = library();
		expect((await lib.search("socket")).map((h) => h.name)).toEqual(["1.3 Power.pdf"]);
		expect((await lib.search("sockets")).map((h) => h.name)).toEqual(["1.3 Power.pdf"]);
		expect((await lib.search("socket", { folder: "/1.0 PLANS/" })).map((h) => h.name)).toEqual(["1.3 Power.pdf"]);
		expect(await lib.search("socket", { folder: "1.0 plans/" })).toHaveLength(1);
		expect(await lib.search("socket", { folder: "4.0 manuals" })).toHaveLength(0);
	});

	it("leaves a document whose text can't be read out, with a warning", async () => {
		const { lib, lines } = library();
		expect(await lib.search("blob")).toHaveLength(0); // only that page says "blob"
		const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(logged).toContainEqual(
			expect.objectContaining({
				level: "WARN",
				msg: "document text unreadable; left out of search",
				key: "docs/raw/8.0 Broken/NoText.pdf",
			}),
		);
	});

	it("keeps the last build until the index generation moves, then rebuilds", async () => {
		const source = stub(fixture);
		const { lib } = library(source);
		await lib.search("warranty");
		const reads = source.reads;
		expect(reads).toBeGreaterThan(0);
		await lib.search("warranty");
		expect(source.reads).toBe(reads); // nothing to rebuild: no text read again
		source.bump();
		await lib.search("warranty");
		expect(source.reads).toBe(reads * 2);
	});

	it("sees a document once its text is readable and the publication moves", async () => {
		const texts = new Map(blobs);
		const source = stub(fixture, texts);
		const { lib } = library(source);
		expect(await lib.search("blob")).toHaveLength(0);
		const key = "docs/raw/8.0 Broken/NoText.pdf";
		texts.set(key, {
			key,
			etag: docByKey(fixture, key).etag,
			pages: [{ n: 1, w: 595, h: 842, text: `This page says blob${" more".repeat(30)}` }],
		});
		// Still the stale build: the page was not read again.
		expect(await lib.search("blob")).toHaveLength(0);
		source.bump();
		expect((await lib.search("blob")).map((h) => h.name)).toEqual(["NoText.pdf"]);
	});

	it("finds a document a real sync added", async () => {
		const store = createMemoryStore();
		const conv = new FakeConverter();
		const { log } = createTestLog();
		const sync = createSyncer({ store, converter: conv, log, now: () => new Date("2026-11-11T03:00:00Z") });
		const lib = createLibrary({ source: sync, log });
		conv.pages.set("pdf-warranty", [
			{
				n: 1,
				w: 595,
				h: 842,
				text: `Warranty: 12 months from the date of handover for all fittings.${" more".repeat(30)}`,
			},
		]);
		expect(await lib.search("warranty handover")).toHaveLength(0);
		await store.putBlob(
			"docs/raw/6.0 General/Warranty.pdf",
			new TextEncoder().encode("pdf-warranty"),
			"application/pdf",
		);
		await sync.sync("test");
		const hits = await lib.search("warranty handover");
		expect(hits.map((h) => h.name)).toEqual(["Warranty.pdf"]);
	});

	it("cuts the snippet in characters when lowercasing changes the length", async () => {
		const key = "docs/raw/odd.pdf";
		const d: Doc = {
			...emptyDoc(key, "0dd00001"),
			etag: '"1"',
			size: 10,
			pages: 1,
			class: CLASS_TEXT,
			status: STATUS_OK,
		};
		const ix: Index = { schema: 1, docs: [d], lastSync: null, updated: "" };
		const text = `${"Ⱥ".repeat(120)} valve`; // Ⱥ lowercases to ⱥ: one character, three bytes
		const texts = new Map<string, PageText>([[key, { key, etag: d.etag, pages: [{ n: 1, w: 595, h: 842, text }] }]]);
		const { lib } = library(stub(ix, texts));
		const hits = await lib.search("valve");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.snippet.endsWith("valve")).toBe(true);
		expect(hits[0]?.snippet.startsWith("…")).toBe(true); // it starts 80 characters before the match
	});
});

describe("page", () => {
	it("returns the page of a readable document and null for one it doesn't have", async () => {
		const { lib } = library();
		const oven = docByKey(fixture, "docs/raw/4.0 Manuals/4.2 Kitchen/Oven.pdf");
		const one = await lib.page(oven.id, 1);
		expect(one.doc?.id).toBe(oven.id);
		expect(one.page?.text).toContain("pyrolytic");
		const seven = await lib.page(oven.id, 7);
		expect(seven.doc?.id).toBe(oven.id);
		expect(seven.page).toBeNull();
	});

	it("is null for an unknown, removed or unreadable document", async () => {
		const { lib } = library();
		expect(await lib.page("nope", 1)).toEqual({ doc: null, page: null });
		// Removed: the record is in the index but not readable.
		expect(await lib.page(docByKey(fixture, "docs/raw/9.0 Long/Gone.pdf").id, 1)).toEqual({ doc: null, page: null });
		// A scanned document is still readable page by page (only search leaves it out).
		const scanned = await lib.page(docByKey(fixture, "docs/raw/4.0 Manuals/Heater (scanned).pdf").id, 2);
		expect(scanned.page?.text ?? "").toBe("x");
	});
});
