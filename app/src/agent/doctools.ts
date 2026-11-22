// The document tools: search_documents and read_document_page, plus the vision
// tool view_document_page. Port of internal/agent/doctools.go (agent-spec §2.3);
// the field order and every text are Go's, because the model reads these bytes.
//
// The documents are Go's `*docs.Library` and `*docs.Viewer`, ported in T1.5 and
// reused here unchanged: the tools only decide what to ask them and how to spell
// the answer. Nothing here imports pi-durable.

import { docFolder, docName } from "../docs/index.ts";
import type { Viewer } from "../docs/render.ts";
import type { Hit, Library } from "../docs/search.ts";
import type { Region } from "../docs/types.ts";
import type { ToolContext, ToolResult, ToolSpec } from "../durable/adapter.ts";
import { goMarshal, Ordered } from "../gojson.ts";
import { goQuote, goTrimSpace } from "../gostr.ts";
import { errorMessage } from "../log.ts";

/** read_document_page returns at most this many code points of one page (Go's MaxPageChars). */
export const MAX_PAGE_CHARS = 8000;

/** What a page without text is answered with: it may be a picture, which needs the vision tool. */
export const NO_TEXT_LAYER = "this page has no text layer (it may be a picture); it can't be read as text yet";

/** A tool's body: the JSON result's text for the model, and the images it hands over. */
type Handler = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

/**
 * docTools is Go's DocTools: offered whenever documents are on, whether or not a
 * document is synced yet, so the tool list — part of the cached prompt prefix —
 * does not change when the first document arrives (doctools_test.go:107).
 */
export function docTools(docs: Library): ToolSpec[] {
	return [
		spec({
			name: "search_documents",
			description:
				"Search the text of the owners' documents (floor plans and M&E drawings, checklists, letters, user manuals). Returns the best-matching pages with a snippet. Use specific words from the question.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "words to look for" },
					doc: { type: "string", description: "limit to one document id from the documents list" },
					folder: { type: "string", description: "limit to a folder, e.g. 4.0 Operating Instructions" },
					limit: { type: "integer" },
				},
				required: ["query"],
			},
			run: (args, ctx) => searchDocuments(docs, args, ctx),
		}),
		spec({
			name: "read_document_page",
			description: "Read the full text of one page of a document (ids from the documents list or search_documents).",
			parameters: {
				type: "object",
				properties: { doc: { type: "string" }, page: { type: "integer", description: "1-based" } },
				required: ["doc", "page"],
			},
			run: (args, ctx) => readDocumentPage(docs, args, ctx),
		}),
	];
}

/**
 * viewTool is Go's ViewTool: offered only when the connection takes images
 * (doctools.go:28-30) and a viewer exists. The vision half is the per-turn
 * `needsVision` flag, because the setting can change between turns (T3.5);
 * the adapter drops the tool from a turn whose connection has no vision.
 */
export function viewTool(viewer: Viewer): ToolSpec {
	return spec({
		name: "view_document_page",
		needsVision: true,
		description:
			"Look at a page of a document as an image, with the words printed inside the area. For drawings: look at the whole sheet first, then pass a region to zoom in and read small labels. Region coordinates are fractions of the page's width and height from the top-left corner (0 to 1).",
		parameters: {
			type: "object",
			properties: {
				doc: { type: "string" },
				page: { type: "integer", description: "1-based" },
				region: {
					type: "object",
					properties: {
						x0: { type: "number" },
						y0: { type: "number" },
						x1: { type: "number" },
						y1: { type: "number" },
					},
					required: ["x0", "y0", "x1", "y1"],
				},
			},
			required: ["doc", "page"],
		},
		run: (args, ctx) => viewDocumentPage(viewer, args, ctx),
	});
}

/** spec fills in the shared fields; a document tool writes nothing, so it is replay-safe. */
function spec(o: {
	name: string;
	description: string;
	parameters: object;
	needsVision?: boolean;
	run: Handler;
}): ToolSpec {
	return {
		name: o.name,
		description: o.description,
		parameters: o.parameters,
		replay: "safe",
		writes: false,
		...(o.needsVision === true ? { needsVision: true } : {}),
		execute: async (args, ctx) => {
			try {
				return await o.run(args, ctx);
			} catch (err) {
				return { text: goMarshal({ error: errorMessage(err) }), error: true };
			}
		},
	};
}

