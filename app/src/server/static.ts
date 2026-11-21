// The catch-all: the page, its icons, and the JSON 404 under /api/. Port of
// Server.static (internal/server/server.go:156-167) with the file server
// replaced by an injected source.
//
// T2.1 serves from a StaticFiles the caller wires; T2.3 supplies the real one
// (embedded in the binary, or os.DirFS(STATIC_DIR) in dev). What stays Go's:
// - no method check, so a POST to "/" answers index.html, as http.FileServer
//   does; that is also why a method the API does not name becomes a 404 here
//   rather than a 405 (server-spec §9.5);
// - "Cache-Control: no-cache" on every file, so a deploy shows up on the next
//   load and the browser revalidates;
// - GET /index.html answers 301 with "Location: ./" (§9.7), and no body;
// - a missing file is Go's plain "404 page not found" with nosniff, while
//   anything under /api/ is the JSON {"error":"no such endpoint"}.

import type { IncomingMessage, ServerResponse } from "node:http";
import { httpError, requestPath, writeErr } from "./http.ts";
import type { Handler } from "./router.ts";

/** One servable file: its bytes and the content type the source gives it. */
export interface StaticFile {
	body: Uint8Array;
	/** Go's extension-based type: "text/html; charset=utf-8", "image/svg+xml", … */
	type: string;
}

/** Where the page's files come from: the embedded tree (T2.3), a directory, or a test's map. */
export interface StaticFiles {
	/** The file at this path relative to the static root ("index.html"), or null. */
	get: (name: string) => StaticFile | null;
}

export function createStatic(files: StaticFiles): Handler {
	return (req, res, h) => {
		// Go checks the prefix on r.URL.Path, which is decoded (§9.6).
		if (h.path.startsWith("/api/")) {
			writeErr(res, 404, "no such endpoint");
			return;
		}
		// FileServer redirects ".../index.html" to "./" so the page keeps one URL.
		// The redirect keeps the no-cache header, as Go's localRedirect does.
		if (h.path.endsWith("/index.html")) {
			res.setHeader("Cache-Control", "no-cache");
			localRedirect(req, res, "./");
			return;
		}
		const name = h.path === "/" ? "index.html" : h.path.slice(1);
		const file = files.get(name);
		if (file === null) {
			// Go's serveError deletes Cache-Control (and Etag, Last-Modified,
			// Content-Encoding) before it writes a file-server error, so a missing
			// file answers without it.
			httpError(res, 404, "404 page not found");
			return;
		}
		// Always revalidate, so a deploy shows up on the next load.
		res.setHeader("Cache-Control", "no-cache");
		// http.ServeContent's own headers come from the file: its type and length.
		res.writeHead(200, { "Content-Type": file.type, "Content-Length": String(file.body.length) });
		res.end(file.body);
	};
}

/**
 * localRedirect is Go's fs.localRedirect: the Location (with the request's
 * query, when it had one), the 301, and nothing else — no body, no type.
 */
function localRedirect(req: IncomingMessage, res: ServerResponse, target: string): void {
	const { query } = requestPath(req.url);
	res.writeHead(301, { Location: query === "" ? target : `${target}?${query}` });
	res.end();
}
