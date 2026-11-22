// The settings service's own error: a lost ETag race, four attempts over. (The
// 400 of a bad field is ../errors.ts's ValidationError, which every domain shares.)

/** Someone else changed settings.json first, four attempts over (Go's ErrConflict). */
export class ConflictError extends Error {
	constructor() {
		super("settings changed by someone else");
		this.name = "ConflictError";
	}
}
