// The process: `serve` (the default) and `healthcheck`, ported from
// cmd/movin/main.go. With a bot token, serve also starts the Telegram bot (T4) —
// after the durable agent is open, so no turn ever finds no harness. It builds the
// store, the entries service, the settings service, the document syncer and the
// HTTP server, then the durable agent on the data volume — with the entry tools,
// the document tools, the page viewer and the prompt wiring of T3.3/T3.4, which
// the chat route (T3.5) drives.
//
// Startup order is Go's (server-spec §8.2), with one Node-only note: the listen
// uses explicit header/idle timeouts and switches off the two Node timeouts Go
// does not have, so an SSE stream or a long chat request is never cut. The
// document schedule starts only after the listener is up, so readiness and the
// page never wait for a sync.
//
// Shutdown is Go's too: stop the background jobs, end the SSE streams, close
// the listener, give in-flight requests 10 s, then cut the connections and warn.

import { mkdir, readFile } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { type AddressInfo, isIP } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promptHooks } from "./agent/prompt.ts";
import { buildTools } from "./agent/tools.ts";
import { type Config, type Env, loadConfig } from "./config.ts";
import { createPoppler } from "./docs/convert/poppler.ts";
import { createLLMSummariser } from "./docs/llmsummary.ts";
import { createViewer, type Viewer } from "./docs/render.ts";
import { startDocsBackground } from "./docs/schedule.ts";
import { createLibrary } from "./docs/search.ts";
import { createSyncer, type Syncer } from "./docs/sync.ts";
import { type Agent, type AgentEnd, type Outbox, openAgent, type ScheduleSpec } from "./durable/adapter.ts";
import { createStartGuard, type StartGuard } from "./durable/startguard.ts";
import { createEntriesService, type EntriesService } from "./entries/service.ts";
import { goQuote } from "./gostr.ts";
import { createLog, errorMessage, type Level, type Log } from "./log.ts";
import { createS3Store } from "./objstore/s3.ts";
import type { ObjectStore } from "./objstore/store.ts";
import type { TelegramStatusSource } from "./server/admin.ts";
import { type Server as AppServer, createServer } from "./server/server.ts";
import type { StaticFiles } from "./server/static.ts";
import { createDiskStatic, DEFAULT_STATIC_DIR } from "./server/static-disk.ts";
import { createSettingsService, type SettingsService } from "./settings/settings.ts";
import { type CheckinService, createCheckin } from "./tasks/checkin.ts";
import { createDocsNotifier, type DocsNotifier, docsyncSpec } from "./tasks/docsync.ts";
import { type Bot, checkinView, createBot, createBotState, statusJSON } from "./telegram/bot.ts";
import { createClient } from "./telegram/client.ts";
import { createOutbox } from "./telegram/outbox.ts";

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
	/** The durable agent, once serve() has opened it: the chat routes read it on every request. */
	agent?: () => Agent | null;
	/** The bot's view for the admin page (T4); null (the default) is Go's nil *telegram.Bot. */
	telegram?: TelegramStatusSource | null;
	/** Asks the scheduled check-in to run again after a settings save (T5.1c); null (the default) without one. */
	rearmCheckin?: (() => Promise<void>) | null;
}

/**
 * What the durable agent reads of the running app: the entries, the documents
 * and the page viewer, wired once at open (T3.5). The chat routes hold the
 * agent, so this travels with the server's own construction.
 */
export interface AgentDeps {
	entries: EntriesService;
	/** The documents syncer, or null when MOVIN_DOCS=off: no document tools, no documents section. */
	syncer: Syncer | null;
	/** The viewer that renders a page for the vision tool, or null when documents are off. */
	viewer: Viewer | null;
	/** The zone the prompt's date line is in (Go's r.Loc). */
	timeZone: string;
	/** The clock the prompt reads the date from. */
	now: () => Date;
}

export interface Running {
	/** The address listened on, with the port the OS picked filled in. */
	address: string;
	port: number;
	/** The store serve() built: the restore guard reads its counter before the agent opens (T5.3a). */
	store: ObjectStore;
	/** The settings service: serve() gives it to the durable agent, which resolves the connection per use. */
	settings: SettingsService;
	/** The logger, so the agent writes the same stream as the server. */
	log: Log;
	/** The entries, documents and viewer serve() built, for the agent it opens next. */
	agentDeps: AgentDeps;
	/** The daily document sync as a durable schedule (T5.2), or null when documents are off. */
	docsync: ScheduleSpec | null;
	/** The group notice the syncer raises (T5.2), or null when documents are off. */
	docsNotifier: DocsNotifier | null;
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

