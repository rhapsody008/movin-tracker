// The LLM-backed document summariser: Go's docs.LLMSummariser
// (internal/docs/summary.go:20-47) on top of src/llm. One plain line per
// document, from the same saved connection the chat uses.
//
// Three things Go's Summarise does, kept here: the connection is resolved on
// every call (so a settings change applies without a restart), no connection is
// an error the syncer logs and turns into an empty summary, and the answer is
// tidied before it goes into the index. It sends no tools and asks for no
// thinking, as Go did (summary.go:33-43).
//
// Known difference: pi-ai's chat call always streams on the wire, so the request
// carries stream:true where Go's carried no stream field at all (decisions.md · T3.1).

import { complete } from "../llm/complete.ts";
import type { SettingsService } from "../settings/settings.ts";
import { type Doc, docFolder, docName } from "./index.ts";
import { SUMMARY_PROMPT, type Summariser, tidySummary } from "./summary.ts";

/** Go's text when neither settings.json nor the environment names a connection (summary.go:27-29). */
export const NO_CONNECTION = "no LLM connection configured";

export interface LLMSummariserOptions {
	/** Resolved per call, so a new connection applies without a restart. */
	settings: Pick<SettingsService, "resolve">;
}

/**
 * createLLMSummariser is the Summariser createSyncer is given: the system
 * prompt, one user message naming the file, and the answer tidied into a line.
 * A failure throws, which the syncer logs and stores as an empty summary.
 */
export function createLLMSummariser(o: LLMSummariserOptions): Summariser {
	return {
		summarise: async (d: Doc, text: string, signal?: AbortSignal): Promise<string> => {
			const cfg = await o.settings.resolve();
			if (cfg.baseUrl === "" || cfg.model === "") throw new Error(NO_CONNECTION);
			const folder = docFolder(d);
			const name = folder === "" ? docName(d) : `${folder}/${docName(d)}`;
			const res = await complete(cfg, {
				system: SUMMARY_PROMPT,
				messages: [{ role: "user", content: `File: ${name}\n\nStart of the text:\n${text}`, timestamp: Date.now() }],
				think: false,
				signal,
			});
			return tidySummary(res.text);
		},
	};
}
