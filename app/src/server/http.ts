// The HTTP answers every route shares: the JSON writers, Go's http.Error, the
// body decoder and the one error mapper (`fail`). Port of internal/server/
// server.go:182-230 (writeJSON, writeErr, writeErr's callers, decode, fail).
//
// The bytes matter (server-spec §9): writeJSON is Go's json.Encoder, so the body
// is goMarshal + exactly one newline, and http.Error is text/plain with nosniff
// and a trailing newline. Only three places in Go use http.Error — auth, readyz
// and the file server's own 404 — and everything else is writeErr.

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	ChangeNotFoundError,
	ConflictError as EntriesConflictError,
	EntryNotFoundError,
	UndoStaleError,
} from "../entries/errors.ts";
import { encodeDocView } from "../entries/model.ts";
import type { EntriesService } from "../entries/service.ts";
import { ValidationError } from "../errors.ts";
import { goMarshal, Ordered, scanJsonValue } from "../gojson.ts";
import { errorMessage, type Log } from "../log.ts";
import { ConflictError as SettingsConflictError } from "../settings/errors.ts";

/** The cap Go's http.MaxBytesReader puts on every JSON body (server.go:223). */
export const MAX_BODY_BYTES = 1 << 20;

/** Go's two 409 lines with a document (server.go:205-212, §1.4). */
export const CONFLICT_MESSAGE = "Someone else just changed this. Showing the latest.";
export const UNDO_STALE_MESSAGE = "That entry was changed again since, so it can't be undone.";
/** Go's one 409 line without a document (settings conflict, server.go:213). */
export const SETTINGS_CONFLICT_MESSAGE =
	"These settings were changed somewhere else at the same moment. Reopen Settings and try again.";
/** Go's 500 line and the log line beside it (server.go:216-220). */
export const FAILED_MESSAGE = "That change didn't save. Try again.";

/** json.NewEncoder(w).Encode(v): Content-Type, the status, goMarshal and one newline (§9.2). */
export function writeJSON(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(`${goMarshal(value)}\n`);
}

/** writeErr is writeJSON of {"error": msg}: a Go map, so its one key is all the order there is. */
export function writeErr(res: ServerResponse, status: number, msg: string): void {
	writeJSON(res, status, { error: msg });
}

/**
 * http.Error: text/plain with nosniff and a trailing newline (§9.1). Go also
 * deletes any Content-Length it had set; Node computes one from the body.
 */
export function httpError(res: ServerResponse, status: number, msg: string): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" });
	res.end(`${msg}\n`);
}

/**
 * badRequest is what Go's own server answers when the request target cannot be
 * parsed at all: a bare "400 Bad Request" with no trailing newline, the type,
 * and a closed connection (net/http's readRequest error path). It happens before
 * routing, so no route's headers appear.
 */
export function badRequest(res: ServerResponse): void {
	res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
	res.end("400 Bad Request");
}

/**
 * hasBadEscape reports a "%" that does not start a %XX escape, which Go's
 * url.Parse rejects before the mux sees the request (server-spec §9.6).
 */
export function hasBadEscape(path: string): boolean {
	for (let i = 0; i < path.length; i++) {
		if (path[i] !== "%") continue;
		if (!isHexDigit(path[i + 1]) || !isHexDigit(path[i + 2])) return true;
		i += 2;
	}
	return false;
}

function isHexDigit(c: string | undefined): boolean {
	return c !== undefined && /^[0-9a-fA-F]$/.test(c);
}

/** Go's JSON whitespace: a decoder skips only these four bytes. */
const JSON_SPACE = " \t\n\r";

function skipSpace(text: string, from: number): number {
	let i = from;
	while (i < text.length && JSON_SPACE.includes(text[i] ?? "")) i++;
	return i;
}

/**
 * decodeBody is Go's decode: it reads the body under a 1 MiB cap and parses one
 * JSON value, ignoring anything after it. It answers null after writing the 400
 * itself, as Go's bool does.
 *
 * A body over the cap and an empty body keep Go's exact text ("http: request
 * body too large", "EOF"); the tails of the parser's own errors are this port's
 * own short text, because Go's come from encoding/json (brief T2.1, §10).
 */
