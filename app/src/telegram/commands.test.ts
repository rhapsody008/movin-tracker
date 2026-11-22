// The bot's command answers against Go's own bytes: `app/golden/t44/main.go`
// wrote `testdata/commands.go.json` from Go's unexported `helpText`, the
// `/recent` line assembly and the two document formatters `/sync` uses, so the
// help text, the zone formatting and every state suffix are Go's and not a
// guess. The cases the golden cannot carry (a journal record Go would panic on,
// a read that fails) are here too.
//
// The bot end to end — the ported `TestCommands`, the Undo button and the
// at-most-once cases — is `bot.test.ts`, which has the fake Bot API and the
// durable rig.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CLASS_SCANNED,
	type Doc,
	emptyDoc,
	STATUS_FAILED,
	STATUS_OK,
	STATUS_REMOVED,
	type Sync,
} from "../docs/index.ts";
import { ChangeText } from "../entries/changetext.ts";
import { type Change, newEntry } from "../entries/model.ts";
import {
	CHECKIN_UNAVAILABLE,
	counts,
	docList,
	HELP_TEXT,
	recentAt,
	recentLine,
	SYNC_REASON_PREFIX,
	unknownCommand,
} from "./commands.ts";

/** Go's answers for T4.4, by app/golden/t44/main.go. */
interface Golden {
	help_text: string;
	recent: { at: string; by: string; channel: string; title: string; loc: string; out: string }[];
	counts: { added: number; changed: number; removed: number; failed: number; out: string }[];
	/** `docs` is null when Go's slice is nil: no documents at all, which is no lines. */
	doc_list: {
		docs: { key: string; class: string; status: string; error: string }[] | null;
		max: number;
		out: string;
	}[];
}

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "commands.go.json"), "utf8")) as Golden;

/** syncResults is one Sync per counts case: only the four counts matter to the formatter. */
function syncOf(c: Golden["counts"][number]): Sync {
	return {
		at: "",
		reason: "",
		added: c.added,
		changed: c.changed,
		removed: c.removed,
		failed: c.failed,
		skipped: 0,
		refreshed: 0,
		error: "",
	};
}

/** docOf builds the index record a docList case describes. */
function docOf(c: { key: string; class: string; status: string; error: string }): Doc {
	return { ...emptyDoc(c.key, "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B"), class: c.class, status: c.status, error: c.error };
}

/** changeOf is one journal record as `/recent` reads it: a note the app saved. */
function changeOf(c: Golden["recent"][number]): Change {
	return {
		id: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B",
		at: c.at,
		by: c.by,
		channel: c.channel,
		op: "create",
		entryId: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6C",
		before: null,
		after: { ...newEntry("01K8ZQ4R7S9T2V5W8X1Y3Z5A6C"), kind: "note", title: c.title },
	};
}

describe("the help text and the command lines", () => {
	it("is Go's helpText, byte for byte (commands.go:24-40)", () => {
		expect(HELP_TEXT).toBe(GOLDEN.help_text);
		// The menu's own line, and the sentence TestCommands looks for.
		expect(HELP_TEXT).toContain("Every change comes back with an Undo button.");
		expect(HELP_TEXT).toContain("/checkin today's tasks and yesterday's open ones, with Done buttons");
	});

	it("names an unknown command in its own case and answers /checkin until T5.1", () => {
		expect(unknownCommand("Foo")).toBe("I don't know /Foo. Send /help to see what I can do.");
		// A bare "/" is an empty command word (commands.go:69-70).
		expect(unknownCommand("")).toBe("I don't know /. Send /help to see what I can do.");
		expect(CHECKIN_UNAVAILABLE).toBe("The check-in isn't available yet.");
	});
});

