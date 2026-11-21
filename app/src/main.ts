// The process: `serve` (the default) and `healthcheck`, ported from
// cmd/movin/main.go. The agent and the Telegram bot are later steps (T3, T4),
// so serve builds the store, the entries service, the settings service, the
// document syncer and the HTTP server, and nothing else.
//
// Startup order is Go's (server-spec §8.2), with one Node-only note: the listen
// uses explicit header/idle timeouts and switches off the two Node timeouts Go
// does not have, so an SSE stream or a long chat request is never cut. The
// document schedule starts only after the listener is up, so readiness and the
// page never wait for a sync.
//
// Shutdown is Go's too: stop the background jobs, end the SSE streams, close
// the listener, give in-flight requests 10 s, then cut the connections and warn.

import { readFile } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { type AddressInfo, isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Config, type Env, loadConfig } from "./config.ts";
import { createPoppler } from "./docs/convert/poppler.ts";
import { startDocsBackground } from "./docs/schedule.ts";
import { createSyncer } from "./docs/sync.ts";
import { createEntriesService } from "./entries/service.ts";
import { goQuote } from "./gostr.ts";
import { createLog, errorMessage, type Level, type Log } from "./log.ts";
import { createS3Store } from "./objstore/s3.ts";
import type { ObjectStore } from "./objstore/store.ts";
import { type Server as AppServer, createServer } from "./server/server.ts";
import type { StaticFiles } from "./server/static.ts";
import { createDiskStatic, DEFAULT_STATIC_DIR } from "./server/static-disk.ts";
import { createSettingsService } from "./settings/settings.ts";

/** A shutdown's budget before the connections are cut (Go's 10 s, main.go:157). */
export const SHUTDOWN_BUDGET_MS = 10_000;

/** healthcheck's client timeout (main.go:214). */
export const HEALTH_TIMEOUT_MS = 3_000;

/** What a test replaces. Everything else is built from the config, as serve() builds it. */
export interface ServeDeps {
	log?: Log;
	store?: ObjectStore;
	/** The clock the entries service and the document schedule read. */
	now?: () => Date;
	/** The page's files; the default reads app/static, or STATIC_DIR when it is set. */
	staticFiles?: StaticFiles;
	/** Server.Guide; null (the default) is a build with no guide, as Go's nil Guide. */
	guide?: (() => Promise<Uint8Array>) | null;
}

export interface Running {
	/** The address listened on, with the port the OS picked filled in. */
	address: string;
	port: number;
	/** Stops the background jobs, ends the streams and closes the listener. Idempotent. */
	stop: () => Promise<void>;
}

/**
 * guideReader is GET /api/admin/guide's bytes: the file named by GUIDE_FILE
 * (the repo's docs/admin-guide.md by default) read on every request, which is
 * Go's dev path (main.go:110-116), so an edit shows up without a restart. A
 * missing file is the route's 500.
 */
export function guideReader(path: string): () => Promise<Uint8Array> {
	return async () => new Uint8Array(await readFile(path));
}

const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

/**
 * logLevel maps LOG_LEVEL to the logger's levels. An unknown value reads as
 * info, which is what Go does: main.go:73-77 ignores UnmarshalText's error and
 * keeps slog's zero level, info.
 */
function logLevel(name: string): Level {
	const v = name.trim().toLowerCase();
	return LEVELS.find((level) => level === v) ?? "info";
}

