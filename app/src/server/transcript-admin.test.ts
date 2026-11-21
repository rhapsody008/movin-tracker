// The byte contract of the admin, settings and document routes, replayed:
// every request of tmp/t22-golden/main.go against this port, compared with what
// Go answered — status, the three headers that carry the contract, and the body
// bytes — and every request each fake endpoint received, compared with Go's.
//
// Five things are random in both apps and are masked by value before comparing:
// latencyMs, the probe steps' ms, the probe's ULID, the storage view's
// lastWrite.at, and the tail of a network error (where Node and Go differ by
// design, brief T2.2). The fake endpoint's origin is masked to <LLM>.
//
// Two v1 shapes are rewritten on both sides because v2 changed them on purpose
// (settings-spec §11): the view's claudeOrigin, which v2 removed, and
// "kind must be openai or claude", which v2 shortened. Nothing else is masked.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../objstore/memory.ts";
import { DEFAULTS } from "../settings/settings.ts";
import { parseTelegramEnv } from "../settings/telegram.ts";
import { ENV_KEY, type FakeCall, headerOf, startFakeLLM, startServer } from "./rig.ts";

interface Step {
	name: string;
	method: string;
	path: string;
	reqHeaders: [string, string][];
	reqBody: string;
	status: number;
	headers: Record<string, string>;
	body: string;
}

interface Fixture {
	steps: Step[];
	llmCalls: FakeCall[];
}

const fixture = JSON.parse(
	readFileSync(new URL("./testdata/transcript-admin.go.json", import.meta.url), "utf8"),
) as Fixture;

/** The clock the Go harness pins. */
const FIXED = new Date("2026-11-12T10:00:00Z");

/** The headers the transcript records (server-spec §1.4, §6.5). */
const COMPARED = ["content-type", "cache-control", "x-content-type-options"];

/**
 * normalise blanks what is random and rewrites the two shapes v2 changed. The
 * endpoint's origin is <LLM> in the fixture already, so Go passes null.
 */
function normalise(text: string, llmBase: string | null): string {
	let out = llmBase === null ? text : text.split(llmBase).join("<LLM>");
	out = out
		// v2 has no claudeOrigin in the view.
		.replace(/"claudeOrigin":"https:\/\/api\.anthropic\.com",/g, "")
		// v2 has one kind, so the wording lost "or claude".
		.replace(/"kind must be openai or claude"/g, `"kind must be openai"`)
		.replace(/"latencyMs":\d+/g, `"latencyMs":<MS>`)
		.replace(/"ms":\d+/g, `"ms":<MS>`)
		.replace(/_probe\/[0-9A-HJKMNP-TV-Z]{26}\.json/g, "_probe/<KEY>.json")
		// Only the storage view's own timestamp: lastSync.at is deterministic.
		.replace(/("lastWrite":\{"key":"entries\.json","at":")[^"]*(")/g, "$1<AT>$2")
		// Go's net error names the socket; Node's names the system call.
		.replace(/(Get \\"[^"]*\\": )[^"\\]*/g, "$1<ERR>");
	return out;
}

describe("the Go admin transcript", () => {
	it("answers all of its requests byte for byte, endpoint calls included (TestAdminTranscriptIsTheGoBytes)", async () => {
		const llm = await startFakeLLM();
		// The guide's bytes are Go's: the fixture's own answer is what this side serves.
		const guide = new TextEncoder().encode(fixture.steps.find((s) => s.name === "guide")?.body ?? "");
		const rig = await startServer({
			store: createMemoryStore(),
			now: () => FIXED,
			settingsEnv: { ...DEFAULTS, baseUrl: `${llm.base}/v1`, apiKey: ENV_KEY, model: "env-model", streaming: false },
			telegramEnv: parseTelegramEnv("111=ZY, 222=Partner", "-1001234"),
			guide: async () => guide,
		});
		try {
			for (const want of fixture.steps) {
				const headers: Record<string, string> = { "X-Forwarded-Email": "zy@example.com" };
				for (const [name, value] of want.reqHeaders) headers[name] = value;
				const body = want.reqBody === "" ? undefined : want.reqBody.split("<LLM>").join(llm.base);
				const got = await rig.do(want.method, want.path.split("<LLM>").join(llm.base), body, headers);

				const wantHeaders: Record<string, string> = {};
				const gotHeaders: Record<string, string> = {};
				for (const name of COMPARED) {
					wantHeaders[name] =
						name === "content-type" ? normalise(want.headers[name] ?? "", null) : (want.headers[name] ?? "");
					gotHeaders[name] = normalise(headerOf(got.headers, name), llm.base);
				}

				// One assertion per request, so a failure names the step.
				expect([want.name, got.status]).toEqual([want.name, want.status]);
				expect([want.name, gotHeaders]).toEqual([want.name, wantHeaders]);
				expect([want.name, normalise(got.raw, llm.base)]).toEqual([want.name, normalise(want.body, null)]);
			}

			// Every request the fake endpoint received, in order: method, path, body
			// and the Authorization header (an empty one means none was sent).
			// The fixture's side is normalised already; this side masks its own origin
			// the same way (F16), so a difference in any part shows up.
			const seen = llm.calls.map((c) => ({
				method: normalise(c.method, llm.base),
				path: normalise(c.path, llm.base),
				body: normalise(c.body, llm.base),
				auth: normalise(c.auth, llm.base),
			}));
			expect(seen.map((c) => c.path)).toEqual(fixture.llmCalls.map((c) => c.path));
			expect(seen).toEqual(fixture.llmCalls);
		} finally {
			await llm.close();
			await rig.close();
		}
	}, 30_000);

	it("masks exactly the random parts and v2's two shapes, and nothing else", () => {
		// A guard on the masking itself: if a later change hides more, this fails.
		const view = `{"vision":false,"claudeOrigin":"https://api.anthropic.com","kind":"openai","keyLast4":"7f3a"}`;
		expect(normalise(view, null)).toBe(`{"vision":false,"kind":"openai","keyLast4":"7f3a"}`);
		expect(normalise(`{"error":"kind must be openai or claude"}`, null)).toBe(`{"error":"kind must be openai"}`);
		expect(normalise(`{"ok":true,"latencyMs":42,"steps":[{"ms":7}]}`, null)).toBe(
			`{"ok":true,"latencyMs":<MS>,"steps":[{"ms":<MS>}]}`,
		);
		expect(normalise(probeKey("01M7ZKH1FKGGG489TF924V32B8"), null)).toBe(`"_probe/<KEY>.json"`);
		expect(normalise(`{"backend":"memory","lastWrite":${lastWrite("2026-11-21T17:47:36.81909001Z")}}`, null)).toBe(
			`{"backend":"memory","lastWrite":{"key":"entries.json","at":"<AT>"}}`,
		);
		expect(normalise(`{"error":"Get \\"http://h/v1/models\\": dial tcp 127.0.0.1:1: refused"}`, null)).toBe(
			`{"error":"Get \\"http://h/v1/models\\": <ERR>"}`,
		);
		// A deterministic body is left alone.
		expect(normalise(`{"models":["model-a","model-b"]}`, null)).toBe(`{"models":["model-a","model-b"]}`);
	});
});

/** A probe result's scratch key, as the body carries it. */
function probeKey(ulid: string): string {
	return `"_probe/${ulid}.json"`;
}

/** The storage view's lastWrite object. */
function lastWrite(at: string): string {
	return `{"key":"entries.json","at":"${at}"}`;
}
