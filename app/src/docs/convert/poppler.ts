// The PDF tools: pdfinfo for page sizes, pdftotext for the text of each page
// and the word boxes of a drawing, pdftocairo for renders. Port of
// internal/docs/convert (convert.go, poppler.go; docs-spec §3): the PDF goes in
// on stdin, results come back on stdout, nothing is written to disk (the
// production root filesystem is read-only).
//
// One tool runs at a time per instance, so a big render can't stack up memory;
// a caller whose signal ends stops waiting for its turn, and each run is killed
// with its own timeout or the caller's signal. As in Go the kill is SIGKILL to
// the direct child only, and the run stops waiting for the inherited pipes 2 s
// later (Go's exec.Cmd.WaitDelay; docs-spec §9.1: a grandchild holding stdout
// open must not keep the call alive).

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { goTrimSpace } from "../../gostr.ts";
import { type Page, type Region, regionValid, type Word } from "../types.ts";

/** One render (Go's DefaultTimeout). */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** One pdfinfo/pdftotext run (Go's DefaultTextTimeout): these run in syncs, and a chat view waits behind them. */
export const DEFAULT_TEXT_TIMEOUT_MS = 30_000;
/** One tool's stdout (Go's DefaultMaxOutput; the largest real document's text with word boxes is about 90 KB). */
export const DEFAULT_MAX_OUTPUT = 16 << 20;
/** Renders are capped: big enough to read a crop, small enough for a model's image input. */
export const MAX_LONG_EDGE = 2000;

/** Word boxes are kept for pages at least this big (0.95 × A3, as docs.Classify). */
const WORDS_MIN_AREA = 0.95 * 842 * 1191;
/** Go caps a tool's stderr at 4096 bytes; only its last line goes into an error. */
const STDERR_CAP = 4096;
/** Go's exec.Cmd.WaitDelay: after the kill, stop waiting for the inherited pipes. */
const KILL_SETTLE_MS = 2000;
const REGION_MESSAGE = "region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1";

const utf8 = new TextDecoder("utf-8");
// pdfinfo prints one "Page    N size:" and one "Page    N rot:" line per page.
const SIZE_RE = /^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)/gm;
const ROT_RE = /^Page\s+(\d+) rot:\s+(\d+)/gm;
// pdftotext -bbox-layout words; the name is XHTML-escaped text.
const WORD_RE = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
const PAGE_RE = /<page width=/g;
const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The page number is outside the document (Go's ErrBadPage). */
export class BadPageError extends Error {
	constructor(page: number, pages: number) {
		super(`no such page ${page} (the document has ${pages})`);
		this.name = "BadPageError";
	}
}

export interface Poppler {
	/** Every page's size and text; word boxes are added when a page is drawing-sized. */
	text(pdf: Uint8Array, signal?: AbortSignal): Promise<Page[]>;
	/** A PNG of page `page` (1-based) or of `region` of it, `longEdge` pixels on its longer side. */
	render(
		pdf: Uint8Array,
		page: number,
		region: Region | null,
		longEdge: number,
		signal?: AbortSignal,
	): Promise<Uint8Array>;
}

export interface PopplerOptions {
	/** One render; default DEFAULT_TIMEOUT_MS. */
	timeoutMs?: number;
	/** One pdfinfo/pdftotext run; default DEFAULT_TEXT_TIMEOUT_MS. */
	textTimeoutMs?: number;
	/** One tool's stdout, in bytes; default DEFAULT_MAX_OUTPUT. */
	maxOutput?: number;
	/**
	 * Test only: the environment the tools run in, defaulting to process.env. The
	 * Go tests put a directory of fake tools first on PATH (t.Setenv in
	 * poppler_test.go), and Node resolves a bare command from the child's own
	 * PATH, so passing the environment is enough.
	 */
	env?: NodeJS.ProcessEnv;
}

/** The resolution that makes a region's longer edge longEdge pixels, and the crop pdftocairo then renders. */
export function pixelBox(
	w: number,
	h: number,
	r: Region,
	longEdge: number,
): { dpi: number; x: number; y: number; width: number; height: number } {
	const rw = (r.x1 - r.x0) * w;
	const rh = (r.y1 - r.y0) * h;
	const dpi = (longEdge * 72) / Math.max(rw, rh);
	const scale = dpi / 72;
	return {
		dpi,
		x: Math.trunc(r.x0 * w * scale),
		y: Math.trunc(r.y0 * h * scale),
		width: Math.trunc(rw * scale + 0.5),
		height: Math.trunc(rh * scale + 0.5),
	};
}

/** Trailing spaces, tabs and carriage returns off each line; runs of blank lines collapsed to one; trimmed. */
function tidy(text: string): string {
	const out: string[] = [];
	let blank = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.replace(/[ \t\r]+$/, "");
		if (trimmed === "") {
			blank++;
			if (blank > 1) continue;
		} else {
			blank = 0;
		}
		out.push(trimmed);
	}
	return goTrimSpace(out.join("\n"));
}

