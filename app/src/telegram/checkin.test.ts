// The morning check-in's texts, buttons and `ci:` callbacks (src/telegram/checkin.ts):
// Go's own answers (app/golden/t51 wrote testdata/checkin.go.json with the real
// functions), the text half of TestCheckinCapsAskMessages, the callback data of
// TestCheckinButtonAfterTheTaskMoved, and Telegram's 64-byte button limit.
//
// Nothing here talks to Telegram or reads a clock of its own: the agendas come
// from the golden's documents, the presses from its fixed 09:30 on 12 Nov 2026.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agenda } from "../entries/agenda.ts";
import type { Doc, Entry } from "../entries/model.ts";
import {
	ALREADY_DONE_TOAST,
	ARCHIVED_TOAST,
	askKeyboard,
	askText,
	CHECKIN_PREFIX,
	type CheckinCallback,
	checkinMessages,
	checkinText,
	MAX_ASK_MESSAGES,
	MAX_OVERDUE_TITLES,
	MORNING_CHECKIN,
	movedToast,
	parseCheckinCallback,
	shortDay,
} from "./checkin.ts";
import type { InlineKeyboardMarkup } from "./client.ts";

/** Go's answers for T5.1a, by app/golden/t51/main.go. */
interface Golden {
	constants: { max_ask_messages: number; max_overdue_titles: number; prefix: string; max_message: number };
	toasts: { archived: string; already_done: string; moved_dated: string; moved_undated: string };
	checkin: {
		name: string;
		today: string;
		since: string;
		/** null for Go's nil slice: no entries at all. */
		doc: GoldenEntry[] | null;
		summary: string;
		messages: { text: string; keyboard: InlineKeyboardMarkup | null }[];
		note: string;
	}[];
	keyboard: { id: string; date: string; keyboard: InlineKeyboardMarkup; longest_callback_bytes: number }[];
	callbacks: { now: string; loc: string; cases: GoldenCallback[] };
}

/** One entry of a golden agenda's document: the fields the texts read. */
interface GoldenEntry {
	id: string;
	kind: string;
	title: string;
	date: string;
	time: string;
	room: string;
	status: string;
	archived: boolean;
	created: string;
}

interface GoldenCallback {
	data: string;
	kind: "ack" | "done" | "milestone" | "move";
	id?: string;
	asked?: string;
	days?: number;
	date?: string;
}

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "checkin.go.json"), "utf8")) as Golden;

function at<T>(list: readonly T[], i: number): T {
	const value = list[i];
	if (value === undefined) throw new Error(`no element ${i} of ${list.length}`);
	return value;
}

function goldenCase(name: string): Golden["checkin"][number] {
	const found = GOLDEN.checkin.find((c) => c.name === name);
	if (found === undefined) throw new Error(`the golden has no case ${name}`);
	return found;
}

/** The golden's document, as the port's Doc (only the fields agenda reads matter). */
function doc(list: readonly GoldenEntry[] | null): Doc {
	return { schema: 1, meta: { moveDate: null, keyDate: null }, entries: (list ?? []).map(entry), changes: [] };
}

function entry(e: GoldenEntry): Entry {
	return {
		id: e.id,
		kind: e.kind,
		title: e.title,
		room: e.room === "" ? null : e.room,
		category: "",
		status: e.status,
		cost: { estimate: null, actual: null },
		vendor: "",
		date: e.date === "" ? null : e.date,
		time: e.time === "" ? null : e.time,
		source: "",
		notes: "",
		tags: [],
		archived: e.archived,
		milestone: false,
		completed: null,
		by: "",
		channel: "",
		created: e.created,
		updated: e.created,
	};
}

/** What the port answers for one golden callback case. */
function expectedCallback(c: GoldenCallback): CheckinCallback {
	switch (c.kind) {
		case "done":
		case "milestone":
			return { op: c.kind, id: c.id ?? "", asked: c.asked ?? "" };
		case "move":
			return { op: "move", id: c.id ?? "", asked: c.asked ?? "", days: c.days ?? 0, date: c.date ?? "" };
		default:
			return { op: "ack" };
	}
}

describe("the golden: Go's texts, buttons and note", () => {
	it("has Go's constants", () => {
		expect(MAX_ASK_MESSAGES).toBe(GOLDEN.constants.max_ask_messages);
		expect(MAX_OVERDUE_TITLES).toBe(GOLDEN.constants.max_overdue_titles);
		expect(CHECKIN_PREFIX).toBe(GOLDEN.constants.prefix);
		expect(MORNING_CHECKIN).toBe("(morning check-in)");
	});

	for (const c of GOLDEN.checkin) {
		it(`${c.name}: the summary, the messages and the note`, () => {
			const ag = agenda(doc(c.doc), c.today, c.since);
			expect(checkinText(c.today, ag).summary).toBe(c.summary);
			expect(checkinMessages(c.today, ag)).toEqual({
				parts: c.messages,
				note: { tag: "checkin", text: c.note },
			});
		});
	}

	for (const c of GOLDEN.keyboard) {
		it(`${c.id}: Go's buttons and their ${c.longest_callback_bytes}-byte longest data`, () => {
			const e = entry({
				id: c.id,
				kind: "task",
				title: "Book movers",
				date: c.date,
				time: "",
				room: "",
				status: "todo",
				archived: false,
				created: "2026-11-01T00:00:01Z",
			});
			expect(askKeyboard(e)).toEqual(c.keyboard);
		});
	}

	for (const c of GOLDEN.callbacks.cases) {
		it(`reads ${JSON.stringify(c.data)} as ${c.kind}`, () => {
			const now = new Date(GOLDEN.callbacks.now);
			expect(parseCheckinCallback(c.data, now, GOLDEN.callbacks.loc)).toEqual(expectedCallback(c));
		});
	}

	it("shows Go's stale-press toasts", () => {
		expect(ARCHIVED_TOAST).toBe(GOLDEN.toasts.archived);
		expect(ALREADY_DONE_TOAST).toBe(GOLDEN.toasts.already_done);
		expect(movedToast("2026-11-13")).toBe(GOLDEN.toasts.moved_dated);
		expect(movedToast(null)).toBe(GOLDEN.toasts.moved_undated);
	});
});

