// The one validation error in the app, shared by every domain: entries (the
// model and the search), settings (llm, telegram, check-in) and the schedules.
// The HTTP layer maps it to 400, which is why it cannot live in one domain.

/** A field rule violation; the API maps it to 400. */
export class ValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ValidationError";
	}
}
