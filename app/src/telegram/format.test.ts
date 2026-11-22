// Telegram's reply formatting (src/telegram/format.ts): Go's split, truncate,
// changeText and undoKeyboard under their Go test names (bot_internal_test.go),
// the answer and failure messages Go's bot.go assembles, and every one of them
// against the bytes Go itself sent — the Go v1 code, tag v1.0.1, golden t43 wrote
// src/telegram/testdata/format.go.json with Go's own functions and the real
// Go client, so the golden pins the text, the split, the thread and the
// keyboard placement together.
//
// Nothing here talks to Telegram: a reply in, the messages out, as values.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ChannelReply,
	CUT_OFF_ERROR,
	CUT_OFF_NOTE,
	channelReply,
	DONE_REPLY,
	NO_ANSWER_REPLY,
	REFUSAL_REPLY,
	STOPPED_REPLY,
	type WireChange,
} from "../agent/reply.ts";
import type { ChangeLine, RunResult } from "../durable/adapter.ts";
import { goMarshal } from "../gojson.ts";
import {
	changeText,
	FAILURE_PREFIX,
	MAX_MESSAGE,
	NON_TEXT_REPLY,
	type ReplyAddress,
	type ReplyOptions,
	replyMessages,
	split,
	THINK_HINT,
	TIMED_OUT_DETAIL,
	textMessages,
	truncate,
	undoKeyboard,
} from "./format.ts";

/** Go's answers for T4.3a, by the Go v1 code (tag v1.0.1, golden t43). */
interface Golden {
	max_message: number;
	split: { text: string; n: number; parts: string[] }[];
	truncate: { text: string; n: number; out: string }[];
	change_text: { changes: WireChange[]; out: string }[];
	undo_keyboard: { changes: WireChange[]; keyboard: string }[];
	/** T4.1's requests.go.json shape: a name per case, the raw bodies it sent. */
	messages: Record<string, string[]>;
}

const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "format.go.json"), "utf8")) as Golden;

/** An item a test has already counted, without noUncheckedIndexedAccess in the way. */
function at<T>(list: readonly T[], i: number): T {
	const value = list[i];
	if (value === undefined) throw new Error(`no element ${i} of ${list.length}`);
	return value;
}

const MODEL = "movin-backend";

/** A journaled write: a real v3 change id, so `undo:` plus it is 31 bytes. */
const SAVED: ChangeLine = { id: "01K8ZQ4R7S9T2V5W8X1Y3Z5A6B", text: "Saved: note · Fluted glass door" };

/** The key dates are not journaled, so there is no button for them. */
const DATES: ChangeLine = { text: "Move-in set to Sat, 5 Dec" };

/** A private chat and the group the golden threads under message 7 of -1001. */
const PRIVATE: ReplyAddress = { chat: 111, messageId: 7, group: false };
const GROUP: ReplyAddress = { chat: -1001, messageId: 7, group: true };

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
function failed(detail: string, changes: ChangeLine[] = [], reason = "model_error"): RunResult {
	return {
		status: "failed",
		reason,
		detail,
		usage: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
		changes,
		toolsUsed: [],
	};
}

// ---------- Go's own tests, ported ----------

describe("TestSplit", () => {
	it("leaves a short text alone and makes an empty text one empty part", () => {
		expect(split("short", 10)).toEqual(["short"]);
		expect(split("", 10)).toEqual([""]);
	});

	it("prefers a line break in the second half of the window", () => {
		expect(split("aaaaaaa\nbbbbbbbbb\ncc", 10)).toEqual(["aaaaaaa", "bbbbbbbbb", "cc"]);
	});

	it("hard-cuts by runes, not bytes, when there is no break", () => {
		const parts = split("é".repeat(25), 10);
		expect(parts).toHaveLength(3);
		expect([...at(parts, 0)]).toHaveLength(10);
		expect([...at(parts, 2)]).toHaveLength(5);
	});
});