/**
 * The HTML unescaping of a word (Go: html.UnescapeString). Poppler writes XHTML,
 * so the five XML entities and numeric references are what it emits; Go's table
 * is much larger (docs-spec §3 and the T1.5a report list the differences).
 */
function unescapeHTML(text: string): string {
	return text.replace(
		/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g,
		(whole: string, dec?: string, hex?: string, name?: string) => {
			if (name !== undefined) return XML_ENTITIES[name] ?? whole;
			const code = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? "", 16);
			// Go answers U+FFFD for a reference that is not a character.
			if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\uFFFD";
			return String.fromCodePoint(code);
		},
	);
}

/** Go's context error text; an AbortSignal.timeout() reads as a deadline, as Go's does. */
function contextError(signal: AbortSignal | undefined): string {
	const reason: unknown = signal?.reason;
	if (reason instanceof Error && reason.name === "TimeoutError") return "context deadline exceeded";
	return "context canceled";
}

/** Go's zero-value rule: an unset or non-positive limit means the default. */
function positive(value: number | undefined, fallback: number): number {
	return value !== undefined && value > 0 ? value : fallback;
}

interface ExecOptions {
	tool: string;
	args: string[];
	pdf: Uint8Array;
	timeoutMs: number;
	maxOutput: number;
	env: NodeJS.ProcessEnv;
	signal: AbortSignal | undefined;
}

interface Exit {
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

/** The last line of a tool's stderr, as poppler.go builds it. */
function lastLine(text: string): string {
	const trimmed = goTrimSpace(text);
	const cut = trimmed.lastIndexOf("\n");
	return cut < 0 ? trimmed : trimmed.slice(cut + 1);
}

function exitStatus(r: Exit): string {
	return r.code === null ? `signal: ${r.signal ?? "unknown"}` : `exit status ${r.code}`;
}

/**
 * One tool process. Resolves with its stdout, or throws with Go's error text:
 * "<tool>: context deadline exceeded" / "context canceled" (the run was
 * killed), "<tool>: <exit status>: <last stderr line>", or
 * "<tool>: output larger than <n> bytes" (a successful exit that overflowed).
 */
async function execTool(o: ExecOptions): Promise<Uint8Array> {
	const child: ChildProcessWithoutNullStreams = spawn(o.tool, o.args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: o.env,
	});
	const out: Uint8Array[] = [];
	let outSize = 0;
	let over = false;
	const err: Uint8Array[] = [];
	let errSize = 0;
	// Both caps keep the first N bytes and swallow the rest without killing the
	// tool (Go's capped writer, docs-spec §9.2); over is only reported on a
	// successful exit.
	child.stdout.on("data", (chunk: Uint8Array) => {
		const room = o.maxOutput - outSize;
		if (chunk.length > room) {
			over = true;
			if (room > 0) {
				out.push(chunk.subarray(0, room));
				outSize = o.maxOutput;
			}
			return;
		}
		out.push(chunk);
		outSize += chunk.length;
	});
	child.stderr.on("data", (chunk: Uint8Array) => {
		const room = STDERR_CAP - errSize;
		if (chunk.length > room) {
			if (room > 0) {
				err.push(chunk.subarray(0, room));
				errSize = STDERR_CAP;
			}
			return;
		}
		err.push(chunk);
		errSize += chunk.length;
	});
	// EPIPE when the tool dies before reading its input; Go ignores write errors the same way.
	child.stdin.on("error", () => undefined);
	child.stdin.end(o.pdf);