/** startServe builds what serve() builds, listens, and hands back the way to stop. */
export async function startServe(config: Config, deps: ServeDeps = {}): Promise<Running> {
	const log = deps.log ?? createLog({ level: logLevel(config.logLevel) });
	const now = deps.now ?? ((): Date => new Date());
	const store =
		deps.store ??
		createS3Store({
			bucket: config.s3Bucket,
			prefix: config.s3Prefix,
			region: config.awsRegion,
			endpointUrl: config.s3EndpointUrl,
		});

	// The entries: one initial read whose failure only means /readyz reports it
	// and the first page load retries (main.go:90-94), then a poll for the other
	// replica's writes.
	const entries = createEntriesService({ store, log, timeZone: config.timeZone, now });
	try {
		await entries.load();
	} catch (err) {
		log.error("initial entries load failed", { err: errorMessage(err) });
	}
	const stopPolling = entries.startPolling(config.pollEveryMs);

	const settings = createSettingsService({
		store,
		log,
		env: config.llm,
		telegramEnv: config.telegram,
		checkinEnv: config.checkin,
		secret: config.settingsSecret,
		now,
	});
	if (config.settingsSecret === "") {
		log.warn("SETTINGS_SECRET is not set; the settings drawer cannot store an API key");
	}
	if (config.allowedEmails.length === 0) {
		log.warn("ALLOWED_EMAILS is empty; every user the proxy lets through can use the web page");
	}

	// Documents: one converter shared by the syncs, so a big render can't stack
	// up. No summariser yet: T3.1 plugs the LLM one in, and an empty summary is
	// what Go writes with none configured.
	const syncer = config.docsOff ? null : createSyncer({ store, converter: createPoppler(), log, now });
	if (syncer === null) log.warn("documents are switched off (MOVIN_DOCS=off)");

	const staticFiles =
		deps.staticFiles ?? createDiskStatic(config.staticDir === "" ? DEFAULT_STATIC_DIR : config.staticDir);
	const app: AppServer = createServer({
		entries,
		docs: syncer,
		settings,
		store,
		log,
		staticFiles,
		authHeader: config.authHeader,
		allowedEmails: config.allowedEmails,
		devEmail: config.devEmail,
		guide: deps.guide ?? null,
		telegram: null,
	});

	// The options come first and the request listener second: `handler` is not an
	// option, and passing it there silently serves nothing at all.
	const httpServer = createHTTPServer(
		{
			// Node checks request and header timeouts only on this interval (default
			// 30 s), so the 10 s headersTimeout set below would fire up to three
			// times late. 1 s makes "headers not in by 10 s" true to within a second.
			connectionsCheckingInterval: 1_000,
		},
		app.handler,
	);
	// Go sets two of these (main.go:144-150): a 10 s read header timeout and a
	// 120 s idle timeout, and deliberately no write timeout because the SSE
	// streams stay open. Node's defaults are different — requestTimeout 300 s
	// would end a long chat request, timeout 0 means no socket timeout — so both
	// are set explicitly: 0 is "no timeout", as in Go.
	httpServer.headersTimeout = 10_000;
	httpServer.keepAliveTimeout = 120_000;
	httpServer.requestTimeout = 0;
	httpServer.timeout = 0;

	const target = listenAddress(config.listenAddr);
	await new Promise<void>((done, fail) => {
		httpServer.once("error", fail);
		httpServer.listen(target, () => {
			httpServer.off("error", fail);
			done();
		});
	});
	const bound = (httpServer.address() as AddressInfo).port;
	const address = `${hostPart(config.listenAddr)}:${bound}`;
	if (!loopback(config.listenAddr)) {
		log.warn(
			`listening beyond loopback; the app trusts ${config.authHeader}, so only the auth proxy may be able to reach this port`,
			{ addr: address },
		);
	}
	log.info("listening", {
		addr: address,
		bucket: config.s3Bucket,
		prefix: config.s3Prefix,
		authHeader: config.authHeader,
		devEmail: config.devEmail !== "",
	});

	// Only now do the background jobs start (main.go:172-182): the startup sync,
	// the minute refresh and the daily one.
	const stopDocs =
		syncer === null
			? (): void => undefined
			: startDocsBackground({
					syncer,
					schedule: config.docsSync,
					timeZone: config.timeZone,
					log,
					now,
				});

	let stopping: Promise<void> | null = null;

	async function shutdown(): Promise<void> {
		stopDocs();
		stopPolling();
		// The streams first: an SSE response never ends by itself, so server.close
		// would wait for the whole budget (Go's RegisterOnShutdown, main.go:154).
		app.closeStreams();
		const closed = new Promise<void>((done) => {
			httpServer.close(() => done());
		});
		let timer: ReturnType<typeof setTimeout> | null = null;
		const budget = new Promise<void>((done) => {
			timer = setTimeout(() => {
				log.warn("HTTP shutdown did not finish cleanly", { err: "context deadline exceeded" });
				httpServer.closeAllConnections();
				done();
			}, SHUTDOWN_BUDGET_MS);
		});
		await Promise.race([closed, budget]);
		if (timer !== null) clearTimeout(timer);
		log.info("stopped");
	}

	return {
		address,
		port: bound,
		stop: () => {
			stopping ??= shutdown();
			return stopping;
		},
	};
}

