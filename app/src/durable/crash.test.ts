// The crash-replay case of T3.2, in the T0.2 pattern: there is no in-process
// crash simulator (durable-api.md §10), so a child process submits a message
// whose replay-safe tool hangs, the test SIGKILLs it inside that tool, and a
// second agent opens the same SQLite file. The tool task was cut off after its
// intent was committed, so it reruns; the run finishes with one answer.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	type FauxProviderHandle,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import { buildTools } from "../agent/tools.ts";
import { createEntriesService } from "../entries/service.ts";
import { type Stub, startStub } from "../llm/stub.ts";
import { createTestLog } from "../log.ts";
import { createS3Store } from "../objstore/s3.ts";
import { DEFAULTS } from "../settings/settings.ts";
import {
	type Agent,
	inspectLive,
	inspectSchedules,
	type Outbox,
	type OutboxJson,
	openAgent,
	type ToolContext,
	type ToolSpec,
	whenIdle,
} from "./adapter.ts";
import { createStartGuard, epochKey } from "./startguard.ts";

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

// The T4.3b cases: the delivery task's two crash windows (durable-delivery.md
// §3). The send is the one effect the checkpoint cannot cover, so a crash
// before it sends that part after the restart, and a crash during it sends that
// part twice — and never an earlier one. The parent hosts the channel as a
// recorder, so what the chat really received is what the test asserts.
const OUTBOX_KEY = "tg:4242";

/** A recorder is the channel these cases watch: every part POSTed to it, in order. */
interface Recorder {
	url: string;
	parts: string[];
	close: () => Promise<void>;
}

/** startRecorder hosts the endpoint a delivery's send POSTs one part to. */
async function startRecorder(): Promise<Recorder> {
	const parts: string[] = [];
	const server = createServer((request, response) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			parts.push(JSON.parse(body) as string);
			response.writeHead(200);
			response.end("ok");
		});
	});
	await new Promise<void>((done) => {
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	return {
		url: `http://127.0.0.1:${port}/send`,
		parts,
		close: async () => {
			await new Promise<void>((done) => {
				server.close(() => done());
			});
		},
	};
}

/** spawnOutboxChild starts the fixture that dies inside a delivery's send. */
function spawnOutboxChild(options: {
	dbPath: string;
	marker: string;
	url: string;
	parts: string[];
	mode: "before" | "after";
}): ChildProcess {
	return spawn(process.execPath, [join(import.meta.dirname, "crash-outbox-child.ts")], {
		cwd: join(import.meta.dirname, "..", ".."),
		stdio: "inherit",
		env: {
			...process.env,
			MOVIN_CRASH_DB: options.dbPath,
			MOVIN_CRASH_MARKER: options.marker,
			MOVIN_CRASH_URL: options.url,
			MOVIN_CRASH_PARTS: options.parts.join(","),
			MOVIN_CRASH_MODE: options.mode,
		},
	});
}

/** kill SIGKILLs the child and waits for it to be gone. */
async function kill(child: ChildProcess, exited: Promise<void>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGKILL");
	await exited;
}

/** openRecovered opens the killed child's database with a channel that works. */
async function openRecovered(dbPath: string, url: string): Promise<Agent> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const { log } = createTestLog();
	const agent = await openAgent({
		dbPath,
		settings: {
			resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", timeoutSec: 60 }),
		},
		log,
		outbox: {
			send: async (_address, part) => {
				await fetch(url, { method: "POST", body: JSON.stringify(part) });
			},
		},
		models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
	});
	agents.push(agent);
	return agent;
}

