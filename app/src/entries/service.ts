// The entries service: the one place that reads and writes entries.json. Port of
// internal/entries/service.go.
//
// Reads come from an in-memory copy; writes clone that copy, apply the change,
// and PUT it back with If-Match, retrying at most MAX_RETRIES times when
// another writer got there first. The cached document is deep-frozen, so a
// caller that tries to change it throws instead of quietly corrupting the cache
// and the journal (Go's aliasing bug, spec §10 trap 10).
//
// Every write can carry a replay key: a durable task that runs twice must find
// its own earlier record instead of writing again (decisions.md, "Change ID
// carries the args hash").

import { ValidationError } from "../errors.ts";
import { goMarshal } from "../gojson.ts";
import { goStamp } from "../gostr.ts";
import { errorMessage, type Log } from "../log.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { ConflictError, EntryNotFoundError } from "./errors.ts";
import { newUlid, REPLAY_PREFIX_LEN, replayChangeId } from "./ids.ts";
import { type Actor, cloneChange, recent as recentChanges, record, undo } from "./journal.ts";
import {
	applyMetaPatch,
	applyPatch,
	type Change,
	cloneDoc,
	cloneEntry,
	type Doc,
	decodeDoc,
	docView,
	type Entry,
	emptyDoc,
	encodeDoc,
	type MetaPatch,
	newEntry,
	type Patch,
	settleCompleted,
} from "./model.ts";

/** The one object the service owns. */
export const KEY = "entries.json";

/** How many times a write is retried after losing an ETag race before the caller gets ConflictError. */
export const MAX_RETRIES = 3;

/** The document as of one ETag. The doc is frozen: hand out copies if you need to change one. */
export interface Snapshot {
	doc: Doc;
	etag: string;
}

/** What a journaled write returns: the entries it touched, its journal records, the new snapshot. */
export interface Result {
	entries: Entry[];
	changes: Change[];
	snapshot: Snapshot;
}

/** A durable task's identity for one run, so a rerun can recognise its own writes. */
export interface Replay {
	/** `epoch|taskId`, built by the caller. */
	key: string;
	/** The tool args; hashed into the change ID. */
	args: unknown;
}

const encoder = new TextEncoder();

// A promise-based mutex with a tryLock, like Go's sync.Mutex.TryLock: one writer
// at a time in this process, and Refresh gives up instead of queueing.
interface Mutex {
	lock: () => Promise<() => void>;
	tryLock: () => (() => void) | null;
}

function createMutex(): Mutex {
	let held = false;
	const waiters: (() => void)[] = [];
	const handOver = (): void => {
		const next = waiters.shift();
		if (next === undefined) held = false;
		else next();
	};
	const makeRelease = (): (() => void) => {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			handOver();
		};
	};
	return {
		lock: () => {
			if (!held) {
				held = true;
				return Promise.resolve(makeRelease());
			}
			return new Promise<() => void>((resolve) => {
				waiters.push(() => resolve(makeRelease()));
			});
		},
		tryLock: () => {
			if (held) return null;
			held = true;
			return makeRelease();
		},
	};
}

// deepFreeze makes the cached document and everything inside it immutable, so
// no caller can reach into a snapshot and change the cache or a journal record.
function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	if (Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const inner of Object.values(value)) deepFreeze(inner);
	return value;
}

/** What the rest of the app uses: reads before writes, in the order the brief lists them. */
export interface EntriesService {
	/** Reads entries.json, creating the empty document on first run. */
	load: () => Promise<Snapshot>;
	/** The cached document; loads it on first use. */
	current: () => Promise<Snapshot>;
	/** Re-reads only if the stored ETag moved; skips while a write runs. */
	refresh: () => Promise<void>;
	/** Refreshes every everyMs until the returned function is called. Errors are logged, never thrown. */
	startPolling: (everyMs: number) => () => void;
	/** Called with the new snapshot whenever the ETag changes. */
	subscribe: (listener: (s: Snapshot) => void) => () => void;
	create: (actor: Actor, patches: readonly Patch[], replay?: Replay) => Promise<Result>;
	update: (actor: Actor, id: string, patch: Patch, replay?: Replay) => Promise<Result>;
	updateIf: (actor: Actor, id: string, check: (entry: Entry) => void, patch: Patch, replay?: Replay) => Promise<Result>;
	delete: (actor: Actor, id: string, replay?: Replay) => Promise<Result>;
	undo: (actor: Actor, changeId: string, replay?: Replay) => Promise<Result>;
	/** The newest n journal records, newest first, only one author's when by is set. */
	recent: (n: number, by?: string) => Promise<Change[]>;
	setMeta: (mp: MetaPatch) => Promise<Snapshot>;
	replace: (doc: Doc) => Promise<Snapshot>;
}

