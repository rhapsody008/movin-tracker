// T4.2b's crash cases, in the T0.2 pattern: a child process really polls a Bot
// API and submits the message it took, and then hangs. The test SIGKILLs it
// mid-turn, reopens the same database in this process, and the bot's startup
// recovery attaches to the open turn — the run finishes, and the reply goes out
// once. Two windows, because they are the two the durable intake has to cover:
//
// - `tool`: the kill lands inside the write tool, after its write is in the
//   bucket (T3.3's and T4.2a's W4 window, driven by the bot). The entries are
//   the shared state between the processes, so this one uses MinIO and skips
//   when there is no S3 endpoint.
// - `model`: the kill lands inside the model request, which is the likeliest
//   real one — a pod killed while the model is answering. It reopens with the
//   *same* connection settings the child used, as production would: the same
//   kind, base URL and model, because the model reference stored with the
//   submission is what pi-durable looks up (`dist/harness/generation.js:433-442`,
//   `failNoModel`).
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTools } from "../agent/tools.ts";
import { FakeConverter } from "../docs/convert/fake.ts";
import { INDEX_KEY } from "../docs/index.ts";
import { createSyncer } from "../docs/sync.ts";
import { type Agent, inspectSchedules, openAgent } from "../durable/adapter.ts";
import { createEntriesService, type EntriesService } from "../entries/service.ts";
import { type Stub, startStub } from "../llm/stub.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import type { ObjectStore } from "../objstore/store.ts";
import { createSettingsService, DEFAULTS, type SettingsService } from "../settings/settings.ts";
import { CHECKIN_SENT, CheckinStore, createCheckin } from "../tasks/checkin.ts";
import { docsyncSpec } from "../tasks/docsync.ts";
import { type Bot, createBot, createBotState } from "./bot.ts";
import { type Client, createClient } from "./client.ts";
import { FAKE_TOKEN, type FakeBotApi, startFakeBotApi } from "./fake-api.ts";
import { createOutbox } from "./outbox.ts";

/** How long one case may take. */
const TIMEOUT_MS = 25_000;

const ZY = 111;

/** The connection both processes use: Go's DEFAULTS with a model, pointed at a stub. */
function connection(baseUrl: string): { env: typeof DEFAULTS; model: string; kind: string } {
	return {
		env: { ...DEFAULTS, baseUrl, model: "m", timeoutSec: 60, maxToolRounds: 3 },
		model: "m",
		kind: DEFAULTS.kind,
	};
}

const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
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

/** kill SIGKILLs and waits, so the database is not held by two processes at once. */
async function kill(child: ChildProcess, exited: Promise<void>): Promise<void> {
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await exited;
}

/** spawned is one child of `crash-bot-child.ts`, with the way to wait for it. */
async function spawnChild(o: {
	dbPath: string;
	marker: string;
	api: FakeBotApi;
	llm: Stub;
	mode: "tool" | "model";
	prefix?: string;
}): Promise<{ child: ChildProcess; exited: Promise<void> }> {
	const child = spawn(process.execPath, [join(import.meta.dirname, "crash-bot-child.ts")], {
		cwd: join(import.meta.dirname, "..", ".."),
		stdio: "inherit",
		env: {
			...process.env,
			MOVIN_CRASH_DB: o.dbPath,
			MOVIN_CRASH_MARKER: o.marker,
			MOVIN_CRASH_API: o.api.url,
			MOVIN_CRASH_LLM: `${o.llm.origin}/v1`,
			MOVIN_CRASH_MODE: o.mode,
			...(o.prefix === undefined ? {} : { MOVIN_CRASH_PREFIX: o.prefix }),
		},
	});
	return { child, exited: new Promise<void>((done) => child.once("exit", () => done())) };
}

/** marked is whether the child has written `word` to its marker. */
async function marked(marker: string, word: string): Promise<boolean> {
	return existsSync(marker) && (await readFile(marker, "utf8")).includes(word);
}

/** rig is the reopened process: the bot, its agent and the entries both sides share. */
interface Rig {
	agent: Agent;
	bot: Bot;
	entries: EntriesService;
	settings: SettingsService;
}

