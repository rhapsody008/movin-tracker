// The HTTP layer's ported Go tests: internal/server/server_test.go, the six the
// T2.1 column of server-spec §7 assigns to this step, plus the two halves of the
// error mapper (fail) that T2.1 owns even though their Go tests arrive with the
// settings routes in T2.2.
//
// Like the Go tests, TestRESTCRUD runs on both stores: the memory one always,
// MinIO when S3_ENDPOINT_URL and S3_BUCKET are set (as they are under
// `make -C app test`).
import { randomUUID } from "node:crypto";
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ConflictError as EntriesConflictError } from "../entries/errors.ts";
import { MAX_RETRIES } from "../entries/service.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import { type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { ConflictError as SettingsConflictError } from "../settings/errors.ts";
import { type Answer, headerOf, PARTNER, startServer, ZY } from "./rig.ts";

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the server suite would be skipped",
	);
}

interface Variant {
	name: string;
	/** A store nothing else in the suite uses. */
	make: () => ObjectStore;
}

const runPrefix = `test-server-ts-${Date.now()}`;
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

/** The `entry` and `doc` parts of an answer, typed loosely: the bytes are the assertion. */
function entryOf(a: Answer): Record<string, unknown> {
	const entry = a.json.entry;
	if (typeof entry !== "object" || entry === null) throw new Error(`no entry in ${a.raw}`);
	return entry as Record<string, unknown>;
}

function changeOf(a: Answer): Record<string, unknown> {
	const change = a.json.change;
	if (typeof change !== "object" || change === null) throw new Error(`no change in ${a.raw}`);
	return change as Record<string, unknown>;
}

function docOf(a: Answer): Record<string, unknown> {
	const doc = a.json.doc;
	if (typeof doc !== "object" || doc === null) throw new Error(`no doc in ${a.raw}`);
	return doc as Record<string, unknown>;
}

function entriesOf(a: Answer): unknown[] {
	const entries = docOf(a).entries;
	if (!Array.isArray(entries)) throw new Error(`no entries in ${a.raw}`);
	return entries;
}

describe("the probes (TestHealth)", () => {
	it("answers /healthz and /readyz without an auth header", async () => {
		const rig = await startServer();
		try {
			for (const path of ["/healthz", "/readyz"]) {
				const got = await rig.do("GET", path, undefined, { "X-Forwarded-Email": "" });
				expect([path, got.status, got.raw]).toEqual([path, 200, "ok\n"]);
			}
		} finally {
			await rig.close();
		}
	});
});

describe("auth (TestAuth)", () => {
	it("rejects without a header, rejects a stranger, accepts any case, and leaves the icons open", async () => {
		const rig = await startServer();
		try {
			const missing = await rig.do("GET", "/api/entries", undefined, { "X-Forwarded-Email": "" });
			expect(missing.status).toBe(401);
			expect(missing.raw).toBe("Not signed in.\n");
			expect(headerOf(missing.headers, "x-content-type-options")).toBe("nosniff");

			const stranger = await rig.do("GET", "/api/entries", undefined, { "X-Forwarded-Email": "stranger@example.com" });
			expect([stranger.status, stranger.raw]).toEqual([
				403,
				"This page is private. stranger@example.com is not on the list.\n",
			]);
			expect(rig.lines.join("\n")).toContain("rejected user not on ALLOWED_EMAILS");

			const page = await rig.do("GET", "/", undefined, { "X-Forwarded-Email": "stranger@example.com" });
			expect(page.status).toBe(403);

			const partner = await rig.do("GET", "/api/entries", undefined, { "X-Forwarded-Email": "Partner@Example.com" });
			expect(partner.status).toBe(200);

			const icon = await rig.do("GET", "/icon.svg", undefined, { "X-Forwarded-Email": "" });
			expect([icon.status, icon.raw]).toEqual([200, "<svg/>"]);

			const index = await rig.do("GET", "/");
			expect(index.status).toBe(200);
			expect(index.raw).toContain("Our new place");
			expect(headerOf(index.headers, "cache-control")).toBe("no-cache");
		} finally {
			await rig.close();
		}
	});
});

