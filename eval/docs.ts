// Go's document cases: cmd/chateval/docs.go:11-56. Each must answer from the
// bucket's documents, change no entries, and use the document tools — which is
// checked from the log written during the case (Go's package-level `lastLog`,
// which is the `toolLog` argument here).
//
// Run only with -docs, which builds the read-only syncer, library and viewer on
// the bucket.

import type { Check, EvalCase } from "./case.ts";
import { unchanged } from "./case.ts";

/**
 * answer is Go's answer(): no entry change, a reply matching the pattern, and
 * the named tools in the log.
 */
function answer(re: string, ...tools: string[]): Check {
	const rx = new RegExp(re, "is");
	return (before, after, res, toolLog) => {
		const bad = unchanged(before, after);
		if (bad !== null) return bad;
		if (!rx.test(res.reply)) return `reply doesn't match /${re}/`;
		for (const tool of tools) {
			if (!toolLog.includes(`"tool":"${tool}"`)) return `didn't call ${tool}`;
		}
		return null;
	};
}

/** docCases are Go's five document questions (docs.go:39-55). */
export function docCases(): EvalCase[] {
	return [
		// A fact from a manual's text.
		{
			msg: "How do I defrost the SMEG fridge freezer?",
			check: answer("automatic|no.?frost|frost.?free", "search_documents"),
		},
		// The layout drawing's room names (text layer or a view).
		{
			msg: "Which rooms are on our unit layout plan?",
			check: answer("master bedroom.*balcony|balcony.*master bedroom"),
		},
		// A location on a drawing: needs the image.
		{
			msg: "Where is the DB (distribution board) in our unit, according to the power points plan?",
			check: answer("kitchen|entrance|main door|front door", "view_document_page"),
		},
		// A legend term.
		{ msg: "On the power points plan, what does WP next to a socket mean?", check: answer("weather") },
		// Not on the sheet: it must say so, not invent a number.
		{
			msg: "How wide is the master bedroom, in metres, according to the layout plan?",
			check: (before, after, res) => {
				const bad = unchanged(before, after);
				if (bad !== null) return bad;
				if (
					/\d+(\.\d+)?\s*(m\b|metre|meter)/.test(res.reply) &&
					!/(not|no dimension|doesn't|does not|isn't|scale)/i.test(res.reply)
				) {
					return "gave a width the plan doesn't state";
				}
				if (
					!/(no|not|doesn't|does not|isn't).{0,40}(dimension|measure|width|shown|stated|marked|given)|measure on site|scale/i.test(
						res.reply,
					)
				) {
					return "didn't say the plan has no dimensions";
				}
				return null;
			},
		},
	];
}
