// One suite per store: the in-memory one always, S3/MinIO when S3_ENDPOINT_URL
// and S3_BUCKET are set (as they are inside `make test`, via Docker Compose).
import { randomUUID } from "node:crypto";
import {
	CreateBucketCommand,
	ListObjectsV2Command,
	type ListObjectsV2CommandOutput,
	PutBucketVersioningCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "./memory.ts";
import { createS3Store, credentialLabel, mapS3Error, s3ClientConfig } from "./s3.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "./store.ts";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (body: Uint8Array): string => new TextDecoder().decode(body);

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";
const s3Prefix = `test-objstore-ts-${Date.now()}-${randomUUID()}`;

// `make test` sets REQUIRE_S3 so a missing MinIO environment can never turn
// into a silently skipped S3 half. Throwing here fails the whole file.
if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the object-store suite would be skipped",
	);
}

interface Variant {
	name: string;
	store: ObjectStore;
	/** Same bucket and prefix, but tiny list pages so List has to follow ContinuationToken. */
	listStore: ObjectStore;
}

const memory = createMemoryStore();
const variants: Variant[] = [{ name: "memory", store: memory, listStore: memory }];

if (endpointUrl !== "" && bucket !== "") {
	await createBucket();
	variants.push({
		name: "s3",
		store: createS3Store({ bucket, prefix: s3Prefix, region, endpointUrl }),
		listStore: createS3Store({ bucket, prefix: s3Prefix, region, endpointUrl, listPageSize: 2 }),
	});
}

// Test-only: the bucket and versioning the Go tests expect. "Already owned"
// and "already exists" are fine (the Go test does the same).
async function createBucket(): Promise<void> {
	const client = new S3Client({ region, endpoint: endpointUrl, forcePathStyle: true });
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (err) {
		const name = typeof err === "object" && err !== null && "name" in err ? err.name : undefined;
		if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
	}
	await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
	client.destroy();
}

