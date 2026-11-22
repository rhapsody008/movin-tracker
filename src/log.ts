// The app's logger: one JSON object per line, the way Go's slog.JSONHandler
// writes them, so a log shipper sees the same shape as before. Port of
// internal/log.go.

export interface Log {
	debug: (msg: string, fields?: Record<string, unknown>) => void;
	info: (msg: string, fields?: Record<string, unknown>) => void;
	warn: (msg: string, fields?: Record<string, unknown>) => void;
	error: (msg: string, fields?: Record<string, unknown>) => void;
}

export type Level = "debug" | "info" | "warn" | "error";

const ORDER: readonly Level[] = ["debug", "info", "warn", "error"];

export interface LogOptions {
	/** Lines below this level are dropped. */
	level: Level;
	/** Where a line goes, newline included (default: process.stdout). */
	write?: (line: string) => void;
}

export function createLog(o: LogOptions): Log {
	const write = o.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
	const min = ORDER.indexOf(o.level);
	const emit = (level: Level, msg: string, fields?: Record<string, unknown>): void => {
		if (ORDER.indexOf(level) < min) return;
		// Go writes RFC3339 with milliseconds in UTC.
		write(JSON.stringify({ time: new Date().toISOString(), level: level.toUpperCase(), msg, ...fields }));
	};
	return {
		debug: (msg, fields) => emit("debug", msg, fields),
		info: (msg, fields) => emit("info", msg, fields),
		warn: (msg, fields) => emit("warn", msg, fields),
		error: (msg, fields) => emit("error", msg, fields),
	};
}

/**
 * The message of a thrown value: an Error's own message, or String(err) for
 * anything else (a rejected non-Error, which Go's errors always were not).
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** A logger that keeps its lines for assertions in tests. */
export function createTestLog(o: { level?: Level } = {}): { log: Log; lines: string[] } {
	const lines: string[] = [];
	const log = createLog({
		level: o.level ?? "debug",
		write: (line) => {
			lines.push(line);
		},
	});
	return { log, lines };
}
