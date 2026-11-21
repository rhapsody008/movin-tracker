// Port of internal/entries/model_test.go plus the model half of
// milestone_test.go, and the golden comparison against Go's own bytes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.ts";
import { goMarshal } from "../gojson.ts";
import {
	applyMetaPatch,
	applyPatch,
	CHANNELS,
	cloneDoc,
	cloneEntry,
	decodeDoc,
	type Entry,
	emptyDoc,
	encodeDoc,
	encodeDocView,
	findEntry,
	isMilestone,
	KIND_NOTE,
	KINDS,
	type Meta,
	newEntry,
	normRoom,
	normTags,
	type Patch,
	PLAN_STATUSES,
	ROOMS,
	SCHEMA_VERSION,
	STATUS_DONE,
	settleCompleted,
	statusesFor,
	TASK_STATUSES,
	validTime,
} from "./model.ts";

function patch(json: string): Patch {
	return JSON.parse(json);
}

// errorOf runs fn and returns what it threw; a call that returns normally is a
// test failure, so a broken check can never pass by doing nothing.
function errorOf(fn: () => void): Error {
	try {
		fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}

function expectValidationError(fn: () => void, message: string): void {
	const err = errorOf(fn);
	expect(err).toBeInstanceOf(ValidationError);
	expect(err.message).toBe(message);
}

// Go's message carries an en dash (U+2013).
const TITLE_RANGE = "title must be 1\u2013200 characters";

interface Case {
	name: string;
	kind: string;
	json: string;
	/** The exact error message, or null when the patch must be accepted. */
	error: string | null;
}

describe("applyPatch validates every field rule (TestValidation)", () => {
	const long = (n: number): string => `"${"x".repeat(n)}"`;
	const cases: Case[] = [
		{ name: "minimal", kind: "", json: `{"title":"Fluted panels"}`, error: null },
		{
			name: "full idea",
			kind: "idea",
			json: `{"title":"Quartz top","room":"Wet Kitchen","category":"Carpentry","status":"shortlisted","cost":{"estimate":3000,"actual":null},"vendor":"Lim","date":"2026-11-20","time":"14:00","source":"showroom","notes":"white","tags":["Kitchen","kitchen"," top "]}`,
			error: null,
		},
		{ name: "empty title", kind: "", json: `{"title":"   "}`, error: TITLE_RANGE },
		{ name: "title 200", kind: "", json: `{"title":${long(200)}}`, error: null },
		{ name: "title 201", kind: "", json: `{"title":${long(201)}}`, error: TITLE_RANGE },
		{
			name: "vendor 201",
			kind: "",
			json: `{"title":"a","vendor":${long(201)}}`,
			error: "vendor must be at most 200 characters",
		},
		{
			name: "source 501",
			kind: "",
			json: `{"title":"a","source":${long(501)}}`,
			error: "source must be at most 500 characters",
		},
		{ name: "notes 4000", kind: "", json: `{"title":"a","notes":${long(4000)}}`, error: null },
		{
			name: "notes 4001",
			kind: "",
			json: `{"title":"a","notes":${long(4001)}}`,
			error: "notes must be at most 4000 characters",
		},
		{
			name: "category 41",
			kind: "",
			json: `{"title":"a","category":${long(41)}}`,
			error: "category must be at most 40 characters",
		},
		{
			name: "unknown room",
			kind: "",
			json: `{"title":"a","room":"ac ledge"}`,
			error: `room must be one of ${ROOMS.join(", ")}, or empty`,
		},
		{ name: "empty room clears", kind: "", json: `{"title":"a","room":""}`, error: null },
		{ name: "null room clears", kind: "", json: `{"title":"a","room":null}`, error: null },
		{
			name: "bad kind",
			kind: "",
			json: `{"title":"a","kind":"wish"}`,
			error: `kind must be one of ${KINDS.join(", ")}`,
		},
		{
			name: "task status on idea",
			kind: "idea",
			json: `{"title":"a","status":"doing"}`,
			error: `status for a idea must be one of ${PLAN_STATUSES.join(", ")}`,
		},
		{
			name: "plan status on task",
			kind: "task",
			json: `{"title":"a","status":"shortlisted"}`,
			error: `status for a task must be one of ${TASK_STATUSES.join(", ")}`,
		},
		{ name: "task status on task", kind: "task", json: `{"title":"a","status":"doing"}`, error: null },
		{
			name: "kind and status together",
			kind: "idea",
			json: `{"title":"a","kind":"task","status":"doing"}`,
			error: null,
		},
		{ name: "bad date", kind: "", json: `{"title":"a","date":"20/11/2026"}`, error: "date must be YYYY-MM-DD" },
		{ name: "impossible date", kind: "", json: `{"title":"a","date":"2026-02-30"}`, error: "date must be YYYY-MM-DD" },
		{
			name: "bad time",
			kind: "",
			json: `{"title":"a","date":"2026-11-20","time":"2pm"}`,
			error: "time must be HH:MM (24h)",
		},
		{
			name: "time 24:00",
			kind: "",
			json: `{"title":"a","date":"2026-11-20","time":"24:00"}`,
			error: "time must be HH:MM (24h)",
		},
		{ name: "time without date", kind: "", json: `{"title":"a","time":"14:00"}`, error: "time needs a date" },
		{ name: "empty date clears", kind: "", json: `{"title":"a","date":""}`, error: null },
		{
			name: "negative cost",
			kind: "",
			json: `{"title":"a","cost":{"estimate":-1}}`,
			error: "cost.estimate must be 0 or more",
		},
		{
			name: "cost as string",
			kind: "",
			json: `{"title":"a","cost":{"estimate":"3k"}}`,
			error: "cost.estimate must be a number or null",
		},
		{
			name: "cost unknown field",
			kind: "",
			json: `{"title":"a","cost":{"quoted":1}}`,
			error: `unknown cost field "quoted"`,
		},
		{
			name: "cost not object",
			kind: "",
			json: `{"title":"a","cost":3000}`,
			error: "cost must be an object with estimate and/or actual",
		},
		{
			name: "tags not list",
			kind: "",
			json: `{"title":"a","tags":"kitchen"}`,
			error: "tags must be a list of strings",
		},
		{
			name: "tag 41",
			kind: "",
			json: `{"title":"a","tags":[${long(41)}]}`,
			error: "each tag must be at most 40 characters",
		},
		{ name: "unknown field", kind: "", json: `{"title":"a","colour":"red"}`, error: `unknown field "colour"` },
		{
			name: "archived not bool",
			kind: "",
			json: `{"title":"a","archived":"yes"}`,
			error: "archived must be true or false",
		},
	];

	for (const c of cases) {
		it(`${c.name}: ${c.error ?? "accepted"}`, () => {
			const e = newEntry(c.kind);
			if (c.error === null) {
				expect(() => applyPatch(e, patch(c.json))).not.toThrow();
				return;
			}
			expectValidationError(() => applyPatch(e, patch(c.json)), c.error);
		});
	}
});

describe("applyPatch normalises the fields it stores (TestNormalisedFields)", () => {
	it("trims, lowercases and de-duplicates", () => {
		const e = newEntry("idea");
		applyPatch(
			e,
			patch(
				`{"title":" Quartz top ","room":"  Wet   Kitchen ","category":"Carpentry","tags":["Kitchen","kitchen"," Top  Choice "]}`,
			),
		);
		expect(e.title).toBe("Quartz top");
		expect(e.room).toBe("wet kitchen");
		expect(e.category).toBe("carpentry");
		expect(e.tags.join("|")).toBe("kitchen|top choice");
	});

	it("trims and lowercases like Go, not like JS trim()", () => {
		// U+0085 is Go space but not JS space; U+FEFF is JS space but not Go space.
		const e = newEntry("note");
		applyPatch(
			e,
			patch(JSON.stringify({ title: "\u0085padded\u0085", room: "\u00a0flex\u00a0", tags: ["\ufeffbom\ufeff"] })),
		);
		expect(e.title).toBe("padded");
		expect(e.room).toBe("flex");
		expect(e.tags).toEqual(["\ufeffbom\ufeff"]);
	});
});

describe("defaults per kind (TestDefaultsPerKind)", () => {
	const cases: Array<[string, string]> = [
		["", "idea"],
		["idea", "idea"],
		["decision", "idea"],
		["note", "idea"],
		["question", "idea"],
		["task", "todo"],
	];
	for (const [kind, want] of cases) {
		it(`kind ${JSON.stringify(kind)} starts as ${want}`, () => {
			expect(newEntry(kind).status).toBe(want);
		});
	}

	it("an empty kind means note", () => {
		expect(newEntry("").kind).toBe("note");
	});
});

describe("a kind change carries the status across (TestKindChangeRemapsStatus)", () => {
	const cases: Array<[string, string, string, string]> = [
		["idea", "idea", "task", "todo"],
		["idea", "shortlisted", "task", "doing"],
		["decision", "decided", "task", "todo"],
		["idea", "done", "task", "done"],
		["task", "todo", "idea", "idea"],
		["task", "doing", "decision", "shortlisted"],
		["task", "done", "note", "done"],
		["idea", "decided", "decision", "decided"], // same status set: unchanged
	];
	for (const [fromKind, fromStatus, toKind, want] of cases) {
		it(`${fromKind}/${fromStatus} to ${toKind} becomes ${want}`, () => {
			const e = newEntry(fromKind);
			e.title = "x";
			e.status = fromStatus;
			applyPatch(e, patch(JSON.stringify({ kind: toKind })));
			expect(e.kind).toBe(toKind);
			expect(e.status).toBe(want);
		});
	}
});

describe("clearing the date clears the time (TestClearingDateClearsTime)", () => {
	it("clears both fields", () => {
		const e = newEntry("task");
		applyPatch(e, patch(`{"title":"Electrician","date":"2026-11-14","time":"14:00"}`));
		applyPatch(e, patch(`{"date":null}`));
		expect(e.date).toBeNull();
		expect(e.time).toBeNull();
	});

	it("refuses a time in the same patch that clears the date", () => {
		const e = newEntry("task");
		applyPatch(e, patch(`{"title":"x","date":"2026-11-14"}`));
		expectValidationError(() => applyPatch(e, patch(`{"date":null,"time":"10:00"}`)), "time needs a date");
	});
});

describe("a cost patch only touches the keys it carries (TestCostPartialPatch)", () => {
	const e = newEntry("task");
	applyPatch(e, patch(`{"title":"Carpentry","cost":{"estimate":18000}}`));

	it("merges estimate and actual", () => {
		applyPatch(e, patch(`{"cost":{"actual":5400}}`));
		expect(e.cost.estimate).toBe(18000);
		expect(e.cost.actual).toBe(5400);
	});

	it("clears one side with null", () => {
		applyPatch(e, patch(`{"cost":{"estimate":null}}`));
		expect(e.cost.estimate).toBeNull();
		expect(e.cost.actual).toBe(5400);
	});

	it("clears both with cost null", () => {
		applyPatch(e, patch(`{"cost":null}`));
		expect(e.cost).toEqual({ estimate: null, actual: null });
	});
});

describe("applyPatch edge cases", () => {
	it("names the first unknown key in patch order", () => {
		expectValidationError(
			() => applyPatch(newEntry(""), patch(`{"title":"a","colour":"red","texture":"rough"}`)),
			`unknown field "colour"`,
		);
		expectValidationError(
			() => applyPatch(newEntry(""), patch(`{"texture":"rough","colour":"red"}`)),
			`unknown field "texture"`,
		);
	});

	it("treats a null title as empty", () => {
		expectValidationError(() => applyPatch(newEntry(""), patch(`{"title":null}`)), TITLE_RANGE);
	});

	it("refuses a title that is not a string", () => {
		expectValidationError(() => applyPatch(newEntry(""), patch(`{"title":5}`)), "title must be a string");
	});

	it("reports status errors for a kindless entry as for a note", () => {
		const e = { ...newEntry("note"), kind: "" };
		expectValidationError(
			() => applyPatch(e, patch(`{"status":"doing"}`)),
			`status for a note must be one of ${PLAN_STATUSES.join(", ")}`,
		);
	});

	it("accepts 20 tags and refuses 21", () => {
		const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
		const ok = newEntry("note");
		applyPatch(ok, patch(JSON.stringify({ tags: twenty })));
		expect(ok.tags).toHaveLength(20);
		expectValidationError(
			() => applyPatch(newEntry("note"), patch(JSON.stringify({ tags: [...twenty, "t20"] }))),
			"at most 20 tags",
		);
	});
});

describe("dates, times, rooms and Go whitespace", () => {
	it("validates 24h clock times", () => {
		expect(validTime("00:00")).toBe(true);
		expect(validTime("23:59")).toBe(true);
		expect(validTime("24:00")).toBe(false);
		expect(validTime("10:60")).toBe(false);
		expect(validTime("9:00")).toBe(false);
	});

	it("normalises room names by Go fields and lowercase", () => {
		expect(normRoom("  Wet   Kitchen ")).toBe("wet kitchen");
		expect(normRoom("AC Ledge")).toBeNull();
		expect(normRoom("\u00a0flex\u00a0")).toBe("flex");
	});

	it("normalises tags with Go's whitespace set, not JS", () => {
		expect(normTags(["\u0085Top \u00a0 Choice\u0085"])).toEqual(["top choice"]);
	});

	it("lists the enumerations in Go's order", () => {
		expect(KINDS).toEqual(["idea", "decision", "task", "note", "question"]);
		expect(statusesFor("task")).toEqual(["todo", "doing", "done"]);
		expect(statusesFor("note")).toEqual(["idea", "shortlisted", "decided", "done"]);
		expect(CHANNELS).toEqual(["web", "telegram", "system"]);
		expect(SCHEMA_VERSION).toBe(1);
		expect(KIND_NOTE).toBe("note");
		expect(STATUS_DONE).toBe("done");
	});
});

function at<T>(list: readonly T[], i: number): T {
	const item = list[i];
	if (item === undefined) throw new Error(`no item ${i}`);
	return item;
}

// applyWithDay is what the service does: apply the patch, then settle the done
// day against the entry as it was and the app's today.
function applyWithDay(before: Entry | null, e: Entry, json: string, today: string): void {
	const p = patch(json);
	applyPatch(e, p);
	settleCompleted(before, e, p, today);
}

describe("settleCompleted keeps the done day in step (TestCompletedDayFollowsStatus)", () => {
	it("stamps today on the move to done, keeps it, clears it, re-stamps it", () => {
		const e = newEntry("task");
		applyWithDay(null, e, `{"title":"Hack the walls","kind":"task"}`, "2026-11-12");
		expect(e.completed).toBeNull();

		applyWithDay(cloneEntry(e), e, `{"status":"done"}`, "2026-11-13");
		expect(e.completed).toBe("2026-11-13");

		// Another edit while still done keeps the day.
		applyWithDay(cloneEntry(e), e, `{"notes":"all walls"}`, "2026-11-16");
		expect(e.completed).toBe("2026-11-13");

		applyWithDay(cloneEntry(e), e, `{"status":"doing"}`, "2026-11-16");
		expect(e.completed).toBeNull();

		applyWithDay(cloneEntry(e), e, `{"status":"done"}`, "2026-11-16");
		expect(e.completed).toBe("2026-11-16");

		// An explicit day wins, and clearing it later keeps the old day.
		applyWithDay(cloneEntry(e), e, `{"completed":"2026-11-10"}`, "2026-11-20");
		expect(e.completed).toBe("2026-11-10");
		applyWithDay(cloneEntry(e), e, `{"completed":null}`, "2026-11-20");
		expect(e.completed).toBe("2026-11-10");
		applyWithDay(cloneEntry(e), e, `{"completed":""}`, "2026-11-20");
		expect(e.completed).toBe("2026-11-10");
	});

	it("stamps today for an entry created done without a day", () => {
		const e = newEntry("task");
		applyWithDay(null, e, `{"title":"Paid deposit","kind":"task","status":"done"}`, "2026-11-16");
		expect(e.completed).toBe("2026-11-16");
	});

	it("keeps an explicit day on an entry created done", () => {
		const e = newEntry("note");
		applyWithDay(
			null,
			e,
			`{"title":"Keys collected","kind":"note","status":"done","milestone":true,"completed":"2026-11-01"}`,
			"2026-11-16",
		);
		expect(e.completed).toBe("2026-11-01");
		expect(isMilestone(e)).toBe(true);
	});

	it("refuses a day on an entry that is not done", () => {
		const e = newEntry("task");
		const p = patch(`{"completed":"2026-11-10"}`);
		applyPatch(e, p);
		expectValidationError(() => settleCompleted(null, e, p, "2026-11-12"), "completed needs status done");
	});

	it("refuses a completed date that is not a date", () => {
		expectValidationError(
			() => applyPatch(newEntry("task"), patch(`{"completed":"10/11/2026"}`)),
			"completed must be YYYY-MM-DD",
		);
	});
});

describe("milestones (milestone_test.go)", () => {
	it("counts as a milestone only when flagged and done", () => {
		const e = newEntry("task");
		expect(isMilestone(e)).toBe(false);
		applyPatch(e, patch(`{"milestone":true}`));
		expect(e.milestone).toBe(true);
		expect(isMilestone(e)).toBe(false);
		applyPatch(e, patch(`{"status":"done"}`));
		expect(isMilestone(e)).toBe(true);
		expect(e.completed).toBeNull(); // the service settles the day, not the patch
	});

	it("writes back a pre-milestone file byte-identically (TestOldEntriesUnchanged)", () => {
		const old = `{"schema":1,"meta":{"moveDate":null,"keyDate":null},"entries":[{"id":"A","kind":"task","title":"Paint","room":null,"category":"","status":"done","cost":{"estimate":null,"actual":null},"vendor":"","date":"2026-11-01","time":null,"source":"","notes":"","tags":[],"archived":false,"by":"zy","channel":"web","created":"2026-11-01T00:00:00Z","updated":"2026-11-02T00:00:00Z"}],"changes":[]}`;
		const d = decodeDoc(old);
		const e = at(d.entries, 0);
		expect(e.milestone).toBe(false);
		expect(e.completed).toBeNull();
		expect(isMilestone(e)).toBe(false);
		expect(encodeDoc(d)).toBe(old);

		// Hand-edited: a day on an entry that isn't done is dropped, the flag stays.
		const edited = old.replace(`"status":"done"`, `"status":"todo","completed":"2026-11-02","milestone":true`);
		const e2 = at(decodeDoc(edited).entries, 0);
		expect(e2.completed).toBeNull();
		expect(e2.milestone).toBe(true);
		expect(isMilestone(e2)).toBe(false);
	});
});

describe("applyMetaPatch changes the key dates (TestMetaPatch)", () => {
	const m: Meta = { moveDate: null, keyDate: null };

	it("sets a date", () => {
		applyMetaPatch(m, { moveDate: "2026-12-05" });
		expect(m.moveDate).toBe("2026-12-05");
	});

	it("refuses a bad date with the field name", () => {
		expectValidationError(() => applyMetaPatch(m, { keyDate: "05/12/2026" }), "keyDate must be YYYY-MM-DD");
	});

	it("clears with an empty string or null", () => {
		applyMetaPatch(m, { moveDate: "" });
		expect(m.moveDate).toBeNull();
		applyMetaPatch(m, { keyDate: "2026-10-29" });
		applyMetaPatch(m, { keyDate: null });
		expect(m.keyDate).toBeNull();
	});

	it("leaves a key that is not in the patch alone", () => {
		applyMetaPatch(m, { moveDate: "2026-12-05" });
		applyMetaPatch(m, { keyDate: "2026-10-29" });
		expect(m).toEqual({ moveDate: "2026-12-05", keyDate: "2026-10-29" });
	});
});

describe("clones and lookups are deep (TestCloneIsDeep)", () => {
	it("a clone shares nothing with the original", () => {
		const d = emptyDoc();
		const e = newEntry("idea");
		applyPatch(e, patch(`{"title":"a","room":"flex","date":"2026-11-20","cost":{"estimate":1},"tags":["t"]}`));
		d.entries.push(e);
		d.changes.push({ id: "c1", at: "", by: "", channel: "", op: "create", entryId: e.id, before: null, after: e });

		const c = cloneDoc(d);
		at(c.entries, 0).room = "dining";
		at(c.entries, 0).cost.estimate = 99;
		at(c.entries, 0).tags[0] = "changed";
		const journalAfter = at(c.changes, 0).after;
		if (journalAfter === null) throw new Error("the clone lost the journal entry");
		journalAfter.title = "changed";

		const original = at(d.entries, 0);
		expect(original.room).toBe("flex");
		expect(original.cost.estimate).toBe(1);
		expect(original.tags).toEqual(["t"]);
		const originalJournalAfter = at(d.changes, 0).after;
		if (originalJournalAfter === null) throw new Error("the original lost the journal entry");
		expect(originalJournalAfter.title).toBe("a");
	});

	it("findEntry returns a clone, or null", () => {
		const d = emptyDoc();
		expect(findEntry(d, "nope")).toBeNull();
		const e = newEntry("note");
		e.id = "A";
		d.entries.push(e);
		const found = findEntry(d, "A");
		if (found === null) throw new Error("findEntry lost the entry");
		found.title = "changed";
		expect(at(d.entries, 0).title).toBe("");
	});

	it("emptyDoc and encodeDocView have the documented shape", () => {
		expect(emptyDoc()).toEqual({ schema: 1, meta: { moveDate: null, keyDate: null }, entries: [], changes: [] });
		const d = emptyDoc();
		d.changes.push({ id: "c", at: "", by: "", channel: "", op: "undo", entryId: "", before: null, after: null });
		// The view is the document without the journal, in Go struct order.
		expect(goMarshal(encodeDocView(d))).toBe('{"schema":1,"meta":{"moveDate":null,"keyDate":null},"entries":[]}');
	});
});

const ENTRY_KEYS = [
	"id",
	"kind",
	"title",
	"room",
	"category",
	"status",
	"cost",
	"vendor",
	"date",
	"time",
	"source",
	"notes",
	"tags",
	"archived",
	"milestone",
	"completed",
	"by",
	"channel",
	"created",
	"updated",
];

describe("decodeDoc normalises what it reads (TestDecodeNormalises)", () => {
	const d = decodeDoc(`{"entries":[
		{"id":"1","title":"a","kind":"wish","status":"weird","room":"AC Ledge","date":"bad","time":"10:00","tags":["X","x"],"channel":"fax"},
		{"id":"2","title":"b","kind":"task","status":"shortlisted","room":"Master Bedroom","date":"2026-11-20","time":"9am"}
	]}`);

	it("fills in the document defaults", () => {
		expect(d.schema).toBe(1);
		expect(d.changes).toEqual([]);
		expect(d.meta).toEqual({ moveDate: null, keyDate: null });
	});

	it("repairs an entry with junk fields", () => {
		const a = at(d.entries, 0);
		expect({
			kind: a.kind,
			status: a.status,
			room: a.room,
			date: a.date,
			time: a.time,
			tags: a.tags,
			channel: a.channel,
		}).toEqual({ kind: "note", status: "idea", room: null, date: null, time: null, tags: ["x"], channel: "web" });
	});

	it("remaps a task status and keeps a valid room and date", () => {
		const b = at(d.entries, 1);
		expect({ status: b.status, room: b.room, date: b.date, time: b.time }).toEqual({
			status: "doing",
			room: "master bedroom",
			date: "2026-11-20",
			time: null,
		});
	});

	it("drops unknown keys and keeps Go's field set", () => {
		const withJunk = decodeDoc(
			`{"schema":1,"unknownDoc":1,"entries":[{"id":"A","title":"a","cost":{"estimate":1,"unknownCost":2},"unknownEntry":true}],"changes":[{"id":"c","op":"create","before":null,"after":null,"unknownChange":3}]}`,
		);
		expect(Object.keys(withJunk)).toEqual(["schema", "meta", "entries", "changes"]);
		expect(Object.keys(at(withJunk.entries, 0))).toEqual(ENTRY_KEYS);
		expect(Object.keys(at(withJunk.entries, 0).cost)).toEqual(["estimate", "actual"]);
		expect(Object.keys(at(withJunk.changes, 0))).toEqual([
			"id",
			"at",
			"by",
			"channel",
			"op",
			"entryId",
			"before",
			"after",
		]);
	});

	it("leaves journal entries raw: normalise is for entries only", () => {
		const raw = decodeDoc(
			`{"changes":[{"id":"c","op":"create","before":null,"after":{"title":"  raw  ","kind":"wish","status":"weird","completed":"2026-11-01","cost":{"estimate":-5},"unknown":1}}]}`,
		);
		const after = at(raw.changes, 0).after;
		if (after === null) throw new Error("decode lost the journal entry");
		expect(after.title).toBe("  raw  ");
		expect(after.kind).toBe("wish");
		expect(after.status).toBe("weird");
		expect(after.completed).toBe("2026-11-01");
		expect(after.cost.estimate).toBe(-5);
	});

	it("reports a wrong field type with Go's message", () => {
		expect(errorOf(() => decodeDoc(`{"entries":[{"title":5}]}`)).message).toBe(
			`decode entries.json: json: cannot unmarshal number into Go struct field Doc.entries.0.title of type string`,
		);
		expect(errorOf(() => decodeDoc(`{"entries":[{"tags":[1]}]}`)).message).toBe(
			`decode entries.json: json: cannot unmarshal number into Doc.entries.0.tags.0 of type string`,
		);
		expect(errorOf(() => decodeDoc(`[]`)).message).toBe(
			`decode entries.json: json: cannot unmarshal array into Go value of type entries.Doc`,
		);
	});

	it("reports invalid JSON with the decode prefix", () => {
		// Go says `invalid character 'n' looking for beginning of object key
		// string`, V8 says `Expected property name or '}' ...`: the text after the
		// prefix is the parser's, so only the prefix is a compatibility rule.
		const err = errorOf(() => decodeDoc(`{not json`));
		expect(err instanceof ValidationError).toBe(false);
		expect(err.message.startsWith("decode entries.json: ")).toBe(true);
	});
});

describe("Amendment 1: rows that kill the reviewer's mutations", () => {
	const rows: Case[] = [
		{
			name: "tag element not string",
			kind: "",
			json: `{"title":"a","tags":[1]}`,
			error: "tags must be a list of strings",
		},
		{
			name: "tag element true",
			kind: "",
			json: `{"title":"a","tags":[true]}`,
			error: "tags must be a list of strings",
		},
		{ name: "archived null", kind: "", json: `{"title":"a","archived":null}`, error: "archived must be true or false" },
		{
			name: "milestone null",
			kind: "",
			json: `{"title":"a","milestone":null}`,
			error: "milestone must be true or false",
		},
		{
			name: "cost as array",
			kind: "",
			json: `{"title":"a","cost":[]}`,
			error: "cost must be an object with estimate and/or actual",
		},
		{ name: "cost zero", kind: "", json: `{"title":"a","cost":{"estimate":0}}`, error: null },
		{ name: "cost actual zero", kind: "", json: `{"title":"a","cost":{"actual":0}}`, error: null },
		{
			name: "time before a null date",
			kind: "",
			json: `{"title":"a","time":"10:00","date":null}`,
			error: "time needs a date",
		},
	];

	for (const c of rows) {
		it(`${c.name}: ${c.error ?? "accepted"}`, () => {
			const e = newEntry(c.kind);
			if (c.error === null) {
				expect(() => applyPatch(e, patch(c.json))).not.toThrow();
				return;
			}
			expectValidationError(() => applyPatch(e, patch(c.json)), c.error);
		});
	}

	it("keeps a zero amount as zero", () => {
		const e = newEntry("task");
		applyPatch(e, patch(`{"cost":{"estimate":0,"actual":0}}`));
		expect(e.cost).toEqual({ estimate: 0, actual: 0 });
	});

	it("a blank room clears it", () => {
		const e = newEntry("note");
		e.room = "flex";
		applyPatch(e, patch(`{"room":"  "}`));
		expect(e.room).toBeNull();
	});

	it("counts code points: 200 emoji fit, 201 do not", () => {
		const emoji = String.fromCodePoint(0x1f600);
		expect(() => applyPatch(newEntry("note"), { title: emoji.repeat(200) })).not.toThrow();
		expectValidationError(() => applyPatch(newEntry("note"), { title: emoji.repeat(201) }), TITLE_RANGE);
	});

	it("trims free text but lowercases only category", () => {
		const e = newEntry("note");
		applyPatch(e, { vendor: "  Lim & Co  ", source: " Showroom ", notes: " white ", category: " Carpentry " });
		expect(e.vendor).toBe("Lim & Co");
		expect(e.source).toBe("Showroom");
		expect(e.notes).toBe("white");
		expect(e.category).toBe("carpentry");
	});

	it("trims and lowercases kind and status", () => {
		const e = newEntry("idea");
		applyPatch(e, { kind: " TASK ", status: " DOING " });
		expect(e.kind).toBe("task");
		expect(e.status).toBe("doing");
	});

	it("refuses an explicit day when a done entry leaves done (milestone_test.go:83)", () => {
		const e = newEntry("task");
		e.status = STATUS_DONE;
		e.completed = "2026-11-10";
		const before = cloneEntry(e);
		const p = patch(`{"status":"todo","completed":"2026-11-10"}`);
		applyPatch(e, p);
		expectValidationError(() => settleCompleted(before, e, p, "2026-11-16"), "completed needs status done");
	});

	it("cloneDoc copies meta instead of sharing it", () => {
		const d = emptyDoc();
		d.meta.moveDate = "2026-12-05";
		const c = cloneDoc(d);
		c.meta.moveDate = "2027-01-01";
		expect(d.meta.moveDate).toBe("2026-12-05");
		expect(c.meta.keyDate).toBeNull();
	});
});

describe("golden files: Go's own bytes are the judge", () => {
	// The files are written by tmp/t13-golden/main.go from the Go app's own
	// Decode and json.Marshal, never by hand. <input>.json is the input,
	// <input>.go.json the bytes Go stores, <input>.go.err Go's error text.
	// app/biome.json excludes this directory so the formatter cannot rewrite
	// either side.
	const dir = join(import.meta.dirname, "testdata");
	const files = readdirSync(dir).sort();

	// Journal tags are the one known byte difference (see the Amendment 1
	// test): Go writes null for a nil Tags slice inside a change, where entry
	// tags are always an array, and Entry.tags is string[] here.
	const knownDifferent = new Set(["journal-nil-tags.go.json"]);
	for (const file of files.filter((f) => f.endsWith(".go.json") && !knownDifferent.has(f))) {
		it(`${file} round-trips to the exact Go bytes`, () => {
			const input = readFileSync(join(dir, file.replace(/\.go\.json$/, ".json")), "utf8");
			const want = readFileSync(join(dir, file), "utf8");
			expect(encodeDoc(decodeDoc(input))).toBe(want);
		});
	}

	for (const file of files.filter((f) => f.endsWith(".go.err"))) {
		it(`${file} is refused with Go's message`, () => {
			const input = readFileSync(join(dir, file.replace(/\.go\.err$/, ".json")), "utf8");
			const err = errorOf(() => decodeDoc(input));
			expect(err instanceof ValidationError).toBe(false);
			if (file === "invalid.go.err") {
				// Only the prefix can match: the wording after it is the JSON
				// parser's own, and V8's differs from Go's.
				expect(err.message.startsWith("decode entries.json: ")).toBe(true);
				return;
			}
			expect(err.message).toBe(readFileSync(join(dir, file), "utf8"));
		});
	}

	it("covers every rule the tricky file is meant to reach", () => {
		const d = decodeDoc(readFileSync(join(dir, "tricky.json"), "utf8"));
		expect(d.schema).toBe(1);
		// >20 tags and a 41-rune tag wipe the list, silently, as in Go.
		expect(at(d.entries, 1).tags).toEqual([]);
		expect(at(d.entries, 5).tags).toEqual([]);
		// completed on a non-done entry is dropped; the flag stays.
		expect(at(d.entries, 0).completed).toBeNull();
		expect(at(d.entries, 0).milestone).toBe(true);
		expect(at(d.entries, 2).milestone).toBe(false);
	});

	it("drops unknown keys at every level, including the top (tricky.json)", () => {
		// treating a nested unknown key as a field would fail the decode or add a
		// field to the encoded bytes, so the golden round trip above and this
		// assertion fail together.
		const d = decodeDoc(readFileSync(join(dir, "tricky.json"), "utf8"));
		expect(Object.hasOwn(d, "unknownTopLevel")).toBe(false);
		expect(Object.hasOwn(d.meta, "unknownMeta")).toBe(false);
		expect(encodeDoc(d)).toBe(readFileSync(join(dir, "tricky.go.json"), "utf8"));
	});
});

describe("Amendment 1: behaviour Go has and JSON.parse hides", () => {
	const dir = join(import.meta.dirname, "testdata");

	it("reads a null tag as an empty one, which is then dropped (patch and file)", () => {
		const e = newEntry("note");
		applyPatch(e, patch(`{"tags":["a",null,"B",""]}`));
		expect(e.tags).toEqual(["a", "b"]);
		const d = decodeDoc(readFileSync(join(dir, "tags-null-element.json"), "utf8"));
		expect(at(d.entries, 0).tags).toEqual(["a"]);
	});

	it("refuses an amount JSON cannot write, in a patch and in a file", () => {
		const e = newEntry("task");
		expectValidationError(
			() => applyPatch(e, { cost: JSON.parse(`{"estimate":1e400}`) }),
			"cost.estimate must be a number or null",
		);
		expectValidationError(
			() => applyPatch(e, { cost: JSON.parse(`{"actual":-1e400}`) }),
			"cost.actual must be a number or null",
		);
		// A negative finite amount keeps its own message.
		expectValidationError(() => applyPatch(e, { cost: { estimate: -1 } }), "cost.estimate must be 0 or more");
		const file = readFileSync(join(dir, "num-huge-cost.go.err"), "utf8");
		expect(file).toContain("number 1e400");
	});

	it("matches a key by exact name first, then case-insensitively, later key wins", () => {
		const d = decodeDoc(`{"ENTRIES":[{"TITLE":"first","title":"second"}],"Schema":1}`);
		expect(d.schema).toBe(1);
		expect(at(d.entries, 0).title).toBe("second");
	});

	it("reports the first bad field in document order, not struct order", () => {
		// updated comes before id in the document and last in the struct; Go
		// reports updated, so a port that walks the struct reports the wrong one.
		const err = errorOf(() => decodeDoc(`{"entries":[{"updated":5,"id":6}]}`));
		expect(err.message).toBe(
			"decode entries.json: json: cannot unmarshal number into Go struct field Doc.entries.0.updated of type string",
		);
	});

	it("reads a null entry, null change and null root as the Go zero values", () => {
		const one = decodeDoc(readFileSync(join(dir, "null-entry.json"), "utf8"));
		expect(at(one.entries, 0).kind).toBe(KIND_NOTE);
		expect(at(one.entries, 0).status).toBe("idea");
		const change = decodeDoc(readFileSync(join(dir, "null-change.json"), "utf8"));
		expect(at(change.changes, 0)).toEqual({
			id: "",
			at: "",
			by: "",
			channel: "",
			op: "",
			entryId: "",
			before: null,
			after: null,
		});
		expect(decodeDoc("null")).toEqual(emptyDoc());
	});

	it("writes [] where Go writes null for journal tags: a known difference", () => {
		// Go's Change.Before/After carry the raw entries, and a nil Tags slice
		// marshals as null. Ours is always an array, so the two files differ only
		// in that token, and Go reads both the same (normTags treats nil and []
		// alike), so an old file stays readable in either direction.
		const d = decodeDoc(readFileSync(join(dir, "journal-nil-tags.json"), "utf8"));
		const after = at(d.changes, 0).after;
		expect(after === null ? null : after.tags).toEqual([]);
		expect(encodeDoc(d)).toContain(`"after":{"id":"A","kind":"task",`);
		expect(encodeDoc(d)).toContain(`"tags":[],`);
		expect(readFileSync(join(dir, "journal-nil-tags.go.json"), "utf8")).toContain(`"tags":null,`);
	});

	it("keeps the parser error as the cause of a decode error", () => {
		const err = errorOf(() => decodeDoc(`{not json`));
		expect(err.cause).toBeInstanceOf(SyntaxError);
	});
});

describe("goMarshal matches Go's encoding/json", () => {
	it("escapes the HTML and line-separator characters Go escapes", () => {
		expect(goMarshal("a<b>c&d")).toBe(String.raw`"a\u003cb\u003ec\u0026d"`);
		expect(goMarshal("\u2028\u2029")).toBe(String.raw`"\u2028\u2029"`);
		expect(goMarshal({ title: "<&>" })).toBe(String.raw`{"title":"\u003c\u0026\u003e"}`);
	});

	it("escapes control characters, quote and backslash like Go", () => {
		const raw = 'a\u0001b\tc\nd\re\u000bf\u000cg"h\\i';
		expect(goMarshal(raw)).toBe(String.raw`"a\u0001b\tc\nd\re\u000bf\fg\"h\\i"`);
	});

	it("leaves DEL, U+0085, U+00A0, U+FEFF and non-BMP characters raw, as Go does", () => {
		const raw = ["del\u007f", "nel\u0085", "nbsp\u00a0", "bom\ufeff", "cjk 厨房", "emoji 😀"];
		expect(goMarshal(raw)).toBe(`["del\u007f","nel\u0085","nbsp\u00a0","bom\ufeff","cjk 厨房","emoji 😀"]`);
	});

	it("prints numbers like Go; -0 and lone surrogates are the known differences", () => {
		expect(goMarshal([18000, 5400.5, 0.1, 1e21, 1e-7, 123456789012, 0, 1e20, 1e-6, 1.5e-8])).toBe(
			"[18000,5400.5,0.1,1e+21,1e-7,123456789012,0,100000000000000000000,0.000001,1.5e-8]",
		);
		// Go writes -0; JSON.stringify writes 0. Left as is, documented in gojson.ts.
		expect(goMarshal(-0)).toBe("0");
	});
});
