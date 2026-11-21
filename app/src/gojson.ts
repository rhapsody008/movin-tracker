// Go-compatible JSON text: every file this app writes must be byte-identical to
// the one the Go app writes, because both are live against the same bucket
// (rollback, side-by-side reads, diff-based checks).
//
// Byte-identical means, against Go's encoding/json:
// - compact output (goMarshal), no trailing newline;
// - strings escaped the way Go escapes them: `"`, `\`, the control characters,
//   and — the part JSON.stringify does not do — HTML escaping of `<`, `>`, `&`,
//   U+2028 and U+2029 (Go's SetEscapeHTML default);
// - struct order for anything encoded from a struct (an Ordered), and only
//   there: a plain object would be a Go map, whose keys are sorted;
// - MarshalIndent's layout for settings.json and docs/index.json: two spaces a
//   level, one element a line, `{}` and `[]` inline, `": "` after a key;
// - a raw section (text the file had, as Go's json.RawMessage) is compacted,
//   HTML-escaped and then re-indented, keeping its own key order, its number
//   literals (`1.50`, `12345678901234567890`) and its escape spellings.
//
// Compared with Go on this Go version: compact output, no trailing newline;
// control characters (< 0x20, escaped as \b \f \n \r \t and \u00XX); `"` and
// `\`; U+007F, U+0085, U+00A0 and U+FEFF (raw in both); non-BMP characters (raw
// UTF-8 in both); and the numbers 18000, 5400.5, 0.1, 1e21, 1e-7, 123456789012,
// 0, 1e20, 1e-6, 1.5e-8, 2.5e21 and 0.30000000000000004 (same shortest
// round-trip digits and exponent form).
//
// Known differences, not coded around:
// - -0: Go writes -0, JSON.stringify writes 0.
// - a lone surrogate in a struct field: JSON.stringify writes the \udXXX escape,
//   Go parses the escape to U+FFFD and writes that (a UTF-8 string can hold the
//   escape but not the surrogate). A lone surrogate escape inside a raw section
//   is kept as written by both.
// - ordering the keys of a Go map takes byte order; compareBytes does that.
// - a UTF-8 BOM: Go's Unmarshal refuses the file, so Go's modify logs
//   "replacing unreadable settings.json" and writes the whole file again,
//   dropping every section it did not own. TextDecoder strips the BOM before
//   the scanner sees it, so this side keeps the sections. Decided: keeping them
//   is the safer behaviour, and it loses nothing.
// - invalid UTF-8 inside a string: Go keeps the raw bytes (its output is not
//   valid UTF-8 either), while TextDecoder answers U+FFFD and this side writes
//   that. Both then read back the same text.

import { compareBytes } from "./gostr.ts";

/** Go's HTML escaping. Those five characters occur only inside strings. */
const ESCAPES: Record<string, string> = {
	"&": "\\u0026",
	"<": "\\u003c",
	">": "\\u003e",
	"\u2028": "\\u2028",
	"\u2029": "\\u2029",
};

const HTML = /[&<>\u2028\u2029]/g;

function escapedChar(c: string): string {
	return ESCAPES[c] ?? c;
}

/** JSON.stringify's string output with Go's HTML escaping on top. */
function escapeString(s: string): string {
	return JSON.stringify(s).replace(HTML, escapedChar);
}

/**
 * json.Marshal(v): compact, Go-escaped, no trailing newline. An object keeps
 * its keys in insertion order, which is how the encoders above it spell a Go
 * struct's field order; an Ordered keeps the order it was given.
 */
export function goMarshal(value: unknown): string {
	return encode(value, null);
}

/**
 * A JSON object with its keys in this order: a Go struct, whose field order is
 * the order it is written in.
 *
 * The two modes differ, and the difference is deliberate:
 * - goMarshalIndent (indented) accepts an Ordered and nothing else for an
 *   object: `encode()` throws a TypeError on a plain object, because a Go map's
 *   keys are sorted and guessing that here would hide a wrong field order.
 * - goMarshal (compact) keeps a plain object's insertion order, which is how a
 *   struct is spelled, and an Ordered keeps the order it was given.
 */
export class Ordered {
	readonly entries: readonly (readonly [string, unknown])[];

	constructor(entries: readonly (readonly [string, unknown])[]) {
		this.entries = entries;
	}
}

/** json.MarshalIndent(v, "", "  "): two spaces a level, one element a line. */
export function goMarshalIndent(value: unknown): string {
	return encode(value, "");
}

