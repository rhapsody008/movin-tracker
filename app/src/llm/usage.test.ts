// The `llm call` line is Go's (agent.go:181-191), field for field: a log shipper
// that greps kind/model/round/stop and sums in/out keeps working.
import { describe, expect, it } from "vitest";
import { createTestLog } from "../log.ts";
import { logLLMCall, usageOf } from "./usage.ts";

describe("logLLMCall", () => {
	it("writes Go's line at Info, in Go's field order", () => {
		const { log, lines } = createTestLog();
		logLLMCall(log, {
			model: "movin-backend",
			round: 2,
			stop: "tool",
			usage: { in: 120, out: 7, cacheRead: 100, cacheWrite: 0 },
		});
		expect(lines).toHaveLength(1);
		const line = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
		expect(Object.keys(line)).toEqual([
			"time",
			"level",
			"msg",
			"kind",
			"model",
			"round",
			"stop",
			"in",
			"out",
			"cacheRead",
			"cacheWrite",
		]);
		expect(line.level).toBe("INFO");
		expect(line.msg).toBe("llm call");
		expect(line.kind).toBe("openai");
		expect(line.model).toBe("movin-backend");
		expect(line.round).toBe(2);
		expect(line.stop).toBe("tool");
		expect(line.in).toBe(120);
		expect(line.out).toBe(7);
		expect(line.cacheRead).toBe(100);
		expect(line.cacheWrite).toBe(0);
	});

	it("drops the line below Info, as slog does", () => {
		const { log, lines } = createTestLog({ level: "warn" });
		logLLMCall(log, { model: "m", round: 1, stop: "end", usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 } });
		expect(lines).toHaveLength(0);
	});
});

describe("usageOf", () => {
	it("reads pi-ai's four counts, cache write included when reported", () => {
		expect(
			usageOf({
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: "movin",
				model: "m",
				usage: {
					input: 11,
					output: 2,
					cacheRead: 7,
					cacheWrite: 3,
					totalTokens: 13,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 0,
			}),
		).toEqual({ in: 11, out: 2, cacheRead: 7, cacheWrite: 3 });
	});
});
