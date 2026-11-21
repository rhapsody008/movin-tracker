// Store backed by one S3 bucket and key prefix. The same bucket is shared by
// the Go app and this one, so the key layout and the ETags used for
// conditional writes must not change.

import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
	PutObjectCommand,
	paginateListObjectsV2,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { NotFoundError, type ObjectInfo, type ObjectStore, PreconditionError, type StoreInfo } from "./store.ts";

/** An empty endpoint URL means the real AWS, exactly like an unset one (as in Go). */
function endpointUrl(o: { endpointUrl?: string }): string | undefined {
	return o.endpointUrl === undefined || o.endpointUrl === "" ? undefined : o.endpointUrl;
}

/** The S3Client options for a store; path-style addressing only for MinIO/S3-compatible endpoints. */
export function s3ClientConfig(o: { region: string; endpointUrl?: string }): S3ClientConfig {
	const endpoint = endpointUrl(o);
	return endpoint === undefined ? { region: o.region } : { region: o.region, endpoint, forcePathStyle: true };
}

export function createS3Store(o: {
	bucket: string;
	prefix: string;
	region: string;
	endpointUrl?: string;
	listPageSize?: number;
}): ObjectStore {
	// Credentials come from the SDK's default chain (env keys, shared profile,
	// web identity, instance role), so none are passed here.
	const client = new S3Client(s3ClientConfig(o));

	const storeKey = (key: string): string => (o.prefix === "" ? key : `${o.prefix}/${key}`);
	const strip = o.prefix === "" ? "" : `${o.prefix}/`;
	const relative = (key: string): string => (key.startsWith(strip) ? key.slice(strip.length) : key);
	const opts = (signal: AbortSignal | undefined) => ({ abortSignal: signal });

	return {
		async get(key: string, signal?: AbortSignal) {
			const out = await client
				.send(new GetObjectCommand({ Bucket: o.bucket, Key: storeKey(key) }), opts(signal))
				.catch((err: unknown) => {
					throw mapS3Error(err, key);
				});
			const body = out.Body === undefined ? new Uint8Array() : await out.Body.transformToByteArray();
			return { body, etag: requireEtag(out.ETag, key) };
		},

		async put(key: string, body: Uint8Array, ifMatch: string | null, signal?: AbortSignal) {
			// "" would become IfMatch: "", which S3 reads as "no condition at all".
			if (ifMatch === "") throw new TypeError("put: ifMatch must be an ETag or null");
			const condition = ifMatch === null ? { IfNoneMatch: "*" } : { IfMatch: ifMatch };
			const out = await client
				.send(
					new PutObjectCommand({
						Bucket: o.bucket,
						Key: storeKey(key),
						Body: body,
						ContentType: "application/json",
						...condition,
					}),
					opts(signal),
				)
				.catch((err: unknown) => {
					throw mapS3Error(err, key);
				});
			return requireEtag(out.ETag, key);
		},

		async stat(key: string, signal?: AbortSignal): Promise<ObjectInfo> {
			const out = await client
				.send(new HeadObjectCommand({ Bucket: o.bucket, Key: storeKey(key) }), opts(signal))
				.catch((err: unknown) => {
					throw mapS3Error(err, key);
				});
			return {
				key,
				etag: requireEtag(out.ETag, key),
				size: out.ContentLength ?? 0,
				lastModified: out.LastModified ?? new Date(0),
			};
		},

		async delete(key: string, signal?: AbortSignal) {
			// Deleting a missing key succeeds in S3, so nothing special here.
			await client
				.send(new DeleteObjectCommand({ Bucket: o.bucket, Key: storeKey(key) }), opts(signal))
				.catch((err: unknown) => {
					throw mapS3Error(err, key);
				});
		},

		async list(prefix: string, signal?: AbortSignal): Promise<ObjectInfo[]> {
			const out: ObjectInfo[] = [];
			// The paginator sets MaxKeys to `input.MaxKeys ?? config.pageSize`
			// (@smithy/core/dist-cjs/index.js:163). With both undefined it stays
			// undefined, and the query serializer drops undefined values, so the
			// request simply carries no MaxKeys and S3 uses its own page size.
			const pagination = { client, pageSize: o.listPageSize };
			try {
				// The extra argument reaches client.send for every page (the
				// paginator forwards `...rest`), so the abort signal applies to all of them.
				for await (const page of paginateListObjectsV2(
					pagination,
					{ Bucket: o.bucket, Prefix: storeKey(prefix) },
					opts(signal),
				)) {
					for (const object of page.Contents ?? []) {
						const key = relative(object.Key ?? "");
						out.push({
							key,
							etag: requireEtag(object.ETag, key),
							size: object.Size ?? 0,
							lastModified: object.LastModified ?? new Date(0),
						});
					}
				}
			} catch (err) {
				throw mapS3Error(err, prefix);
			}
			return out; // S3 lists in key (UTF-8 byte) order
		},

		async putBlob(key: string, body: Uint8Array, contentType: string, signal?: AbortSignal) {
			const out = await client
				.send(
					new PutObjectCommand({ Bucket: o.bucket, Key: storeKey(key), Body: body, ContentType: contentType }),
					opts(signal),
				)
				.catch((err: unknown) => {
					throw mapS3Error(err, key);
				});
			return requireEtag(out.ETag, key);
		},

		async info(): Promise<StoreInfo> {
			const info: StoreInfo = { backend: "s3", bucket: o.bucket, region: o.region };
			if (o.prefix !== "") info.prefix = o.prefix;
			const endpoint = endpointUrl(o);
			if (endpoint !== undefined) info.endpoint = endpoint;
			try {
				// The default chain resolves credentials; the identity carries
				// `$source` (a set of feature names) naming the provider that won.
				const identity: unknown = await client.config.credentials();
				info.credentialSource = credentialLabel(credentialNames(identity));
			} catch {
				// Never the SDK message: it can contain file paths and profile names.
				info.credentialSource = "none found";
				info.credentialError = "no AWS credentials could be loaded";
			}
			return info;
		},
	};
}

