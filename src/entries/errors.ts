// The service's errors, with Go's exact messages. The HTTP layer maps them to
// 409 (ConflictError, UndoStaleError), 404 (EntryNotFoundError,
// ChangeNotFoundError) and 400 (ValidationError, still in model.ts).

/** Someone else changed entries.json first, three times over. */
export class ConflictError extends Error {
	constructor() {
		super("someone else just changed the entries");
		this.name = "ConflictError";
	}
}

/** No entry with that id. Go wraps `no entry with that id` and appends the id. */
export class EntryNotFoundError extends Error {
	constructor(id: string) {
		super(`no entry with that id: ${id}`);
		this.name = "EntryNotFoundError";
	}
}

/** The change is not in the journal any more (trimmed, or never written). */
export class ChangeNotFoundError extends Error {
	constructor(id: string, emptyRecord = false) {
		super(`that change is no longer in the history: ${id}${emptyRecord ? " (empty record)" : ""}`);
		this.name = "ChangeNotFoundError";
	}
}

/** The entry changed after the change being undone, so the undo would throw that edit away. */
export class UndoStaleError extends Error {
	constructor() {
		super("that entry has changed since, so undo was refused");
		this.name = "UndoStaleError";
	}
}
