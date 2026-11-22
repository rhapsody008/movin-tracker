// The chat-eval port (T3.6) on the scripted stub: the real agent, the real
// tools, the real prompt and reply rules, the in-memory entries seeded from
// fixtures/entries.sample.json — and a stub that answers each case with the
// tool calls that make it pass. No gateway, no bucket: the -saved -docs case
// reads a memory store whose writes throw.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/config.ts";
import { CLASS_DRAWING, emptyDoc, encodeIndex, encodePageText, type Index, STATUS_OK } from "../src/docs/index.ts";
import { type Stub, type StubAnswer, type StubUsage, startStub } from "../src/llm/stub.ts";
import { createMemoryStore } from "../src/objstore/memory.ts";
import type { ObjectStore } from "../src/objstore/store.ts";
import { dayIn, main } from "./chateval.ts";

/** The eval's clock: a Wednesday, so "Friday" and "5 Dec" have one answer. */
const NOW = new Date("2026-11-11T09:00:00Z");

/** What the stub reports for every answer: 100 prompt tokens, 20 of them cached. */
const USAGE: StubUsage = { prompt: 100, completion: 10, cached: 20 };

/** How many answers the twelve cases script: 8 tool rounds, 4 plain answers. */
const CASE_REQUESTS = 20;

/** One scripted tool call. */
function call(name: string, args: object): StubAnswer {
	return { kind: "toolCalls", calls: [{ name, arguments: JSON.stringify(args) }], usage: USAGE };
}

/** One scripted answer in words. */
function say(text: string): StubAnswer {
	return { kind: "text", text, usage: USAGE };
}

/** The wrong change the failing run makes: case 3 records 5,000 instead of 5,800. */
const WRONG_ADD = {
	entries: [
		{ kind: "decision", title: "Daikin system 4 aircon", status: "decided", estimate: 5000, vendor: "CoolAir" },
	],
};

/**
 * script is the twelve answers of Go's cases (main.go:100-236), in order: each
 * tool call is what its check wants, so a correct run passes 12 of 12. `wrong`
 * makes case 3 record another price, which its check must fail.
 */
function script(wrong = false): StubAnswer[] {
	return [
		// 1: set the move-in date (two requests: the call, then the answer).
		call("set_dates", { move_in: "2026-12-05" }),
		say("Move-in set to Sat, 5 Dec."),
		// 2: one idea, dry kitchen, nothing invented.
		call("add_entry", {
			entries: [{ kind: "idea", title: "Fluted glass for the dry kitchen sliding door", room: "dry kitchen" }],
		}),
		say("Noted as an idea for the dry kitchen."),
		// 3: a decision at 5,800 from CoolAir.
		wrong
			? call("add_entry", WRONG_ADD)
			: call("add_entry", {
					entries: [
						{
							kind: "decision",
							title: "Daikin system 4 aircon",
							status: "decided",
							estimate: 5800,
							vendor: "CoolAir",
						},
					],
				}),
		say("Recorded the aircon decision."),
		// 4: a task on the coming Friday at 14:00.
		call("add_entry", {
			entries: [{ kind: "task", title: "Electrician to check the DB", date: "2026-11-13", time: "14:00" }],
		}),
		say("Added the electrician for Friday at 14:00."),
		// 5: update the seeded carpentry entry, not a duplicate.
		call("update_entry", { id: "01K9SEED000000000000000001", estimate: 18000, actual: 5400, vendor: "Lim" }),
		say("Updated the carpentry quote and the 30% paid."),
		// 6: two bathrooms, no tiles on record: ask.
		say("Which bathroom do you mean — the master or bedroom 2?"),
		// 7: answer from the record, change nothing.
		say("You decided on sintered stone for the wet kitchen countertop, at SGD 4,200."),
		// 8: archive, never hard-delete.
		call("update_entry", { id: "01K9SEED000000000000000002", archived: true }),
		say("Dropped the post-reno cleaning."),
		// 9: undo the archiving.
		call("undo_change", {}),
		say("Brought the post-reno cleaning back."),
		// 10: a milestone completed today.
		call("add_entry", {
			entries: [{ kind: "note", title: "Collected the keys", milestone: true, status: "done" }],
		}),
		say("Saved collecting the keys as a milestone."),
		// 11: answer from the record.
		say("So far: collected the keys."),
		// 12: group chatter, and nothing to record.
		say("NO_REPLY"),
	];
}

