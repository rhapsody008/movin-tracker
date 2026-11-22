// The morning check-in: `checkin.json`, its claim protocol, the due window, the
// chat it goes to, and the tick that sends it. The port of
// internal/telegram/checkin_state.go, `checkinChat`, `CheckinTick`,
// `checkinCommand` and `CheckinStatus` (checkin.go:44-63, :193-217, :337-474).
// The texts and the buttons are `../telegram/checkin.ts`; the clock is the
// adapter's schedule task (T5.1b), which calls `spec.run` and sleeps until the
// target this tick answers.
//
// `checkin.json` is shared with the Go app and production, which is what makes
// "both due → one message" true: the claim is a conditional put on the same
// object, so exactly one run wins, and a run that crashed mid-send blocks the
// day for STALE_CLAIM_MS and is then taken over with the same window. Deleting
// the file means "not sent today".
//
// The bytes are Go's (the Go v1 code, tag v1.0.1, golden t51 pins them): the field order of
// CheckinRecord (checkin_state.go:31-41), `schema` always 1, an RFC 3339 `at`
// to the second, and `since`/`chat` left out when empty.
//
// Two ports of Go's time work, both deliberate:
// - Go's int64 chat ID is a JS number here, as it is everywhere Telegram's
//   types are (a real chat ID is far below 2^53).
// - checkinDue compares the wall clock in the app's zone, which is Go's
//   comparison except for a scheduled minute that a spring-forward skips: Go
//   normalises such a time to the instant after the gap, this side treats the
//   hour after the gap as past it. The cutoff (20:00) is inside no real zone's
//   change.

import type { OutboxJson, PendingNote, ScheduleSpec } from "../durable/adapter.ts";
import { type Agenda, agenda, isQuiet } from "../entries/agenda.ts";
import type { EntriesService, Snapshot } from "../entries/service.ts";
import { goMarshal, Ordered } from "../gojson.ts";
import { goStamp } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { addDays, day as calendarDay, nextRun, rfc3339, validDate } from "../sched.ts";
import { CHECKIN_CUTOFF, type Checkin, chatID, parseCheckin } from "../settings/checkin.ts";
import { groupAllowed, type Telegram, userName } from "../settings/telegram.ts";
import { formatInt64, parseInt64 } from "../settings/text.ts";
import { checkinMessages } from "../telegram/checkin.ts";
import type { SendMessage } from "../telegram/client.ts";
import { replyPart } from "../telegram/outbox.ts";

/** Where the last check-in is recorded. Shared with Go (checkin_state.go:17). */
export const CHECKIN_KEY = "checkin.json";

/** Claimed, messages going out. */
export const CHECKIN_SENDING = "sending";
/** The day's check-in went out. */
export const CHECKIN_SENT = "sent";
/** Nothing to report that day; nothing sent. */
export const CHECKIN_QUIET = "quiet";

/** How long a "sending" claim holds before another run may take the day over. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;

/** Go's ErrNoCheckinChat (checkin.go:33): there is nowhere to send it. */
export const ERR_NO_CHECKIN_CHAT = "no group or person is allowed, and no check-in chat is set";

/** One value of `checkin.json`; "" is Go's zero value for the optional fields. */
export interface CheckinRecord {
	schema: number;
	/** YYYY-MM-DD in the app's time zone. */
	day: string;
	status: string;
	/** The first day this check-in asks about; kept so a takeover asks the same days. */
	since: string;
	/** RFC 3339, when the status was set. */
	at: string;
	/** Where it went. */
	chat: string;
}

/** A day this run has taken. */
export interface CheckinClaim {
	record: CheckinRecord;
	/** What it replaced; release puts it back. */
	prev: CheckinRecord;
	etag: string;
}

/** What a claim attempt answered: the day, or (null and) the record as read. */
export interface ClaimResult {
	claim: CheckinClaim | null;
	prev: CheckinRecord;
}

/** Go's zero CheckinRecord: no check-in on record. */
export function emptyRecord(): CheckinRecord {
	return { schema: 0, day: "", status: "", since: "", at: "", chat: "" };
}

