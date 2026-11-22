// chat-eval, ported from cmd/chateval (agent-spec §6): it sends a fixed list of
// messages to the real endpoint the connection names, through the real v3 agent
// — the adapter on a temp-file SQLite database, buildTools, promptHooks and
// reply.ts — and prints the entry diff after each one. It runs on an in-memory
// copy of fixtures/entries.sample.json, so it never touches a real bucket.
// Messages run in order on the same document. Exits non-zero if any message made
// the wrong change.
//
//   node eval/chateval.ts [-saved] [-model id] [-docs] [fixture]
//
// -saved uses the connection saved on the web page (settings.json in the
// configured bucket, read only) instead of LLM_* from the environment; run it
// where the app's S3 settings and SETTINGS_SECRET are. -docs adds the five
// questions about the real documents in the bucket (read only; needs -saved and
// poppler). Both read the bucket and never write it.
//
// Removed from Go: the -kind flag and the Claude target (agent-spec §1.10), so
// the banner has no Claude effort wording.
//
// Every case is a fresh conversation (`eval:<n>`), so each is a one-message
// conversation as in Go, on the one document they all share.

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promptHooks } from "../src/agent/prompt.ts";
import { channelReply } from "../src/agent/reply.ts";
import { buildTools } from "../src/agent/tools.ts";
import { type Config, type Env, loadConfig } from "../src/config.ts";
import { createPoppler } from "../src/docs/convert/poppler.ts";
import type { Index } from "../src/docs/index.ts";
import { createViewer, type Viewer } from "../src/docs/render.ts";
import { createLibrary, type Library } from "../src/docs/search.ts";
import { createSyncer, type Syncer } from "../src/docs/sync.ts";
import { type Agent, openAgent, type SettingsSource } from "../src/durable/adapter.ts";
import { type Doc, decodeDoc } from "../src/entries/model.ts";
import { createEntriesService, type EntriesService } from "../src/entries/service.ts";
import { goMarshal } from "../src/gojson.ts";
import { goQuote, goTrimSpace } from "../src/gostr.ts";
import type { Usage } from "../src/llm/usage.ts";
import { createLog, errorMessage, type Log } from "../src/log.ts";
import { createMemoryStore } from "../src/objstore/memory.ts";
import { createS3Store } from "../src/objstore/s3.ts";
import type { ObjectStore } from "../src/objstore/store.ts";
import { createSettingsService, type LLM } from "../src/settings/settings.ts";
import {
	added,
	type Day,
	deref,
	diff,
	type EvalCase,
	entryJson,
	eq,
	fridays,
	live,
	milestones,
	nextDec5,
	unchanged,
} from "./case.ts";
import { docCases } from "./docs.ts";

/** Go's seeded id for the entry cases 8 and 9 archive and bring back (main.go:44-47). */
const SEED_CLEANING = "01K9SEED000000000000000002";

/**
 * Go's default fixture, `fixtures/entries.sample.json` relative to the repo
 * root, which is where the Go binary ran it from. This file sits in eval/, one
 * directory below the root, so the same file is one directory up.
 */
const DEFAULT_FIXTURE = fileURLToPath(new URL("../fixtures/entries.sample.json", import.meta.url));

/** The short weekday and month names Go's layout prints, in Go's order. */
const WEEKDAYS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS: readonly string[] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface EvalOptions {
	/** The environment: LLM_*, and for -saved the app's S3_* and SETTINGS_SECRET. */
	env: Env;
	/** The arguments after the program name. */
	args: readonly string[];
	/** Where a line goes, newline not included; process.stdout by default. */
	write?: (line: string) => void;
	/** Where a failure line goes (Go's main prints `error: <it>`); process.stderr by default. */
	writeErr?: (line: string) => void;
	/** The bucket the saved connection and the documents are read from; the real S3 by default. */
	store?: ObjectStore;
	/** The clock the banner and the date checks read; the system clock by default. */
	now?: () => Date;
}

