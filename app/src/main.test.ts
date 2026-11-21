// The process wiring, tested end to end on the memory store: the two probes,
// the page served from app/static, a shutdown that ends an open SSE stream, and
// the healthcheck command's exit code. No clock, network or real bucket.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "./config.ts";
import { createTestLog } from "./log.ts";
import { run, startServe } from "./main.ts";
import { createMemoryStore } from "./objstore/memory.ts";
import { DEFAULT_STATIC_DIR } from "./server/static-disk.ts";

/** The config a test serves with: the defaults, and port 0 so the OS picks one. */
function testConfig(): Config {
	return { ...loadConfig({ S3_BUCKET: "test-bucket" }), listenAddr: "127.0.0.1:0" };
}

const indexHtml = readFileSync(join(DEFAULT_STATIC_DIR, "index.html"));

interface Stream {
	status: number;
	/** What has arrived so far. */
	text: () => string;
	/** Resolves when the server ends the stream. */
	ended: Promise<void>;
}

/** GET /api/events, read chunk by chunk (rig.ts does the same for the SSE suites). */
function openEvents(port: number): Promise<Stream> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				path: "/api/events",
				method: "GET",
				headers: { "X-Forwarded-Email": "zy@example.com" },
				agent: false,
			},
			(res) => {
				const chunks: string[] = [];
				const ended = new Promise<void>((done) => {
					res.on("end", () => done());
				});
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => chunks.push(chunk));
				resolve({ status: res.statusCode ?? 0, text: () => chunks.join(""), ended });
			},
		);
		req.on("error", reject);
		req.end();
	});
}

/** A port nothing listens on: bound once, then released. */
async function closedPort(): Promise<number> {
	const server = createNetServer();
	await new Promise<void>((done) => {
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	await new Promise<void>((done) => {
		server.close(() => done());
	});
	return port;
}

describe("startServe", () => {
	it("serves the probes and the page, and stop() ends an open SSE stream", async () => {
		const { log, lines } = createTestLog();
		const running = await startServe(testConfig(), { store: createMemoryStore(), log });
		try {
			const base = `http://127.0.0.1:${running.port}`;

			const healthz = await fetch(`${base}/healthz`);
			expect(healthz.status).toBe(200);
			expect(await healthz.text()).toBe("ok\n");

			const readyz = await fetch(`${base}/readyz`);
			expect(readyz.status).toBe(200);
			expect(await readyz.text()).toBe("ok\n");

			// GET / is app/static/index.html, byte for byte, and always revalidated.
			// The page is behind auth, so the request carries the proxy's header.
			const page = await fetch(`${base}/`, { headers: { "X-Forwarded-Email": "zy@example.com" } });
			expect(page.status).toBe(200);
			expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
			expect(page.headers.get("cache-control")).toBe("no-cache");
			const body = new Uint8Array(await page.arrayBuffer());
			expect(body.length).toBe(indexHtml.length);
			expect(Buffer.from(body).equals(indexHtml)).toBe(true);

			const icon = await fetch(`${base}/icon.svg`);
			expect(icon.headers.get("content-type")).toBe("image/svg+xml");
			// The documented difference from Go on alpine: Go sniffs text/plain.
			const manifest = await fetch(`${base}/manifest.webmanifest`);
			expect(manifest.headers.get("content-type")).toBe("application/manifest+json");

			// A stream is open when the signal comes: stop() must end it, not wait for it.
			const stream = await openEvents(running.port);
			expect(stream.status).toBe(200);
			for (let i = 0; i < 100 && !stream.text().includes("event: entries"); i++) {
				await new Promise((done) => setTimeout(done, 10));
			}
			expect(stream.text()).toContain("event: entries");

			await running.stop();
			await Promise.race([
				stream.ended,
				new Promise((_, fail) => {
					setTimeout(() => fail(new Error("the SSE stream outlived stop()")), 2000);
				}),
			]);

			// After the shutdown nothing accepts connections any more.
			await expect(fetch(`${base}/healthz`)).rejects.toThrow();
			expect(lines.join("\n")).toContain('"msg":"stopped"');
		} finally {
			await running.stop();
		}
	});
});

describe("startServe with docsOff", () => {
	it("writes no documents to the bucket and answers docs as switched off", async () => {
		const { log, lines } = createTestLog();
		const store = createMemoryStore();
		const running = await startServe({ ...testConfig(), docsOff: true }, { store, log });
		try {
			const base = `http://127.0.0.1:${running.port}`;
			const auth = { "X-Forwarded-Email": "zy@example.com" };
			const docs = await fetch(`${base}/api/docs`, { headers: auth });
			expect(docs.status).toBe(200);
			expect(await docs.text()).toBe('{"on":false,"running":false,"docs":[]}\n');
			const sync = await fetch(`${base}/api/docs/sync`, { method: "POST", headers: auth });
			expect(sync.status).toBe(404);
			// A startup sync would have written docs/index.json by now.
			await new Promise((done) => setTimeout(done, 200));
			// (entries.json is the entries service creating an empty board, as Go does.)
			const keys = (await store.list("")).map((o) => o.key);
			expect(keys).toEqual(["entries.json"]);
			expect(lines.join("\n")).toContain("documents are switched off");
		} finally {
			await running.stop();
		}
	});
});

describe("run", () => {
	it("healthcheck exits 0 against a listening server and 1 against a closed port", async () => {
		const { log } = createTestLog();
		const running = await startServe(testConfig(), { store: createMemoryStore(), log });
		try {
			expect(await run(["healthcheck"], { LISTEN_ADDR: `127.0.0.1:${running.port}` })).toBe(0);
		} finally {
			await running.stop();
		}
		expect(await run(["healthcheck"], { LISTEN_ADDR: `127.0.0.1:${await closedPort()}` })).toBe(1);
	});

	it("rejects an unknown command with exit code 1", async () => {
		expect(await run(["seed"], {})).toBe(1);
	});
});
