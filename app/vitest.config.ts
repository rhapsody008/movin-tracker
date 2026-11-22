import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "eval/**/*.test.ts", "test/**/*.test.ts"],
		environment: "node",
		globals: false,
		// Creates the MinIO bucket before any file runs (CI starts from an empty MinIO).
		globalSetup: ["test/s3-setup.ts"],
	},
});
