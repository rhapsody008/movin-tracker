// The rig the server suites share: a real node:http server on an ephemeral port,
// with the in-memory entries service, the settings service, the two-file static
// map and the auth list the Go tests use (internal/server/server_test.go:100-198),
// plus the fake OpenAI-compatible endpoint their fakeLLM stubs.
//
// Requests go through node:http rather than fetch so a test sees the bytes as
// they are: no redirect following, no content decoding, and a request target can
// carry a bad escape (which fetch's URL parser would rewrite).

import { createServer as createNodeServer, type IncomingHttpHeaders, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Syncer } from "../docs/sync.ts";
import { createEntriesService, type EntriesService } from "../entries/service.ts";
import { createTestLog, type Log } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { type Checkin, parseCheckin } from "../settings/checkin.ts";
import { createSettingsService, DEFAULTS, type LLM, type SettingsService } from "../settings/settings.ts";
import { parseTelegramEnv, type Telegram } from "../settings/telegram.ts";
import type { TelegramStatusSource } from "./admin.ts";
import { createServer, type ServerDeps } from "./server.ts";
import type { StaticFile, StaticFiles } from "./static.ts";

/** The zone the Go tests set (TZ=Asia/Singapore). */
export const ZONE = "Asia/Singapore";

/** The email every request carries unless a test overrides it (e.go). */
export const ZY = "zy@example.com";
export const PARTNER = "partner@example.com";

/**
 * The Fernet key the rig generates: Go's tests call secret.Generate(), and this
 * is the published test vector from the fernet README (not a real secret). A
 * fixed one keeps a run repeatable; only keySet/keyLast4 reach the browser.
 */
export const TEST_SECRET = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=";

/** The Go tests' two fake keys (server_test.go:33-36). */
export const ENV_KEY = "sk-env-key-0000-aaaa";
export const STORED_KEY = "sk-drawer-secret-7f3a";

const encoder = new TextEncoder();

/** The two files Go's setup puts in its fstest.MapFS. */
export function testStaticFiles(): StaticFiles {
	const files = new Map<string, StaticFile>([
		[
			"index.html",
			{ body: encoder.encode("<!doctype html><title>Our new place</title>"), type: "text/html; charset=utf-8" },
		],
		["icon.svg", { body: encoder.encode("<svg/>"), type: "image/svg+xml" }],
	]);
	return { get: (name) => files.get(name) ?? null };
}

export interface Answer {
	status: number;
	headers: IncomingHttpHeaders;
	/** The body as text (the server only writes UTF-8). */
	raw: string;
	/** The body parsed as JSON, or {} when it is not JSON. */
	json: Record<string, unknown>;
}

export interface RigOptions {
	store?: ObjectStore;
	/** Server.SSEHeartbeat; the Go tests use 50 ms. */
	heartbeatMs?: number;
	devEmail?: string;
	docs?: Syncer | null;
	/** The clock the entries service uses; the transcript test pins it. */
	now?: () => Date;
	/** Wraps the entries service (the conflict and failure fakes). */
	entries?: (inner: EntriesService) => EntriesService;
	/** The settings service's env layer (LLM_* over DEFAULTS); no endpoint unless given. */
	settingsEnv?: LLM;
	/** TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS. */
	telegramEnv?: Telegram;
	/** CHECKIN_SCHEDULE / CHECKIN_CHAT. */
	checkinEnv?: Checkin;
	/** Replaces the settings service (nothing in T2.2 needs it; the store fakes do the work). */
	settings?: (inner: SettingsService) => SettingsService;
	/** Server.Guide; null is a build with no guide. */
	guide?: (() => Promise<Uint8Array>) | null;
	telegram?: TelegramStatusSource | null;
	/** Asks the scheduled check-in to run again after a settings save (T5.1c). */
	rearmCheckin?: (() => Promise<void>) | null;
	/** Replaces any other dependency before the server is built. */
	deps?: (deps: ServerDeps) => ServerDeps;
}

export interface ServerStream {
	status: number;
	headers: IncomingHttpHeaders;
	/** The next chunk of the body as text; rejects at the end of the stream. */
	next: () => Promise<string>;
	/** Ends the client's half, as a browser closing the tab does. */
	close: () => void;
}