/** One parsed command line. */
interface Flags {
	saved: boolean;
	/** `-model`: the model id for this run, over the saved or env one. */
	model: string;
	docs: boolean;
	fixture: string;
}

/** The connection a run uses: the resolved one, the source the agent re-reads, and the bucket. */
interface Connection {
	cfg: LLM;
	settings: SettingsSource;
	/** The bucket the connection was read from, or null when the env supplied it. */
	bucket: ObjectStore | null;
}

/** What -docs build: the read-only syncer, the search library over it, and the page viewer. */
interface Docs {
	syncer: Syncer;
	library: Library;
	viewer: Viewer;
}

/** What one case needs to run. */
interface CaseEnv {
	agent: Agent;
	entries: EntriesService;
	/** The model id the reply carries (Go's cfg.Model). */
	model: string;
	/** The log lines written so far, for the case's own `agent tool call` window. */
	lines: string[];
	write: (line: string) => void;
}

/**
 * run is Go's main()/run() (main.go:256-329): it parses the flags, resolves the
 * connection, seeds the in-memory entries, runs every case on one agent, prints
 * the per-case block and the totals, and throws on a setup error or a failed
 * case — Go returns the error and main prints `error: <it>`.
 */
export async function run(options: EvalOptions): Promise<void> {
	const write = options.write ?? ((line: string): void => void process.stdout.write(`${line}\n`));
	// Go sets S3_BUCKET to "unused" because config.Load requires it and chat-eval
	// works on memory (main.go:264-266).
	const env: Env = { ...options.env };
	if (goTrimSpace(env.S3_BUCKET ?? "") === "") env.S3_BUCKET = "unused";
	const flags = parseFlags(options.args);
	const config = loadConfig(env);
	if (flags.docs && !flags.saved) throw new Error("-docs needs -saved (the documents are in the bucket)");
	const now = options.now ?? ((): Date => new Date());

	// Go's logs buffer (testutil.SyncBuffer): the app's lines, never the console,
	// so the case's window can be searched for the tool calls it made.
	const lines: string[] = [];
	const log = createLog({ level: "debug", write: (line) => lines.push(line) });
	const connection = await resolveConnection(config, flags.model, flags.saved, options.store, log, now);
	const docs = flags.docs ? await openDocs(bucketOf(connection), log, now) : null;

	// The entries: memory only, seeded from the fixture, as Go's evalRunner does
	// (main.go:376-411). Nothing here ever reaches the bucket.
	const entries = createEntriesService({
		store: createMemoryStore(),
		log,
		timeZone: config.timeZone,
		now,
	});
	await entries.load();
	await entries.replace(await readFixture(flags.fixture));

	const dir = await mkdtemp(join(tmpdir(), "movin-chateval-"));
	let agent: Agent;
	try {
		agent = await openAgent({
			dbPath: join(dir, "harness.db"),
			settings: connection.settings,
			log,
			tools: buildTools({
				entries,
				docs: docs === null ? null : docs.library,
				viewer: docs === null ? null : docs.viewer,
			}),
			hooks: promptHooks({
				entries,
				docs: docs === null ? null : docs.syncer,
				viewer: docs !== null,
				timeZone: config.timeZone,
				now,
				log,
			}),
		});
	} catch (err) {
		// An open that fails must leave no database behind.
		await rm(dir, { recursive: true, force: true });
		throw err;
	}

	try {
		const day = dayIn(now(), config.timeZone);
		write(
			`chat-eval: openai model ${connection.cfg.model} at ${connection.cfg.baseUrl}, ${effortOf(connection.cfg)}, today ${goDay(day)}`,
		);
		write("");

		const all = cases(day);
		if (flags.docs) all.push(...docCases());
		const caseEnv: CaseEnv = { agent, entries, model: connection.cfg.model, lines, write };
		const total: Usage = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
		let seconds = 0;
		let failed = 0;
		for (const [index, one] of all.entries()) {
			const outcome = await runCase(caseEnv, index, one);
			seconds += outcome.took;
			total.in += outcome.usage.in;
			total.out += outcome.usage.out;
			total.cacheRead += outcome.usage.cacheRead;
			total.cacheWrite += outcome.usage.cacheWrite;
			if (!outcome.ok) failed++;
		}
		printTotals(write, all.length, seconds, total);
		if (failed > 0) {
			// Go prints the tool calls the whole run made, indented by one space on
			// top of Println's own separator (main.go:320-325).
			write("tool-call log:");
			for (const line of goTrimSpace(lines.join("\n")).split("\n")) {
				if (line.includes("agent tool call")) write(`   ${line}`);
			}
			throw new Error(`${failed} of ${all.length} messages made the wrong change`);
		}
		write(`All ${all.length} messages produced the right change.`);
	} finally {
		await agent.close();
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * cases is Go's cases(): the twelve messages, in order, on the one document
 * (main.go:100-236). Their texts and pass conditions are Go's, case for case.
 */
export function cases(now: Day): EvalCase[] {
	return [
		{
			msg: "We move in on 5 Dec",
			check: (_before, after) => {
				const want = nextDec5(now);
				if (deref(after.meta.moveDate) !== want) {
					return `moveDate = ${deref(after.meta.moveDate)}, want ${want}`;
				}
				return null;
			},
		},
		{
			msg: "Thinking of fluted glass for the dry kitchen sliding door",
			check: (before, after) => {
				const found = added(before, after);
				const e = found[0];
				if (e === undefined || found.length !== 1) return `want one new entry, got ${found.length}`;
				if (e.kind !== "idea" || e.room !== "dry kitchen") {
					return `got kind=${e.kind} room=${deref(e.room)}, want idea / dry kitchen`;
				}
				if (e.date !== null || e.cost.estimate !== null || e.vendor !== "") {
					return `invented a date, cost or vendor: ${entryJson(e)}`;
				}
				return null;
			},
		},
		{
			msg: "Decided: Daikin system 4 aircon, 5.8k from CoolAir",
			check: (before, after) => {
				const found = added(before, after);
				const e = found[0];
				if (e === undefined || found.length !== 1) return `want one new entry, got ${found.length}`;
				if (e.kind !== "decision" && e.status !== "decided") {
					return `got kind=${e.kind} status=${e.status}, want a decision`;
				}
				if (!eq(e.cost.estimate, 5800) && !eq(e.cost.actual, 5800)) {
					return `cost = ${goMarshal(e.cost)}, want 5800`;
				}
				if (!e.vendor.toLowerCase().includes("coolair")) {
					return `vendor = ${goQuote(e.vendor)}, want CoolAir`;
				}
				return null;
			},
		},
		{
			msg: "Electrician coming Friday 2pm to check the DB",
			check: (before, after) => {
				const found = added(before, after);
				const e = found[0];
				if (e === undefined || found.length !== 1) return `want one new entry, got ${found.length}`;
				const [thisFriday, nextFriday] = fridays(now);
				const dated = e.date !== null && (e.date === thisFriday || e.date === nextFriday);
				if (e.kind !== "task" || !dated || e.time !== "14:00") {
					return `got kind=${e.kind} date=${deref(e.date)} time=${deref(e.time)}, want task / ${thisFriday} / 14:00`;
				}
				return null;
			},
		},
		{
			msg: "Lim quoted 18k for carpentry, paid 30% today",
			check: (_before, after) => {
				const found = live(after, "carpent");
				const e = found[0];
				if (e === undefined || found.length !== 1) {
					return `want exactly one live carpentry entry (update, not duplicate), got ${found.length}`;
				}
				if (!eq(e.cost.estimate, 18000) || !eq(e.cost.actual, 5400)) {
					return `carpentry estimate=${deref(e.cost.estimate)} actual=${deref(e.cost.actual)}, want 18000 / 5400`;
				}
				if (!`${e.vendor} ${e.title} ${e.notes}`.toLowerCase().includes("lim")) {
					return "carpentry entry does not mention Lim";
				}
				return null;
			},
		},
		{
			msg: "Put the grey tiles in the bathroom",
			check: (before, after, res) => {
				// Two bathrooms and no tiles on record: it should ask, not guess.
				const bad = unchanged(before, after);
				if (bad !== null) return bad;
				if (!res.reply.includes("?")) return `expected a clarifying question, got ${goQuote(res.reply)}`;
				return null;
			},
		},
		{
			msg: "What did we decide for the kitchen countertop and how much was it?",
			check: (before, after, res) => {
				const bad = unchanged(before, after);
				if (bad !== null) return bad;
				const r = res.reply.toLowerCase().replaceAll(",", "");
				if (!r.includes("sintered") || !(r.includes("4200") || r.includes("4.2k"))) {
					return `reply should name sintered stone and 4,200: ${goQuote(res.reply)}`;
				}
				return null;
			},
		},
		{
			msg: "Drop the post-reno cleaning",
			check: (_before, after) => {
				const e = after.entries.find((entry) => entry.id === SEED_CLEANING);
				if (e === undefined) return "post-reno cleaning was hard-deleted; it should be archived";
				if (!e.archived) return "post-reno cleaning is not archived";
				return null;
			},
		},
		{
			msg: "Undo that",
			check: (_before, after) => {
				const e = after.entries.find((entry) => entry.id === SEED_CLEANING);
				if (e === undefined || e.archived) return "post-reno cleaning should be back (not archived)";
				return null;
			},
		},
		{
			msg: "We collected the keys today, that's a milestone",
			check: (before, after) => {
				const had = milestones(before);
				const nowDone = milestones(after);
				const e = nowDone[nowDone.length - 1];
				if (e === undefined || nowDone.length !== had.length + 1) {
					return `want one new milestone, got ${had.length} → ${nowDone.length}`;
				}
				if (deref(e.completed) !== now.iso) {
					return `milestone ${goQuote(e.title)} done on ${deref(e.completed)}, want ${now.iso}`;
				}
				if (!/key/i.test(e.title)) return `milestone title ${goQuote(e.title)} doesn't mention the keys`;
				return null;
			},
		},
		{
			msg: "What milestones have we hit so far?",
			check: (before, after, res) => {
				const bad = unchanged(before, after);
				if (bad !== null) return bad;
				if (!/key/i.test(res.reply)) return `reply should mention collecting the keys: ${goQuote(res.reply)}`;
				return null;
			},
		},
		{
			msg: "Partner: ok see you at dinner",
			group: true,
			check: (before, after, res) => {
				const bad = unchanged(before, after);
				if (bad !== null) return bad;
				if (!res.silent) return `group chatter should get no reply, got ${goQuote(res.reply)}`;
				return null;
			},
		},
	];
}

/** One case's outcome: what it cost, how long it took, and whether it passed. */
interface CaseOutcome {
	took: number;
	usage: Usage;
	ok: boolean;
}

/**
 * runCase sends one message on its own conversation, prints what happened and
 * checks it (main.go:414-452). Go's `agent.Runner.Run` is `agent.submit` here,
 * and Go's `res.Reply`/`res.Silent` come from reply.ts, the rules the web chat
 * shares.
 */
async function runCase(env: CaseEnv, index: number, tc: EvalCase): Promise<CaseOutcome> {
	const group = tc.group === true;
	const before = (await env.entries.current()).doc;
	const started = performance.now();
	const mark = env.lines.length;
	const result = await env.agent.submit(`eval:${index + 1}`, tc.msg, {
		actor: { by: "chat-eval", channel: group ? "telegram" : "web" },
		group,
	});
	const toolLog = env.lines.slice(mark).join("\n");
	const after = (await env.entries.current()).doc;
	const took = (performance.now() - started) / 1000;
	const usage = result.usage;
	env.write(`${index + 1}. ${goQuote(tc.msg)}  (${took.toFixed(1)}s)`);
	env.write(
		`   usage:   in ${usage.in}, out ${usage.out}, cache read ${usage.cacheRead}, cache write ${usage.cacheWrite}`,
	);
	const reply = channelReply(result, env.model, group);
	if (!reply.outcome.ok) {
		env.write(`   FAIL  agent error: ${reply.outcome.error}`);
		env.write("");
		return { took, usage, ok: false };
	}
	env.write(reply.silent ? "   reply:   (silent)" : `   reply:   ${reply.outcome.result.reply}`);
	for (const line of result.changes) env.write(`   change:  ${line.text}`);
	for (const line of diff(before, after)) env.write(`   diff:    ${line}`);
	const reason = tc.check(before, after, { reply: reply.outcome.result.reply, silent: reply.silent }, toolLog);
	if (reason !== null) {
		env.write(`   FAIL  ${reason}`);
		env.write("");
		return { took, usage, ok: false };
	}
	env.write("   PASS");
	env.write("");
	return { took, usage, ok: true };
}

/**
 * printTotals sums the run (main.go:454-464). Prompt tokens follow Claude's
 * accounting, where cached tokens are reported apart from input (the gateway
 * reports no cache use, so the two agree today).
 */
function printTotals(write: (line: string) => void, n: number, secs: number, u: Usage): void {
	const prompt = u.in + u.cacheRead + u.cacheWrite;
	const hit = prompt > 0 ? (100 * u.cacheRead) / prompt : 0;
	write(
		`totals: ${n} messages, ${secs.toFixed(1)} s (${(secs / Math.max(n, 1)).toFixed(1)} s each), prompt tokens ${prompt} (uncached ${u.in}, cache read ${u.cacheRead} = ${hit.toFixed(0)}%, cache write ${u.cacheWrite}), output ${u.out}`,
	);
}

/** effortOf is Go's effort line without the Claude branch (agent-spec §1.10). */
function effortOf(cfg: LLM): string {
	return cfg.thinkOnDemand ? "thinking off (think only when asked)" : "server default";
}

/**
 * parseFlags reads Go's flags: -saved, -model id, -docs and one positional
 * fixture. `-kind` is gone, so it is an unknown flag (agent-spec §1.10).
 */
function parseFlags(args: readonly string[]): Flags {
	const flags: Flags = { saved: false, model: "", docs: false, fixture: DEFAULT_FIXTURE };
	for (let i = 0; i < args.length; i++) {
		const arg = args[i] ?? "";
		if (arg === "-saved") {
			flags.saved = true;
			continue;
		}
		if (arg === "-docs") {
			flags.docs = true;
			continue;
		}
		if (arg === "-model") {
			const value = args[i + 1];
			if (value === undefined) throw new Error("flag needs an argument: -model");
			flags.model = value;
			i++;
			continue;
		}
		if (arg.startsWith("-model=")) {
			flags.model = arg.slice("-model=".length);
			continue;
		}
		if (arg.startsWith("-") && arg.length > 1) throw new Error(`flag provided but not defined: ${arg}`);
		flags.fixture = arg;
	}
	return flags;
}

/**
 * resolveConnection is Go's connection() (main.go:334-372): the env's LLM_*, or
 * the one saved on the web page (-saved, read only), with `model` overriding the
 * model id for the run. `bucket` is the store it was read from, for -docs.
 */
async function resolveConnection(
	config: Config,
	model: string,
	saved: boolean,
	store: ObjectStore | undefined,
	log: Log,
	now: () => Date,
): Promise<Connection> {
	let cfg: LLM = config.llm;
	let settings: SettingsSource = { resolve: async () => cfg };
	let bucket: ObjectStore | null = null;
	if (saved) {
		bucket =
			store ??
			createS3Store({
				bucket: config.s3Bucket,
				prefix: config.s3Prefix,
				region: config.awsRegion,
				endpointUrl: config.s3EndpointUrl,
			});
		const service = createSettingsService({
			store: bucket,
			log,
			env: config.llm,
			telegramEnv: config.telegram,
			checkinEnv: config.checkin,
			secret: config.settingsSecret,
			now,
		});
		cfg = await service.resolve();
		settings = { resolve: () => service.resolve() };
	}
	if (model !== "") {
		// The run's model, on the banner and on every request the agent makes.
		cfg = { ...cfg, model };
		const inner = settings;
		settings = { resolve: async () => ({ ...(await inner.resolve()), model }) };
	}
	if (cfg.baseUrl === "" || cfg.model === "") {
		throw new Error("set LLM_BASE_URL, LLM_MODEL (and LLM_API_KEY if needed) in .env first, or use -saved");
	}
	return { cfg, settings, bucket };
}

/** bucketOf is the store a -docs run reads; -docs already needs -saved, which builds it. */
function bucketOf(connection: Connection): ObjectStore {
	if (connection.bucket === null) throw new Error("-docs needs -saved (the documents are in the bucket)");
	return connection.bucket;
}

/**
 * openDocs is Go's read-only documents wiring (main.go:396-410): the syncer is
 * only asked for the index and page text, never to sync, so nothing in the
 * bucket changes.
 */
async function openDocs(bucket: ObjectStore, log: Log, now: () => Date): Promise<Docs> {
	const poppler = createPoppler();
	const syncer = createSyncer({ store: bucket, converter: poppler, log, now });
	let index: Index | null = null;
	// Go's `%v` of a nil error is `<nil>`, and that is the text when the index was
	// read but holds no documents.
	let why = "<nil>";
	try {
		index = await syncer.index();
	} catch (err) {
		why = errorMessage(err);
	}
	if (index === null || index.docs.length === 0) {
		throw new Error(`no documents index in the bucket (${why}); run a sync in the app first`);
	}
	return {
		syncer,
		library: createLibrary({ source: syncer, log }),
		viewer: createViewer({ source: syncer, store: bucket, conv: poppler }),
	};
}

/** readFixture is Go's os.ReadFile plus entries.Decode (main.go:379-386). */
async function readFixture(path: string): Promise<Doc> {
	let data: Uint8Array;
	try {
		data = await readFile(path);
	} catch (err) {
		throw new Error(`read ${goQuote(path)}: ${errorMessage(err)}`, { cause: err });
	}
	return decodeDoc(new TextDecoder().decode(data));
}

/** dayIn is Go's `time.Now().In(c.Location)` as the checks read it: the zone's calendar day. */
export function dayIn(at: Date, timeZone: string): Day {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(at);
	const field = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
	const year = field("year");
	const month = field("month");
	const day = field("day");
	// Date.UTC maps years 0-99 to 1900-1999, so the date is set before the weekday is read.
	const calendar = new Date(0);
	calendar.setUTCFullYear(year, month - 1, day);
	const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
	return { iso, weekday: calendar.getUTCDay(), year, month, day };
}

/** goDay is Go's `Format("Mon 2 Jan 2006")`. */
function goDay(d: Day): string {
	return `${WEEKDAYS[d.weekday]} ${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

/**
 * main is Go's main(): the run's exit code, with a failure written as `error: <it>`
 * (Go returns run()'s error and main prints it to stderr).
 */
export async function main(options: EvalOptions): Promise<number> {
	const writeErr = options.writeErr ?? ((line: string): void => void process.stderr.write(`${line}\n`));
	try {
		await run(options);
		return 0;
	} catch (err) {
		writeErr(`error: ${errorMessage(err)}`);
		return 1;
	}
}

// Only as the entry point, as src/main.ts does: a test imports this file for run().
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main({ env: process.env, args: process.argv.slice(2) });
}
