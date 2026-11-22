// The web chat end to end: POST /api/chat, GET /api/chat/history, the `chat`
// frames on /api/events, the abort a closed request causes, and the tools a
// turn offers. Every case runs the real server, adapter, tools and prompt
// against src/llm/stub.ts on a temp-file SQLite and the memory entries service:
// no gateway, no bucket.
//
// The four Go tests keep their names (internal/server/server_test.go:361, :407,
// :511, :906, claude_settings_test.go:109): Go's page sent the whole
// conversation and Go's runner trimmed it; v3 sends only the newest turn,
// which is why TestChatToolLoop's body carries one turn and
// TestThinkStrippedFromEveryWebTurn shows the earlier turns are ignored.
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promptHooks } from "../agent/prompt.ts";
import { CUT_OFF_ERROR, CUT_OFF_NOTE, NOT_FOUND_IN_DOCS_REPLY, REFUSAL_REPLY } from "../agent/reply.ts";
import { buildTools } from "../agent/tools.ts";
import { CLASS_TEXT, type Doc, emptyDoc, type Index, STATUS_OK } from "../docs/index.ts";
import type { Library } from "../docs/search.ts";
import { type Agent, openAgent, whenIdle } from "../durable/adapter.ts";
import { type Stub, type StubAnswer, startStub } from "../llm/stub.ts";
import { LAST_TURN_MESSAGE, NO_CONNECTION_MESSAGE } from "../server/chat.ts";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import { headerOf, PARTNER, type Rig, type ServerStream, startServer, ZY } from "./rig.ts";

/** The zone the rest of the suites use. */
const ZONE = "Asia/Singapore";

/** The clock the prompt's date line reads, so a run's prompt bytes are fixed. */
const NOW = new Date("2026-11-11T09:00:00Z");

/** What the prompt needs of the documents: the index it lists (agent/prompt.ts). */
interface DocSource extends Library {
	index: () => Promise<Index>;
}

/** One document, so the document tools, the vision tool and the documents section all exist. */
function documentsLibrary(): DocSource {
	const fridge: Doc = {
		...emptyDoc("docs/raw/4.0 Manuals/Fridge.pdf", "fridge"),
		pages: 2,
		class: CLASS_TEXT,
		status: STATUS_OK,
	};
	return {
		index: async () => ({ schema: 1, docs: [fridge], lastSync: null, updated: "" }),
		search: async () => [],
		page: async (id, n) =>
			id !== fridge.id || n !== 2
				? { doc: null, page: null }
				: { doc: fridge, page: { n: 2, w: 595, h: 842, text: "…" } },
	};
}

/** A viewer that never renders: the vision test only needs the tool to exist. */
const VIEWER = { view: async () => ({}) } as never;

interface ChatRig {
	rig: Rig;
	stub: Stub;
	agent: Agent;
	/** A closed port, for the dead-endpoint case. */
	close: () => Promise<void>;
}

const open: ChatRig[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const rig of open.splice(0)) await rig.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/**
 * chatRig starts the stub, the server and one agent over it. The agent is
 * opened after the server, as serve() opens it (T3.2), and the server reads it
 * through the getter.
 */
async function chatRig(o: { answers: StubAnswer[]; env?: Partial<LLM>; docs?: DocSource | null }): Promise<ChatRig> {
	const stub = await startStub();
	stub.answer(...o.answers);
	const dir = await mkdtemp(join(tmpdir(), "movin-t35-"));
	dirs.push(dir);
	let agent: Agent | null = null;
	const rig = await startServer({
		settingsEnv: {
			...DEFAULTS,
			baseUrl: `${stub.origin}/v1`,
			model: "env-model",
			streaming: false,
			...o.env,
		},
		deps: (deps) => ({ ...deps, agent: () => agent }),
	});
	agent = await openAgent({
		dbPath: join(dir, "harness.db"),
		settings: rig.settings,
		log: rig.log,
		tools: buildTools({ entries: rig.entries, docs: o.docs ?? null, viewer: o.docs == null ? null : VIEWER }),
		// The retry policy's first backoff is a real delay; a test that waits for a
		// dead endpoint must not pay it.
		retry: { baseDelayMs: 1 },
		hooks: promptHooks({
			entries: rig.entries,
			docs: o.docs ?? null,
			viewer: o.docs != null,
			log: rig.log,
			timeZone: ZONE,
			now: () => NOW,
		}),
	});
	const running = agent;
	const made: ChatRig = {
		rig,
		stub,
		agent: running,
		close: async () => {
			await running.close();
			await rig.close();
			await stub.close();
		},
	};
	open.push(made);
	return made;
}

