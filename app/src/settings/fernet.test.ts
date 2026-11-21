// Fernet against the vendored spec vectors (vendor/github.com/fernet/fernet-go):
// generate.json pins IV and time so the encrypt direction is byte-exact,
// verify.json and invalid.json test the decrypt direction.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFernetKey, decodeKeyOrError, fernetDecrypt, fernetEncrypt } from "./fernet.ts";

interface Vector {
	token: string;
	now: string;
	src: string;
	secret: string;
	iv?: number[];
	ttl_sec?: number;
	desc?: string;
}

function vectors(name: string): Vector[] {
	return JSON.parse(readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8")) as Vector[];
}

function key(secret: string): Buffer {
	return decodeFernetKey(secret);
}

// settings.json's key is decrypted with ttl = 0: no expiry and no clock-skew
// check. Two of invalid.json's vectors are rejected by Go only because of the
// TTL, so with ttl = 0 they verify (to an empty plaintext) — Go prints
// `ttl=0 -> ok=true` for exactly those two (tmp/t14-golden/probe2.go).
const TTL_ONLY = new Set(["far-future TS (unacceptable clock skew)", "expired TTL"]);

function tokenBytes(token: string): Buffer {
	return Buffer.from(token.replaceAll("-", "+").replaceAll("_", "/"), "base64");
}

function toToken(bytes: Buffer): string {
	return bytes.toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

describe("fernetEncrypt matches generate.json", () => {
	for (const v of vectors("generate.json")) {
		it(`produces the vector token for ${JSON.stringify(v.src)}`, () => {
			const iv = Buffer.from(Uint8Array.from(v.iv ?? []));
			const token = fernetEncrypt(key(v.secret), v.src, { iv, now: new Date(v.now) });
			expect(token).toBe(v.token);
			// Go pads the base64: 44 characters per 32 bytes and `=` at the end.
			expect(token.endsWith("=")).toBe(true);
			expect(token.length % 4).toBe(0);
		});
	}
});

describe("fernetDecrypt accepts verify.json", () => {
	for (const v of vectors("verify.json")) {
		it(`decrypts the vector token (ttl_sec ${v.ttl_sec}, ignored)`, () => {
			expect(fernetDecrypt(key(v.secret), v.token)).toBe(v.src);
		});
	}
});

describe("fernetDecrypt refuses every invalid.json vector", () => {
	for (const v of vectors("invalid.json")) {
		if (TTL_ONLY.has(v.desc ?? "")) {
			it(`verifies ${v.desc} because ttl = 0 skips the clock check`, () => {
				expect(fernetDecrypt(key(v.secret), v.token)).toBe("");
			});
			continue;
		}
		it(`returns null for ${v.desc}`, () => {
			expect(fernetDecrypt(key(v.secret), v.token)).toBeNull();
		});
	}

	it("lists the TTL-only vectors in invalid.json, so the set above stays right", () => {
		const names = vectors("invalid.json").map((v) => v.desc ?? "");
		expect(names.filter((n) => n.startsWith("far-future") || n.startsWith("expired"))).toEqual([...TTL_ONLY]);
	});
});

describe("decodeFernetKey", () => {
	const raw = key("cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=");
	const hex = raw.toString("hex");

	it("accepts url-safe base64 with padding", () => {
		expect(key("cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=").equals(raw)).toBe(true);
	});

	it("accepts the 64-character hex form", () => {
		expect(key(hex).equals(raw)).toBe(true);
	});

	it("accepts standard base64 when the url-safe one fails", () => {
		// 0xff x 32 encodes with + and /, which only the std alphabet accepts.
		const bytes = Buffer.alloc(32, 0xff);
		const std = bytes.toString("base64");
		expect(std.includes("+") || std.includes("/")).toBe(true);
		expect(key(std).equals(bytes)).toBe(true);
		expect(key(bytes.toString("hex")).equals(bytes)).toBe(true);
	});

	it("rejects an unpadded secret, as Go's base64 does", () => {
		const got = decodeKeyOrError("cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4");
		expect(got.error).toBe("illegal base64 data at input byte 40");
	});

	it("rejects a bad character with Go's message", () => {
		expect(decodeKeyOrError("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").error).toBe(
			"encoding/hex: invalid byte: U+007A 'z'",
		);
	});

	it("rejects the wrong size and the empty secret", () => {
		expect(decodeKeyOrError("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA").error).toBe(
			"fernet: key decodes to wrong size",
		);
		expect(decodeKeyOrError("").error).toBe("empty key");
		expect(() => decodeFernetKey("not-a-key")).toThrow("illegal base64 data at input byte 8");
	});
});

describe("the token format", () => {
	const k = key("cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=");

	it("stores the timestamp in seconds, big-endian, after the version byte", () => {
		const now = new Date("2026-11-11T09:00:00Z");
		const tok = tokenBytes(fernetEncrypt(k, "hello", { now }));
		expect(tok[0]).toBe(0x80);
		expect(tok.readBigUInt64BE(1)).toBe(BigInt(now.getTime() / 1000));
		expect(tok.length).toBe(1 + 8 + 16 + 16 + 32);
	});

	it("pads a plaintext that is a multiple of 16 with a whole block", () => {
		const token = fernetEncrypt(k, "0123456789abcdef");
		expect(tokenBytes(token).length).toBe(1 + 8 + 16 + 32 + 32);
		expect(fernetDecrypt(k, token)).toBe("0123456789abcdef");
	});

	it("round-trips text with non-ASCII characters", () => {
		const token = fernetEncrypt(k, "sk-ünïcode-key");
		expect(fernetDecrypt(k, token)).toBe("sk-ünïcode-key");
	});

	it("refuses a token whose ciphertext was changed, even with valid padding", () => {
		// 20 bytes of data plus a 12-byte pad: two blocks. Flipping a byte of the
		// first ciphertext block garbles it and flips one byte of the second
		// block's plaintext, which is data, not padding — so only the HMAC (over
		// the whole prefix) can catch it.
		const tok = tokenBytes(fernetEncrypt(k, "0123456789abcdefghij"));
		tok[17] = (tok[17] ?? 0) ^ 0x01;
		expect(fernetDecrypt(k, toToken(tok))).toBeNull();
	});

	it("refuses a token from another key", () => {
		const other = decodeFernetKey("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
		const token = fernetEncrypt(other, "sk-other");
		expect(fernetDecrypt(k, token)).toBeNull();
	});

	it("accepts a token with trailing newlines and ignores everything after a bad character", () => {
		const token = fernetEncrypt(k, "hello");
		expect(fernetDecrypt(k, `${token}\n`)).toBe("hello");
		expect(fernetDecrypt(k, `${token}%%%`)).toBe("hello");
	});
});
