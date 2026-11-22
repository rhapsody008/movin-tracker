// One-line summaries of documents: the model's answer, tidied into a single
// line, and the rule for when a run asks for one. Port of internal/docs/
// summary.go and the summary half of sync.go (docs-spec §4).

import { goTrim, goTrimSpace } from "../gostr.ts";
import { CLASS_SCANNED, type Doc } from "./index.ts";
import type { Page } from "./types.ts";

/** MaxSummaryLen caps a summary (runes): it is one line in every prompt. */
export const MAX_SUMMARY_LEN = 160;

/** How much of a document's text the model sees. */
export const SUMMARY_TEXT_CHARS = 3000;

/**
 * The system prompt of Go's LLMSummariser, byte for byte.
 *
 * T3.1: the LLM-backed summariser plugs in here. Go's LLMSummariser resolves
 * the saved connection on every call (`no LLM connection configured` when there
 * is none), forces Streaming = false, sends this prompt plus one user message
 * "File: <folder/>name\n\nStart of the text:\n<text>" and returns
 * tidySummary(reply). It needs the LLM layer first, so this step only defines
 * the interface and the prompt.
 */
export const SUMMARY_PROMPT =
	"You write one-line descriptions of a family's household documents (a new condo: drawings, checklists, letters, appliance manuals). " +
	"Given a file name and the start of its text, answer with one plain line of at most 20 words saying what the document is and what it is useful for. " +
	"No quotes, no lead-in, no personal details such as names, phone numbers, emails or passwords.";

/** What a sync needs from the model (Go's docs.Summariser). */
export interface Summariser {
	/** One line about the document, from the start of its text. */
	summarise(d: Doc, text: string, signal?: AbortSignal): Promise<string>;
}

/**
 * The per-run memo of summaries, keyed by `key|etag`: "" means tried and
 * failed. It lives for the whole run, so a redone attempt never buys the same
 * summary twice.
 */
export type SummaryMemo = Map<string, string>;

/** The memo key of one version of one file (Go's memoKey in sync.go). */
export function memoKey(key: string, etag: string): string {
	return `${key}|${etag}`;
}

/**
 * tidySummary keeps the first non-empty line, without quotes, capped at
 * MAX_SUMMARY_LEN runes. The cut counts code points, as Go's []rune does: a
 * .slice(-1) here would cut an emoji in half.
 */
export function tidySummary(s: string): string {
	for (const raw of s.split("\n")) {
		let line = goTrim(goTrimSpace(raw), `"'\u201c\u201d`);
		if (line === "") continue;
		const runes = [...line];
		if (runes.length > MAX_SUMMARY_LEN) line = `${goTrimSpace(runes.slice(0, MAX_SUMMARY_LEN - 1).join(""))}…`;
		return line;
	}
	return "";
}

/**
 * firstText returns up to max characters of the document's text, from the first
 * pages on. Characters are code points, not UTF-16 units (Go counts runes).
 */
export function firstText(pages: readonly Page[], max: number): string {
	let text = "";
	let count = 0;
	for (const p of pages) {
		if (count >= max) break;
		const chunk = `${p.text}\n`;
		text += chunk;
		count += [...chunk].length;
	}
	if (count <= max) return text;
	return [...text].slice(0, max).join("");
}

/**
 * retrySummary fills a missing summary of an unchanged document: at most one
 * attempt per run, never for a scan and never when a summary is already there
 * (the caller only calls this when a Summariser is configured).
 *
 * `bought` is the summary a conversion of the same file bought earlier in this
 * run; it is reused instead of asking twice. An unreadable text blob is also
 * remembered, so the model is asked at most once per run and per file.
 */
export async function retrySummary(o: {
	d: Doc;
	memo: SummaryMemo;
	bought: string;
	readPages: () => Promise<Page[]>;
	summarise: (pages: Page[]) => Promise<string>;
}): Promise<string> {
	if (o.d.summary !== "" || o.d.class === CLASS_SCANNED) return o.d.summary;
	const k = memoKey(o.d.key, o.d.etag);
	if (o.bought !== "") {
		o.memo.set(k, o.bought);
		return o.bought;
	}
	const tried = o.memo.get(k);
	if (tried !== undefined) return tried;
	// A text blob that can't be read leaves the summary empty and is not
	// retried until the next run, as in Go.
	const pages = await o.readPages().catch(() => null);
	const sum = pages === null ? "" : await o.summarise(pages);
	o.memo.set(k, sum);
	return sum;
}