/** goSets the connection the way the settings drawer does. */
async function saveLLM(rig: Rig, body: Record<string, unknown>): Promise<void> {
	const answer = await rig.do("PUT", "/api/settings/llm", JSON.stringify(body));
	if (answer.status !== 200) throw new Error(`save settings: ${answer.status} ${answer.raw}`);
}

/** requests is the stub's nth request; a missing one fails the test rather than the type-check. */
function requests(r: ChatRig, n: number): { body: Record<string, unknown> } {
	const sent = r.stub.requests[n];
	if (sent === undefined) throw new Error(`the stub saw no request ${n + 1}`);
	return sent;
}

/** The body of one SSE frame of a fully read response. */
function frameData(raw: string, name: string): Record<string, unknown> | null {
	for (const frame of raw.split("\n\n")) {
		if (!frame.startsWith(`event: ${name}\n`)) continue;
		const data = frame.slice(frame.indexOf("\n") + 1);
		if (!data.startsWith("data: ")) continue;
		return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>;
	}
	return null;
}

/** The body of one `chat` frame of the event stream, or null for any other frame. */
function chatPayload(frame: string): Record<string, unknown> | null {
	if (!frame.startsWith("event: chat\n")) return null;
	const data = frame.slice(frame.indexOf("\n") + 1);
	return data.startsWith("data: ") ? (JSON.parse(data.slice("data: ".length)) as Record<string, unknown>) : null;
}

/** Reads `count` chat frames off the event stream. */
async function chatFrames(stream: ServerStream, count: number): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	while (out.length < count) {
		const chunk = await stream.next();
		for (const frame of chunk.split("\n\n")) {
			const payload = chatPayload(frame);
			if (payload === null) continue;
			out.push(payload);
			if (out.length === count) return out;
		}
	}
	return out;
}

/** The `chat failed` warn lines the server wrote, for Go's stream branch (Q3). */
function failedLogs(r: ChatRig): Record<string, unknown>[] {
	return r.rig.lines
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((line) => line.msg === "chat failed");
}

/** Everything a stream says in the next `ms`, so "no chat frame" is observable. */
async function quiet(stream: ServerStream, ms: number): Promise<string> {
	let text = "";
	const deadline = Date.now() + ms;
	for (;;) {
		const left = deadline - Date.now();
		if (left <= 0) return text;
		const chunk = await Promise.race([
			stream.next().catch(() => ""),
			new Promise<string>((done) => setTimeout(() => done(""), left)),
		]);
		text += chunk;
	}
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

describe("TestChatToolLoop", () => {
	for (const stream of [false, true]) {
		it(`runs the tool loop and shows the change (stream=${stream})`, async () => {
			const r = await chatRig({
				answers: [
					{ kind: "toolCalls", calls: [{ name: "set_dates", arguments: '{"move_in":"2026-12-05"}' }] },
					{ kind: "text", text: "Move-in is set to 5 Dec." },
				],
			});
			await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "model-a", streaming: stream });

			const answer = await r.rig.do(
				"POST",
				"/api/chat",
				`{"turns":[{"role":"user","content":"We move in on 5 Dec"}]}`,
				{
					Accept: "text/event-stream, application/json",
				},
			);
			expect(answer.status).toBe(200);

			let reply: unknown;
			let changes: unknown;
			if (stream) {
				expect(answer.raw).toContain("event: change");
				expect(answer.raw).toContain("event: done");
				const done = frameData(answer.raw, "done");
				if (done === null) throw new Error("no done frame");
				reply = done.reply;
				changes = done.changes;
				expect(done.model).toBe("model-a");
				// Go's change frame: the type twice (in the name and the data), no id
				// for the key dates.
				expect(frameData(answer.raw, "change")).toEqual({ type: "change", text: "Move-in set to Sat, 5 Dec" });
			} else {
				reply = answer.json.reply;
				changes = answer.json.changes;
				expect(answer.json.model).toBe("model-a");
			}
			expect(reply).toBe("Move-in is set to 5 Dec.");
			expect(changes).toEqual([{ text: "Move-in set to Sat, 5 Dec" }]);

			const snap = await r.rig.entries.current();
			expect(snap.doc.meta.moveDate).toBe("2026-12-05");

			// Go's `agent tool call` line, with the web channel.
			const lines = r.rig.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
			const call = lines.find((line) => line.msg === "agent tool call");
			expect(call).toMatchObject({ tool: "set_dates", channel: "web", by: ZY });
		});
	}

	it("answers the JSON form when streaming is off, with Go's field order", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "Nothing to change." }] });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "model-a", streaming: false });
		const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hello"}]}`, {
			Accept: "text/event-stream, application/json",
		});
		expect(answer.status).toBe(200);
		expect(answer.raw).toBe('{"reply":"Nothing to change.","changes":[],"model":"model-a"}\n');
	});
});

