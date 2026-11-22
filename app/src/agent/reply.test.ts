// Go's reply rules (agent-spec §4.5, §2.1.1): one row per line the user can
// see, and the `/think` parser (TestParseThink). Nothing here touches the
// network or the harness: a RunResult in, Go's text out.
import { describe, expect, it } from "vitest";
import type { ChangeLine, RunResult } from "../durable/adapter.ts";
import {
	type AnswerView,
	CUT_OFF_ERROR,
	CUT_OFF_NOTE,
	channelReply,
	chatReply,
	DONE_REPLY,
	NO_ANSWER_REPLY,
	NOT_FOUND_IN_DOCS_REPLY,
	parseThink,
	REFUSAL_REPLY,
	replyText,
	STOPPED_REPLY,
	wireChanges,
} from "./reply.ts";

const MODEL = "movin-backend";

/** One change line with an id: what a journaled write produces. */
const SAVED: ChangeLine = { id: "01K", text: "Saved: task · Book movers" };

/** One change line without an id: the key dates are not journaled, so there is no Undo. */
const DATES: ChangeLine = { text: "Move-in set to Sat, 5 Dec" };

/** answered is a run that said something and ended normally. */
function answered(text: string, over: Partial<Extract<RunResult, { status: "answered" }>> = {}): RunResult {
	return {
		status: "answered",
		text,
		stop: "end",
		usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
		changes: [],
		toolsUsed: [],
		...over,
	};
}

/** failed is a run that ended without an answer. */
function failed(reason: string, detail: string, changes: ChangeLine[] = [], toolsUsed: string[] = []): RunResult {
	return {
		status: "failed",
		reason,
		detail,
		usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
		changes,
		toolsUsed,
	};
}

describe("the reply rules (agent-spec §4.5)", () => {
	const rows: { name: string; run: RunResult; reply: string; changes?: ChangeLine[] }[] = [
		{ name: "the model's own words", run: answered(" Looks good. "), reply: "Looks good." },
		{
			name: "the model declined: not an error, and earlier changes stay",
			run: answered("", { stop: "refusal", changes: [SAVED] }),
			reply: REFUSAL_REPLY,
			changes: [SAVED],
		},
		{
			name: "nothing said but a change made",
			run: answered("", { changes: [SAVED] }),
			reply: DONE_REPLY,
			changes: [SAVED],
		},
		{
			name: "nothing said after a document search",
			run: answered("", { toolsUsed: ["search_documents"] }),
			reply: NOT_FOUND_IN_DOCS_REPLY,
		},
		{
			name: "nothing said after reading a page",
			run: answered("", { toolsUsed: ["read_document_page"] }),
			reply: NOT_FOUND_IN_DOCS_REPLY,
		},
		{ name: "nothing said at all", run: answered(""), reply: NO_ANSWER_REPLY },
		{
			name: "cut off with text: the note is added",
			run: answered("We would look at", { stop: "max_tokens" }),
			reply: `We would look at${CUT_OFF_NOTE}`,
		},
		{
			name: "NO_REPLY is stripped: web never honours it",
			run: answered("NO_REPLY"),
			reply: NO_ANSWER_REPLY,
		},
		{
			name: "NO_REPLY with text answers the rest",
			run: answered("NO_REPLY Done looking."),
			reply: "Done looking.",
		},
		{
			name: "turn_limit with a change made is Go's forced-answer outcome",
			run: failed("turn_limit", "", [DATES]),
			reply: DONE_REPLY,
			changes: [DATES],
		},
		{
			name: "turn_limit with nothing said",
			run: failed("turn_limit", ""),
			reply: NO_ANSWER_REPLY,
		},
		{
			name: "turn_limit after a document search",
			run: failed("turn_limit", "", [], ["search_documents"]),
			reply: NOT_FOUND_IN_DOCS_REPLY,
		},
	];

	for (const row of rows) {
		it(row.name, () => {
			const outcome = chatReply(row.run, MODEL);
			expect(outcome.ok).toBe(true);
			if (!outcome.ok) return;
			expect(outcome.result.reply).toBe(row.reply);
			expect(outcome.result.model).toBe(MODEL);
			expect(outcome.result.changes).toEqual(wireChanges(row.changes ?? []));
		});
	}

	it("answers a cut-off before any text as the error, with the changes kept", () => {
		const outcome = chatReply(answered("  ", { stop: "max_tokens", changes: [SAVED] }), MODEL);
		expect(outcome).toEqual({ ok: false, error: CUT_OFF_ERROR, changes: wireChanges([SAVED]), model: MODEL });
	});

	it("passes a failed run's detail through, with the changes it made", () => {
		const outcome = chatReply(failed("model_error", "endpoint returned 500: boom", [SAVED]), MODEL);
		expect(outcome).toEqual({
			ok: false,
			error: "endpoint returned 500: boom",
			changes: wireChanges([SAVED]),
			model: MODEL,
		});
	});

	it("says Stopped. for a turn the request's close ended", () => {
		expect(chatReply(failed("aborted", ""), MODEL)).toEqual({
			ok: false,
			error: STOPPED_REPLY,
			changes: [],
			model: MODEL,
		});
	});
});

