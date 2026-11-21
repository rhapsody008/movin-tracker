// The two probes. Port of the /healthz and /readyz routes (internal/server/
// server.go:108, :169-180).
//
// Neither is behind auth and neither writes a request log line: Docker's
// HEALTHCHECK, the k8s liveness probe and the proxy's readiness probe call them
// without a user, every few seconds (server-spec §4).

import type { ServerResponse } from "node:http";
import { KEY } from "../entries/service.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectStore } from "../objstore/store.ts";
import { httpError } from "./http.ts";
import type { Handler } from "./router.ts";

/** readyz gives the store five seconds, then answers 503 (server.go:170). */
export const READY_TIMEOUT_MS = 5000;

export interface HealthOptions {
	store: ObjectStore;
	log: Log;
}

export interface HealthRoutes {
	/** GET /healthz: liveness only, no store call. */
	healthz: Handler;
	/** GET /readyz: one Stat of entries.json; a missing object is fine. */
	readyz: Handler;
}

export function createHealth(o: HealthOptions): HealthRoutes {
	const healthz: Handler = (_req, res) => {
		// Go's w.Write sniffs the type of "ok\n" (§9.1).
		plainOK(res);
	};

	const readyz: Handler = async (_req, res) => {
		try {
			await o.store.stat(KEY, AbortSignal.timeout(READY_TIMEOUT_MS));
		} catch (err) {
			// A missing object is fine: the service creates it on the first write.
			// Anything else (auth, network, timeout) keeps the pod out of the
			// rotation. The LLM, the settings and the bot are never checked.
			if (!(err instanceof NotFoundError)) {
				o.log.warn("readyz: S3 not reachable", { err: errorMessage(err) });
				httpError(res, 503, "S3 not reachable");
				return;
			}
		}
		plainOK(res);
	};

	return { healthz, readyz };
}

function plainOK(res: ServerResponse): void {
	res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
	res.end("ok\n");
}