for (const { name, store, listStore } of variants) {
	describe(name, () => {
		it("writes only when the ETag still matches", async () => {
			await expect(store.get("x.json")).rejects.toBeInstanceOf(NotFoundError);
			await expect(store.stat("x.json")).rejects.toBeInstanceOf(NotFoundError);

			const first = await store.put("x.json", enc('{"v":1}'), null);
			await expect(store.put("x.json", enc('{"v":1}'), null)).rejects.toBeInstanceOf(PreconditionError);

			const second = await store.put("x.json", enc('{"v":2}'), first);
			await expect(store.put("x.json", enc('{"v":3}'), first)).rejects.toBeInstanceOf(PreconditionError);

			const got = await store.get("x.json");
			expect(dec(got.body)).toBe('{"v":2}');
			expect(got.etag).toBe(second);
			expect((await store.stat("x.json")).etag).toBe(second);
		});

		it("rejects an empty ifMatch without touching the object", async () => {
			// "" would be IfMatch: "" on S3, which writes unconditionally.
			await expect(store.put("fresh.json", enc("x"), "")).rejects.toBeInstanceOf(TypeError);
			await expect(store.stat("fresh.json")).rejects.toBeInstanceOf(NotFoundError);

			const etag = await store.put("guarded.json", enc("keep"), null);
			await expect(store.put("guarded.json", enc("replaced"), "")).rejects.toBeInstanceOf(TypeError);
			const got = await store.get("guarded.json");
			expect(dec(got.body)).toBe("keep");
			expect(got.etag).toBe(etag);
		});

		it("stats, deletes and describes itself", async () => {
			await expect(store.stat("y.json")).rejects.toBeInstanceOf(NotFoundError);
			const before = Date.now() - 2000;
			const etag = await store.put("y.json", enc('{"v":1}'), null);

			const info = await store.stat("y.json");
			expect(info.etag).toBe(etag);
			expect(info.size).toBe(7);
			expect(info.lastModified.getTime()).toBeGreaterThanOrEqual(before);
			expect(info.lastModified.getTime()).toBeLessThanOrEqual(Date.now() + 2000);

			await store.delete("y.json");
			await expect(store.stat("y.json")).rejects.toBeInstanceOf(NotFoundError);
			await expect(store.delete("y.json")).resolves.toBeUndefined();

			const described = await store.info();
			if (name === "s3") {
				expect(described.backend).toBe("s3");
				expect(described.bucket).toBe(bucket);
				expect(described.region).toBe(region);
				expect(described.prefix).toBe(s3Prefix);
				expect(described.endpoint).toBe(endpointUrl);
				expect(described.credentialSource).toBe("env keys");
				expect(described.credentialError).toBeUndefined();
			} else {
				expect(described).toEqual({ backend: "memory" });
			}
		});

		it("lists nested keys past the prefix boundary and putBlob overwrites", async () => {
			// Written out of order, so a store that forgets to sort fails.
			const written = [
				"docs/raw/zz last.pdf",
				"entries.json",
				"docs/rawx/not this.pdf",
				"docs/raw/2.0 Checklists/deep/er/x #03.pdf",
				"docs/raw/top.pdf",
				"docs/raw/1.0 Plans & Drawings/1.1 Layout (A3).pdf",
			];
			const want = [
				"docs/raw/1.0 Plans & Drawings/1.1 Layout (A3).pdf",
				"docs/raw/2.0 Checklists/deep/er/x #03.pdf",
				"docs/raw/top.pdf",
				"docs/raw/zz last.pdf",
			];
			for (const [index, key] of written.entries()) {
				await listStore.putBlob(key, enc(`%PDF-${index}`), "application/pdf");
			}

			const spy = name === "s3" ? vi.spyOn(S3Client.prototype, "send") : undefined;
			try {
				const listed = await listStore.list("docs/raw/");
				expect(listed.map((object) => object.key)).toEqual(want);
				for (const object of listed) {
					expect(object.etag).not.toBe("");
					expect(object.size).toBe(6);
					expect(object.lastModified.getTime()).toBeGreaterThan(0);
				}

				if (spy !== undefined) {
					// Exactly four keys match, page size is 2: two requests, not one
					// (and nothing else is inside the spy).
					const pages = spy.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command);
					expect(pages.length).toBe(2);
				}
			} finally {
				spy?.mockRestore();
			}
			expect(await listStore.list("docs/none/")).toEqual([]);

			// Unconditional overwrite (a guarded put would refuse it).
			await expect(store.put(want[2] ?? "", enc("x"), null)).rejects.toBeInstanceOf(PreconditionError);
			await listStore.putBlob(want[2] ?? "", enc("new body"), "application/pdf");
			expect(dec((await store.get(want[2] ?? "")).body)).toBe("new body");
		});

		it("lets exactly one of two concurrent conditional puts win", async () => {
			const base = await store.put("race.json", enc("base"), null);
			const [first, second] = await Promise.allSettled([
				store.put("race.json", enc("one"), base),
				store.put("race.json", enc("two"), base),
			]);
			const winner = first.status === "fulfilled" ? first : second;

			expect(winner.status).toBe("fulfilled");
			expect(first.status).not.toBe(second.status);
			const loser = first.status === "rejected" ? first : second;
			if (loser.status === "rejected") expect(loser.reason).toBeInstanceOf(PreconditionError);

			const stored = await store.get("race.json");
			expect(dec(stored.body)).toBe(first.status === "fulfilled" ? "one" : "two");
			if (winner.status === "fulfilled") expect(stored.etag).toBe(winner.value);
		});

		if (name === "s3") {
			it("rejects an already-aborted get with the SDK abort error", async () => {
				const failure: unknown = await store.get("never.json", AbortSignal.abort()).then(
					() => undefined,
					(err: unknown) => err,
				);
				expect(failure).not.toBeInstanceOf(NotFoundError);
				expect(failure).toMatchObject({ name: "AbortError" });
			});

			it("refuses a successful response that carries no ETag", async () => {
				const spy = vi.spyOn(S3Client.prototype, "send");
				try {
					// A 200 without an ETag: the SDK type allows it, so the store must not.
					spy.mockImplementationOnce(async () => ({ $metadata: {} }));
					const putFailure: unknown = await store.put("no-etag.json", enc("x"), null).then(
						() => undefined,
						(err: unknown) => err,
					);
					expect(putFailure).toBeInstanceOf(Error);
					expect(putFailure).not.toBeInstanceOf(NotFoundError);
					expect(putFailure).not.toBeInstanceOf(PreconditionError);
					if (putFailure instanceof Error) {
						expect(putFailure.message).toBe("S3 returned no ETag for no-etag.json");
					}

					// One list page whose only object has no ETag; the message names the
					// key relative to the store prefix.
					const page: ListObjectsV2CommandOutput = {
						$metadata: {},
						Contents: [{ Key: `${s3Prefix}/no-etag/page.json`, Size: 1 }],
						IsTruncated: false,
					};
					spy.mockImplementationOnce(async () => page);
					const listFailure: unknown = await listStore.list("no-etag/").then(
						() => undefined,
						(err: unknown) => err,
					);
					expect(listFailure).toBeInstanceOf(Error);
					expect(listFailure).not.toBeInstanceOf(NotFoundError);
					expect(listFailure).not.toBeInstanceOf(PreconditionError);
					if (listFailure instanceof Error) {
						expect(listFailure.message).toBe("S3 returned no ETag for no-etag/page.json");
					}
				} finally {
					spy.mockRestore();
				}
			});

			it("reports missing credentials without leaking the SDK message", async () => {
				// Env stubs are process-global: this needs the file's tests to run one
				// after another (vitest's default); under `.concurrent` they would leak.
				vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
				vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
				vi.stubEnv("AWS_SESSION_TOKEN", undefined);
				vi.stubEnv("AWS_PROFILE", undefined);
				vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
				vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", "/nonexistent/aws/credentials");
				vi.stubEnv("AWS_CONFIG_FILE", "/nonexistent/aws/config");
				const prefix = `no-creds-${randomUUID()}`;
				try {
					const bare = createS3Store({ bucket, prefix, region, endpointUrl });
					expect(await bare.info()).toEqual({
						backend: "s3",
						bucket,
						region,
						prefix,
						endpoint: endpointUrl,
						credentialSource: "none found",
						credentialError: "no AWS credentials could be loaded",
					});
				} finally {
					vi.unstubAllEnvs();
				}
			});

			it("treats an empty endpoint URL as unset", async () => {
				const plain = createS3Store({ bucket, prefix: `plain-${randomUUID()}`, region, endpointUrl: "" });
				const info = await plain.info();
				expect("endpoint" in info).toBe(false);
				expect(info.credentialSource).toBe("env keys");
			});
		}
	});
}