export interface Rig {
	base: string;
	port: number;
	server: Server;
	entries: EntriesService;
	settings: SettingsService;
	store: ObjectStore;
	log: Log;
	/** Every log line, for the assertions on the warn/error lines. */
	lines: string[];
	/** e.do: one request with the developer's email unless overridden. */
	do: (method: string, path: string, body?: string, headers?: Record<string, string>) => Promise<Answer>;
	/** GET /api/events, headers included; the stream is read chunk by chunk. */
	open: (path: string, headers?: Record<string, string>) => Promise<ServerStream>;
	/** The server's own CloseStreams, for the shutdown test. */
	closeStreams: () => void;
	close: () => Promise<void>;
}

export async function startServer(o: RigOptions = {}): Promise<Rig> {
	const store = o.store ?? createMemoryStore();
	const { log, lines } = createTestLog();
	const made = createEntriesService({ store, log, timeZone: ZONE, now: o.now });
	await made.load();
	const entries = o.entries === undefined ? made : o.entries(made);

	// Go's setup always builds a settings service over the same store (server_test.go:104-118).
	const base = createSettingsService({
		store,
		log,
		env: { ...DEFAULTS, ...o.settingsEnv },
		telegramEnv: o.telegramEnv ?? parseTelegramEnv("", ""),
		checkinEnv: o.checkinEnv ?? parseCheckin("", ""),
		secret: TEST_SECRET,
		now: o.now,
	});
	const settings = o.settings === undefined ? base : o.settings(base);

	const deps: ServerDeps = {
		entries,
		docs: o.docs ?? null,
		settings,
		store,
		log,
		staticFiles: testStaticFiles(),
		authHeader: "X-Forwarded-Email",
		allowedEmails: [ZY, PARTNER],
		devEmail: o.devEmail ?? "",
		sseHeartbeatMs: o.heartbeatMs ?? 50,
		guide: o.guide ?? null,
		telegram: o.telegram ?? null,
		rearmCheckin: o.rearmCheckin ?? null,
	};
	const app = createServer(o.deps === undefined ? deps : o.deps(deps));

	const server = createNodeServer(app.handler);
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;

	const rig: Rig = {
		base: `http://127.0.0.1:${address.port}`,
		port: address.port,
		server,
		entries,
		settings,
		store,
		log,
		lines,
		do: async (method, path, body, headers) => {
			return await send(address.port, method, path, body, { "X-Forwarded-Email": ZY, ...headers });
		},
		open: async (path, headers) => await openStream(address.port, path, { "X-Forwarded-Email": ZY, ...headers }),
		closeStreams: app.closeStreams,
		close: async () => {
			app.closeStreams();
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
	return rig;
}

/** One request over a fresh connection; the body is sent as given, byte for byte. */
export async function send(
	port: number,
	method: string,
	path: string,
	body?: string,
	headers: Record<string, string> = {},
): Promise<Answer> {
	return await new Promise<Answer>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method, path, headers, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const raw = Buffer.concat(chunks).toString("utf8");
				resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, json: parseObject(raw) });
			});
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

function parseObject(raw: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(raw);
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	} catch {
		// Not JSON: the probes and the auth answers are plain text.
	}
	return {};
}

/** The first header's value, as a string; "" when absent. */
export function headerOf(headers: IncomingHttpHeaders, name: string): string {
	const value = headers[name.toLowerCase()];
	if (value === undefined) return "";
	return Array.isArray(value) ? (value[0] ?? "") : value;
}

async function openStream(port: number, path: string, headers: Record<string, string>): Promise<ServerStream> {
	return await new Promise<ServerStream>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method: "GET", path, headers, agent: false }, (res) => {
			const waiting: ((chunk: string) => void)[] = [];
			const chunks: string[] = [];
			let ended = false;
			let failed: Error | null = null;
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				const next = waiting.shift();
				if (next === undefined) chunks.push(chunk);
				else next(chunk);
			});
			const finish = (err: Error | null): void => {
				ended = true;
				failed = err;
				for (const next of waiting.splice(0)) next("");
			};
			res.on("end", () => {
				finish(null);
			});
			res.on("error", (err: Error) => {
				finish(err);
			});
			resolve({
				status: res.statusCode ?? 0,
				headers: res.headers,
				next: async () => {
					const chunk = chunks.shift();
					if (chunk !== undefined) return chunk;
					if (failed !== null) throw failed;
					if (ended) throw new Error("the stream ended");
					return await new Promise<string>((resolveNext, rejectNext) => {
						waiting.push((got) => {
							if (got === "" && failed !== null) rejectNext(failed);
							else if (got === "" && ended) rejectNext(new Error("the stream ended"));
							else resolveNext(got);
						});
					});
				},
				close: () => {
					req.destroy();
				},
			});
		});
		req.on("error", reject);
		req.end();
	});
}

