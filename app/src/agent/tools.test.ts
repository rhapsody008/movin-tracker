// The entry tools (T3.3): Go's schemas byte for byte, the result and error
// texts, the change lines with their undo ids, the replay-safe change IDs, the
// 30-entry cap and the 30-hit search limit. Port of internal/agent/
// tools_test.go's cases on a memory store: no harness, no model, no network.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Actor, ToolContext, ToolResult, ToolSpec } from "../durable/adapter.ts";
import { createEntriesService, type EntriesService } from "../entries/service.ts";
import { goMarshal } from "../gojson.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { buildTools, MAX_ADD_ENTRIES } from "./tools.ts";

const GOLDEN = readFileSync(join(import.meta.dirname, "testdata", "tools.go.json"), "utf8");

interface Rig {
	entries: EntriesService;
	tools: ToolSpec[];
	/** One call, the way the adapter runs it: a fresh task id unless the test passes one. */
	call: (name: string, args: unknown, ctx?: Partial<ToolContext>) => Promise<ToolResult>;
}

let task = 0;

function rig(): Rig {
	const { log } = createTestLog();
	const entries = createEntriesService({
		store: createMemoryStore(),
		log,
		now: () => new Date("2026-11-11T09:00:00Z"),
	});
	const tools = buildTools({ entries });
	const call = async (name: string, args: unknown, over: Partial<ToolContext> = {}): Promise<ToolResult> => {
		const tool = tools.find((t) => t.name === name);
		if (tool === undefined) throw new Error(`no tool ${name}`);
		task++;
		return await tool.execute(args, {
			conversationKey: "web:zy@example.com",
			taskId: String(task),
			callId: `call_${task}`,
			epoch: "epoch-1",
			signal: undefined,
			actor: { by: "zy@example.com", channel: "web" },
			...over,
		});
	};
	return { entries, tools, call };
}

const partner: Actor = { by: "partner", channel: "telegram" };

describe("the tool list", () => {
	it("is Go's five declarations, byte for byte, in Go's order", () => {
		const { tools } = rig();
		expect(tools.map((tool) => tool.name)).toEqual([
			"add_entry",
			"update_entry",
			"search_entries",
			"set_dates",
			"undo_change",
		]);
		// Exactly what Go sends (`type`, `function.{name,description,parameters}`);
		// pi-ai adds `strict:false` later, which the adapter's wire test pins.
		const asGo = tools.map((tool) => ({
			type: "function",
			function: { name: tool.name, description: tool.description, parameters: tool.parameters },
		}));
		expect(goMarshal(asGo)).toBe(GOLDEN);
	});

	it("offers the document tools only with documents, and marks the view tool for vision", () => {
		const { entries } = rig();
		const docs = { search: async () => [], page: async () => ({ doc: null, page: null }) };
		const viewer = { view: async () => ({}) } as never;
		expect(buildTools({ entries }).map((tool) => tool.name)).toHaveLength(5);
		expect(
			buildTools({ entries, docs })
				.map((tool) => tool.name)
				.slice(5),
		).toEqual(["search_documents", "read_document_page"]);
		// The view tool is registered whenever a viewer exists and is offered per
		// turn by the connection's vision (T3.5), so it carries the flag rather than
		// being left out here.
		const withViewer = buildTools({ entries, docs, viewer });
		expect(withViewer.map((tool) => tool.name)).toHaveLength(8);
		expect(withViewer.at(-1)?.name).toBe("view_document_page");
		expect(withViewer.filter((tool) => tool.needsVision === true).map((tool) => tool.name)).toEqual([
			"view_document_page",
		]);
	});

	it("carries milestone and completed with their descriptions (TestMilestoneToolSchema)", () => {
		const { tools } = rig();
		const add = tools.find((tool) => tool.name === "add_entry");
		if (add === undefined) throw new Error("no add_entry");
		const properties = (
			add.parameters as {
				properties: { entries: { items: { properties: Record<string, { description?: string }> } } };
			}
		).properties.entries.items.properties;
		expect(Object.keys(properties)).toEqual([
			"kind",
			"title",
			"room",
			"category",
			"status",
			"estimate",
			"actual",
			"vendor",
			"date",
			"time",
			"source",
			"notes",
			"tags",
			"milestone",
			"completed",
		]);
		expect(properties.milestone?.description).toBe("a notable step for the milestones history");
		expect(properties.completed?.description).toBe(
			"YYYY-MM-DD it was done; set automatically when status becomes done",
		);
	});

	it("marks only the four writes, and every tool replaysafe", () => {
		const { tools } = rig();
		expect(tools.filter((tool) => tool.writes).map((tool) => tool.name)).toEqual([
			"add_entry",
			"update_entry",
			"set_dates",
			"undo_change",
		]);
		expect(tools.every((tool) => tool.replay === "safe")).toBe(true);
	});
});