/**
 * One value as Go writes it: `indent` is the indentation of the line it starts
 * on, or null for compact output. The indented form takes an Ordered for an
 * object (a struct, in field order); a plain object would be a Go map, whose
 * keys Go sorts, so it is refused instead of being sorted by guesswork.
 */
function encode(value: unknown, indent: string | null): string {
	if (value instanceof Ordered) {
		if (value.entries.length === 0) return "{}";
		if (indent === null) {
			return `{${value.entries.map(([k, v]) => `${escapeString(k)}:${encode(v, null)}`).join(",")}}`;
		}
		const lines = value.entries.map(([k, v]) => `${indent}  ${escapeString(k)}: ${encode(v, `${indent}  `)}`);
		return `{\n${lines.join(",\n")}\n${indent}}`;
	}
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		if (indent === null) return `[${value.map((v) => encode(v, null)).join(",")}]`;
		return `[\n${value.map((v) => `${indent}  ${encode(v, `${indent}  `)}`).join(",\n")}\n${indent}]`;
	}
	if (value !== null && typeof value === "object") {
		if (indent !== null) throw new TypeError("goMarshalIndent: wrap an object in Ordered, or it is a Go map");
		// JSON.stringify's rule for a plain object: insertion order, and a key
		// whose value is undefined is left out.
		const pairs = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.map(([k, v]) => `${escapeString(k)}:${encode(v, null)}`);
		return `{${pairs.join(",")}}`;
	}
	if (typeof value === "string") return escapeString(value);
	const text = JSON.stringify(value);
	if (text === undefined) throw new TypeError("goMarshal: value has no JSON form");
	return text;
}

/**
 * A JSON object edited one section at a time, the way Go's `modify` handles
 * settings.json with a map[string]json.RawMessage: a section the save does not
 * own is carried over as the text the file had, so its key order, its number
 * literals and its escape spellings survive (spec §1.5, §9 traps 2 and 3).
 */
export class RawObject {
	/** Raw JSON text per top-level key, as json.RawMessage holds it. */
	private readonly values = new Map<string, string>();

	/** Parses a top-level JSON object; anything else throws, as Go's Unmarshal reports it. */
	static parse(text: string): RawObject {
		const out = new RawObject();
		let i = skipSpace(text, 0);
		if (text[i] !== "{") throw new TypeError(`not a JSON object: ${JSON.stringify(text.slice(i, i + 1))}`);
		i = skipSpace(text, i + 1);
		if (text[i] === "}") {
			i++;
		} else {
			for (;;) {
				if (text[i] !== '"') throw new TypeError(`not a JSON key at byte ${i}`);
				const keyEnd = scanString(text, i);
				const key = JSON.parse(text.slice(i, keyEnd)) as string;
				i = skipSpace(text, keyEnd);
				if (text[i] !== ":") throw new TypeError(`no ":" after the key at byte ${i}`);
				const start = skipSpace(text, i + 1);
				i = scanJsonValue(text, start);
				// A duplicate key: the last one wins, as it does in a Go map.
				out.values.set(key, text.slice(start, i));
				i = skipSpace(text, i);
				if (text[i] === ",") {
					i = skipSpace(text, i + 1);
					continue;
				}
				if (text[i] === "}") {
					i++;
					break;
				}
				throw new TypeError(`no "," or "}" at byte ${i}`);
			}
		}
		if (skipSpace(text, i) !== text.length) throw new TypeError(`text after the object at byte ${i}`);
		return out;
	}

	/** The section's JSON text, or undefined when the file has no such key. */
	raw(key: string): string | undefined {
		return this.values.get(key);
	}

	/** Replaces a section with a value this save owns, encoded as Go's json.Marshal would. */
	set(key: string, value: unknown): void {
		this.values.set(key, goMarshal(value));
	}

	/** Drops a section (Go's `delete(raw, k)`), which a useEnv save does. */
	remove(key: string): void {
		this.values.delete(key);
	}

	/** The bytes of the file: top-level keys in byte order, every section re-compacted and re-indented. */
	encode(): string {
		const keys = [...this.values.keys()].sort(compareBytes);
		if (keys.length === 0) return "{}";
		const lines = keys.map((k) => `  ${escapeString(k)}: ${indent(compact(this.values.get(k) ?? ""), 1)}`);
		return `{\n${lines.join(",\n")}\n}`;
	}
}

