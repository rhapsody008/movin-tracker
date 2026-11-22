// T5.2: the two document behaviours outside the sync engine itself — the
// Telegram "Documents updated" group notice, ported from
// internal/telegram/docs.go (`DocsChanged`, :18-37), and the daily run as a
// durable `movin.schedule` spec (T5-plan §4 T5.2), Go's daily timer in
// internal/docs/schedule.go (:16-61) with the sleep owned by the agent instead
// of the process.
//
// The notifier is the syncer's `Notifier` (sync.ts:59-62). The syncer calls it
// only after a run that changed something, and never for the first import
// (sync.go:264-266), so nothing here decides that: it only fans the one notice
// out. Go sent it straight from the bot; every send in v3 is a durable delivery
// (plan.md:77), one per configured group, so a crash after the index write still
// announces the change. The startup sync runs before the agent opens (main.ts),
// so a notice raised then is held — at most MAX_HELD_NOTICES — and sent on
// `attach`. A notice is a plain group message with no keyboard and no note, so
// it enters no chat's model context, as Go's did not enter its history.
//
// The spec is the daily run only: the startup sync and the minute refresh stay
// in-process (`docs/schedule.ts` with `daily: false`), because the daily one is
// the run a restart could skip. A run syncs only once the clock has reached the
// target the task stored, so waking early (the 15-minute sleep cap) or after a
// restart (the clock moved past it) does the right thing either way.

import type { Doc, Sync } from "../docs/index.ts";
import { DEFAULT_SYNC_SCHEDULE } from "../docs/schedule.ts";
import type { Notifier, Syncer } from "../docs/sync.ts";
import type { OutboxJson, ScheduleSpec } from "../durable/adapter.ts";
import { errorMessage, type Log } from "../log.ts";
import { nextRun, parseSchedule, rfc3339 } from "../sched.ts";
import type { Telegram } from "../settings/telegram.ts";
import { parseInt64 } from "../settings/text.ts";
import { counts, docList, SYNC_REASON_PREFIX } from "../telegram/commands.ts";
import { textMessages } from "../telegram/format.ts";
import { replyPart } from "../telegram/outbox.ts";

/** Go's docList cap in the notice (docs.go:21). */
const NOTICE_DOCS = 10;

/** How many notices are held before the agent opens; only the startup sync raises one. */
const MAX_HELD_NOTICES = 8;

/** A day, for the `off` case of the spec (the 15-minute cap bounds it either way). */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What the notice reads of the settings: the groups it goes to. `SettingsService`
 * is one; a test can hand in a narrower one, as `CheckinSettings` does (T5.1c).
 */
export interface DocsNotifierSettings {
	resolveTelegram(): Promise<Telegram>;
}

export interface DocsNotifierOptions {
	settings: DocsNotifierSettings;
	log: Log;
}

/** The agent's `deliver`, once it is open: a notice is one durable delivery per group. */
export type DocsDeliver = (key: string, address: OutboxJson, parts: readonly OutboxJson[]) => Promise<void>;

/** The syncer's notifier plus the agent's half: `attach` starts sending (T5-plan §4 T5.2). */
export interface DocsNotifier extends Notifier {
	/** Sends what was held, and everything after it: call once the agent is open. */
	attach(deliver: DocsDeliver): void;
}

/** One notice's two inputs, held until the agent can deliver it. */
interface Notice {
	result: Sync;
	changed: Doc[];
}

/**
 * createDocsNotifier is Go's `(*Bot).DocsChanged` (docs.go:18-37). The text is
 * Go's byte for byte — `counts` and `docList` are the same two formatters
 * `/sync` uses — and a sync a chat asked for (`telegram:<id>`) is skipped for
 * that chat because its reply is all it gets.
 */
