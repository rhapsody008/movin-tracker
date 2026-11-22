// A fake PDF tool set for tests: it answers from `pages` keyed by the PDF's own
// bytes, fails for the bodies listed in `fail`, and counts calls so a test can
// prove a sync read a file once and not twice. Port of
// internal/docs/convert/fake.go.
//
// The pages handed out are copies, because a sync empties the text and words of
// a garbled page: Go copies the structs on the way out, so the fake's own table
// must not change. Bodies are keyed byte for byte (latin1 maps every byte to one
// character), which is what Go's string(pdf) does.

import type { Page, Region } from "../types.ts";
import { BadPageError } from "./poppler.ts";

export class FakeConverter {
	readonly pages = new Map<string, Page[]>();
	readonly fail = new Map<string, Error>();
	/** Text calls, failures included. */
	calls = 0;
	renders = 0;
	/** Each text call waits this long first (ms): single-flight tests need the run to yield. */
	delay = 0;

	async text(pdf: Uint8Array): Promise<Page[]> {
		if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay));
		this.calls++;
		const key = keyOf(pdf);
		const err = this.fail.get(key);
		if (err !== undefined) throw err;
		const pages = this.pages.get(key);
		if (pages === undefined) throw new Error(`fake: unknown PDF ${JSON.stringify(key)}`);
		return pages.map(copyPage);
	}

	async render(pdf: Uint8Array, page: number, region: Region | null, longEdge: number): Promise<Uint8Array> {
		this.renders++;
		const pages = this.pages.get(keyOf(pdf));
		if (pages === undefined) throw new Error(`fake: unknown PDF ${JSON.stringify(keyOf(pdf))}`);
		checkPage(pages, page);
		// Go's %v of a *Region: "<nil>" or "&{0.5 0.5 1 1}".
		const where = region === null ? "<nil>" : `&{${region.x0} ${region.y0} ${region.x1} ${region.y1}}`;
		return new TextEncoder().encode(`PNG page=${page} region=${where} edge=${longEdge}`);
	}

	/** Calls under no lock; here for the Go name the tests use. */
	callCount(): number {
		return this.calls;
	}
}

function keyOf(pdf: Uint8Array): string {
	return Buffer.from(pdf).toString("latin1");
}

function copyPage(p: Page): Page {
	return { ...p, ...(p.words === undefined ? {} : { words: p.words.map((w) => ({ t: w.t, b: [...w.b] })) }) };
}

/** Go's convert.checkPage: the page must exist. */
function checkPage(pages: readonly Page[], page: number): void {
	if (page < 1 || page > pages.length) throw new BadPageError(page, pages.length);
}