export async function decodeBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
	const { tooLarge, text } = await readBody(req);
	if (tooLarge) {
		// Go's MaxBytesReader marks the connection too large, so the 400 goes out
		// with Connection: close and nothing else is read (§1.3).
		res.setHeader("Connection", "close");
		writeErr(res, 400, "Request body must be JSON: http: request body too large");
		return null;
	}
	const start = skipSpace(text, 0);
	if (start >= text.length) {
		writeErr(res, 400, "Request body must be JSON: EOF");
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(text.slice(start, scanJsonValue(text, start)));
	} catch {
		writeErr(res, 400, "Request body must be JSON: invalid JSON");
		return null;
	}
	// Go decodes into a map: null leaves it nil, which reads as no fields at all;
	// an array or a scalar is a type error.
	if (value === null) return {};
	if (typeof value !== "object" || Array.isArray(value)) {
		writeErr(res, 400, "Request body must be JSON: not a JSON object");
		return null;
	}
	return value as Record<string, unknown>;
}

/**
 * readBody reads the whole body under Go's 1 MiB cap. A body that goes over it
 * is NOT drained: Go's MaxBytesReader stops reading, the 400 goes out with
 * Connection: close, and the server hangs up (server-spec §1.3, F18). Draining
 * the rest would hand a client that keeps writing a free read.
 */
function readBody(req: IncomingMessage): Promise<{ tooLarge: boolean; text: string }> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settled = true;
				req.pause();
				resolve({ tooLarge: true, text: "" });
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			const body = new Uint8Array(size);
			let at = 0;
			for (const chunk of chunks) {
				body.set(chunk, at);
				at += chunk.length;
			}
			resolve({ tooLarge: false, text: new TextDecoder().decode(body) });
		});
		req.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
	});
}

/** What fail needs: the entries service for the 409 body, and the logger for the 500 line. */
export interface FailDeps {
	entries: EntriesService;
	log: Log;
}

/**
 * fail maps a service error to its HTTP answer (server.go:196-221). The order is
 * Go's and matters: a validation error first, then the two 404s, then the three
 * conflicts, then the 500.
 *
 * The entries-conflict and undo-stale bodies re-read the document and ignore the
 * error; when even that fails the body is {"doc":null,…,"etag":""}, which is
 * what Go writes for a zero Snapshot.
 */
export async function fail(deps: FailDeps, req: IncomingMessage, res: ServerResponse, err: unknown): Promise<void> {
	if (err instanceof ValidationError) {
		writeErr(res, 400, err.message);
		return;
	}
	if (err instanceof EntryNotFoundError) {
		writeErr(res, 404, "That entry no longer exists.");
		return;
	}
	if (err instanceof ChangeNotFoundError) {
		writeErr(res, 404, "That change is too old to undo.");
		return;
	}
	if (err instanceof UndoStaleError) {
		writeJSON(res, 409, await conflictBody(deps, UNDO_STALE_MESSAGE));
		return;
	}
	if (err instanceof SettingsConflictError) {
		writeErr(res, 409, SETTINGS_CONFLICT_MESSAGE);
		return;
	}
	if (err instanceof EntriesConflictError) {
		writeJSON(res, 409, await conflictBody(deps, CONFLICT_MESSAGE));
		return;
	}
	deps.log.error("request failed", {
		method: req.method ?? "",
		path: requestPath(req.url).path,
		err: errorMessage(err),
	});
	writeErr(res, 500, FAILED_MESSAGE);
}

/**
 * conflictBody is the 409 body of an entries conflict: a Go map, so doc, error
 * and etag in byte order. The document is read again so the browser can
 * re-render; a failed read leaves doc null and etag "".
 */
async function conflictBody(deps: FailDeps, msg: string): Promise<Ordered> {
	let doc: unknown = null;
	let etag = "";
	try {
		const snap = await deps.entries.current();
		doc = encodeDocView(snap.doc);
		etag = snap.etag;
	} catch {
		// Go ignores the error and sends the zero snapshot.
	}
	return new Ordered([
		["doc", doc],
		["error", msg],
		["etag", etag],
	]);
}

