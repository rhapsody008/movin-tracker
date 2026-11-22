// The fake converter's own contract, which the sync tests use now and the
// viewer tests (T1.5c) will use for renders: Go's fake.go answers a render with
// "PNG page=%d region=%v edge=%d", where %v of a *Region is "&{0.5 0.5 1 1}"
// and of nil "<nil>".
import { describe, expect, it } from "vitest";
import type { Page } from "../types.ts";
import { FakeConverter } from "./fake.ts";
import { BadPageError } from "./poppler.ts";

const pdf = new TextEncoder().encode("pdf-drawing-v1");
const page: Page = { n: 1, w: 1000, h: 500, text: "POWER LEGEND" };

function fake(): FakeConverter {
	const conv = new FakeConverter();
	conv.pages.set("pdf-drawing-v1", [page]);
	return conv;
}

describe("FakeConverter", () => {
	it("answers text from its table, counts calls, and hands out copies", async () => {
		const conv = fake();
		const pages = await conv.text(pdf);
		expect(pages).toEqual([page]);
		expect(conv.callCount()).toBe(1);
		// A sync empties a garbled page's text; the fake's own copy must not change.
		const first = pages[0];
		if (first === undefined) throw new Error("no page");
		first.text = "";
		expect((await conv.text(pdf))[0]?.text).toBe("POWER LEGEND");
	});

	it("fails the bodies it was told to fail, and counts that too", async () => {
		const conv = fake();
		conv.fail.set("pdf-drawing-v1", new Error("pdftotext: broken"));
		await expect(conv.text(pdf)).rejects.toThrow("pdftotext: broken");
		await expect(conv.text(new TextEncoder().encode("other"))).rejects.toThrow("fake: unknown PDF");
		expect(conv.callCount()).toBe(2);
	});

	it("renders Go's fake PNG text, and refuses a page the document has not got", async () => {
		const conv = fake();
		const whole = new TextDecoder().decode(await conv.render(pdf, 1, null, 1568));
		expect(whole).toBe("PNG page=1 region=<nil> edge=1568");
		const crop = new TextDecoder().decode(await conv.render(pdf, 1, { x0: 0.5, y0: 0.5, x1: 1, y1: 1 }, 1568));
		expect(crop).toBe("PNG page=1 region=&{0.5 0.5 1 1} edge=1568");
		await expect(conv.render(pdf, 2, null, 1568)).rejects.toBeInstanceOf(BadPageError);
		await expect(conv.render(new TextEncoder().encode("other"), 1, null, 1568)).rejects.toThrow("fake: unknown PDF");
		// Go counts a render before it checks the page, so the two refusals count too.
		expect(conv.renders).toBe(4);
	});
});
