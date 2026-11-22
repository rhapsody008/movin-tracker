// The admin routes: the storage view and its six-step probe, the Telegram view
// with the allowlist and the check-in, and the admin guide's bytes. Port of
// internal/server/admin.go.
//
// Three things here are contracts rather than implementation details:
// - the probe takes a try-lock, never a queue: a second request gets 409 at
//   once, because a queued one would hold the connection for 30 s;
// - the scratch object `_probe/<ULID>.json` is the only thing the app ever
//   deletes, and it is cleaned up even when an earlier step failed;
// - the Telegram answer never carries the token, only `tokenSet`.
//
// T2 has no bot: Go calls the methods on a nil *telegram.Bot, which answers the
// zero Status and `CheckinView{NoBot:true}`. T4 plugs the real bot in through
// TelegramStatusSource and nothing else changes.

import type { IncomingMessage, ServerResponse } from "node:http";
import { newUlid } from "../entries/ids.ts";
import type { EntriesService } from "../entries/service.ts";
import { Ordered } from "../gojson.ts";
import { goTimeJSON } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectStore, PreconditionError, type StoreInfo } from "../objstore/store.ts";
import type { CheckinSetting } from "../settings/checkin.ts";
import type { SettingsService } from "../settings/settings.ts";
import type { TelegramView } from "../settings/telegram.ts";
import {
	decodeBody,
	decodeFailed,
	fail,
	fieldOf,
	jsonBool,
	jsonString,
	jsonStrings,
	writeErr,
	writeJSON,
} from "./http.ts";
import type { Handler } from "./router.ts";

/** Go's entries.Key: the one object the storage view stats (admin.go:41). */
const ENTRIES_KEY = "entries.json";

/** Where the storage test writes its scratch object (admin.go:68). */
export const PROBE_PREFIX = "_probe/";

/** The two budgets Go sets (admin.go:35, :79). */
const STORAGE_VIEW_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * The bot's two answers for the admin page. T4 implements this; in T2 the
 * server answers as Go's nil *telegram.Bot does.
 */
export interface TelegramStatusSource {
	/** Go's telegram.Status, an object in Go's field order: tokenSet, running, … rejected. */
	status: () => Record<string, unknown>;
	/**
	 * Go's telegram.CheckinView without `setting`, or null when there is no bot. Async
	 * since T5.1c: the view reads `checkin.json` and settings.json.
	 */
	checkinStatus: () => Promise<Record<string, unknown> | null>;
}

export interface AdminOptions {
	entries: EntriesService;
	settings: SettingsService;
	store: ObjectStore;
	log: Log;
	/** Server.Guide: the guide's bytes, or null when this build has none. */
	guide: (() => Promise<Uint8Array>) | null;
	/** The bot, when there is one (T4); null in T2. */
	telegram: TelegramStatusSource | null;
	/**
	 * Ask the scheduled check-in to run again, after a successful save (T5.1c). A
	 * callback rather than the agent: the admin routes must not import the adapter
	 * (T5-plan §4). Null when this build has no bot.
	 */
	rearmCheckin: (() => Promise<void>) | null;
}

export interface AdminRoutes {
	getStorage: Handler;
	testStorage: Handler;
	getTelegram: Handler;
	putTelegram: Handler;
	putCheckin: Handler;
	getGuide: Handler;
}

/** One probe step, in Go's struct order (admin.go:33-39). */
interface ProbeStep {
	name: string;
	ok: boolean;
	skipped?: boolean;
	ms: number;
	error?: string;
}

