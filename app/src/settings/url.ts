// URL rules for the origin binding: a stored or env API key is only ever sent
// to the scheme://host[:port] it was configured for (settings-spec §3.3).
//
// Go uses net/url, which keeps the host exactly as written and does not fold a
// default port away; URL from Node does fold `:443` on the standard schemes, so
// the authority is split by hand here. Differences left alone: Node's URL
// punycodes and normalises hosts, Go does not, so a non-ASCII host compares
// equal only to the same spelling.

import { goTrimSpace } from "../gostr.ts";

export interface ParsedURL {
	/** Lower case, as Go's url.Parse lowercases it; "" when there is none. */
	scheme: string;
	/** Host with its port, userinfo removed; "" when the URL has no authority. */
	host: string;
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
// Go's url.Parse rejects a space or control character in the authority, and the
// characters it would have to escape there.
const BAD_HOST = /[\s\p{Cc}"'<>\\^`{|}]/u;

/** url.Parse, reduced to what settings.json asks of a URL. Null is Go's error. */
export function parseURL(raw: string): ParsedURL | null {
	const s = goTrimSpace(raw);
	const m = SCHEME.exec(s);
	const scheme = m === null ? "" : (m[1] ?? "").toLowerCase();
	const rest = s.slice(m === null ? 0 : m[0].length);
	if (!rest.startsWith("//")) return { scheme, host: "" };
	const after = rest.slice(2);
	const end = after.search(/[/?#]/);
	const authority = end === -1 ? after : after.slice(0, end);
	if (BAD_HOST.test(authority)) return null;
	const at = authority.lastIndexOf("@");
	return { scheme, host: at === -1 ? authority : authority.slice(at + 1) };
}

/** SameOrigin: scheme and host equal, ignoring case; a URL without a host never matches. */
export function sameOrigin(a: string, b: string): boolean {
	const ua = parseURL(a);
	const ub = parseURL(b);
	if (ua === null || ub === null || ua.host === "") return false;
	return ua.scheme === ub.scheme && ua.host.toLowerCase() === ub.host.toLowerCase();
}

/** originOf: scheme://host for logs; never a path or a query. "" when unparsable. */
export function originOf(raw: string | undefined): string {
	if (raw === undefined) return "";
	const u = parseURL(raw);
	return u === null ? "" : `${u.scheme}://${u.host}`;
}

/** The endpoint URL check: http or https, with a host. */
export function isHTTPURL(raw: string): boolean {
	const u = parseURL(raw);
	return u !== null && (u.scheme === "http" || u.scheme === "https") && u.host !== "";
}
