// Go's string rules, in one place: the ones more than one domain needs.
// strings.TrimSpace / Fields / Trim / TrimRight and fmt's %q are here because
// the entries model, the settings validation, the schedules, the documents code
// and the config all lean on them with the same Go semantics; so are byte-order
// comparison and the RFC3339 stamp every stored file writes.

// Go's unicode.IsSpace, which is what strings.TrimSpace and strings.Fields use:
// \t \n \v \f \r, space, U+0085, U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029,
// U+202F, U+205F and U+3000 (checked with `go doc unicode.IsSpace`). JS trim()
// and \s differ: they count U+FEFF as space and do not count U+0085.
const GO_SPACE = "\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
const goSpaceStart = new RegExp(`^[${GO_SPACE}]+`);
const goSpaceEnd = new RegExp(`[${GO_SPACE}]+$`);
const goSpaces = new RegExp(`[${GO_SPACE}]+`);

export function goTrimSpace(s: string): string {
	return s.replace(goSpaceStart, "").replace(goSpaceEnd, "");
}

export function goFields(s: string): string[] {
	const trimmed = goTrimSpace(s);
	return trimmed === "" ? [] : trimmed.split(goSpaces);
}

/** strings.Trim(s, cutset): every leading and trailing character of cutset off. */
export function goTrim(s: string, cutset: string): string {
	return goTrimRight(goTrimLeft(s, cutset), cutset);
}

/** strings.TrimLeft(s, cutset). */
function goTrimLeft(s: string, cutset: string): string {
	const chars = [...s];
	let start = 0;
	while (start < chars.length && cutset.includes(chars[start] ?? "")) start++;
	return chars.slice(start).join("");
}

/** strings.TrimRight(s, cutset). */
export function goTrimRight(s: string, cutset: string): string {
	const chars = [...s];
	let end = chars.length;
	while (end > 0 && cutset.includes(chars[end - 1] ?? "")) end--;
	return chars.slice(0, end).join("");
}

// Go's strconv.IsPrint: letters, marks, numbers, punctuation, symbols and the
// ASCII space; everything else is escaped, as fmt's %q does.
const PRINTABLE = /[\p{L}\p{M}\p{N}\p{P}\p{S} ]/u;
const SHORT_ESCAPES: Record<string, string> = {
	"\u0007": "\\a",
	"\b": "\\b",
	"\f": "\\f",
	"\n": "\\n",
	"\r": "\\r",
	"\t": "\\t",
	"\u000b": "\\v",
	"\\": "\\\\",
	'"': '\\"',
};

/** Go's %q: a double-quoted Go string literal, which is how the errors show bad input. */
export function goQuote(s: string): string {
	let out = '"';
	for (const ch of s) {
		const short = SHORT_ESCAPES[ch];
		if (short !== undefined) {
			out += short;
		} else if (PRINTABLE.test(ch)) {
			out += ch;
		} else {
			const code = ch.codePointAt(0) ?? 0;
			if (code < 0x80) out += `\\x${hex(code, 2)}`;
			else if (code < 0x10000) out += `\\u${hex(code, 4)}`;
			else out += `\\U${hex(code, 8)}`;
		}
	}
	return `${out}"`;
}

function hex(n: number, width: number): string {
	return n.toString(16).padStart(width, "0");
}

/**
 * Go compares and sorts strings byte by byte, which differs from JavaScript's
 * UTF-16 order for characters outside the BMP and for U+E000–U+FFFF against
 * surrogates. Byte order is the order a Go map's keys and sort.Strings use.
 */
export function compareBytes(a: string, b: string): number {
	return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * time.Format(time.RFC3339) in UTC for a whole second: "2026-11-11T09:00:00Z".
 * Every stored stamp (updated, at, syncedAt) is this, never with milliseconds.
 */
export function goStamp(at: Date): string {
	return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * time.Time's JSON form, which is RFC 3339 in UTC with the fraction's trailing
 * zeros trimmed: a whole second has no fraction at all, and .810 is written
 * .81 (time.Time.MarshalJSON, RFC3339Nano). The storage view's lastWrite.at is
 * the one place the app writes a time.Time rather than a stamp.
 */
export function goTimeJSON(at: Date): string {
	const iso = at.toISOString();
	const dot = iso.indexOf(".");
	if (dot < 0) return iso;
	const fraction = iso.slice(dot + 1, iso.length - 1).replace(/0+$/, "");
	return fraction === "" ? `${iso.slice(0, dot)}Z` : `${iso.slice(0, dot)}.${fraction}Z`;
}
