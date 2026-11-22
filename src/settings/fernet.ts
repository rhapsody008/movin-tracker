// Fernet (the spec at github.com/fernet/spec, as vendored in
// vendor/github.com/fernet/fernet-go): the format of settings.json's
// apiKeyEnc. Port of fernet.go and key.go, on node:crypto.
//
//	token      = base64url_padded(version || ts || iv || ciphertext || hmac)
//	version    = 0x80
//	ts         = unix seconds, 8 bytes big-endian
//	iv         = 16 random bytes
//	ciphertext = AES-128-CBC(cryptKey, iv, PKCS#7(plaintext))
//	hmac       = HMAC-SHA256(signKey, version || ts || iv || ciphertext)
//
// The 32-byte key is split like key.go: the first 16 bytes sign, the second 16
// encrypt. Unlike a fresh node:Buffer, Go always pads the base64 with `=` (so a
// 16-byte plaintext gets a whole extra block), and Go's verifier decodes the
// base64 leniently, so both details are spelled out below.
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The version byte every token starts with. */
const VERSION = 0x80;
/** version(1) + ts(8) + iv(16): where the ciphertext starts. */
const PAY_OFFSET = 1 + 8 + 16;
/** HMAC-SHA256 output length. */
const HMAC_LEN = 32;
/** AES block size, in bytes. */
const BLOCK = 16;

/** base64.URLEncoding's alphabet; used for the key and the token. */
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** What a decode of SETTINGS_SECRET yielded, or Go's reason for refusing it. */
export type KeyDecode = { key: Buffer; error?: undefined } | { key?: undefined; error: string };

/** Go's DecodeKey: hex (exactly 64 chars), then padded std base64, then padded url-safe base64; 32 bytes. */
export function decodeFernetKey(secret: string): Buffer {
	const got = decodeKeyOrError(secret);
	if (got.key === undefined) throw new Error(got.error);
	return got.key;
}

/**
 * decodeKeyOrError is decodeFernetKey without the throw, so the caller can add
 * the `SETTINGS_SECRET is not a valid Fernet key: ` prefix Go's NewService adds.
 */
export function decodeKeyOrError(secret: string): KeyDecode {
	if (secret === "") return { error: "empty key" };
	// key.go: a 64-character secret is hex, and the base64 paths are never tried.
	let bytes: Buffer | string;
	if (secret.length === 64) {
		bytes = decodeHexLenient(secret);
	} else {
		// key.go tries the std alphabet first but keeps the url-safe error, so a
		// secret like "not-a-key" fails at byte 8 ('-' is only bad for std).
		bytes = decodeBase64Std(secret);
		if (typeof bytes === "string") bytes = decodeBase64URL(secret);
	}
	if (typeof bytes === "string") return { error: bytes };
	if (bytes.length !== 32) return { error: "fernet: key decodes to wrong size" };
	return { key: bytes };
}

// decodeHexLenient is hex.DecodeString with Go's error text: a bad character is
// reported by its code point and its quoted form.
function decodeHexLenient(s: string): Buffer | string {
	const out = Buffer.alloc(s.length / 2);
	for (let i = 0; i < s.length; i += 2) {
		const hi = hexDigit(s.charCodeAt(i));
		const lo = hexDigit(s.charCodeAt(i + 1));
		if (hi < 0 || lo < 0) {
			const bad = hi < 0 ? s.charCodeAt(i) : s.charCodeAt(i + 1);
			return `encoding/hex: invalid byte: U+${bad.toString(16).toUpperCase().padStart(4, "0")} ${quoteByte(bad)}`;
		}
		out[i / 2] = hi * 16 + lo;
	}
	return out;
}

function hexDigit(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	return -1;
}

// Go quotes the byte as a rune: 'z' for printable ASCII.
function quoteByte(code: number): string {
	return `'${String.fromCharCode(code)}'`;
}

// decodeBase64URL emulates base64.URLEncoding.DecodeString's acceptance and its
// `illegal base64 data at input byte N` offsets (checked against Go: 43 chars
// fail at 40, "not-a-key" at 8), ignoring \r and \n the way Go's decoder does.
function decodeBase64URL(s: string): Buffer | string {
	return decodeBase64(s, URL_ALPHABET, "base64url");
}

// decodeBase64Std is base64.StdEncoding.DecodeString; key.go only reaches the
// url-safe path when this one fails, but Go tries this alphabet first.
function decodeBase64Std(s: string): Buffer | string {
	return decodeBase64(s, `${URL_ALPHABET.slice(0, 62)}+/`, "base64");
}