describe("a crash in a delivery", () => {
	it("sends every part once when the crash lands before a send", { timeout: TIMEOUT_MS }, async () => {
		const recorder = await startRecorder();
		try {
			const dir = await mkdtemp(join(tmpdir(), "movin-t43b-crash-"));
			dirs.push(dir);
			const dbPath = join(dir, "harness.db");
			const marker = join(dir, "marker.txt");
			const child = spawnOutboxChild({
				dbPath,
				marker,
				url: recorder.url,
				parts: ["a", "b", "c"],
				mode: "before",
			});
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			try {
				// The marker is written before the recorder is called: the first send
				// started and reached nothing when the process dies.
				await waitFor(async () => existsSync(marker), "the child's first send");
				expect(recorder.parts).toEqual([]);
				await kill(child, exited);
			} finally {
				await kill(child, exited);
			}

			// The checkpoint never moved past the first part, so the reopened process
			// sends all three — and the chat sees each of them once.
			const agent = await openRecovered(dbPath, recorder.url);
			await whenIdle(agent, OUTBOX_KEY);
			expect(recorder.parts).toEqual(["a", "b", "c"]);
			expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual(["a"]);
		} finally {
			await recorder.close();
		}
	});

	it("resends only the part that was in flight, and never an earlier one", { timeout: TIMEOUT_MS }, async () => {
		const recorder = await startRecorder();
		try {
			const dir = await mkdtemp(join(tmpdir(), "movin-t43b-crash-"));
			dirs.push(dir);
			const dbPath = join(dir, "harness.db");
			const marker = join(dir, "marker.txt");
			const child = spawnOutboxChild({
				dbPath,
				marker,
				url: recorder.url,
				parts: ["a", "b", "c"],
				mode: "after",
			});
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			try {
				// Two parts reached the recorder; the second is the one whose send hangs,
				// so its checkpoint move never happened.
				await waitFor(async () => recorder.parts.length === 2, "the child's second send");
				await kill(child, exited);
			} finally {
				await kill(child, exited);
			}

			const agent = await openRecovered(dbPath, recorder.url);
			await whenIdle(agent, OUTBOX_KEY);

			// n + 1 parts: "a" once, "b" twice, "c" once. The duplicate is the part
			// that was in flight, and no earlier part repeats.
			expect(recorder.parts).toEqual(["a", "b", "b", "c"]);
			expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual(["a", "b"]);
		} finally {
			await recorder.close();
		}
	});
});

// The T4.2a cases: the intake ledger's crash windows (T4-plan.md §2.6, W3-W5).
// W3 is a batch accepted and nothing submitted; W4 is a kill inside run 1's tool
// with item 2 still queued; W5 is a run that settled while its settle commit
// never ran. Each reopens the same database and does what T4.2b's worker will.
const INTAKE_KEY = "tg:4242";

/** The deadline the recovered worker gives a turn (T4.2b: 15 minutes). */
const INTAKE_DEADLINE = Date.parse("2026-11-11T09:15:00Z");

/** spawnIntakeChild starts the fixture that accepts a batch and then hangs. */
function spawnIntakeChild(options: {
	dbPath: string;
	marker: string;
	mode: "accept" | "tool" | "settled";
	prefix?: string;
}): ChildProcess {
	return spawn(process.execPath, [join(import.meta.dirname, "crash-intake-child.ts")], {
		cwd: join(import.meta.dirname, "..", ".."),
		stdio: "inherit",
		env: {
			...process.env,
			MOVIN_CRASH_DB: options.dbPath,
			MOVIN_CRASH_MARKER: options.marker,
			MOVIN_CRASH_MODE: options.mode,
			...(options.prefix === undefined ? {} : { MOVIN_CRASH_PREFIX: options.prefix }),
		},
	});
}

/** says is what one request's messages said, in order: the model's whole view. */
function says(request: { messages: Message[] }): string[] {
	return request.messages.map((message) =>
		typeof message.content === "string"
			? message.content
			: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
	);
}

/** openKilled reopens the child's database and records every request the model was given. */
async function openKilled(options: {
	dbPath: string;
	answer: (messages: Message[], index: number) => AssistantMessage;
	tools?: readonly ToolSpec[];
	outbox?: Outbox;
}): Promise<{ agent: Agent; faux: FauxProviderHandle; requests: { messages: Message[] }[] }> {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const requests: { messages: Message[] }[] = [];
	faux.setResponses(
		Array.from({ length: 16 }, () => (context: { messages: Message[] }) => {
			requests.push({ messages: context.messages });
			return options.answer(context.messages, requests.length - 1);
		}),
	);
	const { log } = createTestLog();
	const agent = await openAgent({
		dbPath: options.dbPath,
		settings: {
			resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", timeoutSec: 60 }),
		},
		log,
		...(options.tools === undefined ? {} : { tools: options.tools }),
		...(options.outbox === undefined ? {} : { outbox: options.outbox }),
		models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
	});
	agents.push(agent);
	return { agent, faux, requests };
}