it("builds the S3 client config with an endpoint only when there is one", () => {
	expect(s3ClientConfig({ region: "r" })).toEqual({ region: "r" });
	expect(s3ClientConfig({ region: "r", endpointUrl: "" })).toEqual({ region: "r" });
	expect(s3ClientConfig({ region: "r", endpointUrl: "http://minio:9000" })).toEqual({
		region: "r",
		endpoint: "http://minio:9000",
		forcePathStyle: true,
	});
});

it("copies bodies and dates in and out of the memory store", async () => {
	const store = createMemoryStore();
	const body = enc("first");
	await store.put("copy.json", body, null);
	body.fill(0x58); // mutate the caller's array after the write

	const first = await store.get("copy.json");
	expect(dec(first.body)).toBe("first");
	first.body.fill(0x59); // mutate the returned array
	expect(dec((await store.get("copy.json")).body)).toBe("first");

	const stat = await store.stat("copy.json");
	stat.lastModified.setTime(0);
	expect((await store.stat("copy.json")).lastModified.getTime()).not.toBe(0);

	const [listed] = await store.list("copy.json");
	if (listed === undefined) throw new Error("list returned no entry for the key");
	listed.lastModified.setTime(0);
	const [again] = await store.list("copy.json");
	expect(again?.lastModified.getTime()).not.toBe(0);
});