describe("TestUndoKeyboard", () => {
	it("has no keyboard without a journaled change", () => {
		expect(undoKeyboard([])).toBeNull();
		// `undoKeyboard(nil)` in Go, and the key dates: no id, no button.
		expect(undoKeyboard([{ text: "Move-in set" }])).toBeNull();
	});

	it("labels a single change's button Undo with undo:<id> as its data", () => {
		const keyboard = undoKeyboard([{ id: "a", text: "x" }]);
		expect(keyboard).toEqual({ inline_keyboard: [[{ text: "Undo", callback_data: "undo:a" }]] });
	});

	it("keeps eight buttons in two rows of four, the eighth labelled Undo 8", () => {
		const many = Array.from({ length: 10 }, (_, i) => ({ id: String.fromCharCode("a".charCodeAt(0) + i), text: "x" }));
		const keyboard = undoKeyboard(many);
		const rows = keyboard?.inline_keyboard ?? [];
		expect(rows).toHaveLength(2);
		expect(rows.map((row) => row.length)).toEqual([4, 4]);
		expect(rows[1]?.[3]?.text).toBe("Undo 8");
	});
});

// ---------- Go's golden ----------

describe("Go's golden", () => {
	it("is Go's 4000-rune limit, not the plan's 4096", () => {
		expect(MAX_MESSAGE).toBe(4000);
		expect(MAX_MESSAGE).toBe(GOLDEN.max_message);
	});

	it("splits every golden text exactly as Go's split does", () => {
		for (const c of GOLDEN.split) {
			expect(split(c.text, c.n), `${c.n} runes of ${JSON.stringify(c.text.slice(0, 30))}`).toEqual(c.parts);
		}
	});

	it("truncates every golden text exactly as Go's truncate does", () => {
		for (const c of GOLDEN.truncate) {
			expect(truncate(c.text, c.n), `${c.n} runes of ${JSON.stringify(c.text.slice(0, 30))}`).toBe(c.out);
		}
	});

	it("joins every golden change set exactly as Go's changeText does", () => {
		for (const c of GOLDEN.change_text) {
			expect(changeText(c.changes), JSON.stringify(c.changes)).toBe(c.out);
		}
	});

	it("builds every golden keyboard exactly as Go's undoKeyboard does", () => {
		for (const c of GOLDEN.undo_keyboard) {
			expect(goMarshal(undoKeyboard(c.changes)), JSON.stringify(c.changes)).toBe(c.keyboard);
		}
	});

	it("sends Go's exact bytes for every golden answer and failure line", () => {
		// Each case is the turn Go's generator assembled, through the same reply
		// rules the bot uses: channelReply for the text, replyMessages for the
		// messages. Go's own text and the port's must agree byte for byte, which
		// is why these are goMarshal of the SendMessage values Go marshalled.
		const cases: Record<string, { run: RunResult; address: ReplyAddress; options?: ReplyOptions }> = {
			group_reply_with_changes: { run: answered("Looks good.", { changes: [SAVED] }), address: GROUP },
			group_two_parts_with_changes: {
				run: answered(`${"a".repeat(3000)}\n${"b".repeat(2000)}`, { changes: [SAVED, DATES] }),
				address: GROUP,
			},
			private_reply_with_changes: { run: answered("Looks good.", { changes: [SAVED] }), address: PRIVATE },
			reply_without_changes: { run: answered(""), address: PRIVATE },
			failure_with_changes: { run: failed("context deadline exceeded", [SAVED, DATES]), address: GROUP },
			failure_with_long_detail: { run: failed("l".repeat(301)), address: PRIVATE },
			silent: { run: answered("NO_REPLY"), address: GROUP },
		};
		expect(Object.keys(cases).sort()).toEqual(Object.keys(GOLDEN.messages).sort());
		for (const [name, c] of Object.entries(cases)) {
			const reply = channelReply(c.run, MODEL, c.address.group);
			const messages = replyMessages(reply, c.address, c.options);
			expect(messages === null ? [] : messages.map(goMarshal), name).toEqual(GOLDEN.messages[name]);
		}
	});
});