describe("TestChatForcedAnswerWhenModelKeepsCallingTools", () => {
	it("gives a text answer to a model that stops calling tools on the tool result", async () => {
		const r = await chatRig({
			answers: [
				{ kind: "toolCalls", calls: [{ name: "set_dates", arguments: '{"move_in":"2026-12-05"}' }] },
				{ kind: "text", text: "Move-in is set to 5 Dec." },
			],
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"We move in on 5 Dec"}]}`);
		expect(answer.status).toBe(200);
		expect(answer.json.reply).toBe("Move-in is set to 5 Dec.");
	});

	it("still answers in words when the model ignores tool_choice (pi-durable's turn_limit)", async () => {
		// Go forced a last round with tool_choice none and ignored its calls; here the
		// calls run and the run ends turn_limit, so the reply rules fill in the words.
		const r = await chatRig({
			answers: [{ kind: "toolCalls", calls: [{ name: "set_dates", arguments: '{"move_in":"2026-12-05"}' }] }],
			env: { maxToolRounds: 2 },
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"We move in on 5 Dec"}]}`);
		expect(answer.status).toBe(200);
		// A change was made, so Go's finish() says Done. rather than nothing.
		expect(answer.json.reply).toBe("Done.");
		// Three requests: two tool rounds and the forced one, which carried the flag.
		expect(r.stub.requests.map((sent) => sent.body.tool_choice)).toEqual([undefined, undefined, "none"]);
	});
});