/** reopen starts this process on the crashed database, exactly as `serve()` would. */
async function reopen(o: {
	dbPath: string;
	store: ObjectStore;
	api: FakeBotApi;
	/** The base URL the resumed request goes to: the child's own, in the `model` case. */
	baseUrl: string;
}): Promise<Rig> {
	const { log } = createTestLog();
	const now = (): Date => new Date("2026-11-11T09:00:00Z");
	const entries = createEntriesService({ store: o.store, log, now });
	const settings = createSettingsService({
		store: o.store,
		log,
		env: connection(o.baseUrl).env,
		telegramEnv: { users: [{ id: `${ZY}`, name: "ZY" }], groups: [], fromEnv: true },
		now,
	});
	const state = createBotState(true);
	const client: Client = createClient({ token: FAKE_TOKEN, baseUrl: o.api.url });
	const agent = await openAgent({
		dbPath: o.dbPath,
		settings,
		log,
		tools: buildTools({ entries, docs: null, viewer: null }),
		outbox: createOutbox({ client, log, state, now }),
		// The real clock, as production has it: pi-durable arms a retry's sleep in real
		// milliseconds and compares it with `now()`, so a frozen clock would leave the
		// interrupted generation sleeping for ever and the reply would never come.
	});
	const bot = createBot({
		client,
		settings,
		agent,
		entries,
		syncer: null,
		timeZone: "UTC",
		state,
		log,
		pollSeconds: 1,
	});
	// First closes first: the bot stops polling before the servers it polls.
	closers.unshift(async () => {
		await bot.stop();
		await agent.close();
	});
	void bot.run();
	return { agent, bot, entries, settings };
}

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

/** oneUpdate is the message the child polls: "record Quartz" from ZY, privately. */
const oneUpdate = {
	update_id: 1,
	message: {
		message_id: 1,
		from: { id: ZY, is_bot: false, first_name: "Zhou", last_name: "", username: "" },
		chat: { id: ZY, type: "private", title: "", username: "", first_name: "" },
		date: 1,
		text: "record Quartz",
		caption: "",
		photo: [],
		migrate_to_chat_id: 0,
	},
};

describe("a crash mid-turn", () => {
	it.skipIf(endpointUrl === "")(
		"answers the polled message once and writes one entry when killed inside the tool",
		{ timeout: TIMEOUT_MS },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "movin-t42b-crash-"));
			dirs.push(dir);
			const dbPath = join(dir, "harness.db");
			const marker = join(dir, "marker.txt");
			const prefix = `test-t42b-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`;

			// The parent hosts both services the child talks to: a Bot API holding one
			// update, and the scripted model whose tool call the child hangs in.
			const api = await startFakeBotApi();
			closers.push(() => api.close());
			const llm = await startStub();
			closers.push(llm.close);
			llm.answer(
				{
					kind: "toolCalls",
					calls: [{ name: "add_entry", arguments: '{"entries":[{"kind":"note","title":"Quartz"}]}' }],
				},
				{ kind: "text", text: "Run one answered." },
			);
			api.push(structuredClone(oneUpdate));

			const { child, exited } = await spawnChild({ dbPath, marker, api, llm, mode: "tool", prefix });
			try {
				// The write landed and the tool is hanging: the kill is inside the turn.
				await waitFor(async () => marked(marker, "written"), "the child's tool");
				await kill(child, exited);
			} finally {
				await kill(child, exited);
			}
			expect(api.sent).toHaveLength(0);

			// The next process: the same bucket and database, and a model that answers.
			// A second endpoint, because the model reference is kind plus model id, not
			// a URL (generation.js:433-442 settles `no_model` for an unknown one).
			const parentLlm = await startStub();
			closers.push(parentLlm.close);
			parentLlm.answer({ kind: "text", text: "Run one answered." });
			const rig = await reopen({
				dbPath,
				store: createS3Store({ bucket, prefix, region, endpointUrl }),
				api,
				baseUrl: `${parentLlm.origin}/v1`,
			});

			await waitFor(async () => api.sent.length >= 1, "the recovered reply");
			expect(api.sent[0]?.chatId).toBe(ZY);
			expect(api.sent[0]?.text).toBe("Run one answered.\n\n• Saved: note · Quartz");
			expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });

			// One entry, not two: the replayed write is deduplicated by its change id.
			const stored = (await rig.entries.current()).doc.entries;
			expect(stored.map((entry) => [entry.title, entry.by, entry.channel])).toEqual([["Quartz", "ZY", "telegram"]]);
			// And exactly one reply: a second recovery would send another.
			await new Promise((done) => setTimeout(done, 300));
			expect(api.sent).toHaveLength(1);
		},
	);

	it("re-issues the request when killed while the model is answering", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t42b-model-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");

		const api = await startFakeBotApi();
		closers.push(() => api.close());
		const llm = await startStub();
		closers.push(llm.close);
		// The model never answers: the kill lands inside the request itself.
		llm.answer({ kind: "hang" });
		api.push(structuredClone(oneUpdate));

		const { child, exited } = await spawnChild({ dbPath, marker, api, llm, mode: "model" });
		try {
			await waitFor(async () => (await marked(marker, "open")) && llm.requests.length > 0, "the hanging request");
			await kill(child, exited);
		} finally {
			await kill(child, exited);
		}
		expect(api.sent).toHaveLength(0);
		// One request was made and never answered: that is the cut-off generation.
		expect(llm.requests).toHaveLength(1);

		// The same connection settings — kind, base URL, model — as the child used, and
		// the same endpoint, which answers this time.
		llm.answer({ kind: "text", text: "Run one answered." });
		const rig = await reopen({ dbPath, store: createMemoryStore(), api, baseUrl: `${llm.origin}/v1` });

		await waitFor(async () => api.sent.length >= 1, "the recovered reply");
		expect(api.sent[0]?.chatId).toBe(ZY);
		expect(api.sent[0]?.text).toBe("Run one answered.");
		expect(await rig.agent.intake.state()).toMatchObject({ queue: [], open: [] });
		// The answer came from a re-issued request, not from a cached failure.
		expect(llm.requests).toHaveLength(2);

		await new Promise((done) => setTimeout(done, 300));
		expect(api.sent).toHaveLength(1);
	});
});

