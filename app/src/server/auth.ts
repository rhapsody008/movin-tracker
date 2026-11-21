// The sign-in check. Port of Server.auth (internal/server/server.go:117-134).
//
// The app trusts one header, set by the oauth2-proxy sidecar in front of it: the
// pod listens on localhost only (server-spec §2.1). There is no session, no CSRF
// token and no second check anywhere; the header, the ALLOWED_EMAILS list and
// DEV_EMAIL are the whole model.

import type { IncomingMessage, ServerResponse } from "node:http";
import { goTrimSpace } from "../gostr.ts";
import type { Log } from "../log.ts";
import { decodePath, header, httpError, requestPath } from "./http.ts";

export interface AuthOptions {
	/** AUTH_HEADER: the header the proxy sets. Its name is matched case-insensitively. */
	authHeader: string;
	/** ALLOWED_EMAILS, already lowercased and trimmed; empty allows every signed-in user. */
	allowedEmails: readonly string[];
	/** DEV_EMAIL: an empty header signs in as this; "" means nobody. */
	devEmail: string;
	log: Log;
}

/** The signed-in email, or null when this function has already answered 401/403. */
export type Authenticate = (req: IncomingMessage, res: ServerResponse) => string | null;

export function createAuth(o: AuthOptions): Authenticate {
	const name = o.authHeader.toLowerCase();
	return (req, res) => {
		// Go lowercases and trims the raw header, and falls back to the dev email
		// only when it is empty.
		let email = goTrimSpace(header(req, name)).toLowerCase();
		if (email === "") email = o.devEmail;
		if (email === "") {
			httpError(res, 401, "Not signed in.");
			return null;
		}
		if (o.allowedEmails.length > 0 && !o.allowedEmails.includes(email)) {
			o.log.warn("rejected user not on ALLOWED_EMAILS", { email, path: decodePath(requestPath(req.url).path) });
			httpError(res, 403, `This page is private. ${email} is not on the list.`);
			return null;
		}
		return email;
	};
}
