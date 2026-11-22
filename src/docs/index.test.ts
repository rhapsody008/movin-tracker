// Port of internal/docs/index_test.go, plus the golden comparison against Go's
// own bytes (docs-spec §1) and the decode rules a hand-edited or newer index can
// break.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assignID,
	byKey,
	CLASS_DRAWING,
	CLASS_SCANNED,
	CLASS_TEXT,
	CONVERT_VERSION,
	changes,
	classify,
	type Doc,
	decodeIndex,
	decodePageText,
	docFolder,
	docName,
	docTextKey,
	emptyDoc,
	encodeIndex,
	encodePageText,
	find,
	garbled,
	INDEX_KEY,
	type Index,
	MIN_TEXT_CHARS,
	mbUp,
	newerThanThisBuild,
	type PageInfo,
	SCHEMA,
	STATUS_FAILED,
	STATUS_OK,
	STATUS_REMOVED,
	STATUS_SKIPPED,
	skipReason,
	textKeyFor,
} from "./index.ts";

const dir = join(import.meta.dirname, "testdata");

/** The stamp the Go v1 code (tag v1.0.1, golden t15) passes to Encode. */
const GOLDEN_STAMP = "2026-11-11T03:00:00Z";

function fixture(name: string): string {
	return readFileSync(join(dir, name), "utf8");
}

