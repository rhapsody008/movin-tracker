// Vitest global setup: creates the MinIO test bucket, versioned, once before any
// test file runs. Several files (the crash tests, startguard, main) use the
// bucket without creating it; locally an earlier file had always made it, but a
// fresh MinIO (CI) has none and those files failed with NoSuchBucket. Without
// S3_ENDPOINT_URL and S3_BUCKET (the memory-only runs) it does nothing, and it
// never runs against AWS: an endpoint URL is required.
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";

export default async function setup(): Promise<void> {
	const endpoint = process.env.S3_ENDPOINT_URL ?? "";
	const bucket = process.env.S3_BUCKET ?? "";
	if (endpoint === "" || bucket === "") return;
	const client = new S3Client({ region: process.env.AWS_REGION ?? "ap-southeast-1", endpoint, forcePathStyle: true });
	try {
		try {
			await client.send(new CreateBucketCommand({ Bucket: bucket }));
		} catch (err) {
			const name = typeof err === "object" && err !== null && "name" in err ? err.name : undefined;
			if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
		}
		await client.send(
			new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }),
		);
	} finally {
		client.destroy();
	}
}