describe("the dev email (TestDevEmailFallback)", () => {
	it("signs an empty header in as DEV_EMAIL, and the entry records it", async () => {
		const rig = await startServer({ devEmail: ZY });
		try {
			const got = await rig.do("POST", "/api/entries", `{"title":"as dev"}`, { "X-Forwarded-Email": "" });
			expect([got.status, entryOf(got).by]).toEqual([201, "zy@example.com"]);
		} finally {
			await rig.close();
		}
	});
});

describe("the REST walk (TestRESTCRUD)", () => {
	for (const variant of variants) {
		it(`creates, patches, deletes and undoes on the ${variant.name} store`, async () => {
			const rig = await startServer({ store: variant.make() });
			try {
				const created = await rig.do(
					"POST",
					"/api/entries",
					`{"title":"Book movers","kind":"task","date":"2026-11-20","time":"10:00","cost":{"estimate":1200}}`,
				);
				expect(created.status).toBe(201);
				const entry = entryOf(created);
				const id = String(entry.id);
				expect([entry.by, entry.channel, entry.status]).toEqual([ZY, "web", "todo"]);
				expect(created.json.etag).not.toBe("");
				expect(changeOf(created).text).toBe("Saved: task · Book movers · Fri, 20 Nov 10:00 · est $1,200");

				// Three validation errors, each its own text.
				for (const [body, want] of [
					[`{"title":""}`, "title must be 1–200 characters"],
					[`{"title":"x","date":"tomorrow"}`, "date must be YYYY-MM-DD"],
					[`{"title":"x","room":"garage"}`, `room must be one of `],
				] as const) {
					const bad = await rig.do("POST", "/api/entries", body);
					expect([bad.status, String(bad.json.error).startsWith(want)]).toEqual([400, true]);
				}

				const patched = await rig.do("PATCH", `/api/entries/${id}`, `{"status":"done","cost":{"actual":1200}}`, {
					"X-Forwarded-Email": PARTNER,
				});
				expect([patched.status, entryOf(patched).status, entryOf(patched).by]).toEqual([200, "done", PARTNER]);

				const missing = await rig.do("PATCH", "/api/entries/nope", `{"status":"done"}`);
				expect(missing.status).toBe(404);

				const meta = await rig.do("PUT", "/api/meta", `{"moveDate":"2026-12-05","keyDate":"2026-10-29"}`);
				expect([meta.status, (docOf(meta).meta as Record<string, unknown>).moveDate]).toEqual([200, "2026-12-05"]);
				// Meta is not journaled: no entry, no change line.
				expect(Object.keys(meta.json).sort()).toEqual(["doc", "etag"]);

				const badMeta = await rig.do("PUT", "/api/meta", `{"moveDate":"5 Dec"}`);
				expect([badMeta.status, badMeta.json.error]).toEqual([400, "moveDate must be YYYY-MM-DD"]);

				const list = await rig.do("GET", "/api/entries");
				expect([list.status, entriesOf(list).length]).toEqual([200, 1]);

				const deleted = await rig.do("DELETE", `/api/entries/${id}`);
				expect([deleted.status, entriesOf(deleted).length]).toEqual([200, 0]);
				// A delete response never carries the entry it removed.
				expect(deleted.json.entry).toBeUndefined();
				const changeId = String(changeOf(deleted).id);
				expect(changeId).not.toBe("");

				const twice = await rig.do("DELETE", `/api/entries/${id}`);
				expect([twice.status, twice.json.error]).toEqual([404, "That entry no longer exists."]);

				// Undo the delete: the entry is back, stamped with the undoer.
				const undone = await rig.do("POST", `/api/changes/${changeId}/undo`, undefined, {
					"X-Forwarded-Email": PARTNER,
				});
				expect([undone.status, entriesOf(undone).length]).toEqual([200, 1]);
				expect(String(changeOf(undone).text).startsWith("Undone:")).toBe(true);
				expect(entryOf(undone).by).toBe(PARTNER);

				// The same change again: the entry no longer matches, so 409 with the latest doc.
				const stale = await rig.do("POST", `/api/changes/${changeId}/undo`);
				expect([stale.status, stale.json.error, stale.json.doc === null]).toEqual([
					409,
					"That entry was changed again since, so it can't be undone.",
					false,
				]);
				expect(stale.json.etag).not.toBe("");

				const unknown = await rig.do("POST", "/api/changes/nope/undo");
				expect([unknown.status, unknown.json.error]).toEqual([404, "That change is too old to undo."]);
			} finally {
				await rig.close();
			}
		}, 60_000);
	}
});