function decodeBase64(s: string, alphabet: string, encoding: "base64" | "base64url"): Buffer | string {
	const clean = s.replaceAll("\r", "").replaceAll("\n", "");
	const pad = clean.indexOf("=");
	const body = pad === -1 ? clean : clean.slice(0, pad);
	const rest = pad === -1 ? "" : clean.slice(pad);
	for (let i = 0; i < body.length; i++) {
		if (!alphabet.includes(body[i] ?? "")) return `illegal base64 data at input byte ${i}`;
	}
	// Padding may only appear at the end, 1 or 2 of them, and only when the data
	// part leaves a partial quantum (Go: "incomplete quantum").
	if (rest !== "") {
		if (!/^={1,2}$/.test(rest)) return `illegal base64 data at input byte ${pad + 1}`;
		if (body.length % 4 === 1 || (body.length + rest.length) % 4 !== 0)
			return `illegal base64 data at input byte ${pad}`;
		return Buffer.from(`${body}${rest}`, encoding);
	}
	if (body.length % 4 !== 0) return `illegal base64 data at input byte ${body.length - (body.length % 4)}`;
	return Buffer.from(body, encoding);
}

/** PKCS#7 unpad, Go's unpad: a malformed pad (or a zero length) is null. */
function unpad(padded: Buffer): Buffer | null {
	if (padded.length === 0) return null;
	const pad = padded[padded.length - 1] ?? 0;
	for (let i = padded.length - pad; i < padded.length; i++) {
		if (i < 0 || padded[i] !== pad) return null;
	}
	return padded.subarray(0, padded.length - pad);
}

export interface EncryptOptions {
	/** The 16-byte IV; fernet's own random one unless a test vector pins it. */
	iv?: Buffer;
	/** When the token is signed; defaults to now. */
	now?: Date;
}

/**
 * fernetEncrypt is EncryptAndSign: a fresh random IV and the current time unless
 * the caller pins them (only the Fernet spec vectors do).
 */
export function fernetEncrypt(key: Buffer, plaintext: string, o: EncryptOptions = {}): string {
	const iv = o.iv ?? randomBytes(BLOCK);
	if (iv.length !== BLOCK) throw new TypeError("fernetEncrypt: the IV must be 16 bytes");
	const ts = Math.floor((o.now ?? new Date()).getTime() / 1000);
	const signed = Buffer.alloc(PAY_OFFSET + plaintext.length);
	signed[0] = VERSION;
	signed.writeBigUInt64BE(BigInt(ts), 1);
	iv.copy(signed, 9);
	const cipher = createCipheriv("aes-128-cbc", key.subarray(16, 32), iv);
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
	const prefix = Buffer.concat([signed.subarray(0, PAY_OFFSET), ciphertext]);
	const mac = createHmac("sha256", key.subarray(0, 16)).update(prefix).digest();
	// base64.URLEncoding keeps the padding; Buffer's "base64url" drops it.
	return Buffer.concat([prefix, mac]).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

/** fernetDecrypt is VerifyAndDecrypt with ttl = 0: no expiry and no clock check. */
export function fernetDecrypt(key: Buffer, token: string): string | null {
	const tok = decodeLenient(token);
	if (tok.length < 1 + 8 || tok[0] !== VERSION) return null;
	const signedEnd = tok.length - HMAC_LEN;
	if (signedEnd <= 0) return null;
	const mac = createHmac("sha256", key.subarray(0, 16)).update(tok.subarray(0, signedEnd)).digest();
	if (!timingSafeEqual(tok.subarray(signedEnd), mac)) return null;
	const pay = tok.subarray(PAY_OFFSET, signedEnd);
	if (pay.length % BLOCK !== 0) return null;
	try {
		const decipher = createDecipheriv("aes-128-cbc", key.subarray(16, 32), tok.subarray(9, PAY_OFFSET));
		// Go un-pads with its own check (unpad), so Node must not do it as well.
		decipher.setAutoPadding(false);
		const plain = unpad(Buffer.concat([decipher.update(pay), decipher.final()]));
		return plain === null ? null : plain.toString("utf8");
	} catch {
		// A wrong key or a corrupt block: Go's CBCDecrypter has no padding check of
		// its own, but unpad rejects the same garbage.
		return null;
	}
}

/**
 * decodeLenient is what `encoding.Decode(b, tok)` does in fernet.go: decode the
 * complete quanta it can and stop at the first bad character (the error is
 * discarded), skipping \r and \n. Nothing after a '=' is read.
 */
function decodeLenient(input: string): Buffer {
	const bytes: number[] = [];
	let quantum: number[] = [];
	const emit = (n: number): void => {
		for (let i = 0; i < n; i++) {
			const [a = 0, b = 0, c = 0] = quantum;
			if (i === 0) bytes.push((a << 2) | (b >> 4));
			else if (i === 1) bytes.push(((b & 0x0f) << 4) | (c >> 2));
			else bytes.push(((c & 0x03) << 6) | (quantum[3] ?? 0));
		}
		quantum = [];
	};
	for (const ch of input) {
		if (ch === "\r" || ch === "\n") continue;
		if (ch === "=") {
			// '=' ends the data; a partial quantum still yields its 1 or 2 bytes.
			if (quantum.length === 2) emit(1);
			else if (quantum.length === 3) emit(2);
			return Buffer.from(bytes);
		}
		const value = URL_ALPHABET.indexOf(ch);
		if (value < 0) return Buffer.from(bytes);
		quantum.push(value);
		if (quantum.length === 4) emit(3);
	}
	return Buffer.from(bytes);
}
