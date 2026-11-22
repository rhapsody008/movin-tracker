// No provider SDK in the app's own module graph (plan.md:105, "no Anthropic code
// path in the build"). pi-ai ships adapters for Anthropic, OpenAI, Google and
// Bedrock, and the app must not load any of them: a child process records every
// module its loader resolves while importing src/main.ts, and the test reads the
// list back.
//
// Open the openai package only when a request is actually made (the lazy API in
// src/llm/provider.ts), and never Anthropic, Google or Bedrock at all.
import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

/** The app's root: the child runs there, so it resolves the same node_modules. */
const root = join(import.meta.dirname, "..", "..");

/** The provider SDKs pi-ai can load, by the path each would resolve to. */
const PROVIDER_SDKS = [
	/node_modules\/@anthropic-ai\//,
	/node_modules\/openai\//,
	/node_modules\/@google\/genai\//,
	/node_modules\/@aws-sdk\/client-bedrock/,
	/node_modules\/@mistralai\//,
];

/** The child script: record the hook, import the app, print what was loaded. */
const SCRIPT = `
const trace = await import(${JSON.stringify(join(import.meta.dirname, "moduletrace.ts"))});
trace.start();
await import(${JSON.stringify(join(root, "src", "main.ts"))});
console.log(JSON.stringify(trace.loaded()));
`;

describe("the app's module graph", () => {
	it("loads no provider SDK", async () => {
		const { stdout } = await run(process.execPath, ["--input-type=module", "--eval", SCRIPT], {
			cwd: root,
			maxBuffer: 8 << 20,
		});
		const urls = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as string[];
		// The graph really is the app's: main.ts and pi-ai's own modules are in it.
		expect(urls.some((u) => u.endsWith("/src/main.ts"))).toBe(true);
		expect(urls.some((u) => u.includes("/@earendil-works/pi-ai/"))).toBe(true);
		expect(urls.filter((u) => PROVIDER_SDKS.some((re) => re.test(u)))).toEqual([]);
	});
});
