// The "Test connection" probe: the three calls, their wire bodies, and what
// decides `ok`. Ported from testSettings/probeVision (server.go:521-571) against
// Go's own fakeLLM shape, so the bodies can be asserted byte for byte.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { goMarshal } from "../gojson.ts";
import { startFakeLLM } from "../server/rig.ts";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import { encodeTestResult, NO_TOOL_CALLS, PROBE_PNG_BASE64, probe } from "./probe.ts";

function config(baseUrl: string, over: Partial<LLM> = {}): LLM {
	return { ...DEFAULTS, baseUrl, model: "model-a", apiKey: "sk-test-1111", timeoutSec: 5, ...over };
}

const CHAT_BODY =
	`{"model":"model-a","messages":[` +
	`{"role":"system","content":"You set dates on a board. Always use the tool."},` +
	`{"role":"user","content":"We move in on 2026-12-05."}],"tools":[` +
	`{"type":"function","function":{"name":"set_dates","description":"Set the move-in date (YYYY-MM-DD).",` +
	`"parameters":{"type":"object","properties":{"move_in":{"type":"string"}},"required":["move_in"]}}}]}`;

const THINK_KWARGS = `,"chat_template_kwargs":{"enable_thinking":false}`;

describe("probe", () => {
	it("lists the models, gets a tool call, and shows the model the pixel", async () => {
		const llm = await startFakeLLM();
		try {
			const res = await probe(config(`${llm.base}/v1`));
			expect(res.ok).toBe(true);
			expect(res.toolCalls).toBe(true);
			expect(res.vision).toBe(true);
			expect(res.models).toEqual(["model-b", "model-a"].sort());
			expect(res.modelsError).toBeUndefined();
			expect(res.error).toBeUndefined();
			expect(res.latencyMs).toBeGreaterThanOrEqual(0);

			// Three calls, in Go's order: the list, the tool question, the image.
			expect(llm.calls.map((c) => c.path)).toEqual(["/v1/models", "/v1/chat/completions", "/v1/chat/completions"]);
			// The body has Go's field order, and no stream field (the probe never streams).
			expect(llm.calls[1]?.body).toBe(CHAT_BODY);
			// An off connection sends no chat_template_kwargs at all.
			expect(llm.calls[1]?.body.includes("chat_template_kwargs")).toBe(false);
			// The image call carries the pixel as a data URL, and no tools.
			expect(llm.calls[2]?.body).toBe(
				`{"model":"model-a","messages":[{"role":"user","content":[` +
					`{"type":"text","text":"Reply with one word: what colour is this square?"},` +
					`{"type":"image_url","image_url":{"url":"data:image/png;base64,${PROBE_PNG_BASE64}"}}]}]}`,
			);
			expect(llm.calls[2]?.body.includes("tools")).toBe(false);
			// The model name the endpoint saw is the one the drawer named.
			expect(llm.models).toEqual(["model-a", "model-a"]);
		} finally {
			await llm.close();
		}
	});

	it("fails the probe when the endpoint answers without tool_calls, and sends no image", async () => {
		const llm = await startFakeLLM();
		try {
			llm.noTools.value = true;
			const res = await probe(config(`${llm.base}/v1`));
			expect([res.ok, res.toolCalls, res.vision]).toEqual([false, false, false]);
			expect(res.error).toBe(NO_TOOL_CALLS);
			// Two calls: no image probe without tool calling.
			expect(llm.calls.map((c) => c.path)).toEqual(["/v1/models", "/v1/chat/completions"]);
		} finally {
			await llm.close();
		}
	});

	it("sends chat_template_kwargs when thinking is on demand, before and after the tool call", async () => {
		const llm = await startFakeLLM();
		try {
			const res = await probe(config(`${llm.base}/v1`, { thinkOnDemand: true }));
			expect(res.ok).toBe(true);
			expect(llm.calls[1]?.body).toBe(`${CHAT_BODY.slice(0, -1)}${THINK_KWARGS}}`);
			expect(llm.calls[2]?.body.endsWith(`${THINK_KWARGS}}`)).toBe(true);
		} finally {
			await llm.close();
		}
	});

	it("keeps going when only the model list fails, and reports why", async () => {
		const stub = await modelsFailOnly();
		try {
			const res = await probe(config(`${stub.base}/v1`));
			expect(res.ok).toBe(true);
			expect(res.models).toBeUndefined();
			expect(res.modelsError).toBe("endpoint returned 500: no models today");
		} finally {
			await stub.close();
		}
	});

	it("reports a dead endpoint as ok false with Go's Get text, and never throws", async () => {
		const stub = await modelsFailOnly();
		const base = stub.base;
		await stub.close();
		const res = await probe(config(`${base}/v1`));
		expect([res.ok, res.toolCalls, res.vision]).toEqual([false, false, false]);
		expect(res.modelsError?.startsWith(`Get "${base}/v1/models": `)).toBe(true);
		// F2: a POST's network error is `Post "…"`, as Go's urlErrorOp names it.
		expect(res.error?.startsWith(`Post "${base}/v1/chat/completions": `)).toBe(true);
		expect(res.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("keeps every part of an unparseable answer out of the result (F1)", async () => {
		const key = "sk-live-1234567890abcdef";
		for (const body of [key, `{"a": ${key}`]) {
			const stub = await fixedBody(body);
			try {
				const res = await probe(config(`${stub.base}/v1`, { apiKey: key }));
				expect([res.ok, res.error]).toEqual([false, "decode completion: invalid JSON"]);
				expect([res.modelsError?.includes(key), res.error?.includes(key)]).toEqual([false, false]);
			} finally {
				await stub.close();
			}
		}
	});

	it("writes no models key when the endpoint lists none (F4)", async () => {
		const stub = await noModels();
		try {
			const res = await probe(config(`${stub.base}/v1`));
			expect([res.ok, res.models]).toEqual([true, []]);
			// Go's omitempty: no `models` key at all, not "models":[].
			expect(goMarshal(encodeTestResult(res)).includes('"models"')).toBe(false);
		} finally {
			await stub.close();
		}
	});

	it("encodes testResult in Go struct order and leaves the empty optional fields out", () => {
		expect(goMarshal(encodeTestResult({ ok: true, latencyMs: 12, toolCalls: true, models: ["a"], vision: true }))).toBe(
			`{"ok":true,"latencyMs":12,"toolCalls":true,"models":["a"],"vision":true}`,
		);
		expect(
			goMarshal(
				encodeTestResult({ ok: false, latencyMs: 3, toolCalls: false, modelsError: "boom", vision: false, error: "x" }),
			),
		).toBe(`{"ok":false,"latencyMs":3,"toolCalls":false,"modelsError":"boom","vision":false,"error":"x"}`);
		// omitempty on the list and on both strings, as Go reads it.
		expect(
			goMarshal(
				encodeTestResult({
					ok: true,
					latencyMs: 1,
					toolCalls: true,
					models: [],
					modelsError: "",
					vision: true,
					error: "",
				}),
			),
		).toBe(`{"ok":true,"latencyMs":1,"toolCalls":true,"vision":true}`);
	});
});

interface Stub {
	base: string;
	close: () => Promise<void>;
}

/** A stub that answers every request with one fixed body, 200. */
async function fixedBody(body: string): Promise<Stub> {
	return await stubFor(() => ({ status: 200, body }));
}

/** A stub with an empty model list and a tool-calling chat answer. */
async function noModels(): Promise<Stub> {
	return await stubFor((path) => {
		if (path.endsWith("/models")) return { status: 200, body: `{"data":[]}` };
		return { status: 200, body: `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c"}]}}]}` };
	});
}

/** stubFor starts a local endpoint whose answers come from `answer`. */
async function stubFor(answer: (path: string) => { status: number; body: string }): Promise<Stub> {
	const server: Server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			const { status, body } = answer(path);
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(body);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
}

/** A stub whose model list fails and whose chat answers a tool call: the probe half-works. */
async function modelsFailOnly(): Promise<Stub> {
	const server: Server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			if (path.endsWith("/models")) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(`{"error":{"message":"no models today"}}`);
				return;
			}
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(`{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c","type":"function"}]}}]}`);
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
}