export interface ServiceOptions {
	store: ObjectStore;
	log: Log;
	/** The zone whose calendar day is recorded when an entry moves to done. Default UTC. */
	timeZone?: string;
	/** The clock; tests pass their own. */
	now?: () => Date;
}

/** Go's wire snapshot: the document without the journal, plus the ETag. */
export function snapshotJson(snap: Snapshot): string {
	return goMarshal({ doc: docView(snap.doc), etag: snap.etag });
}

interface Loaded {
	doc: Doc;
	etag: string;
}

export function createEntriesService(o: ServiceOptions): EntriesService {
	const { store, log } = o;
	const now = o.now ?? (() => new Date());
	// An unknown zone throws a RangeError here, at construction, not on the first write.
	const dateFormat = new Intl.DateTimeFormat("en-CA", {
		timeZone: o.timeZone ?? "UTC",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const mutex = createMutex();
	const listeners = new Set<(s: Snapshot) => void>();
	let cache: Snapshot | null = null;

	/** Today's date in the app's time zone, as YYYY-MM-DD. */
	function today(): string {
		return dateFormat.format(now());
	}

	/** The write's own stamp: RFC3339 UTC with seconds only, as Go's time.RFC3339 gives. */
	function stamp(): string {
		return goStamp(now());
	}

	async function readDoc(): Promise<Loaded> {
		const got = await store.get(KEY);
		return { doc: decodeDoc(new TextDecoder().decode(got.body)), etag: got.etag };
	}

	// set makes a document the cache and tells the subscribers, if the ETag moved.
	// Listeners run synchronously, as in Go, but one that throws is logged and the
	// others still hear about the change.
	function set(doc: Doc, etag: string): Snapshot {
		const frozen = deepFreeze(doc);
		const changed = cache === null || cache.etag !== etag;
		const snapshot: Snapshot = { doc: frozen, etag };
		cache = snapshot;
		if (changed) {
			for (const listener of listeners) {
				try {
					listener(snapshot);
				} catch (err) {
					log.warn("entries subscriber failed", { err: errorMessage(err) });
				}
			}
		}
		return snapshot;
	}

	async function createEmpty(): Promise<Loaded> {
		const empty = emptyDoc();
		try {
			const etag = await store.put(KEY, encoder.encode(encodeDoc(empty)), null);
			log.info("created empty entries document", { key: KEY });
			return { doc: empty, etag };
		} catch (err) {
			// Another writer created it first; use theirs.
			if (!(err instanceof PreconditionError)) throw err;
			return await readDoc();
		}
	}

	async function load(): Promise<Snapshot> {
		let got: Loaded;
		try {
			got = await readDoc();
		} catch (err) {
			if (!(err instanceof NotFoundError)) throw err;
			got = await createEmpty();
		}
		return set(got.doc, got.etag);
	}

	async function current(): Promise<Snapshot> {
		const hit = cache;
		return hit ?? (await load());
	}

	async function refresh(): Promise<void> {
		const release = mutex.tryLock();
		// A write is running: it leaves the cache current, and a read finishing
		// after it would put an older document back (spec §10 trap 13).
		if (release === null) return;
		try {
			const info = await store.stat(KEY);
			const hit = cache;
			if (hit !== null && hit.etag === info.etag) return;
			const got = await readDoc();
			set(got.doc, got.etag);
		} finally {
			release();
		}
	}

	function startPolling(everyMs: number): () => void {
		const timer = setInterval(() => {
			refresh().catch((err: unknown) => {
				log.warn("entries refresh failed", { err: errorMessage(err) });
			});
		}, everyMs);
		timer.unref();
		return () => {
			clearInterval(timer);
		};
	}

	function subscribe(listener: (s: Snapshot) => void): () => void {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}

	// ---- writes ----

	// Every journaled write is one of these: a function that applies the change to
	// a fresh clone, plus what a replay needs to recognise its own earlier write.
	interface Write {
		apply: (doc: Doc, ids: () => string) => void;
		replay?: Replay | undefined;
		/** How many journal records this write produces (0 for a write that is not journaled). */
		count: number;
		/** Fills the caller's result from the journal when the change was already written. */
		replayed?: ((records: Change[]) => void) | undefined;
	}

	// Change IDs for one attempt: replay-safe when the run has a replay key and
	// nothing collided, else ULIDs. Entry IDs of created entries are always ULIDs.
	function makeIds(replay: Replay | undefined, useReplay: boolean): () => string {
		let index = 0;
		return () => {
			if (replay !== undefined && useReplay) return replayChangeId(replay.key, index++, replay.args);
			return newUlid(now().getTime());
		};
	}

	// The records an earlier run of this task wrote that the journal still holds,
	// in call order. A record can be missing from the front: the journal keeps
	// MAX_CHANGES, so a big batch loses its first records first.
	function replayedRecords(doc: Doc, replay: Replay, count: number): Change[] {
		const out: Change[] = [];
		for (let index = 0; index < count; index++) {
			const id = replayChangeId(replay.key, index, replay.args);
			const found = doc.changes.find((c) => c.id === id);
			if (found !== undefined) out.push(cloneChange(found));
		}
		return out;
	}

	// The entries the original call returned: the new entry for a create and an
	// update, the deleted one for a delete, the removed one for an undo of a create.
	function replayedEntries(records: readonly Change[]): Entry[] {
		const out: Entry[] = [];
		for (const change of records) {
			const e = change.after ?? change.before;
			if (e !== null) out.push(cloneEntry(e));
		}
		return out;
	}

	type ReplayCheck = { kind: "replay"; records: Change[] } | { kind: "replayIds" } | { kind: "collision" };

	// checkReplay looks at the document being written, so it also sees a record
	// another replica wrote, and looks again after a lost ETag race. Every record
	// the call writes is checked, not only the first: the journal's cap can have
	// trimmed index 0 while later records of the same batch are still there, and
	// a rerun must not write the batch a second time.
	function checkReplay(doc: Doc, replay: Replay, count: number): ReplayCheck {
		for (let index = 0; index < count; index++) {
			const id = replayChangeId(replay.key, index, replay.args);
			const prefix = id.slice(0, REPLAY_PREFIX_LEN);
			const hit = doc.changes.find((c) => c.id.startsWith(prefix));
			if (hit === undefined) continue;
			if (hit.id !== id) {
				log.warn("change id collision", {
					id: hit.id,
					want: id.slice(REPLAY_PREFIX_LEN),
					got: hit.id.slice(REPLAY_PREFIX_LEN),
				});
				return { kind: "collision" };
			}
			log.info("replayed change", { id });
			return { kind: "replay", records: replayedRecords(doc, replay, count) };
		}
		return { kind: "replayIds" };
	}

	async function readAndSet(): Promise<Snapshot> {
		const got = await readDoc();
		return set(got.doc, got.etag);
	}

	// mutate is the write path: hold the in-process lock, apply the change to a
	// clone of the cached document, PUT it with If-Match, and on a lost race
	// re-read and apply again up to MAX_RETRIES times (4 PUTs in all, no backoff).
	async function mutate(write: Write): Promise<Snapshot> {
		const release = await mutex.lock();
		try {
			let base = await current();
			for (let attempt = 0; ; attempt++) {
				const doc = cloneDoc(base.doc);
				let useReplay = false;
				if (write.replay !== undefined) {
					const check = checkReplay(doc, write.replay, write.count);
					if (check.kind === "replay") {
						write.replayed?.(check.records);
						return base;
					}
					useReplay = check.kind === "replayIds";
				}
				// The mutation rebuilds its result from scratch: a retry discards
				// whatever the failed attempt had put there.
				write.apply(doc, makeIds(write.replay, useReplay));
				try {
					const tag = await store.put(KEY, encoder.encode(encodeDoc(doc)), base.etag);
					return set(doc, tag);
				} catch (err) {
					if (!(err instanceof PreconditionError)) throw err;
					if (attempt >= MAX_RETRIES) {
						log.warn("write gave up after ETag conflicts", { attempts: attempt + 1 });
						throw new ConflictError();
					}
					log.info("ETag conflict, re-reading entries", { attempt: attempt + 1 });
					base = await readAndSet();
				}
			}
		} finally {
			release();
		}
	}

	// A batch of new entries. Each patch must carry a title; one bad patch rejects
	// the whole batch before anything is written.
	async function create(actor: Actor, patches: readonly Patch[], replay?: Replay): Promise<Result> {
		const out: { entries: Entry[]; changes: Change[] } = { entries: [], changes: [] };
		const snapshot = await mutate({
			replay,
			count: patches.length,
			replayed: (records) => {
				out.entries = replayedEntries(records);
				out.changes = records;
			},
			apply: (doc, ids) => {
				out.entries = [];
				out.changes = [];
				for (const patch of patches) {
					if (!Object.hasOwn(patch, "title")) throw new ValidationError("title is required");
					// Created and updated are the same instant; the ID is always a ULID.
					const at = stamp();
					const e = newEntry("");
					e.id = newUlid(now().getTime());
					e.created = at;
					e.updated = at;
					e.by = actor.by;
					e.channel = actor.channel;
					applyPatch(e, patch);
					settleCompleted(null, e, patch, today());
					doc.entries.push(e);
					out.entries.push(cloneEntry(e));
					out.changes.push(cloneChange(record(doc, actor, "create", e.id, null, e, ids(), at)));
				}
			},
		});
		return { entries: out.entries, changes: out.changes, snapshot };
	}

	/** Changes fields of one entry. */
	async function update(actor: Actor, id: string, patch: Patch, replay?: Replay): Promise<Result> {
		return await updateIf(actor, id, () => undefined, patch, replay);
	}

	/**
	 * updateIf is update with a precondition: check sees the entry as it is in
	 * the document being written (again after a lost race), and an error from it
	 * cancels the write and is returned unchanged.
	 */
	async function updateIf(
		actor: Actor,
		id: string,
		check: (entry: Entry) => void,
		patch: Patch,
		replay?: Replay,
	): Promise<Result> {
		const out: { entries: Entry[]; changes: Change[] } = { entries: [], changes: [] };
		const snapshot = await mutate({
			replay,
			count: 1,
			replayed: (records) => {
				out.entries = replayedEntries(records);
				out.changes = records;
			},
			apply: (doc, ids) => {
				out.entries = [];
				out.changes = [];
				const index = doc.entries.findIndex((e) => e.id === id);
				const found = doc.entries[index];
				if (found === undefined) throw new EntryNotFoundError(id);
				check(cloneEntry(found));
				const before = cloneEntry(found);
				const e = cloneEntry(found);
				applyPatch(e, patch);
				settleCompleted(before, e, patch, today());
				e.updated = stamp();
				e.by = actor.by;
				e.channel = actor.channel;
				doc.entries[index] = e;
				out.entries = [cloneEntry(e)];
				out.changes = [cloneChange(record(doc, actor, "update", id, before, e, ids(), e.updated))];
			},
		});
		return { entries: out.entries, changes: out.changes, snapshot };
	}

	/** Removes an entry; the journal keeps a copy, so it can be undone while the record is there. */
	async function remove(actor: Actor, id: string, replay?: Replay): Promise<Result> {
		const out: { entries: Entry[]; changes: Change[] } = { entries: [], changes: [] };
		const snapshot = await mutate({
			replay,
			count: 1,
			replayed: (records) => {
				out.entries = replayedEntries(records);
				out.changes = records;
			},
			apply: (doc, ids) => {
				out.entries = [];
				out.changes = [];
				const index = doc.entries.findIndex((e) => e.id === id);
				const before = doc.entries[index];
				if (before === undefined) throw new EntryNotFoundError(id);
				doc.entries.splice(index, 1);
				out.entries = [cloneEntry(before)];
				out.changes = [cloneChange(record(doc, actor, "delete", id, before, null, ids(), stamp()))];
			},
		});
		return { entries: out.entries, changes: out.changes, snapshot };
	}

	/** Reverses one change; the undo is journaled too, so it can be undone as well. */
	async function undoChange(actor: Actor, changeId: string, replay?: Replay): Promise<Result> {
		const out: { entries: Entry[]; changes: Change[] } = { entries: [], changes: [] };
		const snapshot = await mutate({
			replay,
			count: 1,
			replayed: (records) => {
				out.entries = replayedEntries(records);
				out.changes = records;
			},
			apply: (doc, ids) => {
				out.entries = [];
				out.changes = [];
				const done = undo(doc, actor, changeId, stamp(), ids);
				out.entries = done.entries.map(cloneEntry);
				out.changes = done.changes.map(cloneChange);
			},
		});
		return { entries: out.entries, changes: out.changes, snapshot };
	}

	async function recent(n: number, by = ""): Promise<Change[]> {
		const snap = await current();
		return recentChanges(snap.doc, n, by);
	}

	/** Changes the key dates of the move. Not journaled. */
	async function setMeta(mp: MetaPatch): Promise<Snapshot> {
		return await mutate({
			count: 0,
			apply: (doc) => {
				applyMetaPatch(doc.meta, mp);
			},
		});
	}

	/** Overwrites the whole document (seed). Still ETag-guarded, and not journaled. */
	async function replace(nd: Doc): Promise<Snapshot> {
		return await mutate({
			count: 0,
			apply: (doc) => {
				const copy = cloneDoc(nd);
				doc.schema = copy.schema;
				doc.meta = copy.meta;
				doc.entries = copy.entries;
				doc.changes = copy.changes;
			},
		});
	}

	return {
		load,
		current,
		refresh,
		startPolling,
		subscribe,
		create,
		update,
		updateIf,
		delete: remove,
		undo: undoChange,
		recent,
		setMeta,
		replace,
	};
}
