// The prompt (T3.4): Go's texts and v3's layout. The rules, documents section,
// date and group line are compared with app/golden/t34/main.go's bytes; the snapshot
// selection and the deltas are Go's prompt.go rules moved into the user
// message. Port of internal/agent/prompt_test.go's cases (which no longer has
// its own file in Go: the rules and snapshot live in milestone_test.go and
// golden_test.go) plus v3's delta cases.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLASS_DRAWING,
	CLASS_SCANNED,
	CLASS_TEXT,
	type Doc as DocsDoc,
	emptyDoc as emptyDocsDoc,
	type Index,
	STATUS_OK,
	STATUS_REMOVED,
} from "../docs/index.ts";
import type { ChangeLine, RunResult } from "../durable/adapter.ts";
import { type Doc, type Entry, emptyDoc, newEntry, ROOMS } from "../entries/model.ts";
import { createEntriesService, type EntriesService, type Result } from "../entries/service.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import {
	changedSince,
	dateLine,
	documentsSection,
	GROUP_LINE,
	promptHooks,
	SILENT_REPLY,
	seenLines,
	snapshotText,
} from "./prompt.ts";

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "prompt.go.json"), "utf8")) as Record<
	string,
	string
>;

const FIXED = new Date("2026-11-11T09:00:00Z");

function entry(over: Partial<Entry>): Entry {
	const e = newEntry(over.kind ?? "idea");
	return {
		...e,
		id: "id",
		title: "Entry",
		status: "idea",
		created: "2026-01-01T00:00:00Z",
		updated: "2026-06-01T00:00:00Z",
		...over,
	};
}

/** goldenDoc is app/golden/t34/main.go's fixture: 173 live entries and three archived. */
function goldenDoc(): Doc {
	const doc = emptyDoc();
	const start = Date.UTC(2026, 0, 1, 0, 0, 0);
	const updatedStart = Date.UTC(2026, 5, 1, 0, 0, 0);
	for (let i = 0; i < 173; i++) {
		const e = entry({
			id: `id-${String(i).padStart(3, "0")}`,
			title: `Entry ${String(i).padStart(3, "0")}`,
			category: "carpentry",
			vendor: "StoneWorks",
			room: ROOMS[i % ROOMS.length] ?? null,
			cost: { estimate: 1000 + i, actual: null },
			created: rfc3339(start + i * 60_000),
			updated: rfc3339(updatedStart + i * 3_600_000),
			by: "zy",
			channel: "web",
		});
		if (i === 23) e.notes = "call the vendor before Friday";
		if (i === 30) {
			e.kind = "task";
			e.status = "done";
			e.milestone = true;
			e.completed = "2026-11-10";
		}
		if (i === 31) {
			e.date = "2026-11-14";
			e.time = "14:00";
		}
		doc.entries.push(e);
	}
	for (let i = 0; i < 3; i++) {
		doc.entries.push(
			entry({
				id: `arch-${String(i).padStart(3, "0")}`,
				kind: "note",
				title: `Archived ${String(i).padStart(3, "0")}`,
				archived: true,
				updated: "2027-01-01T00:00:00Z",
			}),
		);
	}
	return doc;
}

