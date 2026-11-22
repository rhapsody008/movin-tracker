// The entry tools: Go's add_entry, update_entry, search_entries, set_dates and
// undo_change. Port of internal/agent/tools.go (agent-spec §2.3), with the
// schema bytes pinned against internal/agent/testdata/openai_requests.golden
// (copied to src/agent/testdata/tools.go.json) so the model reads exactly what
// it read from the Go app.
//
// Nothing here imports pi-durable: a tool is a ToolSpec, which the adapter
// registers, and an error is a result (`{"error":"…"}`), never a throw — Go's
// exec wraps every failure that way so the model can correct itself
// (TestToolErrorsGoBackToTheModel).
//
// Writes are replay-safe: the change ID comes from the run's `epoch|taskId` and
// the call's arguments, and the entries service returns its earlier record
// instead of writing twice (decisions.md, "Change ID carries the args hash").

import type { Viewer } from "../docs/render.ts";
import type { Library } from "../docs/search.ts";
import type { Actor, ChangeLine, ToolContext, ToolResult, ToolSpec } from "../durable/adapter.ts";
import { ChangeText, fmtDate } from "../entries/changetext.ts";
import { type Change, type Entry, KINDS, type MetaPatch, type Patch, PLAN_STATUSES, ROOMS } from "../entries/model.ts";
import { decodeFilter, searchEntries } from "../entries/search.ts";
import type { EntriesService, Replay } from "../entries/service.ts";
import { goMarshal, Ordered } from "../gojson.ts";
import { errorMessage } from "../log.ts";
import { validDate } from "../sched.ts";
import { docTools, viewTool } from "./doctools.ts";

/** Go's allStatuses: the plan statuses plus the task-only ones (tools.go:27). */
const ALL_STATUSES: readonly string[] = [...PLAN_STATUSES, "todo", "doing"];

/** More new entries than this in one call are dropped, as Go does (tools.go:167-169). */
export const MAX_ADD_ENTRIES = 30;

/** Notes are cut to this many code points in a tool result (Go's `compact(e, 300)`). */
const NOTES_IN_RESULT = 300;

/** `search_entries` defaults its limit to 30, not 50: Filter's default is for the web (tools.go:219-221). */
const SEARCH_LIMIT = 30;

/**
 * One entry property, in Go's order and with Go's words: the same object is
 * used by add_entry (inside `entries[].items`) and by update_entry, and its
 * serialised bytes are part of the cached prompt prefix.
 */
const ENTRY_PROPERTIES = {
	kind: { type: "string", enum: KINDS },
	title: { type: "string", description: "short, specific" },
	room: { type: "string", enum: ["", ...ROOMS] },
	category: { type: "string" },
	status: { type: "string", enum: ALL_STATUSES },
	estimate: { type: "number", description: "SGD quote or expected price" },
	actual: { type: "number", description: "SGD paid so far" },
	vendor: { type: "string" },
	date: { type: "string", description: "YYYY-MM-DD" },
	time: { type: "string", description: "HH:MM 24h; needs a date" },
	source: { type: "string" },
	notes: { type: "string" },
	tags: { type: "array", items: { type: "string" } },
	milestone: { type: "boolean", description: "a notable step for the milestones history" },
	completed: { type: "string", description: "YYYY-MM-DD it was done; set automatically when status becomes done" },
};

/** What buildTools needs: the entries service, and the documents when the feature is on. */
export interface BuildToolsOptions {
	entries: EntriesService;
	/** null or absent: documents are off, so the two document tools are not offered. */
	docs?: Library | null;
	/** null or absent: no page images, so there is no view tool to register. */
	viewer?: Viewer | null;
}

/**
 * buildTools is Go's `r.tools(cfg)` (doctools.go:38-47): the five entry tools,
 * then search_documents and read_document_page when documents are on, then
 * view_document_page when a viewer is there. Go decides the view tool on the
 * connection's vision too, and v3 decides that per turn instead (the tool is
 * marked `needsVision` and the adapter drops it for a connection without
 * vision), because the setting can change while the registry cannot. The order
 * is part of the cached prompt prefix and is asserted (the golden).
 */