function argsObj(args: unknown): Record<string, unknown> {
	return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
}

/** Go's `int(n)` of a float64 argument, or 0 when it is not a number. */
function intArg(v: unknown): number {
	return typeof v === "number" ? Math.trunc(v) : 0;
}

async function searchDocuments(docs: Library, args: unknown, ctx: ToolContext): Promise<ToolResult> {
	const call = argsObj(args);
	const query = typeof call.query === "string" ? call.query : "";
	if (goTrimSpace(query) === "") throw new Error("query is required");
	const hits = await docs.search(
		query,
		{
			doc: typeof call.doc === "string" ? call.doc : "",
			folder: typeof call.folder === "string" ? call.folder : "",
			limit: intArg(call.limit),
		},
		ctx.signal,
	);
	// `hits` is [] and never null (doctools.go:92-94).
	return { text: goMarshal({ hits: hits.map(hitJson) }) };
}

/** hitJson is Go's docs.Hit in struct order: doc, name, folder?, page, score, snippet. */
function hitJson(hit: Hit): Ordered {
	const parts: (readonly [string, unknown])[] = [
		["doc", hit.doc],
		["name", hit.name],
	];
	if (hit.folder !== undefined && hit.folder !== "") parts.push(["folder", hit.folder]);
	parts.push(["page", hit.page], ["score", hit.score], ["snippet", hit.snippet]);
	return new Ordered(parts);
}

async function readDocumentPage(docs: Library, args: unknown, ctx: ToolContext): Promise<ToolResult> {
	const call = argsObj(args);
	const id = typeof call.doc === "string" ? call.doc : "";
	const n = intArg(call.page);
	const found = await docs.page(id, n, ctx.signal);
	if (found.doc === null) throw new Error(`no document ${goQuote(id)}; use an id from the documents list`);
	const doc = found.doc;
	if (found.page === null) throw new Error(`${docName(doc)} has ${doc.pages} pages; there is no page ${n}`);
	const whole = found.page.text;
	const runes = [...whole];
	const text = runes.length > MAX_PAGE_CHARS ? runes.slice(0, MAX_PAGE_CHARS).join("") : whole;
	const parts: (readonly [string, unknown])[] = [
		["class", doc.class],
		["doc", doc.id],
		["folder", docFolder(doc)],
		["name", docName(doc)],
	];
	if (goTrimSpace(text) === "") parts.push(["note", NO_TEXT_LAYER]);
	parts.push(["page", found.page.n], ["pages", doc.pages], ["text", text]);
	if (runes.length > MAX_PAGE_CHARS) parts.push(["truncated", true]);
	return { text: goMarshal(new Ordered(parts)) };
}

async function viewDocumentPage(viewer: Viewer, args: unknown, ctx: ToolContext): Promise<ToolResult> {
	const call = argsObj(args);
	const id = typeof call.doc === "string" ? call.doc : "";
	const n = intArg(call.page);
	// Go takes a region of the right shape and lets the viewer judge the values.
	const raw = call.region;
	const region: Region | null =
		typeof raw === "object" && raw !== null && !Array.isArray(raw)
			? {
					x0: numberArg((raw as Record<string, unknown>).x0),
					y0: numberArg((raw as Record<string, unknown>).y0),
					x1: numberArg((raw as Record<string, unknown>).x1),
					y1: numberArg((raw as Record<string, unknown>).y1),
				}
			: null;
	const view = await viewer.view(id, n, region, ctx.signal);
	const parts: (readonly [string, unknown])[] = [
		["class", view.doc.class],
		["doc", view.doc.id],
		["name", docName(view.doc)],
		["page", view.page],
		["pages", view.doc.pages],
	];
	if (region !== null) {
		// Go marshals its Region struct: x0, y0, x1, y1, not alphabetical.
		parts.push([
			"region",
			new Ordered([
				["x0", region.x0],
				["y0", region.y0],
				["x1", region.x1],
				["y1", region.y1],
			]),
		]);
	}
	// `words` is [] and never null (doctools.go:68-70).
	parts.push(["words", view.words]);
	return { text: goMarshal(new Ordered(parts)), images: [{ mediaType: "image/png", data: view.png }] };
}

function numberArg(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