it("labels credential sources like the Go CredentialLabel", () => {
	const table: [string[], string][] = [
		[["CREDENTIALS_ENV_VARS"], "env keys"],
		[
			["RESOLVED_ACCOUNT_ID", "CREDENTIALS_STS_ASSUME_ROLE_WEB_ID", "CREDENTIALS_ENV_VARS_STS_WEB_ID_TOKEN"],
			"web identity (IRSA)",
		],
		[["CREDENTIALS_PROFILE_STS_WEB_ID_TOKEN"], "web identity (IRSA)"],
		[["CREDENTIALS_PROFILE"], "shared profile"],
		[["CREDENTIALS_PROFILE_SSO"], "SSO"],
		[["CREDENTIALS_SSO"], "SSO"],
		[["CREDENTIALS_HTTP"], "container role"],
		[[], "unknown"],
		[["RESOLVED_ACCOUNT_ID"], "unknown"],
		[["RESOLVED_ACCOUNT_ID", "CREDENTIALS_STS_ASSUME_ROLE"], "CREDENTIALS_STS_ASSUME_ROLE"],
	];
	for (const [names, want] of table) {
		expect(credentialLabel(names)).toBe(want);
	}
});

it("maps SDK errors to store errors and keeps the cause", () => {
	type StoreError = typeof NotFoundError | typeof PreconditionError;

	// Status alone, whatever the name says (the Go mapper checks the code first).
	const byStatus: [number, StoreError][] = [
		[404, NotFoundError],
		[412, PreconditionError],
		[409, PreconditionError],
	];
	for (const [status, want] of byStatus) {
		const raw = sdkError("UnknownError", status);
		const mapped = mappedError(raw, "k.json");
		expect(mapped).toBeInstanceOf(want);
		expect(mapped.cause).toBe(raw);
	}

	// Name alone, with no $metadata at all.
	const byName: [string, StoreError][] = [
		["NoSuchKey", NotFoundError],
		["NotFound", NotFoundError],
		["PreconditionFailed", PreconditionError],
		["ConditionalRequestConflict", PreconditionError],
	];
	for (const [errorName, want] of byName) {
		const raw = bareError(errorName);
		const mapped = mappedError(raw, "k.json");
		expect(mapped).toBeInstanceOf(want);
		expect(mapped.cause).toBe(raw);
	}

	const missing = mappedError(sdkError("UnknownError", 404), "a.json");
	expect(missing.message).toBe("object not found: a.json");
	const stale = mappedError(sdkError("UnknownError", 412), "b.json");
	expect(stale.message).toBe("precondition failed: b.json");

	const other = sdkError("InternalError", 500);
	expect(mapS3Error(other, "e.json")).toBe(other);
});

/** An object shaped like a deserialized SDK error: a name and $metadata.httpStatusCode. */
function sdkError(name: string, status: number): Error & { $metadata: { httpStatusCode: number } } {
	return Object.assign(new Error("sdk failure"), { name, $metadata: { httpStatusCode: status } });
}

/** Name only, no $metadata — as when the SDK fails before a response arrives. */
function bareError(name: string): Error {
	return Object.assign(new Error("sdk failure"), { name });
}

function mappedError(err: unknown, key: string): Error {
	const mapped = mapS3Error(err, key);
	if (!(mapped instanceof Error)) throw new Error("mapper returned the original error instead of a store error");
	return mapped;
}