describe("add_entry", () => {
	it("returns the created ids and Go's change lines with their undo ids", async () => {
		const r = rig();
		const out = await r.call(
			"add_entry",
			{
				entries: [
					{ kind: "idea", title: "Quartz countertop", room: "wet kitchen", estimate: 3000 },
					{ kind: "task", title: "Electrician visit", date: "2026-11-14", time: "14:00" },
				],
			},
			{ actor: partner },
		);

		const created = JSON.parse(out.text) as { created: { id: string; title: string }[] };
		expect(created.created.map((e) => e.title)).toEqual(["Quartz countertop", "Electrician visit"]);
		expect(out.error).toBeUndefined();
		expect(out.changes?.map((line) => line.text)).toEqual([
			"Saved: wet kitchen · idea · Quartz countertop · est $3,000",
			"Saved: task · Electrician visit · Sat, 14 Nov 14:00",
		]);

		const snapshot = await r.entries.current();
		// Every change line carries its journal id, which is what Undo uses.
		for (const line of out.changes ?? []) {
			expect(line.id).toBeDefined();
			expect(snapshot.doc.changes.some((change) => change.id === line.id)).toBe(true);
		}
		for (const entry of snapshot.doc.entries) {
			expect([entry.by, entry.channel]).toEqual(["partner", "telegram"]);
		}
	});

	it("records a milestone through the tools with its done day (TestMilestonesThroughTheTools)", async () => {
		const r = rig();
		const out = await r.call("add_entry", {
			entries: [{ kind: "task", title: "Keys collected", status: "done", milestone: true }],
		});
		const entry = (await r.entries.current()).doc.entries[0];
		expect(entry).toMatchObject({ status: "done", milestone: true, completed: "2026-11-11" });
		// The done day and the star come last in Summary's order.
		expect(out.changes?.[0]?.text).toBe("Saved: task · Keys collected · done Wed, 11 Nov · ★ milestone");
	});

	it("truncates more than 30 entries to 30", async () => {
		const r = rig();
		const entries = Array.from({ length: MAX_ADD_ENTRIES + 1 }, (_, i) => ({ kind: "idea", title: `Item ${i}` }));
		const out = await r.call("add_entry", { entries });
		const created = JSON.parse(out.text) as { created: { id: string; title: string }[] };
		expect(created.created).toHaveLength(30);
		expect(created.created.at(-1)?.title).toBe("Item 29");
	});

	it("replays instead of writing twice when the same task runs again", async () => {
		const r = rig();
		const args = { entries: [{ kind: "idea", title: "Quartz countertop" }] };
		const first = await r.call("add_entry", args, { taskId: "7", epoch: "e" });
		const second = await r.call("add_entry", args, { taskId: "7", epoch: "e" });
		expect(second.text).toBe(first.text);
		expect(second.changes).toEqual(first.changes);
		const snapshot = await r.entries.current();
		expect(snapshot.doc.entries).toHaveLength(1);
		expect(snapshot.doc.changes).toHaveLength(1);
	});

	it("answers a bad batch with Go's error result, not a throw", async () => {
		const r = rig();
		expect(await r.call("add_entry", {})).toEqual({
			text: '{"error":"entries must be a non-empty array"}',
			error: true,
		});
		expect(await r.call("add_entry", { entries: ["nope"] })).toEqual({
			text: '{"error":"each entry must be an object"}',
			error: true,
		});
		const bad = await r.call("add_entry", { entries: [{ kind: "idea", title: "x", room: "garage" }] });
		expect(bad.error).toBe(true);
		expect(bad.text).toContain('"error"');
		expect(bad.text).toContain("room must be one of");
		expect((await r.entries.current()).doc.entries).toHaveLength(0);
	});
});