/** Go's Header.Get: case-insensitive, and the first of several values. */
export function header(req: IncomingMessage, name: string): string {
	const value = req.headers[name.toLowerCase()];
	if (value === undefined) return "";
	// Node joins repeated headers with ", "; Go's Get returns the first one.
	return Array.isArray(value) ? (value[0] ?? "") : value;
}

/** The request target split at "?": the path as sent, and the raw query. */
export function requestPath(url: string | undefined): { path: string; query: string } {
	const target = url ?? "/";
	const cut = target.indexOf("?");
	if (cut < 0) return { path: target, query: "" };
	return { path: target.slice(0, cut), query: target.slice(cut + 1) };
}

/**
 * decodePath is Go's url.PathUnescape of a whole path (r.URL.Path, which has
 * every escape decoded, %2F included). A path that does not decode is handed
 * back as sent; Go would have refused the request before it got this far.
 */
export function decodePath(path: string): string {
	if (!path.includes("%")) return path;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/**
 * decodeFailed answers a decode error found after decodeBody has read the
 * body: the same 400 and the same prefix Go's decode writes, with this port's
 * own short text for the tail (brief T2.1, §10). A wrong field type in a
 * settings body is one of those.
 */
export function decodeFailed(res: ServerResponse, err: unknown): void {
	writeErr(res, 400, `Request body must be JSON: ${errorMessage(err)}`);
}

/**
 * fieldOf is Go's encoding/json lookup of a struct field (encoding/json's
 * `foldName`): a key that differs only in case matches too, and when more than
 * one key matches, the **last** one in the document wins. Go's own answers for
 * `{"apikey":"a","APIKEY":"b"}` (b) and the reverse order (a) are in
 * app/golden/t2x/main.go; the object is walked in JSON.parse's key order.
 *
 * Two gaps against Go, both accepted (decisions.md, brief G2):
 * - a repeated exact key. `JSON.parse` keeps the FIRST position with the LAST
 *   value, so `{"SCHEDULE":"8:05","schedule":"7:00","SCHEDULE":"9:00"}` gives
 *   "7:00" here and "9:00" in Go, which assigns every occurrence in document
 *   order. Closing it needs a positional scanner, which this port does not do.
 * - folding is JavaScript lower-casing, not Go's `foldName`/`foldRune`
 *   (unicode.SimpleFold, encoding/json fold.go): `{"\u017fchedule":"x"}` matches `schedule` in Go (the
 *   long s folds to s) and does not match here.
 *
 * Only structs fold: a body Go decodes into a map (the entries routes) keeps
 * every key as written, and Patch.Apply rejects `"Title"`. Those routes do not
 * use these helpers.
 */
export function fieldOf(raw: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
	const wanted = key.toLowerCase();
	let found = false;
	let value: unknown;
	for (const [k, v] of Object.entries(raw)) {
		if (k.toLowerCase() !== wanted) continue;
		found = true;
		value = v;
	}
	return { found, value };
}

/**
 * jsonString is Go's decode of one string field: a missing key and a null both
 * leave the zero value, any other type is a decode error (json:
 * cannot unmarshal number into Go struct field …).
 */
export function jsonString(raw: Record<string, unknown>, key: string): string {
	const { value } = fieldOf(raw, key);
	if (value === undefined || value === null) return "";
	if (typeof value !== "string") throw new TypeError(`${key} must be a string`);
	return value;
}

/** jsonBool is jsonString for a bool field. */
export function jsonBool(raw: Record<string, unknown>, key: string): boolean {
	const { value } = fieldOf(raw, key);
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") throw new TypeError(`${key} must be true or false`);
	return value;
}

/** jsonStrings is jsonString for a list of strings. */
export function jsonStrings(raw: Record<string, unknown>, key: string): string[] {
	const { value } = fieldOf(raw, key);
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new TypeError(`${key} must be a list`);
	return value.map((item: unknown) => {
		if (typeof item !== "string") throw new TypeError(`${key} must be a list of strings`);
		return item;
	});
}
