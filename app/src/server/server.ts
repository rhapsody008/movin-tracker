// The HTTP server as one object: the two muxes of Go's Handler(), the auth
// wrapper, the request log line, and the event streams. Port of Server.Handler
// and the helpers beside it (internal/server/server.go:78-180).
//
// The topology is Go's (server-spec §1.1), minus the routes that belong to later
// steps:
//
//	GET /healthz, GET /readyz                            no auth, no log line
//	GET /manifest.webmanifest, the four icons            no auth (iOS fetches them)
//	GET /api/entries, POST /api/entries,
//	PATCH|DELETE /api/entries/{id}, POST /api/changes/{id}/undo,
//	PUT /api/meta, GET /api/events                       behind auth
//	GET /api/admin/guide, GET /api/admin/storage,
//	POST /api/admin/storage/test, GET /api/admin/telegram,
//	PUT /api/settings/telegram, PUT /api/settings/checkin,
//	GET /api/docs, POST /api/docs/sync,
//	GET|PUT /api/settings/llm, POST /api/settings/llm/test,
//	POST /api/settings/llm/models                        behind auth
//	everything else                                      auth -> the catch-all
//
// Not routed yet, so it falls to the catch-all's JSON 404 until its step lands:
// POST /api/chat (T3.5).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Syncer } from "../docs/sync.ts";
import type { EntriesService } from "../entries/service.ts";
import { errorMessage, type Log } from "../log.ts";
import type { ObjectStore } from "../objstore/store.ts";
import type { SettingsService } from "../settings/settings.ts";
import { type AdminRoutes, createAdminRoutes, type TelegramStatusSource } from "./admin.ts";
import { createAuth } from "./auth.ts";
import { createDocsRoutes, type DocsRoutes } from "./docs.ts";
import { createEntriesRoutes, type EntriesRoutes } from "./entries.ts";
import { createEvents, DEFAULT_HEARTBEAT_MS } from "./events.ts";
import { createHealth } from "./health.ts";
import { badRequest, decodePath, FAILED_MESSAGE, hasBadEscape, requestPath, writeErr } from "./http.ts";
import { createLLMSettingsRoutes, type LLMSettingsRoutes } from "./llmsettings.ts";
import { logRequests } from "./logging.ts";
import { cleanPath, createRouter, type Handler, type Handling, type Router, redirect } from "./router.ts";
import { createStatic, type StaticFiles } from "./static.ts";

export interface ServerDeps {
	entries: EntriesService;
	/** The documents syncer, or null when the feature is off: then no `docs` event (§3.3). */
	docs?: Syncer | null;
	/** settings.json: the admin page and the LLM drawer read and write it. */
	settings: SettingsService;
	/** What /readyz stats, and what the storage view describes. */
	store: ObjectStore;
	log: Log;
	staticFiles: StaticFiles;
	/** AUTH_HEADER: the header the oauth2-proxy sidecar sets. */
	authHeader: string;
	/** ALLOWED_EMAILS, lowercased and trimmed; empty lets every signed-in user in. */
	allowedEmails: readonly string[];
	/** DEV_EMAIL: who an empty header signs in as; "" means nobody. */
	devEmail: string;
	/** Server.SSEHeartbeat in milliseconds; 0 or absent leaves Go's 25 s default. */
	sseHeartbeatMs?: number;
	/** Server.Guide in bytes, or null when this build has none (Go's nil Guide). */
	guide?: (() => Promise<Uint8Array>) | null;
	/** The Telegram bot's view of the world (T4); null in T2, as Go's nil *Bot. */
	telegram?: TelegramStatusSource | null;
}

export interface Server {
	/** node:http's request listener. */
	handler: (req: IncomingMessage, res: ServerResponse) => void;
	/** Ends every open SSE stream, so a shutdown does not wait for them (Go's CloseStreams). */
	closeStreams: () => void;
}

/** The files iOS fetches without the sign-in cookie (server.go:102-107). */
const PUBLIC_FILES = ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

/** The route groups, one module each. */
interface ApiRoutes {
	entries: EntriesRoutes;
	events: Handler;
	admin: AdminRoutes;
	llm: LLMSettingsRoutes;
	docs: DocsRoutes;
}

