// The thin layer over S3 that the rest of the app uses: read an object with
// its ETag, and write it only if the ETag still matches. Ported from
// internal/objstore; both Go implementations implement all of these methods,
// so the TypeScript side keeps one interface.

export interface ObjectInfo {
	key: string;
	etag: string;
	size: number;
	lastModified: Date;
}

/** Where a store keeps its objects, for the admin page. Never carries key material. */
export interface StoreInfo {
	backend: "s3" | "memory";
	bucket?: string;
	region?: string;
	prefix?: string;
	endpoint?: string;
	credentialSource?: string;
	credentialError?: string;
}

export interface ObjectStore {
	/** Body and ETag; throws NotFoundError. */
	get(key: string, signal?: AbortSignal): Promise<{ body: Uint8Array; etag: string }>;
	/** ifMatch = ETag: write only if it still matches. ifMatch = null: create only (If-None-Match: *). "" is a caller bug and throws TypeError. Returns the new ETag; throws PreconditionError. */
	put(key: string, body: Uint8Array, ifMatch: string | null, signal?: AbortSignal): Promise<string>;
	/** Throws NotFoundError. */
	stat(key: string, signal?: AbortSignal): Promise<ObjectInfo>;
	/** A missing key is not an error. */
	delete(key: string, signal?: AbortSignal): Promise<void>;
	/** Every key starting with prefix, any depth, sorted by key (byte order); keys relative to the store prefix. */
	list(prefix: string, signal?: AbortSignal): Promise<ObjectInfo[]>;
	/** Unconditional write with the given content type. */
	putBlob(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal): Promise<string>;
	info(signal?: AbortSignal): Promise<StoreInfo>;
}

/** The object does not exist. */
export class NotFoundError extends Error {
	constructor(key: string, options?: ErrorOptions) {
		super(`object not found: ${key}`, options);
		this.name = "NotFoundError";
	}
}

/** A conditional write lost the race (HTTP 412/409), or If-None-Match: * found the object already there. */
export class PreconditionError extends Error {
	constructor(key: string, options?: ErrorOptions) {
		super(`precondition failed: ${key}`, options);
		this.name = "PreconditionError";
	}
}
