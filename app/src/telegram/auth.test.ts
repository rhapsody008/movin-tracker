// Go's authorise and its rejected list (src/telegram/auth.ts): the decision
// table of bot_test.go's TestAuthorisation, the display name the admin page
// shows, the bounded newest-first list, and the row an upgraded group leaves.
import { describe, expect, it } from "vitest";
import type { Telegram } from "../settings/telegram.ts";
import {
	addRejected,
	authorise,
	displayName,
	MAX_REJECTED,
	MIGRATION_REASON,
	migratedChat,
	type Rejected,
	rejectionOf,
} from "./auth.ts";
import type { Chat, Message, User } from "./client.ts";

const ALLOW: Telegram = {
	users: [
		{ id: "111", name: "ZY" },
		{ id: "222", name: "Partner" },
	],
	groups: ["-1001"],
	fromEnv: true,
};

const ZY = 111;
const PARTNER = 222;
const STRANGER = 333;
const GROUP = -1001;
const OTHER_GROUP = -2002;

function person(id: number, first = "Zhou", extra: Partial<User> = {}): User {
	return { id, is_bot: false, first_name: first, last_name: "", username: "", ...extra };
}

function chat(id: number, type: string, title = ""): Chat {
	return { id, type, title, username: "", first_name: "" };
}

function verdictOf(allow: Telegram, c: Chat, from: User | undefined): string {
	const auth = authorise(allow, c, from);
	return auth.ok ? auth.name : `refused: ${auth.reason}`;
}

describe("TestAuthorisation", () => {
	it("allows a listed user privately and needs the chat to be that user", () => {
		expect(verdictOf(ALLOW, chat(ZY, "private"), person(ZY))).toBe("ZY");
		// Go's `chat.ID != from.ID` (bot.go:258): a private update cannot pretend.
		expect(verdictOf(ALLOW, chat(PARTNER, "private"), person(ZY))).toBe("refused: user not on the allowlist");
		expect(verdictOf(ALLOW, chat(STRANGER, "private"), person(STRANGER))).toBe("refused: user not on the allowlist");
	});

	it("needs the group and the person in a group, and refuses an unlisted group first", () => {
		expect(verdictOf(ALLOW, chat(GROUP, "supergroup", "Reno"), person(PARTNER, "P"))).toBe("Partner");
		expect(verdictOf(ALLOW, chat(GROUP, "group", "Reno"), person(ZY))).toBe("ZY");
		expect(verdictOf(ALLOW, chat(OTHER_GROUP, "supergroup", "Other"), person(ZY))).toBe(
			"refused: group not on the allowlist",
		);
		// The stranger in the allowed group: the group check passes, the person does not.
		expect(verdictOf(ALLOW, chat(GROUP, "supergroup", "Reno"), person(STRANGER, "Stranger"))).toBe(
			"refused: user not on the allowlist",
		);
	});

	it("refuses a bot, a missing sender and any other chat type", () => {
		expect(verdictOf(ALLOW, chat(ZY, "private"), undefined)).toBe("refused: not from a person");
		expect(verdictOf(ALLOW, chat(ZY, "private"), person(ZY, "Zhou", { is_bot: true }))).toBe(
			"refused: not from a person",
		);
		// Trap 25: IsGroup excludes a channel, and a channel has no way in.
		expect(verdictOf(ALLOW, chat(-3003, "channel", "News"), person(ZY))).toBe("refused: unsupported chat type channel");
		expect(verdictOf(ALLOW, chat(GROUP, "s"), person(ZY))).toBe("refused: unsupported chat type s");
	});

	it("allows nobody when the user list is empty", () => {
		const empty: Telegram = { users: [], groups: [String(GROUP)], fromEnv: true };
		expect(verdictOf(empty, chat(GROUP, "supergroup"), person(ZY))).toBe("refused: user not on the allowlist");
	});
});

describe("the rejected list", () => {
	const at = new Date("2026-11-22T10:00:00Z");

	it("keeps Go's newest-first rows under the configured name, with the ids as text", () => {
		const row = rejectionOf(
			chat(GROUP, "supergroup", "Reno"),
			person(STRANGER, "Stranger", { username: "stranger" }),
			"user not on the allowlist",
			at,
		);
		expect(row).toEqual({
			chatId: "-1001",
			chatType: "supergroup",
			chatTitle: "Reno",
			fromId: "333",
			fromName: "Stranger (@stranger)",
			reason: "user not on the allowlist",
			at,
		});
		// No title, no sender: Go's omitempty on both, and the id as the empty value.
		expect(rejectionOf(chat(-1001, "supergroup"), undefined, "unsupported chat type channel", at)).toEqual({
			chatId: "-1001",
			chatType: "supergroup",
			fromId: "0",
			reason: "unsupported chat type channel",
			at,
		});
	});

	it("prepends, dedupes one person in one chat and keeps at most 10 rows", () => {
		let rows: Rejected[] = [];
		for (let i = 0; i < 12; i++)
			rows = addRejected(
				rows,
				rejectionOf(chat(GROUP, "supergroup"), person(100 + i), "user not on the allowlist", at),
			);

		expect(rows).toHaveLength(MAX_REJECTED);
		// Newest first: the twelfth person is the first row, the second is gone.
		expect(rows.map((row) => row.fromId)).toEqual([
			"111",
			"110",
			"109",
			"108",
			"107",
			"106",
			"105",
			"104",
			"103",
			"102",
		]);

		// The same person again moves to the front instead of appearing twice.
		rows = addRejected(rows, rejectionOf(chat(GROUP, "supergroup"), person(105), "user not on the allowlist", at));
		expect(rows.filter((row) => row.fromId === "105")).toHaveLength(1);
		expect(rows[0]?.fromId).toBe("105");
		expect(rows).toHaveLength(MAX_REJECTED);
	});

	it("records an upgraded group's new chat id, as a supergroup with the old title", () => {
		const message: Message = {
			message_id: 5,
			chat: chat(GROUP, "group", "Reno"),
			date: 1,
			text: "",
			caption: "",
			photo: [],
			migrate_to_chat_id: -1001234,
		};
		const row = rejectionOf(migratedChat(message), person(ZY), MIGRATION_REASON, at);
		expect(row).toMatchObject({
			chatId: "-1001234",
			chatType: "supergroup",
			chatTitle: "Reno",
			fromId: "111",
			reason: MIGRATION_REASON,
		});
		expect(MIGRATION_REASON).toBe("group upgraded: new chat ID");
	});
});

describe("displayName", () => {
	it("is Go's name and username with the brackets it writes", () => {
		expect(displayName(person(1, "Zhou", { username: "zhou" }))).toBe("Zhou (@zhou)");
		expect(displayName(person(1, "Zhou", { last_name: " Yi " }))).toBe("Zhou  Yi");
		expect(displayName(undefined)).toBe("");
		// Go's TrimSpace over the joined pair: a missing first name leaves no space.
		expect(displayName({ id: 1, is_bot: false, first_name: "", last_name: "Yi", username: "" })).toBe("Yi");
	});
});