describe("update_entry and search_entries", () => {
	it("updates with a stray key ignored and searches by a filter", async () => {
		const r = rig();
		const created = JSON.parse(
			(
				await r.call("add_entry", {
					entries: [{ kind: "task", title: "Carpentry", vendor: "Lim", estimate: 18000 }],
				})
			).text,
		) as { created: { id: string }[] };
		const id = created.created[0]?.id ?? "";

		const found = await r.call("search_entries", { vendor: "lim" });
		expect(found.text).toContain('"total":1');
		// Go's map order: entries before total.
		expect(found.text.startsWith('{"entries":[')).toBe(true);

		const updated = await r.call("update_entry", { id, actual: 5400, status: "doing", stray: "ignored" });
		expect(updated.changes?.map((line) => line.text)).toEqual(["Updated: Carpentry (status doing, paid $5,400)"]);
		const parsed = JSON.parse(updated.text) as { ok: boolean; entry: { actual: number; category?: string } };
		expect(parsed.ok).toBe(true);
		expect(parsed.entry.actual).toBe(5400);
		expect(parsed.entry.category).toBeUndefined();

		const archived = await r.call("update_entry", { id, archived: true });
		expect(archived.changes?.map((line) => line.text)).toEqual(["Archived: Carpentry"]);
	});

	it("cuts a long note to 300 code points in a result", async () => {
		const r = rig();
		const notes = "ü".repeat(400);
		const created = JSON.parse(
			(await r.call("add_entry", { entries: [{ kind: "note", title: "Long", notes }] })).text,
		) as { created: { id: string }[] };
		const out = await r.call("update_entry", { id: created.created[0]?.id, title: "Longer" });
		const entry = (JSON.parse(out.text) as { entry: { notes: string } }).entry;
		expect([...entry.notes]).toHaveLength(300);
	});

	it("limits a search to 30 hits and reports the total", async () => {
		const r = rig();
		// Two calls, because one add_entry is capped at 30 (Go's cap).
		await r.call("add_entry", {
			entries: Array.from({ length: 30 }, (_, i) => ({ kind: "idea", title: `Item ${i}` })),
		});
		await r.call("add_entry", {
			entries: Array.from({ length: 5 }, (_, i) => ({ kind: "idea", title: `Extra ${i}` })),
		});
		const out = await r.call("search_entries", {});
		const found = JSON.parse(out.text) as { entries: unknown[]; total: number };
		expect(found.total).toBe(35);
		expect(found.entries).toHaveLength(30);
		// An explicit limit is honoured, and a zero falls back to the tool's 30.
		const one = JSON.parse((await r.call("search_entries", { limit: 1 })).text) as { entries: unknown[] };
		expect(one.entries).toHaveLength(1);
	});

	it("answers an empty patch and bad arguments with Go's texts", async () => {
		const r = rig();
		const created = JSON.parse((await r.call("add_entry", { entries: [{ kind: "idea", title: "x" }] })).text) as {
			created: { id: string }[];
		};
		const id = created.created[0]?.id ?? "";
		expect(await r.call("update_entry", { id })).toEqual({
			text: '{"error":"pass at least one field to change"}',
			error: true,
		});
		expect(await r.call("update_entry", {})).toEqual({ text: '{"error":"id is required"}', error: true });
		expect(await r.call("update_entry", { id: "nope", title: "y" })).toEqual({
			text: '{"error":"no entry with that id: nope"}',
			error: true,
		});
		const bad = await r.call("search_entries", { limit: "many" });
		expect(bad.error).toBe(true);
		expect(bad.text).toContain('"error":"bad search arguments: limit must be a whole number"');
	});
});

