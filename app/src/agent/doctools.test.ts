// The document tools and the view tool (T3.3): Go's result and error texts, the
// 8000-rune page cut, the no-text-layer note, the region echoed inside the tool
// result and the PNG that goes with it. Port of internal/agent/doctools_test.go
// (TestDocumentToolErrors, the page truncation, TestViewDocumentPage) on a fake
// library and a fake viewer: no bucket, no poppler.
import { describe, expect, it } from "vitest";
import { CLASS_DRAWING, CLASS_TEXT, type Doc, emptyDoc, STATUS_OK } from "../docs/index.ts";
import { VIEW_EDGE, type View, type Viewer } from "../docs/render.ts";
import type { Hit, Library } from "../docs/search.ts";
import type { Page, Region } from "../docs/types.ts";
import type { ToolContext, ToolResult, ToolSpec } from "../durable/adapter.ts";
import { goMarshal } from "../gojson.ts";
import { docTools, MAX_PAGE_CHARS, NO_TEXT_LAYER, viewTool } from "./doctools.ts";

const FRIDGE_KEY = "docs/raw/4.0 Manuals/Fridge.pdf";
const PLAN_KEY = "docs/raw/1.0 Plans/1.3 Power.pdf";

function doc(key: string, id: string, over: Partial<Doc> = {}): Doc {
	return { ...emptyDoc(key, id), pages: 2, class: CLASS_TEXT, status: STATUS_OK, ...over };
}

function pageOf(n: number, text: string): Page {
	return { n, w: 595, h: 842, text };
}

interface LibraryOptions {
	hits?: Hit[];
	doc?: Doc | null;
	page?: Page | null;
}

function fakeLibrary(o: LibraryOptions = {}): Library {
	const known = o.doc ?? null;
	return {
		search: async () => o.hits ?? [],
		// An unknown id is the library's "no such document", as Go's Page reports it.
		page: async (id) =>
			known === null || known.id !== id ? { doc: null, page: null } : { doc: known, page: o.page ?? null },
	};
}

/** A viewer that renders one small PNG and echoes what it was asked for. */
function fakeViewer(o: { doc?: Doc; words?: string[]; fail?: Error } = {}): Viewer {
	const rendered: { id: string; n: number; region: Region | null }[] = [];
	const viewer: Viewer = {
		view: async (id, n, region = null): Promise<View> => {
			rendered.push({ id, n, region });
			if (o.fail !== undefined) throw o.fail;
			return {
				doc: o.doc ?? doc(PLAN_KEY, "plan", { class: CLASS_DRAWING }),
				page: n,
				region,
				png: new Uint8Array([137, 80, 78, 71]),
				words: o.words ?? [],
				w: 2384,
				h: 1684,
			};
		},
		cache: () => ({ pdfs: 0, pdfBytes: 0, views: rendered.length, viewBytes: 0 }),
	};
	return viewer;
}

function context(over: Partial<ToolContext> = {}): ToolContext {
	return {
		conversationKey: "web:zy@example.com",
		taskId: "1",
		callId: "call_1",
		epoch: "epoch-1",
		signal: undefined,
		actor: { by: "zy@example.com", channel: "web" },
		...over,
	};
}

async function call(tool: ToolSpec, args: unknown): Promise<ToolResult> {
	return await tool.execute(args, context());
}

function byName(tools: ToolSpec[], name: string): ToolSpec {
	const found = tools.find((tool) => tool.name === name);
	if (found === undefined) throw new Error(`no tool ${name}`);
	return found;
}

describe("search_documents", () => {
	it("answers the hits with Go's field order and omits an empty folder", async () => {
		const hits: Hit[] = [
			{ doc: "fridge", name: "Fridge.pdf", folder: "4.0 Manuals", page: 2, score: 1.5, snippet: "…defrost…" },
			{ doc: "top", name: "Top.pdf", page: 1, score: 0.25, snippet: "x" },
		];
		const out = await call(byName(docTools(fakeLibrary({ hits })), "search_documents"), { query: "defrost" });
		expect(out.text).toBe(
			'{"hits":[{"doc":"fridge","name":"Fridge.pdf","folder":"4.0 Manuals","page":2,"score":1.5,"snippet":"…defrost…"},' +
				'{"doc":"top","name":"Top.pdf","page":1,"score":0.25,"snippet":"x"}]}',
		);
	});

	it("answers an empty list, never null", async () => {
		const out = await call(byName(docTools(fakeLibrary()), "search_documents"), { query: "nothing" });
		expect(out.text).toBe('{"hits":[]}');
	});

	it("requires a query with Go's text, and passes the filters through", async () => {
		const seen: unknown[] = [];
		const library: Library = {
			search: async (_q, options) => {
				seen.push(options);
				return [];
			},
			page: async () => ({ doc: null, page: null }),
		};
		const tool = byName(docTools(library), "search_documents");
		expect(await call(tool, {})).toEqual({ text: '{"error":"query is required"}', error: true });
		expect(await call(tool, { query: "   " })).toEqual({ text: '{"error":"query is required"}', error: true });
		await call(tool, { query: "board", doc: "plan", folder: "1.0 Plans", limit: 3 });
		expect(seen).toEqual([{ doc: "plan", folder: "1.0 Plans", limit: 3 }]);
	});
});