function errorOf(fn: () => void): Error {
	try {
		fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}

describe("SkipReason", () => {
	it("reads PDFs and skips everything else, with Go's reasons", () => {
		const cases: [string, boolean][] = [
			["docs/raw/1.0 Plans & Drawings/1.1 Layout (A3).pdf", false],
			["docs/raw/Manual.PDF", false],
			["docs/raw/2.0 Checklists/._2.1 Gift.pdf", true],
			["docs/raw/._top.pdf", true],
			["docs/raw/5.0 Vouchers/5.1 Video.mp4", true],
			["docs/raw/notes.txt", true],
			["docs/raw/1.0 Plans/", true],
			["docs/raw/no-extension", true],
		];
		for (const [key, skip] of cases) {
			expect([key, skipReason(key) !== ""]).toEqual([key, skip]);
		}
		expect(skipReason("docs/raw/a/b.mp4")).toBe("not a PDF (mp4)");
	});

	it("names the three skip reasons exactly as Go does", () => {
		expect(skipReason("docs/raw/1.0 Plans/")).toBe("folder marker");
		expect(skipReason("docs/raw/1.0 Plans/._1.3 Power.pdf")).toBe("macOS metadata file, not a document");
		expect(skipReason("docs/raw/notes.txt")).toBe("not a PDF (txt)");
		expect(skipReason("docs/raw/no-extension")).toBe("not a PDF ()");
	});
});

describe("Classify", () => {
	const a4: PageInfo = { w: 595, h: 842, chars: 900 };
	const a4scan: PageInfo = { w: 595, h: 842, chars: 0 };
	const cases: { name: string; pages: PageInfo[]; class: string; textPages: number }[] = [
		{ name: "A4 manual", pages: [a4, a4, a4], class: CLASS_TEXT, textPages: 3 },
		{ name: "A3 drawing, rotated", pages: [{ w: 1191, h: 842, chars: 1100 }], class: CLASS_DRAWING, textPages: 1 },
		{ name: "A1 drawing", pages: [{ w: 2384, h: 1684, chars: 1400 }], class: CLASS_DRAWING, textPages: 1 },
		{ name: "scan", pages: [a4scan, a4scan, a4scan], class: CLASS_SCANNED, textPages: 0 },
		{ name: "mostly screenshots", pages: [a4, a4scan, a4scan], class: CLASS_SCANNED, textPages: 1 },
		{ name: "half text is still text", pages: [a4, a4scan], class: CLASS_TEXT, textPages: 1 },
		{ name: "no pages", pages: [], class: CLASS_SCANNED, textPages: 0 },
		{ name: "landscape A4 is not a drawing", pages: [{ w: 842, h: 595, chars: 900 }], class: CLASS_TEXT, textPages: 1 },
		{
			name: "big pages without text are a scan",
			pages: [
				{ w: 1464, h: 822, chars: 0 },
				{ w: 1464, h: 822, chars: 3 },
			],
			class: CLASS_SCANNED,
			textPages: 0,
		},
	];
	for (const c of cases) {
		it(c.name, () => {
			expect(classify(c.pages)).toEqual({ class: c.class, textPages: c.textPages });
		});
	}

	it("counts a page with exactly MinTextChars as having text", () => {
		expect(MIN_TEXT_CHARS).toBe(100);
		expect(classify([{ w: 595, h: 842, chars: MIN_TEXT_CHARS }])).toEqual({ class: CLASS_TEXT, textPages: 1 });
		expect(classify([{ w: 595, h: 842, chars: MIN_TEXT_CHARS - 1 }])).toEqual({
			class: CLASS_SCANNED,
			textPages: 0,
		});
	});
});

describe("AssignID", () => {
	const key = "docs/raw/1.0 Plans/1.3 Power.pdf";

	it("is stable, eight hex digits, and suffixes a collision", () => {
		const id = assignID(key, new Map());
		expect(id).toMatch(/^[0-9a-f]{8}$/);
		expect(assignID(key, new Map([[id, key]]))).toBe(id);
		// Another key already holding the hash gets a suffix for the newcomer.
		expect(assignID(key, new Map([[id, "docs/raw/other.pdf"]]))).toBe(`${id}-2`);
		expect(
			assignID(
				key,
				new Map([
					[id, "x"],
					[`${id}-2`, "y"],
				]),
			),
		).toBe(`${id}-3`);
	});
});

describe("paths and round trip", () => {
	const d = emptyDoc("docs/raw/4.0 Manuals/4.2 Kitchen/SMEG Oven.pdf", "x");

	it("names, folders and text keys", () => {
		expect(docName(d)).toBe("SMEG Oven.pdf");
		expect(docFolder(d)).toBe("4.0 Manuals/4.2 Kitchen");
		expect(docTextKey(d)).toBe("docs/text/4.0 Manuals/4.2 Kitchen/SMEG Oven.pdf.json");
		expect(docFolder(emptyDoc("docs/raw/top.pdf", "y"))).toBe("");
		expect(textKeyFor("docs/raw/a.pdf")).toBe("docs/text/a.pdf.json");
		expect(textKeyFor("docs/other/a.pdf")).toBe("docs/text/docs/other/a.pdf.json");
	});

	it("encodes sorted by key and round-trips", () => {
		const ix: Index = {
			schema: 0,
			docs: [
				{ ...emptyDoc("docs/raw/b.pdf", "b"), status: STATUS_OK, class: CLASS_TEXT, pages: 2 },
				{ ...emptyDoc("docs/raw/a.pdf", "a"), status: STATUS_SKIPPED, reason: "x" },
			],
			lastSync: {
				at: "2026-11-11T00:00:00Z",
				reason: "startup",
				added: 2,
				changed: 0,
				removed: 0,
				failed: 0,
				skipped: 0,
				refreshed: 0,
				error: "",
			},
			updated: "",
		};
		const body = encodeIndex(ix, "2026-11-11T09:00:00Z");
		expect(ix.schema).toBe(SCHEMA);
		expect(body).toContain(`"updated": "2026-11-11T09:00:00Z"`);
		const back = decodeIndex(body);
		expect(back.docs.map((x) => x.key)).toEqual(["docs/raw/a.pdf", "docs/raw/b.pdf"]);
		expect(back.lastSync?.added).toBe(2);
		expect(find(back, "b")?.pages).toBe(2);
		expect(find(back, "zz")).toBeNull();
		expect(byKey(back).get("docs/raw/a.pdf")?.reason).toBe("x");
	});

	it("reads an empty body as an empty index and refuses a future schema", () => {
		expect(decodeIndex("")).toEqual({ schema: SCHEMA, docs: [], lastSync: null, updated: "" });
		const err = errorOf(() => decodeIndex(`{"schema":2,"docs":[]}`));
		expect(err.message).toBe("docs/index.json: schema 2, this build reads 1");
	});

	it("has Go's Changes() truth table", () => {
		expect(
			changes({ at: "", reason: "", added: 0, changed: 0, removed: 1, failed: 0, skipped: 0, refreshed: 0, error: "" }),
		).toBe(true);
		expect(
			changes({ at: "", reason: "", added: 0, changed: 0, removed: 0, failed: 2, skipped: 3, refreshed: 4, error: "" }),
		).toBe(false);
	});
});

describe("Garbled", () => {
	it("flags control characters and vowel-less lines, not good text", () => {
		const good = "Cleaning the grease filters: remove the filters and wash them in hot soapy water every two months.";
		const shifted = "'LPHQVLRQV \x03 \x03 EN \x12\\K NOOMQNXSK QR XPV VP cK TRKZ c| OKLRPXR fQXSMTZQX^ S\\QMZLKXh";
		expect(garbled(good)).toBe(false);
		expect(garbled("")).toBe(false);
		expect(garbled("DB TV P3 2G")).toBe(false);
		expect(garbled(shifted)).toBe(true);
		expect(garbled("xzq brt plk mnb vcx zxc qwr tps lkj hgf dsx nbv")).toBe(true);
	});
});

describe("the newer-version guard", () => {
	it("fires on any record from a newer reader, never on this build's", () => {
		const docs = [emptyDoc("docs/raw/a.pdf", "a")];
		expect(newerThanThisBuild({ schema: 1, docs, lastSync: null, updated: "" })).toBe(false);
		docs[0] = { ...docs[0], v: CONVERT_VERSION } as Doc;
		expect(newerThanThisBuild({ schema: 1, docs, lastSync: null, updated: "" })).toBe(false);
		docs[0] = { ...docs[0], v: CONVERT_VERSION + 1 } as Doc;
		expect(newerThanThisBuild({ schema: 1, docs, lastSync: null, updated: "" })).toBe(true);
	});
});

describe("decode", () => {
	it("wraps a broken body with Go's prefix and keeps V8's wording after it", () => {
		const err = errorOf(() => decodeIndex("{"));
		expect(err.message.startsWith(`decode ${INDEX_KEY}: `)).toBe(true);
	});

	it("refuses the wrong type at every level, naming the Go field path", () => {
		expect(errorOf(() => decodeIndex(`{"schema":1,"docs":"x"}`)).message).toBe(
			"decode docs/index.json: json: cannot unmarshal string into Go struct field Index.docs of type []docs.Doc",
		);
		expect(errorOf(() => decodeIndex(`{"docs":[{"size":"x"}]}`)).message).toBe(
			"decode docs/index.json: json: cannot unmarshal string into Go struct field Doc.docs.0.size of type int64",
		);
		expect(errorOf(() => decodeIndex(`{"docs":[{"pages":1.5}]}`)).message).toBe(
			"decode docs/index.json: json: cannot unmarshal number into Go struct field Doc.docs.0.pages of type int",
		);
		expect(errorOf(() => decodeIndex(`{"docs":[{"etag":7}]}`)).message).toBe(
			"decode docs/index.json: json: cannot unmarshal number into Go struct field Doc.docs.0.etag of type string",
		);
		expect(errorOf(() => decodeIndex(`{"lastSync":"x"}`)).message).toBe(
			"decode docs/index.json: json: cannot unmarshal string into Go struct field Index.lastSync of type docs.Sync",
		);
	});

	it("matches field names case-insensitively, as encoding/json does", () => {
		const ix = decodeIndex(`{"Schema":1,"DOCS":[{"ID":"abc","Key":"docs/raw/a.pdf","ETag":"\\"1\\"","Size":3}]}`);
		expect(ix.docs).toHaveLength(1);
		expect(ix.docs[0]?.id).toBe("abc");
		expect(ix.docs[0]?.etag).toBe('"1"');
		expect(ix.docs[0]?.size).toBe(3);
	});

	it("keeps only the fields the Go struct has", () => {
		const ix = decodeIndex(`{"schema":1,"docs":[{"id":"a","unknown":1}],"what":2}`);
		expect(Object.hasOwn(ix, "what")).toBe(false);
		expect(Object.hasOwn(ix.docs[0] ?? {}, "unknown")).toBe(false);
	});

	it("decodes a page text blob and refuses a broken one", () => {
		const pt = decodePageText(`{"key":"k","etag":"e","pages":[{"n":1,"w":595,"h":842,"text":"t"}]}`);
		expect(pt).toEqual({ key: "k", etag: "e", pages: [{ n: 1, w: 595, h: 842, text: "t" }] });
		expect(errorOf(() => decodePageText(`{"pages":"x"}`)).message).toBe(
			"json: cannot unmarshal string into Go struct field PageText.pages",
		);
		expect(errorOf(() => decodePageText("{")).message.startsWith("Expected property name")).toBe(true);
	});
});

describe("sizes", () => {
	it("rounds a size up to whole MiB, so just over the limit never reads as the limit", () => {
		expect(mbUp(32 << 20)).toBe(32);
		expect(mbUp((32 << 20) + 1)).toBe(33);
		expect(mbUp(0)).toBe(0);
	});
});

describe("golden files: Go's own bytes are the judge", () => {
	// The files are Go's own bytes, written at tag v1.0.1 (golden t15) from the Go package's own
	// Decode and Encode, never by hand: <input>.json is the input, and
	// <input>.go.json is what Go stores for it. pages.* is the PageText blob
	// (compact) and is checked separately, so it is skipped here.
	const files = readdirSync(dir).sort();
	const indexGolden = files.filter((f) => f.endsWith(".go.json") && !f.startsWith("pages."));

	it("has an index golden for every input", () => {
		expect(indexGolden.length).toBeGreaterThanOrEqual(3);
	});

	for (const file of indexGolden) {
		it(`${file} round-trips to the exact Go bytes`, () => {
			const input = fixture(file.replace(/\.go\.json$/, ".json"));
			const want = fixture(file);
			expect(encodeIndex(decodeIndex(input), GOLDEN_STAMP)).toBe(want);
		});
	}

	// The other direction: bytes Go wrote (its own Encode output) must be read
	// and written back unchanged by this side.
	for (const file of indexGolden) {
		it(`reads Go's own ${file} and writes it back unchanged`, () => {
			const want = fixture(file);
			expect(encodeIndex(decodeIndex(want), GOLDEN_STAMP)).toBe(want);
		});
	}

	it("pages.go.json is the compact blob Go writes", () => {
		const want = fixture("pages.go.json");
		expect(encodePageText(decodePageText(fixture("pages.json")))).toBe(want);
		// Compact: no indentation and no trailing newline.
		expect(want.startsWith('{"key":')).toBe(true);
		expect(want.endsWith("}")).toBe(true);
	});

	it("drops unknown keys and keeps a newer version on the tricky file", () => {
		const ix = decodeIndex(fixture("tricky.json"));
		expect(Object.hasOwn(ix, "unknownTopLevel")).toBe(false);
		expect(Object.hasOwn(ix.lastSync ?? {}, "unknownSync")).toBe(false);
		expect(Object.hasOwn(ix.docs[0] ?? {}, "unknownField")).toBe(false);
		// A record from a newer build survives a write untouched: that is what
		// the sync's newer-version guard protects.
		const layout = ix.docs.find((x) => x.id === "aaaa0001");
		expect(layout?.v).toBe(CONVERT_VERSION + 1);
		expect(newerThanThisBuild(ix)).toBe(true);
		expect(fixture("tricky.go.json")).toContain(`"v": 4`);
	});

	it("escapes what Go escapes, and only in strings", () => {
		const body = fixture("tricky.go.json");
		expect(body).toContain(
			`"summary": "\\u003cb\\u003eLayout\\u003c/b\\u003e \\u0026 \\"注解\\": 玄关\\u2028second line 😀"`,
		);
		expect(body).toContain(`"key": "docs/raw/2.0 Checklists/warranty \\u0026 invoice.pdf"`);
	});

	it("writes the empty index and the all-null one the same way", () => {
		const empty = fixture("empty.go.json");
		expect(fixture("nulls.go.json")).toBe(empty);
		expect(empty).toBe(`{\n  "schema": 1,\n  "docs": [],\n  "updated": "${GOLDEN_STAMP}"\n}`);
	});
});

describe("Doc zero values are Go's", () => {
	it("starts every record at the zero value", () => {
		const d = emptyDoc("docs/raw/a.pdf", "abc");
		expect(d).toEqual({
			id: "abc",
			key: "docs/raw/a.pdf",
			etag: "",
			size: 0,
			pages: 0,
			class: "",
			status: "",
			reason: "",
			textPages: 0,
			summary: "",
			syncedAt: "",
			v: 0,
			removedAt: "",
			error: "",
			errorAt: "",
		});
		expect(STATUS_OK).toBe("ok");
		expect(STATUS_FAILED).toBe("failed");
		expect(STATUS_REMOVED).toBe("removed");
		expect(STATUS_SKIPPED).toBe("skipped");
	});
});