/** The five documented answers of -docs (docs.go:39-55), after the twelve. */
function docsScript(): StubAnswer[] {
	return [
		call("search_documents", { query: "defrost SMEG fridge freezer" }),
		say("The SMEG fridge freezer defrosts automatically."),
		say("The master bedroom opens onto the balcony."),
		call("view_document_page", { doc: "0PLAN0001", page: 1 }),
		say("The DB is next to the kitchen entrance."),
		say("WP means weatherproof."),
		say("The plan has no dimensions, so you would have to measure on site."),
	];
}

/** The environment of a run on the stub: an env connection in UTC, no bucket. */
function evalEnv(stub: Stub, over: Env = {}): Env {
	return {
		LLM_BASE_URL: `${stub.origin}/v1`,
		LLM_MODEL: "eval-model",
		LLM_API_KEY: "sk-eval-test",
		TZ: "UTC",
		...over,
	};
}

/** A run's two output streams. */
interface Run {
	out: string[];
	err: string[];
	code: number;
}

/** runOnce is one whole eval run, with its output captured and its exit code. */
async function runOnce(args: readonly string[], env: Env, store?: ObjectStore): Promise<Run> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main({
		env,
		args,
		now: () => NOW,
		write: (line) => out.push(line),
		writeErr: (line) => err.push(line),
		...(store === undefined ? {} : { store }),
	});
	return { out, err, code };
}

/** block is one case's printed lines: from `N. "…"` to the blank line after it. */
function block(out: readonly string[], n: number): string[] {
	const start = out.findIndex((line) => line.startsWith(`${n}. "`));
	if (start < 0) return [];
	const end = out.indexOf("", start);
	return out.slice(start, end < 0 ? out.length : end);
}

/** readOnly is a store that refuses every write, so a run that writes fails loudly. */
function readOnly(inner: ObjectStore): { store: ObjectStore; writes: string[] } {
	const writes: string[] = [];
	const refuse =
		(op: string) =>
		(key: string): never => {
			writes.push(`${op} ${key}`);
			throw new Error(`chat-eval wrote to the bucket: ${op} ${key}`);
		};
	return {
		store: {
			get: (key, signal) => inner.get(key, signal),
			stat: (key, signal) => inner.stat(key, signal),
			list: (prefix, signal) => inner.list(prefix, signal),
			info: (signal) => inner.info(signal),
			put: refuse("put"),
			putBlob: refuse("putBlob"),
			delete: refuse("delete"),
		},
		writes,
	};
}

/** One document in the bucket, so -docs has an index to read. */
const DOC_KEY = "docs/raw/1.0 Plans/1.3 Power.pdf";
const DOC_ID = "0PLAN0001";

/** seedBucket writes the settings and the documents the -saved -docs run reads. */
async function seedBucket(store: ObjectStore, baseUrl: string): Promise<void> {
	const encoder = new TextEncoder();
	await store.put(
		"settings.json",
		encoder.encode(
			JSON.stringify({
				schema: 1,
				llm: { vision: true, baseUrl, model: "saved-model", streaming: true, thinkOnDemand: false },
			}),
		),
		null,
	);
	const doc = {
		...emptyDoc(DOC_KEY, DOC_ID),
		etag: '"1"',
		size: 10,
		pages: 1,
		class: CLASS_DRAWING,
		status: STATUS_OK,
		textPages: 1,
	};
	const index: Index = { schema: 1, docs: [doc], lastSync: null, updated: "" };
	await store.put("docs/index.json", encoder.encode(encodeIndex(index, "2026-11-01T00:00:00Z")), null);
	await store.put(
		"docs/text/1.0 Plans/1.3 Power.pdf.json",
		encoder.encode(
			encodePageText({
				key: DOC_KEY,
				etag: '"1"',
				pages: [
					{
						n: 1,
						w: 2384,
						h: 1684,
						text: `POWER POINTS LEGEND WP weatherproof DB distribution board ${"socket ".repeat(20)}`,
					},
				],
			}),
		),
		null,
	);
}

