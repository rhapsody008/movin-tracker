// Port of internal/entries/search_test.go plus the search half of
// milestone_test.go (TestSearchMilestones), and the cases the Go suite missed.
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.ts";
import { applyPatch, type Doc, emptyDoc, newEntry, type Patch } from "./model.ts";
import { DEFAULT_LIMIT, decodeFilter, type Filter, MAX_LIMIT, type SearchResult, searchEntries } from "./search.ts";

function patch(json: string): Patch {
	return JSON.parse(json);
}

// searchDoc is search_test.go's six-entry fixture, in the same document order.
function searchDoc(): Doc {
	const d = emptyDoc();
	const add = (updated: string, kind: string, json: string): void => {
		const e = newEntry(kind);
		applyPatch(e, patch(json));
		e.id = e.title;
		e.updated = updated;
		d.entries.push(e);
	};
	add(
		"2026-11-01T00:00:00Z",
		"idea",
		`{"title":"Quartz countertop","room":"wet kitchen","category":"carpentry","cost":{"estimate":3000},"tags":["counter","stone"]}`,
	);
	add(
		"2026-11-03T00:00:00Z",
		"decision",
		`{"title":"Sintered stone top","room":"dry kitchen","category":"carpentry","status":"decided","vendor":"Lim Carpentry","tags":["counter"],"notes":"Picked over quartz"}`,
	);
	add(
		"2026-11-02T00:00:00Z",
		"task",
		`{"title":"Electrician visit","category":"electrical","date":"2026-11-14","time":"14:00","vendor":"Tan Electric"}`,
	);
	add(
		"2026-11-04T00:00:00Z",
		"task",
		`{"title":"Book movers","category":"admin","date":"2026-12-01","status":"doing"}`,
	);
	add("2026-11-05T00:00:00Z", "note", `{"title":"Maybe a reading nook","room":"flex","archived":true}`);
	add(
		"2026-11-06T00:00:00Z",
		"question",
		`{"title":"Can we hack the bedroom 2 wall?","room":"bedroom 2","source":"site visit"}`,
	);
	return d;
}

function titles(r: SearchResult): string {
	return r.entries.map((e) => e.title).join(" | ");
}

