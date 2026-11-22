// The crash-replay case of T3.2, in the T0.2 pattern: there is no in-process
// crash simulator (durable-api.md §10), so a child process submits a message
// whose replay-safe tool hangs, the test SIGKILLs it inside that tool, and a
// second agent opens the same SQLite file. The tool task was cut off after its
// intent was committed, so it reruns; the run finishes with one answer.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { buildTools } from "../agent/tools.ts";
import { createEntriesService } from "../entries/service.ts";
import { createTestLog } from "../log.ts";
import { createS3Store } from "../objstore/s3.ts";
import { DEFAULTS } from "../settings/settings.ts";
import { type Agent, openAgent, type ToolContext, type ToolSpec, whenIdle } from "./adapter.ts";

/** How long the whole case may take: the brief keeps it under 30 s. */
const TIMEOUT_MS = 25_000;

/** The tools and the model both processes use; only the tool's body differs. */
const KEY = "web:zy@example.com";

const dirs: string[] = [];
const agents: Agent[] = [];

afterEach(async () => {
	for (const agent of agents.splice(0)) await agent.close();
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((done) => setTimeout(done, 25));
	}
	throw new Error(`timed out waiting for ${what}`);
}

describe("crash replay", () => {
	it("reruns a replay-safe tool after SIGKILL and answers once", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t32-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");

		const child = spawn(process.execPath, [join(import.meta.dirname, "crash-child.ts"), dbPath, marker], {
			cwd: join(import.meta.dirname, "..", ".."),
			stdio: "inherit",
		});
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// The tool appends before it hangs, so this is "the tool started".
			await waitFor(async () => existsSync(marker), "the child's tool to start");
			// The intent is durable before execute() runs (durable-api.md §7), so a
			// kill here is the crash the replay rule is about.
			child.kill("SIGKILL");
			await exited;
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}

		// A second process opens the same file; the adapter resumes on open.
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		faux.setResponses(
			Array.from(
				{ length: 16 },
				() => (context: { messages: { role: string }[] }) =>
					context.messages.at(-1)?.role === "toolResult"
						? fauxAssistantMessage(fauxText("done"))
						: fauxAssistantMessage(fauxToolCall("slow", {}), { stopReason: "toolUse" }),
			),
		);
		const { log } = createTestLog();
		const agent = await openAgent({
			dbPath,
			settings: {
				resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", timeoutSec: 60 }),
			},
			log,
			tools: [
				{
					name: "slow",
					description: "A tool that never finishes, so the process can be killed inside it.",
					parameters: { type: "object", properties: {} },
					replay: "safe",
					writes: false,
					execute: async () => {
						// The recovery's rerun lands here: the second "started" line, and
						// unlike the child this one returns.
						appendFileSync(marker, "started\n");
						return { text: "recovered" };
					},
				},
			],
			models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
		});
		agents.push(agent);

		await whenIdle(agent, KEY);

		// The tool ran twice (once in the killed child, once in the recovery) and the
		// run answered exactly once: nothing was written or said twice.
		expect((await agent.history(KEY, { limit: 10 })).items.map((item) => [item.role, item.text])).toEqual([
			["assistant", "done"],
			["user", "go"],
		]);
		expect(await readFile(marker, "utf8")).toBe("started\nstarted\n");
	});
});