// Go's time.RFC3339 layout: whole seconds, and a zone. A fraction after the
// seconds is accepted on input even though the layout has none (Go's parser does
// that), a comma as well as a full stop.
const STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

/**
 * Go's time.Parse(time.RFC3339, s): null where Go returns an error. An `at` this
 * cannot read is not a claim (checkin_state.go:78-81).
 */
export function parseStamp(s: string): Date | null {
	const m = STAMP.exec(s);
	if (m === null || !validDate(s.slice(0, 10))) return null;
	const hour = Number(m[4]);
	const minute = Number(m[5]);
	const second = Number(m[6]);
	if (hour > 23 || minute > 59 || second > 59) return null;
	const fraction = m[7];
	const offsetHours = Number(m[10] ?? "0");
	const offsetMinutes = Number(m[11] ?? "0");
	if (m[8] === undefined && (m[9] === undefined || offsetHours > 23 || offsetMinutes > 59)) return null;
	// Date.UTC maps years 0-99 to 1900-1999, so set the date before the time.
	const at = new Date(0);
	at.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	at.setUTCHours(hour, minute, second, fraction === undefined ? 0 : Math.trunc(Number(`0.${fraction}`) * 1000));
	// The offset is east of UTC: "+08:00" means the reading is 8 hours later than UTC.
	const east = m[9] === "-" ? -1 : 1;
	return new Date(at.getTime() - east * (offsetHours * 3600 + offsetMinutes * 60) * 1000);
}

/** Whether day's check-in went out or was quiet (checkin_state.go:66-68). */
export function finished(r: CheckinRecord, day: string): boolean {
	return r.day === day && (r.status === CHECKIN_SENT || r.status === CHECKIN_QUIET);
}

/**
 * Whether day is finished or being sent by someone within STALE_CLAIM_MS
 * (checkin_state.go:72-81). An `at` that does not parse is not taken.
 */
export function taken(r: CheckinRecord, day: string, now: Date): boolean {
	if (finished(r, day)) return true;
	if (r.day !== day || r.status !== CHECKIN_SENDING) return false;
	const at = parseStamp(r.at);
	return at !== null && now.getTime() - at.getTime() < STALE_CLAIM_MS;
}

/**
 * The first day the next check-in should ask about (checkin_state.go:87-96):
 * "" when there was none, a claim that may not have finished asks its own
 * window again, otherwise the last day it went out.
 */
export function nextSince(r: CheckinRecord): string {
	if (r.day === "") return "";
	if (r.status === CHECKIN_SENDING && r.since !== "") return r.since;
	return r.day;
}

/**
 * CheckinDue is Go's window (checkin_state.go:161-166): due from hh:mm in the
 * app's zone until CHECKIN_CUTOFF:00, so a missed morning goes out when the app
 * starts, and a day started after 20:00 is skipped.
 */
