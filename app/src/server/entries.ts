// The entries API: the six routes in server-spec §1.2 rows 1-6. Port of
// getEntries, createEntry, patchEntry, deleteEntry, undoChange and putMeta
// (internal/server/server.go:233-349), plus entryResp and respond (:250-266).
//
// Every answer is entryResp: the entry the write touched, the journal change
// (its id is the undo handle, with the banner line ready made) and the new
// document. GET sends the wire snapshot instead, and 304 when the browser
// already has that ETag.

import type { IncomingMessage, ServerResponse } from "node:http";
import { ChangeText } from "../entries/changetext.ts";
import { encodeDocView, encodeEntry, type MetaPatch } from "../entries/model.ts";
import type { EntriesService, Result, Snapshot } from "../entries/service.ts";
import { Ordered } from "../gojson.ts";
import type { Log } from "../log.ts";
import { decodeBody, fail, header, writeErr, writeJSON } from "./http.ts";
import type { Handler } from "./router.ts";

export interface EntriesRoutesOptions {
	entries: EntriesService;
	log: Log;
}

/** The six routes, ready for the router. */
export interface EntriesRoutes {
	getEntries: Handler;
	createEntry: Handler;
	patchEntry: Handler;
	deleteEntry: Handler;
	undoChange: Handler;
	putMeta: Handler;
}

export function createEntriesRoutes(o: EntriesRoutesOptions): EntriesRoutes {
	const { entries, log } = o;

	/** Go's actorOf: the web user as the journal records them. */
	function actorOf(user: string): { by: string; channel: string } {
		return { by: user, channel: "web" };
	}

	async function onError(req: IncomingMessage, res: ServerResponse, err: unknown): Promise<void> {
		await fail({ entries, log }, req, res, err);
	}

	/** GET /api/entries: the snapshot, its ETag, or 304 when the browser has it (§9.9). */
	const getEntries: Handler = async (req, res) => {
		let snap: Snapshot;
		try {
			snap = await entries.current();
		} catch (err) {
			await onError(req, res, err);
			return;
		}
		res.setHeader("ETag", snap.etag);
		if (header(req, "If-None-Match") === snap.etag) {
			// No body, and no Content-Type: only the ETag says anything.
			res.writeHead(304);
			res.end();
			return;
		}
		writeJSON(res, 200, snapshotBody(snap));
	};

	/** POST /api/entries: one patch, 201 with the created entry. */
	const createEntry: Handler = async (req, res, h) => {
		const patch = await decodeBody(req, res);
		if (patch === null) return;
		try {
			const made = await entries.create(actorOf(h.user), [patch]);
			writeJSON(res, 201, respond(made));
		} catch (err) {
			await onError(req, res, err);
		}
	};

	/** PATCH /api/entries/{id}: one patch, 200 with the updated entry. */
	const patchEntry: Handler = async (req, res, h) => {
		const patch = await decodeBody(req, res);
		if (patch === null) return;
		try {
			const done = await entries.update(actorOf(h.user), h.id, patch);
			writeJSON(res, 200, respond(done));
		} catch (err) {
			await onError(req, res, err);
		}
	};

	/** DELETE /api/entries/{id}: 200, and the answer never carries the removed entry. */
	const deleteEntry: Handler = async (req, res, h) => {
		let done: Result;
		try {
			done = await entries.delete(actorOf(h.user), h.id);
		} catch (err) {
			await onError(req, res, err);
			return;
		}
		const gone = done.entries[0];
		if (gone === undefined) {
			await onError(req, res, new Error("delete returned no entry"));
			return;
		}
		log.info("entry deleted", { by: h.user, id: gone.id, title: gone.title });
		writeJSON(res, 200, respond(done, false));
	};

	/** POST /api/changes/{id}/undo: 200 with the entry the undo put back or removed. */
	const undoChange: Handler = async (req, res, h) => {
		try {
			const done = await entries.undo(actorOf(h.user), h.id);
			writeJSON(res, 200, respond(done));
		} catch (err) {
			await onError(req, res, err);
		}
	};

	/** PUT /api/meta: the two key dates, each a string or null. Meta is not journaled. */
	const putMeta: Handler = async (req, res) => {
		const raw = await decodeBody(req, res);
		if (raw === null) return;
		const mp: MetaPatch = {};
		// Go walks a map here, so its own order for two bad keys is random; this
		// walks the body's key order, as the entries patch port does.
		for (const [k, v] of Object.entries(raw)) {
			if (v !== null && typeof v !== "string") {
				writeErr(res, 400, `${k} must be a string or null`);
				return;
			}
			if (k === "moveDate") mp.moveDate = v;
			else if (k === "keyDate") mp.keyDate = v;
			else {
				writeErr(res, 400, `unknown field ${k}`);
				return;
			}
		}
		try {
			const snap = await entries.setMeta(mp);
			writeJSON(res, 200, snapshotBody(snap));
		} catch (err) {
			await onError(req, res, err);
		}
	};

	return { getEntries, createEntry, patchEntry, deleteEntry, undoChange, putMeta };
}

/** The wire snapshot body: doc then etag, as Snapshot.MarshalJSON writes it. */
function snapshotBody(snap: Snapshot): Ordered {
	return new Ordered([
		["doc", encodeDocView(snap.doc)],
		["etag", snap.etag],
	]);
}

/**
 * respond is Go's respond: entry, change, doc, etag in that order, the first two
 * omitted when there is nothing to show. A delete passes entry false, which is
 * Go's `out.Entry = nil`.
 */
function respond(result: Result, withEntry = true): Ordered {
	const fields: [string, unknown][] = [];
	const first = result.entries[0];
	if (withEntry && first !== undefined) fields.push(["entry", encodeEntry(first)]);
	const change = result.changes[0];
	if (change !== undefined) {
		fields.push([
			"change",
			new Ordered([
				["id", change.id],
				["text", ChangeText(change)],
			]),
		]);
	}
	fields.push(["doc", encodeDocView(result.snapshot.doc)], ["etag", result.snapshot.etag]);
	return new Ordered(fields);
}