describe("a refusal (P1)", () => {
	for (const stream of [false, true]) {
		it(`is a 200 with Go's declined text (stream=${stream})`, async () => {
			// pi-ai reports a content filter as an error stop and pi-durable ends the run
			// model_error; Go answers 200 with its declined text and keeps the changes
			// made before it (agent-spec §10.12, agent.go:193-196).
			const r = await chatRig({
				answers: [
					{
						kind: "toolCalls",
						calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"note","title":"Quartz"}]}' }],
					},
					{ kind: "text", text: "I can't help with that.", finish: "content_filter" },
				],
			});
			await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: stream });
			const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"note the quartz"}]}`, {
				Accept: "text/event-stream, application/json",
			});
			expect(answer.status).toBe(200);

			if (stream) {
				// Go drops the partial the model streamed, then the declined text is the
				// answer (agent.go:193-196).
				expect(answer.raw).toContain("event: reset");
				expect(answer.raw.indexOf("event: reset")).toBeLessThan(answer.raw.indexOf("event: done"));
				expect(answer.raw).not.toContain("event: error");
				const done = frameData(answer.raw, "done");
				expect(done?.reply).toBe(REFUSAL_REPLY);
				expect(done?.changes).toHaveLength(1);
			} else {
				expect(answer.json.reply).toBe(REFUSAL_REPLY);
				expect(answer.json.changes).toHaveLength(1);
			}
			// The entry the run saved before it declined is on the board, and the
			// transcript shows the same text the live turn did.
			expect((await r.rig.entries.current()).doc.entries.map((entry) => entry.title)).toEqual(["Quartz"]);
			const page = await r.rig.do("GET", "/api/chat/history");
			const items = page.json.items as Record<string, unknown>[];
			expect(items.map((item) => [item.role, item.text])).toEqual([
				["user", "note the quartz"],
				["assistant", REFUSAL_REPLY],
			]);
		});
	}
});

describe("a reload shows what the live turn showed (Q1)", () => {
	it("applies the same reply rules to an answer row as the live turn used", async () => {
		// Four turns, one per rule: a change with nothing said (`Done.`), a document
		// search with nothing said, a cut-off, and a refusal. The live reply and the
		// reloaded row must be the same text every time, because both go through
		// reply.ts.
		const r = await chatRig({
			answers: [
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"note","title":"Quartz"}]}' }],
				},
				{ kind: "text", text: "" },
				{ kind: "toolCalls", calls: [{ name: "search_documents", arguments: '{"query":"defrost"}' }] },
				{ kind: "text", text: "" },
				{ kind: "text", text: "We would look at", finish: "length" },
				{ kind: "text", text: "I can't help with that.", finish: "content_filter" },
			],
			docs: documentsLibrary(),
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });

		const live: string[] = [];
		for (const text of ["note the quartz", "what is the warranty?", "compare the quotes", "something else"]) {
			const answer = await r.rig.do(
				"POST",
				"/api/chat",
				`{"turns":[{"role":"user","content":${JSON.stringify(text)}}]}`,
			);
			expect(answer.status).toBe(200);
			live.push(String(answer.json.reply));
		}
		expect(live).toEqual([
			// Go's finish(): a change made and nothing said.
			"Done.",
			// A document tool was called and nothing was said.
			NOT_FOUND_IN_DOCS_REPLY,
			// Go keeps the text and notes the cut.
			`We would look at${CUT_OFF_NOTE}`,
			// Go's declined text, which is a 200 (P1).
			REFUSAL_REPLY,
		]);

		const page = await r.rig.do("GET", "/api/chat/history");
		const items = page.json.items as Record<string, unknown>[];
		expect(items.map((item) => item.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		// The same four lines, in the same order, after a reload.
		expect(items.filter((item) => item.role === "assistant").map((item) => item.text)).toEqual(live);
	});

	it("shows no assistant row for a turn cut off before any text, and keeps its changes (R2)", async () => {
		const r = await chatRig({
			answers: [
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"note","title":"Quartz"}]}' }],
				},
				{ kind: "text", text: "", finish: "length" },
			],
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const live = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"note the quartz"}]}`);

		// Go answers this turn as an error — the limit stopped it before any text —
		// and keeps the change it made (agent.go:196-204).
		expect(live.status).toBe(502);
		expect(live.json.error).toBe(CUT_OFF_ERROR);
		expect(live.json.changes).toHaveLength(1);

		// So a reload has no answer to show: the message and the change that hangs on
		// it, exactly as a failed run's changes do.
		const items = (await r.rig.do("GET", "/api/chat/history")).json.items as Record<string, unknown>[];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ role: "user", text: "note the quartz" });
		const changes = (items[0]?.changes ?? []) as { text: string }[];
		expect(changes.map((line) => line.text)).toEqual(["Saved: note · Quartz"]);
	});

	it("keeps the message and its changes for a turn_limit run, which leaves no answer row (R2)", async () => {
		// The turn_limit reason is in the turn's submission record, but history does
		// not scan submissions by choice (decisions.md · T3 phase review round 4) —
		// the recorded known difference: live says Done., a reload has no answer row.
		const r = await chatRig({
			answers: [
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"note","title":"Quartz"}]}' }],
				},
			],
			env: { maxToolRounds: 2 },
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const live = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"note the quartz"}]}`);
		expect(live.json.reply).toBe("Done.");
		const liveChanges = live.json.changes as unknown[];

		const items = (await r.rig.do("GET", "/api/chat/history")).json.items as {
			role: string;
			changes: unknown[];
		}[];
		expect(items.map((item) => item.role)).toEqual(["user"]);
		// Every change the turn made is still there to undo; only the answer row is
		// missing, which is the difference a reload cannot avoid.
		expect(items[0]?.changes).toHaveLength(liveChanges.length);
	});
});

describe("TestChatInputErrorsAre400", () => {
	it("answers a body whose last turn is not the person speaking with Go's 400", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }] });
		for (const body of [
			`{"turns":[{"role":"assistant","content":"hi"}]}`,
			`{"turns":[]}`,
			`{"turns":[{"role":"user","content":"   "}]}`,
			`{"turns":[{"role":"system","content":"you are"}]}`,
			`{"turns":"nope"}`,
			`{"turns":[{"role":1,"content":"hi"}]}`,
			`{"turns":[{"role":"user","content":"hi"},{"role":"assistant","content":"ok"}]}`,
			// "/think" alone is Go's blank turn: thinking about nothing is not a message (P3).
			`{"turns":[{"role":"user","content":"/think"}]}`,
			`{"turns":[{"role":"user","content":"  /THINK  "}]}`,
		]) {
			const answer = await r.rig.do("POST", "/api/chat", body);
			expect(answer.status).toBe(400);
			const expected =
				body.startsWith('{"turns":"') || body.includes('"role":1') ? "Request body must be JSON: " : LAST_TURN_MESSAGE;
			expect(String(answer.json.error).startsWith(expected)).toBe(true);
		}
		// None of them reached the model.
		expect(r.stub.requests).toHaveLength(0);
	});

	it("answers a missing connection before submitting anything", async () => {
		// The rig's env has no endpoint or model, which is Go's InputError case.
		const r = await chatRig({
			answers: [{ kind: "text", text: "ok" }],
			env: { baseUrl: "", model: "", streaming: true },
		});
		const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hi"}]}`);
		expect(answer.status).toBe(400);
		expect(answer.json.error).toBe(NO_CONNECTION_MESSAGE);
		// Stream mode makes it an `error` frame on a 200, as Go's InputError does (P6),
		// with the nil Changes Go's zero Result carries (Q3).
		const streamed = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hi"}]}`, {
			Accept: "text/event-stream, application/json",
		});
		expect(headerOf(streamed.headers, "content-type")).toBe("text/event-stream");
		expect(frameData(streamed.raw, "error")).toEqual({ changes: null, error: NO_CONNECTION_MESSAGE, model: "" });
		// Go's stream branch logs the same WARN line its 502 path does; the JSON 400
		// above logged nothing.
		expect(failedLogs(r)).toHaveLength(1);
		expect(failedLogs(r)[0]).toMatchObject({ by: ZY, model: "", err: NO_CONNECTION_MESSAGE });
		expect(r.stub.requests).toHaveLength(0);
	});

	it("sends an input error as an `error` frame on the stream, and a 400 in the JSON form (P6)", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }] });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: true });
		const bad = `{"turns":[{"role":"assistant","content":"hi"}]}`;

		const streamed = await r.rig.do("POST", "/api/chat", bad, { Accept: "text/event-stream, application/json" });
		expect(streamed.status).toBe(200);
		expect(headerOf(streamed.headers, "content-type")).toBe("text/event-stream");
		// Go's stream branch sends the zero Result's nil Changes — not `[]` — and logs
		// the same WARN line the 502 path does (server.go:472-476, Q3).
		expect(frameData(streamed.raw, "error")).toEqual({ changes: null, error: LAST_TURN_MESSAGE, model: "m" });
		expect(streamed.raw).not.toContain("event: done");
		expect(failedLogs(r)).toHaveLength(1);
		expect(failedLogs(r)[0]).toMatchObject({ by: ZY, model: "m", err: LAST_TURN_MESSAGE });

		// Without the Accept header the same turn is Go's JSON 400, and Go's JSON
		// branch logs nothing.
		const json = await r.rig.do("POST", "/api/chat", bad, { Accept: "application/json" });
		expect(json.status).toBe(400);
		expect(json.json).toEqual({ error: LAST_TURN_MESSAGE });
		expect(failedLogs(r)).toHaveLength(1);

		// Streaming off: a request that asks for a stream still gets the JSON form.
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const stillJson = await r.rig.do("POST", "/api/chat", bad, { Accept: "text/event-stream, application/json" });
		expect(stillJson.status).toBe(400);
		expect(failedLogs(r)).toHaveLength(1);
		expect(r.stub.requests).toHaveLength(0);
	});

	it("answers a dead endpoint with Go's 502, the changes it kept and the model", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }] });
		const dead = await startStub();
		const origin = dead.origin;
		await dead.close();
		await saveLLM(r.rig, { baseUrl: `${origin}/v1`, model: "m", streaming: false });
		const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hi"}]}`);
		expect(answer.status).toBe(502);
		expect(answer.json).toMatchObject({ changes: [], model: "m" });
		expect(String(answer.json.error)).toMatch(/connect|fetch failed|terminated/i);
	});
});