describe("counts (docs.go:81-95)", () => {
	it("joins the non-zero counts in Go's order, or says nothing changed", () => {
		for (const c of GOLDEN.counts) expect(counts(syncOf(c))).toBe(c.out);
		// The order is added, changed, removed, failed — the one thing a port can
		// get wrong without noticing.
		expect(counts(syncOf({ added: 4, changed: 3, removed: 2, failed: 1, out: "" }))).toBe(
			"4 added, 3 changed, 2 removed, 1 failed",
		);
	});
});

describe("docList (docs.go:97-119)", () => {
	it("writes one line per document with Go's state suffix and the …and n more cut", () => {
		for (const c of GOLDEN.doc_list) expect(docList((c.docs ?? []).map(docOf), c.max)).toBe(c.out);
	});

	it("prefers removed, then failed, then the kept-error line, and lets a scan say it is not searchable", () => {
		const scan = { ...emptyDoc("docs/raw/Leaflet.pdf", "i"), class: CLASS_SCANNED, status: STATUS_OK };
		// A scanned document with a kept error is the error case, not the scan one.
		expect(docList([{ ...scan, error: "x" }], 10)).toBe(
			"• Leaflet.pdf (the new version couldn't be read; the previous one is still used)",
		);
		expect(docList([{ ...scan, status: STATUS_REMOVED }], 10)).toBe("• Leaflet.pdf (removed)");
		expect(docList([{ ...scan, status: STATUS_FAILED }], 10)).toBe("• Leaflet.pdf (couldn't be read)");
	});
});

describe("the /recent line (commands.go:84-96)", () => {
	it("formats Go's time in the app's zone and marks a web change", () => {
		for (const c of GOLDEN.recent) expect(recentLine(changeOf(c), c.loc)).toBe(c.out);
	});

	it("shows an unparseable `at` as it is, and 00:00 rather than 24:00", () => {
		expect(recentAt("2026-11-12 14:00", "UTC")).toBe("2026-11-12 14:00");
		// Go's Parse refuses a day the month does not have.
		expect(recentAt("2026-02-30T14:00:00Z", "UTC")).toBe("2026-02-30T14:00:00Z");
		expect(recentAt("2026-11-11T16:00:00Z", "Asia/Singapore")).toBe("Thu 12 Nov 00:00");
		// An offset is part of the instant, not the zone shown.
		expect(recentAt("2026-11-12T23:30:00+08:00", "UTC")).toBe("Thu 12 Nov 15:30");
	});

	it("skips a journal record Go's ChangeText would panic on, instead of losing the reply", () => {
		// Go 1.0.x still writes this `set_dates` meta record while a rollback runs
		// (spec §6.3): ChangeText has no branch for it and panics, which costs Go
		// the whole answer.
		const meta: Change = {
			id: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6D",
			at: "2026-11-12T14:00:00Z",
			by: "ZY",
			channel: "telegram",
			op: "meta",
			entryId: "",
			before: null,
			after: null,
		};
		expect(recentLine(meta, "UTC")).toBeNull();
		// The records around it still render.
		const saved = changeOf(GOLDEN.recent[0] as Golden["recent"][number]);
		expect(recentLine(saved, "UTC")).toBe("• Saved: note · Theirs — Partner, Thu 12 Nov 14:00");
	});

	it("still throws for a record ChangeText cannot describe, so the panic guard has something to catch", () => {
		// A create with no after side is a corrupt record, not an old op: the bot
		// must log `telegram handler panicked` rather than pretend it is nothing.
		const broken: Change = { ...changeOf(GOLDEN.recent[0] as Golden["recent"][number]), after: null };
		expect(() => recentLine(broken, "UTC")).toThrow(TypeError);
		// And the same record through ChangeText is what throws.
		expect(() => ChangeText(broken)).toThrow(TypeError);
	});
});

describe("the /sync reason", () => {
	it("is Go's `telegram:<chat id>`, which T5.2's notice skips on (docs.go:14)", () => {
		expect(SYNC_REASON_PREFIX).toBe("telegram:");
		expect(SYNC_REASON_PREFIX + String(-1001)).toBe("telegram:-1001");
	});
});
