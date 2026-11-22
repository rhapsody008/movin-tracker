// The settings service: the one place that reads and writes settings.json.
// Port of internal/settings/settings.go (+ the telegram and checkin sections,
// whose validation lives in telegram.ts and checkin.ts).
//
// Reads come from a copy at most CACHE_TTL_MS old. Writes read the file as raw
// sections, let one section change, and PUT it back with If-Match, retrying the
// whole read-modify-write when another writer got there first, so saving one
// section never drops another (spec §5). A generation counter stops a slow read
// from caching an older document over a save (spec §9, trap 13).
//
// v2: there is one connection kind, OpenAI-compatible. A stored llm section
// with kind "claude" is ignored as a whole — the env applies and its key is
// never decrypted — and the view says so with legacyKind (spec §11).

import { ValidationError } from "../errors.ts";
import { RawObject } from "../gojson.ts";
import { goStamp, goTrimRight, goTrimSpace } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { type Checkin, type CheckinInput, type CheckinSetting, parseCheckin } from "./checkin.ts";
import { ConflictError } from "./errors.ts";
import { decodeFernetKey, fernetDecrypt, fernetEncrypt } from "./fernet.ts";
import {
	decodeStored,
	decodeStoredLLM,
	emptyStored,
	encodeCheckin,
	encodeLLM,
	encodeTelegram,
	type Stored,
	type StoredLLM,
} from "./stored.ts";
import type { Telegram, TelegramInput, TelegramView } from "./telegram.ts";
import { validTelegram } from "./telegram.ts";
import { isHTTPURL, originOf, sameOrigin } from "./url.ts";

/** The one object the service owns. */
export const KEY = "settings.json";

/** How long a read of settings.json is reused before the store is asked again. */
export const CACHE_TTL_MS = 30_000;

/** How many times a write is retried after losing an ETag race before ConflictError. */
export const MAX_RETRIES = 3;

/** Save, test and models reject Claude-shaped input with this (400 in T2.2). */
export const CLAUDE_MESSAGE = "Claude connections are no longer supported; use an OpenAI-compatible endpoint";

/** A fully resolved connection, ready to call. */
export interface LLM {
	/** "openai"; never empty once resolved. */
	kind: string;
	/** The model takes images (drawing crops): what the Save probe found. */
	vision: boolean;
	baseUrl: string;
	apiKey: string;
	model: string;
	/** The app's own limits, not settings: they come from the env defaults. */
	timeoutSec: number;
	maxToolRounds: number;
	streaming: boolean;
	/** The model thinks only when a message starts with /think. */
	thinkOnDemand: boolean;
}

/** The built-in values, used when neither settings.json nor the env sets a field. */
export const DEFAULTS: Readonly<LLM> = Object.freeze({
	kind: "openai",
	vision: false,
	baseUrl: "",
	apiKey: "",
	model: "",
	timeoutSec: 600,
	maxToolRounds: 5,
	streaming: true,
	thinkOnDemand: false,
});

/** What the settings drawer sends to save or test. */
export interface Input {
	vision: boolean;
	/** Empty means openai. "claude" is rejected in v2. */
	kind: string;
	baseUrl: string;
	/** Empty keeps the stored key. */
	apiKey: string;
	/** Explicit removal. */
	clearKey: boolean;
	model: string;
	streaming: boolean;
	thinkOnDemand: boolean;
}

/** What GET /api/settings/llm returns. No field can carry the key. */
export interface View {
	vision: boolean;
	kind: string;
	/** "claude" when a v1 section is being ignored; omitted otherwise. */
	legacyKind?: string;
	baseUrl: string;
	model: string;
	streaming: boolean;
	thinkOnDemand: boolean;
	keySet: boolean;
	keyLast4?: string;
	keyFromEnv: boolean;
	canStoreKey: boolean;
	updated?: string;
	by?: string;
}

export interface ServiceOptions {
	store: ObjectStore;
	log: Log;
	/** The env-level defaults (LLM_*), which settings.json overrides. */
	env: LLM;
	/** The env-level allowlist that a saved telegram section replaces. */
	telegramEnv?: Telegram;
	/** The env-level check-in that a saved checkin section replaces. */
	checkinEnv?: Checkin;
	/** SETTINGS_SECRET: empty means a key can only come from LLM_API_KEY. */
	secret?: string;
	now?: () => Date;
	/** Test seam for "the stored key is never decrypted"; defaults to the Fernet call. */
	decrypt?: (token: string) => string | null;
}

