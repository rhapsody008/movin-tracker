// The Telegram allowlist: who may talk to the bot and which groups it answers
// in. Port of internal/settings/telegram.go.
//
// IDs are strings so 64-bit Telegram IDs never pass through a JS number; the
// helpers take a bigint.

import { ValidationError } from "../errors.ts";
import { goFields, goQuote, goTrimSpace } from "../gostr.ts";
import { errorMessage } from "../log.ts";
import { formatInt64, parseInt64 } from "./text.ts";

/** One person allowed to talk to the bot. name is what the journal records as "by". */
export interface TelegramUser {
	id: string;
	name: string;
}

/** The resolved allowlist. An empty user list allows nobody. */
export interface Telegram {
	users: TelegramUser[];
	groups: string[];
	fromEnv: boolean;
}

/** The `telegram` section of settings.json. */
export interface StoredTelegram {
	users: TelegramUser[];
	groups: string[];
	updated?: string;
	by?: string;
}

/** What the admin page sends. useEnv drops the saved section so the env applies again. */
export interface TelegramInput {
	users: TelegramUser[];
	groups: string[];
	useEnv: boolean;
}

/** The allowlist as the admin page shows it. */
export interface TelegramView extends Telegram {
	updated?: string;
	by?: string;
}

export const MAX_TELEGRAM_USERS = 20;
export const MAX_TELEGRAM_GROUPS = 10;

/** The configured name for an allowed user. */
export function userName(t: Telegram, id: bigint): string | null {
	const s = formatInt64(id);
	for (const u of t.users) if (u.id === s) return u.name;
	return null;
}

/** Whether a group chat ID is on the list. */
export function groupAllowed(t: Telegram, id: bigint): boolean {
	const s = formatInt64(id);
	return t.groups.includes(s);
}

/** Go's utf8.RuneCountInString: code points, not UTF-16 units. */
function runeCount(s: string): number {
	return [...s].length;
}

/**
 * validTelegram normalises and checks a list: user IDs are positive integers,
 * group IDs negative ones (Telegram's convention), names 1-40 characters, no
 * duplicates — and two people may not share a name, because the name is what
 * the journal records as "by" and what /undo matches on.
 */
export function validTelegram(
	users: readonly TelegramUser[],
	groups: readonly string[],
): { users: TelegramUser[]; groups: string[] } {
	const outUsers: TelegramUser[] = [];
	const outGroups: string[] = [];
	const seen = new Set<string>();
	const names = new Set<string>();
	if (users.length > MAX_TELEGRAM_USERS) throw new ValidationError(`at most ${MAX_TELEGRAM_USERS} Telegram users`);
	if (groups.length > MAX_TELEGRAM_GROUPS) throw new ValidationError(`at most ${MAX_TELEGRAM_GROUPS} Telegram groups`);
	for (const u of users) {
		const typed = goTrimSpace(u.id);
		const parsed = parseInt64(typed);
		if (parsed === null || parsed <= 0n) {
			throw new ValidationError(`Telegram user ID ${goQuote(u.id)} must be a positive number`);
		}
		const id = formatInt64(parsed);
		const name = goFields(u.name).join(" ");
		const length = runeCount(name);
		if (length < 1 || length > 40) {
			throw new ValidationError(`name for Telegram user ${id} must be 1-40 characters`);
		}
		if (seen.has(id)) throw new ValidationError(`Telegram user ${id} is listed twice`);
		const folded = name.toLowerCase();
		if (names.has(folded)) {
			throw new ValidationError(`two Telegram users are named ${goQuote(name)}; give each a different name`);
		}
		seen.add(id);
		names.add(folded);
		outUsers.push({ id, name });
	}
	for (const g of groups) {
		const parsed = parseInt64(goTrimSpace(g));
		if (parsed === null || parsed >= 0n) {
			throw new ValidationError(`Telegram group ID ${goQuote(g)} must be a negative number (group IDs start with -)`);
		}
		const id = formatInt64(parsed);
		if (seen.has(id)) throw new ValidationError(`Telegram group ${id} is listed twice`);
		seen.add(id);
		outGroups.push(id);
	}
	return { users: outUsers, groups: outGroups };
}

/**
 * ParseTelegramEnv reads TELEGRAM_ALLOWED_IDS ("id=name,id2=name2"; a bare id
 * gets the id as its name) and TELEGRAM_ALLOWED_CHATS ("-100…,-100…").
 */
export function parseTelegramEnv(ids: string, chats: string): Telegram {
	const users: TelegramUser[] = [];
	for (const raw of ids.split(",")) {
		const part = goTrimSpace(raw);
		if (part === "") continue;
		const at = part.indexOf("=");
		const id = at === -1 ? part : part.slice(0, at);
		const given = at === -1 ? "" : part.slice(at + 1);
		const name = at === -1 || goTrimSpace(given) === "" ? id : given;
		users.push({ id: goTrimSpace(id), name });
	}
	const groups: string[] = [];
	for (const raw of chats.split(",")) {
		const g = goTrimSpace(raw);
		if (g !== "") groups.push(g);
	}
	try {
		const valid = validTelegram(users, groups);
		return { users: valid.users, groups: valid.groups, fromEnv: true };
	} catch (err) {
		throw new ValidationError(`TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS: ${errorMessage(err)}`);
	}
}