export function checkinDue(now: Date, hour: number, minute: number, timeZone: string): boolean {
	// The wall clock in timeZone, "YYYY-MM-DDTHH:MM:SS": fixed width, so string
	// order is the order of the readings.
	const wall = rfc3339(now, timeZone).slice(0, 19);
	const date = wall.slice(0, 10);
	const at = `${date}T${pad2(hour)}:${pad2(minute)}:00`;
	const cutoff = `${date}T${pad2(CHECKIN_CUTOFF)}:00:00`;
	return wall >= at && wall < cutoff;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Where the scheduled check-in goes (checkin.go:44-63): the saved chat, which
 * must be on the allowlist — every button press there would be refused
 * otherwise — else the first allowed group, else the first allowed person.
 */
export function checkinChat(cfg: Checkin, tg: Telegram): number {
	const id = chatID(cfg);
	if (id !== 0n) {
		if (userName(tg, id) !== null || groupAllowed(tg, id)) return Number(id);
		throw new Error(`the check-in chat ${formatInt64(id)} is not an allowed group or person (Settings → Telegram)`);
	}
	for (const g of tg.groups) {
		const parsed = parseInt64(g);
		if (parsed !== null) return Number(parsed);
	}
	for (const u of tg.users) {
		const parsed = parseInt64(u.id);
		if (parsed !== null) return Number(parsed);
	}
	throw new Error(ERR_NO_CHECKIN_CHAT);
}

/** Go's checkin.json, read and written with conditional puts. */
export class CheckinStore {
	private readonly store: ObjectStore;

	constructor(store: ObjectStore) {
		this.store = store;
	}

	/** The record and its ETag ("" and a zero record when there is none yet). */
	async load(): Promise<{ record: CheckinRecord; etag: string }> {
		let body: Uint8Array;
		let etag: string;
		try {
			({ body, etag } = await this.store.get(CHECKIN_KEY));
		} catch (err) {
			if (err instanceof NotFoundError) return { record: emptyRecord(), etag: "" };
			throw err;
		}
		return { record: decodeRecord(new TextDecoder().decode(body)), etag };
	}

	/**
	 * Takes day for this run, or answers null with the record as read when the
	 * day is already taken or another run won the conditional write.
	 */
	async claim(day: string, chat: string, now: Date): Promise<ClaimResult> {
		const prev = await this.load();
		if (taken(prev.record, day, now)) return { claim: null, prev: prev.record };
		let since = nextSince(prev.record);
		// Taking over a crashed claim: the same days, not an empty window.
		if (prev.record.day === day && prev.record.status === CHECKIN_SENDING) since = prev.record.since;
		const record: CheckinRecord = {
			schema: 1,
			day,
			status: CHECKIN_SENDING,
			since,
			at: goStamp(now),
			chat,
		};
		let etag: string;
		try {
			etag = await this.put(record, prev.etag);
		} catch (err) {
			if (err instanceof PreconditionError) return { claim: null, prev: prev.record };
			throw err;
		}
		return { claim: { record, prev: prev.record, etag }, prev: prev.record };
	}

	/** Marks the claimed day sent or quiet. */
	async finish(c: CheckinClaim, status: string, now: Date): Promise<void> {
		await this.put({ ...c.record, status, at: goStamp(now) }, c.etag);
	}

	/**
	 * Gives a claimed day back after a failed send: the previous record as it
	 * was, its time too, so a stale claim stays stale. With no previous record
	 * this writes an empty one (there is no conditional delete), which reads as
	 * "never sent".
	 */
	async release(c: CheckinClaim): Promise<void> {
		await this.put(c.prev, c.etag);
	}

	private async put(r: CheckinRecord, ifMatch: string): Promise<string> {
		const body = new TextEncoder().encode(encodeRecord(r));
		return await this.store.put(CHECKIN_KEY, body, ifMatch === "" ? null : ifMatch);
	}
}

/** Go's json.Marshal of CheckinRecord: field order, schema 1, omitempty on since and chat. */
function encodeRecord(r: CheckinRecord): string {
	const fields: (readonly [string, unknown])[] = [
		["schema", 1],
		["day", r.day],
		["status", r.status],
	];
	if (r.since !== "") fields.push(["since", r.since]);
	fields.push(["at", r.at]);
	if (r.chat !== "") fields.push(["chat", r.chat]);
	return goMarshal(new Ordered(fields));
}

/** Go's json.Unmarshal of CheckinRecord: unknown fields ignored, missing ones zero. */
function decodeRecord(text: string): CheckinRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`decode ${CHECKIN_KEY}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(
			`decode ${CHECKIN_KEY}: json: cannot unmarshal ${goJsonKind(raw)} into Go value of type telegram.CheckinRecord`,
		);
	}
	const o = raw as Record<string, unknown>;
	return {
		schema: intField(o, "schema"),
		day: strField(o, "day"),
		status: strField(o, "status"),
		since: strField(o, "since"),
		at: strField(o, "at"),
		chat: strField(o, "chat"),
	};
}

function strField(o: Record<string, unknown>, name: string): string {
	const v = o[name];
	if (v === undefined || v === null) return "";
	if (typeof v !== "string") throw fieldError(v, name, "string");
	return v;
}

function intField(o: Record<string, unknown>, name: string): number {
	const v = o[name];
	if (v === undefined || v === null) return 0;
	if (typeof v !== "number" || !Number.isInteger(v)) throw fieldError(v, name, "int");
	return v;
}

function fieldError(v: unknown, path: string, goType: string): Error {
	return new Error(
		`decode ${CHECKIN_KEY}: json: cannot unmarshal ${goJsonKind(v)} into Go struct field CheckinRecord.${path} of type ${goType}`,
	);
}

/** Go's wording for a value that does not fit the field. */
function goJsonKind(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	switch (typeof v) {
		case "string":
			return "string";
		case "boolean":
			return "bool";
		case "number":
			return "number";
		default:
			return "object";
	}
}

/**
 * The check-in against the durable agent: one delivery to a chat, the way the
 * adapter's `deliver` takes it. The adapter knows nothing of check-ins, so the
 * note rides in the same commit as the delivery (T5.1b).
 */
export type CheckinDeliver = (
	key: string,
	address: OutboxJson,
	parts: readonly OutboxJson[],
	options?: { note?: PendingNote },
) => Promise<void>;

/** What `/checkin` needs of the check-in: Go's `checkinCommand` (checkin.go:193-217). */
export interface CheckinSender {
	/** Sends the check-in to `chat` now, with the note, and never writes `checkin.json` (§13.5). */
	sendNow: (key: string, chat: number, send: (text: string) => Promise<void>) => Promise<void>;
}

/** The check-in as the rest of the app sees it. */
export interface CheckinService extends CheckinSender {
	/** The adapter's scheduled job (T5.1b): one tick, and the next target it answers. */
	spec: ScheduleSpec;
	/** Go's CheckinTick (checkin.go:337-415): one wall-clock pass. Answers the next target, epoch ms. */
	tick: () => Promise<number>;
	/** Go's CheckinView (checkin.go:434-474) in Go's field order, without `setting` (the server's). */
	status: () => Promise<Record<string, unknown>>;
}

/**
 * What the check-in reads of the settings: the setting, and the allowlist its chat
 * must be on. `SettingsService` is one; a test can hand in a narrower one, which is
 * how Go's `r.bot.Settings = broken` swaps a failing read in (checkin_test.go:534).
 */
export interface CheckinSettings {
	resolveCheckin: () => Promise<Checkin>;
	resolveTelegram: () => Promise<Telegram>;
}

export interface CheckinOptions {
	/** `checkin.json`: shared with the Go app and with production. */
	store: ObjectStore;
	settings: CheckinSettings;
	entries: EntriesService;
	deliver: CheckinDeliver;
	now: () => Date;
	/** The app's zone: every day and hour decision reads through it (Go's `loc`, checkin.go:35-40). */
	timeZone: string;
	log: Log;
}

/**
 * How long a failed or not-yet-possible pass waits before trying again: Go's tick
 * ran every minute, so one minute is its cadence (checkin.go:319-334).
 */
const RETRY_MS = 60_000;

/** The default time: what an `off` setting arms the next re-read at (T5-plan §2.2). */
const DEFAULT_TIME = parseCheckin("", "");

/**
 * createCheckin is Go's `Checkin` (checkin.go:20-22) plus the loop around it. The
 * per-process `checkinDay` and warn map Go kept on the Bot (bot.go:50-52) live in
 * this closure, so a restarted process checks the day again and the claim is what
 * still makes it once-only.
 *
 * The tick re-reads the setting and re-checks the due window on **every** wake:
 * the sleep is the adapter's `sleepUntil`, capped at fifteen minutes, and nothing
 * guarantees it elapses at the instant it was armed for (t5-spec §13.12). A sleep
 * armed for 09:30 that fires at 21:00 sends nothing and writes no record.
 */
export function createCheckin(o: CheckinOptions): CheckinService {
	const { settings, entries, deliver, now, timeZone, log } = o;
	const state = new CheckinStore(o.store);
	/** Go's checkinDay: the day this process finished. */
	let checkinDay = "";
	/** Go's checkinWarned/checkinWarnDay: one warning per kind and day. */
	let warned = new Set<string>();
	let warnDay = "";

	log.info("morning check-in loop running", { until: `${pad2(CHECKIN_CUTOFF)}:00` });

	/** The next target after a finished or skipped day: today's time if it is still ahead, else tomorrow's. */
	function nextTarget(at: Date, cfg: Checkin): number {
		// While off, the default time is when the setting is looked at again; the
		// fifteen-minute cap is the outer bound either way (T5-plan §2.2).
		const time = cfg.on ? cfg : DEFAULT_TIME;
		return nextRun(at, time.hour, time.minute, timeZone).getTime();
	}

	/** warnCheckin is Go's warnCheckin (checkin.go:419-431): one line per kind and day. */
	function warnCheckin(kind: string, day: string, msg: string, err: unknown): void {
		if (warnDay !== day) {
			// A new day: start over.
			warned = new Set();
			warnDay = day;
		}
		const key = `${kind} ${day}`;
		const warn = !warned.has(key);
		warned.add(key);
		if (warn) log.warn(msg, { err: errorMessage(err) });
	}

	/** sendCheckin is Go's sendCheckin (checkin.go:149-180) as one durable delivery with its note. */
	async function sendCheckin(key: string, chat: number, day: string, ag: Agenda): Promise<void> {
		const { parts, note } = checkinMessages(day, ag);
		const messages = parts.map((p): SendMessage => {
			const message: SendMessage = { chat_id: chat, text: p.text };
			if (p.keyboard !== null) message.reply_markup = p.keyboard;
			return message;
		});
		// No thread and no keyboard on the summary, exactly Go's plain SendMessage: the
		// address is the chat itself, not the message that happened to be last.
		await deliver(key, { chat, messageId: 0, group: false }, messages.map(replyPart), { note });
	}

	async function tick(): Promise<number> {
		const at = now();
		const today = calendarDay(at, timeZone);
		let cfg: Checkin;
		try {
			cfg = await settings.resolveCheckin();
		} catch (err) {
			// Never fall back to the defaults here: a check-in saved as Off (or to a
			// private chat) must not go to the group after one failed read
			// (checkin.go:344-353). The next wake tries again.
			warnCheckin("read", today, "morning check-in: couldn't read the settings; skipping this minute", err);
			return at.getTime() + RETRY_MS;
		}
		if (!cfg.on || !checkinDue(at, cfg.hour, cfg.minute, timeZone)) return nextTarget(at, cfg);
		if (checkinDay === today) return nextTarget(at, cfg);
		// Remember only a finished day: while someone else's claim is fresh, keep
		// checking, so a copy that crashed mid-send is taken over.
		const markFinished = (): void => {
			checkinDay = today;
		};
		let chat: number;
		try {
			chat = checkinChat(cfg, await settings.resolveTelegram());
		} catch (err) {
			// Not remembered as finished: fixing the allowlist on the web page lets it
			// go out the same day (checkin.go:369-374).
			warnCheckin("chat", today, "morning check-in can't go out until this is fixed", err);
			return at.getTime() + RETRY_MS;
		}
		let claimed: ClaimResult;
		try {
			claimed = await state.claim(today, String(chat), at);
		} catch (err) {
			log.warn("morning check-in: couldn't read or claim the day; will retry", { err: errorMessage(err) });
			return at.getTime() + RETRY_MS;
		}
		const claim = claimed.claim;
		if (claim === null) {
			// Someone else has the day. Only a finished day is this process's to remember.
			if (!finished(claimed.prev, today)) return at.getTime() + RETRY_MS;
			markFinished();
			return nextTarget(at, cfg);
		}
		const release = async (why: string, err: unknown): Promise<void> => {
			log.warn(`morning check-in: ${why}; will retry`, { err: errorMessage(err) });
			try {
				await state.release(claim);
			} catch (failure) {
				log.warn("morning check-in: couldn't give the day back; it can be retaken in 10 minutes", {
					err: errorMessage(failure),
				});
			}
		};
		let snap: Snapshot;
		try {
			snap = await entries.current();
		} catch (err) {
			await release("couldn't read the entries", err);
			return at.getTime() + RETRY_MS;
		}
		const ag = agenda(snap.doc, today, claim.record.since);
		if (isQuiet(ag)) {
			try {
				await state.finish(claim, CHECKIN_QUIET, now());
			} catch (err) {
				log.warn("morning check-in: couldn't record a quiet day", { err: errorMessage(err) });
			}
			log.info("morning check-in: nothing to report today", { day: today });
			markFinished();
			return nextTarget(at, cfg);
		}
		try {
			await sendCheckin(`tg:${chat}`, chat, today, ag);
		} catch (err) {
			await release("couldn't send it", err);
			return at.getTime() + RETRY_MS;
		}
		try {
			await state.finish(claim, CHECKIN_SENT, now());
		} catch (err) {
			log.warn("morning check-in sent but not recorded", { err: errorMessage(err) });
		}
		log.info("morning check-in sent", {
			day: today,
			chatId: chat,
			today: ag.today.length,
			asked: ag.ask.length,
			overdue: ag.overdue.length,
		});
		markFinished();
		return nextTarget(at, cfg);
	}

	async function sendNow(key: string, chat: number, send: (text: string) => Promise<void>): Promise<void> {
		let snap: Snapshot;
		try {
			snap = await entries.current();
		} catch {
			await send("Couldn't read the entries right now.");
			return;
		}
		const at = now();
		const today = calendarDay(at, timeZone);
		let since = "";
		// Days missed since the last check-in are asked about too (checkin.go:201-208);
		// a read failure here is ignored, as Go's is.
		try {
			const { record } = await state.load();
			const s = nextSince(record);
			if (s !== "" && s < addDays(today, -1)) since = s;
		} catch {
			// No record to widen the window with.
		}
		const ag = agenda(snap.doc, today, since);
		if (isQuiet(ag)) {
			await send("Nothing dated for today, and no open tasks from before.");
			return;
		}
		try {
			await sendCheckin(key, chat, today, ag);
		} catch (err) {
			// The user already saw whatever part went out (checkin.go:213-216).
			log.warn("telegram check-in failed", { chatId: chat, err: errorMessage(err) });
		}
	}

	async function status(): Promise<Record<string, unknown>> {
		// Go's CheckinStatus (checkin.go:448-474): the record as read, then the setting.
		let last: Record<string, unknown> | null = null;
		try {
			const { record } = await state.load();
			if (record.day !== "") last = recordJSON(record);
		} catch {
			// A load failure is ignored here: the page still shows the setting.
		}
		let cfg: Checkin;
		try {
			cfg = await settings.resolveCheckin();
		} catch (err) {
			// The view is returned before On/At/Chat are filled (:459-463).
			return viewJSON({ on: false, until: cutoffText(), error: errorMessage(err), last });
		}
		if (!cfg.on) return viewJSON({ on: false, until: cutoffText(), last });
		let chat: number;
		try {
			chat = checkinChat(cfg, await settings.resolveTelegram());
		} catch (err) {
			return viewJSON({ on: true, at: cfg.schedule, until: cutoffText(), error: errorMessage(err), last });
		}
		return viewJSON({ on: true, at: cfg.schedule, until: cutoffText(), chat: String(chat), last });
	}

	return {
		spec: { name: "checkin", run: async (): Promise<number> => await tick() },
		tick,
		status,
		sendNow,
	};
}

/** Go's `fmt.Sprintf("%02d:00", sched.CheckinCutoff)` (checkin.go:456). */
function cutoffText(): string {
	return `${pad2(CHECKIN_CUTOFF)}:00`;
}

/** CheckinView in Go's struct order: on, at, until, chat, error, last (checkin.go:434-445). */
function viewJSON(v: {
	on: boolean;
	at?: string;
	until: string;
	chat?: string;
	error?: string;
	last: Record<string, unknown> | null;
}): Record<string, unknown> {
	const out: Record<string, unknown> = { on: v.on };
	if (v.at !== undefined) out.at = v.at;
	out.until = v.until;
	if (v.chat !== undefined) out.chat = v.chat;
	if (v.error !== undefined) out.error = v.error;
	if (v.last !== null) out.last = v.last;
	return out;
}

/** CheckinRecord in Go's struct order, with omitempty on `since` and `chat` (checkin_state.go:31-41). */
function recordJSON(r: CheckinRecord): Record<string, unknown> {
	const out: Record<string, unknown> = { schema: r.schema, day: r.day, status: r.status };
	if (r.since !== "") out.since = r.since;
	out.at = r.at;
	if (r.chat !== "") out.chat = r.chat;
	return out;
}
