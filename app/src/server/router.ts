// The router: methods plus patterns, the way Go's ServeMux matches them
// (server-spec §1.1, §9.5, §9.6). Port of the two ServeMux values in
// server.go:78-115 as far as a Node port needs them.
//
// Two Go rules this keeps, because the bytes depend on them:
// - there is no 405. A method that no route names falls through to the caller's
//   catch-all, which is what Go's `api.Handle("/", static)` does (§9.5);
// - HEAD is served by the GET route (§9.5).
//
// Two it does not need: trailing-slash subtree patterns (the catch-all is a
// fallback) and redirecting a registered "/tree" to "/tree/" (nothing is
// registered with a trailing slash).

import type { IncomingMessage, ServerResponse } from "node:http";

/** What a matched route is handed beyond the request itself. */
export interface Handling {
	/** The signed-in email auth put on the request; "" on the routes outside auth. */
	user: string;
	/** The {id} the pattern captured, percent-decoded once; "" when the pattern has none. */
	id: string;
	/** The path, decoded as Go's r.URL.Path is: what the file server and the log line see. */
	path: string;
}

/** A route's answer. Nothing may be written after it resolves for a streaming route. */
export type Handler = (req: IncomingMessage, res: ServerResponse, h: Handling) => Promise<void> | void;

export interface Match {
	handler: Handler;
	id: string;
}

export interface Router {
	/** Registers `method` on `pattern`, whose only wildcard is a whole-segment `{id}`. */
	add: (method: string, pattern: string, handler: Handler) => void;
	/** The route for this method and escaped path, or null: the caller's catch-all answers then. */
	match: (method: string, path: string) => Match | null;
}

interface Route {
	method: string;
	/** One entry a segment: the literal to match, or null for the {id} wildcard. */
	segments: readonly (string | null)[];
	handler: Handler;
}

export function createRouter(): Router {
	const routes: Route[] = [];
	return {
		add: (method, pattern, handler) => {
			if (!pattern.startsWith("/")) throw new TypeError(`pattern must start with "/": ${pattern}`);
			routes.push({ method, segments: splitPath(pattern).map((s) => (s === WILDCARD ? null : s)), handler });
		},
		match: (method, path) => {
			// Go serves a HEAD from the GET pattern (§9.5).
			const want = method === "HEAD" ? "GET" : method;
			const segments = splitPath(path);
			for (const route of routes) {
				if (route.method !== want || route.segments.length !== segments.length) continue;
				const id = captures(route.segments, segments);
				if (id !== null) return { handler: route.handler, id };
			}
			return null;
		},
	};
}

/** The one wildcard name the API patterns use (server.go:288, :300, :310). */
const WILDCARD = "{id}";

/** "/api/entries/a" -> ["api", "entries", "a"], with "/" as no segments. */
function splitPath(path: string): string[] {
	if (path === "/") return [];
	const parts = path.split("/");
	// A path always starts with "/", so its first part is empty.
	return parts.slice(1);
}

/** The wildcard's value when every segment matches, else null. */
function captures(pattern: readonly (string | null)[], path: readonly string[]): string | null {
	let id = "";
	for (let i = 0; i < pattern.length; i++) {
		const want = pattern[i];
		const got = path[i] ?? "";
		// Go matches a literal against the escaped segment, so "%68ealthz" is not
		// "healthz"; only the wildcard's value is unescaped (routing_tree.go).
		if (want === null) {
			// Go's wildcards match a single non-empty segment, so a trailing slash
			// does not fill one.
			if (got === "") return null;
			id = unescapeSegment(got);
			continue;
		}
		if (want !== got) return null;
	}
	return id;
}

/** Go's url.PathUnescape of one segment; a bad escape is left as sent. */
function unescapeSegment(segment: string): string {
	if (!segment.includes("%")) return segment;
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * cleanPath is Go's net/http cleanPath: path.Clean, with a trailing slash put
 * back. A request whose path is not already clean is answered with a 307 to the
 * cleaned path before it is routed (§9.6).
 */
export function cleanPath(p: string): string {
	if (p === "") return "/";
	const rooted = p.startsWith("/") ? p : `/${p}`;
	const kept: string[] = [];
	for (const segment of rooted.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			kept.pop();
			continue;
		}
		kept.push(segment);
	}
	const clean = `/${kept.join("/")}`;
	return rooted.endsWith("/") && clean !== "/" ? `${clean}/` : clean;
}

const STATUS_TEXT: Record<number, string> = { 301: "Moved Permanently", 307: "Temporary Redirect" };

/**
 * redirect is Go's http.Redirect: the Location, text/html on a GET or HEAD, and
 * on a GET the little link body Go writes (§9.6).
 */
export function redirect(res: ServerResponse, method: string, status: number, target: string): void {
	const headers: Record<string, string> = { Location: target };
	const asked = method === "GET" || method === "HEAD";
	if (asked) headers["Content-Type"] = "text/html; charset=utf-8";
	res.writeHead(status, headers);
	if (method !== "GET") {
		res.end();
		return;
	}
	res.end(`<a href="${htmlEscape(target)}">${STATUS_TEXT[status] ?? ""}</a>.\n\n`);
}

/** Go's html.EscapeString, which http.Redirect applies to the link's href. */
function htmlEscape(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&#34;")
		.replace(/'/g, "&#39;");
}