/** One request the fake endpoint received, for the wire-format assertions. */
export interface FakeCall {
	method: string;
	/** The path only, no query string: what Go's fake records as r.URL.Path. */
	path: string;
	body: string;
	/** The Authorization header, or "" when the request carried none. */
	auth: string;
}

export interface FakeLLM {
	/** The origin to configure as LLM_BASE_URL; the app appends "/v1". */
	base: string;
	/** Every request the endpoint received, in order. */
	calls: FakeCall[];
	/** Every model a chat request named, in order (server_test.go's assertion). */
	models: string[];
	/** Simulates a model that ignores tools (Go's fakeLLM.noTools). */
	noTools: { value: boolean };
	close: () => Promise<void>;
}

/**
 * startFakeLLM is Go's fakeLLM (server_test.go:27-98): /v1/models answers
 * model-b then model-a (deliberately unsorted), and /v1/chat/completions
 * answers a set_dates tool call when the user's text says "move in" and plain
 * text otherwise. Everything under /bad/ is a 404 with an OpenAI-shaped error,
 * so the models 502 can be exercised without a dead network.
 */
export async function startFakeLLM(): Promise<FakeLLM> {
	const calls: FakeCall[] = [];
	const models: string[] = [];
	const noTools = { value: false };
	const server = createNodeServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const path = (req.url ?? "").split("?")[0] ?? "";
			calls.push({ method: req.method ?? "", path, body, auth: headerOf(req.headers, "authorization") });
			if (path === BAD_MODELS_PATH) {
				res.writeHead(404, { "Content-Type": "application/json" });
				res.end(`{"error":{"message":"Invalid API key"}}`);
				return;
			}
			if (path.endsWith("/v1/models")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(`{"data":[{"id":"model-b"},{"id":"model-a"}]}`);
				return;
			}
			if (path.endsWith("/v1/chat/completions")) {
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(completion(body, models, noTools.value)));
				return;
			}
			res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
			res.end("404 page not found\n");
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		calls,
		models,
		noTools,
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

/** The path whose models list answers 404, so a probe reports a 502 (Go's fake has no such path). */
export const BAD_MODELS_PATH = "/bad/v1/models";

/** The model that never calls a tool, so TestSettingsTestEndpoint can see that answer. */
export const NO_TOOLS_MODEL = "no-tools-model";

/** One chat completion answer, shaped like Go's fakeLLM.handle. */
function completion(body: string, models: string[], noTools: boolean): unknown {
	let asked: unknown;
	try {
		asked = JSON.parse(body);
	} catch {
		asked = null;
	}
	const req = typeof asked === "object" && asked !== null ? (asked as Record<string, unknown>) : {};
	const model = typeof req.model === "string" ? req.model : "";
	models.push(model);
	const messages = Array.isArray(req.messages) ? req.messages : [];
	const last: unknown = messages[messages.length - 1];
	const text = messageText(last);
	const wantsTool = text.includes("move in") && !noTools && model !== NO_TOOLS_MODEL && req.tool_choice !== "none";
	const message: Record<string, unknown> = { role: "assistant", content: wantsTool ? "" : "Nothing to change." };
	if (wantsTool) {
		message.tool_calls = [
			{
				id: "call_1",
				type: "function",
				function: { name: "set_dates", arguments: `{"move_in":"2026-12-05"}` },
			},
		];
	}
	return { choices: [{ message }] };
}

/** One message's text: a string, or the text parts of the image-shaped content. */
function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (typeof part !== "object" || part === null) return "";
			const text = (part as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.join(" ");
}
