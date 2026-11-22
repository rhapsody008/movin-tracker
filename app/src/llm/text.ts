// Chat-template control tokens that local chat servers leak into the reply
// text. Port of StripSpecialTokens (internal/llm/openai.go:268-277).
//
// Go's regex is case-sensitive and the trim happens only when the text holds a
// "<|" at all, which is what keeps every other reply byte-identical. The case
// table lives in testdata/striptokens.go.json, written by app/golden/t31/main.go.

import { goTrimSpace } from "../gostr.ts";

/** specialTokenRe: the seven tokens Go removes. */
const SPECIAL_TOKEN = /<\|(?:im_end|im_start|eot_id|end_of_text|endoftext|end|eom_id)\|>/g;

/** stripSpecialTokens removes leaked chat-template tokens and trims the rest. */
export function stripSpecialTokens(s: string): string {
	if (!s.includes("<|")) return s;
	return goTrimSpace(s.replace(SPECIAL_TOKEN, ""));
}

/**
 * textOf is the text blocks of a message's (or a committed partial's) content,
 * joined in order. pi-ai keeps thinking and tool calls in the same array, so
 * every reader has to skip them the same way.
 */
export function textOf(
	content: string | readonly { readonly type: string; readonly text?: string }[] | undefined,
): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "text" && block.text !== undefined) text += block.text;
	}
	return text;
}
