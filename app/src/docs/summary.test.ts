// Port of internal/docs/summary_test.go's TestSummaries, plus the tidying and
// truncation rules of summary.go and firstText. TestLLMSummariser is not here:
// the model-backed summariser needs the LLM layer (T3.1).
import { describe, expect, it } from "vitest";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { FakeConverter } from "./convert/fake.ts";
import { CONVERT_VERSION, type Doc, docName, STATUS_OK } from "./index.ts";
import { firstText, MAX_SUMMARY_LEN, retrySummary, SUMMARY_PROMPT, type Summariser, tidySummary } from "./summary.ts";
import { createSyncer, type Syncer } from "./sync.ts";
import type { Page } from "./types.ts";

const manual = "docs/raw/4.0 Manuals/Fridge.pdf";
const scan = "docs/raw/scan.pdf";

/** 240 characters: a page with text. */
const LONG = "Defrost the freezer every six months. Keep the door seal clean with warm soapy water. ".repeat(3);

const FIXED = new Date("2026-11-11T03:00:00Z");
const encoder = new TextEncoder();

/** Go's fakeSummaries: counts the calls, and can pretend the model is down. */
class FakeSummaries implements Summariser {
	calls: string[] = [];
	fail = false;
	texts: string[] = [];

	async summarise(d: Doc, text: string): Promise<string> {
		this.calls.push(docName(d));
		this.texts.push(text);
		if (this.fail) throw new Error("model down");
		return `About ${docName(d)}`;
	}
}

interface Rig {
	store: ObjectStore;
	conv: FakeConverter;
	sum: FakeSummaries;
	sync: Syncer;
	put: (key: string, body: string) => Promise<void>;
	run: () => Promise<Awaited<ReturnType<Syncer["sync"]>>>;
	doc: (key: string) => Promise<Doc>;
}

function createRig(store: ObjectStore = createMemoryStore()): Rig {
	const { log } = createTestLog();
	const conv = new FakeConverter();
	conv.pages.set("pdf-manual-v1", [
		{ n: 1, w: 595, h: 842, text: LONG },
		{ n: 2, w: 595, h: 842, text: LONG },
	]);
	conv.pages.set("pdf-manual-v2", [
		{ n: 1, w: 595, h: 842, text: `${LONG}Version two.` },
		{ n: 2, w: 595, h: 842, text: LONG },
	]);
	conv.pages.set("pdf-scan", [{ n: 1, w: 595, h: 842, text: "" }]);
	const sum = new FakeSummaries();
	const sync = createSyncer({ store, converter: conv, summariser: sum, log, now: () => FIXED });
	return {
		store,
		conv,
		sum,
		sync,
		put: async (key, body) => {
			await store.putBlob(key, encoder.encode(body), "application/pdf");
		},
		run: async () => await sync.sync("test"),
		doc: async (key) => {
			const ix = await sync.index();
			const d = ix.docs.find((x) => x.key === key);
			if (d === undefined) throw new Error(`${key} not in the index`);
			return d;
		},
	};
}

describe("TestSummaries", () => {
	it("summarises readable documents once, retries a failure, and never touches a scan", async () => {
		const r = createRig();
		r.sum.fail = true;
		await r.put(manual, "pdf-manual-v1");
		await r.put(scan, "pdf-scan");

		// The model is down: the document is still synced, without a summary.
		await r.run();
		const down = await r.doc(manual);
		expect({ status: down.status, summary: down.summary, calls: r.sum.calls }).toEqual({
			status: STATUS_OK,
			summary: "",
			calls: ["Fridge.pdf"], // never the scan
		});
		// The model saw the start of the text, not the file.
		expect(r.sum.texts[0]?.startsWith("Defrost the freezer")).toBe(true);

		// Next sync: one retry for the missing summary, no reconversion.
		r.sum.fail = false;
		const calls = r.conv.calls;
		await r.run();
		expect({
			summary: (await r.doc(manual)).summary,
			calls: r.sum.calls,
			conversions: r.conv.calls - calls,
		}).toEqual({
			summary: "About Fridge.pdf",
			calls: ["Fridge.pdf", "Fridge.pdf"],
			conversions: 0,
		});

		// Unchanged with a summary: no model call.
		await r.run();
		expect(r.sum.calls).toHaveLength(2);

		// A new version gets a new summary.
		await r.put(manual, "pdf-manual-v2");
		await r.run();
		expect(r.sum.calls).toHaveLength(3);
		expect((await r.doc(manual)).v).toBe(CONVERT_VERSION);
	});
});