describe("a crash with the intake ledger", () => {
	it("submits an accepted item once after a crash before the submit", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t42a-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");

		const child = spawnIntakeChild({ dbPath, marker, mode: "accept" });
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// The marker line is written after the accept commit: the batch is durable.
			await waitFor(async () => existsSync(marker), "the child's accept");
			await kill(child, exited);
		} finally {
			await kill(child, exited);
		}

		const { agent, faux } = await openKilled({ dbPath, answer: () => fauxAssistantMessage(fauxText("done")) });

		// W3's durable state: the batch and the cursor, and no turn in flight.
		const state = await agent.intake.state();
		expect(state.cursor).toBe(11);
		expect(state.queue.map((queued) => queued.id)).toEqual([10]);
		expect(state.open).toEqual([]);

		// The worker logic T4.2b runs for a queued item.
		const [queued] = state.queue;
		if (queued === undefined) throw new Error("no queued item");
		const result = await agent.submit(queued.key, "message 10", {
			requestId: `tg:${queued.id}`,
			intake: { id: queued.id, deadlineAt: INTAKE_DEADLINE },
		});

		// One submission and one run: the accepted update was not duplicated.
		expect(result).toMatchObject({ status: "answered", text: "done" });
		expect(faux.state.callCount).toBe(1);
		expect((await agent.history(INTAKE_KEY, { limit: 10 })).items.map((item) => item.role)).toEqual([
			"assistant",
			"user",
		]);
		// The submit commit moved the item and left the queue empty.
		expect(await agent.intake.state()).toMatchObject({
			cursor: 11,
			queue: [],
			open: [{ id: 10, deadlineAt: INTAKE_DEADLINE }],
		});
	});

	// W4's journal record is the entries one, so the write and the replay have to
	// be shared between the two processes: MinIO, as in the T3.3 case above.
	const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
	const bucket = process.env.S3_BUCKET ?? "";
	const region = process.env.AWS_REGION ?? "ap-southeast-1";

	it.skipIf(endpointUrl === "")(
		"recovers a run killed inside its tool, attaches to it, and runs the next item after it",
		{ timeout: TIMEOUT_MS },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "movin-t42a-crash-"));
			dirs.push(dir);
			const dbPath = join(dir, "harness.db");
			const marker = join(dir, "marker.txt");
			const prefix = `test-t42a-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const { log } = createTestLog();
			const entries = createEntriesService({
				store: createS3Store({ bucket, prefix, region, endpointUrl }),
				log,
				now: () => new Date("2026-11-11T09:00:00Z"),
			});

			const child = spawnIntakeChild({ dbPath, marker, mode: "tool", prefix });
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			try {
				// The write landed and the tool is hanging: the kill is inside it.
				await waitFor(
					async () => existsSync(marker) && (await readFile(marker, "utf8")).includes("written"),
					"the child's write",
				);
				await kill(child, exited);
			} finally {
				await kill(child, exited);
			}

			// The recovery runs the same tool, this time to its end: the replay has to
			// dedupe the write on its change ID, not write a second entry.
			const tools = buildTools({ entries }).map((tool) =>
				tool.name === "add_entry"
					? {
							...tool,
							execute: async (args: unknown, ctx: ToolContext) => {
								const result = await tool.execute(args, ctx);
								appendFileSync(marker, "recovered\n");
								return result;
							},
						}
					: tool,
			);
			const { agent, requests } = await openKilled({
				dbPath,
				tools,
				answer: (_messages, index) =>
					fauxAssistantMessage(fauxText(index === 0 ? "Run one answered." : "Run two answered.")),
			});

			// The resumed run finishes on its own: nothing has to attach for that.
			await whenIdle(agent, INTAKE_KEY);
			const state = await agent.intake.state();
			expect(state.queue.map((queued) => queued.id)).toEqual([11]);
			const [turn] = state.open;
			if (turn === undefined) throw new Error("no open turn");

			// Attaching reports the answer the crash cut off, and settling drops it.
			expect(await agent.attach(INTAKE_KEY, turn.submission)).toMatchObject({
				status: "answered",
				text: "Run one answered.",
			});
			await agent.intake.settle(turn.id, INTAKE_KEY, turn.address, null);

			// Then the queued item runs, in the same transcript, seeing run 1's answer.
			const next = (await agent.intake.state()).queue[0];
			if (next === undefined) throw new Error("no queued item");
			const second = await agent.submit(INTAKE_KEY, "message 11", {
				requestId: `tg:${next.id}`,
				intake: { id: next.id, deadlineAt: INTAKE_DEADLINE },
			});
			expect(second).toMatchObject({ status: "answered", text: "Run two answered." });
			const request = requests[1];
			if (request === undefined) throw new Error("no second request");
			expect(says(request)).toContain("Run one answered.");
			expect(says(request)).toContain("message 11");

			// One entry and one journal record for the one write the rerun replayed.
			const snapshot = await entries.current();
			expect(snapshot.doc.entries.map((entry) => entry.title)).toEqual(["Quartz"]);
			expect(snapshot.doc.changes).toHaveLength(1);
			expect((await readFile(marker, "utf8")).trim().split("\n")).toEqual([
				"accepted 10,11",
				'written actor={"by":"partner","channel":"telegram"}',
				"recovered",
			]);
		},
	);

	it("settles a run the crash finished, and sends its reply exactly once", { timeout: TIMEOUT_MS }, async () => {
		const recorder = await startRecorder();
		try {
			const dir = await mkdtemp(join(tmpdir(), "movin-t42a-crash-"));
			dirs.push(dir);
			const dbPath = join(dir, "harness.db");
			const marker = join(dir, "marker.txt");

			const child = spawnIntakeChild({ dbPath, marker, mode: "settled" });
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			try {
				// The run answered and the settle never ran: the item is still open.
				await waitFor(
					async () => existsSync(marker) && (await readFile(marker, "utf8")).includes("settled"),
					"the child's settle window",
				);
				await kill(child, exited);
			} finally {
				await kill(child, exited);
			}

			const { agent } = await openKilled({
				dbPath,
				answer: () => fauxAssistantMessage(fauxText("unused")),
				outbox: {
					send: async (_address, part) => {
						await fetch(recorder.url, { method: "POST", body: JSON.stringify(part) });
					},
				},
			});

			const state = await agent.intake.state();
			expect(state.open.map((turn) => turn.id)).toEqual([10]);
			const [turn] = state.open;
			if (turn === undefined) throw new Error("no open turn");

			// The run settled before the crash, so attaching answers at once, and the
			// item is only dropped by the settle the dead process never committed.
			expect(await agent.attach(INTAKE_KEY, turn.submission)).toMatchObject({
				status: "answered",
				text: "Run one answered.",
			});
			await agent.intake.settle(turn.id, INTAKE_KEY, turn.address, ["the reply"]);
			await whenIdle(agent, INTAKE_KEY);

			// One reply, one part, one delivery: the restart settled it once.
			expect(recorder.parts).toEqual(["the reply"]);
			expect(await agent.intake.state()).toEqual({ cursor: 11, acceptedAt: expect.any(Number), queue: [], open: [] });
		} finally {
			await recorder.close();
		}
	});
});

// The T5.1b cases (T5-plan §4): a scheduled task is one looping task, so a kill
// must leave exactly that one task — asleep on the target its run answered, or
// waiting for the run the crash cut off to run again.
describe("a crash in a scheduled task", () => {
	/**
	 * openScheduled opens the killed child's database in this process, with a spec
	 * that records what it is called with and answers `target`. No timer is armed: a
	 * real fifteen-minute sleep would outlive the test, so the only wake left is
	 * `resume()`'s at open — which is what the overdue case below turns on.
	 */
	async function openScheduled(
		dbPath: string,
		options: { now: () => number; target: number },
	): Promise<{ agent: Agent; calls: (number | null)[] }> {
		const calls: (number | null)[] = [];
		const { log } = createTestLog();
		const agent = await openAgent({
			dbPath,
			settings: {
				resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "faux-1", timeoutSec: 60 }),
			},
			log,
			now: options.now,
			setTimer: () => undefined,
			schedules: [
				{
					name: "checkin",
					run: async ({ target }) => {
						calls.push(target);
						return options.target;
					},
				},
			],
		});
		agents.push(agent);
		return { agent, calls };
	}

	it("keeps the schedule while it sleeps, at the same target", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t51b-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");
		const target = Date.now() + 120_000;

		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, "crash-schedule-child.ts"), dbPath, marker, "sleep", String(target)],
			{ cwd: join(import.meta.dirname, "..", ".."), stdio: "inherit" },
		);
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// The child's run answered its target and the task is asleep at it: a kill
			// before that line would land between the run and the sleep's commit.
			await waitFor(
				async () => existsSync(marker) && /slept |timeout/.test(await readFile(marker, "utf8")),
				"the child's sleep",
			);
			await kill(child, exited);
		} finally {
			await kill(child, exited);
		}
		expect(await readFile(marker, "utf8")).toBe(`null\nslept ${String(target)}\n`);

		// One minute before the target: nothing may run before it, and the sleep the
		// child stored is exactly the one the reopened process finds.
		const { agent, calls } = await openScheduled(dbPath, { now: () => target - 60_000, target });
		expect(await inspectSchedules(agent)).toEqual([{ name: "checkin", state: "sleeping", until: target, target }]);
		expect(calls).toEqual([]);
	});

	// "The check-in catches up when the app was down at 09:30": the stored sleep's
	// `until` passed while no process ran, so no timer can fire for it. resume() is
	// what wakes it, and this open arms no timer at all. The longer timeout lets that
	// wake's own 25 s wait be the failure a skipped wake reports.
	it("runs an overdue schedule at once, and sleeps towards the next target", { timeout: 30_000 }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t51b-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");
		const target = Date.now() + 120_000;

		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, "crash-schedule-child.ts"), dbPath, marker, "sleep", String(target)],
			{ cwd: join(import.meta.dirname, "..", ".."), stdio: "inherit" },
		);
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// As above: the kill lands with the task asleep at the target, never inside
			// the run whose target it has not stored yet.
			await waitFor(
				async () => existsSync(marker) && /slept |timeout/.test(await readFile(marker, "utf8")),
				"the child's sleep",
			);
			await kill(child, exited);
		} finally {
			await kill(child, exited);
		}
		expect(await readFile(marker, "utf8")).toBe(`null\nslept ${String(target)}\n`);

		// The process comes back two minutes after the target: the run is overdue, and
		// must happen with the target the child stored, not with a fresh one.
		const next = target + 14 * 60_000;
		const { agent, calls } = await openScheduled(dbPath, { now: () => target + 120_000, target: next });
		await waitFor(async () => calls.length === 1, "the overdue run");
		expect(calls).toEqual([target]);
		// One catch-up, not a second task: the same schedule sleeps again, at the next
		// target, and the sleep it stored before is gone.
		await waitFor(async () => {
			const [only] = await inspectSchedules(agent);
			return only?.state === "sleeping" && only.until === next;
		}, "the next sleep");
		expect(await inspectSchedules(agent)).toEqual([{ name: "checkin", state: "sleeping", until: next, target: next }]);
	});

	it("reruns the run a crash cut off, and still keeps one task", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t51b-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");

		const child = spawn(
			process.execPath,
			[join(import.meta.dirname, "crash-schedule-child.ts"), dbPath, marker, "hang", String(Date.now() + 120_000)],
			{ cwd: join(import.meta.dirname, "..", ".."), stdio: "inherit" },
		);
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// The child's `run` appended and then hung: the kill lands inside the phase.
			await waitFor(async () => existsSync(marker), "the child's run to start");
			await kill(child, exited);
		} finally {
			await kill(child, exited);
		}
		expect(await readFile(marker, "utf8")).toBe("null\n");

		// The task was `running` at the kill, so the reopen runs its phase again, with
		// the target the crashed run had — and creates no second task.
		const { agent, calls } = await openScheduled(dbPath, { now: () => Date.now(), target: Date.now() + 60 * 60_000 });
		await waitFor(async () => calls.length === 1, "the recovered run");
		expect(calls).toEqual([null]);
		expect(await inspectSchedules(agent)).toEqual([expect.objectContaining({ name: "checkin", state: "sleeping" })]);
	});
});

// The T5.3a case (T5-plan §5.3): a database restored from a Velero snapshot must
// resend no old reply and replay no tool. Child A is SIGKILLed with an open turn
// whose add_entry hangs, a delivery whose first send hangs, a delivery sleeping
// on a 429, one item still queued and one sleeping schedule; its harness.db with
// its -wal and -shm is copied as the snapshot. The original directory is then
// finished by the control run B, which does resend and does re-run the tool (so
// the case is not vacuous), and the copy is opened three ways: by counter, by a
// new HARNESS_RESTORE_ID, and by the same id again.
describe("a restored database resends nothing and replays no tool", () => {
	const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
	const bucket = process.env.S3_BUCKET ?? "";
	const region = process.env.AWS_REGION ?? "ap-southeast-1";
	const CHAT = "tg:111";
	const SENDING = "tg:222";

	/** starts are the `harness start` lines of one open, as the fields it logged. */
	function starts(lines: string[]): Record<string, unknown>[] {
		return lines
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.msg === "harness start");
	}

	/** toolRuns are the tool executions a directory's marker recorded. */
	function toolRuns(marker: string): string[] {
		return (existsSync(marker) ? readFileSync(marker, "utf8") : "")
			.split("\n")
			.filter((line) => line.startsWith("tool "));
	}

	it.skipIf(endpointUrl === "")(
		"aborts the lost timeline, and answers only what arrives afterwards",
		{ timeout: 60_000 },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "movin-t53a-restore-"));
			dirs.push(dir);
			const one = join(dir, "one");
			const two = join(dir, "two");
			await mkdir(one, { recursive: true });
			await mkdir(two, { recursive: true });
			const dbOne = join(one, "harness.db");
			const dbTwo = join(two, "harness.db");
			const markerA = join(dir, "a.txt");
			const markerB = join(dir, "b.txt");
			const markerC = join(dir, "c.txt");
			const prefix = `test-t53a-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const s3 = createS3Store({ bucket, prefix, region, endpointUrl });
			const entries = createEntriesService({ store: s3, log: createTestLog().log, now: () => new Date() });
			const recorder = await startRecorder();
			const stub: Stub = await startStub();
			const write = {
				kind: "toolCalls",
				calls: [{ name: "add_entry", arguments: JSON.stringify({ entries: [{ kind: "idea", title: "Quartz" }] }) }],
			} as const;
			stub.answer(write, { kind: "text", text: "Saved it." });
			const snapshots: Agent[] = [];

			/**
			 * openDir opens one directory the way serve does — the real tools, the real
			 * model wiring through the stub, a recording channel, and the guard — and
			 * records every tool run and schedule run in its own marker.
			 */
			const openDir = async (options: {
				dbPath: string;
				marker: string;
				restoreId: string;
			}): Promise<{ agent: Agent; lines: string[] }> => {
				const { log, lines } = createTestLog();
				const tools: ToolSpec[] = buildTools({ entries }).map((tool) =>
					tool.name === "add_entry"
						? {
								...tool,
								execute: async (args: unknown, ctx: ToolContext) => {
									const result = await tool.execute(args, ctx);
									appendFileSync(options.marker, `tool ${result.changes?.[0]?.id ?? "no-change"}\n`);
									return result;
								},
							}
						: tool,
				);
				const agent = await openAgent({
					dbPath: options.dbPath,
					settings: {
						resolve: async () => ({ ...DEFAULTS, baseUrl: `${stub.origin}/v1`, model: "stub-model", apiKey: "" }),
					},
					log,
					tools,
					outbox: {
						send: async (_address: OutboxJson, part: OutboxJson) => {
							await fetch(recorder.url, { method: "POST", body: JSON.stringify(part) });
						},
					},
					schedules: [
						{
							name: "checkin",
							run: async () => {
								appendFileSync(options.marker, "schedule run\n");
								return Date.now() + 10 * 60_000;
							},
						},
					],
					startGuard: createStartGuard({ store: s3, instance: "dev", restoreId: options.restoreId, log }),
				});
				agents.push(agent);
				snapshots.push(agent);
				return { agent, lines };
			};

			try {
				// 1. Child A leaves the work a snapshot captures, then dies.
				const child = spawn(process.execPath, [join(import.meta.dirname, "crash-restore-child.ts")], {
					cwd: join(import.meta.dirname, "..", ".."),
					stdio: "inherit",
					env: {
						...process.env,
						MOVIN_CRASH_DB: dbOne,
						MOVIN_CRASH_MARKER: markerA,
						MOVIN_CRASH_PREFIX: prefix,
						MOVIN_CRASH_STUB: stub.origin,
						MOVIN_CRASH_URL: recorder.url,
					},
				});
				const exited = new Promise<void>((done) => child.once("exit", () => done()));
				try {
					await waitFor(
						async () => existsSync(markerA) && (await readFile(markerA, "utf8")).includes("ready "),
						"child A's ready line",
					);
					await kill(child, exited);
				} finally {
					await kill(child, exited);
				}
				const readA = await readFile(markerA, "utf8");
				const epochA =
					readA
						.split("\n")
						.find((line) => line.startsWith("ready "))
						?.slice("ready ".length) ?? "";
				expect(epochA).toMatch(/^[0-9a-f-]{36}$/);
				expect(readA).toContain("written ");

				// 2. The snapshot: the database with its write-ahead log and shared memory.
				for (const suffix of ["", "-wal", "-shm"]) {
					if (existsSync(`${dbOne}${suffix}`)) await copyFile(`${dbOne}${suffix}`, `${dbTwo}${suffix}`);
				}

				// 3. Child B, the control: the same database opened normally, finished.
				const b = await openDir({ dbPath: dbOne, marker: markerB, restoreId: "" });
				await whenIdle(b.agent, CHAT);
				// The T4.2b worker: attach to the open turn, then settle it with its answer.
				const open = (await b.agent.intake.state()).open[0];
				if (open === undefined) throw new Error("no open turn");
				const answer = await b.agent.attach(CHAT, open.submission);
				if (answer.status !== "answered") throw new Error(`the recovered turn ${answer.status}`);
				await b.agent.intake.settle(open.id, CHAT, open.address, [answer.text]);
				// 111's own delivery is what a close must not cut short: the settle only
				// queues it, and `whenIdle(CHAT)` waits for the send the control's reply is
				// asserted on. `SENDING` alone leaves 111 racing the close.
				await whenIdle(b.agent, CHAT);
				await whenIdle(b.agent, SENDING);
				await b.agent.close();

				// The control really did resend and re-run the tool: 111's answer, 222's
				// two parts, and the replayed add_entry deduped to the one record.
				expect(recorder.parts.sort()).toEqual(["222a", "222b", "Saved it."]);
				expect(toolRuns(markerB)).toHaveLength(1);
				const journalAfterB = (await entries.current()).doc;
				expect(journalAfterB.entries.map((entry) => entry.title)).toEqual(["Quartz"]);
				expect(journalAfterB.changes).toHaveLength(1);
				expect(starts(b.lines)).toEqual([expect.objectContaining({ starts: 2, restore: "none" })]);
				// Both sides are at 2 now, and the copy is still at 1.
				const counter = async (): Promise<number> =>
					(JSON.parse(new TextDecoder().decode((await s3.get(epochKey("dev"))).body)) as { starts: number }).starts;
				expect(await counter()).toBe(2);

				// 4. The baseline the restored copy may not move.
				const parts = recorder.parts.length;
				const requests = stub.requests.length;
				const runs = toolRuns(markerC).length;
				const journal = journalAfterB.changes.length;

				// 5. Child C: the snapshot, opened with an empty HARNESS_RESTORE_ID over
				// S3's 2. Nothing may be sent, asked or replayed before a new message.
				const c = await openDir({ dbPath: dbTwo, marker: markerC, restoreId: "" });
				const startLine = starts(c.lines)[0];
				process.stdout.write(`restore by counter: ${JSON.stringify(startLine)}\n`);
				expect(startLine).toMatchObject({ starts: 3, restore: "counter" });
				expect(startLine?.tasksAborted).toBeGreaterThanOrEqual(2);
				expect(startLine?.submissionsAborted).toBeGreaterThanOrEqual(1);
				expect(startLine?.intakeDropped).toBe(2);

				// The abort handlers run under resume(), so wait for them, then check that
				// nothing of the lost timeline went out.
				await waitFor(
					async () => (await inspectLive(c.agent)).every((task) => task.kind !== "movin.outbox.delivery"),
					"the aborted deliveries to settle",
				);
				expect(recorder.parts).toHaveLength(parts);
				expect(stub.requests).toHaveLength(requests);
				expect(toolRuns(markerC)).toHaveLength(runs);
				expect((await entries.current()).doc.changes).toHaveLength(journal);

				// The ledger: no queue, no open turn, no cursor; `recent` still holds the
				// ids the lost timeline accepted, so a redelivery is dropped (13.14).
				expect(await c.agent.intake.state()).toEqual({
					cursor: 0,
					acceptedAt: expect.any(Number),
					queue: [],
					open: [],
				});
				expect(
					await c.agent.intake.accept({
						cursor: 12,
						items: [100, 101].map((id) => ({
							id,
							key: CHAT,
							address: { chat: 111, group: false },
							payload: { text: `message ${String(id)}` },
							at: 1_000 + id,
						})),
					}),
				).toEqual([]);

				// The epoch rotated, and no delivery is live; one schedule per name.
				expect(c.agent.epoch).not.toBe(epochA);
				expect(await inspectLive(c.agent)).toEqual([{ kind: "movin.schedule", state: "sleeping" }]);

				// The new message is answered once, and its write gets a change id the lost
				// timeline never had. It arrives as a poll would bring it: accepted after
				// the restore, submitted, then settled by the worker that sends its reply.
				const fresh = {
					id: 102,
					key: CHAT,
					address: { chat: 111, group: false },
					payload: { text: "a new message" },
					at: 2_000,
				};
				expect(await c.agent.intake.accept({ cursor: 13, items: [fresh] })).toEqual([fresh]);
				stub.answer(write, { kind: "text", text: "Saved it again." });
				expect(
					await c.agent.submit(CHAT, "a new message", {
						requestId: "tg:102",
						intake: { id: fresh.id, deadlineAt: Date.now() + 15 * 60_000 },
						// A write needs an actor (T3.3), as the bot supplies from the update.
						actor: { by: "partner", channel: "telegram" },
					}),
				).toMatchObject({ status: "answered", text: "Saved it again." });
				await c.agent.intake.settle(fresh.id, CHAT, fresh.address, ["Saved it again."]);
				await whenIdle(c.agent, CHAT);
				expect(recorder.parts.slice(parts)).toEqual(["Saved it again."]);
				const newRuns = toolRuns(markerC).slice(runs);
				expect(newRuns).toHaveLength(1);
				const newId = newRuns[0]?.slice("tool ".length) ?? "";
				expect(newId).not.toBe("");
				const finalJournal = (await entries.current()).doc;
				expect(finalJournal.changes).toHaveLength(journal + 1);
				expect(finalJournal.changes.map((change) => change.id)).toContain(newId);
				expect(journalAfterB.changes.map((change) => change.id)).not.toContain(newId);
				// The transcript the restore left: the lost turn's message, the new one, and
				// exactly one answer — the one the new message earned.
				expect((await c.agent.history(CHAT, { limit: 10 })).items.map((item) => [item.role, item.text])).toEqual([
					["assistant", "Saved it again."],
					["user", "a new message"],
					["user", "message 100"],
				]);
				await c.agent.close();

				// 6. The same snapshot with HARNESS_RESTORE_ID=r1: the counters are equal
				// now, so only the id can say the database was restored.
				const sentByC = recorder.parts.length;
				const askedByC = stub.requests.length;
				const ranByC = toolRuns(markerC).length;
				const d = await openDir({ dbPath: dbTwo, marker: markerC, restoreId: "r1" });
				const idLine = starts(d.lines)[0];
				process.stdout.write(`restore by id: ${JSON.stringify(idLine)}\n`);
				expect(idLine).toMatchObject({ restore: "id" });
				await waitFor(
					async () => (await inspectLive(d.agent)).every((task) => task.kind !== "movin.outbox.delivery"),
					"the second restore's deliveries to settle",
				);
				expect(recorder.parts).toHaveLength(sentByC);
				expect(stub.requests).toHaveLength(askedByC);
				expect(toolRuns(markerC)).toHaveLength(ranByC);
				expect(d.agent.epoch).not.toBe(c.agent.epoch);
				expect(await d.agent.intake.state()).toMatchObject({ cursor: 0, queue: [], open: [] });
				await d.agent.close();

				// 7. The same id again is a normal start: nothing is dropped and nothing
				// reruns (the id is recorded, so the path is a one-shot).
				const e = await openDir({ dbPath: dbTwo, marker: markerC, restoreId: "r1" });
				const againLine = starts(e.lines)[0];
				process.stdout.write(`same id again: ${JSON.stringify(againLine)}\n`);
				expect(againLine).toMatchObject({ restore: "none" });
				expect(againLine).not.toHaveProperty("tasksAborted");
				expect(recorder.parts).toHaveLength(sentByC);
				expect(stub.requests).toHaveLength(askedByC);
				expect(toolRuns(markerC)).toHaveLength(ranByC);
				expect(e.agent.epoch).toBe(d.agent.epoch);
				await e.agent.close();

				process.stdout.write(
					`restore case: recorder ${JSON.stringify(recorder.parts)}, journal ${String(journal + 1)} records, counter ${String(
						await counter(),
					)}\n`,
				);
			} finally {
				for (const agent of snapshots.splice(0)) await agent.close().catch(() => undefined);
				await recorder.close();
				await stub.close();
			}
		},
	);
});