describe("the twelve cases on the scripted stub", () => {
	it("prints Go's per-case block, the totals and the all-pass line, exit 0", { timeout: 60_000 }, async () => {
		const stub = await startStub();
		try {
			stub.answer(...script());
			const run = await runOnce([], evalEnv(stub));

			expect(run.code).toBe(0);
			expect(run.err).toEqual([]);
			// The banner: Go's line with the v3 kind, the effort and Go's date layout.
			expect(run.out.slice(0, 2)).toEqual([
				`chat-eval: openai model eval-model at ${stub.origin}/v1, server default, today Wed 11 Nov 2026`,
				"",
			]);
			// Twelve blocks, each ending in PASS, and the last line Go prints.
			expect(run.out.filter((line) => line === "   PASS")).toHaveLength(12);
			expect(run.out.filter((line) => line.startsWith("   FAIL"))).toEqual([]);
			expect(run.out.at(-1)).toBe("All 12 messages produced the right change.");

			// Case 1: the usage line, the reply, the change and the diff are Go's.
			const first = block(run.out, 1);
			expect(first[0]).toMatch(/^1\. "We move in on 5 Dec" {2}\(\d+\.\ds\)$/);
			expect(first.slice(1)).toEqual([
				"   usage:   in 160, out 20, cache read 40, cache write 0",
				"   reply:   Move-in set to Sat, 5 Dec.",
				"   change:  Move-in set to Sat, 5 Dec",
				"   diff:    meta.moveDate: <nil> → 2026-12-05",
				"   PASS",
			]);
			// Case 8 archives, case 9 brings it back: the same document throughout.
			expect(block(run.out, 8)).toContain('   diff:    ~ "Post-reno cleaning" archived: false → true');
			expect(block(run.out, 9)).toContain('   diff:    ~ "Post-reno cleaning" archived: true → false');
			// Case 10 records the milestone with today's date.
			expect(block(run.out, 10)).toContain(
				'   diff:    + "Collected the keys" {"actual":null,"category":"","completed":"2026-11-11","date":null,"estimate":null,"kind":"note","milestone":true,"room":null,"status":"done","time":null,"vendor":""}',
			);
			// Case 12 is silent, and says so.
			expect(block(run.out, 12)).toContain("   reply:   (silent)");
			// Only the group case is submitted as one: its system prompt carries Go's
			// group line and no other request does (SubmitOptions.group).
			const systems = stub.requests.map(systemText);
			expect(systems.at(-1)).toContain("This is a group chat");
			expect(systems.slice(0, -1).every((text) => !text.includes("This is a group chat"))).toBe(true);

			// The totals: prompt = in + cacheRead + cacheWrite over all 20 requests.
			const totals = run.out.find((line) => line.startsWith("totals: ")) ?? "";
			expect(totals).toMatch(
				/^totals: 12 messages, \d+\.\d s \(\d+\.\d s each\), prompt tokens 2000 \(uncached 1600, cache read 400 = 20%, cache write 0\), output 200$/,
			);

			// Every case was its own conversation: one user message per request, and the
			// model is the resolved one.
			expect(stub.requests).toHaveLength(CASE_REQUESTS);
			for (const request of stub.requests) {
				expect(request.body.model).toBe("eval-model");
				const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
				const users = messages.filter((m) => isRecord(m) && m.role === "user");
				expect(users).toHaveLength(1);
			}
		} finally {
			await stub.close();
		}
	});

	it("fails one case, prints the tool-call log and exits 1", { timeout: 60_000 }, async () => {
		const stub = await startStub();
		try {
			stub.answer(...script(true));
			const run = await runOnce([], evalEnv(stub));

			expect(run.code).toBe(1);
			expect(run.err).toEqual(["error: 1 of 12 messages made the wrong change"]);
			expect(run.out.filter((line) => line === "   PASS")).toHaveLength(11);
			expect(run.out).toContain('   FAIL  cost = {"estimate":5000,"actual":null}, want 5800');
			// The totals still count all twelve, as Go's do.
			expect(run.out.find((line) => line.startsWith("totals: "))).toContain("totals: 12 messages,");
			// The dump: every `agent tool call` line of the run, indented.
			const dump = run.out.indexOf("tool-call log:");
			expect(dump).toBeGreaterThan(0);
			const lines = run.out.slice(dump + 1);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(line.startsWith("   ")).toBe(true);
				expect(line).toContain('"msg":"agent tool call"');
			}
			expect(lines.some((line) => line.includes('"tool":"update_entry"'))).toBe(true);
		} finally {
			await stub.close();
		}
	});

	it("prints a refusal's reply, not an agent error (P1)", { timeout: 60_000 }, async () => {
		const stub = await startStub();
		try {
			// Case 1's tool round runs and then the model declines: pi-ai's content
			// filter. Go answers its declined text, so the eval must print the reply and
			// pass the case — never `FAIL agent error`.
			const answers = script();
			answers[1] = { kind: "text", text: "I can't help with that.", finish: "content_filter", usage: USAGE };
			stub.answer(...answers);
			const run = await runOnce([], evalEnv(stub));

			expect(block(run.out, 1)).toContain("   reply:   The model declined to answer this message. Try rephrasing it.");
			const printed = run.out.join("\n");
			expect(printed).not.toContain("agent error");
			expect(printed).not.toContain("content_filter");
		} finally {
			await stub.close();
		}
	});

	it("takes -model for the banner and for every request", { timeout: 60_000 }, async () => {
		const stub = await startStub();
		try {
			stub.answer(...script());
			const run = await runOnce(["-model", "override-model"], evalEnv(stub));

			expect(run.code).toBe(0);
			expect(run.out[0]).toBe(
				`chat-eval: openai model override-model at ${stub.origin}/v1, server default, today Wed 11 Nov 2026`,
			);
			expect(stub.requests.length).toBeGreaterThan(0);
			for (const request of stub.requests) expect(request.body.model).toBe("override-model");
		} finally {
			await stub.close();
		}
	});
});

