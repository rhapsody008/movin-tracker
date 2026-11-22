// A fake OpenAI-compatible endpoint, test-only, reused by T3.2-T3.6: it records
// every request and answers from a script, in the modes the LLM layer has to
// survive. Port of the shape of the tests' httptest servers (internal/llm/
// openai_test.go, images_test.go) on node:http, plus the failures Go's tests
// never needed: a mid-stream error and a socket destroyed mid-answer.
//
// Nothing here reaches beyond loopback and no test starts it twice.

import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** Token counts as the wire reports them. */
export interface StubUsage {
	prompt: number;
	completion: number;
	cached?: number;
}

/** One tool call the stub streams back, its arguments split into fragments. */
export interface StubToolCall {
	name: string;
	arguments: string;
	id?: string;
}

/** One scripted answer. */
export type StubAnswer =
	| { kind: "text"; text: string; finish?: string; usage?: StubUsage }
	| { kind: "toolCalls"; calls: readonly StubToolCall[]; text?: string; usage?: StubUsage }
	| { kind: "json"; body: unknown }
	| { kind: "error"; status: number; message: string }
	| { kind: "midStreamError"; message: string; text?: string }
	| { kind: "destroy"; text?: string }
	/** Never answers, so the caller's own timeout is the only way out. */
	| { kind: "hang" };

/** One request as it arrived. */
export interface StubRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
	/** The JSON body; {} when it was not a JSON object. */
	body: Record<string, unknown>;
	raw: string;
}

export interface Stub {
	/** The origin; the app's base URL is `${origin}/v1`. */
	origin: string;
	requests: StubRequest[];
	/** Replace the script: one answer per request, the last repeating when it runs out. */
	answer: (...answers: StubAnswer[]) => void;
	close: () => Promise<void>;
}

/**
 * startStub serves one fake endpoint. Port 0 (the default) lets the OS pick;
 * a fixed port is for a caller that has to put the URL in the environment first
 * (tools/llm-check.ts against the stub).
 */
export async function startStub(o: { port?: number } = {}): Promise<Stub> {
	const requests: StubRequest[] = [];
	let script: StubAnswer[] = [{ kind: "text", text: "ok" }];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			requests.push({
				method: req.method ?? "",
				path: (req.url ?? "").split("?")[0] ?? "",
				headers: req.headers,
				body: jsonObject(raw),
				raw,
			});
			const next = script.length > 1 ? script.shift() : script[0];
			reply(res, next ?? { kind: "text", text: "ok" });
		});
	});
	await new Promise<void>((done) => {
		server.listen(o.port ?? 0, "127.0.0.1", done);
	});
	const address = server.address() as AddressInfo;
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		answer: (...answers) => {
			script = [...answers];
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((done) => {
				server.close(() => {
					done();
				});
			});
		},
	};
}

/** reply writes one scripted answer. */
function reply(res: ServerResponse, a: StubAnswer): void {
	switch (a.kind) {
		case "text": {
			const events: unknown[] = [];
			// Two deltas, so a caller that drops a fragment is caught.
			const split = Math.floor(a.text.length / 2);
			if (a.text !== "") {
				events.push({ choices: [{ delta: { role: "assistant", content: a.text.slice(0, split) } }] });
				events.push({ choices: [{ delta: { content: a.text.slice(split) } }] });
			}
			events.push({ choices: [{ delta: {}, finish_reason: a.finish ?? "stop" }] });
			if (a.usage !== undefined) events.push({ choices: [], usage: usageChunk(a.usage) });
			events.push("[DONE]");
			sse(res, events);
			return;
		}
		case "toolCalls": {
			const events: unknown[] = [];
			if (a.text !== undefined && a.text !== "") {
				events.push({ choices: [{ delta: { role: "assistant", content: a.text } }] });
			}
			a.calls.forEach((call, index) => {
				const split = Math.floor(call.arguments.length / 2);
				events.push({
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index,
										id: call.id ?? `call_${index}`,
										type: "function",
										function: { name: call.name, arguments: call.arguments.slice(0, split) },
									},
								],
							},
						},
					],
				});
				events.push({
					choices: [{ delta: { tool_calls: [{ index, function: { arguments: call.arguments.slice(split) } }] } }],
				});
			});
			events.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
			if (a.usage !== undefined) events.push({ choices: [], usage: usageChunk(a.usage) });
			events.push("[DONE]");
			sse(res, events);
			return;
		}
		case "json":
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(a.body));
			return;
		case "error":
			res.writeHead(a.status, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: a.message, type: "stub" } }));
			return;
		case "midStreamError":
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (a.text !== undefined && a.text !== "") {
				res.write(textEvent({ choices: [{ delta: { content: a.text } }] }));
			}
			res.write(textEvent({ error: { message: a.message } }));
			res.end();
			return;
		case "destroy":
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (a.text !== undefined && a.text !== "") {
				res.write(textEvent({ choices: [{ delta: { content: a.text } }] }));
			}
			// The socket goes away mid-answer, which pi-ai reports as a transport drop.
			setTimeout(() => res.socket?.destroy(), 10);
			return;
		case "hang":
			// The request stays open until the client gives up or the stub closes.
			return;
	}
}

/** sse writes events as server-sent events; a string is already a payload. */
function sse(res: ServerResponse, events: readonly unknown[]): void {
	res.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of events) res.write(textEvent(event));
	res.end();
}

/** textEvent is one `data:` line. */
function textEvent(event: unknown): string {
	return `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
}

/** usageChunk is the OpenAI usage shape, which pi-ai reads into Usage. */
function usageChunk(usage: StubUsage): Record<string, unknown> {
	return {
		prompt_tokens: usage.prompt,
		completion_tokens: usage.completion,
		...(usage.cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: usage.cached } }),
	};
}

/** jsonObject parses a request body, keeping {} for anything that is not an object. */
function jsonObject(raw: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return {};
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