describe("the group silence (TestGroupSilence)", () => {
	it("sends nothing for NO_REPLY in a group with nothing recorded", () => {
		const reply = channelReply(answered("NO_REPLY"), MODEL, true);
		expect(reply.silent).toBe(true);
		expect(reply.outcome).toEqual({ ok: true, result: { reply: "", changes: [], model: MODEL } });
	});

	it("still answers in a group once something was recorded", () => {
		const reply = channelReply(answered("NO_REPLY", { changes: [SAVED] }), MODEL, true);
		expect(reply.silent).toBe(false);
		if (!reply.outcome.ok) throw new Error("not answered");
		expect(reply.outcome.result.reply).toBe(DONE_REPLY);
	});

	it("is silent for a marker among other words, as Go's Contains rule reads it", () => {
		const reply = channelReply(answered("NO_REPLY Done looking."), MODEL, true);
		expect(reply.silent).toBe(true);
		if (!reply.outcome.ok) throw new Error("not answered");
		expect(reply.outcome.result.reply).toBe("");
	});

	it("never silences a web turn", () => {
		const reply = channelReply(answered("NO_REPLY"), MODEL, false);
		expect(reply.silent).toBe(false);
		if (!reply.outcome.ok) throw new Error("not answered");
		expect(reply.outcome.result.reply).toBe(NO_ANSWER_REPLY);
	});

	it("sends a cut-off that carries the marker as it was written, in a group and on the web", () => {
		// Go returns a cut-off straight from stopped(), so finish() runs neither the
		// marker rule nor the silence rule on it (agent.go:129-130, :191-204, R3).
		for (const group of [true, false]) {
			const reply = channelReply(answered("NO_REPLY then more", { stop: "max_tokens" }), MODEL, group);
			expect(reply.silent).toBe(false);
			if (!reply.outcome.ok) throw new Error("not answered");
			expect(reply.outcome.result.reply).toBe(`NO_REPLY then more${CUT_OFF_NOTE}`);
		}
	});

	it("never silences a refusal or a cut-off in a group", () => {
		const refusal = channelReply(answered("", { stop: "refusal" }), MODEL, true);
		expect(refusal.silent).toBe(false);
		if (!refusal.outcome.ok) throw new Error("not answered");
		expect(refusal.outcome.result.reply).toBe(REFUSAL_REPLY);
		const cut = channelReply(answered("We would", { stop: "max_tokens" }), MODEL, true);
		expect(cut.silent).toBe(false);
	});
});

describe("a reloaded answer's text (Q1, R3)", () => {
	const view = (over: Partial<AnswerView> = {}): AnswerView => ({
		text: "",
		stop: "end",
		changes: [],
		toolsUsed: [],
		...over,
	});

	it("returns a refusal and a cut-off as they were sent, without finish", () => {
		// Go's stopped() hands these two back before finish() runs, so the marker is
		// neither stripped nor honoured (agent.go:129-130, :191-204).
		expect(replyText(view({ text: "I can't help with that.", stop: "refusal" }))).toBe(REFUSAL_REPLY);
		expect(replyText(view({ text: "NO_REPLY then more", stop: "max_tokens" }))).toBe(
			`NO_REPLY then more${CUT_OFF_NOTE}`,
		);
	});

	it("applies Go's finish rules to every other answer", () => {
		expect(replyText(view({ changes: wireChanges([SAVED]) }))).toBe(DONE_REPLY);
		expect(replyText(view({ toolsUsed: ["search_documents"] }))).toBe(NOT_FOUND_IN_DOCS_REPLY);
		expect(replyText(view())).toBe(NO_ANSWER_REPLY);
		expect(replyText(view({ text: "NO_REPLY Done looking." }))).toBe("Done looking.");
	});
});

describe("the change lines on the wire", () => {
	it("carry Go's fields only: an id when there is one, and never the entry id", () => {
		expect(wireChanges([SAVED, DATES])).toEqual([
			{ id: "01K", text: "Saved: task · Book movers" },
			{ text: "Move-in set to Sat, 5 Dec" },
		]);
	});
});

describe("parseThink (TestParseThink)", () => {
	// The Go table, case for case (agent_test.go:422-444).
	const cases: { in: string; rest: string; think: boolean }[] = [
		{ in: "/think compare the quotes", rest: "compare the quotes", think: true },
		{ in: "  /THINK\nwhich one?", rest: "which one?", think: true },
		{ in: "/think", rest: "", think: true },
		{ in: "/thinking about tiles", rest: "/thinking about tiles", think: false },
		{ in: "I think so", rest: "I think so", think: false },
		{ in: "/thin", rest: "/thin", think: false },
	];
	for (const c of cases) {
		it(`parses ${JSON.stringify(c.in)}`, () => {
			expect(parseThink(c.in)).toEqual({ text: c.rest, think: c.think });
		});
	}

	it("leaves the text untouched when no command is there", () => {
		// Go returns the input as given, not trimmed, when it is not a command.
		expect(parseThink("  hello  ")).toEqual({ text: "  hello  ", think: false });
	});
});