export interface SettingsService {
	/** settings.json as of at most CACHE_TTL_MS ago; a problem reads as the env defaults. */
	current: () => Promise<Stored>;
	/** Resolves env over defaults over file. */
	resolve: () => Promise<LLM>;
	/** The view, with the top-level updated/by (LLM last saved). */
	view: () => Promise<View>;
	/** The key to send to baseUrl: the typed one, else the configured one if it belongs there. */
	keyFor: (baseUrl: string, typed: string) => Promise<string>;
	/** Resolves the settings the drawer is showing, without saving. */
	forTest: (input: Input) => Promise<LLM>;
	save: (by: string, input: Input) => Promise<View>;
	resolveTelegram: () => Promise<Telegram>;
	viewTelegram: () => Promise<TelegramView>;
	saveTelegram: (by: string, input: TelegramInput) => Promise<TelegramView>;
	/** Throws when settings.json exists but cannot be read: a check-in saved as off must not go out. */
	resolveCheckin: () => Promise<Checkin>;
	viewCheckin: () => Promise<CheckinSetting>;
	saveCheckin: (by: string, input: CheckinInput) => Promise<CheckinSetting>;
	/** Replaces the clock (tests). */
	setClock: (now: () => Date) => void;
	/** Replaces the env-level allowlist (tests, and the server wiring it from config). */
	withTelegramEnv: (t: Telegram) => void;
	/** Replaces the env-level check-in (tests). */
	withCheckinEnv: (c: Checkin) => void;
}

interface Cached {
	stored: Stored;
	at: Date;
}

/** reReadLLM decodes the section a save is about to replace, ignoring junk as Go does. */
function reReadLLM(section: string | undefined): StoredLLM {
	if (section === undefined) return {};
	try {
		return decodeStoredLLM(JSON.parse(section));
	} catch {
		return {};
	}
}

/** NewService's error: SETTINGS_SECRET is not a valid Fernet key: … */
function decodeSecret(secret: string): Buffer {
	try {
		return decodeFernetKey(secret);
	} catch (err) {
		throw new Error(`SETTINGS_SECRET is not a valid Fernet key: ${errorMessage(err)}`, { cause: err });
	}
}