	const exit = Promise.withResolvers<Exit>();
	let settled = false;
	const settle = (r: Exit): void => {
		if (settled) return;
		settled = true;
		exit.resolve(r);
	};
	child.on("error", (error) => settle({ code: null, signal: null, error }));
	child.on("close", (code, signal) => settle({ code, signal }));

	let killed: "timeout" | "aborted" | null = null;
	let settleTimer: NodeJS.Timeout | undefined;
	const timer = setTimeout(() => kill("timeout"), o.timeoutMs);
	const onAbort = (): void => kill("aborted");
	o.signal?.addEventListener("abort", onAbort, { once: true });
	if (o.signal?.aborted === true) kill("aborted");
	const result = await exit.promise;
	clearTimeout(timer);
	if (settleTimer !== undefined) clearTimeout(settleTimer);
	o.signal?.removeEventListener("abort", onAbort);

	if (killed === "timeout") throw new Error(`${o.tool}: context deadline exceeded`);
	if (killed === "aborted") throw new Error(`${o.tool}: ${contextError(o.signal)}`);
	const stderr = lastLine(utf8.decode(Buffer.concat(err)));
	if (result.error !== undefined) throw new Error(`${o.tool}: ${result.error.message}: ${stderr}`);
	if (result.code !== 0) throw new Error(`${o.tool}: ${exitStatus(result)}: ${stderr}`);
	if (over) throw new Error(`${o.tool}: output larger than ${o.maxOutput} bytes`);
	return Buffer.concat(out);

	/** SIGKILL the direct child only, then — Go's WaitDelay — stop waiting for its pipes 2 s later. */
	function kill(why: "timeout" | "aborted"): void {
		if (settled || killed !== null) return;
		killed = why;
		child.kill("SIGKILL");
		settleTimer = setTimeout(() => {
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			settle({ code: null, signal: "SIGKILL" });
		}, KILL_SETTLE_MS);
	}
}