// ---------- the messages one turn sends ----------

describe("replyMessages", () => {
	it("sends an answered turn's reply as one message with no keyboard", () => {
		const messages = replyMessages(channelReply(answered(" Looks good. "), MODEL, false), PRIVATE);
		expect(messages).toEqual([{ chat_id: 111, text: "Looks good." }]);
	});

	it("appends Go's change block to the answer, starting on a blank line", () => {
		const messages = replyMessages(
			channelReply(answered("Looks good.", { changes: [SAVED, DATES] }), MODEL, false),
			PRIVATE,
		);
		expect(messages).toEqual([
			{
				chat_id: 111,
				text: "Looks good.\n\n• Saved: note · Fluted glass door\n• Move-in set to Sat, 5 Dec",
				reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: `undo:${SAVED.id ?? ""}` }]] },
			},
		]);
	});

	it("says Done. when the model said nothing and saved something", () => {
		const messages = replyMessages(channelReply(answered("", { changes: [DATES] }), MODEL, false), PRIVATE);
		expect(messages).toEqual([{ chat_id: 111, text: `${DONE_REPLY}\n\n• Move-in set to Sat, 5 Dec` }]);
	});

	it("sends a refusal as Go's declined line, with no keyboard", () => {
		const messages = replyMessages(channelReply(answered("", { stop: "refusal" }), MODEL, false), PRIVATE);
		expect(messages).toEqual([{ chat_id: 111, text: REFUSAL_REPLY }]);
	});

	it("sends a cut-off answer with Go's note", () => {
		const messages = replyMessages(
			channelReply(answered("Half an answer", { stop: "max_tokens" }), MODEL, false),
			PRIVATE,
		);
		expect(messages).toEqual([{ chat_id: 111, text: `Half an answer${CUT_OFF_NOTE}` }]);
	});

	it("sends Go's failure line for a turn cut off before it said anything", () => {
		// Go keeps a cut-off turn as an error when it said nothing at all, and the
		// changes it made before it stay (agent.go:196-204).
		const reply = channelReply(answered("", { stop: "max_tokens", changes: [SAVED] }), MODEL, false);
		expect(replyMessages(reply, PRIVATE)).toEqual([
			{
				chat_id: 111,
				text: `${FAILURE_PREFIX}${CUT_OFF_ERROR}\n\nSome changes were saved before it failed:\n• Saved: note · Fluted glass door`,
				reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: `undo:${SAVED.id ?? ""}` }]] },
			},
		]);
	});

	it("keeps the change block and its buttons on a failed turn", () => {
		const messages = replyMessages(channelReply(failed("model went away", [SAVED]), MODEL, false), PRIVATE);
		expect(messages).toEqual([
			{
				chat_id: 111,
				text: `${FAILURE_PREFIX}model went away\n\nSome changes were saved before it failed:\n• Saved: note · Fluted glass door`,
				reply_markup: { inline_keyboard: [[{ text: "Undo", callback_data: `undo:${SAVED.id ?? ""}` }]] },
			},
		]);
	});

	it("sends Stopped. as the detail of an abort that was not the watchdog", () => {
		// Go's detail is err.Error(); a person pressing Stop is v3's `aborted`.
		const messages = replyMessages(channelReply(failed("", [], "aborted"), MODEL, false), PRIVATE);
		expect(messages).toEqual([{ chat_id: 111, text: `${FAILURE_PREFIX}${STOPPED_REPLY}` }]);
	});

	it("says the watchdog stopped a timed-out turn, not Go's deadline text", () => {
		// The recorded difference: Go's own wording for the same event is
		// `context deadline exceeded`, which is what a run without the option keeps.
		const reply = channelReply(failed("context deadline exceeded"), MODEL, false);
		expect(replyMessages(reply, PRIVATE)).toEqual([
			{ chat_id: 111, text: `${FAILURE_PREFIX}context deadline exceeded` },
		]);
		expect(replyMessages(reply, PRIVATE, { timedOut: true })).toEqual([
			{ chat_id: 111, text: `${FAILURE_PREFIX}${TIMED_OUT_DETAIL}` },
		]);
		expect(TIMED_OUT_DETAIL).toBe("the turn took longer than 15 minutes and was stopped");
	});

	it("sends nothing at all when the group turn was silent", () => {
		const reply = channelReply(answered("NO_REPLY"), MODEL, true);
		expect(reply.silent).toBe(true);
		expect(replyMessages(reply, GROUP)).toBeNull();
		// Not even a failure line, and the same for a silent turn with no outcome to tell.
		expect(
			replyMessages({ outcome: { ok: true, result: { reply: "", changes: [], model: MODEL } }, silent: true }, GROUP),
		).toBeNull();
	});

	it("threads the answer under the message in a group and not in a private chat", () => {
		const reply = channelReply(answered("Looks good."), MODEL, true);
		expect(replyMessages(reply, GROUP)).toEqual([{ chat_id: -1001, text: "Looks good.", reply_to_message_id: 7 }]);
		expect(replyMessages(reply, PRIVATE)).toEqual([{ chat_id: 111, text: "Looks good." }]);
	});

	it("puts the Undo keyboard on the last part and threads only the first", () => {
		const long = `${"a".repeat(3000)}\n${"b".repeat(2000)}`;
		const reply = channelReply(answered(long, { changes: [SAVED, DATES] }), MODEL, true);
		const messages = replyMessages(reply, GROUP) ?? [];
		expect(messages).toHaveLength(2);
		const [first, last] = messages;
		// The break at 3000 is the one Go's split takes, and the thread is only on
		// the first part; the keyboard only on the last (spec §11 trap 10).
		expect(first).toEqual({ chat_id: -1001, text: "a".repeat(3000), reply_to_message_id: 7 });
		expect(last?.reply_to_message_id).toBeUndefined();
		expect(last?.reply_markup).toEqual({
			inline_keyboard: [[{ text: "Undo", callback_data: `undo:${SAVED.id ?? ""}` }]],
		});
		expect(last?.text.startsWith("b".repeat(2000))).toBe(true);
	});

	it("has no keyboard when the only changes were the key dates", () => {
		const reply = channelReply(answered("Saved.", { changes: [DATES] }), MODEL, false);
		const messages = replyMessages(reply, PRIVATE) ?? [];
		expect(messages).toHaveLength(1);
		expect(at(messages, 0).reply_markup).toBeUndefined();
	});

	it("trims blank lines at the start of a reply before sending it", () => {
		// The v3-only trim: Go sends res.Reply as it is, and T0.3 saw a /think
		// answer begin with two blank lines.
		const handBuilt: ChannelReply = {
			outcome: { ok: true, result: { reply: "\n\n  Two blank lines first", changes: [], model: MODEL } },
			silent: false,
		};
		expect(replyMessages(handBuilt, PRIVATE)).toEqual([{ chat_id: 111, text: "  Two blank lines first" }]);
		// A blank line holding spaces goes too; a line with text keeps its own.
		const spaced: ChannelReply = {
			outcome: { ok: true, result: { reply: " \n\t\nNot indented", changes: [], model: MODEL } },
			silent: false,
		};
		expect(replyMessages(spaced, PRIVATE)).toEqual([{ chat_id: 111, text: "Not indented" }]);
	});

	it("never has to trim a channelReply answer, because shownText trims first", () => {
		// Pinned either way: the trim is unreachable from the reply rules, so it
		// can only ever fire on a hand-built reply like the one above.
		const runs: RunResult[] = [
			answered("\n\n  Leading blank lines\n\n"),
			answered("NO_REPLY"),
			answered("", { changes: [DATES] }),
			answered("", { stop: "refusal" }),
			answered("  ", { stop: "max_tokens" }),
			failed("model went away"),
		];
		for (const run of runs) {
			for (const group of [false, true]) {
				const messages = replyMessages(channelReply(run, MODEL, group), group ? GROUP : PRIVATE);
				for (const message of messages ?? []) {
					expect(message.text.startsWith("\n"), JSON.stringify(message.text.slice(0, 20))).toBe(false);
				}
			}
		}
	});

	it("carries Go's fixed lines, byte for byte", () => {
		expect(NON_TEXT_REPLY).toBe("I can only read text for now. Drawings, photos and voice notes are coming.");
		expect(THINK_HINT).toBe("Put your question after /think, e.g. /think which countertop fits our budget better?");
		expect(FAILURE_PREFIX).toBe("Sorry, that didn't go through: ");
		expect(NO_ANSWER_REPLY).toBe("No answer came back. Try rephrasing.");
	});
});

