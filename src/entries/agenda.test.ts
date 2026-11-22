// Port of internal/entries/agenda_test.go plus the cases the Go suite missed.
import { describe, expect, it } from "vitest";
import { addDays } from "../sched.ts";
import { type Agenda, agenda, isQuiet, MAX_ASK_DAYS } from "./agenda.ts";
import { type Doc, type Entry, emptyDoc, newEntry } from "./model.ts";

function titlesOf(es: readonly Entry[]): string {
	return es.map((e) => e.title).join(",");
}

// mk builds an entry the way agenda_test.go's literal does: raw fields, no
// validation, so a question can carry the status "idea".
function mk(title: string, kind: string, status: string, date: string, time: string | null, archived: boolean): Entry {
	const e = newEntry(kind);
	e.id = title;
	e.title = title;
	e.status = status;
	e.time = time;
	e.archived = archived;
	e.date = date === "" ? null : date;
	e.created = "2026-11-01T00:00:00Z";
	return e;
}

function agendaDoc(): Doc {
	const d = emptyDoc();
	d.entries = [
		mk("tiler", "task", "todo", "2026-11-12", "14:00", false),
		mk("electrician", "task", "doing", "2026-11-12", "09:00", false),
		mk("pick tiles", "question", "idea", "2026-11-12", null, false), // any kind today, untimed last
		mk("done today", "task", "done", "2026-11-12", null, false),
		mk("archived today", "task", "todo", "2026-11-12", null, true),
		mk("yesterday", "task", "todo", "2026-11-11", null, false),
		mk("yesterday done", "task", "done", "2026-11-11", null, false),
		mk("yesterday idea", "idea", "idea", "2026-11-11", null, false), // not a task: not asked about
		mk("three days ago", "task", "todo", "2026-11-09", null, false),
		mk("ten days ago", "task", "todo", "2026-11-02", null, false),
		mk("tomorrow", "task", "todo", "2026-11-13", null, false),
		mk("undated", "task", "doing", "", null, false),
	];
	return d;
}

describe("agenda", () => {
	const d = agendaDoc();
	const cases: { name: string; since: string; today: string; ask: string; overdue: string }[] = [
		{
			name: "normal day: yesterday asked",
			since: "2026-11-11",
			today: "electrician,tiler,pick tiles",
			ask: "yesterday",
			overdue: "ten days ago,three days ago",
		},
		{
			name: "no record yet: yesterday",
			since: "",
			today: "electrician,tiler,pick tiles",
			ask: "yesterday",
			overdue: "ten days ago,three days ago",
		},
		{
			name: "missed days are asked",
			since: "2026-11-08",
			today: "electrician,tiler,pick tiles",
			ask: "three days ago,yesterday",
			overdue: "ten days ago",
		},
		{
			name: "at most 7 days back",
			since: "2026-10-01",
			today: "electrician,tiler,pick tiles",
			ask: "three days ago,yesterday",
			overdue: "ten days ago",
		},
		{
			name: "already asked today",
			since: "2026-11-12",
			today: "electrician,tiler,pick tiles",
			ask: "",
			overdue: "ten days ago,three days ago,yesterday",
		},
	];
	for (const c of cases) {
		it(c.name, () => {
			const a: Agenda = agenda(d, "2026-11-12", c.since);
			expect(titlesOf(a.today)).toBe(c.today);
			expect(titlesOf(a.ask)).toBe(c.ask);
			expect(titlesOf(a.overdue)).toBe(c.overdue);
			expect(isQuiet(a)).toBe(false);
		});
	}

	it("counts a task dated on the floor as overdue", () => {
		expect(MAX_ASK_DAYS).toBe(7);
		expect(titlesOf(agenda(d, "2026-11-12", "2026-11-05").overdue)).toBe("ten days ago");
	});

	it("is quiet on a day with only future, undated and done entries", () => {
		const quiet = emptyDoc();
		quiet.entries = [
			mk("tomorrow", "task", "todo", "2026-11-13", null, false),
			mk("undated", "task", "todo", "", null, false),
			mk("done", "task", "done", "2026-11-11", null, false),
		];
		const a = agenda(quiet, "2026-11-12", "");
		expect(isQuiet(a)).toBe(true);
		expect([a.today, a.ask, a.overdue]).toEqual([[], [], []]);
	});

	it("gives nothing for an invalid today", () => {
		expect(isQuiet(agenda(d, "bad", ""))).toBe(true);
	});

	it("puts untimed entries last within a day", () => {
		const timed = emptyDoc();
		timed.entries = [
			mk("untimed", "task", "todo", "2026-11-11", null, false),
			mk("late", "task", "todo", "2026-11-11", "18:00", false),
			mk("early", "task", "todo", "2026-11-11", "07:30", false),
			mk("tomorrow", "task", "todo", "2026-11-13", null, false),
		];
		expect(titlesOf(agenda(timed, "2026-11-12", "").ask)).toBe("early,late,untimed");
	});

	it("returns copies, not shared memory", () => {
		const todayHit = agenda(d, "2026-11-12", "").today[0];
		if (todayHit === undefined) throw new Error("no entry for today");
		todayHit.title = "changed";
		expect(titlesOf(agenda(d, "2026-11-12", "").today)).toBe("electrician,tiler,pick tiles");
	});
});

describe("addDays", () => {
	it("crosses a month end", () => {
		expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
		expect(addDays("2026-12-01", -1)).toBe("2026-11-30");
	});

	it("crosses a year end", () => {
		expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
		expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
	});

	it("handles the leap day", () => {
		expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
		expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
		expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // not a leap year
	});

	it("returns an empty day for an invalid input", () => {
		expect(addDays("", 1)).toBe("");
		expect(addDays("bad", 1)).toBe("");
		expect(addDays("2026-02-30", 1)).toBe("");
		expect(addDays("2026-2-3", 1)).toBe("");
	});
});