describe("TestModelSwitchTakesEffectNextMessage", () => {
	it("uses the saved model on the very next message", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }] });
		const chatOnce = async (): Promise<unknown> => {
			const answer = await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hello"}]}`);
			expect(answer.status).toBe(200);
			return r.stub.requests.at(-1)?.body.model;
		};
		expect(await chatOnce()).toBe("env-model");
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "model-b", streaming: false });
		expect(await chatOnce()).toBe("model-b");
	});
});

describe("TestThinkStrippedFromEveryWebTurn", () => {
	it("strips /think from what the model reads, and only the newest turn asks for thinking", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }], env: { thinkOnDemand: true } });
		// v1's page sent its whole history; only the newest turn is used now, so an
		// earlier /think turn is ignored rather than answered again.
		const answer = await r.rig.do(
			"POST",
			"/api/chat",
			`{"turns":[{"role":"user","content":"/think compare the quotes"},{"role":"assistant","content":"A is cheaper."},{"role":"user","content":"and the warranty?"}]}`,
		);
		expect(answer.status).toBe(200);
		const sent = r.stub.requests.at(-1);
		if (sent === undefined) throw new Error("no request");
		const users = (sent.body.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user");
		const text = users.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
		expect(text).not.toContain("/think");
		expect(text).toContain("and the warranty?");
		// The newest turn has no /think, so thinking is off.
		expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });

		// A newest turn that is a /think message asks for thinking, and the command
		// never reaches the model.
		await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"  /THINK\\nwhy?"}]}`);
		const asked = r.stub.requests.at(-1);
		if (asked === undefined) throw new Error("no request");
		const askedText = (asked.body.messages as { role: string; content: unknown }[])
			.filter((m) => m.role === "user")
			.map((m) => (typeof m.content === "string" ? m.content : ""))
			.join("\n");
		expect(askedText).toContain("why?");
		expect(askedText).not.toContain("/THINK");
		expect(asked.body.chat_template_kwargs).toEqual({ enable_thinking: true, preserve_thinking: true });
	});
});

/** counts is the multiset of a page's rows: each exactly once, order-free. */
function counts(rows: readonly string[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const row of rows) out[row] = (out[row] ?? 0) + 1;
	return out;
}

describe("GET /api/chat/history", () => {
	/** Two turns: one that saves an entry, and one that says nothing about the record. */
	async function twoTurns(): Promise<ChatRig> {
		const r = await chatRig({
			answers: [
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"task","title":"Book movers"}]}' }],
				},
				{ kind: "text", text: "Saved it." },
				{ kind: "text", text: "Nothing to change." },
			],
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		expect(
			(await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"Book the movers"}]}`)).status,
		).toBe(200);
		expect((await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hello"}]}`)).status).toBe(200);
		return r;
	}

	it("answers two turns as four rows, oldest first, with the run's changes on its answer", async () => {
		const r = await twoTurns();
		const answer = await r.rig.do("GET", "/api/chat/history");
		expect(answer.status).toBe(200);
		const items = answer.json.items as Record<string, unknown>[];
		expect(items.map((item) => [item.role, item.text])).toEqual([
			["user", "Book the movers"],
			["assistant", "Saved it."],
			["user", "hello"],
			["assistant", "Nothing to change."],
		]);
		expect(items.every((item) => typeof item.at === "number")).toBe(true);
		const changes = items[1]?.changes as Record<string, unknown>[];
		expect(changes.map((line) => line.text)).toEqual(["Saved: task · Book movers"]);
		// A journaled change has its id, which is what the page's Undo needs.
		expect(typeof changes[0]?.id).toBe("string");
		// Go's ChangeLine has the id and the text and nothing else.
		expect(Object.keys(changes[0] ?? {}).sort()).toEqual(["id", "text"]);
		expect(items[0]?.changes).toEqual([]);
		expect(items[3]?.changes).toEqual([]);
		expect(answer.json.more).toBe(false);
		expect(answer.json.cursor).toBe("");
	});

	it("pages downwards with the cursor, and takes a limit of at most 200", async () => {
		const r = await twoTurns();
		const first = await r.rig.do("GET", "/api/chat/history?limit=2");
		const page = first.json.items as Record<string, unknown>[];
		expect(page.map((item) => item.text)).toEqual(["hello", "Nothing to change."]);
		expect(first.json.more).toBe(true);
		const cursor = first.json.cursor;
		expect(typeof cursor).toBe("string");

		const under = await r.rig.do("GET", `/api/chat/history?before=${String(cursor)}&limit=2`);
		expect((under.json.items as Record<string, unknown>[]).map((item) => item.text)).toEqual([
			"Book the movers",
			"Saved it.",
		]);
		expect(under.json.more).toBe(false);

		// A limit over the cap is the cap, not an error.
		expect((await r.rig.do("GET", "/api/chat/history?limit=1000")).status).toBe(200);
		expect((await r.rig.do("GET", "/api/chat/history?limit=nonsense")).status).toBe(200);
	});

	it("never splits a run, so each change line lands on exactly one row (P2)", async () => {
		// Two runs that save an entry and one that saves then fails: five rows and three
		// change lines. A page boundary must never cut a run in half — the cursor would
		// then start inside it and its change lines would land on two rows.
		const r = await chatRig({
			answers: [
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"task","title":"First"}]}' }],
				},
				{ kind: "text", text: "Saved it." },
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"task","title":"Second"}]}' }],
				},
				{ kind: "text", text: "Saved it." },
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"task","title":"Third"}]}' }],
				},
				{ kind: "error", status: 500, message: "boom" },
			],
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		for (const [text, status] of [
			["one", 200],
			["two", 200],
			["three", 502],
		] as const) {
			const answer = await r.rig.do(
				"POST",
				"/api/chat",
				`{"turns":[{"role":"user","content":${JSON.stringify(text)}}]}`,
			);
			expect(answer.status).toBe(status);
		}

		for (const limit of [1, 2, 3, 4]) {
			const rows: { role: string; text: string; changes: { text: string }[] }[] = [];
			let before = "";
			let pages = 0;
			for (;;) {
				pages++;
				expect(pages).toBeLessThan(20);
				const path = `/api/chat/history?limit=${limit}${before === "" ? "" : `&before=${before}`}`;
				const answer = await r.rig.do("GET", path);
				expect(answer.status).toBe(200);
				const items = answer.json.items as { role: string; text: string; changes: { text: string }[] }[];
				// A page is oldest first: the cursor's run boundary is its first row, and
				// every run reads user-then-answer. A reversed run would show an answer
				// before the message it answers (Q4). A page with nothing on it may not
				// claim there is more.
				expect(items.map((item) => item.role).join(",")).toMatch(/^user(,assistant)?(,user(,assistant)?)*$/);
				if (answer.json.more === true) expect(items.length).toBeGreaterThan(0);
				rows.push(...items);
				if (answer.json.more !== true) break;
				before = String(answer.json.cursor);
			}
			// Every row of the transcript exactly once, however the pages fell, and each
			// page in the list's own order: the run boundary (its user row) first, then
			// that run's answer (Q4).
			expect(counts(rows.map((row) => `${row.role}:${row.text}`))).toEqual(
				counts(["assistant:Saved it.", "assistant:Saved it.", "user:one", "user:three", "user:two"]),
			);
			const lines = rows.flatMap((row) => row.changes.map((line) => line.text));
			expect(lines).toHaveLength(3);
			expect(new Set(lines).size).toBe(3);
			// The failed run's line is on its own user row; an answered run's is on its
			// answer, and its user row carries none.
			const failed = rows.find((row) => row.text === "three");
			expect(failed?.role).toBe("user");
			expect(failed?.changes.map((line) => line.text)).toEqual(["Saved: task · Third"]);
			for (const text of ["one", "two"]) {
				expect(rows.find((row) => row.text === text)?.changes).toEqual([]);
			}
		}
	});

	it("is empty for an email that never chatted", async () => {
		const r = await twoTurns();
		const partner = await r.rig.do("GET", "/api/chat/history", undefined, { "X-Forwarded-Email": PARTNER });
		expect(partner.status).toBe(200);
		expect(partner.json).toEqual({ items: [], more: false, cursor: "" });
		// And the other email's conversation is unchanged by that read.
		expect((await r.rig.do("GET", "/api/chat/history")).json.items).toHaveLength(4);
	});

	it("is behind the same sign-in check as every other route", async () => {
		const r = await twoTurns();
		const anonymous = await r.rig.do("GET", "/api/chat/history", undefined, { "X-Forwarded-Email": "" });
		expect(anonymous.status).toBe(401);
		expect(anonymous.raw).toBe("Not signed in.\n");
	});

	it("answers the user turn of a run that never finished", async () => {
		// A reload during a turn stops it (the request's close aborts it), and the
		// transcript keeps what the person typed.
		const r = await chatRig({ answers: [{ kind: "hang" }] });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		await abortTurn(r, "slow question");
		const answer = await r.rig.do("GET", "/api/chat/history");
		expect((answer.json.items as Record<string, unknown>[]).map((item) => [item.role, item.text])).toEqual([
			["user", "slow question"],
		]);
	});
});

