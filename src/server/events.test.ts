// The event stream's own contract: the exact bytes of the handshake, the
// heartbeat, the docs event, and the cleanup when a page goes away. The Go tests
// only cover "a write shows up" (TestSSEBroadcastsWrites, ported in
// server.test.ts); these are the parts of server-spec §3 a byte comparison can
// catch and a leak would break.
import { describe, expect, it } from "vitest";
import { FakeConverter } from "../docs/convert/fake.ts";
import { createSyncer, type Syncer } from "../docs/sync.ts";
import type { Page } from "../docs/types.ts";
import { snapshotJson } from "../entries/service.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { headerOf, type ServerStream, startServer } from "./rig.ts";

const encoder = new TextEncoder();

/** The body of one SSE frame: everything after "event: <name>\ndata: " and before "\n\n". */
function payloadOf(frame: string): string {
	const at = frame.indexOf("\n");
	if (!frame.startsWith("event: ") || at < 0) throw new Error(`not an event frame: ${JSON.stringify(frame)}`);
	const data = frame.slice(at + 1);
	if (!data.startsWith("data: ")) throw new Error(`no data line: ${JSON.stringify(frame)}`);
	return data.slice("data: ".length);
}

/** Reads frames until one has this name; pings are skipped. */
async function nextEvent(stream: ServerStream, name: string): Promise<string> {
	for (;;) {
		const chunk = await stream.next();
		for (const frame of chunk.split("\n\n")) {
			if (frame.startsWith(`event: ${name}\n`)) return frame;
		}
	}
}