	// Documents: one converter shared by the syncs and the page views, so a big
	// render can't stack up (Go's "one Poppler", main.go:118-123), and the LLM
	// summariser, which resolves the saved connection per file.
	const poppler = config.docsOff ? null : createPoppler();
	// The group notice a sync raises (T5.2): the startup sync runs before the agent
	// opens, so the notifier holds that one until `serve()` attaches the delivery.
	const docsNotifier = poppler === null ? null : createDocsNotifier({ settings, log });
	const syncer =
		poppler === null
			? null
			: createSyncer({
					store,
					converter: poppler,
					summariser: createLLMSummariser({ settings }),
					notify: docsNotifier ?? undefined,
					log,
					now,
				});
	if (syncer === null) log.warn("documents are switched off (MOVIN_DOCS=off)");
	// The page viewer is Go's docs.Viewer (main.go:123): only the vision tool uses
	// it, and only when the connection takes images.
	const viewer = syncer === null || poppler === null ? null : createViewer({ source: syncer, store, conv: poppler });
	// The daily sync is the agent's durable `docsync` schedule (T5.2), so the
	// in-process timer below stays off: one daily run, and a restart catches it up.
	const docsync =
		syncer === null ? null : docsyncSpec({ syncer, schedule: config.docsSync, timeZone: config.timeZone, now, log });

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
		telegram: deps.telegram ?? null,
		rearmCheckin: deps.rearmCheckin ?? null,
		agent: deps.agent ?? ((): null => null),
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
					// The daily run is the agent's schedule (T5.2); this keeps startup
					// and the minute refresh only.
					daily: false,
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
		store,
		settings,
		log,
		agentDeps: { entries, syncer, viewer, timeZone: config.timeZone, now },
		docsync,
		docsNotifier,
		stop: () => {
			stopping ??= shutdown();
			return stopping;
		},
	};
}

/** The durable harness's database: on the data volume, so chat history survives the pod (plan.md · Storage). */
export function harnessDbPath(dataDir: string): string {
	return join(dataDir, "harness.db");
}

/**
 * openDurableAgent is serve's agent: the harness on `<dataDir>/harness.db`, with
 * the entry tools and the document tools of T3.3 and the prompt of T3.4 wired in
 * (T3.5). The directory is made here because a fresh volume has nothing in it.
 */
export async function openDurableAgent(
	config: Config,
	settings: SettingsService,
	log: Log,
	deps: AgentDeps,
	/** The channel the delivery task sends through (T4): absent in a process that cannot send. */
	outbox?: Outbox,
	/**
	 * The restore guard (T5.3a): serve builds it over the S3 store and the config,
	 * so the harness decides whether this database was restored before it resumes.
	 * Absent (a test that opens the agent directly), a start is what it always was.
	 */
	startGuard?: StartGuard,
	/** The scheduled jobs this process runs (T5.1c): absent means a process with none. */
	schedules?: readonly ScheduleSpec[],
): Promise<Agent> {
	await mkdir(config.dataDir, { recursive: true });
	// Go builds the search library over the syncer (main.go:120); without documents
	// there is no library, and buildTools offers the five entry tools alone.
	const docs = deps.syncer === null ? null : createLibrary({ source: deps.syncer, log });
	return openAgent({
		dbPath: harnessDbPath(config.dataDir),
		settings,
		log,
		tools: buildTools({ entries: deps.entries, docs, viewer: deps.viewer }),
		hooks: promptHooks({
			entries: deps.entries,
			docs: deps.syncer,
			viewer: deps.viewer !== null,
			timeZone: deps.timeZone,
			now: deps.now,
			log,
		}),
		...(outbox === undefined ? {} : { outbox }),
		...(startGuard === undefined ? {} : { startGuard }),
		...(schedules === undefined ? {} : { schedules }),
	});
}

/**
 * exitIfFailed is the pod-restart rule (plan.md · Deploy): a harness whose
 * storage failed ends the process, so Kubernetes starts a new one. A close of
 * our own (`closed`) leaves the exit code alone.
 */
export function exitIfFailed(end: AgentEnd, exit: (code: number) => void): void {
	if (end.kind === "failed") exit(1);
}

