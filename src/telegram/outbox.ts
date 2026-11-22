// The channel the adapter's delivery task sends through (T4.3b's `Outbox`):
// one part is one `sendMessage` (bot.go:596-613), and a failure is mapped onto
// the retry the task should make — `retry_after` for a 429, permanent for any
// other 4xx, transient for everything else (T4 plan change, spec §1.5).
//
// A failed send is also the bot's `lastError`, with Go's line and Go's text:
// `telegram sendMessage failed`, and the scrubbed error as the status shows it
// (bot.go:605-608). The token is in the client's URL, never in a message
// (T4.1: every error it throws is scrubbed), so nothing here can leak it.

import { type Outbox, OutboxError, type OutboxJson } from "../durable/adapter.ts";
import { errorMessage, type Log } from "../log.ts";
import type { BotState } from "./bot.ts";
import { type Client, type SendMessage, TelegramApiError } from "./client.ts";

export interface OutboxOptions {
	client: Client;
	log: Log;
	/** Go's Status: a failed send sets its `lastError`, as Go's setErr did. */
	state: BotState;
	now?: () => Date;
}

/**
 * replyPart is one message of a reply plan as the ledger carries it: the
 * adapter's `OutboxJson` is the Bot API's own JSON, and `SendMessage` is that
 * JSON under its field names, so the part is the message itself.
 */
export function replyPart(message: SendMessage): OutboxJson {
	return message as unknown as OutboxJson;
}

export function createOutbox(o: OutboxOptions): Outbox {
	const now = o.now ?? ((): Date => new Date());
	return {
		async send(_address, part, signal) {
			const message = part as unknown as SendMessage;
			try {
				await o.client.sendMessage(message, signal);
			} catch (err) {
				const text = errorMessage(err);
				o.state.lastError = text;
				o.state.lastErrorAt = now();
				o.log.warn("telegram sendMessage failed", { chatId: message.chat_id, err: text });
				throw failureOf(err);
			}
		},
	};
}

/**
 * failureOf is how a send's error steers the delivery task (adapter.ts's
 * `sendFailure`): a 429 says how long to wait, any other 4xx is hopeless, and
 * a 5xx, a transport failure or a timeout is worth another attempt.
 */
export function failureOf(err: unknown): OutboxError {
	const failure = new OutboxError(errorMessage(err));
	if (!(err instanceof TelegramApiError)) return failure;
	if (err.code === 429) {
		failure.retryAfterMs = err.retryAfter * 1_000;
		return failure;
	}
	if (err.code >= 400 && err.code < 500) failure.permanent = true;
	return failure;
}