/** conflictStore lets the conditional PUTs lose, to drive a 409 (server_test.go:296-308). */
function conflictStore(inner: ObjectStore): ObjectStore & { lose: number } {
	const wrapped: ObjectStore & { lose: number } = {
		...inner,
		lose: 0,
		put: async (key, body, ifMatch, signal) => {
			// Only a conditional write loses, as Go's fake does.
			if (wrapped.lose > 0 && ifMatch !== null) {
				wrapped.lose--;
				throw new PreconditionError(key);
			}
			return await inner.put(key, body, ifMatch, signal);
		},
	};
	return wrapped;
}

describe("a lost ETag race (TestConflictReturns409WithLatestDoc)", () => {
	it("answers 409 with the latest document", async () => {
		const store = conflictStore(createMemoryStore());
		const rig = await startServer({ store });
		try {
			store.lose = MAX_RETRIES + 1;
			const got = await rig.do("POST", "/api/entries", `{"title":"x"}`);
			expect([got.status, got.json.error]).toEqual([409, "Someone else just changed this. Showing the latest."]);
			// The body re-reads the document, so the page can re-render: doc and etag.
			expect(got.json.doc).not.toBeNull();
			expect(entriesOf(got)).toEqual([]);
		} finally {
			await rig.close();
		}
	});
});

describe("the event stream (TestSSEBroadcastsWrites)", () => {
	it("sends the open document first and then every write", async () => {
		const rig = await startServer({ heartbeatMs: 50 });
		const stream = await rig.open("/api/events", { "X-Forwarded-Email": PARTNER });
		try {
			expect(headerOf(stream.headers, "content-type")).toBe("text/event-stream");
			const first = await stream.next();
			expect(first.startsWith("event: entries\ndata: {")).toBe(true);
			expect(first.endsWith("\n\n")).toBe(true);
			const snap = JSON.parse(first.slice("event: entries\ndata: ".length, -2)) as { doc: { entries: unknown[] } };
			expect(snap.doc.entries).toEqual([]);

			const made = await rig.do("POST", "/api/entries", `{"title":"Lift booking"}`);
			expect(made.status).toBe(201);

			// The write's event, read within the 5 s the Go test allows.
			const event = await withTimeout(nextEntriesEvent(stream), 5000);
			const pushed = JSON.parse(event) as { doc: { entries: { title: string }[] } };
			expect(pushed.doc.entries.map((e) => e.title)).toEqual(["Lift booking"]);
		} finally {
			stream.close();
			await rig.close();
		}
	});
});

