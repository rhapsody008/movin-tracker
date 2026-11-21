// Port of internal/docs/convert/poppler_test.go. The real tools come from
// app/Dockerfile.test (the `app-test` image installs poppler-utils, so unlike
// the Go tests these never skip), run against the same hand-built
// testdata/sample.pdf; the cases a real tool cannot produce (a tool that hangs,
// a grandchild the kill cannot reach, HTML entities in a word) use shell
// scripts on PATH, as the Go tests do.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Page, regionValid } from "../types.ts";
import {
	BadPageError,
	createPoppler,
	DEFAULT_MAX_OUTPUT,
	DEFAULT_TEXT_TIMEOUT_MS,
	DEFAULT_TIMEOUT_MS,
	MAX_LONG_EDGE,
	pixelBox,
} from "./poppler.ts";

const sample: Uint8Array = readFileSync(fileURLToPath(new URL("./testdata/sample.pdf", import.meta.url)));
const realSample = process.env.MOVIN_SAMPLE_PDF ?? "";

/** Writes fake tools and returns a PATH with their directory first (Go: t.Setenv("PATH", dir+":"+…)). */
function fakeTools(scripts: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "poppler-"));
	for (const [name, script] of Object.entries(scripts)) {
		const file = join(dir, name);
		writeFileSync(file, script, { mode: 0o755 });
		chmodSync(file, 0o755); // the mode above is masked by the umask
	}
	return `${dir}:${process.env.PATH ?? ""}`;
}

/** The environment a fake-tool run gets: ours, with that PATH (Go's t.Setenv). */
function fakeEnv(scripts: Record<string, string>): NodeJS.ProcessEnv {
	return { ...process.env, PATH: fakeTools(scripts) };
}

/** A fake pdfinfo that hangs: the `sleep` grandchild holds stdout open after the kill. */
const HANGING_PDFINFO = "#!/bin/sh\nsleep 30\n";

// One drawing-sized page, so text() also asks for word boxes.
const FAKE_SIZES = `#!/bin/sh
cat <<'EOF'
Pages:           1
Page    1 size: 842 x 1191
Page    1 rot:   0
EOF
`;

// Words with every escape poppler emits, a numeric-only word, an unknown
// entity, a reference Go answers U+FFFD for, and one blank word to skip.
const FAKE_TEXT = `#!/bin/sh
case "$1" in
-bbox-layout)
	cat <<'EOF'
<body><doc>
  <page width="842.000000" height="1191.000000">
    <word xMin="10.000000" yMin="20.000000" xMax="30.000000" yMax="40.000000">A&amp;B</word>
    <word xMin="50.000000" yMin="60.000000" xMax="70.000000" yMax="80.000000">&#65;&#x42;</word>
    <word xMin="90.000000" yMin="100.000000" xMax="110.000000" yMax="120.000000">&lt;tag&gt;</word>
    <word xMin="130.000000" yMin="140.000000" xMax="150.000000" yMax="160.000000">&quot;q&quot;&apos;</word>
    <word xMin="170.000000" yMin="180.000000" xMax="190.000000" yMax="200.000000">&#x1F600;</word>
    <word xMin="210.000000" yMin="220.000000" xMax="230.000000" yMax="240.000000">&unknown;</word>
    <word xMin="250.000000" yMin="260.000000" xMax="270.000000" yMax="280.000000">&#0;</word>
    <word xMin="290.000000" yMin="300.000000" xMax="310.000000" yMax="320.000000">   </word>
  </page>
</doc></body>
EOF
	;;
*)
	printf 'hello &amp; goodbye\\n\\f'
	;;
esac
`;

function page(pages: Page[], n: number): Page {
	const found = pages[n - 1];
	if (found === undefined) throw new Error(`no page ${n} of ${pages.length}`);
	return found;
}

/** The width and height in a PNG's IHDR chunk. */
function pngSize(png: Uint8Array): { w: number; h: number } {
	if (png.length < 24 || png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
		throw new Error(`not a PNG (${png.length} bytes)`);
	}
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { w: view.getUint32(16), h: view.getUint32(20) };
}

