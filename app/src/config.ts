// Every setting that comes from the environment. Port of internal/config/config.go,
// with the v2 removals (settings-spec §11): no Claude connection, no
// LLM_CLAUDE_BASE_URL, and LLM_KIND=claude refuses to start.
//
// loadConfig takes the environment map so tests never touch process.env; the
// server passes the default. A bad value throws with Go's message: the process
// is expected to die at startup rather than run half-configured.

import { fileURLToPath } from "node:url";
import { DEFAULT_SYNC_SCHEDULE } from "./docs/schedule.ts";
import { goQuote, goTrim, goTrimRight, goTrimSpace } from "./gostr.ts";
import { errorMessage } from "./log.ts";
import { parseSchedule } from "./sched.ts";
import { type Checkin, DEFAULT_CHECKIN, parseCheckin } from "./settings/checkin.ts";
import { parseTelegramEnv, type Telegram } from "./settings/telegram.ts";

/**
 * The admin guide's Markdown: the repo's docs/, next to app/ where this file
 * lives (main.go:110-116 reads it on every request in dev, and the built Go
 * binary embeds the same file).
 */
const DEFAULT_GUIDE_FILE = fileURLToPath(new URL("../../docs/admin-guide.md", import.meta.url));

/** The LLM limits that come from Defaults, not from the environment. */
export const LLM_DEFAULTS = { timeoutSec: 600, maxToolRounds: 5, streaming: true } as const;

/** How long HARNESS_RESTORE_ID may be, in characters (T5.3a). */
const RESTORE_ID_MAX = 128;

/** What a restore id may be: printable ASCII, so it survives a shell and a log line unchanged. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export interface LLMConfig {
	/** Always "openai" in v2. */
	kind: "openai";
	vision: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	timeoutSec: number;
	maxToolRounds: number;
	streaming: boolean;
	thinkOnDemand: boolean;
}

export interface Config {
	listenAddr: string;
	s3Bucket: string;
	s3Prefix: string;
	awsRegion: string;
	s3EndpointUrl: string;
	authHeader: string;
	allowedEmails: string[];
	/** Used when the auth header is missing; local dev only. */
	devEmail: string;
	settingsSecret: string;
	/** The env-level LLM defaults; settings.json overrides them. */
	llm: LLMConfig;
	/** DOCS_SYNC_SCHEDULE as written: HH:MM in timeZone, or off. */
	docsSync: string;
	checkin: Checkin;
	/** Empty: the bot does not start. */
	telegramToken: string;
	/** The env-level allowlist; settings.json overrides it. */
	telegram: Telegram;
	/** The TZ name, for Intl. */
	timeZone: string;
	staticDir: string;
	/** GUIDE_FILE: the admin guide's Markdown, read on every request. */
	guideFile: string;
	/** DATA_DIR: the volume, holding the durable harness's SQLite file (`<dataDir>/harness.db`). */
	dataDir: string;
	/** false when MOVIN_DOCS=off: no syncer, no syncs, and GET /api/docs says on:false. */
	docsOff: boolean;
	/**
	 * MOVIN_INSTANCE: `dev` or `prod`, naming this deployment's S3 start counter
	 * (`harness/<instance>/epoch.json`, T5-plan §14.6). Empty when it is not set:
	 * serve() then refuses to start, so prod can never share dev's counter — but a
	 * test or tool that builds only the rest of the config may leave it out.
	 */
	instance: string;
	/** HARNESS_RESTORE_ID: a fresh id after a restore, else empty (the ConfigMap `movin-restore`). */
	restoreId: string;
	pollEveryMs: number;
	logLevel: string;
}

/** An environment lookup: process.env, or a plain object in tests. */
export type Env = Record<string, string | undefined>;

/** env(k, d): the trimmed value, or the default when unset or blank. */
function env(e: Env, k: string, d: string): string {
	const v = goTrimSpace(e[k] ?? "");
	return v === "" ? d : v;
}

/** strconv.ParseBool, whose error text LLM_STREAMING reports. */
function parseBool(s: string): boolean {
	switch (s) {
		case "1":
		case "t":
		case "T":
		case "true":
		case "TRUE":
		case "True":
			return true;
		case "0":
		case "f":
		case "F":
		case "false":
		case "FALSE":
		case "False":
			return false;
		default:
			throw new Error(`strconv.ParseBool: parsing ${goQuote(s)}: invalid syntax`);
	}
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	Object.freeze(value);
	for (const inner of Object.values(value)) deepFreeze(inner);
	return value;
}

