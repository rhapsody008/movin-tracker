// The logger writes slog-style JSON lines: time (RFC3339, ms), level, msg,
// then the fields; below the level, nothing.
import { describe, expect, it, vi } from "vitest";
import { createLog, createTestLog } from "./log.ts";

function fieldOf(line: string, name: string): unknown {
	const parsed: unknown = JSON.parse(line);
	if (typeof parsed !== "object" || parsed === null) throw new Error(`not an object: ${line}`);
	return (parsed as Record<string, unknown>)[name];
}

describe("createLog", () => {
	it("writes one JSON line per call with time, level, msg and fields", () => {
		const { log, lines } = createTestLog();
		log.info("replayed change", { id: "01ARZ3NDEK" });
		log.warn("change id collision", { id: "x", suffix: "tail" });

		expect(lines.length).toBe(2);
		const first = lines[0] ?? "";
		// RFC3339 with milliseconds, in UTC.
		expect(fieldOf(first, "time")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(fieldOf(first, "level")).toBe("INFO");
		expect(fieldOf(first, "msg")).toBe("replayed change");
		expect(fieldOf(first, "id")).toBe("01ARZ3NDEK");

		const second = lines[1] ?? "";
		expect(fieldOf(second, "level")).toBe("WARN");
		expect(fieldOf(second, "suffix")).toBe("tail");
	});

	it("drops lines below the level", () => {
		const { log, lines } = createTestLog({ level: "warn" });
		log.debug("gone");
		log.info("gone");
		log.warn("kept");
		log.error("kept too");
		expect(lines.map((line) => fieldOf(line, "msg"))).toEqual(["kept", "kept too"]);
		expect(lines.map((line) => fieldOf(line, "level"))).toEqual(["WARN", "ERROR"]);
	});

	it("gets a line and its newline from the given write function", () => {
		const written: string[] = [];
		const log = createLog({
			level: "info",
			write: (line) => {
				written.push(line);
			},
		});
		log.info("hello");
		expect(written.length).toBe(1);
		expect(fieldOf(written[0] ?? "", "msg")).toBe("hello");
	});

	it("writes to stdout with a trailing newline by default", () => {
		const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		// Vitest's mockRestore also clears mock.calls, so read them first.
		const calls: unknown[][] = [];
		try {
			createLog({ level: "debug" }).debug("out");
			calls.push(...spy.mock.calls);
		} finally {
			spy.mockRestore();
		}
		expect(calls.length).toBe(1);
		const line = String(calls[0]?.[0]);
		expect(line.endsWith("\n")).toBe(true);
		expect(fieldOf(line.trimEnd(), "level")).toBe("DEBUG");
	});
});
