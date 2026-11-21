// Go's integer rules for settings.json: strconv.ParseInt/FormatInt, which check
// the Telegram IDs and the check-in chat. The string rules (TrimSpace, Fields,
// %q) are in ../gostr.ts, where every domain can reach them.

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const DIGITS = /^[+-]?[0-9]+$/;

/** strconv.ParseInt(s, 10, 64): null where Go returns an error. */
export function parseInt64(s: string): bigint | null {
	if (!DIGITS.test(s)) return null;
	const n = BigInt(s.startsWith("+") ? s.slice(1) : s);
	return n < INT64_MIN || n > INT64_MAX ? null : n;
}

/** strconv.FormatInt(n, 10). */
export function formatInt64(n: bigint): string {
	return n.toString();
}
