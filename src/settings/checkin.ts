// The morning check-in setting: a daily "HH:MM" in the app's time zone (or
// off) and the chat it goes to. Port of internal/settings/checkin.go, which
// parses the time with sched.Parse: that lives in ../sched.ts, the one home for
// an "HH:MM or off" setting.

import { ValidationError } from "../errors.ts";
import { goQuote, goTrimSpace } from "../gostr.ts";
import { errorMessage } from "../log.ts";
import { parseSchedule, type Schedule } from "../sched.ts";
import { formatInt64, parseInt64 } from "./text.ts";

/** The check-in time when nothing is set. */
export const DEFAULT_CHECKIN = "09:30";

/** The local hour after which a missed morning check-in is skipped for the day. */
export const CHECKIN_CUTOFF = 20;

/** The resolved setting. */
export interface Checkin {
	/** "HH:MM" in the app's time zone, or "off". */
	schedule: string;
	/** A chat ID, or "" for the first allowed group (else the first allowed person). */
	chat: string;
	fromEnv: boolean;
	on: boolean;
	hour: number;
	minute: number;
}

/** What the admin page sends. useEnv drops the saved section so the env applies again. */
export interface CheckinInput {
	schedule: string;
	chat: string;
	useEnv: boolean;
}

/** The `checkin` section of settings.json. */
export interface StoredCheckin {
	schedule: string;
	chat?: string;
	updated?: string;
	by?: string;
}

/** The setting as the admin page shows it. */
export interface CheckinSetting extends Checkin {
	updated?: string;
	by?: string;
	/** settings.json could not be read, so what is saved is unknown. */
	unreadable?: boolean;
}

/** chat as a number (0n for the default, which is not a chat ID). */
export function chatID(c: Checkin): bigint {
	return parseInt64(c.chat) ?? 0n;
}

/**
 * ParseCheckin checks and normalises a schedule (before the cutoff, or off) and
 * a chat ID ("" = the default).
 */
export function parseCheckin(schedule: string, chat: string): Checkin {
	let sched: Schedule;
	try {
		sched = parseSchedule("the check-in time", schedule, DEFAULT_CHECKIN);
	} catch (err) {
		throw new ValidationError(errorMessage(err));
	}
	if (sched.on && sched.hour >= CHECKIN_CUTOFF) {
		throw new ValidationError(`the check-in time must be before ${CHECKIN_CUTOFF}:00 (later ones are skipped)`);
	}
	const c: Checkin = {
		schedule: "off",
		chat: "",
		fromEnv: false,
		on: sched.on,
		hour: sched.hour,
		minute: sched.minute,
	};
	if (sched.on) c.schedule = `${String(sched.hour).padStart(2, "0")}:${String(sched.minute).padStart(2, "0")}`;
	const trimmed = goTrimSpace(chat);
	if (trimmed !== "") {
		const id = parseInt64(trimmed);
		if (id === null || id === 0n) {
			throw new ValidationError(`the check-in chat must be a Telegram chat ID (a number), not ${goQuote(trimmed)}`);
		}
		c.chat = formatInt64(id);
	}
	return c;
}
