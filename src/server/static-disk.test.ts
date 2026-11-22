// The disk static source: the four content types, and the names it refuses to
// serve (a parent directory, a subdirectory, a hidden file).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contentTypeOf, createDiskStatic, DEFAULT_STATIC_DIR } from "./static-disk.ts";

describe("createDiskStatic", () => {
	const dir = mkdtempSync(join(tmpdir(), "movin-static-"));
	mkdirSync(join(dir, "sub"));
	writeFileSync(join(dir, "index.html"), "<!doctype html>");
	writeFileSync(join(dir, ".env"), "SECRET=1");
	writeFileSync(join(dir, "sub", "page.html"), "<!doctype html>");
	writeFileSync(join(dir, "notes.txt"), "hello");
	const files = createDiskStatic(dir);

	it("reads a file with its content type", () => {
		const file = files.get("index.html");
		expect(file?.type).toBe("text/html; charset=utf-8");
		expect(new TextDecoder().decode(file?.body)).toBe("<!doctype html>");
	});

	it("refuses a hidden file, a subdirectory and a parent directory", () => {
		expect(files.get(".env")).toBeNull();
		expect(files.get("sub/page.html")).toBeNull();
		expect(files.get("../index.html")).toBeNull();
		expect(files.get("sub")).toBeNull();
	});

	it("gives an unknown extension a type Go would sniff", () => {
		expect(files.get("notes.txt")?.type).toBe("application/octet-stream");
	});

	it("reports a missing file as null, which is the 404", () => {
		expect(files.get("missing.html")).toBeNull();
	});
});

describe("contentTypeOf", () => {
	it("is Go's extension table for the page's files", () => {
		expect(contentTypeOf("index.html")).toBe("text/html; charset=utf-8");
		expect(contentTypeOf("icon.svg")).toBe("image/svg+xml");
		expect(contentTypeOf("icon-192.png")).toBe("image/png");
		expect(contentTypeOf("manifest.webmanifest")).toBe("application/manifest+json");
		expect(contentTypeOf("noextension")).toBe("");
	});
});

describe("DEFAULT_STATIC_DIR", () => {
	it("is static/, the tree this build serves", () => {
		expect(DEFAULT_STATIC_DIR).toBe(join(import.meta.dirname, "..", "..", "static"));
		expect(createDiskStatic(DEFAULT_STATIC_DIR).get("index.html")?.body.length).toBeGreaterThan(80_000);
	});
});
