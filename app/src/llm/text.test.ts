// stripSpecialTokens is compared case by case with Go's own answers in
// testdata/striptokens.go.json, which app/golden/t31/main.go writes:
//
//	docker compose --profile tools run --rm --no-deps test sh -c 'cd /src && go run ./app/golden/t31/main.go'
//
// The cases are Go's TestStripSpecialTokens plus the shapes a port gets wrong:
// mid-text tokens, repeated ones, nothing but tokens, a lookalike token and the
// case-sensitive pattern.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripSpecialTokens } from "./text.ts";

interface Golden {
	in: string;
	out: string;
}

const golden = JSON.parse(
	readFileSync(join(import.meta.dirname, "testdata", "striptokens.go.json"), "utf8"),
) as Golden[];

describe("stripSpecialTokens", () => {
	it("matches Go's answer for every case in the golden table", () => {
		expect(golden).toHaveLength(14);
		for (const one of golden) {
			expect(stripSpecialTokens(one.in)).toBe(one.out);
		}
	});

	it("leaves text with no token byte-identical, including its spaces", () => {
		expect(stripSpecialTokens("  no token here  ")).toBe("  no token here  ");
		expect(stripSpecialTokens("a <|not_a_token|> stays")).toBe("a <|not_a_token|> stays");
	});
});
