// The body-reading helpers every API route shares: Go's case-insensitive field
// lookup (F15) and the 400 an oversize body gets (F18). The rest of http.ts is
// covered through the routes in server.test.ts and the transcripts.
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { fieldOf, jsonBool, jsonString, jsonStrings, MAX_BODY_BYTES } from "./http.ts";
import { startServer, ZY } from "./rig.ts";

describe("a struct field's case-insensitive lookup (F15)", () => {
	// Go's own answers for these bodies are in app/golden/t2x/main.go: encoding/json
	// folds the case, and the LAST matching key in the document wins.
	it("matches a folded key and lets the last one win", () => {
		expect(jsonString({ apikey: "a", APIKEY: "b" }, "apiKey")).toBe("b");
		expect(jsonString({ APIKEY: "b", apikey: "a" }, "apiKey")).toBe("a");
		// An exact match does not win: position does.
		expect(jsonString({ apiKey: "exact", APIKEY: "folded" }, "apiKey")).toBe("folded");
		expect(jsonString({ APIKEY: "folded", apiKey: "exact" }, "apiKey")).toBe("exact");
		expect(jsonString({ ApiKey: "mixed" }, "apiKey")).toBe("mixed");
	});

	it("keeps Go's zero values for a missing key, a null and an empty object", () => {
		expect(jsonString({}, "apiKey")).toBe("");
		expect(jsonString({ apiKey: null }, "apiKey")).toBe("");
		expect(jsonBool({ USEENV: true }, "useEnv")).toBe(true);
		expect(jsonBool({}, "useEnv")).toBe(false);
		expect(jsonStrings({ USERS: ["a"] }, "users")).toEqual(["a"]);
		expect(jsonStrings({}, "users")).toEqual([]);
	});

	it("reports the field the caller asked for, not the key the body used", () => {
		expect(() => jsonString({ APIKEY: 5 }, "apiKey")).toThrow("apiKey must be a string");
		expect(() => jsonBool({ USEENV: "yes" }, "useEnv")).toThrow("useEnv must be true or false");
	});

	it("tells presence from absence", () => {
		expect(fieldOf({ SchEdUlE: "8:05" }, "schedule")).toEqual({ found: true, value: "8:05" });
		expect(fieldOf({}, "schedule")).toEqual({ found: false, value: undefined });
	});
});

describe("an oversize body (F18)", () => {
	it("answers 400 with Connection: close without waiting for the rest", async () => {
		const rig = await startServer();
		const req = request({
			host: "127.0.0.1",
			port: rig.port,
			method: "POST",
			path: "/api/entries",
			headers: { "X-Forwarded-Email": ZY, "Content-Type": "application/json" },
			agent: false,
		});
		try {
			const got = await new Promise<{ status: number; connection: string; raw: string }>((resolve, reject) => {
				req.on("response", (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						resolve({
							status: res.statusCode ?? 0,
							connection: String(res.headers.connection ?? ""),
							raw: Buffer.concat(chunks).toString("utf8"),
						});
					});
				});
				// A request that is never ended: the server must answer on the cap
				// alone, not after the client finishes (which would be draining).
				req.on("error", reject);
				req.write(Buffer.alloc(MAX_BODY_BYTES + 1, "a"));
			});
			expect(got.status).toBe(400);
			expect(got.raw).toBe(`{"error":"Request body must be JSON: http: request body too large"}\n`);
			expect(got.connection).toBe("close");
		} finally {
			// The server hung up on us; nothing more is expected of this socket.
			req.on("error", () => undefined);
			req.destroy();
			await rig.close();
		}
	});
});
