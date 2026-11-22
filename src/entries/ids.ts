// Identifiers: ULIDs in the same shape as Go's ulid.Make(), and the change IDs
// that make a rerun of a durable task replay instead of writing twice
// (decisions.md, "Change ID carries the args hash").
import { createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The 16-char key part of a replay-safe change ID. */
export const REPLAY_PREFIX_LEN = 16;

const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms: number): string {
	let out = "";
	let n = Math.floor(ms);
	for (let i = 0; i < TIME_LEN; i++) {
		out = ALPHABET[n % 32] + out;
		n = Math.floor(n / 32);
	}
	return out;
}

// 80 random bits as 16 base32 chars. crypto.getRandomValues is Node's
// web-crypto global (node:crypto documents it; 10 bytes is far under the
// 65536-byte cap).
function encodeRandom(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	return base32(bytes).slice(0, RANDOM_LEN);
}

// base32 writes the byte string as Crockford base32, 5 bits per char, most
// significant first; a trailing partial group is padded with zero bits.
function base32(bytes: Uint8Array): string {
	let out = "";
	let acc = 0;
	let bits = 0;
	for (const b of bytes) {
		acc = (acc << 8) | b;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += ALPHABET[(acc >>> bits) & 31];
		}
		acc &= (1 << bits) - 1;
	}
	if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
	return out;
}

/** A 26-char ULID: 48-bit ms timestamp, then 80 random bits. */
export function newUlid(nowMs: number = Date.now()): string {
	return encodeTime(nowMs) + encodeRandom();
}

function sha256(text: string): Uint8Array {
	return createHash("sha256").update(text, "utf8").digest();
}

/**
 * canonicalJson is JSON with object keys sorted at every depth, arrays left in
 * order and undefined members dropped, so the same args always hash the same.
 */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const source = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const key of Object.keys(source).sort()) {
		const member = source[key];
		if (member === undefined) continue;
		parts.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
	}
	return `{${parts.join(",")}}`;
}

/**
 * replayChangeId derives the change ID for the index-th write of one task run:
 * 16 chars of base32(sha256(key|index)) and 10 chars of the args hash. The key
 * is the caller's `epoch|taskId`. A rerun finds the record by the prefix and
 * tells a replay from a collision by the suffix.
 */
export function replayChangeId(key: string, index: number, args: unknown): string {
	const head = base32(sha256(`${key}|${index}`)).slice(0, REPLAY_PREFIX_LEN);
	const tail = base32(sha256(canonicalJson(args))).slice(0, 10);
	return head + tail;
}