export function createSettingsService(o: ServiceOptions): SettingsService {
	const { store, log } = o;
	const env: LLM = { ...o.env, kind: o.env.kind === "" ? "openai" : o.env.kind };
	const secret = o.secret ?? "";
	const fkey = secret === "" ? null : decodeSecret(secret);
	const decrypt = o.decrypt ?? ((token: string): string | null => (fkey === null ? null : fernetDecrypt(fkey, token)));
	let now = o.now ?? ((): Date => new Date());
	let telegramEnv: Telegram = o.telegramEnv ?? { users: [], groups: [], fromEnv: true };
	let checkinEnv = o.checkinEnv;
	const encoder = new TextEncoder();
	// warnOnce's memory: message → the details it was last logged with.
	const lastWarn = new Map<string, string>();
	let cache: Cached | null = null;
	let gen = 0;

	/** Logs a warning only when the details differ from the last time for that message. */
	function warnOnce(msg: string, fields?: Record<string, unknown>): void {
		const details = JSON.stringify(fields ?? {});
		const prev = lastWarn.get(msg);
		lastWarn.set(msg, details);
		if (prev !== details) log.warn(msg, fields);
	}

	async function load(): Promise<Stored> {
		let body: Uint8Array;
		try {
			body = (await store.get(KEY)).body;
		} catch (err) {
			if (err instanceof NotFoundError) return emptyStored();
			throw err;
		}
		try {
			return decodeStored(body);
		} catch (err) {
			throw new Error(`decode ${KEY}: ${errorMessage(err)}`, { cause: err });
		}
	}

	/** currentErr is current, but reports a failed read rather than falling back. */
	async function currentErr(): Promise<Stored> {
		const hit = cache;
		if (hit !== null && now().getTime() - hit.at.getTime() < CACHE_TTL_MS) return hit.stored;
		const genAtStart = gen;
		const stored = await load();
		// A save landed while this read was in flight; its copy is newer.
		if (gen !== genAtStart && cache !== null) return cache.stored;
		cache = { stored, at: now() };
		return stored;
	}

	async function current(): Promise<Stored> {
		try {
			return await currentErr();
		} catch (err) {
			warnOnce("settings.json unreadable, using env defaults", { err: errorMessage(err) });
			return emptyStored();
		}
	}

	// ---- resolution ----

	interface Resolved {
		llm: LLM;
		keyFromEnv: boolean;
		legacyKind?: string;
	}

	/** resolve layers settings.json over env over defaults, field by field. */
	function resolve(st: Stored): Resolved {
		const out: LLM = { ...env };
		let keyFromEnv = out.apiKey !== "";
		const l = st.llm;
		if (l?.kind === "claude") {
			// A v1 Claude connection: not this app's to use. The env applies, and the
			// stored key stays encrypted because decrypt is never called.
			return { llm: out, keyFromEnv: keyFromEnv && out.apiKey !== "", legacyKind: "claude" };
		}
		if (l !== undefined) {
			if (l.baseUrl !== undefined) out.baseUrl = l.baseUrl;
			if (l.vision !== undefined) out.vision = l.vision;
			if (l.apiKeyEnc !== undefined) {
				const k = decrypt(l.apiKeyEnc);
				if (k === null) {
					log.warn("stored API key could not be decrypted; using LLM_API_KEY instead (check SETTINGS_SECRET)");
				} else if (l.baseUrl === undefined || !sameOrigin(l.baseUrl, out.baseUrl)) {
					// The stored key belongs to the URL it was saved with. If this process
					// would send it elsewhere, it is not used.
					warnOnce("stored API key belongs to another host; not using it", {
						savedFor: originOf(l.baseUrl),
						target: originOf(out.baseUrl),
					});
				} else {
					out.apiKey = k;
					keyFromEnv = false;
				}
			}
			if (l.model !== undefined) out.model = l.model;
			if (l.streaming !== undefined) out.streaming = l.streaming;
			if (l.thinkOnDemand !== undefined) out.thinkOnDemand = l.thinkOnDemand;
		}
		// The env key belongs to LLM_BASE_URL. If the file points the app at a
		// different host, that key must not follow it there.
		if (keyFromEnv && env.baseUrl !== "" && !sameOrigin(out.baseUrl, env.baseUrl)) out.apiKey = "";
		return { llm: out, keyFromEnv: keyFromEnv && out.apiKey !== "" };
	}

	async function resolveNow(): Promise<LLM> {
		return resolve(await current()).llm;
	}

	async function view(): Promise<View> {
		const st = await current();
		const { llm, legacyKind, keyFromEnv } = resolve(st);
		return {
			vision: llm.vision,
			kind: llm.kind,
			...(legacyKind === undefined ? {} : { legacyKind }),
			baseUrl: llm.baseUrl,
			model: llm.model,
			streaming: llm.streaming,
			thinkOnDemand: llm.thinkOnDemand,
			keySet: llm.apiKey !== "",
			keyFromEnv,
			canStoreKey: fkey !== null,
			...(llm.apiKey.length >= 8 ? { keyLast4: llm.apiKey.slice(-4) } : {}),
			...(st.updated === undefined ? {} : { updated: st.updated }),
			...(st.by === undefined ? {} : { by: st.by }),
		};
	}

	async function keyFor(baseUrl: string, typed: string): Promise<string> {
		if (typed !== "") return typed;
		const cur = await resolveNow();
		return cur.apiKey !== "" && sameOrigin(baseUrl, cur.baseUrl) ? cur.apiKey : "";
	}

	/** normalise fills the kind (empty = openai) and checks the URL and the model. */
	function normalise(input: Input): Input {
		let req: Input = { ...input };
		if (req.kind === "") req.kind = "openai";
		if (req.kind === "claude") throw new ValidationError(CLAUDE_MESSAGE);
		if (req.kind !== "openai") throw new ValidationError("kind must be openai");
		if (!isHTTPURL(req.baseUrl)) throw new ValidationError("endpoint URL must start with http:// or https://");
		const model = goTrimSpace(req.model);
		if (model === "") throw new ValidationError("model is required");
		req = {
			kind: req.kind,
			vision: req.vision,
			baseUrl: goTrimRight(goTrimSpace(req.baseUrl), "/"),
			apiKey: req.apiKey,
			clearKey: req.clearKey,
			model,
			streaming: req.streaming,
			thinkOnDemand: req.thinkOnDemand,
		};
		return req;
	}

	async function forTest(input: Input): Promise<LLM> {
		const req = normalise(input);
		let key = await keyFor(req.baseUrl, req.apiKey);
		if (req.clearKey && req.apiKey === "") {
			key = "";
			if (env.apiKey !== "" && (env.baseUrl === "" || sameOrigin(req.baseUrl, env.baseUrl))) key = env.apiKey;
		}
		return {
			kind: req.kind,
			vision: req.vision,
			baseUrl: req.baseUrl,
			apiKey: key,
			model: req.model,
			timeoutSec: env.timeoutSec,
			maxToolRounds: env.maxToolRounds,
			streaming: req.streaming,
			thinkOnDemand: req.thinkOnDemand,
		};
	}

	/** remember caches a document this process just wrote. */
	function remember(body: string): void {
		try {
			cache = { stored: decodeStored(encoder.encode(body)), at: now() };
			gen++;
		} catch {
			// A document we wrote is readable; if it is not, the next read will say so.
		}
	}

	// modify is the only write path: read settings.json as raw sections, let fn
	// change the ones it owns, and write it back with the ETag guard. Sections fn
	// does not touch (including ones this version doesn't know) are kept.
	async function modify(fn: (raw: RawObject) => void): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let raw = new RawObject();
			let etag: string | null = null;
			let body: Uint8Array | null = null;
			try {
				const got = await store.get(KEY);
				body = got.body;
				etag = got.etag;
			} catch (err) {
				if (!(err instanceof NotFoundError)) throw err;
			}
			if (body !== null) {
				try {
					raw = RawObject.parse(new TextDecoder().decode(body));
				} catch {
					// Unreadable file (or not a JSON object, which Go's `null` body is
					// too): overwrite it rather than leave the app stuck.
					log.warn("replacing unreadable settings.json");
					raw = new RawObject();
				}
			}
			fn(raw);
			raw.set("schema", 1);
			const out = raw.encode();
			try {
				await store.put(KEY, encoder.encode(out), etag);
				remember(out);
				return;
			} catch (err) {
				if (!(err instanceof PreconditionError)) throw err;
				if (attempt >= MAX_RETRIES) throw new ConflictError();
			}
		}
	}

	async function save(by: string, input: Input): Promise<View> {
		const req = normalise(input);
		let enc: string | undefined;
		if (req.apiKey !== "") {
			if (fkey === null) {
				throw new ValidationError(
					"SETTINGS_SECRET is not configured on the server, so a key cannot be stored. Set LLM_API_KEY instead.",
				);
			}
			enc = fernetEncrypt(fkey, req.apiKey);
		}
		await modify((raw) => {
			const old = reReadLLM(raw.raw("llm"));
			let keep = old.apiKeyEnc;
			if (req.clearKey) keep = undefined;
			// A saved key belongs to its endpoint: moving to another host without
			// typing a key drops it instead of sending it there.
			if (
				keep !== undefined &&
				enc === undefined &&
				(old.baseUrl === undefined || !sameOrigin(req.baseUrl, old.baseUrl))
			) {
				keep = undefined;
			}
			if (enc !== undefined) keep = enc;
			raw.set(
				"llm",
				encodeLLM({
					// v2: Save always writes openai, so a Go rollback sees a plain connection.
					kind: "openai",
					vision: req.vision,
					baseUrl: req.baseUrl,
					apiKeyEnc: keep,
					model: req.model,
					streaming: req.streaming,
					thinkOnDemand: req.thinkOnDemand,
				}),
			);
			raw.set("updated", goStamp(now()));
			raw.set("by", by);
		});
		log.info("LLM settings saved", {
			by,
			kind: req.kind,
			model: req.model,
			baseUrl: req.baseUrl,
			keyChanged: enc !== undefined || req.clearKey,
		});
		return await view();
	}

	// ---- telegram ----

	function resolveTelegramFrom(st: Stored): Telegram {
		const saved = st.telegram;
		if (saved === undefined) {
			return { users: [...telegramEnv.users], groups: [...telegramEnv.groups], fromEnv: true };
		}
		try {
			// Re-validate what was stored; a hand-edited file falls back to env.
			const valid = validTelegram(saved.users, saved.groups);
			return { users: valid.users, groups: valid.groups, fromEnv: false };
		} catch (err) {
			warnOnce("telegram section of settings.json is invalid, using env allowlist", { err: errorMessage(err) });
			return resolveTelegramFrom(emptyStored());
		}
	}

	async function resolveTelegram(): Promise<Telegram> {
		return resolveTelegramFrom(await current());
	}

	async function viewTelegram(): Promise<TelegramView> {
		const st = await current();
		const t: TelegramView = { ...resolveTelegramFrom(st) };
		if (st.telegram !== undefined) {
			if (st.telegram.updated !== undefined) t.updated = st.telegram.updated;
			if (st.telegram.by !== undefined) t.by = st.telegram.by;
		}
		return t;
	}

	async function saveTelegram(by: string, input: TelegramInput): Promise<TelegramView> {
		let users: Telegram["users"] = [];
		let groups: string[] = [];
		if (!input.useEnv) {
			const valid = validTelegram(input.users, input.groups);
			users = valid.users;
			groups = valid.groups;
		}
		await modify((raw) => {
			if (input.useEnv) {
				raw.remove("telegram");
				return;
			}
			raw.set("telegram", encodeTelegram({ users, groups, updated: goStamp(now()), by }));
		});
		log.info("Telegram allowlist saved", { by, users: users.length, groups: groups.length, useEnv: input.useEnv });
		return await viewTelegram();
	}

	// ---- check-in ----

	function resolveCheckinFrom(st: Stored): Checkin {
		const saved = st.checkin;
		if (saved === undefined) {
			return { ...(checkinEnv ?? parseCheckin("", "")), fromEnv: true };
		}
		try {
			return parseCheckin(saved.schedule, saved.chat ?? "");
		} catch (err) {
			warnOnce("checkin section of settings.json is invalid, using the server's setting", { err: errorMessage(err) });
			return resolveCheckinFrom(emptyStored());
		}
	}

	async function resolveCheckin(): Promise<Checkin> {
		let st: Stored;
		try {
			st = await currentErr();
		} catch (err) {
			throw new Error(`read ${KEY}: ${errorMessage(err)}`, { cause: err });
		}
		return resolveCheckinFrom(st);
	}

	async function viewCheckin(): Promise<CheckinSetting> {
		let st: Stored;
		let unreadable = false;
		try {
			st = await currentErr();
		} catch {
			st = emptyStored();
			unreadable = true;
		}
		const v: CheckinSetting = { ...resolveCheckinFrom(st) };
		if (unreadable) v.unreadable = true;
		if (st.checkin !== undefined) {
			if (st.checkin.updated !== undefined) v.updated = st.checkin.updated;
			if (st.checkin.by !== undefined) v.by = st.checkin.by;
		}
		return v;
	}

	async function saveCheckin(by: string, input: CheckinInput): Promise<CheckinSetting> {
		let c: Checkin | null = null;
		if (!input.useEnv) c = parseCheckin(input.schedule, input.chat);
		const schedule = c?.schedule ?? "";
		const chat = c?.chat ?? "";
		await modify((raw) => {
			if (input.useEnv) {
				raw.remove("checkin");
				return;
			}
			raw.set("checkin", encodeCheckin({ schedule, chat, updated: goStamp(now()), by }));
		});
		log.info("check-in setting saved", { by, schedule, chat, useEnv: input.useEnv });
		return await viewCheckin();
	}

	return {
		current,
		resolve: resolveNow,
		view,
		keyFor,
		forTest,
		save,
		resolveTelegram,
		viewTelegram,
		saveTelegram,
		resolveCheckin,
		viewCheckin,
		saveCheckin,
		setClock: (fn) => {
			now = fn;
		},
		withTelegramEnv: (t) => {
			telegramEnv = t;
		},
		withCheckinEnv: (c) => {
			checkinEnv = c;
		},
	};
}
