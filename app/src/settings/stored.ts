// The shape of settings.json on disk: the decoded document (`stored` in
// settings.go, telegram.go and checkin.go) and the encoders that write one
// section back without touching the others (spec §1).
//
// Every llm field is optional, because "not in the file" is different from
// "set to the zero value": the file is layered over the env defaults field by
// field. A field of the wrong type makes the whole file unreadable, as Go's
// json.Unmarshal does.

import { Ordered } from "../gojson.ts";
import type { StoredCheckin } from "./checkin.ts";
import type { StoredTelegram } from "./telegram.ts";

/** The `llm` section: every field optional, absent means "env default". */
export interface StoredLLM {
	vision?: boolean;
	kind?: string;
	baseUrl?: string;
	apiKeyEnc?: string;
	model?: string;
	streaming?: boolean;
	thinkOnDemand?: boolean;
}

/** The decoded settings.json. Top-level updated/by mean "LLM last saved". */
export interface Stored {
	schema: number;
	llm?: StoredLLM;
	telegram?: StoredTelegram;
	checkin?: StoredCheckin;
	updated?: string;
	by?: string;
}

/** The empty document: no file yet, or an unreadable one. */
export function emptyStored(): Stored {
	return { schema: 0 };
}

/** decodeStored parses settings.json; a bad shape throws (Go's Unmarshal error). */
export function decodeStored(body: Uint8Array): Stored {
	const value: unknown = JSON.parse(new TextDecoder().decode(body));
	// Go unmarshals null into a struct without changing it and without error.
	if (value === null) return emptyStored();
	const o = object(value, "settings.json");
	return {
		schema: numberOr(o.schema, "schema") ?? 0,
		llm: o.llm === undefined ? undefined : decodeStoredLLM(o.llm),
		telegram: o.telegram === undefined ? undefined : decodeTelegram(o.telegram),
		checkin: o.checkin === undefined ? undefined : decodeCheckin(o.checkin),
		updated: stringOr(o.updated, "updated"),
		by: stringOr(o.by, "by"),
	};
}

/** decodeStoredLLM decodes an `llm` section, tolerating junk (Go ignores the error when re-reading it in a save). */
export function decodeStoredLLM(value: unknown): StoredLLM {
	const o = object(value, "llm");
	return {
		vision: boolOr(o.vision, "llm.vision"),
		kind: stringOr(o.kind, "llm.kind"),
		baseUrl: stringOr(o.baseUrl, "llm.baseUrl"),
		apiKeyEnc: stringOr(o.apiKeyEnc, "llm.apiKeyEnc"),
		model: stringOr(o.model, "llm.model"),
		streaming: boolOr(o.streaming, "llm.streaming"),
		thinkOnDemand: boolOr(o.thinkOnDemand, "llm.thinkOnDemand"),
	};
}

function decodeTelegram(value: unknown): StoredTelegram {
	const o = object(value, "telegram");
	const users = array(o.users, "telegram.users").map((u) => {
		const uo = object(u, "telegram.users[]");
		return { id: stringOr(uo.id, "telegram.users[].id") ?? "", name: stringOr(uo.name, "telegram.users[].name") ?? "" };
	});
	const groups = array(o.groups, "telegram.groups").map((g, i) => {
		if (typeof g !== "string") throw new TypeError(`telegram.groups[${i}]: not a string`);
		return g;
	});
	return {
		users,
		groups,
		updated: stringOr(o.updated, "telegram.updated"),
		by: stringOr(o.by, "telegram.by"),
	};
}

function decodeCheckin(value: unknown): StoredCheckin {
	const o = object(value, "checkin");
	return {
		schedule: stringOr(o.schedule, "checkin.schedule") ?? "",
		chat: stringOr(o.chat, "checkin.chat"),
		updated: stringOr(o.updated, "checkin.updated"),
		by: stringOr(o.by, "checkin.by"),
	};
}

// fieldOf drops the undefined fields, so omitempty behaves and the order of the
// struct's fields is the order the Go source has.
function fieldOf(entries: readonly (readonly [string, unknown])[]): Ordered {
	return new Ordered(entries.filter(([, v]) => v !== undefined));
}

/** The llm section in storedLLM's field order; apiKeyEnc is left out when there is no key. */
export function encodeLLM(l: StoredLLM): Ordered {
	return fieldOf([
		["vision", l.vision],
		["kind", l.kind],
		["baseUrl", l.baseUrl],
		["apiKeyEnc", l.apiKeyEnc],
		["model", l.model],
		["streaming", l.streaming],
		["thinkOnDemand", l.thinkOnDemand],
	]);
}

/** The telegram section in storedTelegram's field order. */
export function encodeTelegram(t: StoredTelegram): Ordered {
	return fieldOf([
		[
			"users",
			t.users.map(
				(u) =>
					new Ordered([
						["id", u.id],
						["name", u.name],
					]),
			),
		],
		["groups", [...t.groups]],
		["updated", t.updated],
		["by", t.by],
	]);
}

/** The checkin section in storedCheckin's field order (chat is omitempty). */
export function encodeCheckin(c: StoredCheckin): Ordered {
	return fieldOf([
		["schedule", c.schedule],
		["chat", c.chat === "" ? undefined : c.chat],
		["updated", c.updated],
		["by", c.by],
	]);
}

function object(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${what}: not an object`);
	return value as Record<string, unknown>;
}

function array(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) throw new TypeError(`${what}: not an array`);
	return value;
}

function stringOr(value: unknown, what: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new TypeError(`${what}: not a string`);
	return value;
}

function boolOr(value: unknown, what: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new TypeError(`${what}: not a boolean`);
	return value;
}

function numberOr(value: unknown, what: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number") throw new TypeError(`${what}: not a number`);
	return value;
}
