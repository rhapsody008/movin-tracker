// Go's reply rules, applied to a run's outcome: port of agent.go's turn.stopped,
// turn.finish and ParseThink (agent-spec §2.1.1, §4.5), shared by the web chat
// (T3.5) and the Telegram bot (T4).
//
// Everything here is Go's text, byte for byte. The two shapes the web route
// writes are built from one outcome: the 200/`done` Result, or the 502/`error`
// body with the changes the run made before it failed.
//
// The one v3-only row is `turn_limit`: pi-durable ends a run whose model keeps
// calling tools past the forced round with that reason instead of Go's
// forced-answer round (decisions.md · T3.2 G2), so it is answered by the same
// "nothing was said" rules Go's finish() applies — a change still gets `Done.`.

import type { ChangeLine, RunResult } from "../durable/adapter.ts";
import { goTrimSpace } from "../gostr.ts";
import type { Stop } from "../llm/complete.ts";
import { SILENT_REPLY } from "./prompt.ts";

/** Go's ThinkCommand: a message that starts with it asks the model to think first. */
export const THINK_COMMAND = "/think";

/** Go's RefusalReply: the model declined, and the turn ends successfully (agent.go:72-73). */
export const REFUSAL_REPLY = "The model declined to answer this message. Try rephrasing it.";

/** Go's NotFoundInDocsReply: a document tool was called and the model then said nothing (agent.go:76-77). */
export const NOT_FOUND_IN_DOCS_REPLY =
	"I looked in the documents but couldn't find an answer to that. Try other words, or name the document.";

/** Go's CutOffNote: appended to a reply the output limit cut short (agent.go:79-80). */
export const CUT_OFF_NOTE = " (cut off: the reply hit the length limit)";

/** Go's ErrCutOff: the limit stopped a round before it produced any text (agent.go:83). */
export const CUT_OFF_ERROR =
	"the model's reply was cut off by the output limit before it said anything; try a shorter question";

/** Go's finish(): what a turn says when it made a change and said nothing (agent.go:245-249). */
export const DONE_REPLY = "Done.";

/** Go's finish(): what a turn says when it said nothing at all (agent.go:250-251). */
export const NO_ANSWER_REPLY = "No answer came back. Try rephrasing.";

/**
 * What the page shows when the person pressed Stop (agent-spec §4.3). Go has it
 * only on the page, because a closed request cannot be answered; v3 also sends
 * it as the failed turn's line, so the other tabs' bubbles end with the same
 * words the sending tab shows.
 */
export const STOPPED_REPLY = "Stopped.";

/** The tools that make a turn "looked in the documents" (agent.go:172-176). */
export const DOC_TOOLS: readonly string[] = ["search_documents", "read_document_page"];

/** One change line as the wire carries it: Go's ChangeLine, id first (agent.go:54-57). */
export interface WireChange {
	/** The journal record's id, for the Undo chip; absent for a change that is not undoable (the key dates). */
	id?: string;
	text: string;
}

/** Go's Result (agent.go:59-68) without `usage`, which never reaches JSON. */
export interface ChatResult {
	reply: string;
	changes: WireChange[];
	model: string;
}

/** What one turn answers: Go's 200/`done` Result, or the 502/`error` body with the changes kept. */
export type ChatOutcome =
	| { ok: true; result: ChatResult }
	| { ok: false; error: string; changes: WireChange[]; model: string };

/** A turn's answer, and whether the channel sends it at all (Go's `Result.Silent`). */
export interface ChannelReply {
	outcome: ChatOutcome;
	/**
	 * Go's `Silent`: a group chat the model answered with NO_REPLY and nothing
	 * recorded, so the channel sends nothing (agent.go:65-67, :236-241). A web turn
	 * is never silent (agent-spec §2.1.1).
	 */
	silent: boolean;
}

/**
 * chatReply maps a run to what the channel shows. `model` is the resolved model
 * id the request ran with (Go's cfg.Model, which the route reads from the
 * connection settings). Web is never a group, so it never goes silent.
 */
export function chatReply(run: RunResult, model: string): ChatOutcome {
	return channelReply(run, model, false).outcome;
}

/**
 * channelReply is chatReply with Go's group rule: `group` is the turn's
 * `Request.Group`, which only the Telegram bot sets (T4). The rules are Go's
 * `finish()` — the only place NO_REPLY is honoured — applied to the same
 * outcomes chatReply answers.
 */
export function channelReply(run: RunResult, model: string, group: boolean): ChannelReply {
	const changes = wireChanges(run.changes);
	if (run.status === "failed") {
		// The forced-answer outcome: Go's last round produced words, pi-durable's
		// bound ends the run instead. Whatever it said nothing about still counts.
		if (run.reason === "turn_limit") {
			return spoken({
				ok: true,
				result: { reply: replyText({ text: "", stop: "end", changes, toolsUsed: run.toolsUsed }), changes, model },
			});
		}
		// reason "aborted": the request closed (the Stop button, a reload).
		if (run.reason === "aborted") return spoken({ ok: false, error: STOPPED_REPLY, changes, model });
		return spoken({ ok: false, error: run.detail, changes, model });
	}
	// Go keeps a cut-off turn as an error only when it said nothing at all, and the
	// changes made before it stay (agent.go:196-204).
	if (cutOffBeforeText(run.stop, run.text)) return spoken({ ok: false, error: CUT_OFF_ERROR, changes, model });
	const answer = { text: run.text, stop: run.stop, changes, toolsUsed: run.toolsUsed };
	// Go's group silence is finish()'s rule, and finish() never runs on a refusal or
	// a cut-off (agent.go:129-130, :191-204), so neither is ever silenced.
	if (group && !stopsBeforeFinish(run.stop) && changes.length === 0 && shownText(answer).includes(SILENT_REPLY)) {
		return { outcome: { ok: true, result: { reply: "", changes, model } }, silent: true };
	}
	return spoken({ ok: true, result: { reply: replyText(answer), changes, model } });
}