describe("the transcript's text (P4)", () => {
	it("keeps what the person typed, and gives the model the stripped text", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "Because it rained." }], env: { thinkOnDemand: true } });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: true });
		const mine = await r.rig.open("/api/events");
		try {
			const answer = r.rig.do(
				"POST",
				"/api/chat",
				`{"turns":[{"role":"user","content":"/think why?"}],"request":"r1"}`,
			);
			const frames = await chatFrames(mine, 3);
			// Another tab draws the message as typed, `/think` and all.
			expect(frames[0]).toMatchObject({ type: "user", text: "/think why?", request: "r1" });
			expect((await answer).status).toBe(200);

			// So does a reload, and the model never saw the command.
			const page = await r.rig.do("GET", "/api/chat/history");
			const items = page.json.items as Record<string, unknown>[];
			expect(items.map((item) => [item.role, item.text])).toEqual([
				["user", "/think why?"],
				["assistant", "Because it rained."],
			]);
			const sent = requests(r, 0);
			const users = (sent.body.messages as { role: string; content: unknown }[])
				.filter((message) => message.role === "user")
				.map((message) => (typeof message.content === "string" ? message.content : ""))
				.join("\n");
			expect(users).toContain("why?");
			expect(users).not.toContain("/think");
		} finally {
			mine.close();
		}
	});
});

