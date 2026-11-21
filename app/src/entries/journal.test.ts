// The journal on its own: append and cap, the byte comparison undo relies on,
// the three kinds of undo and the recent list. Port of journal.go with
// journal_test.go folded into service.test.ts in Go; the small cases live here.
import { describe, expect, it } from "vitest";
import { ChangeNotFoundError, UndoStaleError } from "./errors.ts";
import { type Actor, MAX_CHANGES, recent, record, sameEntry, undo } from "./journal.ts";
import { applyPatch, type Entry, emptyDoc, newEntry, type Patch } from "./model.ts";

const zy: Actor = { by: "zy@x", channel: "web" };
const partner: Actor = { by: "partner", channel: "telegram" };
const AT = "2026-11-12T23:30:00Z";

function patch(json: string): Patch {
	return JSON.parse(json);
}

function entry(json: string): Entry {
	const e = newEntry("");
	applyPatch(e, patch(json));
	return e;
}

function ulids(): () => string {
	let n = 0;
	return () => {
		n++;
		return `C${String(n).padStart(25, "0")}`;
	};
}

function errorOf(fn: () => void): Error {
	try {
		fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}

describe("record", () => {
	it("appends a record with the actor, op and cloned entries", () => {
		const doc = emptyDoc();
		const before = entry(`{"title":"Lights"}`);
		const after = { ...before, status: "doing" };
		const change = record(doc, zy, "update", before.id, before, after, "c1", AT);

		expect(doc.changes.length).toBe(1);
		expect(change).toEqual({
			id: "c1",
			at: AT,
			by: "zy@x",
			channel: "web",
			op: "update",
			entryId: before.id,
			before,
			after,
		});
		// Clones: touching the arguments afterwards cannot reach the journal.
		before.title = "changed";
		after.tags.push("x");
		expect(doc.changes[0]?.before?.title).toBe("Lights");
		expect(doc.changes[0]?.after?.tags).toEqual([]);
	});

	it("keeps nulls for the missing side", () => {
		const doc = emptyDoc();
		const e = entry(`{"title":"x"}`);
		record(doc, zy, "create", e.id, null, e, "c1", AT);
		record(doc, zy, "delete", e.id, e, null, "c2", AT);
		expect(doc.changes[0]?.before).toBeNull();
		expect(doc.changes[1]?.after).toBeNull();
	});

	it("keeps only the newest changes past the cap", () => {
		const doc = emptyDoc();
		const e = entry(`{"title":"x"}`);
		// The cap is 200 in the spec, so it is spelled out: asserting only
		// against MAX_CHANGES would follow the constant anywhere it moved.
		expect(MAX_CHANGES).toBe(200);
		for (let i = 0; i < MAX_CHANGES + 1; i++) record(doc, zy, "update", e.id, e, e, `c${i}`, AT);
		expect(doc.changes.length).toBe(200);
		expect(doc.changes[0]?.id).toBe("c1");
		expect(doc.changes[MAX_CHANGES - 1]?.id).toBe(`c${MAX_CHANGES}`);
	});
});

describe("sameEntry", () => {
	it("compares the encoded bytes, so any difference counts", () => {
		const e = entry(`{"title":"Lights","kind":"task","tags":["a"]}`);
		expect(sameEntry(e, { ...e })).toBe(true);
		expect(sameEntry(e, { ...e, notes: "x" })).toBe(false);
		expect(sameEntry(e, { ...e, tags: ["a", "b"] })).toBe(false);
		expect(sameEntry(e, { ...e, updated: `${e.updated}1` })).toBe(false);
		expect(sameEntry(null, null)).toBe(true);
		expect(sameEntry(e, null)).toBe(false);
		expect(sameEntry(null, e)).toBe(false);
	});
});

describe("undo", () => {
	it("removes the entry a create added and journals the undo", () => {
		const doc = emptyDoc();
		const next = ulids();
		const e = entry(`{"title":"Fluted panels"}`);
		doc.entries.push(e);
		const created = record(doc, partner, "create", e.id, null, e, next(), AT);

		const res = undo(doc, partner, created.id, AT, next);
		expect(doc.entries).toEqual([]);
		expect(res.entries).toEqual([e]);
		expect(res.changes[0]?.op).toBe("undo");
		expect(res.changes[0]?.before).toEqual(e);
		expect(res.changes[0]?.after).toBeNull();
		expect(doc.changes[doc.changes.length - 1]?.op).toBe("undo");
	});

	it("restores an update and stamps the undoer", () => {
		const doc = emptyDoc();
		const next = ulids();
		const before = entry(`{"title":"Sofa","kind":"idea"}`);
		const after = { ...before, status: "decided", updated: "2026-11-12T00:00:00Z", by: "partner" };
		doc.entries.push(after);
		const updated = record(doc, partner, "update", before.id, before, after, next(), AT);

		const res = undo(doc, zy, updated.id, "2026-11-13T09:00:00Z", next);
		const got = doc.entries[0];
		expect(got?.status).toBe("idea");
		expect(got?.by).toBe("zy@x");
		expect(got?.channel).toBe("web");
		expect(got?.updated).toBe("2026-11-13T09:00:00Z");
		expect(res.entries).toEqual([got]);
	});

	it("puts a deleted entry back verbatim, at the end", () => {
		const doc = emptyDoc();
		const next = ulids();
		const kept = { ...entry(`{"title":"kept"}`), id: "kept-1" };
		const gone = { ...entry(`{"title":"gone"}`), id: "gone-1", by: "partner", channel: "telegram" };
		doc.entries.push(kept);
		const deleted = record(doc, zy, "delete", gone.id, gone, null, next(), AT);

		undo(doc, zy, deleted.id, "2026-11-13T09:00:00Z", next);
		expect(doc.entries.map((e) => e.title)).toEqual(["kept", "gone"]);
		// Verbatim: the entry keeps its old stamps, unlike an undo of an update.
		expect(doc.entries[1]).toEqual(gone);
	});

	it("refuses a second undo of the same change and leaves the entry alone", () => {
		const doc = emptyDoc();
		const next = ulids();
		const e = entry(`{"title":"x"}`);
		doc.entries.push(e);
		const created = record(doc, zy, "create", e.id, null, e, next(), AT);
		undo(doc, zy, created.id, AT, next);

		const err = errorOf(() => undo(doc, zy, created.id, AT, next));
		expect(err).toBeInstanceOf(UndoStaleError);
		expect(err.message).toBe("that entry has changed since, so undo was refused");
	});

	it("refuses a change that is not in the journal, or has no entries", () => {
		const doc = emptyDoc();
		const next = ulids();
		const missing = errorOf(() => undo(doc, zy, "nope", AT, next));
		expect(missing).toBeInstanceOf(ChangeNotFoundError);
		expect(missing.message).toBe("that change is no longer in the history: nope");

		doc.changes.push({
			id: "c1",
			at: AT,
			by: "zy@x",
			channel: "web",
			op: "update",
			entryId: "x",
			before: null,
			after: null,
		});
		const empty = errorOf(() => undo(doc, zy, "c1", AT, next));
		expect(empty).toBeInstanceOf(ChangeNotFoundError);
		expect(empty.message).toBe("that change is no longer in the history: c1 (empty record)");
	});
});

describe("recent", () => {
	function filled(): ReturnType<typeof emptyDoc> {
		const doc = emptyDoc();
		const e = entry(`{"title":"x"}`);
		for (let i = 0; i < 4; i++) record(doc, i % 2 === 1 ? partner : zy, "update", e.id, e, e, `c${i}`, AT);
		return doc;
	}

	it("returns the newest first, filtered and capped", () => {
		const doc = filled();
		expect(recent(doc, 2, "").map((c) => c.id)).toEqual(["c3", "c2"]);
		expect(recent(doc, 2, "partner").map((c) => c.id)).toEqual(["c3", "c1"]);
		expect(recent(doc, 0, "")).toEqual([]);
		expect(recent(emptyDoc(), 5, "")).toEqual([]);
	});

	it("hands out copies", () => {
		const doc = filled();
		const [first] = recent(doc, 1, "");
		if (first?.after === null || first?.after === undefined) throw new Error("missing after");
		first.after.title = "mutated";
		expect(doc.changes[3]?.after?.title).toBe("x");
	});
});