/** Waits until the condition holds, or fails after about two seconds. */
async function until(what: string, ok: () => boolean): Promise<void> {
	for (let i = 0; i < 200; i++) {
		if (ok()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("the event stream handshake", () => {
	it("sends the snapshot first and a ping only after it (TestEventsFirstFrameIsTheSnapshot)", async () => {
		const rig = await startServer({ heartbeatMs: 20 });
		const stream = await rig.open("/api/events");
		try {
			expect(headerOf(stream.headers, "content-type")).toBe("text/event-stream");
			expect(headerOf(stream.headers, "cache-control")).toBe("no-cache");
			expect(headerOf(stream.headers, "x-accel-buffering")).toBe("no");

			// The first frame is the snapshot, byte for byte: the same body as
			// GET /api/entries, without the newline the JSON writer appends.
			const snap = await rig.entries.current();
			const first = await stream.next();
			expect(first).toBe(`event: entries\ndata: ${snapshotJson(snap)}\n\n`);

			// The heartbeat is a comment, so EventSource listeners never see it.
			const ping = await stream.next();
			expect(ping).toBe(": ping\n\n");
		} finally {
			stream.close();
			await rig.close();
		}
	});

	it("releases both subscriptions when the page goes away (TestEventsCleansUpOnClose)", async () => {
		let entryListeners = 0;
		let docListeners = 0;
		const { log } = createTestLog();
		const sync = createSyncer({ store: createMemoryStore(), converter: new FakeConverter(), log });
		const watchedDocs: Syncer = {
			...sync,
			subscribe: (listener) => {
				docListeners++;
				const off = sync.subscribe(listener);
				return () => {
					docListeners--;
					off();
				};
			},
		};
		const rig = await startServer({
			heartbeatMs: 20,
			docs: watchedDocs,
			entries: (inner) => ({
				...inner,
				subscribe: (listener) => {
					entryListeners++;
					const off = inner.subscribe(listener);
					return () => {
						entryListeners--;
						off();
					};
				},
			}),
		});
		const stream = await rig.open("/api/events");
		try {
			await stream.next();
			expect([entryListeners, docListeners]).toEqual([1, 1]);
			stream.close();
			// Both listeners and the heartbeat timer are released on close: the
			// unsubscribe functions are the only way the counters go down.
			await until("the subscriptions to be released", () => entryListeners === 0 && docListeners === 0);
			expect([entryListeners, docListeners]).toEqual([0, 0]);
		} finally {
			stream.close();
			await rig.close();
		}
	});

	it("ends an open stream on closeStreams, so a shutdown does not wait (TestCloseStreamsEndsThem)", async () => {
		const rig = await startServer({ heartbeatMs: 20 });
		const stream = await rig.open("/api/events");
		await stream.next();
		rig.closeStreams();
		// The server ends the response; the client sees the stream finish.
		await expect(stream.next()).rejects.toThrow("the stream ended");
		await rig.close();
	});

	it("sends one docs event for a finished sync (TestDocsEventIsTheView)", async () => {
		const store = createMemoryStore();
		const { log } = createTestLog();
		const converter = new FakeConverter();
		const pdf = encoder.encode("%PDF-1.4 fridge manual");
		converter.pages.set(Buffer.from(pdf).toString("latin1"), [page(1, LONG), page(2, LONG)]);
		const sync = createSyncer({ store, converter, log, now: () => new Date("2026-11-11T03:00:00Z") });
		const rig = await startServer({ docs: sync, heartbeatMs: 5000 });
		await store.putBlob("docs/raw/4.0 Manuals/Fridge.pdf", pdf, "application/pdf");
		const stream = await rig.open("/api/events");
		try {
			await stream.next();
			// The result reaches the page over the stream, never in the response.
			await sync.sync("web");
			const frame = await nextEvent(stream, "docs");
			const view = JSON.parse(payloadOf(frame)) as Record<string, unknown>;
			expect([view.on, view.running]).toEqual([true, false]);
			expect((view.lastSync as Record<string, unknown>).reason).toBe("web");
			const docs = view.docs as Record<string, unknown>[];
			expect(docs.map((d) => [d.name, d.folder, d.status, d.class])).toEqual([
				["Fridge.pdf", "4.0 Manuals", "ok", "text"],
			]);
		} finally {
			stream.close();
			await rig.close();
		}
	});

	it("ends a stream that starts after closeStreams, after its first snapshot (F5)", async () => {
		const rig = await startServer({ heartbeatMs: 20 });
		rig.closeStreams();
		// A shutdown that already happened ends this stream too: Go's closed
		// s.closing channel wins the first select, after the snapshot is out.
		const stream = await rig.open("/api/events");
		try {
			expect(headerOf(stream.headers, "content-type")).toBe("text/event-stream");
			expect((await stream.next()).startsWith("event: entries\ndata: ")).toBe(true);
			await expect(stream.next()).rejects.toThrow("the stream ended");
		} finally {
			stream.close();
			await rig.close();
		}
	});

	it("sends a docs signal that arrives before the handshake after the snapshot (F6)", async () => {
		const store = createMemoryStore();
		const { log } = createTestLog();
		const sync = createSyncer({ store, converter: new FakeConverter(), log });
		let fire: (() => void) | null = null;
		const armed: Syncer = {
			...sync,
			subscribe: (listener) => {
				fire = listener;
				return sync.subscribe(listener);
			},
		};
		const rig = await startServer({
			docs: armed,
			heartbeatMs: 5000,
			entries: (inner) => ({
				...inner,
				// The sync finishes while the first snapshot is being read, so the
				// signal lands before the SSE headers exist.
				current: async () => {
					fire?.();
					await new Promise((resolve) => setTimeout(resolve, 20));
					return await inner.current();
				},
			}),
		});
		const stream = await rig.open("/api/events");
		try {
			// Well formed: the headers, then entries, then docs — never a docs frame
			// written before the handshake.
			let text = "";
			while ((text.match(/\n\n/g) ?? []).length < 2) text += await stream.next();
			expect(text.startsWith("event: entries\ndata: ")).toBe(true);
			expect(text).toContain('\n\nevent: docs\ndata: {"on":true,"running":false,"docs":[]}\n\n');
		} finally {
			stream.close();
			await rig.close();
		}
	});

	it("drops a failed docs read at stream start instead of killing the stream (G1)", async () => {
		const store = createMemoryStore();
		const { log } = createTestLog();
		const sync = createSyncer({ store, converter: new FakeConverter(), log });
		let fire: (() => void) | null = null;
		const broken: Syncer = {
			...sync,
			// Every docs event's view read fails, as Go's does when the index cannot
			// be read (server.go:415-419).
			index: async () => {
				throw new Error("index unreadable");
			},
			subscribe: (listener) => {
				fire = listener;
				return sync.subscribe(listener);
			},
		};
		const rig = await startServer({
			docs: broken,
			heartbeatMs: 20,
			entries: (inner) => ({
				...inner,
				// The sync finishes while the first snapshot is being read, so the
				// failing event is queued during the handshake.
				current: async () => {
					fire?.();
					await new Promise((resolve) => setTimeout(resolve, 20));
					return await inner.current();
				},
			}),
		});
		const stream = await rig.open("/api/events");
		try {
			expect((await stream.next()).startsWith("event: entries\ndata: ")).toBe(true);
			// The stream is still open: the next frame is the heartbeat, not the end.
			expect(await stream.next()).toBe(": ping\n\n");
			// And the failure was dropped, not reported as a request error.
			expect(rig.lines.join("\n")).not.toContain("request failed");
		} finally {
			stream.close();
			await rig.close();
		}
	});

	it("sends no docs event when the feature is off", async () => {
		const rig = await startServer({ docs: null, heartbeatMs: 20 });
		const stream = await rig.open("/api/events");
		try {
			await stream.next();
			// Two heartbeats come through with nothing in between: no docs view.
			const second = await stream.next();
			const third = await stream.next();
			expect([second, third]).toEqual([": ping\n\n", ": ping\n\n"]);
		} finally {
			stream.close();
			await rig.close();
		}
	});
});

/** 240 characters, so a page counts as having text (MIN_TEXT_CHARS is 100). */
const LONG = "Defrost the freezer every six months. Keep the door seal clean with warm soapy water. ".repeat(3);

function page(n: number, text: string): Page {
	return { n, w: 595, h: 842, text };
}
