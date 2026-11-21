// The endpoint calls in src/llm/models.ts: the request Go sends, the sort order
// of the ids, and the two error forms (openai.go:46-131). Every case runs
// against a local stub, so nothing here touches the network.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ApiError, listModels, urlErrorOp } from "./models.ts";

interface Seen {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
}

interface Stub {
	/** The origin; callers append "/v1" as the app does. */
	base: string;
	seen: Seen[];
	close: () => Promise<void>;
}

/** serve answers every request from one function, recording what arrived. */
async function serve(answer: (seen: Seen) => { status: number; body: string }): Promise<Stub> {
	const seen: Seen[] = [];
	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const one: Seen = { method: req.method ?? "", path: (req.url ?? "").split("?")[0] ?? "", headers: req.headers };
			seen.push(one);
			const { status, body } = answer(one);
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
		seen,
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

function ok(data: unknown[]): { status: number; body: string } {
	return { status: 200, body: JSON.stringify({ data }) };
}

describe("listModels", () => {
	it("sends GET {baseUrl}/models with the key as a Bearer and sorts the ids by byte", async () => {
		const stub = await serve(() => ok([{ id: "model-b" }, { id: "model-a" }]));
		try {
			const ids = await listModels({ baseUrl: `${stub.base}/v1/`, apiKey: "sk-typed-1", timeoutMs: 5000 });
			expect(ids).toEqual(["model-a", "model-b"]);
			expect(stub.seen).toHaveLength(1);
			const only = stub.seen[0];
			expect([only?.method, only?.path]).toEqual(["GET", "/v1/models"]);
			expect(only?.headers.authorization).toBe("Bearer sk-typed-1");
			expect(only?.headers["content-type"]).toBe("application/json");
		} finally {
			await stub.close();
		}
	});

	it("sends no Authorization header at all for an empty key, not an empty Bearer", async () => {
		const stub = await serve(() => ok([]));
		try {
			await listModels({ baseUrl: `${stub.base}/v1`, apiKey: "", timeoutMs: 5000 });
			const only = stub.seen[0];
			// The header is absent, which is what keeps a stored key at its own origin.
			expect(only?.headers.authorization).toBeUndefined();
		} finally {
			await stub.close();
		}
	});

	it("answers endpoint returned {status}: {error.message} for a non-2xx answer", async () => {
		const stub = await serve(() => ({ status: 401, body: `{"error":{"message":"Invalid API key"}}` }));
		try {
			const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: "sk-test-1111", timeoutMs: 5000 }));
			expect(err).toBeInstanceOf(ApiError);
			expect(err.message).toBe("endpoint returned 401: Invalid API key");
		} finally {
			await stub.close();
		}
	});

	it("trims a plain-text error body and keeps it whole up to 300 characters", async () => {
		const stub = await serve(() => ({ status: 500, body: "  gateway fell over  \n" }));
		try {
			const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: "sk-test-1111", timeoutMs: 5000 }));
			expect(err.message).toBe("endpoint returned 500: gateway fell over");
		} finally {
			await stub.close();
		}
	});

	it("cuts a long error body at 300 bytes and adds an ellipsis", async () => {
		const long = "x".repeat(400);
		const stub = await serve(() => ({ status: 502, body: long }));
		try {
			const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: "sk-test-1111", timeoutMs: 5000 }));
			expect(err.message).toBe(`endpoint returned 502: ${"x".repeat(300)}…`);
		} finally {
			await stub.close();
		}
	});

	it("reads only the first 2000 bytes of a failing answer (io.LimitReader)", async () => {
		// 2500 spaces and then a word: trimmed to nothing when only 2000 bytes are read.
		const stub = await serve(() => ({ status: 503, body: `${" ".repeat(2500)}REAL` }));
		try {
			const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: "sk-test-1111", timeoutMs: 5000 }));
			expect(err.message).toBe("endpoint returned 503: ");
		} finally {
			await stub.close();
		}
	});

	it("removes the key from an error the endpoint echoes back", async () => {
		const stub = await serve(() => ({ status: 401, body: `{"error":{"message":"bad key sk-secret-123"}}` }));
		try {
			const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: "sk-secret-123", timeoutMs: 5000 }));
			expect(err.message).toBe("endpoint returned 401: bad key [redacted]");
		} finally {
			await stub.close();
		}
	});

	it('writes Get "<url>": <cause> for a dead endpoint', async () => {
		// A port nothing listens on: the same shape Go's net error has, without its middle.
		const stub = await serve(() => ok([]));
		const base = stub.base;
		await stub.close();
		const err = await errorOf(listModels({ baseUrl: `${base}/v1`, apiKey: "sk-test-1111", timeoutMs: 2000 }));
		expect(err.message.startsWith(`Get "${base}/v1/models": `)).toBe(true);
		expect(err.message.length).toBeGreaterThan(`Get "${base}/v1/models": `.length);
	});

	it("reports a body it cannot read as a decode error", async () => {
		const stub = await serve(() => ({ status: 200, body: `{"data":"not a list"}` }));
		try {
			const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: "sk-test-1111", timeoutMs: 5000 }));
			expect(err.message).toBe("decode models list: data must be a list");
		} finally {
			await stub.close();
		}
	});
	// F3: a missing or null list is Go's nil slice, which is no models, not an error.
	it("answers [] for a null body, and for no data at all, or a null data", async () => {
		// A top-level null: Go's decode into a struct is a no-op, so no models.
		for (const body of ["null", "{}", `{"data":null}`, `{"data":[]}`]) {
			const stub = await serve(() => ({ status: 200, body }));
			try {
				expect([body, await listModels({ baseUrl: `${stub.base}/v1`, apiKey: "", timeoutMs: 5000 })]).toEqual([
					body,
					[],
				]);
			} finally {
				await stub.close();
			}
		}
	});

	// F1: V8's JSON.parse message quotes its input, so a body that IS the key
	// would print it. The tail is fixed instead, and nothing of the key survives.
	it("names no part of a body it could not parse (F1)", async () => {
		const key = "sk-live-1234567890abcdef";
		for (const body of [key, `{"data": ${key}`]) {
			const stub = await serve(() => ({ status: 200, body }));
			try {
				const err = await errorOf(listModels({ baseUrl: `${stub.base}/v1`, apiKey: key, timeoutMs: 5000 }));
				expect([body, err.message]).toEqual([body, "decode models list: invalid JSON"]);
				expect([body, err.message.includes(key)]).toEqual([body, false]);
			} finally {
				await stub.close();
			}
		}
	});

	// F2: Go's urlErrorOp, from the Go probe in tmp/t2x-golden.
	it("names a network error's verb the way Go's urlErrorOp does (F2)", () => {
		expect(["GET", "POST", "PUT", "DELETE", ""].map(urlErrorOp)).toEqual(["Get", "Post", "Put", "Delete", "Get"]);
	});
});

/** errorOf is the rejection of one call, or a test failure when it answered. */
async function errorOf(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}
