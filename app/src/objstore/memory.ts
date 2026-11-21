// In-process store with the same conditional-write rules as S3. Used by unit
// tests and by chat-eval so they never touch a real bucket.

import { createHash } from "node:crypto";
import { NotFoundError, type ObjectInfo, type ObjectStore, PreconditionError, type StoreInfo } from "./store.ts";

interface StoredObject {
	body: Uint8Array;
	etag: string;
	lastModified: Date;
}

export function createMemoryStore(): ObjectStore {
	const objects = new Map<string, StoredObject>();
	let seq = 0;

	// Every write gets a fresh ETag even for the same body, or a no-op write
	// would look like "nothing changed" to pollers; mix in a sequence number
	// the way memory.go does (two little-endian bytes, then the body).
	function write(key: string, body: Uint8Array): string {
		seq++;
		const hash = createHash("md5");
		hash.update(Uint8Array.of(seq & 0xff, (seq >>> 8) & 0xff));
		hash.update(body);
		const etag = `"${hash.digest("hex")}"`;
		objects.set(key, { body: body.slice(), etag, lastModified: new Date() });
		return etag;
	}

	return {
		async get(key: string) {
			const object = objects.get(key);
			if (object === undefined) throw new NotFoundError(key);
			return { body: object.body.slice(), etag: object.etag };
		},

		async put(key: string, body: Uint8Array, ifMatch: string | null) {
			// Same caller bug as in the S3 store: "" is not an ETag.
			if (ifMatch === "") throw new TypeError("put: ifMatch must be an ETag or null");
			const existing = objects.get(key);
			if (ifMatch === null && existing !== undefined) throw new PreconditionError(key);
			if (ifMatch !== null && (existing === undefined || existing.etag !== ifMatch)) {
				throw new PreconditionError(key);
			}
			return write(key, body);
		},

		async stat(key: string): Promise<ObjectInfo> {
			const object = objects.get(key);
			if (object === undefined) throw new NotFoundError(key);
			return { key, etag: object.etag, size: object.body.length, lastModified: new Date(object.lastModified) };
		},

		async delete(key: string) {
			objects.delete(key);
		},

		async list(prefix: string): Promise<ObjectInfo[]> {
			const out: ObjectInfo[] = [];
			for (const [key, object] of objects) {
				if (key.startsWith(prefix)) {
					out.push({ key, etag: object.etag, size: object.body.length, lastModified: new Date(object.lastModified) });
				}
			}
			// Plain `<` on strings is UTF-16 code-unit order, which matches S3's
			// UTF-8 byte order for our keys (ASCII, no astral characters).
			out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
			return out;
		},

		async putBlob(key: string, body: Uint8Array) {
			return write(key, body);
		},

		async info(): Promise<StoreInfo> {
			return { backend: "memory" };
		},
	};
}
