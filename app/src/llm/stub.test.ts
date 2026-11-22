// The fake endpoint every LLM test runs against: it records what arrived and
// answers from a script, one answer per request and the last one repeating. The
// modes are the ones the tests above and T3.2-T3.6 need, so each is pinned here
// once instead of being assumed.
import { describe, expect, it } from "vitest";
import { startStub } from "./stub.ts";

/** post is one request to the stub, with a JSON body, and the raw answer text. */
async function post(origin: string, body: unknown = { hello: true }): Promise<{ status: number; text: string }> {
	const res = await fetch(`${origin}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: "Bearer sk-1" },
		body: JSON.stringify(body),
	});
	return { status: res.status, text: await res.text() };
}

describe("startStub", () => {
	it("records the method, the path, the headers and the JSON body of every request", async () => {
		const stub = await startStub();
		try {
			await post(stub.origin);
			const only = stub.requests[0];
			expect(only?.method).toBe("POST");
			expect(only?.path).toBe("/v1/chat/completions");
			expect(only?.headers.authorization).toBe("Bearer sk-1");
			expect(only?.body).toEqual({ hello: true });
			expect(only?.raw).toBe('{"hello":true}');
		} finally {
			await stub.close();
		}
	});

	it("answers plain JSON when the script says so", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "json", body: { choices: [{ message: { content: "hi" } }] } });
			const res = await post(stub.origin);
			expect(res.status).toBe(200);
			expect(JSON.parse(res.text)).toEqual({ choices: [{ message: { content: "hi" } }] });
		} finally {
			await stub.close();
		}
	});

	it("streams text deltas, a usage chunk and [DONE]", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "text", text: "Hello there", usage: { prompt: 3, completion: 2, cached: 1 } });
			const res = await post(stub.origin);
			// "Hello there" goes out in two deltas, split at the half.
			expect(res.text).toContain(`data: {"choices":[{"delta":{"role":"assistant","content":"Hello"}}]}`);
			expect(res.text).toContain(`data: {"choices":[{"delta":{"content":" there"}}]}`);
			expect(res.text).toContain(`data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2`);
			expect(res.text.trimEnd().endsWith("data: [DONE]")).toBe(true);
		} finally {
			await stub.close();
		}
	});

	it("answers an error status with an OpenAI-shaped body", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "error", status: 429, message: "slow down" });
			const res = await post(stub.origin);
			expect(res.status).toBe(429);
			expect(JSON.parse(res.text)).toEqual({ error: { message: "slow down", type: "stub" } });
		} finally {
			await stub.close();
		}
	});

	it("keeps the last answer of a script for every later request", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "error", status: 401, message: "no" }, { kind: "text", text: "ok" });
			expect((await post(stub.origin)).status).toBe(401);
			expect((await post(stub.origin)).status).toBe(200);
			expect((await post(stub.origin)).status).toBe(200);
			expect(stub.requests).toHaveLength(3);
		} finally {
			await stub.close();
		}
	});

	it("keeps a hanging request open, so a caller's own timeout is the only way out", async () => {
		const stub = await startStub();
		try {
			stub.answer({ kind: "hang" });
			const pending = post(stub.origin);
			const raced = await Promise.race([pending.then(() => "answered"), sleep(100).then(() => "still open")]);
			expect(raced).toBe("still open");
		} finally {
			await stub.close();
		}
	});
});

/** sleep waits a moment, for the race above. */
function sleep(ms: number): Promise<void> {
	return new Promise((done) => {
		setTimeout(done, ms);
	});
}
