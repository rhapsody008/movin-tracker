// The real source for T2.1's StaticFiles: the page and its icons read from a
// directory on every request, which is Go's os.DirFS(STATIC_DIR) in dev
// (cmd/movin/main.go:108-116). This build ships static/ next to the code
// instead of an //go:embed tree (web.go:11-22), so the same disk source is what
// production serves: an edited page shows up on the next load, and there is no
// build-time copy to forget.
//
// What is Go's and what deliberately is not (server-spec §2.5, §9.8):
// - the content type comes from the extension, as Go's mime package does
//   (".html", ".svg", ".png"). ".webmanifest" is the documented difference: Go
//   on alpine has no table entry and sniffs text/plain, this sends
//   application/manifest+json (Chrome fetches it as JSON either way);
// - Cache-Control: no-cache is set by createStatic, not here;
// - no ETag, no Last-Modified and no Range: Go's embedded FS has a zero modtime
//   and serves whole files, and the T2.1 handler writes Content-Length itself.
//   With STATIC_DIR Go would send the real modtime and answer 304/206; this
//   does not, which is recorded as a known difference in the step notes;
// - an extension outside those four answers application/octet-stream where Go
//   would sniff the bytes; the page has no such file;
// - a name with "/", "\\" or ".." in it, or one starting with ".", is not
//   served: there are no subdirectories, and no directory listing exists.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StaticFile, StaticFiles } from "./static.ts";

/** static/, resolved from this file (src/server/) so the cwd does not matter. */
export const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../static", import.meta.url));

/** The four extensions the page has (server-spec §2.5). */
const TYPES: Readonly<Record<string, string>> = {
	html: "text/html; charset=utf-8",
	svg: "image/svg+xml",
	png: "image/png",
	webmanifest: "application/manifest+json",
};

/** The type Go's mime.TypeByExtension gives these files; "" for an unknown extension, as Go has none. */
export function contentTypeOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot < 0 ? "" : (TYPES[name.slice(dot + 1).toLowerCase()] ?? "");
}

/** A name the page cannot ask for: absolute, a parent directory, or a hidden file. */
function badName(name: string): boolean {
	return name === "" || name.startsWith(".") || name.includes("/") || name.includes("\\") || name.includes("..");
}

/**
 * createDiskStatic serves `dir` as it is on disk at each request. The T2.1
 * interface is synchronous, so this reads with readFileSync: one small file per
 * request, the same work Go's file server does inside the handler.
 */
export function createDiskStatic(dir: string): StaticFiles {
	return {
		get: (name: string): StaticFile | null => {
			if (badName(name)) return null;
			let body: Buffer;
			try {
				body = readFileSync(join(dir, name));
			} catch {
				// Missing, a directory, or unreadable: Go's file server answers 404
				// for all three, and createStatic does that for a null.
				return null;
			}
			return { body, type: contentTypeOf(name) || "application/octet-stream" };
		},
	};
}
