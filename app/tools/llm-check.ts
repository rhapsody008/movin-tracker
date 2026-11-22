// The billed live check for the LLM layer (brief T3.1, run by the main session,
// not by the agent that wrote it). It uses the connection the app itself would
// use — loadConfig(process.env) then the settings service's resolve() — and
// never saves anything, never prints the key, and never prints the config.
//
//   env LLM_BASE_URL=… LLM_MODEL=… LLM_API_KEY=…  node tools/llm-check.ts
//
// Five calls against the real gateway: a short text turn with thinking off, the
// same with thinking on, a tool-call turn with the probe's set_dates tool, an
// image turn with the probe's 1x1 pixel, and one summariser call on a fixed
// text. Each prints what came back and how long it took.

import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.ts";
import { emptyDoc } from "../src/docs/index.ts";
import { createLLMSummariser } from "../src/docs/llmsummary.ts";
import { complete, thinkingFor } from "../src/llm/complete.ts";
import { llmError } from "../src/llm/errors.ts";
import { imageContent } from "../src/llm/images.ts";
import { PROBE_PNG_BASE64 } from "../src/llm/probe.ts";
import { llmModels, modelEntry } from "../src/llm/provider.ts";
import { textOf } from "../src/llm/text.ts";
import { usageOf } from "../src/llm/usage.ts";
import { createLog, errorMessage } from "../src/log.ts";
import { createS3Store } from "../src/objstore/s3.ts";
import { createSettingsService, type LLM } from "../src/settings/settings.ts";

/** Go's chat-eval banner and this check's line width. */
const SNIPPET = 80;

/** The probe's set_dates tool (src/llm/probe.ts:probeTool), in pi-ai's tool shape. */
const SET_DATES = {
	name: "set_dates",
	description: "Set the move-in date (YYYY-MM-DD).",
	parameters: { type: "object", properties: { move_in: { type: "string" } }, required: ["move_in"] },
};

/** What one check reports. `timed` fills the name and the latency, never the check. */
interface Cell {
	stop: string;
	text: string;
	usage: string;
	toolCalls?: number;
}

interface Row extends Cell {
	name: string;
	latencyMs: number;
}

function usageLine(u: { in: number; out: number; cacheRead: number; cacheWrite: number }): string {
	return `in ${u.in} out ${u.out} cache read ${u.cacheRead} cache write ${u.cacheWrite}`;
}

function print(row: Row): void {
	const first = [...row.text].slice(0, SNIPPET).join("").replace(/\n/g, " ");
	const tools = row.toolCalls === undefined ? "" : ` tools ${row.toolCalls}`;
	console.log(
		`${row.name}: ${row.latencyMs} ms, stop ${row.stop}${tools}, usage ${row.usage}\n  reply: ${first}`,
	);
}

async function timed<T>(name: string, fn: () => Promise<T>, describe: (v: T) => Cell): Promise<Row | null> {
	const start = Date.now();
	try {
		const value = await fn();
		const row: Row = { name, latencyMs: Date.now() - start, ...describe(value) };
		print(row);
		return row;
	} catch (err) {
		console.log(`${name}: ${Date.now() - start} ms, FAILED: ${errorMessage(err)}`);
		return null;
	}
}

async function main(): Promise<number> {
	const config = loadConfig(process.env);
	const log = createLog({ level: "warn" });
	const store = createS3Store({
		bucket: config.s3Bucket,
		prefix: config.s3Prefix,
		region: config.awsRegion,
		endpointUrl: config.s3EndpointUrl,
	});
	const settings = createSettingsService({
		store,
		log,
		env: config.llm,
		telegramEnv: config.telegram,
		checkinEnv: config.checkin,
		secret: config.settingsSecret,
		now: () => new Date(),
	});
	const cfg: LLM = await settings.resolve();
	if (cfg.baseUrl === "" || cfg.model === "") {
		console.log("no LLM connection configured: set it in Settings or in LLM_BASE_URL/LLM_MODEL");
		return 1;
	}
	// The model and whether a key is set; never the key, never the whole connection.
	console.log(`model ${cfg.model} · key ${cfg.apiKey === "" ? "none" : "set"} · vision ${cfg.vision}`);

	const rows: Row[] = [];
	// The level is printed with the name: with thinkOnDemand off, "thinking off"
	// still means pi-ai sends enable_thinking true (decisions.md · T3.1).
	const text = (name: string, think: boolean): Promise<Row | null> =>
		timed(
			`${name} (level ${thinkingFor(cfg, think)})`,
			() =>
				complete(cfg, { system: "Answer in one short sentence.", messages: [user("Say hello in three words.")], think }),
			(res) => ({ stop: res.stop, text: res.text, usage: usageLine(res.usage) }),
		);

	const first = await text("text, thinking off", false);
	if (first !== null) rows.push(first);
	const second = await text("text, thinking on", true);
	if (second !== null) rows.push(second);

	const { models } = llmModels(cfg);
	// The level is complete.ts's: pi-ai's SimpleStreamOptions has no "off", so the
	// option is left out and streamSimple sends no reasoning effort at all.
	const level = thinkingFor(cfg, false);
	const toolTurn = await timed(
		"tool call",
		async () => {
			const message = await models.completeSimple(
				modelEntry(cfg),
				{
					messages: [user("We move in on 2026-12-05. Always use the tool.")],
					tools: [SET_DATES],
				},
				{
					...(level === "off" ? {} : { reasoning: level }),
					timeoutMs: cfg.timeoutSec * 1000,
				},
			);
			// pi-ai answers a failure as a message with stopReason "error": count it
			// as a failed check, not an answer.
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw llmError(message, cfg.apiKey);
			}
			const calls = message.content.filter((block) => block.type === "toolCall");
			return { message, calls: calls.length, reply: textOf(message.content) };
		},
		(res) => ({
			stop: res.message.stopReason,
			text: res.reply,
			usage: usageLine(usageOf(res.message)),
			toolCalls: res.calls,
		}),
	);
	if (toolTurn !== null) rows.push(toolTurn);

	const png = imageContent({ mediaType: "image/png", data: Buffer.from(PROBE_PNG_BASE64, "base64") });
	const imageTurn = await timed(
		"image",
		() =>
			complete(cfg, {
				messages: [user([{ type: "text", text: "Reply with one word: what colour is this square?" }, png])],
			}),
		(res) => ({ stop: res.stop, text: res.text, usage: usageLine(res.usage) }),
	);
	if (imageTurn !== null) rows.push(imageTurn);

	const summariser = createLLMSummariser({ settings });
	const summary = await timed(
		"summariser",
		() => summariser.summarise(emptyDoc("docs/raw/4.0 Manuals/Fridge.pdf", ""), "Defrosting the freezer: switch off, leave the door open."),
		(res) => ({ stop: "end", text: res, usage: "n/a" }),
	);
	if (summary !== null) rows.push(summary);

	console.log(`\n${rows.length} of 5 checks answered`);
	return rows.length === 5 ? 0 : 1;
}

/** user is one user turn, text only or with image parts. */
function user(content: string | (TextContent | ImageContent)[]): UserMessage {
	return { role: "user", content, timestamp: Date.now() };
}

process.exitCode = await main();