function errorOf(fn: () => void): Error {
	try {
		fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected a throw, but the call returned");
}

describe("searchEntries", () => {
	const d = searchDoc();
	const cases: { name: string; f: Filter; want: string }[] = [
		{
			name: "everything, newest first, no archived",
			f: {},
			want: "Can we hack the bedroom 2 wall? | Book movers | Sintered stone top | Electrician visit | Quartz countertop",
		},
		{ name: "include archived", f: { include_archived: true, kinds: ["note"] }, want: "Maybe a reading nook" },
		{
			name: "kitchen decisions",
			f: { rooms: ["Dry Kitchen", "wet kitchen"], statuses: ["decided"] },
			want: "Sintered stone top",
		},
		{
			name: "kind any-of",
			f: { kinds: ["Task", "question"] },
			want: "Can we hack the bedroom 2 wall? | Book movers | Electrician visit",
		},
		{ name: "room excludes entries without one", f: { rooms: ["flex"] }, want: "" },
		{ name: "category", f: { category: "Carpentry" }, want: "Sintered stone top | Quartz countertop" },
		{ name: "tags need all", f: { tags: ["counter", "stone"] }, want: "Quartz countertop" },
		{ name: "vendor substring", f: { vendor: "lim" }, want: "Sintered stone top" },
		{
			name: "text words all match, any field",
			f: { text: "quartz top" },
			want: "Sintered stone top | Quartz countertop",
		},
		{ name: "text matches room", f: { text: "bedroom" }, want: "Can we hack the bedroom 2 wall?" },
		{ name: "text matches source", f: { text: "site" }, want: "Can we hack the bedroom 2 wall?" },
		{ name: "date range inclusive", f: { date_from: "2026-11-14", date_to: "2026-11-30" }, want: "Electrician visit" },
		{ name: "date from only", f: { date_from: "2026-11-15" }, want: "Book movers" },
		{ name: "limit", f: { limit: 2 }, want: "Can we hack the bedroom 2 wall? | Book movers" },
		{ name: "no match", f: { text: "jacuzzi" }, want: "" },
	];
	for (const c of cases) {
		it(c.name, () => {
			expect(titles(searchEntries(d, c.f))).toBe(c.want);
		});
	}

	it("includes both ends of the date range", () => {
		expect(titles(searchEntries(d, { date_from: "2026-11-14", date_to: "2026-11-14" }))).toBe("Electrician visit");
		expect(titles(searchEntries(d, { date_to: "2026-11-14" }))).toBe("Electrician visit");
		expect(titles(searchEntries(d, { date_from: "2026-11-30", date_to: "2026-12-01" }))).toBe("Book movers");
	});

	it("leaves undated entries out once a bound is set", () => {
		expect(titles(searchEntries(d, { date_from: "2026-01-01" }))).toBe("Book movers | Electrician visit");
	});

	it("keeps document order on an updated tie", () => {
		const tie = emptyDoc();
		const add = (title: string, updated: string): void => {
			const e = newEntry("note");
			e.id = title;
			e.title = title;
			e.updated = updated;
			tie.entries.push(e);
		};
		add("second", "2026-11-02T00:00:00Z");
		add("first", "2026-11-02T00:00:00Z");
		add("newest", "2026-11-03T00:00:00Z");
		add("third", "2026-11-02T00:00:00Z");
		expect(titles(searchEntries(tie, {}))).toBe("newest | second | first | third");
	});

	it("splits text on Go's spaces, U+00A0 included", () => {
		expect(titles(searchEntries(d, { text: "quartz\u00a0top" }))).toBe("Sintered stone top | Quartz countertop");
	});

	it("keeps inner spaces in category but collapses them in rooms", () => {
		const spaced = emptyDoc();
		const e = newEntry("note");
		e.id = "site";
		e.title = "Site work";
		e.category = "site work";
		spaced.entries.push(e);
		expect(titles(searchEntries(spaced, { category: "  Site   Work " }))).toBe("");
		expect(titles(searchEntries(spaced, { category: " Site Work " }))).toBe("Site work");
		expect(titles(searchEntries(d, { rooms: ["wet   kitchen"] }))).toBe("Quartz countertop");
	});
});

describe("searchEntries limits", () => {
	function manyDoc(): Doc {
		const d = emptyDoc();
		for (let i = 0; i < 250; i++) {
			const e = newEntry("note");
			e.title = `n${i}`;
			e.id = e.title;
			e.updated = `2026-11-01T00:00:${String(i).padStart(3, "0")}Z`;
			d.entries.push(e);
		}
		return d;
	}

	it("reports the total and cuts at the default limit", () => {
		const r = searchEntries(manyDoc(), {});
		expect(r.total).toBe(250);
		expect(r.entries.length).toBe(DEFAULT_LIMIT);
		expect(DEFAULT_LIMIT).toBe(50);
	});

	it("caps the limit at the maximum", () => {
		expect(searchEntries(manyDoc(), { limit: 1000 }).entries.length).toBe(MAX_LIMIT);
		expect(MAX_LIMIT).toBe(200);
	});

	it("returns copies, not shared memory", () => {
		const d = manyDoc();
		const first = searchEntries(d, { limit: 1 }).entries[0];
		if (first === undefined) throw new Error("no hit");
		first.title = "changed";
		expect(searchEntries(d, { limit: 1 }).entries[0]?.title).toBe("n249");
	});
});

describe("searchEntries milestones", () => {
	function milestoneDoc(): Doc {
		const d = emptyDoc();
		const add = (json: string): void => {
			const e = newEntry("");
			applyPatch(e, patch(json));
			e.id = e.title;
			d.entries.push(e);
		};
		add(`{"title":"Keys","kind":"note","status":"done","milestone":true}`);
		add(`{"title":"Handover","kind":"task","milestone":true}`); // flagged, not done yet
		add(`{"title":"Paint","kind":"task","status":"done"}`);
		return d;
	}

	it("keeps only milestones when true and leaves them out when false", () => {
		const d = milestoneDoc();
		const yes = searchEntries(d, { milestone: true });
		expect(yes.total).toBe(1);
		expect(yes.entries[0]?.title).toBe("Keys");
		expect(searchEntries(d, { milestone: false }).total).toBe(2);
	});

	it("decodes the milestone flag from the tool args", () => {
		const f = decodeFilter({ milestone: true });
		expect(f.milestone).toBe(true);
		expect(f.limit).toBeUndefined();
	});
});

describe("decodeFilter", () => {
	it("reads the JSON names and ignores unknown keys", () => {
		expect(
			decodeFilter({
				kinds: ["task"],
				rooms: ["flex"],
				statuses: ["todo"],
				category: "admin",
				tags: ["x"],
				vendor: "lim",
				text: "top",
				date_from: "2026-11-01",
				date_to: "2026-11-30",
				include_archived: true,
				milestone: false,
				limit: 3,
				nonsense: "ignored",
			}),
		).toEqual({
			kinds: ["task"],
			rooms: ["flex"],
			statuses: ["todo"],
			category: "admin",
			tags: ["x"],
			vendor: "lim",
			text: "top",
			date_from: "2026-11-01",
			date_to: "2026-11-30",
			include_archived: true,
			milestone: false,
			limit: 3,
		});
	});

	it("treats null as a missing field, as Go does", () => {
		const f = decodeFilter({ text: null, limit: null, kinds: null, milestone: null, include_archived: null });
		expect(f.text).toBeUndefined();
		expect(f.limit).toBeUndefined();
		expect(f.kinds).toBeUndefined();
		expect(f.milestone).toBeUndefined();
		expect(f.include_archived).toBeUndefined();
		expect(searchEntries(searchDoc(), f).total).toBe(5);
	});

	it("refuses a wrong type for each field, naming it", () => {
		const cases: [Record<string, unknown>, string][] = [
			[{ kinds: "task" }, "kinds must be a list of strings"],
			[{ kinds: [1] }, "kinds must be a list of strings"],
			[{ rooms: 5 }, "rooms must be a list of strings"],
			[{ statuses: {} }, "statuses must be a list of strings"],
			[{ category: 5 }, "category must be a string"],
			[{ tags: "counter" }, "tags must be a list of strings"],
			[{ vendor: true }, "vendor must be a string"],
			[{ text: 1 }, "text must be a string"],
			[{ date_from: [] }, "date_from must be a string"],
			[{ date_to: 20261130 }, "date_to must be a string"],
			[{ include_archived: "yes" }, "include_archived must be true or false"],
			[{ milestone: 1 }, "milestone must be true or false"],
			[{ limit: "50" }, "limit must be a whole number"],
			[{ limit: 2.5 }, "limit must be a whole number"],
		];
		for (const [args, want] of cases) {
			const err = errorOf(() => decodeFilter(args));
			expect(err).toBeInstanceOf(ValidationError);
			expect(err.message).toBe(want);
		}
	});

	it("refuses args that are not an object", () => {
		for (const args of [null, "text", 5, ["kinds"]]) {
			expect(errorOf(() => decodeFilter(args)).message).toBe("search arguments must be an object");
		}
	});
});