// ---------- T5.1c: a crash between the claim and the delivery ----------

/**
 * The check-in's own crash window: the day is claimed in `checkin.json`, and the
 * process dies before the delivery's commit. The next process takes the stale
 * claim over after STALE_CLAIM_MS and sends once, with the crashed claim's window
 * — Go's `TestCheckinTakesOverACrashedClaim` (checkin_test.go:302), with a real
 * kill rather than a planted claim.
 *
 * MinIO, because `checkin.json` and the entries are what the two processes share.
 */
describe("a crash between the check-in's claim and its delivery", () => {
	it.skipIf(endpointUrl === "")(
		"takes the stale claim over, sends one check-in, and records it with the crashed window",
		{ timeout: TIMEOUT_MS },
		async () => {
			const dir = await mkdtemp(join(tmpdir(), "movin-t51c-crash-"));
			dirs.push(dir);
			const marker = join(dir, "marker.txt");
			const prefix = `test-t51c-crash-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const store = createS3Store({ bucket, prefix, region, endpointUrl });
			const { log } = createTestLog();
			const at = (iso: string): Date => new Date(iso);

			// What the crashed process finds: yesterday's check-in went out, and one task
			// is still open from that day.
			const entries = createEntriesService({ store, log, now: () => at("2026-11-13T09:30:00Z") });
			await entries.create({ by: "ZY", channel: "web" }, [{ kind: "task", title: "Book movers", date: "2026-11-12" }]);
			const checkinStore = new CheckinStore(store);
			const yesterdays = await checkinStore.claim("2026-11-12", "-1001", at("2026-11-12T09:30:00Z"));
			if (yesterdays.claim === null) throw new Error("the 12th could not be claimed");
			await checkinStore.finish(yesterdays.claim, CHECKIN_SENT, at("2026-11-12T09:30:00Z"));

			const child = spawn(process.execPath, [join(import.meta.dirname, "crash-checkin-child.ts")], {
				cwd: join(import.meta.dirname, "..", ".."),
				stdio: "inherit",
				env: {
					...process.env,
					MOVIN_CRASH_MARKER: marker,
					MOVIN_CRASH_PREFIX: prefix,
				},
			});
			const exited = new Promise<void>((done) => child.once("exit", () => done()));
			try {
				await waitFor(async () => marked(marker, "claimed"), "the claim to land");
				await kill(child, exited);
			} finally {
				await kill(child, exited);
			}
			// The claim is in the bucket and nothing was recorded as sent.
			expect((await checkinStore.load()).record).toMatchObject({ day: "2026-11-13", status: "sending" });

			// The next process, eleven minutes later: the claim is stale, so it takes over.
			const sends: { texts: string[] }[] = [];
			const reopened = createCheckin({
				store,
				settings: createSettingsService({
					store: createMemoryStore(),
					log,
					env: DEFAULTS,
					telegramEnv: { users: [{ id: "111", name: "ZY" }], groups: ["-1001"], fromEnv: true },
					now: () => at("2026-11-13T09:41:00Z"),
				}),
				entries,
				deliver: async (_key, _address, parts) => {
					sends.push({ texts: parts.map((part) => String((part as { text?: string }).text ?? "")) });
				},
				now: () => at("2026-11-13T09:41:00Z"),
				timeZone: "UTC",
				log,
			});
			await reopened.tick();

			// Exactly one check-in, asking the crashed claim's days, recorded as sent.
			expect(sends).toHaveLength(1);
			expect(sends[0]?.texts[0]).toContain("Good morning! Fri 13 Nov");
			expect(sends[0]?.texts[1]?.startsWith("Yesterday: Book movers")).toBe(true);
			expect((await checkinStore.load()).record).toMatchObject({
				day: "2026-11-13",
				status: CHECKIN_SENT,
				since: "2026-11-12",
			});

			// And a second pass the same day sends nothing more.
			await reopened.tick();
			expect(sends).toHaveLength(1);
		},
	);
});

// ---------- T5.2: a crash inside the daily document sync ----------

/**
 * The daily sync's own crash window: the durable `docsync` schedule reaches
 * 03:00 and the process dies inside the run, so the day is unfinished in the
 * database. The next process re-runs it — Go had no retry for a crash here — and
 * writes the index once. No bucket is shared: the database is the state.
 */
describe("a crash inside the daily document sync", () => {
	it("runs the day again on reopen and writes the index once", { timeout: TIMEOUT_MS }, async () => {
		const dir = await mkdtemp(join(tmpdir(), "movin-t52-crash-"));
		dirs.push(dir);
		const dbPath = join(dir, "harness.db");
		const marker = join(dir, "marker.txt");

		const child = spawn(process.execPath, [join(import.meta.dirname, "crash-docsync-child.ts")], {
			cwd: join(import.meta.dirname, "..", ".."),
			stdio: "inherit",
			env: { ...process.env, MOVIN_CRASH_DB: dbPath, MOVIN_CRASH_MARKER: marker },
		});
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		try {
			// The child reached 03:00 and is inside the sync: kill it there.
			await waitFor(async () => marked(marker, "daily"), "the child's daily sync");
			await kill(child, exited);
		} finally {
			await kill(child, exited);
		}

		// The next process, ten minutes later: the crashed day is still the target, so
		// it runs the sync again — over its own store, and one index write.
		const at = (iso: string): Date => new Date(iso);
		const { log } = createTestLog();
		const memory = createMemoryStore();
		const pad = " text of the manual".repeat(10);
		await memory.putBlob("docs/raw/Oven.pdf", new TextEncoder().encode("pdf-b"), "application/pdf");
		let indexWrites = 0;
		const store: ObjectStore = {
			...memory,
			put: async (key, body, ifMatch, signal) => {
				if (key === INDEX_KEY) indexWrites++;
				return await memory.put(key, body, ifMatch, signal);
			},
		};
		const conv = new FakeConverter();
		conv.pages.set("pdf-b", [{ n: 1, w: 595, h: 842, text: `Oven manual${pad}` }]);
		const syncer = createSyncer({ store, converter: conv, log, now: () => at("2026-11-12T03:10:00Z") });
		const reasons: string[] = [];
		const spec = docsyncSpec({
			syncer: {
				sync: async (reason) => {
					reasons.push(reason);
					return await syncer.sync(reason);
				},
			},
			schedule: "03:00",
			timeZone: "UTC",
			now: () => at("2026-11-12T03:10:00Z"),
			log,
		});
		const agent = await openAgent({
			dbPath,
			settings: { resolve: async () => ({ ...DEFAULTS, baseUrl: "http://faux.test/v1", model: "m" }) },
			log,
			// A frozen clock and only the zero-delay pacing timers: the crashed run is
			// queued at open, and the next morning's sleep is not this test's to wait on.
			now: () => at("2026-11-12T03:10:00Z").getTime(),
			setTimer: (callback, delayMs) => {
				if (delayMs !== 0) return () => undefined;
				const handle = setTimeout(callback, 0);
				return () => clearTimeout(handle);
			},
			schedules: [spec],
		});
		closers.push(() => agent.close());
		await waitFor(async () => indexWrites === 1, "the rerun's index write");

		// One daily sync, one conversion, one index write — and the schedule stays.
		expect(reasons).toEqual(["daily"]);
		expect(indexWrites).toBe(1);
		expect(conv.calls).toBe(1);
		await waitFor(
			async () => (await inspectSchedules(agent)).some((task) => task.target === Date.parse("2026-11-13T03:00:00Z")),
			"the next day's target",
		);
	});
});