/** The error a call failed with; vitest's rejects matchers cannot also time the call. */
async function rejection<T>(call: Promise<T>): Promise<Error> {
	try {
		await call;
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("the call did not fail");
}

describe("poppler", () => {
	const poppler = createPoppler();

	it("text() reads the three pages of sample.pdf and the A3 page's word boxes", { timeout: 30_000 }, async () => {
		const pages = await poppler.text(sample);
		expect(pages).toHaveLength(3);
		// Page 1: A4 text, no word boxes (not a drawing-sized page).
		const first = page(pages, 1);
		expect([first.n, first.w, first.h]).toEqual([1, 595, 842]);
		expect(first.text).toContain("Kitchen countertop: sintered stone");
		expect(first.words).toBeUndefined();
		// Page 2: A3 rotated 90 → displayed landscape, with word boxes in that space.
		const second = page(pages, 2);
		expect([second.w, second.h]).toEqual([1191, 842]);
		expect(second.text).toContain("BALCONY");
		const balcony = (second.words ?? []).find((w) => w.t === "BALCONY");
		if (balcony === undefined) throw new Error(`no BALCONY word on page 2: ${JSON.stringify(second.words)}`);
		expect(balcony.b[2]).toBeLessThanOrEqual(second.w);
		expect(balcony.b[3]).toBeLessThanOrEqual(second.h);
		expect(balcony.b[0]).toBeGreaterThanOrEqual(0);
		expect(balcony.b[0]).toBeLessThan(balcony.b[2]);
		// Page 3: blank.
		expect(page(pages, 3).text).toBe("");
	});

	it("render() draws page 2 whole and as a quarter crop at the requested size", { timeout: 30_000 }, async () => {
		const whole = pngSize(await poppler.render(sample, 2, null, 800)); // 1191x842 → 800x566
		expect(whole.w).toBe(800);
		expect(whole.h).toBeGreaterThanOrEqual(560);
		expect(whole.h).toBeLessThanOrEqual(570);
		const crop = pngSize(await poppler.render(sample, 2, { x0: 0.5, y0: 0, x1: 1, y1: 0.5 }, 400));
		expect(crop.w).toBe(400);
		expect(crop.h).toBeGreaterThanOrEqual(280);
		expect(crop.h).toBeLessThanOrEqual(285);
		// MAX_LONG_EDGE caps a render, never an upscale beyond it.
		expect(pngSize(await poppler.render(sample, 2, null, 5000)).w).toBe(MAX_LONG_EDGE);
	});

	it("render() refuses a page outside the document and an inside-out region", { timeout: 30_000 }, async () => {
		await expect(poppler.render(sample, 9, null, 400)).rejects.toBeInstanceOf(BadPageError);
		await expect(poppler.render(sample, 9, null, 400)).rejects.toThrow("no such page 9 (the document has 3)");
		await expect(poppler.render(sample, 1, { x0: 0.5, y0: 0, x1: 0.4, y1: 1 }, 400)).rejects.toThrow(
			"region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1",
		);
	});

	it("text() reports what a tool said on stderr and its exit status", { timeout: 30_000 }, async () => {
		const err = await rejection(poppler.text(new TextEncoder().encode("not a pdf")));
		expect(err.message).toBe("pdfinfo: exit status 1: Syntax Error: Couldn't read xref table");
	});

	it("pixelBox() maps the right half of an A1 sheet to a 1568 px crop", () => {
		// The right half of an A1 landscape sheet (2384x1684 pt) is 1192x1684 pt:
		// its long edge is the height, so that becomes 1568 px.
		const box = pixelBox(2384, 1684, { x0: 0.5, y0: 0, x1: 1, y1: 1 }, 1568);
		expect(box.height).toBe(1568);
		expect(box.width).toBeGreaterThanOrEqual(1108);
		expect(box.width).toBeLessThanOrEqual(1111);
		expect(box.x).toBeGreaterThanOrEqual(1108);
		expect(box.x).toBeLessThanOrEqual(1111);
		expect(box.y).toBe(0);
		expect(box.dpi).toBeGreaterThanOrEqual(67.0);
		expect(box.dpi).toBeLessThanOrEqual(67.1);
		expect(regionValid({ x0: 0, y0: 0, x1: 1, y1: 1 })).toBe(true);
		expect(regionValid({ x0: 0.2, y0: 0, x1: 0.2, y1: 1 })).toBe(false);
		expect(regionValid({ x0: -0.1, y0: 0, x1: 1, y1: 1 })).toBe(false);
	});

	it("the defaults are Go's", () => {
		expect(DEFAULT_MAX_OUTPUT).toBe(16 << 20);
		expect(DEFAULT_TEXT_TIMEOUT_MS).toBe(30_000);
		expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
		expect(MAX_LONG_EDGE).toBe(2000);
	});

	// Go's TestPopplerTimeoutKillsTheTool: the tool's own timeout kills it, and
	// the run settles without the `sleep` that still holds stdout.
	it("text() kills the tool at its timeout and returns without the grandchild", { timeout: 20_000 }, async () => {
		const p = createPoppler({ textTimeoutMs: 300, env: fakeEnv({ pdfinfo: HANGING_PDFINFO }) });
		const started = Date.now();
		const err = await rejection(p.text(sample));
		const elapsed = Date.now() - started;
		expect(err.message).toBe("pdfinfo: context deadline exceeded");
		expect(elapsed).toBeLessThan(5000);
	});

	// Go's TestPopplerWaitRespectsContext: one caller holds the slot, and a
	// second whose own signal ends stops waiting for its turn.
	it("a caller whose signal ends stops waiting for the tool slot", { timeout: 30_000 }, async () => {
		const p = createPoppler({ textTimeoutMs: 1000, env: fakeEnv({ pdfinfo: HANGING_PDFINFO }) });
		const holding = rejection(p.text(sample)); // holds the slot until its own timeout
		await new Promise((resolve) => setTimeout(resolve, 200));
		const started = Date.now();
		const err = await rejection(p.render(sample, 1, null, 200, AbortSignal.timeout(200)));
		const elapsed = Date.now() - started;
		expect(err.message).toBe("pdfinfo: waiting for the PDF tools: context deadline exceeded");
		expect(elapsed).toBeLessThan(1000);
		expect((await holding).message).toBe("pdfinfo: context deadline exceeded");
	});

	// F2 d: a caller that gives up while waiting must hand the slot on. Without
	// the release before the throw, the queue behind it never moves again.
	it("a caller that gives up while waiting leaves the slot to a later call", { timeout: 20_000 }, async () => {
		const dir = mkdtempSync(join(tmpdir(), "poppler-slot-"));
		const slow = join(dir, "slow");
		writeFileSync(slow, "");
		const script = `#!/bin/sh
if [ -f ${slow} ]; then sleep 30; fi
cat <<'EOF'
Pages:           1
Page    1 size: 842 x 1191
Page    1 rot:   0
EOF
`;
		const p = createPoppler({ textTimeoutMs: 1000, env: fakeEnv({ pdfinfo: script, pdftotext: FAKE_TEXT }) });
		// The first caller holds the solo slot until its own timeout.
		const holding = rejection(p.text(sample));
		await new Promise((resolve) => setTimeout(resolve, 100));
		const gaveUp = await rejection(p.text(sample, AbortSignal.timeout(100)));
		expect(gaveUp.message).toBe("pdfinfo: waiting for the PDF tools: context deadline exceeded");
		expect((await holding).message).toBe("pdfinfo: context deadline exceeded");

		// The tool is quick now: a later call must get the slot and succeed.
		rmSync(slow);
		const pages = await Promise.race([
			p.text(sample),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("the slot was never released to the next caller")), 3000),
			),
		]);
		expect(page(pages, 1).w).toBe(842);
	});

	// F2 e: the caller's own abort kills the running tool, not just its wait. The
	// run settles KILL_SETTLE_MS after the kill (the `sleep` grandchild holds the
	// pipes), so about 2 s is the floor; the tool's own timeout is 30 s.
	it("a caller's abort kills a running tool well before its timeout", { timeout: 30_000 }, async () => {
		const p = createPoppler({ textTimeoutMs: 30_000, env: fakeEnv({ pdfinfo: HANGING_PDFINFO }) });
		const controller = new AbortController();
		const started = Date.now();
		const running = rejection(p.text(sample, controller.signal));
		setTimeout(() => controller.abort(), 200);
		const err = await Promise.race([
			running,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("the running tool was not killed by the abort")), 5000),
			),
		]);
		expect(err.message).toBe("pdfinfo: context canceled");
		expect(Date.now() - started).toBeLessThan(5000);
	});

	// Go's TestPopplerOutputCap: the cap is reported on a clean exit, and the
	// tool is not killed for it.
	it("text() reports the output cap and does not kill the tool for it", { timeout: 20_000 }, async () => {
		const err = await rejection(createPoppler({ maxOutput: 50 }).text(sample));
		expect(err.message).toBe("pdfinfo: output larger than 50 bytes");
	});

	// Go's TestPopplerText word handling (poppler.go html.UnescapeString).
	it("text() unescapes word text, keeps unknown entities and skips blank words", { timeout: 20_000 }, async () => {
		const pages = await createPoppler({ env: fakeEnv({ pdfinfo: FAKE_SIZES, pdftotext: FAKE_TEXT }) }).text(sample);
		expect(pages).toHaveLength(1);
		const only = page(pages, 1);
		expect(only.text).toBe("hello &amp; goodbye"); // page text is not unescaped, only words are
		expect(only.words).toEqual([
			{ t: "A&B", b: [10, 20, 30, 40] },
			{ t: "AB", b: [50, 60, 70, 80] },
			{ t: "<tag>", b: [90, 100, 110, 120] },
			{ t: `"q"'`, b: [130, 140, 150, 160] },
			{ t: "😀", b: [170, 180, 190, 200] },
			{ t: "&unknown;", b: [210, 220, 230, 240] },
			{ t: "\uFFFD", b: [250, 260, 270, 280] },
		]);
	});

	// Real documents only when a path is given (never committed), as in Go.
	it.skipIf(realSample === "")("text() reads a real document", { timeout: 120_000 }, async () => {
		const pages = await createPoppler().text(readFileSync(realSample));
		expect(pages.length).toBeGreaterThan(0);
	});
});