export function createServer(deps: ServerDeps): Server {
	const { log } = deps;
	const staticHandler = createStatic(deps.staticFiles);
	const auth = createAuth({
		authHeader: deps.authHeader,
		allowedEmails: deps.allowedEmails,
		devEmail: deps.devEmail,
		log,
	});
	const health = createHealth({ store: deps.store, log });
	const entries = createEntriesRoutes({ entries: deps.entries, log });
	const streams = createEvents({
		entries: deps.entries,
		docs: deps.docs ?? null,
		log,
		heartbeatMs: deps.sseHeartbeatMs ?? DEFAULT_HEARTBEAT_MS,
	});
	const admin = createAdminRoutes({
		entries: deps.entries,
		settings: deps.settings,
		store: deps.store,
		log,
		guide: deps.guide ?? null,
		telegram: deps.telegram ?? null,
	});
	const llm = createLLMSettingsRoutes({ entries: deps.entries, settings: deps.settings, log });
	const docs = createDocsRoutes({ entries: deps.entries, docs: deps.docs ?? null, log });

	// The root mux: the probes, the files that need no sign-in, and a catch-all
	// that runs everything else behind auth.
	const root = createRouter();
	root.add("GET", "/healthz", health.healthz);
	root.add("GET", "/readyz", health.readyz);
	for (const path of PUBLIC_FILES) root.add("GET", path, staticHandler);

	// The API mux. No catch-all route: a path or a method it does not name falls
	// through to the static handler, which is where Go's `api.Handle("/")` sits
	// and why nothing here can answer 405 (§9.5).
	const api = createRouter();
	addApiRoutes(api, { entries, events: streams.events, admin, llm, docs });

	async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const { path: sent, query } = requestPath(req.url);
		// Go's URL parser refuses an invalid escape before the mux runs.
		if (hasBadEscape(sent)) {
			badRequest(res);
			return;
		}
		// Go's ServeMux cleans the path before it matches and answers 307 to the
		// cleaned one (§9.6). It happens before auth, as it does there.
		const cleaned = cleanPath(sent);
		if (cleaned !== sent) {
			redirect(res, req.method ?? "", 307, query === "" ? cleaned : `${cleaned}?${query}`);
			return;
		}
		const at: Handling = { user: "", id: "", path: decodePath(sent) };
		const method = req.method ?? "";

		const rootMatch = root.match(method, sent);
		if (rootMatch !== null) {
			await rootMatch.handler(req, res, { ...at, id: rootMatch.id });
			return;
		}

		const user = auth(req, res);
		if (user === null) return;
		const behind = { ...at, user };
		const apiMatch = api.match(method, sent);
		if (apiMatch === null) {
			await staticHandler(req, res, behind);
			return;
		}
		await apiMatch.handler(req, res, { ...behind, id: apiMatch.id });
	}

	const logged = logRequests(log, dispatch);

	function failed(req: IncomingMessage, res: ServerResponse, err: unknown): void {
		log.error("request failed", {
			method: req.method ?? "",
			path: decodePath(requestPath(req.url).path),
			err: errorMessage(err),
		});
		if (res.headersSent) {
			// A stream that was already talking: there is no status left to change.
			res.destroy();
			return;
		}
		writeErr(res, 500, FAILED_MESSAGE);
	}

	return {
		handler: (req, res) => {
			logged(req, res).catch((err: unknown) => {
				failed(req, res, err);
			});
		},
		closeStreams: streams.closeStreams,
	};
}

/** Every API route, in Go's registration order (server.go:79-100). */
function addApiRoutes(router: Router, routes: ApiRoutes): void {
	const { entries, events, admin, llm, docs } = routes;
	router.add("GET", "/api/entries", entries.getEntries);
	router.add("POST", "/api/entries", entries.createEntry);
	router.add("PATCH", "/api/entries/{id}", entries.patchEntry);
	router.add("DELETE", "/api/entries/{id}", entries.deleteEntry);
	router.add("POST", "/api/changes/{id}/undo", entries.undoChange);
	router.add("PUT", "/api/meta", entries.putMeta);
	router.add("GET", "/api/events", events);
	// POST /api/chat (T3.5) goes here.
	router.add("GET", "/api/admin/guide", admin.getGuide);
	router.add("GET", "/api/admin/storage", admin.getStorage);
	router.add("POST", "/api/admin/storage/test", admin.testStorage);
	router.add("GET", "/api/admin/telegram", admin.getTelegram);
	router.add("PUT", "/api/settings/checkin", admin.putCheckin);
	router.add("GET", "/api/docs", docs.getDocs);
	router.add("POST", "/api/docs/sync", docs.syncDocs);
	router.add("PUT", "/api/settings/telegram", admin.putTelegram);
	router.add("GET", "/api/settings/llm", llm.getSettings);
	router.add("PUT", "/api/settings/llm", llm.putSettings);
	router.add("POST", "/api/settings/llm/test", llm.testSettings);
	router.add("POST", "/api/settings/llm/models", llm.models);
}
