// The event stream: GET /api/events. Port of Server.events, sse.send and
// sse.comment (internal/server/server.go:351-433), server-spec §3.
//
// The handshake is three headers and a flush, then only `event:`/`data:` blocks
// and `: ping` comments — no id:, no retry:, no replay. The first `entries`
// event is sent before any ping, so a page that reconnects always starts from a
// full snapshot. Every open stream is registered here so a shutdown can end
// them without waiting (Go's CloseStreams); a stream that starts after that
// sends its first snapshot and ends at once, which is what Go's closed
// `s.closing` channel does.

import type { ServerResponse } from "node:http";
import type { Syncer } from "../docs/sync.ts";
import type { Snapshot } from "../entries/service.ts";
import { type EntriesService, snapshotJson } from "../entries/service.ts";
import { goMarshal } from "../gojson.ts";
import type { Log } from "../log.ts";
import { docsView } from "./docsview.ts";
import { fail } from "./http.ts";
import type { Handler } from "./router.ts";

/** Go's default heartbeat: Server.SSEHeartbeat is 0 unless a test sets it (server.go:399-402). */
export const DEFAULT_HEARTBEAT_MS = 25_000;

/** The bytes of one heartbeat: a comment, so EventSource listeners never see it. */
export const PING = ": ping\n\n";

export interface EventsOptions {
	entries: EntriesService;
	/** The documents syncer, or null: then no `docs` event ever fires (§3.3). */
	docs: Syncer | null;
	log: Log;
	/** Server.SSEHeartbeat in milliseconds; 0 leaves the 25 s default. */
	heartbeatMs: number;
}

export interface Events {
	/** GET /api/events. */
	events: Handler;
	/** Ends every open stream, so a shutdown does not wait for them (Go's CloseStreams). */
	closeStreams: () => void;
	/**
	 * Sends one `chat` frame (T3.5) to every stream signed in as `email`, the
	 * sender's own included — the sender recognises its request id (chat.ts). A
	 * stream of another email never sees it: the frame carries no user and the
	 * subscription is per email.
	 */
	chat: (email: string, payload: string) => void;
}

/** One open stream: who it belongs to, and how to write to it. */
interface OpenStream {
	email: string;
	send: (event: string, payload: string) => boolean;
	stop: () => void;
}

export function createEvents(o: EventsOptions): Events {
	// Every open stream, so closeStreams can end them all and a chat frame can
	// reach the ones of one email.
	const open = new Set<OpenStream>();
	// Go's s.closing: closed for good by CloseStreams, so a later stream notices
	// at its first select and returns.
	let closing = false;

	const events: Handler = async (req, res, at) => {
		// Go subscribes before it reads the snapshot and before it writes the
		// headers; a change that lands in between waits in a one-slot channel.
		let started = false;
		let pending: Snapshot | null = null;
		// A docs signal that arrives before the handshake waits for it (§F6): Go's
		// select can only be reached after the first snapshot is written.
		let pendingDocs = false;
		let cancelEntries: (() => void) | null = null;
		let stopDocs: (() => void) | null = null;
		let ticker: ReturnType<typeof setInterval> | null = null;
		let stopped = false;

		// stop unsubscribes, clears the timer and ends the stream. It leaves a
		// response that never got its headers alone: the error that got us here
		// answers it with JSON (§3.1).
		function stop(): void {
			if (stopped) return;
			stopped = true;
			if (ticker !== null) clearInterval(ticker);
			cancelEntries?.();
			stopDocs?.();
			open.delete(stream);
			if (res.headersSent && !res.writableEnded) res.end();
		}

		function send(event: string, payload: string): boolean {
			if (stopped || res.writableEnded || res.destroyed) return false;
			res.write(`event: ${event}\ndata: ${payload}\n\n`);
			return true;
		}

		const stream: OpenStream = { email: at.user, send, stop };

		cancelEntries = o.entries.subscribe((snap) => {
			if (!started) {
				// Latest wins, as the service's one-slot channel does: the snapshot
				// sent first is the one read below, and this is the one after it.
				pending = snap;
				return;
			}
			if (!send("entries", snapshotJson(snap))) stop();
		});

		async function sendDocs(): Promise<void> {
			if (!started) {
				pendingDocs = true;
				return;
			}
			// Go re-reads the view for every signal and drops the event when the
			// index cannot be read (server.go:415-421).
			const view = await docsView(o.docs);
			if (!send("docs", goMarshal(view))) stop();
		}

		if (o.docs !== null) {
			// A failed read drops the event silently, as Go does.
			stopDocs = o.docs.subscribe(() => {
				sendDocs().catch(() => undefined);
			});
		}

		let snap: Snapshot;
		try {
			snap = await o.entries.current();
		} catch (err) {
			// Before the first byte this is an ordinary JSON error (§3.1).
			stop();
			await fail({ entries: o.entries, log: o.log }, req, res, err);
			return;
		}

		startSSE(res);
		open.add(stream);
		res.on("close", stop);
		if (!send("entries", snapshotJson(snap))) {
			stop();
			return;
		}
		started = true;
		const earlier = pending;
		pending = null;
		if (earlier !== null && !send("entries", snapshotJson(earlier))) {
			stop();
			return;
		}
		// The signal that arrived while the snapshot was being read goes out after
		// it, with a fresh view: the stream stays entries-then-docs. A failed read
		// drops the event, as Go's select does (server.go:415-419), and never
		// kills a stream that has already answered.
		if (pendingDocs) {
			pendingDocs = false;
			await sendDocs().catch(() => undefined);
		}
		// A shutdown that happened while this stream was starting ends it here,
		// the way Go's closed channel wins the first select.
		if (closing) {
			stop();
			return;
		}

		const heartbeat = o.heartbeatMs === 0 ? DEFAULT_HEARTBEAT_MS : o.heartbeatMs;
		ticker = setInterval(() => {
			if (!sendComment(res)) stop();
		}, heartbeat);
		ticker.unref();
	};

	return {
		events,
		closeStreams: () => {
			closing = true;
			for (const stream of [...open]) stream.stop();
		},
		chat: (email, payload) => {
			for (const stream of [...open]) {
				if (stream.email !== email) continue;
				if (!stream.send("chat", payload)) stream.stop();
			}
		},
	};
}

/** startSSE writes Go's three headers and nothing else, then flushes them at once (§3.1). */
export function startSSE(res: ServerResponse): void {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		// nginx ingress: do not buffer, or the page never sees an event.
		"X-Accel-Buffering": "no",
	});
	res.flushHeaders();
}

/** sse.comment: the heartbeat, which is a comment and not an event (§3.2). */
function sendComment(res: ServerResponse): boolean {
	if (res.writableEnded || res.destroyed) return false;
	res.write(PING);
	return true;
}