/** serve is `movin`: the same build, then wait for SIGINT or SIGTERM. */
async function serve(env: Env): Promise<void> {
	const config = loadConfig(env);
	// The restore guard names one deployment's counter, and there is no default:
	// a default would let prod read dev's and run a false restore (T5-plan §14.6).
	if (config.instance === "") throw new Error('MOVIN_INSTANCE must be "dev" or "prod"');
	// One shutdown, whoever asks: both signals can arrive, and the guard's read of
	// the counter is waiting through the same signal (T5.3a), so a start that hangs
	// on a dead bucket ends when the pod is told to stop.
	const shutdown = new AbortController();
	const signalled = new Promise<void>((done) => {
		const onSignal = (): void => {
			shutdown.abort();
			done();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
	// Set once the harness is open, and read by the chat routes per request: the
	// agent opens after the listener, so a slow volume never delays readiness or
	// the page (T3.2).
	let agent: Agent | null = null;
	// The morning check-in (T5.1c) exists before the agent does: its spec is what
	// the adapter schedules, and its delivery goes through the agent once open.
	let checkin: CheckinService | null = null;
	// The check-in's delivery waits for the agent instead of failing: its spec is
	// scheduled inside `openDurableAgent`, so the first tick can run before this
	// function's `opened` exists. A failed open resolves it with nothing rather than
	// rejecting — a rejection nobody happened to await would be an unhandled one —
	// and a tick that waited on it then gives the day back as any failed send does.
	const ready = Promise.withResolvers<Agent | null>();
	// The bot's status exists before the bot does: the outbox a delivery task calls
	// reports a failed send into it, and the admin page answers Go's
	// `tokenSet:true running:false` in the moment between (main.go:124-138).
	const state = config.telegramToken === "" ? null : createBotState(true);
	const client = config.telegramToken === "" ? null : createClient({ token: config.telegramToken });
	const log = createLog({ level: logLevel(config.logLevel) });
	const telegram: TelegramStatusSource | null =
		state === null
			? null
			: {
					status: () => statusJSON(state),
					checkinStatus: async () => (checkin === null ? checkinView() : await checkin.status()),
				};
	const outbox = client === null || state === null ? undefined : createOutbox({ client, log, state });
	const running = await startServe(config, {
		log,
		guide: guideReader(config.guideFile),
		agent: () => agent,
		telegram,
		// A saved check-in time takes effect at the next run, not at the next restart
		// (T5.1c): the admin route asks the schedule to run again.
		rearmCheckin:
			client === null
				? null
				: async () => {
						if (agent !== null) await agent.schedule.rearm("checkin");
					},
	});
	// The morning check-in (T5.1c): Go builds it only with a token, and starts it after
	// the listener (main.go:129, :181). Its send is the durable delivery, which needs
	// the agent — so the spec goes to the agent at open, and `deliver` reads it then.
	checkin =
		client === null
			? null
			: createCheckin({
					store: running.store,
					settings: running.settings,
					entries: running.agentDeps.entries,
					deliver: async (key, address, parts, options) => {
						const open = await ready.promise;
						if (open === null) throw new Error("the durable agent did not open, so the check-in cannot be sent");
						await open.deliver(key, address, parts, options);
					},
					now: running.agentDeps.now,
					timeZone: running.agentDeps.timeZone,
					log: running.log,
				});
	// The agent opens after the listener, like Go's background jobs (main.go:172-182),
	// so a slow volume never delays readiness or the page. The guard decides about
	// the database before anything is scheduled (T5.3a).
	// The scheduled jobs this process runs: the check-in's tick (T5.1c) and the daily
	// document sync (T5.2). A process with no bot still syncs the documents — Go does
	// too without a token — so only the check-in needs one.
	const schedules: ScheduleSpec[] = [];
	if (checkin !== null) schedules.push(checkin.spec);
	if (running.docsync !== null) schedules.push(running.docsync);
	let opened: Agent;
	try {
		opened = await openDurableAgent(
			config,
			running.settings,
			running.log,
			running.agentDeps,
			outbox,
			createStartGuard({
				store: running.store,
				instance: config.instance,
				restoreId: config.restoreId,
				log: running.log,
				signal: shutdown.signal,
			}),
			schedules,
		);
	} catch (err) {
		// A start that fails must leave nothing running: the listener and the
		// background jobs would hold the event loop open while the process reported
		// exit code 1, and the pod would keep answering with no agent.
		ready.resolve(null);
		await running.stop();
		throw err;
	}
	agent = opened;
	ready.resolve(opened);
	// The startup sync's notice goes out now (T5.2): a group message of its own, with
	// no note, so it reaches no chat's model context — Go's notice was not history
	// either. What the notifier held before this line is flushed here.
	running.docsNotifier?.attach(async (key, address, parts) => {
		await opened.deliver(key, address, parts);
	});
	// The bot starts only once the agent is open: a turn must never find no
	// harness. Polling starts after startup recovery, which answers what a crash
	// left open (spec §2.1). Its `/recent` reads entries in the app's own zone (`TZ`)
	// and its `/sync` re-reads the documents through the one syncer (main.go:124-138).
	const bot: Bot | null =
		client === null || state === null
			? null
			: createBot({
					client,
					settings: running.settings,
					agent: opened,
					entries: running.agentDeps.entries,
					syncer: running.agentDeps.syncer,
					timeZone: running.agentDeps.timeZone,
					state,
					log: running.log,
					checkin,
				});
	// The run promise is the one thing main cannot await on shutdown: a rejection
	// must be logged, never left unhandled (Go's `log.Error("telegram bot stopped")`,
	// main.go:132-133; T4 fixes M4).
	void bot?.run().catch((err: unknown) => {
		running.log.error("telegram bot stopped", { err: errorMessage(err) });
	});
	void opened.closed.then((end) => exitIfFailed(end, (code) => process.exit(code)));
	try {
		await signalled;
		await running.stop();
	} finally {
		// Polling first: an update already polled is durable, and its turn is what
		// the next start recovers (spec §2.3).
		await bot?.stop();
		await opened.close();
	}
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
