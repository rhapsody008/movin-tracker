// The journal inside entries.json: why each change happened, and how to undo
// it. Port of internal/entries/journal.go. The records carry a full copy of the
// entry before and after, so an undo needs nothing else.
import { ChangeNotFoundError, UndoStaleError } from "./errors.ts";
import { type Change, cloneEntry, type Doc, type Entry, encodeEntry } from "./model.ts";

/** Older changes drop off the end of the journal and can no longer be undone. */
export const MAX_CHANGES = 200;

/** Who wrote a change and through which channel. */
export interface Actor {
	by: string;
	channel: string;
}

/**
 * record appends one journal record to doc and returns it. The entries are
 * cloned so a record never shares objects with the live document; the caller
 * supplies at (its clock's stamp) and id (a ULID, or a replay-safe id).
 */
export function record(
	doc: Doc,
	actor: Actor,
	op: string,
	entryId: string,
	before: Entry | null,
	after: Entry | null,
	id: string,
	at: string,
): Change {
	const change: Change = {
		id,
		at,
		by: actor.by,
		channel: actor.channel,
		op,
		entryId,
		before: before === null ? null : cloneEntry(before),
		after: after === null ? null : cloneEntry(after),
	};
	doc.changes.push(change);
	const over = doc.changes.length - MAX_CHANGES;
	if (over > 0) doc.changes = doc.changes.slice(over);
	return change;
}

/** Byte equality of the encoded entries, as Go's sameEntry has it. */
export function sameEntry(a: Entry | null, b: Entry | null): boolean {
	if (a === null || b === null) return a === null && b === null;
	return JSON.stringify(encodeEntry(a)) === JSON.stringify(encodeEntry(b));
}

export interface UndoResult {
	/** The entry as the original call returned it: the restored one, or the removed one. */
	entries: Entry[];
	changes: Change[];
}

/**
 * undo reverses one change, provided the entry still looks exactly as that
 * change left it. The undo is itself journaled, so it can be undone too.
 */
export function undo(doc: Doc, actor: Actor, changeId: string, at: string, newId: () => string): UndoResult {
	const change = doc.changes.find((c) => c.id === changeId);
	if (change === undefined) throw new ChangeNotFoundError(changeId);
	if (change.before === null && change.after === null) {
		// Never written by the app; a hand-edited file could hold one.
		throw new ChangeNotFoundError(changeId, true);
	}
	const index = doc.entries.findIndex((e) => e.id === change.entryId);
	const cur: Entry | null = index < 0 ? null : (doc.entries[index] ?? null);
	if (!sameEntry(cur, change.after)) throw new UndoStaleError();

	// What goes back: nothing for undo of a create, before itself for undo of a
	// delete, before restamped for undo of an update.
	let restored: Entry | null = null;
	if (change.before === null) {
		doc.entries = doc.entries.filter((_, i) => i !== index);
	} else if (index < 0) {
		restored = cloneEntry(change.before);
		doc.entries.push(restored);
	} else {
		restored = { ...cloneEntry(change.before), updated: at, by: actor.by, channel: actor.channel };
		doc.entries[index] = restored;
	}
	const entries = restored !== null ? [restored] : cur !== null ? [cur] : [];
	const journaled = record(doc, actor, "undo", change.entryId, cur, restored, newId(), at);
	return { entries, changes: [journaled] };
}

/** The newest n records, newest first, optionally only one author's. */
export function recent(doc: Doc, n: number, by: string): Change[] {
	const out: Change[] = [];
	for (let i = doc.changes.length - 1; i >= 0 && out.length < n; i--) {
		const change = doc.changes[i];
		if (change === undefined) continue;
		if (by !== "" && change.by !== by) continue;
		out.push(cloneChange(change));
	}
	return out;
}

/** A copy of a journal record, so callers can never touch the cache. */
export function cloneChange(c: Change): Change {
	return {
		...c,
		before: c.before === null ? null : cloneEntry(c.before),
		after: c.after === null ? null : cloneEntry(c.after),
	};
}