export function createAdminRoutes(o: AdminOptions): AdminRoutes {
	const { entries, settings, store, log } = o;
	// Go's probeMu.TryLock: one probe at a time, and no queue behind it.
	let probing = false;

	async function onError(req: IncomingMessage, res: ServerResponse, err: unknown): Promise<void> {
		await fail({ entries, log }, req, res, err);
	}

	/** GET /api/admin/storage: where the objects live, and when entries.json last changed. */
	const getStorage: Handler = async (_req, res) => {
		const signal = AbortSignal.timeout(STORAGE_VIEW_TIMEOUT_MS);
		const info = await store.info(signal);
		let lastWrite: unknown = null;
		let error = "";
		try {
			const st = await store.stat(ENTRIES_KEY, signal);
			lastWrite = new Ordered([
				["key", ENTRIES_KEY],
				["at", goTimeJSON(st.lastModified)],
			]);
		} catch (err) {
			// A missing document is not an error: the service writes it on the first save.
			if (!(err instanceof NotFoundError)) {
				log.warn("storage stat failed", { err: errorMessage(err) });
				error = `Could not read ${ENTRIES_KEY} from storage.`;
			}
		}
		writeJSON(res, 200, encodeStorageView(info, lastWrite, error));
	};

	/** POST /api/admin/storage/test: the six steps, always 200 once it has the lock. */
	const testStorage: Handler = async (_req, res, h) => {
		if (probing) {
			writeErr(res, 409, "A storage test is already running.");
			return;
		}
		probing = true;
		try {
			const result = await probe(store, AbortSignal.timeout(PROBE_TIMEOUT_MS));
			log.info("storage test", { by: h.user, ok: result.ok, key: result.key });
			writeJSON(res, 200, encodeProbeResult(result));
		} finally {
			probing = false;
		}
	};

	/**
	 * The no-bot Status: Go's zero value for a nil *telegram.Bot, which has
	 * TokenSet false (bot.go:103-113). T4's bot reports its own tokenSet.
	 */
	function noBotStatus(): Record<string, unknown> {
		return { tokenSet: false, running: false, rejected: [] };
	}

	/** Go's CheckinView for a nil *telegram.Bot: `{on:false, noBot:true}` (checkin.go:448-453). */
	function noBotCheckin(): Record<string, unknown> {
		return { on: false, noBot: true };
	}

	/** telegramView, the answer of all three Telegram routes (admin.go:167-215). */
	async function telegramBody(): Promise<Ordered> {
		const status = o.telegram?.status() ?? noBotStatus();
		const checkin = (await o.telegram?.checkinStatus()) ?? noBotCheckin();
		return new Ordered([
			["status", status],
			["allowlist", encodeTelegramView(await settings.viewTelegram())],
			[
				"checkin",
				// Go appends its own `setting` after every CheckinView field, so the
				// setting is editable with no bot too (admin.go:177-184).
				new Ordered([...Object.entries(checkin), ["setting", encodeCheckinSetting(await settings.viewCheckin())]]),
			],
		]);
	}

	const getTelegram: Handler = async (_req, res) => {
		writeJSON(res, 200, await telegramBody());
	};

	const putTelegram: Handler = async (req, res, h) => {
		const raw = await decodeBody(req, res);
		if (raw === null) return;
		let input: { users: { id: string; name: string }[]; groups: string[]; useEnv: boolean };
		try {
			input = {
				users: jsonUsers(raw, "users"),
				groups: jsonStrings(raw, "groups"),
				useEnv: jsonBool(raw, "useEnv"),
			};
		} catch (err) {
			decodeFailed(res, err);
			return;
		}
		try {
			await settings.saveTelegram(h.user, input);
		} catch (err) {
			await onError(req, res, err);
			return;
		}
		writeJSON(res, 200, await telegramBody());
	};

	const putCheckin: Handler = async (req, res, h) => {
		const raw = await decodeBody(req, res);
		if (raw === null) return;
		let input: { schedule: string; chat: string; useEnv: boolean };
		try {
			input = {
				schedule: jsonString(raw, "schedule"),
				chat: jsonString(raw, "chat"),
				useEnv: jsonBool(raw, "useEnv"),
			};
		} catch (err) {
			decodeFailed(res, err);
			return;
		}
		try {
			await settings.saveCheckin(h.user, input);
		} catch (err) {
			await onError(req, res, err);
			return;
		}
		// The saved time applies at the next run, not at the next restart (t5-spec
		// §11): ask the scheduled check-in to run again now. A rearm that fails leaves
		// the change in force anyway — the fifteen-minute cap re-reads it.
		const rearm = o.rearmCheckin;
		if (rearm !== null) {
			try {
				await rearm();
			} catch (err) {
				log.warn("check-in rearm failed", { err: errorMessage(err) });
			}
		}
		writeJSON(res, 200, await telegramBody());
	};

	/** GET /api/admin/guide: the Markdown bytes, unchanged (admin.go:217-231). */
	const getGuide: Handler = async (_req, res) => {
		if (o.guide === null) {
			writeErr(res, 404, "no admin guide in this build");
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = await o.guide();
		} catch (err) {
			log.warn("admin guide unreadable", { err: errorMessage(err) });
			writeErr(res, 500, "The admin guide could not be read.");
			return;
		}
		// Raw bytes, and no trailing newline added.
		res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-cache" });
		res.end(Buffer.from(bytes));
	};

	return { getStorage, testStorage, getTelegram, putTelegram, putCheckin, getGuide };
}

/** storageView: Go's embedded objstore.Info, then lastWrite (always present) and error (admin.go:20-32). */
function encodeStorageView(info: StoreInfo, lastWrite: unknown, error: string): Ordered {
	const e: (readonly [string, unknown])[] = [["backend", info.backend]];
	if (info.bucket !== undefined) e.push(["bucket", info.bucket]);
	if (info.region !== undefined) e.push(["region", info.region]);
	if (info.prefix !== undefined) e.push(["prefix", info.prefix]);
	if (info.endpoint !== undefined) e.push(["endpoint", info.endpoint]);
	if (info.credentialSource !== undefined) e.push(["credentialSource", info.credentialSource]);
	if (info.credentialError !== undefined) e.push(["credentialError", info.credentialError]);
	e.push(["lastWrite", lastWrite]);
	if (error !== "") e.push(["error", error]);
	return new Ordered(e);
}

