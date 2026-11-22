// Port of internal/docs/sync_test.go and the sync half of limits_test.go, plus
// the single-flight, timestamp and removal rules the Go suite leaves implicit.
// Every case runs on the memory store and on MinIO when S3_ENDPOINT_URL and
// S3_BUCKET are set (as they are inside `make test`).
import { randomUUID } from "node:crypto";
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createTestLog, type Log } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import { type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { FakeConverter } from "./convert/fake.ts";
import {
	CONVERT_VERSION,
	changes,
	type Doc,
	decodeIndex,
	docName,
	emptyDoc,
	emptyIndex,
	encodeIndex,
	INDEX_KEY,
	type Index,
	MAX_PDF_BYTES as LIMIT,
	MAX_PDF_BYTES,
	STATUS_FAILED,
	STATUS_OK,
	STATUS_REMOVED,
	STATUS_SKIPPED,
	type Sync,
} from "./index.ts";
import { createLibrary } from "./search.ts";
import type { Summariser } from "./summary.ts";
import { ConflictError, createSyncer, MAX_INDEX_RETRIES, NewerIndexError, type Syncer } from "./sync.ts";
import type { Page } from "./types.ts";

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the docs suite would be skipped",
	);
}

const runPrefix = `test-docs-ts-${Date.now()}`;

interface Variant {
	name: string;
	/** A store nothing else in the suite uses. */
	make: () => ObjectStore;
}

const variants: Variant[] = [{ name: "memory", make: () => createMemoryStore() }];

if (endpointUrl !== "" && bucket !== "") {
	await createBucket();
	variants.push({
		name: "s3",
		make: () => createS3Store({ bucket, prefix: `${runPrefix}/${randomUUID()}`, region, endpointUrl }),
	});
}

async function createBucket(): Promise<void> {
	const client = new S3Client({ region, endpoint: endpointUrl, forcePathStyle: true });
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (err) {
		const name = typeof err === "object" && err !== null && "name" in err ? err.name : undefined;
		if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
	}
	await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
	client.destroy();
}

const manual = "docs/raw/4.0 Manuals/Fridge.pdf";
const drawing = "docs/raw/1.0 Plans/1.3 Power.pdf";
const junk = "docs/raw/1.0 Plans/._1.3 Power.pdf";
const video = "docs/raw/5.0 Vouchers/5.1 Video.mp4";

/** 240 characters, so a page counts as having text (MIN_TEXT_CHARS is 100). */
const LONG = "Defrost the freezer every six months. Keep the door seal clean with warm soapy water. ".repeat(3);

const FIXED = new Date("2026-11-11T03:00:00Z");

const encoder = new TextEncoder();

function a4(text: string, n: number): Page {
	return { n, w: 595, h: 842, text };
}

interface Notes {
	calls: Sync[];
	docs: Doc[][];
}

interface Rig {
	store: ObjectStore;
	conv: FakeConverter;
	notes: Notes;
	log: Log;
	lines: string[];
	sync: Syncer;
	put: (key: string, body: string) => Promise<void>;
	run: (reason?: string) => Promise<Sync>;
	doc: (key: string) => Promise<Doc>;
}

function createRig(store: ObjectStore, opts: { now?: () => Date; summariser?: Summariser } = {}): Rig {
	const { log, lines } = createTestLog();
	const conv = new FakeConverter();
	conv.pages.set("pdf-manual-v1", [a4(LONG, 1), a4(LONG, 2)]);
	conv.pages.set("pdf-manual-v2", [a4(`${LONG}Version two.`, 1), a4(LONG, 2)]);
	conv.pages.set("pdf-drawing-v1", [
		{ n: 1, w: 2384, h: 1684, text: `POWER LEGEND ${LONG}`, words: [{ t: "DB", b: [100, 900, 120, 910] }] },
	]);
	const notes: Notes = { calls: [], docs: [] };
	const sync = createSyncer({
		store,
		converter: conv,
		summariser: opts.summariser,
		notify: {
			docsChanged: (result, changed) => {
				notes.calls.push(result);
				notes.docs.push(changed);
			},
		},
		log,
		now: opts.now ?? ((): Date => FIXED),
	});
	const rig: Rig = {
		store,
		conv,
		notes,
		log,
		lines,
		sync,
		put: async (key, body) => {
			await store.putBlob(key, encoder.encode(body), "application/pdf");
		},
		run: async (reason = "test") => await sync.sync(reason),
		doc: async (key) => {
			const ix = await sync.index();
			const d = ix.docs.find((x) => x.key === key);
			if (d === undefined) throw new Error(`${key} not in the index`);
			return d;
		},
	};
	return rig;
}

