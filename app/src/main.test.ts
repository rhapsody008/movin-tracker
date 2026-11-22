// The process wiring, tested end to end on the memory store: the two probes,
// the page served from app/static, a shutdown that ends an open SSE stream, and
// the healthcheck command's exit code. No clock, network or real bucket.
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "./config.ts";
import { createStartGuard } from "./durable/startguard.ts";
import { createTestLog } from "./log.ts";
import { exitIfFailed, harnessDbPath, openDurableAgent, run, startServe } from "./main.ts";
import { createMemoryStore } from "./objstore/memory.ts";
import { DEFAULT_STATIC_DIR } from "./server/static-disk.ts";

/** The config a test serves with: the defaults, and port 0 so the OS picks one. */
function testConfig(): Config {
	// MOVIN_INSTANCE is required by serve() (T5.3a), so every config a test builds
	// names one; the instance only matters to the S3 start counter.
	return {
		...loadConfig({ S3_BUCKET: "test-bucket", MOVIN_INSTANCE: "dev" }),
		listenAddr: "127.0.0.1:0",
	};
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

/** connects resolves when something accepts a connection on the port. */
function connects(port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve();
		});
		socket.once("error", reject);
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

describe("the durable agent", () => {
	it("opens the harness on the data volume and closes with the session", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "movin-main-data-"));
		const config = { ...testConfig(), dataDir };
		const { log } = createTestLog();
		const running = await startServe(config, { store: createMemoryStore(), log });
		try {
			expect(harnessDbPath(dataDir)).toBe(join(dataDir, "harness.db"));
			const agent = await openDurableAgent(config, running.settings, running.log, running.agentDeps);
			try {
				// The database is on the volume, with a session document created with it.
				expect(existsSync(harnessDbPath(dataDir))).toBe(true);
				expect(agent.epoch).toMatch(/^[0-9a-f-]{36}$/);
			} finally {
				await agent.close();
			}
			expect(await agent.closed).toEqual({ kind: "closed" });
		} finally {
			await running.stop();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("exits 1 and closes the server when the harness cannot open", { timeout: 20_000 }, async () => {
		const port = await closedPort();
		const deadS3 = await closedPort();
		const code = await run(["serve"], {
			S3_BUCKET: "test-bucket",
			MOVIN_INSTANCE: "dev",
			// An endpoint that refuses at once, so the startup read fails fast.
			S3_ENDPOINT_URL: `http://127.0.0.1:${deadS3}`,
			LISTEN_ADDR: `127.0.0.1:${port}`,
			// A path that cannot be a directory on any POSIX host (mkdir: ENOTDIR).
			DATA_DIR: "/dev/null/not-a-directory",
			MOVIN_DOCS: "off",
		});
		expect(code).toBe(1);
		// serve() stopped the server before the error: nothing answers on its port.
		await expect(connects(port)).rejects.toThrow();
	});

	// T5.3a: no default for the instance, so prod can never read dev's counter.
	it("exits 1 without MOVIN_INSTANCE, before anything listens", { timeout: 20_000 }, async () => {
		const port = await closedPort();
		const code = await run(["serve"], {
			S3_BUCKET: "test-bucket",
			LISTEN_ADDR: `127.0.0.1:${port}`,
			MOVIN_DOCS: "off",
		});
		expect(code).toBe(1);
		await expect(connects(port)).rejects.toThrow();
	});

	// T5.3a: serve hands the guard in, and the guard logs the start it decided on.
	it("opens with the restore guard and logs the start", { timeout: 20_000 }, async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "movin-main-guard-"));
		const config = { ...testConfig(), dataDir };
		const { log, lines } = createTestLog();
		const store = createMemoryStore();
		const running = await startServe(config, { store, log });
		try {
			const agent = await openDurableAgent(
				config,
				running.settings,
				running.log,
				running.agentDeps,
				undefined,
				createStartGuard({ store, instance: config.instance, restoreId: "", log }),
			);
			try {
				const start = lines
					.map((line) => JSON.parse(line) as Record<string, unknown>)
					.filter((line) => line.msg === "harness start");
				// A first start: no restore, and the counter this database now carries.
				expect(start).toEqual([expect.objectContaining({ starts: 1, restore: "none" })]);
				expect(start[0]).not.toHaveProperty("tasksAborted");
			} finally {
				await agent.close();
			}
		} finally {
			await running.stop();
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	it("exits 1 when the harness's storage failed, and leaves the code alone on a close", () => {
		const codes: number[] = [];
		const exit = (code: number): void => {
			codes.push(code);
		};
		exitIfFailed({ kind: "closed" }, exit);
		exitIfFailed({ kind: "failed", error: new Error("the volume went away") }, exit);
		expect(codes).toEqual([1]);
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