describe("the two tabs", () => {
	it("sends the chat frames of one email to every stream of that email, and to no other", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "Hello there." }] });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const mine = await r.rig.open("/api/events");
		const theirs = await r.rig.open("/api/events", { "X-Forwarded-Email": PARTNER });
		try {
			const answer = r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hi"}],"request":"req-1"}`);
			// user, delta(s), done: the second tab sees the whole turn.
			const frames = await chatFrames(mine, 3);
			expect(frames.map((frame) => frame.type)).toEqual(["user", "delta", "done"]);
			expect(frames[0]).toMatchObject({ type: "user", text: "hi", request: "req-1" });
			expect(frames[1]).toMatchObject({ type: "delta", request: "req-1" });
			expect(frames[2]).toMatchObject({
				type: "done",
				reply: "Hello there.",
				changes: [],
				model: "m",
				request: "req-1",
			});
			expect((await answer).status).toBe(200);

			// The other email's stream is alive and heard nothing of it.
			const heard = await quiet(theirs, 200);
			expect(heard).toContain("event: entries");
			expect(heard).not.toContain("event: chat");
		} finally {
			mine.close();
			theirs.close();
		}
	});

	it("lets the sender tell its own request from another tab's", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "Hello there." }] });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const mine = await r.rig.open("/api/events");
		try {
			// No id in the body: the server makes one, and echoes it on every frame.
			const answer = r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"hi"}]}`);
			const frames = await chatFrames(mine, 3);
			const id = frames[0]?.request;
			expect(typeof id).toBe("string");
			expect((id as string).length).toBeGreaterThan(0);
			expect(frames.every((frame) => frame.request === id)).toBe(true);
			// The same id is not the one a second turn uses.
			const second = r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"again"}],"request":"mine"}`);
			const next = await chatFrames(mine, 3);
			expect(next.every((frame) => frame.request === "mine")).toBe(true);
			await answer;
			await second;
		} finally {
			mine.close();
		}
	});

	it("carries a change frame with its id, so another tab can offer Undo", async () => {
		const r = await chatRig({
			answers: [
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"task","title":"Book movers"}]}' }],
				},
				{ kind: "text", text: "Saved it." },
			],
		});
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false });
		const mine = await r.rig.open("/api/events");
		try {
			const answer = r.rig.do(
				"POST",
				"/api/chat",
				`{"turns":[{"role":"user","content":"Book the movers"}],"request":"r1"}`,
			);
			const frames = await chatFrames(mine, 4);
			expect(frames.map((frame) => frame.type)).toEqual(["user", "change", "delta", "done"]);
			expect(frames[1]).toMatchObject({ type: "change", request: "r1", text: "Saved: task · Book movers" });
			expect(typeof frames[1]?.id).toBe("string");
			expect(frames[3]).toMatchObject({ type: "done", request: "r1", reply: "Saved it." });
			await answer;
		} finally {
			mine.close();
		}
	});
});

