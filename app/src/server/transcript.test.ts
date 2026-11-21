// The byte contract, replayed: every request of tmp/t21-golden/main.go's script
// against this port, compared with what Go answered — status, the five headers
// that carry the contract, and the body bytes.
//
// Two things are random in both apps and are masked by first appearance before
// comparing: ULIDs (entry and change ids) and ETags (the store's own values).
// One thing differs on purpose (brief T2.1): the tail of a JSON decode error,
// where Go's text comes from encoding/json. Everything else must be equal.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { snapshotJson } from "../entries/service.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { headerOf, send, startServer } from "./rig.ts";

interface Row {
	name: string;
	method: string;
	path: string;
	reqHeaders: [string, string][];
	reqBody: string;
	/** "oversize": both sides build the same 1 MiB + 1 byte body instead. */
	reqBodyKind?: string;
	status: number;
	headers: Record<string, string>;
	body: string;
}

const fixture = JSON.parse(readFileSync(new URL("./testdata/transcript.go.json", import.meta.url), "utf8")) as Row[];

/** The clock the Go harness pins (main.go: fixed). */
const FIXED = new Date("2026-11-12T10:00:00Z");

/** The headers the transcript records (server-spec §1.4, §2.1, §9.1). */
const COMPARED = ["content-type", "etag", "location", "cache-control", "x-content-type-options"];

/** Crockford base32, 26 characters: a ULID, which is every id the API hands out. */
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;

/** A JSON "etag" field, whose value Go writes with its S3 quotes escaped. */
const ETAG_FIELD = /("etag":")((?:[^"\\]|\\.)*)(")/g;

/** The decode-error prefix; the tail after it is this port's own text. */
const DECODE_TAIL = /("Request body must be JSON: )([^"]*)"/g;

/** The two tails that must match Go exactly; every other tail is masked. */
const EXACT_TAILS = new Set(["EOF", "http: request body too large"]);

/**
 * maskDecodeTails leaves the two texts the port promises to match and blanks the
 * rest, on both sides: that is the one documented difference (brief T2.1).
 */
function maskDecodeTails(text: string): string {
	return text.replace(DECODE_TAIL, (whole, prefix: string, tail: string) =>
		EXACT_TAILS.has(tail) ? whole : `${prefix}<TAIL>"`,
	);
}

/** One side's ids and etags, numbered by the order they first appear in. */
class Mask {
	readonly ids: string[] = [];
	readonly etags: string[] = [];
	private readonly seenIds = new Set<string>();
	private readonly seenEtags = new Set<string>();

	/** Masks one response (its ETag header and its body) and records what is new. */
	answer(etagHeader: string, body: string): { etag: string; body: string } {
		const etag = etagHeader === "" ? "" : this.etag(etagHeader);
		return { etag, body: maskDecodeTails(this.text(body)) };
	}

	private text(body: string): string {
		return body
			.replace(ETAG_FIELD, (_whole, prefix: string, value: string, suffix: string) => {
				return `${prefix}${this.etag(value)}${suffix}`;
			})
			.replace(ULID, (id) => this.id(id));
	}

	etag(value: string): string {
		const seen = this.etags.indexOf(value);
		if (seen >= 0) return `<ETAG${seen + 1}>`;
		if (!this.seenEtags.has(value)) {
			this.seenEtags.add(value);
			this.etags.push(value);
		}
		return `<ETAG${this.etags.indexOf(value) + 1}>`;
	}

	id(value: string): string {
		const seen = this.ids.indexOf(value);
		if (seen >= 0) return `<ID${seen + 1}>`;
		if (!this.seenIds.has(value)) {
			this.seenIds.add(value);
			this.ids.push(value);
		}
		return `<ID${this.ids.indexOf(value) + 1}>`;
	}
}

/** Every ULID of one response body, in order of appearance. */
function idsIn(body: string): string[] {
	return [...body.matchAll(ULID)].map((m) => m[0]);
}

/** Every ETag of one response: the header and the body's "etag" fields. */
function etagsIn(etagHeader: string, body: string): string[] {
	const out: string[] = [];
	if (etagHeader !== "") out.push(etagHeader);
	for (const m of body.matchAll(ETAG_FIELD)) {
		const value = m[2];
		if (value !== undefined) out.push(value);
	}
	return out;
}

/** 1 MiB + 1 bytes of a JSON object: one over the cap, as the Go harness builds it. */
function oversizeBody(): string {
	const prefix = `{"title":"`;
	const suffix = `"}`;
	// The parentheses matter: in Go 1<<20+1 parses as (1<<20)+1, in JavaScript
	// it would be 1<<(20+1).
	return prefix + "a".repeat((1 << 20) + 1 - prefix.length - suffix.length) + suffix;
}

/** The Go run's ids and etags, so a path or header can name the port's own. */
const goIds: string[] = [];
const goEtags: string[] = [];
for (const row of fixture) {
	for (const id of idsIn(row.body)) if (!goIds.includes(id)) goIds.push(id);
	for (const etag of etagsIn(row.headers.etag ?? "", row.body)) if (!goEtags.includes(etag)) goEtags.push(etag);
}

