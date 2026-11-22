// The restore guard (T5.3a): the S3 half of "is this database a restored
// snapshot?" (T5-plan §2.4, plan.md:47-49).
//
// Two triggers, one object: `harness/<instance>/epoch.json` holds how many times
// this deployment has started. Every start reads it, decides, and — after SQLite
// has recorded the decision — sets it to the number this database now carries.
// A database restored from a snapshot has the old number, so it is behind the
// object (`"counter"`); a restored database also gets a new HARNESS_RESTORE_ID
// from the runbook, which differs from the id it recorded (`"id"`).
//
// This file imports the object store, gojson, gostr and log only, the leaf
// modules: pi-durable is the adapter's alone, and the decision is a plain value
// the adapter acts on. `imports.test.ts` pins that list.
//
// The counter cannot see a restore that happened with no start in between (a
// scale to 0, a restore, a start reads the same number on both sides — T5-plan
// §3): that is what the explicit id is for, and `velero.md` makes it mandatory.

import { setTimeout as sleep } from "node:timers/promises";
import { goMarshal, Ordered } from "../gojson.ts";
import { goStamp } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "../objstore/store.ts";

/** How the start found the database: a new copy, a restore by id or by counter, or neither. */
export type StartRestore = false | "id" | "counter";

/** What a start has to do, and the state it must record. */
export type StartDecision = {
	/** `false`: nothing was restored. */
	restore: StartRestore;
	/** The number this start carries: `max(SQLite, S3) + 1`. */
	starts: number;
	/** The restore id to record: the environment's, or the old one when the environment has none. */
	restoreId: string;
};

/** The adapter's view of the guard: one decision before `resume()`, one write after the commit. */
export interface StartGuard {
	/** Reads the counter, decides, and remembers the ETag `committed()` must write against. */
	check(db: { starts: number; restoreId: string }): Promise<StartDecision>;
	/** Sets the counter to `starts`, at least its own value; a failure only warns. */
	committed(starts: number): Promise<void>;
}