describe("the tools follow the settings", () => {
	const toolNames = (sent: { body: Record<string, unknown> }): string[] =>
		((sent.body.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);

	it("offers view_document_page only when the connection takes images", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }], docs: documentsLibrary() });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false, vision: false });
		expect((await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"one"}]}`)).status).toBe(200);
		expect(toolNames(requests(r, 0))).toEqual([
			"add_entry",
			"update_entry",
			"search_entries",
			"set_dates",
			"undo_change",
			"search_documents",
			"read_document_page",
		]);

		// Turning vision on applies to the next request, with no restart.
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false, vision: true });
		expect((await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"two"}]}`)).status).toBe(200);
		expect(toolNames(requests(r, 1)).at(-1)).toBe("view_document_page");

		// And off again.
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false, vision: false });
		expect((await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"three"}]}`)).status).toBe(200);
		expect(toolNames(requests(r, 2))).not.toContain("view_document_page");
	});

	it("says so in the system text as well, so the model is never told about a tool it lacks", async () => {
		const r = await chatRig({ answers: [{ kind: "text", text: "ok" }], docs: documentsLibrary() });
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false, vision: true });
		await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"one"}]}`);
		await saveLLM(r.rig, { baseUrl: `${r.stub.origin}/v1`, model: "m", streaming: false, vision: false });
		await r.rig.do("POST", "/api/chat", `{"turns":[{"role":"user","content":"two"}]}`);
		const system = (sent: { body: Record<string, unknown> }): string =>
			((sent.body.messages ?? []) as { role: string; content: unknown }[])
				.filter((message) => message.role === "system")
				.map((message) => (typeof message.content === "string" ? message.content : ""))
				.join("\n");
		expect(system(requests(r, 0))).toContain("use view_document_page");
		expect(system(requests(r, 1))).not.toContain("view_document_page");
	});
});

/**
 * abortTurn sends one chat request and closes it mid-run, the way the Stop
 * button and a reload do, then waits for the run to end.
 */
async function abortTurn(r: ChatRig, text: string): Promise<void> {
	const port = r.rig.port;
	const sent = request({
		host: "127.0.0.1",
		port,
		method: "POST",
		path: "/api/chat",
		agent: false,
		headers: {
			"X-Forwarded-Email": ZY,
			"Content-Type": "application/json",
			Accept: "text/event-stream, application/json",
		},
	});
	sent.on("error", () => undefined);
	sent.write(JSON.stringify({ turns: [{ role: "user", content: text }] }));
	sent.end();
	// Long enough for the request to be read and the run to start, short enough
	// that the hanging stub never answers it.
	await sleep(250);
	sent.destroy();
	await whenIdle(r.agent, `web:${ZY}`);
}