/** Replaces the Go ids and ETags a later step names with this run's own. */
function rename(sent: string, tsIds: readonly string[], tsEtags: readonly string[]): string {
	let out = sent;
	tsEtags.forEach((ts, i) => {
		const go = goEtags[i];
		if (go !== undefined) out = out.split(go).join(ts);
	});
	tsIds.forEach((ts, i) => {
		const go = goIds[i];
		if (go !== undefined) out = out.split(go).join(ts);
	});
	return out;
}

describe("the Go transcript", () => {
	it("answers all 45 requests byte for byte (TestTranscriptIsTheGoBytes)", async () => {
		const rig = await startServer({ store: createMemoryStore(), now: () => FIXED });
		const goMask = new Mask();
		const tsMask = new Mask();
		const tsIds: string[] = [];
		const tsEtags: string[] = [];
		try {
			for (const want of fixture) {
				// The Go harness signs every request in as zy@example.com unless a
				// step overrides the header (main.go:runScript).
				const headers: Record<string, string> = { "X-Forwarded-Email": "zy@example.com" };
				for (const [name, value] of want.reqHeaders) headers[name] = rename(value, tsIds, tsEtags);

				const got = await send(
					rig.port,
					want.method,
					rename(want.path, tsIds, tsEtags),
					want.reqBodyKind === "oversize" ? oversizeBody() : want.reqBody === "" ? undefined : want.reqBody,
					headers,
				);

				// Learn this run's ids and etags before the next step can name them.
				for (const id of idsIn(got.raw)) if (!tsIds.includes(id)) tsIds.push(id);
				for (const etag of etagsIn(headerOf(got.headers, "etag"), got.raw)) {
					if (!tsEtags.includes(etag)) tsEtags.push(etag);
				}

				const expected = goMask.answer(want.headers.etag ?? "", want.body);
				const actual = tsMask.answer(headerOf(got.headers, "etag"), got.raw);
				const wantHeaders: Record<string, string> = {};
				const gotHeaders: Record<string, string> = {};
				for (const name of COMPARED) {
					wantHeaders[name] = name === "etag" ? expected.etag : (want.headers[name] ?? "");
					gotHeaders[name] = name === "etag" ? actual.etag : headerOf(got.headers, name);
				}

				// One assertion per request, so a failure names the step.
				expect([want.name, got.status]).toEqual([want.name, want.status]);
				expect([want.name, gotHeaders]).toEqual([want.name, wantHeaders]);
				expect([want.name, actual.body]).toEqual([want.name, expected.body]);
			}
		} finally {
			await rig.close();
		}
	}, 30_000);

	it("writes the wire snapshot as Go does, omitempty included (TestSnapshotIsTheGoBytes)", async () => {
		// The same three entries the script has written by its "entries-two" step,
		// made through the service instead of HTTP, then the snapshot body checked
		// against Go's. This is the pin on the wire form: milestone false and
		// completed null must be left out (omitempty), never written as false/null.
		const rig = await startServer({ store: createMemoryStore(), now: () => FIXED });
		try {
			const actor = { by: "zy@example.com", channel: "web" };
			// The three patches the script posts: the plain one, the one with <, & and a
			// quote in its title, and the one that follows the trailing-data body.
			const patches: Record<string, unknown>[] = [
				{ title: "Book movers", kind: "task", date: "2026-11-20", time: "10:00", cost: { estimate: 1200 } },
				{
					title: `Paint <&" seal`,
					kind: "idea",
					room: "flex",
					date: "2026-12-01",
					time: "08:30",
					vendor: "Ah Seng & Sons",
					cost: { estimate: 1234.5 },
					notes: "a > b & c",
					source: "WhatsApp",
				},
				{ title: "Trailing" },
			];
			for (const patch of patches) await rig.entries.create(actor, [patch]);
			const snap = await rig.entries.current();
			const row = fixture.find((r) => r.name === "entries-two");
			if (row === undefined) throw new Error("fixture: no entries-two step");
			const want = new Mask().answer(row.headers.etag ?? "", row.body);
			const got = new Mask().answer(snap.etag, `${snapshotJson(snap)}\n`);
			expect([got.etag, got.body]).toEqual([want.etag, want.body]);
		} finally {
			await rig.close();
		}
	});

	it("masks exactly three things, and none of them is an entry field", () => {
		// A guard on the masking itself: if a future change makes the transcript
		// match by hiding more, this fails.
		expect(maskDecodeTails(`{"error":"Request body must be JSON: unexpected EOF"}`)).toBe(
			`{"error":"Request body must be JSON: <TAIL>"}`,
		);
		expect(maskDecodeTails(`{"error":"Request body must be JSON: EOF"}`)).toBe(
			`{"error":"Request body must be JSON: EOF"}`,
		);
		expect(maskDecodeTails(`{"error":"Request body must be JSON: http: request body too large"}`)).toBe(
			`{"error":"Request body must be JSON: http: request body too large"}`,
		);
	});
});
