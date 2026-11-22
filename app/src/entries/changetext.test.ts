// The change line, against the Go program's own answers. The fixture comes from
// the Go v1 code, tag v1.0.1, golden t21 (agent.Money, agent.Summary and agent.ChangeText), so
// this compares the port with Go rather than with a guess.
//
// It lives in src/server/testdata beside the HTTP transcript, not in
// entries/testdata: that directory is the document round-trip set that
// model.test.ts reads (every <name>.go.json there must re-encode from its
// <name>.json), and a table of answers is not a stored document.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ChangeText, fmtDate, Money, Summary } from "./changetext.ts";
import { decodeDoc } from "./model.ts";

interface Fixture {
	fmtDate: { in: string; out: string }[];
	money: { in: number; out: string }[];
	/** Every Change of the table, in one document, so decodeDoc can read them. */
	doc: unknown;
	changeTexts: string[];
}

const fixture = JSON.parse(
	readFileSync(new URL("../server/testdata/changetext.go.json", import.meta.url), "utf8"),
) as Fixture;

describe("the change line (Go golden)", () => {
	it("spells a day as Go's Mon, 2 Jan, and hands back what is not a day (fmtDate)", () => {
		expect(fixture.fmtDate.length).toBeGreaterThan(5);
		for (const c of fixture.fmtDate) expect([c.in, fmtDate(c.in)]).toEqual([c.in, c.out]);
	});

	it("formats money as Go does, cents carry and negatives included (Money)", () => {
		expect(fixture.money.length).toBeGreaterThan(10);
		for (const c of fixture.money) expect([c.in, Money(c.in)]).toEqual([c.in, c.out]);
	});

	it("writes every change line Go writes (ChangeText)", () => {
		const doc = decodeDoc(JSON.stringify(fixture.doc));
		expect(doc.changes.length).toBe(fixture.changeTexts.length);
		expect(doc.changes.length).toBeGreaterThanOrEqual(30);
		doc.changes.forEach((change, i) => {
			expect([change.op, ChangeText(change)]).toEqual([change.op, fixture.changeTexts[i]]);
		});
	});

	it("describes an entry the way the banner does (Summary)", () => {
		const doc = decodeDoc(JSON.stringify(fixture.doc));
		// The first change is a create whose Summary is the tail of its line.
		const first = doc.changes[0];
		if (first === undefined || first.after === null) throw new Error("fixture: no create");
		expect(`Saved: ${Summary(first.after)}`).toBe(fixture.changeTexts[0]);
	});
});