describe("textMessages", () => {
	it("threads the first part in a group and puts the keyboard on the last", () => {
		const long = `${"a".repeat(3000)}\n${"b".repeat(2000)}`;
		const keyboard = { inline_keyboard: [[{ text: "Undo", callback_data: "undo:x" }]] };
		const messages = textMessages(long, GROUP, keyboard);

		expect(messages).toHaveLength(2);
		expect(at(messages, 0)).toEqual({ chat_id: -1001, text: "a".repeat(3000), reply_to_message_id: 7 });
		expect(at(messages, 1).reply_markup).toEqual(keyboard);
		expect(at(messages, 1).reply_to_message_id).toBeUndefined();
		// A private chat is never threaded, and a message with no keyboard says nothing
		// about one: Go omits the field (spec §11 trap 15 is the edit, not the send).
		expect(textMessages("short", PRIVATE)).toEqual([{ chat_id: 111, text: "short" }]);
	});
});

describe("undoKeyboard's callback data", () => {
	it("accepts Telegram's 64 bytes and refuses one more", () => {
		// `undo:` is 5 bytes, so a 59-byte id is exactly the limit.
		expect(undoKeyboard([{ id: "x".repeat(59), text: "x" }])).toEqual({
			inline_keyboard: [[{ text: "Undo", callback_data: `undo:${"x".repeat(59)}` }]],
		});
		expect(() => undoKeyboard([{ id: "x".repeat(60), text: "x" }])).toThrow(/over Telegram's 64/);
	});

	it("counts bytes, not characters", () => {
		// 32 three-byte characters are 96 bytes of callback_data.
		expect(() => undoKeyboard([{ id: "装".repeat(32), text: "x" }])).toThrow(/is 101 bytes/);
	});
});

describe("split and truncate on their own", () => {
	it("keeps an empty leading newline run out of the next part", () => {
		// The newline at a break is consumed on both sides, so the parts do not
		// rejoin to the input (spec §11 trap 4).
		expect(split(`${"x".repeat(30)}\n\n${"y".repeat(30)}`, 30)).toEqual(["x".repeat(30), "y".repeat(30)]);
	});

	it("never cuts inside a code point, even at the limit", () => {
		const parts = split("😀".repeat(MAX_MESSAGE + 1), MAX_MESSAGE);
		expect(parts.map((part) => [...part].length)).toEqual([MAX_MESSAGE, 1]);
		// Go's behaviour, kept: 4000 code points of emoji are 8000 UTF-16 units,
		// which Telegram would refuse (spec §11 trap 3).
		expect(at(parts, 0).length).toBe(MAX_MESSAGE * 2);
	});

	it("keeps n-1 runes and the ellipsis", () => {
		expect(truncate("abcd", 3)).toBe("ab…");
		expect(truncate("abc", 3)).toBe("abc");
		expect(truncate("😀😀😀😀", 2)).toBe("😀…");
	});
});