/** telegram.Status has no token in it; the allowlist and the check-in are settings views. */
function encodeTelegramView(v: TelegramView): Ordered {
	const e: (readonly [string, unknown])[] = [
		[
			"users",
			v.users.map(
				(u) =>
					new Ordered([
						["id", u.id],
						["name", u.name],
					]),
			),
		],
		["groups", v.groups],
		["fromEnv", v.fromEnv],
	];
	if (v.updated !== undefined) e.push(["updated", v.updated]);
	if (v.by !== undefined) e.push(["by", v.by]);
	return new Ordered(e);
}

/** CheckinSetting: the resolved setting, then updated/by/unreadable; On/Hour/Minute never go out. */
function encodeCheckinSetting(s: CheckinSetting): Ordered {
	const e: (readonly [string, unknown])[] = [
		["schedule", s.schedule],
		["chat", s.chat],
		["fromEnv", s.fromEnv],
	];
	if (s.updated !== undefined) e.push(["updated", s.updated]);
	if (s.by !== undefined) e.push(["by", s.by]);
	if (s.unreadable === true) e.push(["unreadable", true]);
	return new Ordered(e);
}

interface ProbeResult {
	ok: boolean;
	key: string;
	steps: ProbeStep[];
}

/** probeResult: ok, key, steps, with `skipped` and `error` left out when empty (admin.go:52-66). */
function encodeProbeResult(r: ProbeResult): Ordered {
	return new Ordered([
		["ok", r.ok],
		["key", r.key],
		[
			"steps",
			r.steps.map((s) => {
				const e: (readonly [string, unknown])[] = [
					["name", s.name],
					["ok", s.ok],
				];
				if (s.skipped === true) e.push(["skipped", true]);
				e.push(["ms", s.ms]);
				if (s.error !== undefined) e.push(["error", s.error]);
				return new Ordered(e);
			}),
		],
	]);
}

/**
 * probe is the six-step storage test (admin.go:87-165). Steps after the first
 * failure are recorded as skipped with no timing; the delete step still runs
 * whenever the scratch object was created, so a failed test leaves nothing
 * behind. `ok` is false when any step is not ok, a skipped one included.
 */
async function probe(store: ObjectStore, signal: AbortSignal): Promise<ProbeResult> {
	const encoder = new TextEncoder();
	const key = `${PROBE_PREFIX}${newUlid()}.json`;
	const body = encoder.encode(`{"probe":true}`);
	const res: ProbeResult = { ok: false, key, steps: [] };
	let etag = "";
	let etag2 = "";
	let failed = false;

	const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
		if (failed) {
			res.steps.push({ name, ok: false, skipped: true, ms: 0 });
			return;
		}
		const start = Date.now();
		let error = "";
		try {
			await fn();
		} catch (err) {
			error = errorMessage(err);
			failed = true;
		}
		const st: ProbeStep = { name, ok: error === "", ms: Date.now() - start };
		if (error !== "") st.error = error;
		res.steps.push(st);
	};

	await step("create (only if absent)", async () => {
		// null is the create-only condition (If-None-Match: *); "" would be a caller bug.
		etag = await store.put(key, body, null, signal);
	});
	await step("head", async () => {
		const st = await store.stat(key, signal);
		if (st.etag !== etag) throw new Error("head returned a different ETag than the write");
	});
	await step("get", async () => {
		const got = await store.get(key, signal);
		if (Buffer.compare(got.body, body) !== 0 || got.etag !== etag) {
			throw new Error("read back different content or ETag");
		}
	});
	await step("refuse stale write", async () => {
		try {
			etag2 = await store.put(key, encoder.encode(`{"probe":2}`), etag, signal);
		} catch (err) {
			throw new Error(`setup write failed: ${errorMessage(err)}`);
		}
		try {
			await store.put(key, encoder.encode(`{"probe":3}`), etag, signal);
		} catch (err) {
			// The stale ETag must lose: that is the whole point of the step.
			if (err instanceof PreconditionError) return;
			throw err;
		}
		throw new Error("a write with a stale ETag was accepted; concurrent edits could be lost");
	});
	await step("write with current ETag", async () => {
		await store.put(key, encoder.encode(`{"probe":4}`), etag2, signal);
	});
	// Delete runs whenever the scratch object was created, even after a later
	// step failed (admin.go:144-146).
	if (etag !== "") failed = false;
	await step("delete", async () => {
		await store.delete(key, signal);
		let gone = false;
		try {
			await store.stat(key, signal);
		} catch (err) {
			if (err instanceof NotFoundError) gone = true;
		}
		if (!gone) throw new Error("object still there after delete");
	});
	res.ok = res.steps.every((s) => s.ok);
	return res;
}

/** Go's decode of []TelegramUser; a wrong shape is a decode error, not a validation one. */
function jsonUsers(raw: Record<string, unknown>, key: string): { id: string; name: string }[] {
	const { value } = fieldOf(raw, key);
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new TypeError(`${key} must be a list`);
	return value.map((item: unknown) => {
		if (typeof item !== "object" || item === null || Array.isArray(item)) {
			throw new TypeError(`${key} must be a list of {id, name}`);
		}
		const user = item as Record<string, unknown>;
		return { id: jsonString(user, "id"), name: jsonString(user, "name") };
	});
}
