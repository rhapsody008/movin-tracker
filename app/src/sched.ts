// The app's daily schedules: "HH:MM" on a 24-hour clock in the app's time
// zone, or off; when such a schedule next fires; and the day arithmetic the
// check-in and the documents sync share. Port of internal/sched/sched.go,
// which is the one place Go parses a schedule: the check-in setting
// (internal/settings/checkin.go), DOCS_SYNC_SCHEDULE (internal/config,
// internal/docs/schedule.go) and the Telegram loops all call it.
//
// Time zone work is Intl's: a wall-clock reading in a zone and the instant it
// stands for are converted in both directions here, so nextRun can answer
// across a daylight-saving change (Europe/London 2026: 03:00 local is 03:00Z
// in winter and 02:00Z in summer).

import { goQuote, goTrimSpace } from "./gostr.ts";
import { parseInt64 } from "./settings/text.ts";

/** A parsed schedule: a 24-hour clock reading, or off. */
export interface Schedule {
	hour: number;
	minute: number;
	on: boolean;
}

/**
 * Parse reads one schedule variable: "HH:MM" (24 h) or off/none/false,
 * trimmed and case-folded; an empty value takes the default. name is the
 * variable, for the error message, which quotes what was typed.
 */
export function parseSchedule(name: string, s: string, def: string): Schedule {
	let v = goTrimSpace(s).toLowerCase();
	if (v === "off" || v === "none" || v === "false") return { hour: 0, minute: 0, on: false };
	if (v === "") v = def;
	const at = v.indexOf(":");
	const h = at === -1 ? "" : v.slice(0, at);
	const m = at === -1 ? "" : v.slice(at + 1);
	const hh = atoi(h);
	const mm = atoi(m);
	if (hh === null || mm === null || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
		throw new Error(`${name} must be HH:MM (24 h) or off, not ${goQuote(v)}`);
	}
	return { hour: hh, minute: mm, on: true };
}

// strconv.Atoi: an optionally signed run of decimal digits; null where Go errors.
function atoi(s: string): number | null {
	const n = parseInt64(s);
	return n === null || n > 2n ** 31n - 1n || n < -(2n ** 31n) ? null : Number(n);
}

/**
 * NextRun is the next time after now that the clock in timeZone shows
 * hour:minute: today when that is still ahead, otherwise tomorrow (so at
 * exactly 03:00 the next run is tomorrow's).
 */
export function nextRun(now: Date, hour: number, minute: number, timeZone: string): Date {
	const wall = wallClock(now.getTime(), timeZone);
	let next = instantOf(wall.year, wall.month, wall.day, hour, minute, timeZone);
	if (next <= now.getTime()) next = instantOf(wall.year, wall.month, wall.day + 1, hour, minute, timeZone);
	return new Date(next);
}

/** Day is now's calendar day in timeZone (YYYY-MM-DD). */
export function day(now: Date, timeZone: string): string {
	const w = wallClock(now.getTime(), timeZone);
	return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}`;
}

const dateRe = /^\d{4}-\d{2}-\d{2}$/;

function isLeapYear(year: number): boolean {
	return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
	if (month === 2) return isLeapYear(year) ? 29 : 28;
	if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
	return 31;
}

/**
 * ValidDate is Go's time.Parse("2006-01-02") check: the shape first, then a real
 * date, so 2026-02-30 is refused; Date.parse would silently roll it over to March.
 */
export function validDate(s: string): boolean {
	if (!dateRe.test(s)) return false;
	const month = Number(s.slice(5, 7));
	const day = Number(s.slice(8, 10));
	if (month < 1 || month > 12) return false;
	return day >= 1 && day <= daysInMonth(Number(s.slice(0, 4)), month);
}

/**
 * AddDays moves a YYYY-MM-DD day by n days and returns "" for a day that is not
 * valid. Go parses the day and calls AddDate, which normalises across month and
 * year ends; Date.UTC normalises the same way for date-only values.
 */
export function addDays(day: string, n: number): string {
	if (!validDate(day)) return "";
	// Date.UTC maps years 0-99 to 1900-1999, so set the date before shifting.
	const t = new Date(0);
	t.setUTCFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
	t.setUTCDate(t.getUTCDate() + n);
	return t.toISOString().slice(0, 10);
}

/**
 * Rfc3339 formats an instant the way Go's time.Format(time.RFC3339) does in a
 * zone: "2026-11-11T03:00:00+08:00", or "…Z" for UTC. Every stored stamp is
 * UTC (goStamp in docs/index.ts); this one is for a time the logs show in the
 * app's own zone.
 */
export function rfc3339(at: Date, timeZone: string): string {
	const w = wallClock(at.getTime(), timeZone);
	const offset = Math.trunc(offsetMs(at.getTime(), timeZone) / 1000);
	const zone = offset === 0 ? "Z" : `${offset < 0 ? "-" : "+"}${hoursMinutes(Math.abs(offset))}`;
	return `${pad(w.year, 4)}-${pad(w.month, 2)}-${pad(w.day, 2)}T${hhmmss(w.hour * 3600 + w.minute * 60 + w.second)}${zone}`;
}

/** A wall-clock reading in a zone. */
interface Wall {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

// One formatter per zone: building them is not free and the sync re-arms often.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	const known = formatters.get(timeZone);
	if (known !== undefined) return known;
	const f = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23", // not h24, which prints midnight as 24
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	formatters.set(timeZone, f);
	return f;
}

/** What the clock in timeZone shows at instant t. */
function wallClock(t: number, timeZone: string): Wall {
	const parts = formatter(timeZone).formatToParts(t);
	const field = (type: string): number => {
		const found = parts.find((p) => p.type === type);
		return found === undefined ? 0 : Number(found.value);
	};
	return {
		year: field("year"),
		month: field("month"),
		day: field("day"),
		hour: field("hour"),
		minute: field("minute"),
		second: field("second"),
	};
}

/** The zone's offset at instant t, in milliseconds east of UTC. */
function offsetMs(t: number, timeZone: string): number {
	const w = wallClock(t, timeZone);
	return utcMillis(w.year, w.month, w.day, w.hour, w.minute, w.second) - t;
}

/**
 * The instant at which the clock in timeZone shows y-mo-d hh:mm:00. The offset
 * is looked up twice, because the offset itself depends on the instant (that
 * is what moves it across a daylight-saving change).
 */
function instantOf(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
	const wall = utcMillis(year, month, day, hour, minute, 0);
	const first = wall - offsetMs(wall, timeZone);
	return wall - offsetMs(first, timeZone);
}

function utcMillis(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
	const t = new Date(0); // year 0-99 would map to 1900-1999, so set the year first
	t.setUTCFullYear(year, month - 1, day);
	t.setUTCHours(hour, minute, second, 0);
	return t.getTime();
}

/** An offset's hours and minutes as +HH:MM shows them. */
function hoursMinutes(seconds: number): string {
	return `${pad(Math.trunc(seconds / 3600), 2)}:${pad(Math.trunc((seconds % 3600) / 60), 2)}`;
}

/** Seconds of a day as HH:MM:SS, as Go's 15:04:05 lays it out. */
function hhmmss(seconds: number): string {
	const h = Math.trunc(seconds / 3600);
	const m = Math.trunc((seconds % 3600) / 60);
	return `${pad(h, 2)}:${pad(m, 2)}:${pad(seconds % 60, 2)}`;
}

function pad(n: number, width: number): string {
	return String(n).padStart(width, "0");
}
