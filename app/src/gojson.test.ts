// The Go-compatible JSON writer: the raw-section scanner against Go's own
// answers (app/src/testdata/raw.go.json, written by app/golden/t14/main.go
// rawtable), and the two read-path differences Go and this port have on purpose.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RawObject } from "./gojson.ts";

interface RawCase {
	/** What the case is, for the test name. */
	name: string;
	/** base64 of the file's bytes, so control characters survive the golden file. */
	input: string;
	/** false: Go's Unmarshal refuses this input, and so must the scanner. */
	ok: boolean;
	/** Go's bytes after raw["schema"] = 1 and MarshalIndent; "" when !ok. */
	output: string;
}

const table: RawCase[] = JSON.parse(readFileSync(new URL("./testdata/raw.go.json", import.meta.url), "utf8"));
const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe("the raw-section scanner matches Go", () => {
	it("has the golden rows: valid ones to compare, invalid ones to refuse", () => {
		expect(table.filter((r) => r.ok).length).toBeGreaterThanOrEqual(9);
		expect(table.filter((r) => !r.ok).length).toBeGreaterThanOrEqual(16);
	});

	for (const row of table) {
		const input = decoder.decode(new Uint8Array(Buffer.from(row.input, "base64")));
		it(`${row.ok ? "writes Go's bytes for" : "refuses, as Go does"}: ${row.name}`, () => {
			if (!row.ok) {
				expect(() => RawObject.parse(input)).toThrow(TypeError);
				return;
			}
			const raw = RawObject.parse(input);
			raw.set("schema", 1);
			expect(raw.encode()).toBe(row.output);
		});
	}
});

// A5: the two read-path differences, deliberate and documented in gojson.ts.
describe("the read-path differences Go and this port have", () => {
	// Go fails on the BOM and modify replaces the whole file, dropping every
	// section. TextDecoder strips the BOM, so this side keeps them: a file
	// written with a BOM keeps its sections instead of losing them.
	it("keeps the sections of a file with a UTF-8 BOM, where Go replaces the file", () => {
		const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"stt":{"model":"whisper"}}')]);
		const text = decoder.decode(withBom);
		expect(text.startsWith("{")).toBe(true); // the BOM is gone before the scanner sees it
		const raw = RawObject.parse(text);
		raw.set("schema", 1);
		expect(raw.encode()).toBe('{\n  "schema": 1,\n  "stt": {\n    "model": "whisper"\n  }\n}');
	});

	// Go keeps the invalid bytes inside a raw section; TextDecoder answers
	// U+FFFD for them, which is what this side then writes.
	it("writes U+FFFD for invalid UTF-8 inside a string, where Go keeps the bytes", () => {
		const bytes = new Uint8Array([...encoder.encode('{"s":"a'), 0xff, ...encoder.encode('b"}')]);
		const raw = RawObject.parse(decoder.decode(bytes));
		raw.set("schema", 1);
		expect(raw.encode()).toBe('{\n  "s": "a\ufffdb",\n  "schema": 1\n}');
	});
});