export function buildTools(o: BuildToolsOptions): ToolSpec[] {
	const tools = entryTools(o.entries);
	if (o.docs !== undefined && o.docs !== null) {
		tools.push(...docTools(o.docs));
		if (o.viewer !== undefined && o.viewer !== null) tools.push(viewTool(o.viewer));
	}
	return tools;
}

/** entryTools is Go's Tools: the five entry tools, in Go's order. */
export function entryTools(entries: EntriesService): ToolSpec[] {
	return [
		spec({
			name: "add_entry",
			description: "Record one or more new entries. Returns their ids.",
			parameters: {
				type: "object",
				properties: {
					entries: {
						type: "array",
						items: {
							type: "object",
							properties: ENTRY_PROPERTIES,
							required: ["kind", "title"],
						},
					},
				},
				required: ["entries"],
			},
			writes: true,
			run: (args, ctx) => addEntry(entries, args, ctx),
		}),
		spec({
			name: "update_entry",
			description:
				"Change fields of an existing entry by id. Only pass fields that change; null clears a field. archived=true drops it from view (recoverable).",
			parameters: {
				type: "object",
				properties: { id: { type: "string" }, ...ENTRY_PROPERTIES, archived: { type: "boolean" } },
				required: ["id"],
			},
			writes: true,
			run: (args, ctx) => updateEntry(entries, args, ctx),
		}),
		spec({
			name: "search_entries",
			description:
				"Find entries by structured filters and/or words. All filters are optional and combine with AND; list filters match any of their values (tags must all match).",
			parameters: {
				type: "object",
				properties: {
					kinds: { type: "array", items: { type: "string", enum: KINDS } },
					rooms: { type: "array", items: { type: "string", enum: ROOMS } },
					statuses: { type: "array", items: { type: "string", enum: ALL_STATUSES } },
					category: { type: "string" },
					tags: { type: "array", items: { type: "string" } },
					vendor: { type: "string" },
					text: { type: "string", description: "words that must all appear in the entry" },
					date_from: { type: "string", description: "YYYY-MM-DD" },
					date_to: { type: "string", description: "YYYY-MM-DD" },
					milestone: {
						type: "boolean",
						description: "true: only milestones (flagged and done); false: leave them out",
					},
					include_archived: { type: "boolean" },
					limit: { type: "integer" },
				},
			},
			writes: false,
			run: (args) => searchEntriesTool(entries, args),
		}),
		spec({
			name: "set_dates",
			description: "Set the move-in date and/or the key collection date (YYYY-MM-DD). Pass only the ones that change.",
			parameters: { type: "object", properties: { move_in: { type: "string" }, key_collection: { type: "string" } } },
			writes: true,
			run: (args) => setDates(entries, args),
		}),
		spec({
			name: "undo_change",
			description: "Undo a change. Without change_id, undoes the latest change by the person asking.",
			parameters: { type: "object", properties: { change_id: { type: "string" } } },
			writes: true,
			run: (args, ctx) => undoChange(entries, args, ctx),
		}),
	];
}

/** A tool's body: the JSON result's text for the model, plus the change lines the user sees. */
type Handler = (args: unknown, ctx: ToolContext) => Promise<ToolResult>;

/** spec fills in the shared fields and turns a thrown error into Go's result (tools.go:104-110). */
function spec(o: { name: string; description: string; parameters: object; writes: boolean; run: Handler }): ToolSpec {
	return {
		name: o.name,
		description: o.description,
		parameters: o.parameters,
		// A read tool is replay-safe because it writes nothing; a write tool
		// because its change ID dedupes (plan.md · Tools).
		replay: "safe",
		writes: o.writes,
		execute: async (args, ctx) => {
			try {
				return await o.run(args, ctx);
			} catch (err) {
				// Go's error path is a result, so the model can correct itself; the
				// images of a failed call are dropped with it.
				return { text: goMarshal({ error: errorMessage(err) }), error: true };
			}
		},
	};
}