function rfc3339(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function docsIndex(): Index {
	const doc = (key: string, id: string, over: Partial<DocsDoc>): DocsDoc => ({
		...emptyDocsDoc(key, id),
		pages: 2,
		class: CLASS_TEXT,
		status: STATUS_OK,
		...over,
	});
	return {
		schema: 1,
		docs: [
			doc("docs/raw/4.0 Manuals/Fridge.pdf", "fridge", {
				pages: 2,
				class: CLASS_TEXT,
				summary: "How to defrost the freezer.",
			}),
			doc("docs/raw/1.0 Plans/1.3 Power.pdf", "plan", { pages: 1, class: CLASS_DRAWING }),
			doc("docs/raw/2.0 Letters/Handover.pdf", "scan", {
				pages: 4,
				class: CLASS_SCANNED,
				summary: "Handover checklist.",
			}),
			doc("docs/raw/9.0 Old/Gone.pdf", "gone", { pages: 1, status: STATUS_REMOVED }),
		],
		lastSync: null,
		updated: "",
	};
}

async function service(doc: Doc): Promise<EntriesService> {
	const entries = createEntriesService({
		store: createMemoryStore(),
		log: createTestLog().log,
		now: () => FIXED,
		timeZone: "UTC",
	});
	await entries.replace(doc);
	return entries;
}

/** lineOf is the change line a write really makes: the journal record's id. */
function lineOf(result: Result, text: string): ChangeLine {
	const record = result.changes[0];
	if (record === undefined) throw new Error("the write made no record");
	return { id: record.id, text };
}

function answered(changes: readonly ChangeLine[]): RunResult {
	return {
		status: "answered",
		text: "",
		stop: "end",
		usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
		changes: [...changes],
		toolsUsed: [],
	};
}

describe("the rules", () => {
	it("equal Go's text with the one recorded replacement", async () => {
		const hooks = promptHooks({ entries: await service(emptyDoc()), log: createTestLog().log });
		return hooks.instructions?.("web:zy@example.com", { group: false, vision: false }).then((rules) => {
			expect(rules).toBe(GOLDEN.rules_v3 ?? "");
			expect(rules).not.toContain("when the list above is not enough");
			expect(rules).toContain("when the snapshot is not enough");
		});
	});
});

describe("the documents section", () => {
	it("is Go's text with and without vision, and absent for an empty index", () => {
		expect(documentsSection(docsIndex(), { viewer: true, vision: false })).toBe(GOLDEN.documents ?? "");
		expect(documentsSection(docsIndex(), { viewer: false, vision: true })).toBe(GOLDEN.documents ?? "");
		expect(documentsSection(docsIndex(), { viewer: true, vision: true })).toBe(GOLDEN.documents_vision ?? "");
		expect(
			documentsSection({ schema: 1, docs: [], lastSync: null, updated: "" }, { viewer: false, vision: false }),
		).toBe(GOLDEN.documents_empty ?? "");
	});

	it("is absent, not empty, when the index read fails, and the failure is logged", async () => {
		const { log, lines } = createTestLog();
		const hooks = promptHooks({
			entries: await service(emptyDoc()),
			log,
			docs: {
				index: async () => {
					throw new Error("the index is gone");
				},
			},
		});
		const rules = await hooks.instructions?.("web:zy@example.com", { group: false, vision: false });
		expect(rules).toBe(GOLDEN.rules_v3 ?? "");
		const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(logged.some((line) => line.msg === "documents index unavailable for the prompt")).toBe(true);
	});

	it("sits between the rules and the group line", async () => {
		const hooks = promptHooks({
			entries: await service(emptyDoc()),
			log: createTestLog().log,
			docs: { index: async () => docsIndex() },
		});
		const system = await hooks.instructions?.("tg:1", { group: true, vision: false });
		if (system === undefined) throw new Error("no instructions");
		expect(system.indexOf("\n\nDocuments (")).toBeGreaterThan(0);
		expect(system.indexOf("\n\nDocuments (")).toBeLessThan(system.indexOf("\nThis is a group chat"));
	});

	it("adds the vision sentence only for a turn whose connection takes images (T3.5)", async () => {
		// Go decided this from cfg.Vision when the runner was built; the setting can
		// change between turns here, so it arrives with the turn's own options.
		const hooks = promptHooks({
			entries: await service(emptyDoc()),
			log: createTestLog().log,
			docs: { index: async () => docsIndex() },
			viewer: true,
		});
		expect(await hooks.instructions?.("web:zy@example.com", { group: false, vision: true })).toBe(
			`${GOLDEN.rules_v3 ?? ""}${GOLDEN.documents_vision ?? ""}`,
		);
		expect(await hooks.instructions?.("web:zy@example.com", { group: false, vision: false })).toBe(
			`${GOLDEN.rules_v3 ?? ""}${GOLDEN.documents ?? ""}`,
		);
		// Without a viewer there is no tool to describe, whatever the connection says.
		const noViewer = promptHooks({
			entries: await service(emptyDoc()),
			log: createTestLog().log,
			docs: { index: async () => docsIndex() },
		});
		expect(await noViewer.instructions?.("web:zy@example.com", { group: false, vision: true })).toBe(
			`${GOLDEN.rules_v3 ?? ""}${GOLDEN.documents ?? ""}`,
		);
	});
});

describe("the date and group parts", () => {
	it("is Go's date line, with not set for a missing date", () => {
		expect(dateLine({ keyDate: "2026-10-29", moveDate: null }, FIXED, "UTC")).toBe((GOLDEN.date ?? "").slice(1));
		expect(dateLine({ keyDate: null, moveDate: null }, FIXED, "UTC")).toBe(
			"Today is 2026-11-11 (Wednesday). Key collection: not set. Move-in: not set.",
		);
	});

	it("moves across midnight in the configured zone", () => {
		// 16:30 UTC is 00:30 the next day in Singapore.
		const at = new Date("2026-11-11T16:30:00Z");
		expect(dateLine({ keyDate: null, moveDate: null }, at, "Asia/Singapore")).toBe(
			"Today is 2026-11-12 (Thursday). Key collection: not set. Move-in: not set.",
		);
		expect(dateLine({ keyDate: null, moveDate: null }, at, "UTC")).toBe(
			"Today is 2026-11-11 (Wednesday). Key collection: not set. Move-in: not set.",
		);
	});

	it("is Go's group line, in a group only (TestGroupSilence)", async () => {
		expect(GROUP_LINE).toBe((GOLDEN.group ?? "").slice((GOLDEN.date ?? "").length));
		expect(GROUP_LINE).toContain("group chat");
		expect(GROUP_LINE).toContain(SILENT_REPLY);
		const hooks = promptHooks({ entries: await service(emptyDoc()), log: createTestLog().log });
		expect(await hooks.instructions?.("tg:1", { group: true, vision: false })).toContain("group chat");
		expect(await hooks.instructions?.("web:zy@example.com", { group: false, vision: false })).not.toContain(
			"group chat",
		);
	});
});

describe("the entries snapshot", () => {
	it("matches Go's selection and bytes (the long header, notes left out, milestone last)", () => {
		const doc = goldenDoc();
		const text = snapshotText(doc);
		expect(text).toBe(GOLDEN.snapshot_v3 ?? "");
		const json = text.slice(text.indexOf("["));
		const lines = JSON.parse(json) as { id: string; milestone?: boolean; completed?: string; notes?: string }[];
		expect(lines).toHaveLength(150);
		// Drop archived, most recently updated 150, then created order: id-023 .. id-172.
		expect(lines[0]?.id).toBe("id-023");
		expect(lines.at(-1)?.id).toBe("id-172");
		expect(lines.some((line) => line.id.startsWith("arch-"))).toBe(false);
		expect(lines.some((line) => line.notes !== undefined)).toBe(false);
		expect(lines.find((line) => line.id === "id-030")).toMatchObject({
			milestone: true,
			completed: "2026-11-10",
		});
	});

	it("uses the short header below the limit, and lists an empty document", () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "b", title: "Second", created: "2026-01-02T00:00:00Z" }));
		doc.entries.push(entry({ id: "a", title: "First", created: "2026-01-01T00:00:00Z" }));
		expect(snapshotText(doc)).toBe(
			'Entries snapshot: [{"id":"a","kind":"idea","title":"First","status":"idea"},' +
				'{"id":"b","kind":"idea","title":"Second","status":"idea"}]',
		);
		expect(snapshotText(emptyDoc())).toBe("Entries snapshot: []");
	});
});