/** Load reads the environment and returns the config or throws on a bad value. */
export function loadConfig(e: Env): Config {
	const llm: LLMConfig = {
		kind: "openai",
		vision: false,
		baseUrl: goTrimRight(env(e, "LLM_BASE_URL", ""), "/"),
		apiKey: env(e, "LLM_API_KEY", ""),
		model: env(e, "LLM_MODEL", ""),
		timeoutSec: LLM_DEFAULTS.timeoutSec,
		maxToolRounds: LLM_DEFAULTS.maxToolRounds,
		streaming: LLM_DEFAULTS.streaming,
		thinkOnDemand: false,
	};
	const kind = env(e, "LLM_KIND", "openai");
	if (kind === "claude")
		throw new Error("LLM_KIND=claude is no longer supported (v2): use an OpenAI-compatible endpoint");
	if (kind !== "openai") throw new Error('LLM_KIND must be "openai"');
	const streaming = env(e, "LLM_STREAMING", "");
	if (streaming !== "") {
		try {
			llm.streaming = parseBool(streaming);
		} catch (err) {
			throw new Error(`LLM_STREAMING: ${errorMessage(err)}`, { cause: err });
		}
	}
	const think = env(e, "LLM_THINK_ON_DEMAND", "");
	if (think !== "") {
		try {
			llm.thinkOnDemand = parseBool(think);
		} catch (err) {
			throw new Error(`LLM_THINK_ON_DEMAND: ${errorMessage(err)}`, { cause: err });
		}
	}

	const s3Bucket = env(e, "S3_BUCKET", "");
	if (s3Bucket === "") throw new Error("S3_BUCKET is required");

	const timeZone = env(e, "TZ", "Asia/Singapore");
	checkTimeZone(timeZone);

	const docsSync = env(e, "DOCS_SYNC_SCHEDULE", DEFAULT_SYNC_SCHEDULE);
	parseSchedule("DOCS_SYNC_SCHEDULE", docsSync, DEFAULT_SYNC_SCHEDULE);

	const schedule = env(e, "CHECKIN_SCHEDULE", DEFAULT_CHECKIN);
	try {
		parseCheckin(schedule, "");
	} catch (err) {
		throw new Error(`CHECKIN_SCHEDULE: ${errorMessage(err)}`, { cause: err });
	}
	let checkin: Checkin;
	try {
		checkin = parseCheckin(schedule, env(e, "CHECKIN_CHAT", ""));
	} catch (err) {
		throw new Error(`CHECKIN_CHAT: ${errorMessage(err)}`, { cause: err });
	}

	// MOVIN_DOCS is the one switch v2 adds: the dev app can share the real bucket
	// without writing the documents index before T3.1 brings the summariser.
	const docsSwitch = env(e, "MOVIN_DOCS", "on");
	if (docsSwitch !== "on" && docsSwitch !== "off") throw new Error('MOVIN_DOCS must be "on" or "off"');

	// The restore guard's two variables (T5.3a). A default for the instance would
	// let prod share dev's counter and run a false restore, so there is none: the
	// value is required where the guard is built (serve).
	const instance = env(e, "MOVIN_INSTANCE", "");
	if (instance !== "" && instance !== "dev" && instance !== "prod") {
		throw new Error('MOVIN_INSTANCE must be "dev" or "prod"');
	}
	const restoreId = env(e, "HARNESS_RESTORE_ID", "");
	if (restoreId.length > RESTORE_ID_MAX || !PRINTABLE_ASCII.test(restoreId)) {
		throw new Error(`HARNESS_RESTORE_ID must be at most ${String(RESTORE_ID_MAX)} printable ASCII characters`);
	}

	const allowedEmails: string[] = [];
	for (const part of env(e, "ALLOWED_EMAILS", "").split(",")) {
		const mail = goTrimSpace(part).toLowerCase();
		if (mail !== "") allowedEmails.push(mail);
	}

	return deepFreeze({
		listenAddr: env(e, "LISTEN_ADDR", "127.0.0.1:8080"),
		s3Bucket,
		s3Prefix: goTrim(env(e, "S3_PREFIX", ""), "/"),
		awsRegion: env(e, "AWS_REGION", "ap-southeast-1"),
		s3EndpointUrl: env(e, "S3_ENDPOINT_URL", ""),
		authHeader: env(e, "AUTH_HEADER", "X-Forwarded-Email"),
		allowedEmails,
		devEmail: env(e, "DEV_EMAIL", "").toLowerCase(),
		settingsSecret: env(e, "SETTINGS_SECRET", ""),
		llm,
		docsSync,
		checkin,
		telegramToken: env(e, "TELEGRAM_BOT_TOKEN", ""),
		telegram: parseTelegramEnv(env(e, "TELEGRAM_ALLOWED_IDS", ""), env(e, "TELEGRAM_ALLOWED_CHATS", "")),
		timeZone,
		staticDir: env(e, "STATIC_DIR", ""),
		guideFile: env(e, "GUIDE_FILE", DEFAULT_GUIDE_FILE),
		dataDir: env(e, "DATA_DIR", "/data"),
		docsOff: docsSwitch === "off",
		instance,
		restoreId,
		pollEveryMs: 5000,
		logLevel: env(e, "LOG_LEVEL", "info"),
	});
}

// checkTimeZone is time.LoadLocation's job: Intl knows the same zone database.
function checkTimeZone(name: string): void {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: name });
	} catch {
		throw new Error(`TZ: unknown time zone ${goQuote(name)}`);
	}
}