export interface StartGuardOptions {
	store: ObjectStore;
	/** `dev` or `prod`: each names its own object, so their counters never stand in for each other. */
	instance: string;
	/** HARNESS_RESTORE_ID; "" when the ConfigMap `movin-restore` is not applied. */
	restoreId: string;
	log: Log;
	/** Aborting ends a waiting read, and the start with it: the process may not resume on a guess. */
	signal?: AbortSignal;
	/**
	 * Test seam: the wait between two reads. Production is node's own timer, which
	 * takes the signal; a test that owns time replaces it.
	 */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The first wait after a failed read, and the longest one (T5-plan §2.4: 1 s, doubling, up to 30 s). */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** epochKey is where one instance's counter lives: next to `entries.json`, under the store's prefix. */
export function epochKey(instance: string): string {
	return `harness/${instance}/epoch.json`;
}

/**
 * createStartGuard builds the guard over one instance's counter. It holds the
 * ETag `check()` read, so `committed()` writes conditionally on it: two
 * instances starting at once cannot lose a start.
 */
export function createStartGuard(options: StartGuardOptions): StartGuard {
	const key = epochKey(options.instance);
	/** The ETag of the object `check()` read; null when there was none. */
	let etag: string | null = null;

	return { check, committed };

	/**
	 * check reads the counter (a missing object is 0) and decides. The order is
	 * T5-plan §2.4's: a new database is never a restore, then the id, then the
	 * counter.
	 */
	async function check(db: { starts: number; restoreId: string }): Promise<StartDecision> {
		const stored = await read();
		etag = stored.etag;
		// A new database has known nothing yet, so nothing about it was lost: S3
		// ahead of it is another instance's counter or a deleted volume, not a
		// restore. Without this rule a fresh volume with a shared bucket would run
		// the restore path on every first start.
		const restore: StartRestore =
			db.starts === 0
				? false
				: options.restoreId !== "" && options.restoreId !== db.restoreId
					? "id"
					: db.starts < stored.starts
						? "counter"
						: false;
		return {
			restore,
			// Behind or ahead, both sides end on one number, so a database that was
			// ahead keeps its own count.
			starts: Math.max(db.starts, stored.starts) + 1,
			// The id the runbook applied, or the one already recorded: a start with no
			// id must not forget the last one.
			restoreId: options.restoreId === "" ? db.restoreId : options.restoreId,
		};
	}

	/**
	 * committed sets the counter to what SQLite just recorded. The conditional
	 * write keeps the higher number when another instance started in between;
	 * anything else only warns, because SQLite ahead of S3 heals at the next
	 * start through `max()` (T5-plan §2.4).
	 */
	async function committed(starts: number): Promise<void> {
		try {
			await write(starts, etag);
			return;
		} catch (err) {
			if (!(err instanceof PreconditionError)) {
				warnNotSaved(starts, err);
				return;
			}
		}
		// One plain read, never `read()`: a retry that waits is a resume() that waits,
		// and a start must not sit here through an S3 outage.
		try {
			const current = await get();
			await write(Math.max(current.starts, starts), current.etag);
		} catch (err) {
			warnNotSaved(starts, err);
		}
	}

	/** warnNotSaved is the one line a failed write logs: the start stands. */
	function warnNotSaved(starts: number, err: unknown): void {
		options.log.warn("harness start counter not saved", { key, starts, err: errorMessage(err) });
	}

	/**
	 * read answers the counter, and retries any failure until it does (T5-plan
	 * §2.4, decision 13.15): a start must not resume on a guess about whether the
	 * database was restored, and the listener already answers 503 while the
	 * harness opens. A signal that aborts ends the wait with a throw.
	 */
	async function read(): Promise<{ starts: number; etag: string | null }> {
		let wait = RETRY_BASE_MS;
		for (;;) {
			throwIfAborted();
			try {
				return await get();
			} catch (err) {
				if (err instanceof NotFoundError) return { starts: 0, etag: null };
				// A shutdown that aborted the read is not a read failure: the start ends
				// with the signal, and no line says the counter was unreadable.
				throwIfAborted();
				// The object is the one thing a start cannot guess: a wrong answer drops
				// every pending reply, so a failure is a warning and another try.
				options.log.warn("harness start counter unreadable", {
					key,
					err: errorMessage(err),
					in: wait,
				});
				await pause(wait);
				wait = Math.min(wait * 2, RETRY_MAX_MS);
			}
		}
	}

	/** get is one plain read: the counter, or NotFoundError, or whatever the store raised. */
	async function get(): Promise<{ starts: number; etag: string | null }> {
		const got = await options.store.get(key, options.signal);
		return { starts: decode(got.body), etag: got.etag };
	}

	/** write puts one counter, conditional on the ETag `read()` gave (null: create only). */
	async function write(starts: number, ifMatch: string | null): Promise<string> {
		const body = new TextEncoder().encode(
			goMarshal(
				new Ordered([
					["schema", 1],
					["starts", starts],
					// For a person reading the bucket, not for the decision: the counter is
					// the number, and the id stays in SQLite (T5-plan §14.5).
					["at", goStamp(new Date())],
				]),
			),
		);
		return await options.store.put(key, body, ifMatch, options.signal);
	}

	/**
	 * pause waits `ms` and stops at once when the start is aborted: the stdlib's
	 * timer takes the signal, so a signal that fired before the wait rejects here
	 * instead of sleeping out a shutdown's grace period. Only an abort ends a wait
	 * early, so both paths leave one error.
	 */
	async function pause(ms: number): Promise<void> {
		const signal = options.signal;
		const wait =
			options.sleep === undefined
				? sleep(ms, undefined, signal === undefined ? {} : { signal })
				: options.sleep(ms, signal);
		try {
			await wait;
		} catch {
			throw abortedError();
		}
	}

	/** throwIfAborted is the check before a read: an already-aborted signal never touches S3. */
	function throwIfAborted(): void {
		if (options.signal?.aborted === true) throw abortedError();
	}

	/** abortedError is what a start throws when a shutdown ends its wait for the counter. */
	function abortedError(): Error {
		return new Error("the harness start counter could not be read: aborted", { cause: options.signal?.reason });
	}
}

/**
 * decode is Go's json.Unmarshal of the counter object, and anything that is not
 * a whole count is a read failure like any other: the caller retries it rather
 * than reading a damaged object as 0, which would skip a restore.
 */
function decode(body: Uint8Array): number {
	const text = new TextDecoder().decode(body);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		throw new Error(`${text.slice(0, 80)}: ${errorMessage(err)}`, { cause: err });
	}
	const starts = typeof raw === "object" && raw !== null ? (raw as { starts?: unknown }).starts : undefined;
	if (typeof starts !== "number" || !Number.isInteger(starts) || starts < 0) {
		throw new Error(`starts is ${JSON.stringify(starts)}, not a count`);
	}
	return starts;
}