describe("the deltas", () => {
	it("has no block when nothing changed", () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "a", title: "A" }));
		expect(changedSince(seenLines(doc), doc)).toBe("");
	});

	it("says updated once for a line that changed, in created order", () => {
		const doc = emptyDoc();
		doc.entries.push(
			entry({ id: "a", title: "A", created: "2026-01-01T00:00:00Z" }),
			entry({ id: "b", title: "B", created: "2026-01-02T00:00:00Z" }),
			entry({ id: "c", title: "C", created: "2026-01-03T00:00:00Z" }),
		);
		const seen = seenLines(doc);
		doc.entries[2] = { ...doc.entries[2], title: "C2" } as Entry;
		doc.entries[0] = { ...doc.entries[0], title: "A2" } as Entry;
		expect(changedSince(seen, doc)).toBe(
			"Changed since your last message:\n" +
				'- updated {"id":"a","kind":"idea","title":"A2","status":"idea"}\n' +
				'- updated {"id":"c","kind":"idea","title":"C2","status":"idea"}',
		);
	});

	it("says added for a new live entry and removed for an archived or deleted one", () => {
		const doc = emptyDoc();
		doc.entries.push(
			entry({ id: "a", title: "A" }),
			entry({ id: "b", title: "B" }),
			entry({ id: "c", title: "C", created: "2026-01-03T00:00:00Z" }),
		);
		const seen = seenLines(doc);
		doc.entries[0] = { ...doc.entries[0], archived: true } as Entry;
		const removed = doc.entries[1] as Entry;
		// A delete leaves its entry in the journal's `before`, which is where the
		// prompt finds the creation time of an entry that is no longer in the doc.
		doc.changes.push({
			id: "chg",
			at: "2026-01-02T00:00:00Z",
			by: "partner",
			channel: "telegram",
			op: "delete",
			entryId: "b",
			before: removed,
			after: null,
		});
		doc.entries = doc.entries.filter((e) => e.id !== "b");
		doc.entries.push(entry({ id: "d", title: "D", created: "2026-01-04T00:00:00Z" }));
		expect(changedSince(seen, doc)).toBe(
			"Changed since your last message:\n" +
				'- removed a "A"\n' +
				'- removed b "B"\n' +
				'- added {"id":"d","kind":"idea","title":"D","status":"idea"}',
		);
	});
});