/**
 * Go's compacting of a raw section (encoding/json's appendCompact with
 * escapeHTML on): insignificant spaces dropped, the five HTML characters
 * escaped, and every other byte — inside strings and out — left as it was.
 */
function compact(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i] ?? "";
		if (c === '"') {
			out += c;
			i++;
			while (i < text.length) {
				const d = text[i] ?? "";
				if (d === "\\") {
					// An escape sequence is copied as written: Go does not re-spell it.
					out += d + (text[i + 1] ?? "");
					i += 2;
					continue;
				}
				out += escapedChar(d);
				i++;
				if (d === '"') break;
			}
			continue;
		}
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		out += c;
		i++;
	}
	return out;
}

/**
 * Go's appendIndent for one compact value that sits at nesting `depth` (its own
 * braces at that depth, its contents one deeper): two spaces a level, one
 * element a line, `{}` and `[]` inline, `": "` after a key.
 */
function indent(text: string, base: number): string {
	let out = "";
	let depth = base;
	let needIndent = false;
	let i = 0;
	while (i < text.length) {
		const c = text[i] ?? "";
		// The newline and the extra level go before the first element of any
		// kind, a key included (Go's scanner marks that with scanBeginString).
		if (needIndent && c !== "}" && c !== "]") {
			needIndent = false;
			depth++;
			out += `\n${"  ".repeat(depth)}`;
		}
		if (c === '"') {
			const end = scanString(text, i);
			out += text.slice(i, end);
			i = end;
			continue;
		}
		switch (c) {
			case "{":
			case "[":
				// Delayed, so that an empty object or array stays {} or [].
				needIndent = true;
				out += c;
				break;
			case ",":
				out += `,\n${"  ".repeat(depth)}`;
				break;
			case ":":
				out += ": ";
				break;
			case "}":
			case "]":
				if (needIndent) needIndent = false;
				else out += `\n${"  ".repeat(--depth)}`;
				out += c;
				break;
			default:
				out += c;
		}
		i++;
	}
	return out;
}

function skipSpace(text: string, i: number): number {
	while (i < text.length) {
		const c = text[i];
		if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") break;
		i++;
	}
	return i;
}

/** The index just past the string that starts at `i`; Go's scanner's rules. */
function scanString(text: string, i: number): number {
	i++;
	while (i < text.length) {
		const c = text[i] ?? "";
		if (c === '"') return i + 1;
		if (c === "\\") {
			const e = text[i + 1];
			if (e === "u") {
				if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) throw new TypeError(`bad \\u escape at byte ${i}`);
				i += 6;
				continue;
			}
			if (e === undefined || !'"\\/bfnrt'.includes(e)) throw new TypeError(`bad escape at byte ${i}`);
			i += 2;
			continue;
		}
		if (c < " ") throw new TypeError(`control character in a string at byte ${i}`);
		i++;
	}
	throw new TypeError(`unterminated string from byte ${i}`);
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/**
 * The index just past the first JSON value at or after `from`, as Go's
 * json.Decoder reads one value and stops: the HTTP layer uses it so a body with
 * trailing data decodes the first value only (server-spec §9.12).
 */
export function scanJsonValue(text: string, from: number): number {
	const i = skipSpace(text, from);
	const c = text[i];
	if (c === '"') return scanString(text, i);
	if (c === "{" || c === "[") return scanContainer(text, i);
	if (text.startsWith("true", i)) return i + 4;
	if (text.startsWith("false", i)) return i + 5;
	if (text.startsWith("null", i)) return i + 4;
	NUMBER.lastIndex = i;
	const m = NUMBER.exec(text);
	if (m === null || m.index !== i) throw new TypeError(`not a JSON value at byte ${i}`);
	return i + m[0].length;
}

function scanContainer(text: string, i: number): number {
	const close = text[i] === "{" ? "}" : "]";
	const object = close === "}";
	i = skipSpace(text, i + 1);
	if (text[i] === close) return i + 1;
	for (;;) {
		i = skipSpace(text, i);
		if (object) {
			if (text[i] !== '"') throw new TypeError(`not a JSON key at byte ${i}`);
			i = skipSpace(text, scanString(text, i));
			if (text[i] !== ":") throw new TypeError(`no ":" after the key at byte ${i}`);
			i++;
		}
		i = skipSpace(text, scanJsonValue(text, i));
		if (text[i] === ",") {
			i++;
			continue;
		}
		if (text[i] === close) return i + 1;
		throw new TypeError(`no "," or "${close}" at byte ${i}`);
	}
}
