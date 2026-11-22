// Who may talk to the bot, and the list of those it ignored: Go's `authorise`,
// `reject`, `displayName` and the group-to-supergroup migration row
// (internal/telegram/bot.go:238-274, :276-292, :300-304).
//
// Pure functions over the resolved allowlist, so both auth checks — the poll's
// (`dispatch`) and the worker's (`handle`) — are one rule, and the admin page's
// rejected rows are built the same way wherever they come from.
//
// The allowlist is Go's `settings.Telegram` (src/settings/telegram.ts): a private
// chat needs an allowed user, a group needs the group **and** the user, and
// anything else — a channel, a chat type this port does not know — is refused
// with `unsupported chat type <type>` (spec §3.1).

import { goTrimSpace } from "../gostr.ts";
import { groupAllowed, type Telegram, userName } from "../settings/telegram.ts";
import { type Chat, isGroupChat, type Message, type User } from "./client.ts";

/** Go's maxRejected (bot.go:86): the operator's aid is bounded. */
export const MAX_REJECTED = 10;

/** Go's toast for a person who is not on the list (bot.go:315-317, :540). */
export const NOT_ON_LIST_TOAST = "You're not on this bot's list.";

/** Why a service message about a group upgrade is in the rejected list (bot.go:303). */
export const MIGRATION_REASON = "group upgraded: new chat ID";

/** Go's log line for a group that became a supergroup (bot.go:301). */
export const MIGRATION_LOG =
	"telegram group was upgraded to a supergroup; its chat ID changed. Add the new ID on the admin page.";

/** What `authorise` decided: the configured name, or Go's reason for a refusal. */
export type Auth = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Go's authorise (bot.go:252-274), in Go's order: a person at all, then the
 * user, the group, and the chat type. In a private chat the sender must be the
 * chat itself, so a forwarded or asymmetric update cannot masquerade (trap 12).
 */
export function authorise(allow: Telegram, chat: Chat, from: User | undefined): Auth {
	if (from === undefined || from.is_bot) return { ok: false, reason: "not from a person" };
	const name = userName(allow, BigInt(from.id));
	if (chat.type === "private") {
		if (name === null || chat.id !== from.id) return { ok: false, reason: "user not on the allowlist" };
		return { ok: true, name };
	}
	if (isGroupChat(chat)) {
		if (!groupAllowed(allow, BigInt(chat.id))) return { ok: false, reason: "group not on the allowlist" };
		if (name === null) return { ok: false, reason: "user not on the allowlist" };
		return { ok: true, name };
	}
	return { ok: false, reason: `unsupported chat type ${chat.type}` };
}

/** One chat or person the bot ignored, as the admin page shows it (bot.go:62-72). */
export interface Rejected {
	/** Go's `chatId,string`: the int64 as text, so the page can offer to add it. */
	chatId: string;
	chatType: string;
	chatTitle?: string;
	fromId: string;
	fromName?: string;
	reason: string;
	at: Date;
}

/**
 * Go's displayName (bot.go:238-250): the first and last name trimmed, then the
 * username in brackets when there is one.
 */
export function displayName(from: User | undefined): string {
	if (from === undefined) return "";
	let name = goTrimSpace(`${from.first_name} ${from.last_name}`);
	if (from.username !== "") name += ` (@${from.username})`;
	return name;
}

/** rejectionOf builds the row Go's reject records (bot.go:276-283). */
export function rejectionOf(chat: Chat, from: User | undefined, reason: string, at: Date): Rejected {
	const row: Rejected = { chatId: `${chat.id}`, chatType: chat.type, fromId: "0", reason, at };
	if (chat.title !== "") row.chatTitle = chat.title;
	if (from !== undefined) {
		row.fromId = `${from.id}`;
		const name = displayName(from);
		if (name !== "") row.fromName = name;
	}
	return row;
}

/**
 * addRejected is Go's list update (bot.go:284-290): the new row first, then the
 * older ones, at most MAX_REJECTED, dropping any older row for the same person
 * in the same chat — so a double rejection of one update is one row.
 */
export function addRejected(rows: readonly Rejected[], row: Rejected): Rejected[] {
	const out = [row];
	for (const older of rows) {
		if (out.length >= MAX_REJECTED) break;
		if (older.chatId === row.chatId && older.fromId === row.fromId) continue;
		out.push(older);
	}
	return out;
}

/**
 * migratedChat is the chat Go's reject is called with for a group upgrade
 * (bot.go:302-304): the **new** id, as a supergroup, carrying the old title — the
 * old chat is on the list and the new one is not, so the operator has to see it
 * and add it.
 */
export function migratedChat(message: Message): Chat {
	return {
		id: message.migrate_to_chat_id,
		type: "supergroup",
		title: message.chat.title,
		username: "",
		first_name: "",
	};
}
