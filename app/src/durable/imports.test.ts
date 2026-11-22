// "Only src/durable/adapter.ts imports pi-durable (or chord)" as a test, next
// to the Biome rule that enforces it in `make -C app lint`. Two gates on
// purpose: Biome fails fast with the reason at the import, and this fails
// `make -C app test` — the step's verification line is a test, and a stray
// import added here is caught even by a runner that skips lint.
//
// The scan is textual: Biome has already parsed every file by the time this
// runs, so this only has to cover the specifiers a static import or a literal
// dynamic import writes (`from "…"`, `import("…")`).
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The package that must not leak past the adapter. */
const RESTRICTED = /(?:from|import)\s*\(?\s*["'](@earendil-works\/(?:pi-durable|chord)(?:\/[^"']*)?)["']/g;

/** The one file allowed to import them. */
const ALLOWED = join("src", "durable", "adapter.ts");

/** sourceFiles lists the app's TypeScript sources. */
async function sourceFiles(dir: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** restrictedImports are every file that imports pi-durable or chord. */
async function restrictedImports(): Promise<string[]> {
	const hits: string[] = [];
	for (const file of await sourceFiles("src")) {
		const text = await readFile(file, "utf8");
		for (const match of text.matchAll(RESTRICTED)) hits.push(`${file}: ${match[1]}`);
	}
	return hits;
}

/** AGENT_RUNTIME is a runtime import of the agent layer: `import … from "../agent/…"`, not `import type`. */
const AGENT_RUNTIME = /(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s*["']\.\.\/agent\/[^"']*["']/g;

describe("the pi-durable import rule", () => {
	it("finds the adapter's own imports, so the scan is not vacuous", async () => {
		const hits = await restrictedImports();
		expect(hits.some((hit) => hit.startsWith(`${ALLOWED}: @earendil-works/pi-durable`))).toBe(true);
		expect(hits.some((hit) => hit.startsWith(`${ALLOWED}: @earendil-works/chord`))).toBe(true);
	});

	it("finds them in no other file", async () => {
		expect((await restrictedImports()).filter((hit) => !hit.startsWith(`${ALLOWED}:`))).toEqual([]);
	});
});

describe("the layer rule", () => {
	// The adapter is the neutral layer: it returns RunResult and knows nothing of
	// Go's reply rules. `reply.ts` (in src/agent) applies those to a run and to a
	// reloaded row alike, so one import the other way would put a reply rule back
	// inside the harness and split the two again (T3 review round 2, Q1).
	it("keeps src/durable/adapter.ts free of runtime imports from src/agent", async () => {
		const adapter = await readFile(ALLOWED, "utf8");
		expect(adapter.match(AGENT_RUNTIME)).toBeNull();
		// The pattern is probed against a value import and a type-only one, so a
		// silent regex cannot pass this by finding nothing anywhere.
		const sample = `import { REFUSAL_REPLY } from "../agent/reply.ts";`;
		expect(sample.match(AGENT_RUNTIME)).toHaveLength(1);
		const typeOnly = `import type { ChangeLine } from "../agent/reply.ts";`;
		expect(typeOnly.match(AGENT_RUNTIME)).toBeNull();
	});
});