describe("-saved -docs on a read-only bucket", () => {
	it("reads the saved connection and the documents and never writes", { timeout: 120_000 }, async () => {
		const stub = await startStub();
		try {
			const bucket = createMemoryStore();
			await seedBucket(bucket, `${stub.origin}/v1`);
			const read = readOnly(bucket);
			stub.answer(...script(), ...docsScript());
			// No LLM_* here: the connection comes from settings.json in the bucket.
			const run = await runOnce(["-saved", "-docs"], { TZ: "UTC", S3_BUCKET: "bucket-test" }, read.store);

			expect(run.err).toEqual([]);
			expect(run.code).toBe(0);
			expect(run.out[0]).toBe(
				`chat-eval: openai model saved-model at ${stub.origin}/v1, server default, today Wed 11 Nov 2026`,
			);
			expect(run.out.filter((line) => line === "   PASS")).toHaveLength(17);
			expect(run.out.at(-1)).toBe("All 17 messages produced the right change.");
			// The document cases ran on the documents: the tool calls are in the log
			// during their case, and their answers passed.
			expect(block(run.out, 13)).toContain("   PASS");
			expect(block(run.out, 15)).toContain("   PASS");
			expect(block(run.out, 17)).toContain("   PASS");
			expect(read.writes).toEqual([]);
		} finally {
			await stub.close();
		}
	});
});

describe("the connection", () => {
	it("asks for LLM_* or -saved when there is no connection", { timeout: 30_000 }, async () => {
		// No LLM_BASE_URL, no LLM_MODEL, and no S3_BUCKET either: Go defaults that to
		// "unused" before config reads it, so the connection is the complaint.
		const run = await runOnce([], { TZ: "UTC" });
		expect(run.code).toBe(1);
		expect(run.err).toEqual([
			"error: set LLM_BASE_URL, LLM_MODEL (and LLM_API_KEY if needed) in .env first, or use -saved",
		]);
		expect(run.out).toEqual([]);
	});

	it("says -docs needs -saved", { timeout: 30_000 }, async () => {
		const run = await runOnce(["-docs"], { TZ: "UTC", LLM_BASE_URL: "http://127.0.0.1:1/v1", LLM_MODEL: "m" });
		expect(run.code).toBe(1);
		expect(run.err).toEqual(["error: -docs needs -saved (the documents are in the bucket)"]);
	});
});

describe("the date the checks read", () => {
	it("is the app zone's calendar day, as Go's Time.In(c.Location) gives", () => {
		// 20:00 UTC on 11 Nov is already the 12th in Singapore.
		expect(dayIn(new Date("2026-11-11T20:00:00Z"), "Asia/Singapore")).toEqual({
			iso: "2026-11-12",
			weekday: 4,
			year: 2026,
			month: 11,
			day: 12,
		});
		expect(dayIn(NOW, "UTC")).toEqual({ iso: "2026-11-11", weekday: 3, year: 2026, month: 11, day: 11 });
	});
});

/** systemText is the system message a stub request carried ("") when it had none. */
function systemText(request: { body: Record<string, unknown> }): string {
	const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
	for (const message of messages) {
		if (isRecord(message) && message.role === "system" && typeof message.content === "string") return message.content;
	}
	return "";
}

/** isRecord narrows a request's message entry. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
