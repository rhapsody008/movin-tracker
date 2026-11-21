// The request log line. Port of Server.logRequests (internal/server/
// server.go:136-154).
//
// It is a DEBUG line, so with the default LOG_LEVEL=info nothing is written;
// the tests turn it on and read the fields. /healthz and /readyz never get one:
// Docker's HEALTHCHECK and the proxy's readiness probe poll them every few
// seconds and would bury everything else.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Log } from "../log.ts";
import { decodePath, requestPath } from "./http.ts";

/** Wraps the whole request: the line is written after the handler finished, as Go's defer-free version does. */
export function logRequests(
	log: Log,
	next: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		const start = Date.now();
		const path = decodePath(requestPath(req.url).path);
		try {
			await next(req, res);
		} finally {
			if (path !== "/healthz" && path !== "/readyz") {
				// res.statusCode is what writeHead was given, or 200 implicitly: the
				// same thing Go's statusRecorder records.
				log.debug("request", { method: req.method ?? "", path, status: res.statusCode, ms: Date.now() - start });
			}
		}
	};
}