export function createPoppler(options: PopplerOptions = {}): Poppler {
	const renderTimeoutMs = positive(options.timeoutMs, DEFAULT_TIMEOUT_MS);
	const textTimeoutMs = positive(options.textTimeoutMs, DEFAULT_TEXT_TIMEOUT_MS);
	const maxOutput = positive(options.maxOutput, DEFAULT_MAX_OUTPUT);
	const env = options.env ?? process.env;
	// The one tool slot: resolves when the running tool releases its turn.
	let slot: Promise<void> = Promise.resolve();

	/** Waits for the slot, or gives up when the signal ends; the returned function releases it. */
	async function acquire(signal: AbortSignal | undefined, tool: string): Promise<() => void> {
		const previous = slot;
		const turn = Promise.withResolvers<void>();
		slot = previous.then(() => turn.promise);
		let held = true;
		const release = (): void => {
			if (held) {
				held = false;
				turn.resolve();
			}
		};
		if (aborted(signal)) {
			release(); // do not hold the slot we were queued for
			throw waitingError(tool, signal);
		}
		const giveUp = Promise.withResolvers<void>();
		const onAbort = (): void => giveUp.resolve();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([previous, giveUp.promise]);
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
		if (aborted(signal)) {
			release();
			throw waitingError(tool, signal);
		}
		return release;
	}

	async function run(
		signal: AbortSignal | undefined,
		timeoutMs: number,
		pdf: Uint8Array,
		tool: string,
		args: string[],
	): Promise<Uint8Array> {
		const release = await acquire(signal, tool);
		try {
			return await execTool({ tool, args, pdf, timeoutMs, maxOutput, env, signal });
		} finally {
			release();
		}
	}

	/** Each page's as-displayed size (rotation applied). */
	async function sizes(signal: AbortSignal | undefined, pdf: Uint8Array): Promise<[number, number][]> {
		const out = utf8.decode(await run(signal, textTimeoutMs, pdf, "pdfinfo", ["-f", "1", "-l", "100000", "-"]));
		const rotations = new Map<number, number>();
		for (const [, n = "0", rot = "0"] of out.matchAll(ROT_RE)) rotations.set(Number(n), Number(rot));
		const sizes: [number, number][] = [];
		for (const [, n = "0", wide = "0", tall = "0"] of out.matchAll(SIZE_RE)) {
			const w = Number(wide);
			const h = Number(tall);
			sizes.push((rotations.get(Number(n)) ?? 0) % 180 === 90 ? [h, w] : [w, h]);
		}
		if (sizes.length === 0) throw new Error("pdfinfo: no pages found");
		return sizes;
	}

	/** Word boxes for the drawing-sized pages, in the rotated (as-displayed) space. */
	async function words(signal: AbortSignal | undefined, pdf: Uint8Array, pages: Page[]): Promise<void> {
		const out = utf8.decode(
			await run(signal, textTimeoutMs, pdf, "pdftotext", ["-bbox-layout", "-enc", "UTF-8", "-", "-"]),
		);
		const starts: number[] = [];
		for (const m of out.matchAll(PAGE_RE)) starts.push(m.index);
		for (const [i, start] of starts.entries()) {
			const page = pages[i];
			if (page === undefined || page.w * page.h < WORDS_MIN_AREA) continue;
			const found: Word[] = [];
			for (const [, xMin = "0", yMin = "0", xMax = "0", yMax = "0", name = ""] of out
				.slice(start, starts[i + 1] ?? out.length)
				.matchAll(WORD_RE)) {
				const t = unescapeHTML(name);
				if (goTrimSpace(t) === "") continue;
				found.push({ t, b: [Number(xMin), Number(yMin), Number(xMax), Number(yMax)] });
			}
			if (found.length > 0) page.words = found;
		}
	}

	async function text(pdf: Uint8Array, signal?: AbortSignal): Promise<Page[]> {
		const pageSizes = await sizes(signal, pdf);
		const body = utf8.decode(
			await run(signal, textTimeoutMs, pdf, "pdftotext", ["-layout", "-enc", "UTF-8", "-", "-"]),
		);
		const texts = body.split("\f"); // one form feed after each page
		const pages: Page[] = [];
		let big = false;
		for (const [i, [w, h]] of pageSizes.entries()) {
			pages.push({ n: i + 1, w, h, text: tidy(texts[i] ?? "") });
			if (w * h >= WORDS_MIN_AREA) big = true;
		}
		if (big) await words(signal, pdf, pages);
		return pages;
	}

	async function render(
		pdf: Uint8Array,
		page: number,
		region: Region | null,
		longEdge: number,
		signal?: AbortSignal,
	): Promise<Uint8Array> {
		const edge = longEdge <= 0 || longEdge > MAX_LONG_EDGE ? MAX_LONG_EDGE : longEdge;
		const pageSizes = await sizes(signal, pdf);
		if (page < 1 || page > pageSizes.length) throw new BadPageError(page, pageSizes.length);
		const n = String(page);
		const base = ["-png", "-singlefile", "-f", n, "-l", n];
		if (region === null) {
			return run(signal, renderTimeoutMs, pdf, "pdftocairo", [...base, "-scale-to", String(edge), "-", "-"]);
		}
		if (!regionValid(region)) throw new Error(REGION_MESSAGE);
		const [w, h] = pageSizes[page - 1] ?? [0, 0];
		const box = pixelBox(w, h, region, edge);
		// pdftocairo renders only the cropped area, so memory stays flat at any
		// zoom (pdftoppm would rasterise the whole page first).
		return run(signal, renderTimeoutMs, pdf, "pdftocairo", [
			...base,
			"-r",
			box.dpi.toFixed(2),
			"-x",
			String(box.x),
			"-y",
			String(box.y),
			"-W",
			String(box.width),
			"-H",
			String(box.height),
			"-",
			"-",
		]);
	}

	return { text, render };
}

function waitingError(tool: string, signal: AbortSignal | undefined): Error {
	return new Error(`${tool}: waiting for the PDF tools: ${contextError(signal)}`);
}

/** signal?.aborted, read through a call so a narrow from an earlier await does not stick. */
function aborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}
