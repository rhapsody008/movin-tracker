// The one way a pi-ai failure becomes text. Port of Go's error surface for a
// model call (internal/llm/openai.go:69-100): a non-2xx answer reads
// `endpoint returned <status>: <message>`, anything else keeps its own text,
// and every error that leaves src/llm passes through the key scrub.
//
// pi-ai reports a failed request as an AssistantMessage with
// `stopReason:"error"` and `errorMessage`, or throws; the HTTP status is not a
// field of the message, so it is recovered from the text pi-ai composes:
// `<status>: <json body>` for a JSON answer, `<status> <body>` for a text one
// (utils/error-body.js formatProviderError). Go read the body's `error.message`;
// pi-ai has already unwrapped it to the object it stringifies, so the same
// `message` is read back out of the JSON.
//
// decisions.md · T3.1 lists the texts this produces against Go's for 401, 429,
// 500, 503 and a dropped connection.

import { errorMessage } from "../log.ts";
import { ApiError, cutErrorText, scrubKey } from "./models.ts";

/** Go's `endpoint returned <status>: <msg>`, or pi-ai's own text when no status is in it. */
export function llmError(failure: unknown, apiKey: string): Error {
	const raw = failureText(failure);
	const status = statusOf(raw);
	const err = status === null ? new Error(raw) : new ApiError(status.status, cutErrorText(status.message));
	return scrubKey(err, apiKey);
}

/**
 * failureText is what pi-ai said: an AssistantMessage's `errorMessage`, or the
 * message of whatever was thrown. A message without one has no text at all.
 */
function failureText(failure: unknown): string {
	if (typeof failure === "object" && failure !== null && "stopReason" in failure) {
		const message = (failure as { errorMessage?: unknown }).errorMessage;
		return typeof message === "string" ? message : "";
	}
	return errorMessage(failure);
}

/** `401: {"message":"…"}` and `500 plain failure` both start with the status. */
const STATUS_PREFIX = /^(\d{3})(?::[ \t]*|[ \t]+)([\s\S]*)$/;

/** statusOf splits pi-ai's text into Go's two halves, or null when it has no status. */
function statusOf(raw: string): { status: number; message: string } | null {
	const match = STATUS_PREFIX.exec(raw);
	if (match === null) return null;
	const status = Number(match[1]);
	if (!Number.isFinite(status)) return null;
	return { status, message: jsonMessage(match[2] ?? "") };
}

/** jsonMessage is Go's preference for `{"error":{"message":…}}` over the raw body. */
function jsonMessage(text: string): string {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return text;
	}
	if (typeof value !== "object" || value === null) return text;
	const message = (value as { message?: unknown }).message;
	return typeof message === "string" ? message : text;
}