/**
 * Turns the credential identity's `$source` feature names into Go's short
 * labels. The SDK exposes this as `AttributedAwsCredentialIdentity.$source`,
 * a `Partial<Record<FeatureId, string>>`
 * (@aws-sdk/types/dist-types/identity/AwsCredentialIdentity.d.ts:60) filled in
 * by `setCredentialFeature` in the credential providers.
 *
 * No shipped provider sets `CREDENTIALS_IMDS` (it exists only in
 * @aws-sdk/types/dist-types/feature-ids.d.ts:62), so an instance role arrives
 * with no feature name and is reported as "unknown".
 */
export function credentialLabel(names: string[]): string {
	if (names.includes("CREDENTIALS_ENV_VARS")) return "env keys";
	if (
		names.includes("CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN") ||
		names.includes("CREDENTIALS_PROFILE_STS_WEB_ID_TOKEN")
	) {
		return "web identity (IRSA)";
	}
	if (names.some((name) => name.startsWith("CREDENTIALS_SSO") || name.startsWith("CREDENTIALS_PROFILE_SSO")))
		return "SSO";
	if (
		names.some(
			(name) =>
				name.startsWith("CREDENTIALS_PROFILE") || name === "CREDENTIALS_PROCESS" || name === "CREDENTIALS_LOGIN",
		)
	) {
		return "shared profile";
	}
	if (names.includes("CREDENTIALS_HTTP")) return "container role";
	// Anything else: name the first real credential source feature.
	// RESOLVED_ACCOUNT_ID is not one: only the STS paths set it, next to the
	// feature of the provider that actually supplied the credentials.
	return names.find((name) => name.startsWith("CREDENTIALS_")) ?? "unknown";
}

/** Object.keys($source), guarded at runtime so no cast is needed. */
function credentialNames(identity: unknown): string[] {
	if (typeof identity !== "object" || identity === null || !("$source" in identity)) return [];
	const source = identity.$source;
	if (typeof source !== "object" || source === null) return [];
	return Object.keys(source);
}

/**
 * Deliberate departure from Go: s3.go's Put returns "" when a response has no
 * ETag, but Amendment 1 forbids "" as an If-Match (it would disable the
 * guard), so a missing ETag is an error here instead.
 */
function requireEtag(etag: string | undefined, key: string): string {
	if (etag === undefined || etag === "") throw new Error(`S3 returned no ETag for ${key}`);
	return etag;
}

/**
 * Port of mapErr in s3.go: 404 / NoSuchKey / NotFound are "not found",
 * 412 / 409 / PreconditionFailed / ConditionalRequestConflict are "precondition
 * failed", everything else is rethrown unchanged.
 */
export function mapS3Error(err: unknown, key: string): unknown {
	if (typeof err !== "object" || err === null) return err;
	const status = httpStatus(err);
	if (status === 404) return new NotFoundError(key, { cause: err });
	if (status === 412 || status === 409) return new PreconditionError(key, { cause: err });
	const name = errorName(err);
	if (name === "NoSuchKey" || name === "NotFound") return new NotFoundError(key, { cause: err });
	if (name === "PreconditionFailed" || name === "ConditionalRequestConflict") {
		return new PreconditionError(key, { cause: err });
	}
	return err;
}

function httpStatus(err: object): number | undefined {
	if (!("$metadata" in err)) return undefined;
	const metadata = err.$metadata;
	if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) return undefined;
	return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

function errorName(err: object): string | undefined {
	return "name" in err && typeof err.name === "string" ? err.name : undefined;
}