describe("the hooks", () => {
	it("puts the snapshot, the date and the typed text in the first message, and only the date later", async () => {
		const doc = emptyDoc();
		doc.meta = { keyDate: "2026-10-29", moveDate: null };
		doc.entries.push(entry({ id: "a", title: "A" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });

		const first = await hooks.userContent?.("web:zy@example.com", "hello", {
			fresh: true,
			group: false,
			state: null,
		});
		if (first === undefined) throw new Error("no userContent");
		expect(first.content).toBe(`${snapshotText(doc)}\n\n${dateLine(doc.meta, FIXED, "UTC")}\n\nhello`);
		expect(first.state).toEqual({ seen: seenLines(doc) });

		const later = await hooks.userContent?.("web:zy@example.com", "again", {
			fresh: false,
			group: false,
			state: first.state,
		});
		if (later === undefined) throw new Error("no userContent");
		expect(later.content).toBe(`${dateLine(doc.meta, FIXED, "UTC")}\n\nagain`);
	});

	it("puts the pending notes under one header line, after the delta and before the date", async () => {
		const doc = emptyDoc();
		doc.meta = { keyDate: "2026-10-29", moveDate: null };
		doc.entries.push(entry({ id: "a", title: "A" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const checkin = "(morning check-in) Good morning. Today: nothing due.\n\nAsked about:\n• Yesterday: Book movers";

		const first = await hooks.userContent?.("k", "hello", {
			fresh: true,
			group: false,
			state: null,
			notes: [{ tag: "checkin", text: checkin }],
		});
		if (first === undefined) throw new Error("no userContent");
		// The exact bytes: the snapshot, the notes block, the date line, the message.
		expect(first.content).toBe(
			`${snapshotText(doc)}\n\nSent to this chat since your last message:\n${checkin}\n\n${dateLine(doc.meta, FIXED, "UTC")}\n\nhello`,
		);

		// Two notes are one block, separated by a blank line; the same turn without
		// notes is exactly what it was before notes existed.
		const later = await hooks.userContent?.("k", "again", {
			fresh: false,
			group: false,
			state: first.state,
			notes: [
				{ tag: "checkin", text: "(morning check-in) one" },
				{ tag: "notice", text: "(documents updated) two" },
			],
		});
		if (later === undefined) throw new Error("no userContent");
		expect(later.content).toBe(
			`Sent to this chat since your last message:\n(morning check-in) one\n\n(documents updated) two\n\n${dateLine(doc.meta, FIXED, "UTC")}\n\nagain`,
		);

		const plain = await hooks.userContent?.("k", "again", { fresh: false, group: false, state: first.state });
		if (plain === undefined) throw new Error("no userContent");
		expect(plain.content).toBe(`${dateLine(doc.meta, FIXED, "UTC")}\n\nagain`);
	});

	it("shows one edit from elsewhere as exactly one updated line", async () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "a", title: "A" }), entry({ id: "b", title: "B" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");

		const id = doc.entries[0]?.id ?? "";
		await entries.update({ by: "partner", channel: "telegram" }, id, { title: "A changed" });
		const later = await hooks.userContent?.("k", "two", { fresh: false, group: false, state: first.state });
		if (later === undefined) throw new Error("no userContent");
		const delta = later.content.split("\n\n")[0] ?? "";
		expect(delta).toBe(
			"Changed since your last message:\n" + '- updated {"id":"a","kind":"idea","title":"A changed","status":"idea"}',
		);
	});

	it("does not echo the run's own write after afterRun (own add_entry)", async () => {
		const entries = await service(emptyDoc());
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");
		const written = await entries.create({ by: "zy@example.com", channel: "web" }, [{ kind: "idea", title: "Quartz" }]);
		const created = (await entries.current()).doc.entries[0];
		if (created === undefined) throw new Error("not created");
		const state = await hooks.afterRun?.("k", answered([lineOf(written, "Saved: idea · Quartz")]), first.state);
		const later = await hooks.userContent?.("k", "two", { fresh: false, group: false, state });
		if (later === undefined) throw new Error("no userContent");
		expect(later.content).not.toContain("Changed since your last message");
	});

	it("advances seen from the run's own journal record, not from a later edit (P5a)", async () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "a", title: "A" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");

		// The agent updates X in its run…
		const written = await entries.update({ by: "zy@example.com", channel: "web" }, "a", { title: "A by the agent" });
		// …and the partner edits the same entry before the run settles.
		await entries.update({ by: "partner", channel: "telegram" }, "a", { title: "A by the partner" });

		const state = await hooks.afterRun?.("k", answered([lineOf(written, "Updated: A (title)")]), first.state);
		const later = await hooks.userContent?.("k", "two", { fresh: false, group: false, state });
		if (later === undefined) throw new Error("no userContent");
		const delta = later.content.split("\n\n")[0] ?? "";
		// The model was told what its own write made, so the partner's edit is the one
		// delta — exactly one line for X, and it is the partner's version.
		expect(delta).toContain("- updated ");
		expect(delta.match(/- updated /g)).toHaveLength(1);
		expect(delta).toContain('"title":"A by the partner"');
	});

	it("treats a change line without a journal id as touching no entry (set_dates)", async () => {
		const entries = await service(emptyDoc());
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");
		const state = await hooks.afterRun?.("k", answered([{ text: "Move-in set to Sat, 5 Dec" }]), first.state);
		// Go never journaled it, so there is nothing to advance: the state is the same.
		expect(state).toBe(first.state);
	});

	it("shows a partner's archive as a removed line, and drops the agent's own archive from seen", async () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "a", title: "A" }), entry({ id: "b", title: "B" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");

		// The partner archives B on the board: the next turn's delta says so.
		await entries.update({ by: "partner", channel: "telegram" }, "b", { archived: true });
		const later = await hooks.userContent?.("k", "two", { fresh: false, group: false, state: first.state });
		if (later === undefined) throw new Error("no userContent");
		expect(later.content).toContain('Changed since your last message:\n- removed b "B"');

		// The agent archives A itself: its record's `after` is the archived entry, which
		// is not a live line, so `seen` drops it (as a delete does) and the next turn
		// does not echo the agent's own archive back at it.
		const written = await entries.update({ by: "zy@example.com", channel: "web" }, "a", { archived: true });
		const state = await hooks.afterRun?.("k", answered([lineOf(written, "Archived: A")]), later.state);
		const third = await hooks.userContent?.("k", "three", { fresh: false, group: false, state });
		if (third === undefined) throw new Error("no userContent");
		expect(third.content).not.toContain("removed");
	});

	it("rebuilds seen and sends the snapshot again on a fresh context", async () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "a", title: "A" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");
		const fresh = await hooks.userContent?.("k", "two", { fresh: true, group: false, state: first.state });
		if (fresh === undefined) throw new Error("no userContent");
		expect(fresh.content.startsWith(snapshotText(doc))).toBe(true);
		expect(fresh.state).toEqual({ seen: seenLines(doc) });
	});

	it("keeps a key-date change out of the deltas (it shows only in the date line)", async () => {
		const doc = emptyDoc();
		doc.entries.push(entry({ id: "a", title: "A" }));
		const entries = await service(doc);
		const hooks = promptHooks({ entries, log: createTestLog().log, timeZone: "UTC", now: () => FIXED });
		const first = await hooks.userContent?.("k", "one", { fresh: true, group: false, state: null });
		if (first === undefined) throw new Error("no userContent");
		await entries.setMeta({ keyDate: "2026-10-29" });
		const later = await hooks.userContent?.("k", "two", { fresh: false, group: false, state: first.state });
		if (later === undefined) throw new Error("no userContent");
		expect(later.content).not.toContain("Changed since your last message");
		expect(later.content).toContain("Key collection: 2026-10-29");
	});
});
