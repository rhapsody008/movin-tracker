// The two document routes: the list, and "sync now". Port of internal/server/
// docs.go on top of the docsView that T2.1 wrote for the event stream.
//
// The sync answers before it works: 202 with {joined, started}, and the result
// reaches the page over the `docs` event (§3.2). Nothing about the request is
// handed to the sync, so a client that closes the tab does not stop the run.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Syncer } from "../docs/sync.ts";
import type { EntriesService } from "../entries/service.ts";
import { Ordered } from "../gojson.ts";
import { errorMessage, type Log } from "../log.ts";
import { docsView } from "./docsview.ts";
import { fail, writeErr, writeJSON } from "./http.ts";
import type { Handler } from "./router.ts";

/** Go's reason string for a sync started from the page (docs.go:62, "web"). */
const WEB_REASON = "web";

export interface DocsRoutesOptions {
	entries: EntriesService;
	/** The syncer, or null when the documents feature is off. */
	docs: Syncer | null;
	log: Log;
}

export interface DocsRoutes {
	getDocs: Handler;
	syncDocs: Handler;
}

export function createDocsRoutes(o: DocsRoutesOptions): DocsRoutes {
	const { entries, docs, log } = o;

	async function onError(req: IncomingMessage, res: ServerResponse, err: unknown): Promise<void> {
		// Go sends this through fail, so an index read failure is the odd 500
		// line "That change didn't save. Try again." (server-spec §6.4).
		await fail({ entries, log }, req, res, err);
	}

	/** GET /api/docs: on, running, lastSync, docs. */
	const getDocs: Handler = async (req, res) => {
		let view: Ordered;
		try {
			view = await docsView(docs);
		} catch (err) {
			await onError(req, res, err);
			return;
		}
		writeJSON(res, 200, view);
	};

	/** POST /api/docs/sync: start one, or join the one running, and answer at once. */
	const syncDocs: Handler = async (_req, res, h) => {
		if (docs === null) {
			writeErr(res, 404, "Documents are not switched on.");
			return;
		}
		const joined = docs.running();
		// Detached on purpose: no request signal, and the failure is only logged.
		docs.sync(WEB_REASON).catch((err: unknown) => {
			log.warn("document sync from the web page failed", { by: h.user, err: errorMessage(err) });
		});
		log.info("document sync requested", { by: h.user, joined });
		// A Go map, so its two keys come out in byte order.
		writeJSON(
			res,
			202,
			new Ordered([
				["joined", joined],
				["started", !joined],
			]),
		);
	};

	return { getDocs, syncDocs };
}