export function createDocsNotifier(o: DocsNotifierOptions): DocsNotifier {
	const { settings, log } = o;
	let deliver: DocsDeliver | null = null;
	const held: Notice[] = [];
	/** One notice at a time: Go sent inside the run, so later changes never overtake. */
	let chain: Promise<void> = Promise.resolve();

	function docsChanged(result: Sync, changed: Doc[]): void {
		if (deliver === null) {
			held.push({ result, changed });
			// A bound, not an expectation: the only pre-attach notice is the startup
			// sync's, and the newest is the one worth keeping.
			if (held.length > MAX_HELD_NOTICES) held.shift();
			return;
		}
		queue(deliver, { result, changed });
	}

	function queue(put: DocsDeliver, notice: Notice): void {
		// send never rejects: every failure below is logged and skipped.
		chain = chain.then(() => send(put, notice));
	}

	async function send(put: DocsDeliver, notice: Notice): Promise<void> {
		const text = `Documents updated: ${counts(notice.result)}\n${docList(notice.changed, NOTICE_DOCS)}`;
		// Go's syncReasonPrefix (docs.go:14): the chat that asked for this sync.
		const skip = notice.result.reason.startsWith(SYNC_REASON_PREFIX)
			? notice.result.reason.slice(SYNC_REASON_PREFIX.length)
			: "";
		let groups: readonly string[];
		try {
			groups = (await settings.resolveTelegram()).groups;
		} catch (err) {
			// Go resolved the allowlist synchronously; a failed read is v3's only new case.
			log.warn("telegram documents notice failed", { err: errorMessage(err) });
			return;
		}
		for (const group of groups) {
			if (group === skip) continue;
			const id = parseInt64(group);
			if (id === null) continue;
			const chat = Number(id);
			// Go's plain SendMessage: no keyboard, no thread (messageId 0 is never sent).
			const messages = textMessages(text, { chat, messageId: 0, group: true });
			try {
				await put(`tg:${chat}`, { chat, messageId: 0, group: true }, messages.map(replyPart));
			} catch (err) {
				// One group's failure must not stop the others (docs.go:35-37).
				log.warn("telegram documents notice failed", { chatId: chat, err: errorMessage(err) });
			}
		}
	}

	return {
		docsChanged,
		attach: (put: DocsDeliver): void => {
			deliver = put;
			for (const notice of held.splice(0)) queue(put, notice);
		},
	};
}

export interface DocsyncOptions {
	/** The sync the daily run performs: the app's one `Syncer`. */
	syncer: Pick<Syncer, "sync">;
	/** DOCS_SYNC_SCHEDULE as written: HH:MM in timeZone, or off. */
	schedule: string;
	/** The zone the schedule's clock is read in (Go's `loc`). */
	timeZone: string;
	now: () => Date;
	log: Log;
}

/**
 * docsyncSpec is the daily half of Go's `Background` (:16-61) as a schedule spec:
 * the target the task stored is Go's armed timer. `run` syncs with reason
 * "daily" only once the clock has reached that target, then answers the next
 * wall-clock time in the app's zone, so a run that finishes at 23:59 still
 * targets 03:00 the next morning, and a task reopened after 03:00 runs the day
 * it slept through. `off` arms no daily run at all: startup and the minute
 * refresh still happen (docs/schedule.ts).
 */
export function docsyncSpec(o: DocsyncOptions): ScheduleSpec {
	const at = parseSchedule("DOCS_SYNC_SCHEDULE", o.schedule, DEFAULT_SYNC_SCHEDULE);
	return {
		name: "docsync",
		run: async ({ target, signal }) => {
			const from = o.now();
			if (at.on && target !== null && from.getTime() >= target) {
				try {
					await o.syncer.sync("daily", signal);
				} catch (err) {
					// Go logged this and armed the next timer (:55-57): a failed night is
					// not a reason to stop, and the spec must not throw (a faulted task
					// would never wake again). A shutdown's own cancelled sync is not a
					// failure: Go logged nothing when `ctx.Err()` was set (:55).
					if (signal?.aborted !== true) {
						o.log.warn("daily document sync failed", { err: errorMessage(err) });
					}
				}
			}
			const now = o.now();
			if (!at.on) return now.getTime() + DAY_MS;
			const next = nextRun(now, at.hour, at.minute, o.timeZone);
			// Go logged this once per armed timer (:45). The 15-minute wakes answer the
			// same target, so only a new one is news.
			if (next.getTime() !== target) {
				o.log.info("next daily document sync", { at: rfc3339(next, o.timeZone) });
			}
			return next.getTime();
		},
	};
}