/** The next chunk that carries an `entries` event, skipping pings. */
async function nextEntriesEvent(stream: { next: () => Promise<string> }): Promise<string> {
	for (;;) {
		const chunk = await stream.next();
		const at = chunk.indexOf("event: entries\ndata: ");
		if (at >= 0) return chunk.slice(at + "event: entries\ndata: ".length, chunk.indexOf("\n\n", at));
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`nothing arrived within ${ms} ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

describe("what the page receives (TestPageNeverReceivesTheJournal)", () => {
	it("never carries the journal, keeps the change line, and answers 304 to a known ETag", async () => {
		const rig = await startServer();
		try {
			const created = await rig.do("POST", "/api/entries", `{"title":"Book movers"}`);
			const id = String(entryOf(created).id);
			const patched = await rig.do("PATCH", `/api/entries/${id}`, `{"status":"shortlisted"}`);
			const list = await rig.do("GET", "/api/entries");

			for (const [i, body] of [created.raw, patched.raw, list.raw].entries()) {
				expect([i, body.includes(`"changes"`), body.includes(`"entries"`)]).toEqual([i, false, true]);
			}
			// The change line (with its undo id) still comes with each write.
			expect(patched.raw).toContain(`"change":{"id":"`);

			// If nothing changed since the page's copy: 304, no body, the ETag.
			const etag = String(list.json.etag);
			const same = await rig.do("GET", "/api/entries", undefined, { "If-None-Match": etag });
			expect([same.status, same.raw]).toEqual([304, ""]);
			expect(headerOf(same.headers, "etag")).toBe(etag);
			expect(headerOf(same.headers, "content-type")).toBe("");
		} finally {
			await rig.close();
		}
	});
});

describe("the error mapper (fail)", () => {
	it("gives a settings conflict its own message and no document (TestSettingsConflictHasItsOwnMessage)", async () => {
		const rig = await startServer({
			entries: (inner) => ({
				...inner,
				// The settings save is T2.2's route; its 409 goes through the same mapper.
				undo: async () => {
					throw new SettingsConflictError();
				},
			}),
		});
		try {
			const got = await rig.do("POST", "/api/changes/whatever/undo");
			expect([got.status, got.json.error]).toEqual([
				409,
				"These settings were changed somewhere else at the same moment. Reopen Settings and try again.",
			]);
			// The settings text has no doc, which is what tells the two 409s apart.
			expect(got.json.doc).toBeUndefined();
			expect(got.json.etag).toBeUndefined();
		} finally {
			await rig.close();
		}
	});

	it("sends doc null and an empty etag when the 409's own re-read fails (TestConflictWithAnUnreadableDocument)", async () => {
		const rig = await startServer({
			entries: (inner) => ({
				...inner,
				create: async () => {
					throw new EntriesConflictError();
				},
				current: async () => {
					throw new Error("the store is gone");
				},
			}),
		});
		try {
			const got = await rig.do("POST", "/api/entries", `{"title":"x"}`);
			expect(got.status).toBe(409);
			expect([got.raw.includes(`"doc":null`), got.json.error]).toEqual([
				true,
				"Someone else just changed this. Showing the latest.",
			]);
			expect(got.json.etag).toBe("");
		} finally {
			await rig.close();
		}
	});

	it("maps an unexpected error to 500 with Go's line and a log line (TestUnexpectedFailureIs500)", async () => {
		const rig = await startServer({
			entries: (inner) => ({
				...inner,
				delete: async () => {
					throw new Error("disk on fire");
				},
			}),
		});
		try {
			const got = await rig.do("DELETE", "/api/entries/x");
			expect([got.status, got.json.error]).toEqual([500, "That change didn't save. Try again."]);
			const logged = rig.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(
				logged.some(
					(line) => line.msg === "request failed" && line.path === "/api/entries/x" && line.err === "disk on fire",
				),
			).toBe(true);
		} finally {
			await rig.close();
		}
	});
});

describe("a request the URL parser cannot read (TestBadEscapeIs400)", () => {
	it("answers Go's bare 400 for an invalid percent escape", async () => {
		const rig = await startServer();
		try {
			const got = await rig.do("GET", "/api/entries/%zz");
			expect([got.status, got.raw]).toEqual([400, "400 Bad Request"]);
			expect(headerOf(got.headers, "content-type")).toBe("text/plain; charset=utf-8");
			// Go answers this before routing, so the API's JSON 404 never happens.
			expect(headerOf(got.headers, "x-content-type-options")).toBe("");
		} finally {
			await rig.close();
		}
	});
});
