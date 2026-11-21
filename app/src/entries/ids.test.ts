// ULID shape and the replay-safe change ID (decisions.md, "Change ID carries
// the args hash").
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, newUlid, REPLAY_PREFIX_LEN, replayChangeId } from "./ids.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function decodeTime(ulid: string): number {
	let ms = 0;
	for (const char of ulid.slice(0, 10)) {
		const digit = ALPHABET.indexOf(char);
		if (digit < 0) throw new Error(`not a base32 char: ${char}`);
		ms = ms * 32 + digit;
	}
	return ms;
}

describe("newUlid", () => {
	it("is 26 Crockford base32 chars", () => {
		for (let i = 0; i < 50; i++) {
			const id = newUlid();
			expect(id.length).toBe(26);
			expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		}
	});

	it("decodes back to the timestamp it was made with", () => {
		for (const ms of [0, 1, 1_700_000_000_000, Date.UTC(2026, 10, 12, 23, 30, 0)]) {
			expect(decodeTime(newUlid(ms))).toBe(ms);
		}
	});

	it("sorts by time when the prefix is read as text", () => {
		const early = newUlid(1_700_000_000_000);
		const late = newUlid(1_700_000_000_001);
		expect(early.slice(0, 10) < late.slice(0, 10)).toBe(true);
		expect([late, early].sort()).toEqual([early, late]);
	});

	it("does not repeat itself", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 200; i++) ids.add(newUlid());
		expect(ids.size).toBe(200);
	});
});

describe("canonicalJson", () => {
	it("sorts keys at every depth and keeps array order", () => {
		expect(canonicalJson({ b: 1, a: { d: [3, 1], c: 2 } })).toBe('{"a":{"c":2,"d":[3,1]},"b":1}');
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
	});

	it("drops undefined members and keeps null", () => {
		expect(canonicalJson({ a: undefined, b: null, c: "x" })).toBe('{"b":null,"c":"x"}');
		expect(canonicalJson([undefined])).toBe("[null]");
	});

	it("gives equal text for objects written in a different key order", () => {
		expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
	});
});

describe("replayChangeId", () => {
	const args = { title: "Carpentry", cost: { estimate: 18000 } };

	it("is 26 chars: 16 of the key hash and 10 of the args hash", () => {
		const id = replayChangeId("epoch1|task7", 0, args);
		expect(id.length).toBe(26);
		expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(REPLAY_PREFIX_LEN).toBe(16);
	});

	it("is stable for the same key, index and args, whatever the key order", () => {
		expect(replayChangeId("epoch1|task7", 0, args)).toBe(
			replayChangeId("epoch1|task7", 0, { cost: { estimate: 18000 }, title: "Carpentry" }),
		);
	});

	it("changes with the index, and shares the prefix", () => {
		const first = replayChangeId("epoch1|task7", 0, args);
		const second = replayChangeId("epoch1|task7", 1, args);
		expect(first.slice(0, 16)).not.toBe(second.slice(0, 16));
		expect(first.slice(16)).toBe(second.slice(16));
	});

	it("changes the whole id when the args change, prefix the same", () => {
		const one = replayChangeId("epoch1|task7", 0, args);
		const other = replayChangeId("epoch1|task7", 0, { title: "Carpentry", cost: { estimate: 18001 } });
		expect(other.slice(0, 16)).toBe(one.slice(0, 16));
		expect(other.slice(16)).not.toBe(one.slice(16));
	});

	it("changes the prefix when the key changes", () => {
		const a = replayChangeId("epoch1|task7", 0, args);
		const b = replayChangeId("epoch1|task8", 0, args);
		expect(a.slice(0, 16)).not.toBe(b.slice(0, 16));
	});

	it("matches vectors computed outside this module", () => {
		// Known vectors from a standalone run with node:crypto and a hand-written
		// encoder that reads the digest bit by bit (not ids.ts's base32), so a
		// bug here cannot agree with a bug there:
		//   sha256("epoch1|task7|0") = 84b24ff6…e5be, first 80 bits = GJS4ZXPS7THT0KQV
		//   sha256(canonicalJson(args)) = 9235d42a…4c21, first 50 bits = J8TX8AK4GV
		//   id(index 0) = GJS4ZXPS7THT0KQVJ8TX8AK4GV
		//   id(index 1) = 1ZEZDZXKXGE577MHJ8TX8AK4GV (same suffix, new prefix)
		const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
		expect(sha("epoch1|task7|0")).toBe("84b24ff6d93ea3a04efb2e39d4d9188b14173840ae8ce7913ae026edc407e5be");
		expect(sha("epoch1|task7|1")).toBe("0fddf6ffb3ec1c539e914c1d1675f624598e0a2ea7b2fc256e9647b316b95b42");
		expect(sha(canonicalJson(args))).toBe("9235d42a6486d59a867ad46f493b4aeaa6f1f735ec80891138f842b8b38e4c21");
		expect(replayChangeId("epoch1|task7", 0, args)).toBe("GJS4ZXPS7THT0KQVJ8TX8AK4GV");
		expect(replayChangeId("epoch1|task7", 1, args)).toBe("1ZEZDZXKXGE577MHJ8TX8AK4GV");
	});
});