/** serve is `movin`: the same build, then wait for SIGINT or SIGTERM. */
async function serve(env: Env): Promise<void> {
	const config = loadConfig(env);
	const running = await startServe(config, { guide: guideReader(config.guideFile) });
	await new Promise<void>((done) => {
		// One shutdown, whoever asks: both signals can arrive, and stop() is idempotent.
		const onSignal = (): void => {
			void running.stop().then(done);
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
}

/**
 * healthcheck is the Docker HEALTHCHECK and the k8s liveness exec (main.go:207-224):
 * GET http://<LISTEN_ADDR>/healthz, 3 s, and only a 200 passes. ":8080" means
 * 127.0.0.1:8080, as Go rewrites it.
 */
export async function healthcheck(env: Env): Promise<void> {
	let addr = env.LISTEN_ADDR ?? "";
	if (addr === "") addr = ":8080";
	if (addr.startsWith(":")) addr = `127.0.0.1${addr}`;
	let res: Response;
	try {
		res = await fetch(`http://${addr}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
	} catch (err) {
		// Node's fetch says "fetch failed"; the dial error is the cause, as Go's
		// error text is the dial error.
		const cause = err instanceof Error && err.cause !== undefined ? err.cause : err;
		throw new Error(`healthz: ${errorMessage(cause)}`, { cause: err });
	}
	await res.text();
	if (res.status !== 200) throw new Error(`healthz returned ${res.status}`);
}

/** The argv commands (main.go:37-71); the return value is the exit code. */
export async function run(argv: readonly string[], env: Env): Promise<number> {
	const cmd = argv[0] ?? "serve";
	try {
		switch (cmd) {
			case "serve":
				await serve(env);
				return 0;
			case "healthcheck":
				await healthcheck(env);
				return 0;
			default:
				throw new Error(`unknown command ${goQuote(cmd)}`);
		}
	} catch (err) {
		process.stderr.write(`error: ${errorMessage(err)}\n`);
		return 1;
	}
}

/** A listen address as net.Listen("tcp", addr) reads it: ":8080" is every interface, host may be empty. */
function listenAddress(addr: string): { port: number; host: string | undefined } {
	const colon = addr.lastIndexOf(":");
	if (colon < 0) throw new Error(`listen tcp: address ${addr}: missing port in address`);
	const portText = addr.slice(colon + 1);
	if (!/^[0-9]+$/.test(portText)) throw new Error(`listen tcp: address ${addr}: invalid port`);
	const port = Number(portText);
	if (port > 65_535) throw new Error(`listen tcp: address ${addr}: invalid port`);
	let host = addr.slice(0, colon);
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	return { port, host: host === "" ? undefined : host };
}

/** hostPart is an address's host as written, for the log line and the reported address. */
function hostPart(addr: string): string {
	const colon = addr.lastIndexOf(":");
	return colon < 0 ? "" : addr.slice(0, colon);
}

/** loopback reports whether a listen address only accepts local connections (main.go:194-206). */
export function loopback(addr: string): boolean {
	let host = hostPart(addr);
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host === "localhost") return true;
	if (isIP(host) === 4) return host.startsWith("127.");
	if (isIP(host) === 6) return host === "::1" || host === "0:0:0:0:0:0:0:1";
	return false;
}

// Only as the entry point: a test imports this file for startServe and run.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await run(process.argv.slice(2), process.env);
}