/** spoken is an answer the channel sends; nothing but finish() can silence one. */
function spoken(outcome: ChatOutcome): ChannelReply {
	return { outcome, silent: false };
}

/**
 * One answer as the transcript keeps it, so a reload can apply the rules the
 * live turn applied instead of inventing a second, different transcript (Q1).
 */
export interface AnswerView {
	/** What the model said: the answer's own text, before the channel's rules. */
	text: string;
	/** How the answer stopped (complete.ts's `Stop`). */
	stop: Stop;
	/** The run's change lines, which decide Go's `Done.` rule. */
	changes: readonly WireChange[];
	/** The tools the run called, which decide Go's documents-not-found rule. */
	toolsUsed: readonly string[];
}

/** cutOffBeforeText is Go's ErrCutOff: the output limit stopped the round before any text. */
export function cutOffBeforeText(stop: Stop, text: string): boolean {
	return stop === "max_tokens" && goTrimSpace(text) === "";
}

/**
 * shownText is Go's `res.Reply` before `finish()`: the model's answer, the
 * declined text, or the cut-off text with its note (agent.go:191-204).
 */
export function shownText(answer: { text: string; stop: Stop }): string {
	if (answer.stop === "refusal") return REFUSAL_REPLY;
	if (answer.stop === "max_tokens") return goTrimSpace(answer.text) + CUT_OFF_NOTE;
	return goTrimSpace(answer.text);
}

/**
 * stopsBeforeFinish is the stop path of Go's loop: `stopped()` returns the
 * refusal reply and the cut-off text straight to the caller and `finish()` never
 * runs on them (agent.go:129-130, :191-204). The NO_REPLY rule is finish()'s,
 * so neither a refusal nor a cut-off is ever stripped or silenced.
 */
function stopsBeforeFinish(stop: Stop): boolean {
	return stop === "refusal" || stop === "max_tokens";
}

/**
 * replyText is the text a channel shows for one answer — Go's `turn.finish`
 * over `shownText`, the same function the live turn goes through, so a reloaded
 * row cannot disagree with the bubble that was shown (Q1).
 */
export function replyText(answer: AnswerView): string {
	const shown = shownText(answer);
	// Go sends these two as they are (agent.go:129-130, :191-204).
	if (stopsBeforeFinish(answer.stop)) return shown;
	return finishText(shown, answer.changes, answer.toolsUsed);
}

/**
 * finishText is Go's turn.finish: the NO_REPLY marker, then the rules for a
 * turn that said nothing. Go tests `strings.Contains`, so a reply that carries
 * the marker among other words is stripped too (agent.go:236-253).
 */
function finishText(reply: string, changes: readonly WireChange[], toolsUsed: readonly string[]): string {
	const text = reply.includes(SILENT_REPLY) ? goTrimSpace(reply.replaceAll(SILENT_REPLY, "")) : reply;
	return text === "" ? emptyReply(changes, toolsUsed) : text;
}

/** The three lines Go's finish() picks between when the model said nothing. */
function emptyReply(changes: readonly WireChange[], toolsUsed: readonly string[]): string {
	if (changes.length > 0) return DONE_REPLY;
	if (toolsUsed.some((name) => DOC_TOOLS.includes(name))) return NOT_FOUND_IN_DOCS_REPLY;
	return NO_ANSWER_REPLY;
}

/**
 * wireChanges is Go's ChangeLine on the wire: `id` when the journal has one (the
 * Undo chip), and no `id` key at all otherwise (`omitempty`).
 */
export function wireChanges(changes: readonly ChangeLine[]): WireChange[] {
	return changes.map((line) => (line.id === undefined ? { text: line.text } : { id: line.id, text: line.text }));
}

/**
 * parseThink is Go's ParseThink (agent.go:36-51): a message that starts with
 * /think, in any case and as its own word, asks for thinking and loses the
 * command. /thinking and /thin are ordinary text, and /think alone is an empty
 * message that thinks.
 */
export function parseThink(text: string): { text: string; think: boolean } {
	const trimmed = goTrimSpace(text);
	if (trimmed.length < THINK_COMMAND.length) return { text, think: false };
	if (trimmed.slice(0, THINK_COMMAND.length).toLowerCase() !== THINK_COMMAND) return { text, think: false };
	const rest = trimmed.slice(THINK_COMMAND.length);
	if (rest !== "" && rest[0] !== " " && rest[0] !== "\n" && rest[0] !== "\t") return { text, think: false };
	return { text: goTrimSpace(rest), think: true };
}
