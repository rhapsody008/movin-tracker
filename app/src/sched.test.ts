// Port of internal/sched/sched_test.go, plus the zone formatting the daily
// documents timer's log line needs. nextRun, day and addDays are compared case
// by case with Go's own answers in testdata/sched.go.json, which
// tmp/t15c-golden/main.go writes: two zones without DST (Asia/Singapore, UTC)
// and one with (Europe/London, across both 2026 changes).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addDays, day, nextRun, parseSchedule, rfc3339 } from "./sched.ts";

interface GoldenNext {
	now: string;
	hh: number;
	mm: number;
	tz: string;
	next: string;
	utc: string;
}

interface GoldenDay {
	now: string;
	tz: string;
	day: string;
}

interface GoldenAdd {
	day: string;
	n: number;
	want: string;
}

const golden = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "sched.go.json"), "utf8")) as {
	next: GoldenNext[];
	day: GoldenDay[];
	addDays: GoldenAdd[];
};

/** RFC3339 in UTC, seconds only, as the golden's "utc" field is. */
function utcStamp(at: Date): string {
	return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function errorOf(fn: () => unknown): Error {
	try {
		fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}

describe("parseSchedule", () => {
	const cases: { input: string; want: string }[] = [
		{ input: "", want: "03:00 on" },
		{ input: "03:00", want: "03:00 on" },
		{ input: "21:30", want: "21:30 on" },
		{ input: "off", want: "00:00 off" },
		{ input: "OFF", want: "00:00 off" },
		{ input: " None ", want: "00:00 off" },
		{ input: "false", want: "00:00 off" },
		{ input: " 07:15 ", want: "07:15 on" },
		{ input: "3:5", want: "03:05 on" },
		{ input: "+3:00", want: "03:00 on" },
	];

	for (const c of cases) {
		it(`reads ${JSON.stringify(c.input)} as ${c.want}`, () => {
			const s = parseSchedule("X", c.input, "03:00");
			const clock = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
			expect(`${clock} ${s.on ? "on" : "off"}`).toBe(c.want);
		});
	}

	for (const bad of ["3", "24:00", "07:61", "noon", "-1:00", "03:00:00", "0x3:00"]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			expect(() => parseSchedule("X", bad, "03:00")).toThrow('X must be HH:MM (24 h) or off, not "');
		});
	}

	it("quotes what was typed, lowercased and trimmed", () => {
		const err = errorOf(() => parseSchedule("DOCS_SYNC_SCHEDULE", " Noon ", "03:00"));
		expect(err.message).toBe('DOCS_SYNC_SCHEDULE must be HH:MM (24 h) or off, not "noon"');
		const minute = errorOf(() => parseSchedule("X", "03:60", "03:00"));
		expect(minute.message).toBe('X must be HH:MM (24 h) or off, not "03:60"');
	});
});

describe("nextRun", () => {
	for (const c of golden.next) {
		it(`from ${c.now} in ${c.tz} fires at ${c.next}`, () => {
			const next = nextRun(new Date(c.now), c.hh, c.mm, c.tz);
			expect(rfc3339(next, c.tz)).toBe(c.next);
			expect(utcStamp(next)).toBe(c.utc);
			// Strictly after now, always.
			expect(next.getTime()).toBeGreaterThan(new Date(c.now).getTime());
		});
	}
});

describe("day", () => {
	for (const c of golden.day) {
		it(`of ${c.now} in ${c.tz} is ${c.day}`, () => {
			expect(day(new Date(c.now), c.tz)).toBe(c.day);
		});
	}
});

describe("addDays", () => {
	for (const c of golden.addDays) {
		it(`moves ${JSON.stringify(c.day)} by ${c.n} to ${JSON.stringify(c.want)}`, () => {
			expect(addDays(c.day, c.n)).toBe(c.want);
		});
	}
});

describe("rfc3339", () => {
	it("formats an instant in the zone the log line is read in", () => {
		const at = new Date("2026-11-10T19:00:00Z");
		expect(rfc3339(at, "Asia/Singapore")).toBe("2026-11-11T03:00:00+08:00");
		expect(rfc3339(at, "UTC")).toBe("2026-11-10T19:00:00Z");
		// Across both London changes in 2026.
		expect(rfc3339(new Date("2026-03-29T02:00:00Z"), "Europe/London")).toBe("2026-03-29T03:00:00+01:00");
		expect(rfc3339(new Date("2026-10-25T03:00:00Z"), "Europe/London")).toBe("2026-10-25T03:00:00Z");
		expect(rfc3339(new Date("2026-01-15T09:30:45Z"), "Europe/London")).toBe("2026-01-15T09:30:45Z");
	});
});