async function errorOf(fn: () => Promise<unknown>): Promise<Error> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof Error) return err;
		throw err;
	}
	throw new Error("expected the call to throw, it returned normally");
}

/** The log lines as objects, so a test can check a message and its fields. */
function logged(lines: readonly string[]): Record<string, unknown>[] {
	return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Their index is written just before our first conditional PUT: our run must redo on top of it. */
function racingStore(inner: ObjectStore, sneak: () => Promise<void>): ObjectStore {
	let once = false;
	return {
		...inner,
		put: async (key, body, ifMatch, signal) => {
			if (key === INDEX_KEY && !once) {
				once = true;
				await sneak();
			}
			return await inner.put(key, body, ifMatch, signal);
		},
	};
}

/** Every index write loses the race. */
function alwaysConflict(inner: ObjectStore): ObjectStore {
	return {
		...inner,
		put: async (key, body, ifMatch, signal) => {
			if (key === INDEX_KEY) throw new PreconditionError(key);
			return await inner.put(key, body, ifMatch, signal);
		},
	};
}

class FakeSummaries implements Summariser {
	calls: string[] = [];
	fail = false;

	async summarise(d: Doc): Promise<string> {
		this.calls.push(docName(d));
		if (this.fail) throw new Error("model down");
		return `About ${docName(d)}`;
	}
}

for (const variant of variants) {
	describe(variant.name, () => {
		it("imports, then follows a change, a removal and a re-upload", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.put(drawing, "pdf-drawing-v1");
			await r.put(junk, "apple double");
			await r.put(video, "mp4");

			// First import: two documents read, two skipped, nobody notified.
			const res = await r.run();
			expect({
				added: res.added,
				skipped: res.skipped,
				failed: res.failed,
				removed: res.removed,
				notes: r.notes.calls.length,
			}).toEqual({ added: 2, skipped: 2, failed: 0, removed: 0, notes: 0 });
			const m = await r.doc(manual);
			expect({
				status: m.status,
				class: m.class,
				pages: m.pages,
				textPages: m.textPages,
				hasID: m.id !== "",
				v: m.v,
				syncedAt: m.syncedAt,
			}).toEqual({ status: STATUS_OK, class: "text", pages: 2, textPages: 2, hasID: true, v: 3, syncedAt: res.at });
			expect((await r.doc(drawing)).class).toBe("drawing");
			const j = await r.doc(junk);
			expect({ status: j.status, reason: j.reason }).toEqual({
				status: STATUS_SKIPPED,
				reason: "macOS metadata file, not a document",
			});
			const pt = await r.sync.pageText(await r.doc(drawing));
			expect({ pages: pt.pages.length, word: pt.pages[0]?.words?.[0]?.t, key: pt.key }).toEqual({
				pages: 1,
				word: "DB",
				key: drawing,
			});
			const calls = r.conv.calls;

			// Nothing changed: no conversions, no notes, no skips counted again.
			const quiet = await r.run();
			expect({
				changes: changes(quiet),
				skipped: quiet.skipped,
				conversions: r.conv.calls - calls,
				notes: r.notes.calls.length,
			}).toEqual({ changes: false, skipped: 0, conversions: 0, notes: 0 });

			// A new version: changed, one note naming that document, same id.
			await r.put(manual, "pdf-manual-v2");
			const changed = await r.run();
			expect({ changed: changed.changed, notes: r.notes.calls.length, key: r.notes.docs[0]?.[0]?.key }).toEqual({
				changed: 1,
				notes: 1,
				key: manual,
			});
			const id = (await r.doc(manual)).id;
			expect(id).toBe(m.id);

			// Deleted from the bucket: kept as removed, noted.
			await r.store.delete(manual);
			const removed = await r.run();
			const gone = await r.doc(manual);
			expect({
				removed: removed.removed,
				status: gone.status,
				removedAt: gone.removedAt,
				notes: r.notes.calls.length,
			}).toEqual({ removed: 1, status: STATUS_REMOVED, removedAt: removed.at, notes: 2 });

			// Uploaded again: back, same id.
			await r.put(manual, "pdf-manual-v1");
			const back = await r.run();
			const again = await r.doc(manual);
			expect({ added: back.added, status: again.status, id: again.id }).toEqual({
				added: 1,
				status: STATUS_OK,
				id,
			});
		});

		it("retries a document that failed to convert", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			r.conv.fail.set("pdf-manual-v1", new Error("pdftotext: broken file"));
			const failed = await r.run();
			const d = await r.doc(manual);
			expect({ failed: failed.failed, status: d.status, reason: d.reason, error: d.error }).toEqual({
				failed: 1,
				status: STATUS_FAILED,
				reason: "pdftotext: broken file",
				error: "pdftotext: broken file",
			});
			expect(logged(r.lines)).toContainEqual(
				expect.objectContaining({
					msg: "document sync failed",
					key: manual,
					err: "pdftotext: broken file",
					keptPrevious: false,
				}),
			);
			r.conv.fail.delete("pdf-manual-v1");
			const retried = await r.run();
			expect({ added: retried.added, status: (await r.doc(manual)).status }).toEqual({ added: 1, status: STATUS_OK });
		});

		it("is single flight: four callers start one run and share its result", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.put(drawing, "pdf-drawing-v1");
			r.conv.delay = 50;
			const results = await Promise.all([
				r.sync.sync("web"),
				r.sync.sync("web"),
				r.sync.sync("web"),
				r.sync.sync("web"),
			]);
			expect(r.conv.calls).toBe(2); // one conversion per document, not per caller
			for (const res of results) expect(res.added).toBe(2);
			// The very same result object: the callers joined one run.
			expect(new Set(results).size).toBe(1);
			// And one "documents synced" line, not four.
			expect(logged(r.lines).filter((l) => l.msg === "documents synced")).toHaveLength(1);
		});

		// F2 c: a caller that joins with a signal that ended before it called in
		// rejects at once, rather than waiting for the run it joined.
		it("rejects a joiner whose signal was already aborted, without waiting", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			r.conv.delay = 300; // the run is still going when the joiner calls in
			const first = r.sync.sync("web");
			const controller = new AbortController();
			const reason = new Error("the caller went away");
			controller.abort(reason);
			const outcome = await Promise.race([
				r.sync.sync("web", controller.signal).then(
					() => "resolved",
					(err: unknown) => err,
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("still waiting"), 100)),
			]);
			expect(outcome).toBe(reason);
			await first;
		});

		// F2 b: a read of the index that started before a sync must not put its
		// older copy back: the sync's copy is the newer one.
		it("keeps the newer index when a read started before the sync finishes after it", async () => {
			const store = variant.make();
			await store.put(INDEX_KEY, encoder.encode(encodeIndex(emptyIndex(), "2026-11-11T03:00:00Z")), null);
			let armed = true;
			let entered = (): void => undefined;
			let release = (): void => undefined;
			const enteredPromise = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const releasePromise = new Promise<void>((resolve) => {
				release = resolve;
			});
			const gated: ObjectStore = {
				...store,
				get: async (key, signal) => {
					const got = await store.get(key, signal);
					if (armed && key === INDEX_KEY) {
						armed = false;
						entered();
						await releasePromise;
					}
					return got;
				},
			};
			const r = createRig(gated);
			await r.put(manual, "pdf-manual-v1");

			const read = r.sync.index(); // reads the empty index, then waits
			await enteredPromise;
			await r.run(); // the sync writes an index holding the manual
			release();
			const readIndex = await read;
			expect(readIndex.docs.map((d) => d.key)).toEqual([manual]);
			// And the cache stays the sync's copy, not the read's older one.
			expect((await r.sync.index()).docs.map((d) => d.key)).toEqual([manual]);
			const stored = decodeIndex(new TextDecoder().decode((await store.get(INDEX_KEY)).body));
			expect(stored.docs.map((d) => d.key)).toEqual([manual]);
		});

		it("redoes the run on top of another writer's index, converting nothing twice", async () => {
			const r = createRig(variant.make());
			const other = "docs/raw/other.pdf";
			await r.put(manual, "pdf-manual-v1");
			await r.put(other, "pdf-other");
			const otherInfo = await r.store.stat(other);
			const racing = racingStore(r.store, async () => {
				const theirs: Index = {
					schema: 1,
					docs: [
						{
							...emptyDoc(other, "abc12345"),
							etag: otherInfo.etag,
							status: STATUS_OK,
							class: "text",
							pages: 1,
							summary: "theirs",
							v: CONVERT_VERSION,
						},
					],
					lastSync: null,
					updated: "",
				};
				await r.store.put(INDEX_KEY, encoder.encode(encodeIndex(theirs, "2026-11-11T03:00:00Z")), null);
			});
			const sync = createSyncer({ store: racing, converter: r.conv, log: r.log, now: () => FIXED });
			const res = await sync.sync("test");
			// manual and other in the first attempt; nothing again after the redo.
			expect(r.conv.calls).toBe(2);
			expect(logged(r.lines)).toContainEqual(
				expect.objectContaining({ msg: "documents index changed while syncing; redoing", attempt: 1 }),
			);
			const ix = decodeIndex(new TextDecoder().decode((await r.store.get(INDEX_KEY)).body));
			expect({ docs: ix.docs.length, added: res.added }).toEqual({ docs: 2, added: 1 });
			const theirs = ix.docs.find((d) => d.key === other);
			expect({ summary: theirs?.summary, id: theirs?.id }).toEqual({ summary: "theirs", id: "abc12345" });
		});

		it("stays silent while nothing has ever been readable", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.put(drawing, "pdf-drawing-v1");
			r.conv.fail.set("pdf-manual-v1", new Error("pdfinfo: not installed"));
			r.conv.fail.set("pdf-drawing-v1", new Error("pdfinfo: not installed"));
			const allFailed = await r.run();
			expect({ failed: allFailed.failed, notes: r.notes.calls.length }).toEqual({ failed: 2, notes: 0 });
			r.conv.fail.clear();
			const fixed = await r.run();
			expect({ added: fixed.added, notes: r.notes.calls.length }).toEqual({ added: 2, notes: 0 });
			// From now on changes are announced.
			await r.put(manual, "pdf-manual-v2");
			const later = await r.run();
			expect({ changed: later.changed, notes: r.notes.calls.length }).toEqual({ changed: 1, notes: 1 });
		});

		it("refreshes documents read by an older ConvertVersion, quietly", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.put(drawing, "pdf-drawing-v1");
			await r.run();
			const ix = await r.sync.index();
			for (const d of ix.docs) d.v = CONVERT_VERSION - 1;
			const { etag } = await r.store.get(INDEX_KEY);
			await r.store.put(INDEX_KEY, encoder.encode(encodeIndex(ix, "2026-11-11T03:00:00Z")), etag);
			const calls = r.conv.calls;
			const res = await r.run();
			expect({
				refreshed: res.refreshed,
				changes: changes(res),
				conversions: r.conv.calls - calls,
				notes: r.notes.calls.length,
			}).toEqual({ refreshed: 2, changes: false, conversions: 2, notes: 0 });
			expect((await r.doc(manual)).v).toBe(CONVERT_VERSION);
			const again = await r.run();
			expect({ refreshed: again.refreshed, conversions: r.conv.calls - calls }).toEqual({
				refreshed: 0,
				conversions: 2,
			});
		});

		it("leaves an index written by a newer build alone", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.run();
			const ix = await r.sync.index();
			const doc = ix.docs[0];
			if (doc === undefined) throw new Error("no document");
			doc.v = CONVERT_VERSION + 1;
			const { etag } = await r.store.get(INDEX_KEY);
			await r.store.put(INDEX_KEY, encoder.encode(encodeIndex(ix, "2026-11-11T03:00:00Z")), etag);
			const before = (await r.store.get(INDEX_KEY)).body;
			const calls = r.conv.calls;
			const err = await errorOf(async () => await r.sync.sync("daily"));
			expect(err).toBeInstanceOf(NewerIndexError);
			expect(err.message).toBe("documents index was written by a newer version of the app; this one leaves it alone");
			const after = (await r.store.get(INDEX_KEY)).body;
			expect(new TextDecoder().decode(after)).toBe(new TextDecoder().decode(before));
			expect(r.conv.calls).toBe(calls);
			expect(logged(r.lines)).toContainEqual(expect.objectContaining({ level: "WARN", msg: "documents sync failed" }));
		});

		it("keeps a readable document whose new version fails, and its recovery is a change", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.run();
			await r.put(manual, "pdf-manual-v2");
			r.conv.fail.set("pdf-manual-v2", new Error("pdftotext: timeout"));
			const res = await r.run();
			const d = await r.doc(manual);
			expect({
				failed: res.failed,
				changes: changes(res),
				status: d.status,
				pages: d.pages,
				notes: r.notes.calls.length,
			}).toEqual({ failed: 1, changes: false, status: STATUS_OK, pages: 2, notes: 0 });
			expect({ error: d.error, errorAt: d.errorAt }).toEqual({
				error: "couldn't read the new version: pdftotext: timeout",
				errorAt: res.at,
			});
			expect(logged(r.lines)).toContainEqual(
				expect.objectContaining({ msg: "document sync failed", key: manual, keptPrevious: true }),
			);
			// The readable text is still there, so the document stays usable, and
			// search still finds it (the failed re-read changed nothing).
			expect((await r.sync.pageText(d)).pages).toHaveLength(2);
			const found = await createLibrary({ source: r.sync, log: r.log }).search("defrost freezer");
			expect(found.length).toBeGreaterThan(0);
			expect(found.every((h) => h.name === "Fridge.pdf")).toBe(true);
			r.conv.fail.delete("pdf-manual-v2");
			const fixed = await r.run();
			expect({ changed: fixed.changed, added: fixed.added, notes: r.notes.calls.length }).toEqual({
				changed: 1,
				added: 0,
				notes: 1,
			});
			const back = await r.doc(manual);
			expect({ error: back.error, errorAt: back.errorAt }).toEqual({ error: "", errorAt: "" });
		});

		it("remembers conversions and summaries across a redo", async () => {
			const r = createRig(variant.make());
			const sum = new FakeSummaries();
			const other = "docs/raw/other.pdf";
			await r.put(manual, "pdf-manual-v1");
			await r.put(drawing, "pdf-drawing-v1");
			await r.put(other, "pdf-other");
			r.conv.pages.set("pdf-other", [a4(LONG, 1)]);
			r.conv.fail.set("pdf-drawing-v1", new Error("broken"));
			const otherInfo = await r.store.stat(other);
			const racing = racingStore(r.store, async () => {
				const theirs: Index = {
					schema: 1,
					docs: [
						{
							...emptyDoc(other, "abc12345"),
							etag: otherInfo.etag,
							status: STATUS_OK,
							class: "text",
							pages: 1,
							v: CONVERT_VERSION,
						},
					],
					lastSync: null,
					updated: "",
				};
				await r.store.put(INDEX_KEY, encoder.encode(encodeIndex(theirs, "2026-11-11T03:00:00Z")), null);
			});
			const sync = createSyncer({
				store: racing,
				converter: r.conv,
				summariser: sum,
				log: r.log,
				now: () => FIXED,
			});
			await sync.sync("test");
			// Attempt 1 converts all three and summarises the two readable ones;
			// the redo converts nothing and buys no summary again, not even for
			// the other writer's summary-less record.
			expect(r.conv.calls).toBe(3);
			expect(sum.calls).toEqual(["Fridge.pdf", "other.pdf"]);
			const ix = await sync.index();
			expect(ix.docs.find((d) => d.key === manual)?.summary).toBe("About Fridge.pdf");
		});

		it("gives up with ConflictError after the retries, converting once", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			const sync = createSyncer({ store: alwaysConflict(r.store), converter: r.conv, log: r.log, now: () => FIXED });
			const err = await errorOf(async () => await sync.sync("test"));
			expect(err).toBeInstanceOf(ConflictError);
			expect(err.message).toBe("documents index changed by someone else; try the sync again");
			expect(r.conv.calls).toBe(1); // exactly one conversion over 4 attempts
			expect(logged(r.lines).filter((l) => l.msg === "documents index changed while syncing; redoing")).toHaveLength(
				MAX_INDEX_RETRIES + 1,
			);
			expect(logged(r.lines)).toContainEqual(
				expect.objectContaining({ level: "WARN", msg: "documents sync failed", err: err.message }),
			);
		});

		it("never reads a PDF over the size limit", { timeout: 30_000 }, async () => {
			const r = createRig(variant.make());
			const big = "x".repeat(LIMIT + 1);
			r.conv.pages.set(big, [a4(LONG, 1)]);
			await r.put("docs/raw/Huge.pdf", big);
			const calls = r.conv.calls;
			await r.run();
			const d = await r.doc("docs/raw/Huge.pdf");
			expect(d.status).toBe(STATUS_FAILED);
			expect(`${d.reason} ${d.error}`).toContain("too large to read (33 MB; the limit is 32 MB)");
			expect(r.conv.calls).toBe(calls);
			expect(MAX_PDF_BYTES).toBe(32 << 20);
		});

		it("writes one stamp for every field of a run", async () => {
			// A clock that moves on every read, so a second read anywhere would
			// show up as a different string.
			let ticks = 0;
			const r = createRig(variant.make(), {
				now: () => {
					ticks++;
					return new Date(FIXED.getTime() + (ticks - 1) * 1000);
				},
			});
			await r.put(manual, "pdf-manual-v1");
			await r.put(drawing, "pdf-drawing-v1");
			const first = await r.run();
			const m = await r.doc(manual);
			const stored = decodeIndex(new TextDecoder().decode((await r.store.get(INDEX_KEY)).body));
			expect({
				syncedAt: m.syncedAt,
				drawingSyncedAt: (await r.doc(drawing)).syncedAt,
				lastSyncAt: stored.lastSync?.at,
				updated: stored.updated,
			}).toEqual({
				syncedAt: first.at,
				drawingSyncedAt: first.at,
				lastSyncAt: first.at,
				updated: first.at,
			});

			// A removal stamps removedAt with the same instant of its own run.
			await r.store.delete(drawing);
			const second = await r.run();
			expect((await r.doc(drawing)).removedAt).toBe(second.at);

			// A failed re-read stamps errorAt and leaves syncedAt where it was.
			await r.put(manual, "pdf-manual-v2");
			r.conv.fail.set("pdf-manual-v2", new Error("pdftotext: timeout"));
			const third = await r.run();
			const broken = await r.doc(manual);
			expect({ errorAt: broken.errorAt, syncedAt: broken.syncedAt }).toEqual({
				errorAt: third.at,
				syncedAt: first.at,
			});
		});

		it("does not announce the removal of a file it never read", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			await r.put(junk, "apple double");
			await r.run();
			expect(r.notes.calls).toHaveLength(0); // the first import is silent
			await r.store.delete(junk);
			const res = await r.run();
			expect({ removed: res.removed, changes: changes(res), notes: r.notes.calls.length }).toEqual({
				removed: 0,
				changes: false,
				notes: 0,
			});
			expect((await r.doc(junk)).status).toBe(STATUS_REMOVED);
		});

		it("signals subscribers after every run and reports a run in flight", async () => {
			const r = createRig(variant.make());
			await r.put(manual, "pdf-manual-v1");
			let signals = 0;
			const off = r.sync.subscribe(() => {
				signals++;
			});
			r.conv.delay = 20;
			const pending = r.sync.sync("web");
			expect(r.sync.running()).toBe(true);
			await pending;
			expect({ signals, running: r.sync.running() }).toEqual({ signals: 1, running: false });
			off();
			await r.sync.sync("web");
			expect(signals).toBe(1);

			// A listener that throws is logged and does not break the run.
			r.sync.subscribe(() => {
				throw new Error("listener broke");
			});
			const res = await r.sync.sync("web");
			expect(res.added).toBe(0);
			expect(logged(r.lines)).toContainEqual(
				expect.objectContaining({ msg: "documents subscriber failed", err: "listener broke" }),
			);
		});

		it("bumps the index generation only when the cached index is replaced", async () => {
			const r = createRig(variant.make());
			const atStart = r.sync.generation();
			const empty = await r.sync.index();
			expect(empty).toEqual(emptyIndex());
			const afterLoad = r.sync.generation();
			expect(afterLoad).toBeGreaterThan(atStart);
			await r.put(manual, "pdf-manual-v1");
			await r.run();
			const afterSync = r.sync.generation();
			expect(afterSync).toBeGreaterThan(afterLoad);
			await r.sync.refresh(); // nothing changed in the bucket
			expect(r.sync.generation()).toBe(afterSync);
			// Another writer replaces the index: the refresh must notice.
			const { etag } = await r.store.get(INDEX_KEY);
			const other: Index = {
				schema: 1,
				docs: [emptyDoc("docs/raw/x.pdf", "abcdef01")],
				lastSync: null,
				updated: "",
			};
			await r.store.put(INDEX_KEY, encoder.encode(encodeIndex(other, "2026-11-11T04:00:00Z")), etag);
			await r.sync.refresh();
			expect(r.sync.generation()).toBe(afterSync + 1);
			expect((await r.sync.index()).docs[0]?.key).toBe("docs/raw/x.pdf");
		});

		it("wraps a broken text blob with the key it came from", async () => {
			const r = createRig(variant.make());
			await r.store.putBlob("docs/text/x.pdf.json", encoder.encode("{"), "application/json");
			const err = await errorOf(async () => await r.sync.pageText(emptyDoc("docs/raw/x.pdf", "x")));
			expect(err.message.startsWith("decode docs/text/x.pdf.json: ")).toBe(true);
		});
	});
}

describe("log lines", () => {
	it("says what a run did, with Go's message and fields", async () => {
		const r = createRig(createMemoryStore());
		await r.put(manual, "pdf-manual-v1");
		await r.run("startup");
		expect(logged(r.lines)).toContainEqual(
			expect.objectContaining({
				level: "INFO",
				msg: "documents synced",
				reason: "startup",
				added: 1,
				changed: 0,
				removed: 0,
				failed: 0,
				skipped: 0,
				refreshed: 0,
				firstImport: true,
			}),
		);
	});
});
