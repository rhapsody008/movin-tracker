// The Go string rules: strings.TrimSpace / Fields / Trim / TrimRight, byte-order
// comparison and the RFC3339 stamp. The whitespace rows and the goStamp case
// moved here with the code, from model.test.ts and docs/index.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareBytes, goFields, goQuote, goStamp, goTimeJSON, goTrim, goTrimRight, goTrimSpace } from "./gostr.ts";

// Every member of Go's unicode.IsSpace set, one row each.
const goSpace = [
	"\t",
	"\n",
	"\v",
	"\f",
	"\r",
	" ",
	"\u0085",
	"\u00a0",
	"\u1680",
	"\u2000",
	"\u2001",
	"\u2002",
	"\u2003",
	"\u2004",
	"\u2005",
	"\u2006",
	"\u2007",
	"\u2008",
	"\u2009",
	"\u200a",
	"\u2028",
	"\u2029",
	"\u202f",
	"\u205f",
	"\u3000",
];

describe("Go's whitespace set", () => {
	for (const c of goSpace) {
		const code = (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
		it(`trims U+${code} at both ends`, () => {
			expect(goTrimSpace(`${c}x${c}`)).toBe("x");
			expect(goFields(`${c}a${c}b`)).toEqual(["a", "b"]);
		});
	}

	it("does not trim U+FEFF, which is JS space but not Go space", () => {
		expect(goTrimSpace("\ufeffx\ufeff")).toBe("\ufeffx\ufeff");
	});

	it("splits and trims like Go, unlike String.trim()", () => {
		expect(goFields("\u0085a\u00a0 b\t\tc \u2028")).toEqual(["a", "b", "c"]);
		expect(goTrimSpace("\u0085x\u0085")).toBe("x");
		expect("\ufeffx\ufeff".trim()).toBe("x"); // what JS would have done
	});
});

describe("strings.Trim and strings.TrimRight", () => {
	it("takes every leading and trailing character of the cutset", () => {
		expect(goTrim("//a/b//", "/")).toBe("a/b");
		expect(goTrim("///", "/")).toBe("");
		expect(goTrim("/a/", "/")).toBe("a");
		expect(goTrimRight("a//", "/")).toBe("a");
		expect(goTrim("a/", "")).toBe("a/"); // an empty cutset cuts nothing
	});

	it("takes a cutset of several characters, as strings.Trim does", () => {
		const quotes = `"'\u201c\u201d`;
		expect(goTrim(`\u201c"done"\u201d`, quotes)).toBe("done");
		expect(goTrim("'a\"", quotes)).toBe("a");
		expect(goTrim("a'b", quotes)).toBe("a'b"); // only the ends
	});
});

describe("goQuote", () => {
	// Go's answers for these, from tmp/t14-golden/probe4.go: printable text
	// stays raw, non-printable space and controls are escaped.
	it("writes Go's %q: raw when printable, \\x below U+0080, \\u above", () => {
		expect(goQuote("a\tb")).toBe(String.raw`"a\tb"`);
		expect(goQuote("é 厨房 😀")).toBe('"é 厨房 😀"');
		expect(goQuote("\u0001")).toBe(String.raw`"\x01"`);
		expect(goQuote("\u00a0")).toBe(String.raw`"\u00a0"`);
		expect(goQuote("\u2028")).toBe(String.raw`"\u2028"`);
		expect(goQuote("\ufeff")).toBe(String.raw`"\ufeff"`);
	});
});

describe("goStamp", () => {
	it("writes RFC3339 with seconds only, as Go's Format(RFC3339)", () => {
		expect(goStamp(new Date("2026-11-11T03:00:00.000Z"))).toBe("2026-11-11T03:00:00Z");
		expect(goStamp(new Date("2026-11-11T03:00:00.789Z"))).toBe("2026-11-11T03:00:00Z");
	});
});

describe("compareBytes", () => {
	// The order Go's sort.Strings gives these keys (tmp/t14-golden/main.go
	// sortkeys), not one worked out here. JS's UTF-16 order differs: it puts a
	// surrogate pair (a non-BMP character) before U+E000.
	it("sorts in Go's byte order, not JavaScript's UTF-16 order", () => {
		const goOrder: string[] = JSON.parse(readFileSync(new URL("./testdata/sortkeys.go.json", import.meta.url), "utf8"));
		const reversed = [...goOrder].reverse();
		expect([...reversed].sort(compareBytes)).toEqual(goOrder);
		// The same list in UTF-16 order is a different order, so this test is
		// not passing by accident.
		expect([...reversed].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).not.toEqual(goOrder);
	});
});

describe("goTimeJSON", () => {
	// time.Time's JSON form: RFC 3339 in UTC, with the fraction's trailing zeros
	// trimmed off — so a whole second has no fraction at all.
	it("trims the fraction the way time.Time does (F9)", () => {
		expect(goTimeJSON(new Date("2026-11-21T03:04:05.000Z"))).toBe("2026-11-21T03:04:05Z");
		expect(goTimeJSON(new Date("2026-11-21T03:04:05.810Z"))).toBe("2026-11-21T03:04:05.81Z");
		expect(goTimeJSON(new Date("2026-11-21T03:04:05.123Z"))).toBe("2026-11-21T03:04:05.123Z");
		// A whole second: S3's LastModified has one-second resolution.
		expect(goTimeJSON(new Date("2026-11-21T03:04:05Z"))).toBe("2026-11-21T03:04:05Z");
		// An offset date is written in UTC, as r.Send does.
		expect(goTimeJSON(new Date("2026-11-21T11:04:05.500+08:00"))).toBe("2026-11-21T03:04:05.5Z");
	});
});