// The T3.3 case: the crash lands between add_entry's WRITE and the answer, so
// the recovered run must replay the write (one journal record, one entry) and
// answer once — and the rerun must still know who asked, from the actor the
// adapter stored with the input and memoised on the tool task.
describe("a crash between a write and the reply", () => {
	// The entries live in MinIO, because the two processes must share them; a
	// memory store would not outlive the child.
	const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
	const bucket = process.env.S3_BUCKET ?? "";
	const region = process.env.AWS_REGION ?? "ap-southeast-1";

	it.skipIf(endpointUrl === "")(
		"replays add_entry to one record and answers once",
		{ timeout: TIMEOUT_MS },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "movin-t33-crash-"));
			dirs.push(dir);
			const dbPath = join(dir, "harness.db");
			const marker = join(dir, "marker.txt");
			const prefix = `test-t33-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const store = () => createS3Store({ bucket, prefix, region, endpointUrl });
			const now = () => new Date("2026-11-11T09:00:00Z");

			const child = spawn(process.execPath, [join(import.meta.dirname, "crash-tools-child.ts")], {
				cwd: join(import.meta.dirname, "..", ".."),
				stdio: "inherit",
				env: { ...process.env, MOVIN_CRASH_DB: dbPath, MOVIN_CRASH_MARKER: marker, MOVIN_CRASH_PREFIX: prefix },
			});
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			try {
				// The tool appends after the write, so this is "written, not answered".
				await waitFor(async () => existsSync(marker), "the child's write to land");
				child.kill("SIGKILL");
				await exited;
			} finally {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}

			// The recovery: the same database, the same entries, and the tools a real
			// process registers — this time add_entry returns instead of hanging.
			const { log } = createTestLog();
			const entries = createEntriesService({ store: store(), log, now });
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel();
			faux.setResponses(
				Array.from(
					{ length: 16 },
					() => (context: { messages: { role: string }[] }) =>
						context.messages.at(-1)?.role === "toolResult"
							? fauxAssistantMessage(fauxText("Saved it."))
							: fauxAssistantMessage(fauxToolCall("add_entry", { entries: [{ kind: "idea", title: "Quartz" }] }), {
									stopReason: "toolUse",
								}),
				),
			);
			const tools: ToolSpec[] = buildTools({ entries }).map((tool) =>
				tool.name === "add_entry"
					? {
							...tool,
							execute: async (args: unknown, ctx: ToolContext) => {
								appendFileSync(marker, `recovery actor=${JSON.stringify(ctx.actor)}\n`);
								return await tool.execute(args, ctx);
							},
						}
					: tool,
			);
			const agent = await openAgent({
				dbPath,
				settings: {
					resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", timeoutSec: 60 }),
				},
				log,
				tools,
				models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
			});
			agents.push(agent);
			await whenIdle(agent, KEY);

			// One answer, one entry, one journal record: the rerun replayed the write.
			expect((await agent.history(KEY, { limit: 10 })).items.map((item) => [item.role, item.text])).toEqual([
				["assistant", "Saved it."],
				["user", "quartz for the wet kitchen"],
			]);
			const snapshot = await entries.current();
			expect(snapshot.doc.entries.map((entry) => entry.title)).toEqual(["Quartz"]);
			expect(snapshot.doc.changes).toHaveLength(1);
			expect(snapshot.doc.entries[0]).toMatchObject({ by: "partner", channel: "telegram" });

			// Both processes saw the actor: the child wrote it, the recovery read it
			// back from the tool task's memo (beforeTool does not run again).
			const lines = (await readFile(marker, "utf8")).trim().split("\n");
			expect(lines[0]).toBe('actor={"by":"partner","channel":"telegram"}');
			expect(lines[1]).toBe('recovery actor={"by":"partner","channel":"telegram"}');
		},
	);
});

// The T3.4 case: the prompt state is committed with the message, then the
// process dies before the run (and its afterRun) settles. Reopening must find
// that state, not lose it and not apply a second step.
describe("a crash after the submit", () => {
	it("keeps the seen state and advances it once", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t34-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");

		const child = spawn(process.execPath, [join(import.meta.dirname, "crash-prompt-child.ts"), dbPath, marker], {
			cwd: join(import.meta.dirname, "..", ".."),
			stdio: "inherit",
		});
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// The tool line comes after the submit commit: the state is on disk.
			await waitFor(
				async () => existsSync(marker) && (await readFile(marker, "utf8")).includes('"at":"tool"'),
				"the child's submit",
			);
			child.kill("SIGKILL");
			await exited;
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		// The child wrote its submit state and never reached afterRun.
		expect(
			(await readFile(marker, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).at),
		).toEqual(["submit", "tool"]);

		/** openWithPromptState reopens the database with hooks that record what they are given. */
		const openWithPromptState = async (seen: unknown[]): Promise<Agent> => {
			const faux = fauxProvider();
			const models = createModels();
			models.setProvider(faux.provider);
			const model = faux.getModel();
			faux.setResponses(
				Array.from(
					{ length: 16 },
					() => (context: { messages: { role: string }[] }) =>
						context.messages.at(-1)?.role === "toolResult"
							? fauxAssistantMessage(fauxText("done"))
							: fauxAssistantMessage(fauxText("still done")),
				),
			);
			const { log } = createTestLog();
			const agent = await openAgent({
				dbPath,
				settings: {
					resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", timeoutSec: 60 }),
				},
				log,
				hooks: {
					userContent: async (_key, text, { state }) => {
						seen.push(state);
						const previous = (state ?? {}) as { runs?: number };
						return { content: text, state: { ...(state as object), runs: (previous.runs ?? 0) + 1 } };
					},
					afterRun: async (_key, _result, state) => {
						const previous = (state ?? {}) as { after?: number };
						return { ...(state as object), after: (previous.after ?? 0) + 1 };
					},
				},
				models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
			});
			agents.push(agent);
			return agent;
		};

		// The first reopen finds exactly what the submit commit stored: no loss,
		// and afterRun never ran for the killed attempt.
		const firstSeen: unknown[] = [];
		const second = await openWithPromptState(firstSeen);
		await second.submit(KEY, "two");
		await whenIdle(second, KEY);
		expect(firstSeen[0]).toEqual({ runs: 1, seen: { a: "line-a" } });
		await second.close();
		agents.splice(agents.indexOf(second), 1);

		// The next reopen sees the state after one turn: runs 2, after 1 — not a
		// second afterRun and not a reset of runs.
		const thirdSeen: unknown[] = [];
		const third = await openWithPromptState(thirdSeen);
		await third.submit(KEY, "three");
		expect(thirdSeen[0]).toEqual({ runs: 2, seen: { a: "line-a" }, after: 1 });
	});
});