describe("tidySummary", () => {
	it("keeps the first non-empty line, without quotes", () => {
		expect(tidySummary('"SMEG fridge manual: settings, defrosting and cleaning."\nSecond line.')).toBe(
			"SMEG fridge manual: settings, defrosting and cleaning.",
		);
		expect(tidySummary("\n\n  \n  Kitchen plan.  \nnext")).toBe("Kitchen plan.");
		expect(tidySummary("“Curly quoted”")).toBe("Curly quoted");
		expect(tidySummary("'single'")).toBe("single");
		expect(tidySummary("   \n\t\n")).toBe("");
	});

	it("caps at 160 code points, trimming before the ellipsis", () => {
		expect(MAX_SUMMARY_LEN).toBe(160);
		const long = "a".repeat(400);
		const out = tidySummary(long);
		expect([...out]).toHaveLength(MAX_SUMMARY_LEN);
		expect(out).toBe(`${"a".repeat(MAX_SUMMARY_LEN - 1)}…`);
		// The cut lands on a space, which is trimmed before the ellipsis.
		expect(tidySummary(`${"a".repeat(158)}  b`)).toBe(`${"a".repeat(158)}…`);
	});

	it("counts code points, not UTF-16 units, so an emoji is never cut in half", () => {
		const out = tidySummary("😀".repeat(200));
		expect([...out]).toHaveLength(MAX_SUMMARY_LEN);
		expect(out).toBe(`${"😀".repeat(MAX_SUMMARY_LEN - 1)}…`);
		expect(out.isWellFormed()).toBe(true);
	});
});

describe("firstText", () => {
	const page = (text: string): Page => ({ n: 1, w: 595, h: 842, text });

	it("joins the pages with a newline and stops after max characters", () => {
		expect(firstText([page("a"), page("b")], 10)).toBe("a\nb\n");
		expect(firstText([page("abc"), page("def")], 5)).toBe("abc\nd");
		expect(firstText([], 10)).toBe("");
	});

	it("counts code points, not UTF-16 units", () => {
		expect(firstText([page("😀")], 1)).toBe("😀");
		expect(firstText([page("a😀b")], 2)).toBe("a😀");
	});
});

describe("retrySummary", () => {
	const doc = (patch: Partial<Doc> = {}): Doc => ({
		...{
			id: "a",
			key: manual,
			etag: '"1"',
			size: 1,
			pages: 1,
			class: "text",
			status: STATUS_OK,
			reason: "",
			textPages: 1,
			summary: "",
			syncedAt: "",
			v: CONVERT_VERSION,
			removedAt: "",
			error: "",
			errorAt: "",
		},
		...patch,
	});

	it("does nothing when a summary is there, or for a scan", async () => {
		let asked = 0;
		const o = {
			memo: new Map<string, string>(),
			bought: "",
			readPages: async () => [page()],
			summarise: async () => {
				asked++;
				return "s";
			},
		};
		expect(await retrySummary({ ...o, d: doc({ summary: "already" }) })).toBe("already");
		expect(await retrySummary({ ...o, d: doc({ class: "scanned" }) })).toBe("");
		expect(asked).toBe(0);
	});

	it("asks once per run and remembers the answer, failures included", async () => {
		const memo = new Map<string, string>();
		let asked = 0;
		const run = async (): Promise<string> =>
			await retrySummary({
				d: doc(),
				memo,
				bought: "",
				readPages: async () => [page()],
				summarise: async () => {
					asked++;
					return "";
				},
			});
		expect(await run()).toBe("");
		expect(await run()).toBe("");
		expect(asked).toBe(1);
		expect(memo.get(`${manual}|"1"`)).toBe("");
	});

	it("reuses a summary a conversion already bought", async () => {
		const memo = new Map<string, string>();
		let asked = 0;
		const out = await retrySummary({
			d: doc(),
			memo,
			bought: "bought earlier",
			readPages: async () => [page()],
			summarise: async () => {
				asked++;
				return "asked";
			},
		});
		expect(out).toBe("bought earlier");
		expect(asked).toBe(0);
		expect(memo.get(`${manual}|"1"`)).toBe("bought earlier");
	});

	it("does not ask when the stored text cannot be read", async () => {
		const memo = new Map<string, string>();
		let asked = 0;
		const out = await retrySummary({
			d: doc(),
			memo,
			bought: "",
			readPages: async () => {
				throw new Error("gone");
			},
			summarise: async () => {
				asked++;
				return "asked";
			},
		});
		expect(out).toBe("");
		expect(asked).toBe(0);
		expect(memo.get(`${manual}|"1"`)).toBe("");
	});

	function page(): Page {
		return { n: 1, w: 595, h: 842, text: LONG };
	}
});

describe("the prompt", () => {
	it("is Go's, including the no-personal-details rule", () => {
		expect(SUMMARY_PROMPT).toContain("no personal details");
		expect(SUMMARY_PROMPT.startsWith("You write one-line descriptions of a family's household documents")).toBe(true);
	});
});