// Go: TestCheckinCapsAskMessages, the text half (checkin_test.go:228-243).
describe("TestCheckinCapsAskMessages", () => {
	it("asks 8 messages and lists the rest, counting every ask", () => {
		const c = goldenCase("ten_asks");
		const ag = agenda(doc(c.doc), c.today, c.since);
		const { summary, asks } = checkinText(c.today, ag);
		expect(ag.ask).toHaveLength(10);
		expect(asks).toHaveLength(MAX_ASK_MESSAGES);
		expect(summary).toContain("Not marked done yet (10)");
		expect(summary).toContain("Also open from earlier days:\n• Task 09 — Wed 11 Nov\n• Task 10 — Wed 11 Nov");
		// The eight asked about are not repeated as text.
		expect(summary).not.toContain("Task 01 —");
		expect(summary).not.toContain("Task 08 —");
	});
});

// Go: TestCheckinButtonAfterTheTaskMoved, the data strings (checkin_test.go:398-407).
describe("TestCheckinButtonAfterTheTaskMoved", () => {
	it("carries the date the task had when it was asked", () => {
		const e = entry(at(goldenCase("three_asks").doc ?? [], 0));
		const base = `${e.id}:20261111`;
		expect(askKeyboard(e).inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
			`ci:d:${base}`,
			`ci:m:${base}`,
			`ci:r:${base}:1`,
			`ci:r:${base}:7`,
		]);
		// Asked on the 12th about the 11th: "Yesterday", and the 11th in the data.
		expect(askText(e, "2026-11-12")).toBe("Yesterday: Book movers\nDone?");
	});

	it("sends no data longer than 64 bytes, Telegram's limit", () => {
		for (const c of GOLDEN.keyboard) {
			const buttons = c.keyboard.inline_keyboard.flat();
			expect(buttons.length).toBe(4);
			for (const b of buttons) {
				expect(Buffer.byteLength(b.callback_data ?? "", "utf8")).toBeLessThanOrEqual(64);
			}
			// A 26-character ULID and the date as asked: Go says at most 44.
			expect(Math.max(...buttons.map((b) => Buffer.byteLength(b.callback_data ?? "", "utf8")))).toBe(
				c.longest_callback_bytes,
			);
		}
	});
});

describe("shortDay", () => {
	it("is Go's Mon 2 Jan, and returns a day it cannot parse unchanged", () => {
		expect(shortDay("2026-11-12")).toBe("Thu 12 Nov");
		expect(shortDay("2026-11-07")).toBe("Sat 7 Nov");
		expect(shortDay("2026-01-01")).toBe("Thu 1 Jan");
		expect(shortDay("2026-02-30")).toBe("2026-02-30");
		expect(shortDay("")).toBe("");
	});
});

// The four buttons are one row per ask; a message with no ask has none.
describe("askKeyboard", () => {
	it("has no buttons for an agenda with nothing to ask", () => {
		const ag = agenda(doc(goldenCase("empty").doc), "2026-11-12", "");
		expect(checkinMessages("2026-11-12", ag).parts.map((p) => p.keyboard)).toEqual([null]);
	});

	it("puts one row of four on every ask and none on the summary", () => {
		const c = goldenCase("three_asks");
		const parts = checkinMessages(c.today, agenda(doc(c.doc), c.today, c.since)).parts;
		expect(parts[0]?.keyboard).toBeNull();
		for (const part of parts.slice(1)) {
			expect(part.keyboard?.inline_keyboard).toHaveLength(1);
			expect(part.keyboard?.inline_keyboard[0]?.map((b) => b.text)).toEqual(["Done", "Done ★", "Tomorrow", "+1 week"]);
		}
		expect(at(parts, 1).text).toBe("Yesterday: Book movers\nDone?");
	});
});

// Not in Go: a stray press of a `ci:` button that is not one of the four ops.
describe("parseCheckinCallback", () => {
	it("answers a bare ack to anything it cannot act on", () => {
		const now = new Date(GOLDEN.callbacks.now);
		expect(parseCheckinCallback("ci:", now, "UTC")).toEqual({ op: "ack" });
		expect(parseCheckinCallback("ci:r:", now, "UTC")).toEqual({ op: "ack" });
		expect(parseCheckinCallback("ci:r:01K8ZQ4R7S9T2V5W8X1Y3Z5A01:20261111:", now, "UTC")).toEqual({ op: "ack" });
	});
});