/** argsObj is Go's `map[string]any` from the call's arguments. */
function argsObj(args: unknown): Record<string, unknown> {
	return isObject(args) ? args : {};
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** replay is the run's identity for one call: the entries service hashes the args into the ID. */
function replayOf(ctx: ToolContext, args: unknown): Replay {
	return { key: `${ctx.epoch}|${ctx.taskId}`, args };
}

/** The actor a write stamps; the adapter blocks a write tool that has none (beforeTool). */
function actorOf(ctx: ToolContext): Actor {
	if (ctx.actor === undefined) throw new Error("writes need a known person; this message has none");
	return ctx.actor;
}

/** lines maps the journal records a write produced to Go's ChangeLine (tools.go:155-161). */
function lines(changes: readonly Change[]): ChangeLine[] {
	return changes.map((change) => ({ id: change.id, text: ChangeText(change) }));
}

/** Go's entryFields: the properties a tool may write, in the order Go checks them. */
const ENTRY_FIELDS = [
	"kind",
	"title",
	"room",
	"category",
	"status",
	"vendor",
	"date",
	"time",
	"source",
	"notes",
	"tags",
	"milestone",
	"completed",
] as const;

/**
 * entryPatch keeps only the fields the tools allow, so stray keys from the
 * model are ignored rather than rejected (Go's entryPatch, tools.go:128-152):
 * estimate and actual become cost, and archived is only allowed for an update.
 */
function entryPatch(args: Record<string, unknown>, allowArchived: boolean): Patch {
	const keep: Record<string, unknown> = {};
	for (const field of ENTRY_FIELDS) {
		if (Object.hasOwn(args, field)) keep[field] = args[field];
	}
	const cost: Record<string, unknown> = {};
	for (const field of ["estimate", "actual"]) {
		if (Object.hasOwn(args, field)) cost[field] = args[field];
	}
	if (Object.keys(cost).length > 0) keep.cost = cost;
	if (allowArchived && Object.hasOwn(args, "archived")) keep.archived = args.archived;
	return keep;
}

async function addEntry(entries: EntriesService, args: unknown, ctx: ToolContext): Promise<ToolResult> {
	const given = argsObj(args).entries;
	const raw = Array.isArray(given) ? given : [];
	if (raw.length === 0) throw new Error("entries must be a non-empty array");
	const patches: Patch[] = [];
	for (const item of raw.slice(0, MAX_ADD_ENTRIES)) {
		if (!isObject(item)) throw new Error("each entry must be an object");
		patches.push(entryPatch(item, false));
	}
	const res = await entries.create(actorOf(ctx), patches, replayOf(ctx, args));
	const created = res.entries.map((entry) => ({ id: entry.id, title: entry.title }));
	return { text: goMarshal({ created }), changes: lines(res.changes) };
}

async function updateEntry(entries: EntriesService, args: unknown, ctx: ToolContext): Promise<ToolResult> {
	const call = argsObj(args);
	const id = typeof call.id === "string" ? call.id : "";
	if (id === "") throw new Error("id is required");
	const patch = entryPatch(call, true);
	if (Object.keys(patch).length === 0) throw new Error("pass at least one field to change");
	const res = await entries.update(actorOf(ctx), id, patch, replayOf(ctx, args));
	const entry = res.entries[0];
	if (entry === undefined) throw new Error(`no entry with that id: ${id}`);
	// Go's map: alphabetical, so entry then ok; the entry's own bytes are
	// compactEntry's struct order, with notes cut to 300.
	return { text: goMarshal({ entry: compactEntry(entry, NOTES_IN_RESULT), ok: true }), changes: lines(res.changes) };
}

async function searchEntriesTool(entries: EntriesService, args: unknown): Promise<ToolResult> {
	let filter: ReturnType<typeof decodeFilter>;
	try {
		filter = decodeFilter(args);
	} catch (err) {
		// Go wraps its decode failure in `bad search arguments` (tools.go:215-218).
		throw new Error(`bad search arguments: ${errorMessage(err)}`);
	}
	if ((filter.limit ?? 0) <= 0) filter.limit = SEARCH_LIMIT;
	const snapshot = await entries.current();
	const found = searchEntries(snapshot.doc, filter);
	return {
		// Go's map is alphabetical: entries before total.
		text: goMarshal({
			entries: found.entries.map((entry) => compactEntry(entry, NOTES_IN_RESULT)),
			total: found.total,
		}),
	};
}

async function setDates(entries: EntriesService, args: unknown): Promise<ToolResult> {
	const call = argsObj(args);
	const patch: MetaPatch = {};
	const changes: ChangeLine[] = [];
	const move = call.move_in;
	if (typeof move === "string" && move !== "") {
		if (!validDate(move)) throw new Error("move_in must be YYYY-MM-DD");
		patch.moveDate = move;
		changes.push({ text: `Move-in set to ${fmtDate(move)}` });
	}
	const keys = call.key_collection;
	if (typeof keys === "string" && keys !== "") {
		if (!validDate(keys)) throw new Error("key_collection must be YYYY-MM-DD");
		patch.keyDate = keys;
		changes.push({ text: `Key collection set to ${fmtDate(keys)}` });
	}
	if (patch.moveDate === undefined && patch.keyDate === undefined) throw new Error("pass move_in or key_collection");
	// Not journaled, as in Go (tools.go:240): the change line has no id, an undo
	// without an id still reaches the latest entry change, and a rerun after a
	// crash just writes the same dates again (decisions.md, T3.3 finding 1).
	await entries.setMeta(patch);
	// Go returns the bare JSON string "ok", not an object (agent-spec §10.9).
	return { text: goMarshal("ok"), changes };
}

async function undoChange(entries: EntriesService, args: unknown, ctx: ToolContext): Promise<ToolResult> {
	const actor = actorOf(ctx);
	const call = argsObj(args);
	let id = typeof call.change_id === "string" ? call.change_id : "";
	if (id === "") {
		// Only the caller's own latest change: Go's Recent(1, a.By) filters by
		// author (journal.go:112-126).
		const recent = await entries.recent(1, actor.by);
		const found = recent[0];
		if (found === undefined) throw new Error("there is no recent change by you to undo");
		id = found.id;
	}
	const res = await entries.undo(actor, id, replayOf(ctx, args));
	const undone = lines(res.changes);
	return { text: goMarshal({ ok: true, undone: undone[0]?.text ?? "" }), changes: undone };
}

/** Go's compactEntry: the fields the model reads in a result, with notes cut (prompt.go:27-51). */
export function compactEntry(entry: Entry, notesLen: number): Ordered {
	const parts: (readonly [string, unknown])[] = [
		["id", entry.id],
		["kind", entry.kind],
		["title", entry.title],
	];
	// Go's omitempty: a nil room, an empty category, no date, no money.
	if (entry.room !== null) parts.push(["room", entry.room]);
	if (entry.category !== "") parts.push(["category", entry.category]);
	parts.push(["status", entry.status]);
	if (entry.date !== null) parts.push(["date", entry.date]);
	if (entry.time !== null) parts.push(["time", entry.time]);
	if (entry.vendor !== "") parts.push(["vendor", entry.vendor]);
	if (entry.cost.estimate !== null) parts.push(["estimate", entry.cost.estimate]);
	if (entry.cost.actual !== null) parts.push(["actual", entry.cost.actual]);
	// Go cuts notes to notesLen and omitempty drops an empty result, which is how
	// the prompt snapshot leaves them out (prompt.go:38, :81).
	if (entry.notes !== "" && notesLen > 0) parts.push(["notes", cutRunes(entry.notes, notesLen)]);
	if (entry.archived) parts.push(["archived", true]);
	// Last, so entries without them keep their exact line (prompt cache).
	if (entry.milestone) parts.push(["milestone", true]);
	if (entry.completed !== null) parts.push(["completed", entry.completed]);
	return new Ordered(parts);
}

/** cutRunes is Go's `[]rune(s)[:n]` cut: whole code points, never half a character. */
function cutRunes(s: string, n: number): string {
	const runes = [...s];
	return runes.length <= n ? s : runes.slice(0, n).join("");
}