describe("read_document_page", () => {
	it("answers the page in Go's field order", async () => {
		const fridge = doc(FRIDGE_KEY, "fridge");
		const tool = byName(
			docTools(fakeLibrary({ doc: fridge, page: pageOf(2, "Defrosting: defrost the freezer every six months.") })),
			"read_document_page",
		);
		const out = await call(tool, { doc: "fridge", page: 2 });
		expect(out.text).toBe(
			'{"class":"text","doc":"fridge","folder":"4.0 Manuals","name":"Fridge.pdf","page":2,"pages":2,' +
				'"text":"Defrosting: defrost the freezer every six months."}',
		);
	});

	it("cuts a page at 8000 code points and says so", async () => {
		const long = "ü".repeat(MAX_PAGE_CHARS + 10);
		const tool = byName(
			docTools(fakeLibrary({ doc: doc(FRIDGE_KEY, "fridge"), page: pageOf(1, long) })),
			"read_document_page",
		);
		const out = await call(tool, { doc: "fridge", page: 1 });
		const parsed = JSON.parse(out.text) as { text: string; truncated?: boolean };
		expect([...parsed.text]).toHaveLength(MAX_PAGE_CHARS);
		expect(parsed.truncated).toBe(true);
		// Go's map is alphabetical, so truncated is the last key.
		expect(out.text.endsWith(',"truncated":true}')).toBe(true);
	});

	it("says when a page has no text layer", async () => {
		const tool = byName(
			docTools(fakeLibrary({ doc: doc(FRIDGE_KEY, "fridge"), page: pageOf(1, " \n ") })),
			"read_document_page",
		);
		const out = await call(tool, { doc: "fridge", page: 1 });
		const parsed = JSON.parse(out.text) as { note: string };
		expect(parsed.note).toBe(NO_TEXT_LAYER);
		expect(NO_TEXT_LAYER).toBe("this page has no text layer (it may be a picture); it can't be read as text yet");
	});

	it("answers Go's two not-found texts", async () => {
		const fridge = doc(FRIDGE_KEY, "fridge");
		const tool = byName(docTools(fakeLibrary({ doc: fridge, page: null })), "read_document_page");
		expect(await call(tool, { doc: "nope", page: 1 })).toEqual({
			text: '{"error":"no document \\"nope\\"; use an id from the documents list"}',
			error: true,
		});
		expect(await call(tool, { doc: "fridge", page: 9 })).toEqual({
			text: '{"error":"Fridge.pdf has 2 pages; there is no page 9"}',
			error: true,
		});
	});
});

describe("view_document_page", () => {
	it("echoes the region inside the result and returns one PNG", async () => {
		const viewer = fakeViewer({ words: ["DB", "distribution", "board"] });
		const out = await call(viewTool(viewer), {
			doc: "plan",
			page: 1,
			region: { x0: 0, y0: 0, x1: 0.5, y1: 0.5 },
		});
		// The region keeps its struct order, not the alphabetical one (Go's Region).
		expect(out.text).toBe(
			'{"class":"drawing","doc":"plan","name":"1.3 Power.pdf","page":1,"pages":2,' +
				'"region":{"x0":0,"y0":0,"x1":0.5,"y1":0.5},"words":["DB","distribution","board"]}',
		);
		expect(out.images).toEqual([{ mediaType: "image/png", data: new Uint8Array([137, 80, 78, 71]) }]);
		expect(VIEW_EDGE).toBe(1568);
	});

	it("has no region key without one, and answers words as [] not null", async () => {
		const out = await call(viewTool(fakeViewer()), { doc: "plan", page: 1 });
		expect(out.text).not.toContain("region");
		expect(out.text).toContain('"words":[]');
	});

	it("passes the viewer's refusal through as Go's error result", async () => {
		const viewer = fakeViewer({ fail: new Error('not viewable: no document "nope"') });
		expect(await call(viewTool(viewer), { doc: "nope", page: 1 })).toEqual({
			text: '{"error":"not viewable: no document \\"nope\\""}',
			error: true,
		});
	});
});

describe("the tool list", () => {
	it("is byte-identical whether or not any document is synced", () => {
		// The declarations depend only on the build, never on the index, which is
		// what keeps the cached prompt prefix stable (Go's TestDocumentToolsOnClaude
		// half, doctools_test.go:107).
		const empty = docTools(fakeLibrary());
		const synced = docTools(fakeLibrary({ hits: [], doc: doc(FRIDGE_KEY, "fridge"), page: pageOf(1, "text") }));
		const asGo = (tools: ToolSpec[]): string =>
			goMarshal(
				tools.map((tool) => ({
					type: "function",
					function: { name: tool.name, description: tool.description, parameters: tool.parameters },
				})),
			);
		expect(asGo(synced)).toBe(asGo(empty));
		expect(empty.map((tool) => tool.name)).toEqual(["search_documents", "read_document_page"]);
		expect(viewTool(fakeViewer()).name).toBe("view_document_page");
	});
});