describe("set_dates", () => {
	it("answers the bare JSON string ok and a change line with no id, and writes no journal record", async () => {
		const r = rig();
		const out = await r.call("set_dates", { move_in: "2026-12-05", key_collection: "2026-10-29" });
		expect(out.text).toBe('"ok"');
		expect(out.changes).toEqual([{ text: "Move-in set to Sat, 5 Dec" }, { text: "Key collection set to Thu, 29 Oct" }]);
		const snapshot = await r.entries.current();
		expect(snapshot.doc.meta).toEqual({ moveDate: "2026-12-05", keyDate: "2026-10-29" });
		// Go's SetMeta is not journaled (tools.go:240), and neither is v3's.
		expect(snapshot.doc.changes).toEqual([]);
	});

	it("leaves the latest change undoable: add, set the move-in date, undo undoes the add", async () => {
		const r = rig();
		await r.call("add_entry", { entries: [{ kind: "idea", title: "Fluted glass" }] });
		await r.call("set_dates", { move_in: "2026-12-05" });
		const out = await r.call("undo_change", {});
		expect(out.error).toBeUndefined();
		expect(out.changes?.map((line) => line.text)).toEqual(["Undone: removed Fluted glass"]);
		const snapshot = await r.entries.current();
		expect(snapshot.doc.entries).toEqual([]);
		expect(snapshot.doc.meta.moveDate).toBe("2026-12-05");
	});

	it("rerun after a crash just writes the same dates again", async () => {
		const r = rig();
		const args = { move_in: "2026-12-05" };
		const first = await r.call("set_dates", args, { taskId: "9" });
		const second = await r.call("set_dates", args, { taskId: "9" });
		expect(second).toEqual(first);
		const snapshot = await r.entries.current();
		expect(snapshot.doc.meta.moveDate).toBe("2026-12-05");
		expect(snapshot.doc.changes).toEqual([]);
	});

	it("answers Go's errors", async () => {
		const r = rig();
		expect(await r.call("set_dates", {})).toEqual({
			text: '{"error":"pass move_in or key_collection"}',
			error: true,
		});
		expect(await r.call("set_dates", { move_in: "5 Dec" })).toEqual({
			text: '{"error":"move_in must be YYYY-MM-DD"}',
			error: true,
		});
		expect(await r.call("set_dates", { key_collection: "2026-13-01" })).toEqual({
			text: '{"error":"key_collection must be YYYY-MM-DD"}',
			error: true,
		});
	});
});

describe("undo_change", () => {
	it("without an id undoes the caller's own latest change, not the partner's", async () => {
		const r = rig();
		const mine = JSON.parse(
			(await r.call("add_entry", { entries: [{ kind: "idea", title: "Mine" }] }, { actor: partner })).text,
		) as { created: { id: string }[] };
		await r.call(
			"add_entry",
			{ entries: [{ kind: "idea", title: "Theirs" }] },
			{
				actor: { by: "zy@example.com", channel: "telegram" },
			},
		);

		const out = await r.call("undo_change", {}, { actor: partner });
		expect(out.changes?.map((line) => line.text)).toEqual(["Undone: removed Mine"]);
		const undone = JSON.parse(out.text) as { ok: boolean; undone: string };
		expect(undone).toEqual({ ok: true, undone: "Undone: removed Mine" });
		const snapshot = await r.entries.current();
		expect(snapshot.doc.entries.map((entry) => entry.title)).toEqual(["Theirs"]);
		expect(snapshot.doc.entries.some((entry) => entry.id === mine.created[0]?.id)).toBe(false);
	});

	it("with no change of the caller's own answers Go's text", async () => {
		const r = rig();
		await r.call("add_entry", { entries: [{ kind: "idea", title: "Theirs" }] }, { actor: partner });
		expect(await r.call("undo_change", {}, { actor: { by: "zy@example.com", channel: "web" } })).toEqual({
			text: '{"error":"there is no recent change by you to undo"}',
			error: true,
		});
	});

	it("names the change it undoes by its journal id", async () => {
		const r = rig();
		const added = await r.call("add_entry", { entries: [{ kind: "idea", title: "Mine" }] });
		const changedId = added.changes?.[0]?.id ?? "";
		const out = await r.call("undo_change", { change_id: changedId });
		expect(out.changes?.[0]?.id).toBeDefined();
		expect(out.changes?.[0]?.id).not.toBe(changedId);
		expect(out.changes?.[0]?.text).toBe("Undone: removed Mine");
	});
});
