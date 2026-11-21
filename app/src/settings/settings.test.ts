// The settings service: the port of settings_test.go, kind_test.go and
// checkin_test.go. Every case runs on the memory store and on MinIO twice —
// except the two that need a wrapped store (a forced ETag race and a slow
// read), which is a property of the service's read-modify-write, not of a
// backend, so they run on memory only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ValidationError } from "../errors.ts";
import { goStamp } from "../gostr.ts";
import { createTestLog } from "../log.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import { NotFoundError, type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { chatID, parseCheckin } from "./checkin.ts";
import { ConflictError } from "./errors.ts";
import { decodeFernetKey, fernetEncrypt } from "./fernet.ts";
import {
	CACHE_TTL_MS,
	CLAUDE_MESSAGE,
	createSettingsService,
	DEFAULTS,
	type Input,
	KEY,
	type LLM,
	MAX_RETRIES,
	type SettingsService,
} from "./settings.ts";
import { groupAllowed, parseTelegramEnv, type Telegram, type TelegramUser, userName } from "./telegram.ts";

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the settings suite would be skipped",
	);
}

/** The published Fernet test vector from the fernet README (not a real secret). */
const SECRET = "cw_0x689RpI-jtRR7oE8h_eQsKImvJapLeSbXpwF4e4=";

/** newRig's clock: 2026-11-11T09:00:00Z, as the Go fixture was written at. */
const START = Date.parse("2026-11-11T09:00:00Z");

function fixture(name: string): string {
	return readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8");
}

function envTelegram(): Telegram {
	return parseTelegramEnv("111=ZY, 222=Partner", "-1001234");
}

const runPrefix = `test-settings-ts-${Date.now()}`;

interface Variant {
	name: string;
	/** A store nothing else in the suite uses. */
	make: () => ObjectStore;
}

const variants: Variant[] = [{ name: "memory", make: () => createMemoryStore() }];

if (endpointUrl !== "" && bucket !== "") {
	await createBucket();
	variants.push({
		name: "s3",
		make: () => createS3Store({ bucket, prefix: `${runPrefix}/${randomUUID()}`, region, endpointUrl }),
	});
}

async function createBucket(): Promise<void> {
	const client = new S3Client({ region, endpoint: endpointUrl, forcePathStyle: true });
	try {
		await client.send(new CreateBucketCommand({ Bucket: bucket }));
	} catch (err) {
		const name = typeof err === "object" && err !== null && "name" in err ? err.name : undefined;
		if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists") throw err;
	}
}

interface Rig {
	svc: SettingsService;
	store: ObjectStore;
	logs: string[];
	/** Moves the service's clock, as the Go tests did by changing r.now. */
	advance: (ms: number) => void;
	raw: () => Promise<Record<string, unknown>>;
	exists: () => Promise<boolean>;
}

/** newRig: the env defaults the Go tests use, over a store holding `file`. */
async function newRig(store: ObjectStore, file = ""): Promise<Rig> {
	if (file !== "") await store.put(KEY, new TextEncoder().encode(file), null);
	const clock = { at: START };
	const { log, lines } = createTestLog({ level: "warn" });
	const env: LLM = {
		...DEFAULTS,
		baseUrl: "https://env.example/v1",
		model: "env-model",
		apiKey: "sk-env-0000-aaaa",
	};
	const svc = createSettingsService({
		store,
		log,
		env,
		telegramEnv: envTelegram(),
		checkinEnv: parseCheckin("", ""),
		secret: SECRET,
		now: () => new Date(clock.at),
	});
	return {
		svc,
		store,
		logs: lines,
		advance: (ms) => {
			clock.at += ms;
		},
		raw: async () => {
			const { body } = await store.get(KEY);
			return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
		},
		exists: async () => {
			try {
				await store.get(KEY);
				return true;
			} catch (err) {
				if (err instanceof NotFoundError) return false;
				throw err;
			}
		},
	};
}

async function rigOn(v: Variant, file = ""): Promise<Rig> {
	return await newRig(v.make(), file);
}

const v1File = `{
  "schema": 1,
  "llm": {"baseUrl": "https://llm.example/v1", "model": "qwen", "temperature": 0.1, "maxTokens": 2048, "streaming": false},
  "updated": "2026-10-14T00:00:00Z",
  "by": "zy@example.com"
}`;

const llmIn: Input = {
	vision: false,
	kind: "openai",
	baseUrl: "https://new.example/v1",
	apiKey: "sk-new-secret-7f3a",
	clearKey: false,
	model: "m2",
	streaming: true,
	thinkOnDemand: false,
};

function user(id: string, name: string): TelegramUser {
	return { id, name };
}

for (const v of variants) {
	describe(`settings (${v.name})`, () => {
		// TestV1FileReadsAsBefore
		it("reads a v1 file as before, env key staying on its own host", async () => {
			const r = await rigOn(v, v1File);
			const l = await r.svc.resolve();
			expect([l.baseUrl, l.model, l.streaming, l.apiKey]).toEqual(["https://llm.example/v1", "qwen", false, ""]);
			const view = await r.svc.view();
			expect([view.updated, view.by, view.keySet, view.keyFromEnv]).toEqual([
				"2026-10-14T00:00:00Z",
				"zy@example.com",
				false,
				false,
			]);
			// Pointing back at the env endpoint brings the env key back.
			const r2 = await rigOn(v, v1File.replace("https://llm.example/v1", "https://env.example/v1"));
			expect((await r2.svc.resolve()).apiKey).toBe("sk-env-0000-aaaa");
			const tg = await r.svc.resolveTelegram();
			expect([tg.fromEnv, tg.users.length, tg.users.at(1)?.name]).toEqual([true, 2, "Partner"]);
			expect(groupAllowed(tg, -1001234n)).toBe(true);
		});

		// TestSectionsSurviveEachOthersSaves
		it("keeps every other section through each save", async () => {
			const file = v1File.replace('"by": "zy@example.com"', '"by": "zy@example.com", "stt": {"model": "whisper"}');
			const r = await rigOn(v, file);
			await r.svc.saveTelegram("zy@example.com", { useEnv: false, users: [user("333", "Helper")], groups: ["-1009"] });
			await r.svc.save("partner@example.com", llmIn);
			let raw = await r.raw();
			expect(raw.telegram).toBeDefined();
			expect(raw.stt).toEqual({ model: "whisper" });
			const llm = raw.llm as Record<string, unknown>;
			const enc = llm.apiKeyEnc as string;
			expect(enc === "").toBe(false);
			expect(JSON.stringify(llm).includes("sk-new-secret")).toBe(false);

			// A Telegram save must keep the encrypted key and the rest of llm.
			await r.svc.saveTelegram("zy@example.com", { useEnv: false, users: [user("111", "ZY")], groups: [] });
			raw = await r.raw();
			const llm2 = raw.llm as Record<string, unknown>;
			expect([llm2.apiKeyEnc, llm2.model, raw.stt]).toEqual([enc, "m2", { model: "whisper" }]);
			const l = await r.svc.resolve();
			expect([l.apiKey, l.model]).toEqual(["sk-new-secret-7f3a", "m2"]);
			expect((await r.svc.view()).by).toBe("partner@example.com");
		});

		// TestTelegramSectionReplacesEnvAsAWhole
		it("treats a saved telegram section as the whole allowlist", async () => {
			const r = await rigOn(v);
			const view = await r.svc.saveTelegram("zy", {
				useEnv: false,
				users: [user(" 333 ", "  Helper   Lim ")],
				groups: [],
			});
			expect([
				view.fromEnv,
				view.users.length,
				view.users.at(0)?.id,
				view.users.at(0)?.name,
				view.groups.length,
			]).toEqual([false, 1, "333", "Helper Lim", 0]);
			expect([view.by, view.updated === undefined]).toEqual(["zy", false]);
			const tg = await r.svc.resolveTelegram();
			expect(userName(tg, 111n)).toBeNull();
			expect(groupAllowed(tg, -1001234n)).toBe(false);
			expect(userName(tg, 333n)).toBe("Helper Lim");

			// An empty saved list allows nobody (it does not fall back to env).
			await r.svc.saveTelegram("zy", { useEnv: false, users: [], groups: [] });
			const empty = await r.svc.resolveTelegram();
			expect([empty.users.length, empty.fromEnv]).toEqual([0, false]);
			// useEnv drops the section and env applies again.
			await r.svc.saveTelegram("zy", { useEnv: true, users: [], groups: [] });
			expect((await r.raw()).telegram).toBeUndefined();
			const back = await r.svc.resolveTelegram();
			expect([back.fromEnv, back.users.length]).toEqual([true, 2]);
		});

		// TestTelegramValidation
		it("rejects every bad allowlist without writing anything", async () => {
			const r = await rigOn(v);
			const u = (id: string, name: string): TelegramUser[] => [user(id, name)];
			const cases: Record<string, TelegramUser[]> = {
				"not a number": u("abc", "x"),
				"negative user": u("-5", "x"),
				"empty name": u("5", "  "),
				"name 41": u("5", "n".repeat(41)),
				"duplicate user": [...u("5", "a"), user("5", "b")],
				"duplicate name": [...u("5", "ZY"), user("6", "zy")],
			};
			for (const [name, users] of Object.entries(cases)) {
				await expect(r.svc.saveTelegram("zy", { useEnv: false, users, groups: [] }), name).rejects.toBeInstanceOf(
					ValidationError,
				);
			}
			const groups: Record<string, string[]> = {
				"positive group": ["1001"],
				"group not a number": ["reno"],
				"duplicate group": ["-1", "-1"],
			};
			for (const [name, g] of Object.entries(groups)) {
				await expect(
					r.svc.saveTelegram("zy", { useEnv: false, users: u("5", "a"), groups: g }),
					name,
				).rejects.toBeInstanceOf(ValidationError);
			}
			expect(await r.exists()).toBe(false);
		});

		// TestUnreadableFileFallsBackToEnv
		it("falls back to the env when the file cannot be read", async () => {
			const r = await rigOn(v, "{not json");
			expect((await r.svc.resolve()).model).toBe("env-model");
			const tg = await r.svc.resolveTelegram();
			expect([tg.fromEnv, tg.users.length]).toEqual([true, 2]);
			// A hand-edited invalid telegram section also falls back to env.
			const r2 = await rigOn(v, '{"schema":1,"llm":{},"telegram":{"users":[{"id":"x","name":"?"}],"groups":[]}}');
			const r2tg = await r2.svc.resolveTelegram();
			expect([r2tg.fromEnv, r2tg.users.length]).toEqual([true, 2]);
			// Saving over an unreadable file works and keeps nothing from it.
			await r.svc.saveTelegram("zy", { useEnv: false, users: [user("9", "N")], groups: [] });
			const after = await r.svc.resolveTelegram();
			expect([after.fromEnv, after.users.length]).toEqual([false, 1]);
		});

		// TestCacheAndTTL
		it("shows its own saves at once and another writer's after the TTL", async () => {
			const r = await rigOn(v);
			await r.svc.saveTelegram("zy", { useEnv: false, users: [user("9", "N")], groups: [] });
			expect(userName(await r.svc.resolveTelegram(), 9n)).toBe("N");
			// A write from elsewhere (another replica, a restore) waits for the TTL.
			const { etag } = await r.store.get(KEY);
			const outside = '{"schema":1,"llm":{},"telegram":{"users":[{"id":"8","name":"Outside"}],"groups":[]}}';
			await r.store.put(KEY, new TextEncoder().encode(outside), etag);
			expect(userName(await r.svc.resolveTelegram(), 8n)).toBeNull();
			r.advance(CACHE_TTL_MS + 1000);
			expect(userName(await r.svc.resolveTelegram(), 8n)).toBe("Outside");
		});

		// F2 j: Go's cache test is `now.Sub(at) < ttl`, so at exactly the TTL the
		// cached copy is stale and the file is read again.
		it("reads the file again at exactly the cache TTL", async () => {
			const r = await rigOn(v, '{"schema":1,"llm":{"model":"first"}}');
			expect((await r.svc.resolve()).model).toBe("first");
			const { etag } = await r.store.get(KEY);
			await r.store.put(KEY, new TextEncoder().encode('{"schema":1,"llm":{"model":"second"}}'), etag);
			// One millisecond short of the TTL: still the cached copy.
			r.advance(CACHE_TTL_MS - 1);
			expect((await r.svc.resolve()).model).toBe("first");
			r.advance(1); // exactly the TTL
			expect((await r.svc.resolve()).model).toBe("second");
		});

		// TestNoKindMeansOpenAI
		it("reads a file without a kind as openai", async () => {
			const current =
				'{"schema":1,"llm":{"baseUrl":"http://host.docker.internal:8081/v1","model":"q","streaming":true,"thinkOnDemand":true}}';
			for (const [name, file] of Object.entries({ v1: v1File, current, none: "" })) {
				const r = await rigOn(v, file);
				expect((await r.svc.resolve()).kind, name).toBe("openai");
				expect((await r.svc.view()).kind, name).toBe("openai");
			}
			const r = await rigOn(v, current);
			const l = await r.svc.resolve();
			expect([l.baseUrl, l.thinkOnDemand]).toEqual(["http://host.docker.internal:8081/v1", true]);
		});

		// TestBadKindIsRejected, plus the v2 refusal of claude.
		it("rejects an unknown kind on save and on test", async () => {
			const r = await rigOn(v);
			const bad = { ...llmIn, kind: "gpt" };
			await expect(r.svc.save("zy", bad)).rejects.toBeInstanceOf(ValidationError);
			await expect(r.svc.forTest(bad)).rejects.toBeInstanceOf(ValidationError);
			await expect(r.svc.save("zy", { ...llmIn, kind: "claude" })).rejects.toThrow(CLAUDE_MESSAGE);
		});

		// TestVision, without its Claude half: v2 has no kind that implies vision.
		it("keeps the vision flag the Save check found", async () => {
			const r = await rigOn(v);
			expect((await r.svc.resolve()).vision).toBe(false);
			await r.svc.save("zy", { ...llmIn, vision: true });
			expect((await r.svc.resolve()).vision).toBe(true);
			expect((await r.svc.view()).vision).toBe(true);
		});

		// TestEnvKeyGoesOnlyToItsOrigin, minus its Claude half: with no file the env
		// key is the whole connection, and it must not follow the file to another host.
		it("sends the env key only to the env's own host", async () => {
			const r = await rigOn(v);
			expect(await r.svc.keyFor("https://env.example/v1", "")).toBe("sk-env-0000-aaaa");
			expect(await r.svc.keyFor("https://other.example/v1", "")).toBe("");
			await r.svc.save("zy", { ...llmIn, baseUrl: "https://other.example/v1", apiKey: "" });
			expect((await r.svc.resolve()).apiKey).toBe("");
			const r2 = await rigOn(v);
			await r2.svc.save("zy", { ...llmIn, baseUrl: "https://env.example/v1", apiKey: "" });
			expect(await r2.svc.keyFor("https://env.example/v1", "")).toBe("sk-env-0000-aaaa");
		});

		// TestStoredKeyStaysWithItsHost, rewritten for the one kind v2 has: the Go
		// cases are the claude ones (fixed origin, LLM_CLAUDE_BASE_URL), dropped.
		// The property that survives is the drawer's: a stored key belongs to the
		// URL it was saved with, so pointing at another host does not carry it.
		it("keeps a stored key with the host it was saved for", async () => {
			const r = await rigOn(v);
			await r.svc.save("zy", { ...llmIn, baseUrl: "https://api.anthropic.com/v1/", apiKey: "sk-ant-saved-9999" });
			const moved = await r.svc.forTest({ ...llmIn, baseUrl: "https://other.example/v1", apiKey: "" });
			expect(moved.apiKey).toBe("");
			const same = await r.svc.forTest({ ...llmIn, baseUrl: "https://API.anthropic.com/v1", apiKey: "" });
			expect(same.apiKey).toBe("sk-ant-saved-9999");
			// Saving the moved URL drops the stored key rather than binding it there.
			await r.svc.save("zy", { ...llmIn, baseUrl: "https://other.example/v1", apiKey: "" });
			expect(((await r.raw()).llm as Record<string, unknown>).apiKeyEnc).toBeUndefined();
			expect((await r.svc.resolve()).apiKey).toBe("");
		});

		// TestKeyWithoutURLAndOneWarning
		it("drops a key stored without a URL, warning once", async () => {
			const store = v.make();
			const tok = fernetEncrypt(decodeFernetKey(SECRET), "sk-orphan-1234");
			const file = `{"schema":1,"llm":{"apiKeyEnc":"${tok}","model":"q"}}`;
			await store.put(KEY, new TextEncoder().encode(file), null);
			const { log, lines } = createTestLog({ level: "warn" });
			// Go's settings.Defaults here: no env key and no env URL.
			const svc = createSettingsService({ store, log, env: DEFAULTS, secret: SECRET });
			for (let i = 0; i < 5; i++) expect((await svc.resolve()).apiKey).toBe("");
			expect(lines.filter((l) => l.includes("belongs to another host")).length).toBe(1);
			await svc.save("zy", { ...llmIn, baseUrl: "https://llm.example/v1", model: "m", apiKey: "" });
			const body = new TextDecoder().decode((await store.get(KEY)).body);
			expect(body.includes("apiKeyEnc")).toBe(false);
		});

		// F2 i: a stored key belongs to the URL it was saved with, and a URL
		// without a host (or one that cannot be parsed) is never a match.
		it("does not use a stored key whose saved URL has no host or cannot be parsed", async () => {
			const tok = fernetEncrypt(decodeFernetKey(SECRET), "sk-orphan-5678");
			for (const baseUrl of ["example.com/v1", "https://a b/v1", "https:///v1"]) {
				const store = v.make();
				const file = `{"schema":1,"llm":{"baseUrl":${JSON.stringify(baseUrl)},"apiKeyEnc":"${tok}"}}`;
				await store.put(KEY, new TextEncoder().encode(file), null);
				const { log, lines } = createTestLog({ level: "warn" });
				const svc = createSettingsService({ store, log, env: DEFAULTS, secret: SECRET });
				expect((await svc.resolve()).apiKey, baseUrl).toBe("");
				expect(lines.filter((l) => l.includes("stored API key belongs to another host")).length, baseUrl).toBe(1);
			}
		});

		// TestCheckinSetting
		it("resolves, saves and re-reads the check-in", async () => {
			const r = await rigOn(v);
			const d = await r.svc.resolveCheckin();
			expect([d.on, d.schedule, d.hour, d.minute, d.chat, d.fromEnv]).toEqual([true, "09:30", 9, 30, "", true]);
			r.svc.withCheckinEnv(parseCheckin("off", "-100"));
			const e = await r.svc.resolveCheckin();
			expect([e.on, e.schedule, chatID(e), e.fromEnv]).toEqual([false, "off", -100n, true]);
			const saved = await r.svc.saveCheckin("zy", { schedule: " 7:05 ", chat: "", useEnv: false });
			expect([saved.schedule, saved.fromEnv, saved.by, saved.on, saved.hour, saved.minute]).toEqual([
				"07:05",
				false,
				"zy",
				true,
				7,
				5,
			]);
			// Another service on the same file (the other copy of the app) sees it.
			const other = createSettingsService({ store: r.store, log: createTestLog().log, env: DEFAULTS, secret: SECRET });
			expect((await other.resolveCheckin()).schedule).toBe("07:05");
			for (const bad of [
				{ schedule: "20:00", chat: "", useEnv: false },
				{ schedule: "7", chat: "", useEnv: false },
				{ schedule: "09:30", chat: "x", useEnv: false },
				{ schedule: "09:30", chat: "0", useEnv: false },
			]) {
				await expect(r.svc.saveCheckin("zy", bad)).rejects.toBeInstanceOf(ValidationError);
			}
			const back = await r.svc.saveCheckin("zy", { schedule: "", chat: "", useEnv: true });
			expect([back.schedule, back.fromEnv]).toEqual(["off", true]);
		});

		// TestCheckinUnreadableAndInvalid
		it("reports an unreadable file and warns once about an invalid section", async () => {
			// Unreadable: an error, never the defaults (which would be on, 09:30).
			const broken = createSettingsService({
				store: failingGet(v.make()),
				log: createTestLog().log,
				env: DEFAULTS,
				secret: SECRET,
			});
			await expect(broken.resolveCheckin()).rejects.toThrow("read settings.json: 503 slow down");
			// A hand-edited bad section: the server's setting, warned once.
			const store = v.make();
			const file = '{"schema":1,"checkin":{"schedule":"21:00","chat":"x"}}';
			await store.put(KEY, new TextEncoder().encode(file), null);
			const { log, lines } = createTestLog({ level: "warn" });
			const svc = createSettingsService({
				store,
				log,
				env: DEFAULTS,
				checkinEnv: parseCheckin("08:15", "-100"),
				secret: SECRET,
			});
			for (let i = 0; i < 3; i++) {
				const c = await svc.resolveCheckin();
				expect([c.fromEnv, c.schedule, c.chat]).toEqual([true, "08:15", "-100"]);
			}
			expect(lines.filter((l) => l.includes("checkin section of settings.json is invalid")).length).toBe(1);
		});

		// TestTwoWarningsEachOnce
		it("logs each of two different warnings once", async () => {
			const store = v.make();
			const file =
				'{"schema":1,"checkin":{"schedule":"25:00"},"telegram":{"users":[{"id":"-1","name":"x"}],"groups":[]}}';
			await store.put(KEY, new TextEncoder().encode(file), null);
			const { log, lines } = createTestLog({ level: "warn" });
			const svc = createSettingsService({ store, log, env: DEFAULTS, secret: SECRET });
			for (let i = 0; i < 3; i++) {
				await svc.resolveCheckin();
				await svc.resolveTelegram();
			}
			for (const w of ["checkin section of settings.json is invalid", "telegram section of settings.json is invalid"]) {
				expect(lines.filter((l) => l.includes(w)).length, w).toBe(1);
			}
		});

		// The pure-settings half of server_test.go's TestSettingsKeyNeverLeaks: an
		// empty key keeps the stored one, clearKey drops it and the env key applies.
		it("keeps the stored key on an empty field and falls back on clearKey", async () => {
			const r = await rigOn(v);
			await r.svc.save("zy", { ...llmIn, baseUrl: "https://env.example/v1", apiKey: "sk-saved-9999" });
			expect((await r.svc.forTest({ ...llmIn, baseUrl: "https://env.example/v1", apiKey: "" })).apiKey).toBe(
				"sk-saved-9999",
			);
			expect(
				(await r.svc.forTest({ ...llmIn, baseUrl: "https://env.example/v1", apiKey: "", clearKey: true })).apiKey,
			).toBe("sk-env-0000-aaaa");
			await r.svc.save("zy", { ...llmIn, baseUrl: "https://env.example/v1", apiKey: "", clearKey: true });
			expect(((await r.raw()).llm as Record<string, unknown>).apiKeyEnc).toBeUndefined();
			expect((await r.svc.resolve()).apiKey).toBe("sk-env-0000-aaaa");
		});

		// spec §1.5: writes are indented two spaces with the top-level keys in
		// sorted (byte) order, whatever order the file it read them in had.
		it("writes the top-level keys sorted, keeping a section it does not know", async () => {
			const shuffled = `{"zz":{"a":1},"telegram":{"users":[],"groups":[]},"schema":1,"llm":{"model":"q","baseUrl":"https://llm.example/v1"}}`;
			const r = await rigOn(v, shuffled);
			await r.svc.saveCheckin("zy", { schedule: "off", chat: "", useEnv: false });
			const text = new TextDecoder().decode((await r.store.get(KEY)).body);
			const keys = [...text.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
			expect(keys).toEqual(["checkin", "llm", "schema", "telegram", "zz"]);
			expect(keys).toEqual([...keys].sort());
			expect(text.startsWith('{\n  "checkin": {')).toBe(true);
		});

		// spec §3.5: the last four characters are shown from eight up, never shorter.
		it("shows keyLast4 only for a key of eight characters or more", async () => {
			const r = await rigOn(v);
			await r.svc.save("zy", { ...llmIn, apiKey: "sk-12345" });
			expect((await r.svc.view()).keyLast4).toBe("2345");
			// Seven characters is not enough: no fragment of it may be shown.
			await r.svc.save("zy", { ...llmIn, apiKey: "sk-1234" });
			const short = await r.svc.view();
			expect(short.keySet).toBe(true);
			expect(short.keyLast4).toBeUndefined();
		});

		// v2, spec §11: a v1 file with a Claude connection of another install. Loading
		// it and resolving must not rewrite a byte, and its key must never be decrypted.
		it("leaves the claude fixture byte-identical and never decrypts its key", async () => {
			const file = fixture("settings-go-claude.json");
			const store = v.make();
			await store.put(KEY, new TextEncoder().encode(file), null);
			const before = await store.get(KEY);
			const decrypted: string[] = [];
			const svc = createSettingsService({
				store,
				log: createTestLog({ level: "warn" }).log,
				env: { ...DEFAULTS, baseUrl: "https://env.example/v1", model: "env-model", apiKey: "sk-env-0000-aaaa" },
				secret: SECRET,
				decrypt: (tok) => {
					decrypted.push(tok);
					return null;
				},
			});
			const l = await svc.resolve();
			expect([l.kind, l.baseUrl, l.apiKey, l.model]).toEqual([
				"openai",
				"https://env.example/v1",
				"sk-env-0000-aaaa",
				"env-model",
			]);
			const view = await svc.view();
			// The env key is set; the ignored section's key is not (and is never read).
			expect([view.legacyKind, view.keySet, view.keyFromEnv, view.canStoreKey]).toEqual(["claude", true, true, true]);
			// legacyKind sits right after kind, and the fields are the view's own order.
			expect(Object.keys(view).slice(0, 3)).toEqual(["vision", "kind", "legacyKind"]);
			await svc.resolveTelegram();
			await svc.resolveCheckin();
			await svc.viewCheckin();
			expect(decrypted).toEqual([]);
			const after = await store.get(KEY);
			expect(new TextDecoder().decode(after.body)).toBe(file);
			expect(after.etag).toBe(before.etag);
		});

		// v2: Save always writes kind openai, and the sections it does not own are
		// the Go fixture's, unchanged — telegram, check-in and an unknown section.
		it("writes kind openai and keeps the other sections", async () => {
			const store = v.make();
			await store.put(KEY, new TextEncoder().encode(fixture("settings-go.json")), null);
			const svc = createSettingsService({
				store,
				log: createTestLog({ level: "warn" }).log,
				env: { ...DEFAULTS, baseUrl: "https://env.example/v1", model: "env-model", apiKey: "sk-env-0000-aaaa" },
				secret: SECRET,
				now: () => new Date(START),
			});
			const go = await svc.resolve();
			expect([go.baseUrl, go.model, go.apiKey, go.streaming, go.thinkOnDemand, go.vision]).toEqual([
				"https://llm.example/v1",
				"m2",
				"sk-test-go-written-7f3a",
				true,
				true,
				true,
			]);
			const old = JSON.parse(new TextDecoder().decode((await store.get(KEY)).body)) as Record<string, unknown>;
			await svc.save("zy@example.com", { ...llmIn, baseUrl: "https://llm.example/v2", apiKey: "sk-fresh-9999" });
			const doc = (await store.get(KEY).then((g) => JSON.parse(new TextDecoder().decode(g.body)))) as Record<
				string,
				unknown
			>;
			const llm = doc.llm as Record<string, unknown>;
			expect([llm.kind, llm.baseUrl, llm.model]).toEqual(["openai", "https://llm.example/v2", "m2"]);
			expect(String(llm.apiKeyEnc).startsWith("gAAAAA")).toBe(true);
			expect(doc.telegram).toEqual(old.telegram);
			expect(doc.checkin).toEqual(old.checkin);
			expect(doc.stt).toEqual({ model: "whisper", notes: ["a < b", "c & d"] });
			expect([doc.schema, doc.updated, doc.by]).toEqual([1, goStamp(new Date(START)), "zy@example.com"]);
			expect((await svc.resolve()).apiKey).toBe("sk-fresh-9999");
		});
	});
}

// T1 F1: the bytes of settings.json, against the Go writer. Both files in
// testdata are Go's own output (tmp/t14-golden/main.go savebytes): the same
// fixture, the same two saves, the same fixed clock. Neither save touches llm,
// so no apiKeyEnc is involved — the fixture has none, and its llm, checkin and
// unknown "zeta" sections must survive byte for byte, number literals and all.
describe("settings.json bytes (Go writer)", () => {
	it("writes the same bytes as Go after a telegram save and a check-in save", async () => {
		const mem = createMemoryStore();
		await mem.put(KEY, readFileSync(new URL("./testdata/save-fixture.json", import.meta.url)), null);
		const svc = createSettingsService({
			store: mem,
			log: createTestLog({ level: "warn" }).log,
			env: DEFAULTS,
			secret: SECRET,
			now: () => new Date(START),
		});
		const written = async (): Promise<string> => new TextDecoder().decode((await mem.get(KEY)).body);

		await svc.saveTelegram("zy@example.com", {
			useEnv: false,
			users: [user("333", " Helper  Lim ")],
			groups: ["-1009"],
		});
		expect(await written()).toBe(fixture("save-telegram.go.json"));

		// An empty chat is omitted (Go's omitempty on storedCheckin.Chat).
		await svc.saveCheckin("zy@example.com", { schedule: "7:05", chat: "", useEnv: false });
		const after = await written();
		expect(after).toBe(fixture("save-checkin.go.json"));
		expect(after.includes('"chat"')).toBe(false);
	});

	// B1 (N5): an empty settings.json is readable, not unreadable — the save
	// must not log the replace warning for a body of "{}".
	it("reads an empty {} file without calling it unreadable", async () => {
		const mem = createMemoryStore();
		await mem.put(KEY, new TextEncoder().encode("{}"), null);
		const { log, lines } = createTestLog({ level: "warn" });
		const svc = createSettingsService({
			store: mem,
			log,
			env: DEFAULTS,
			secret: SECRET,
			now: () => new Date(START),
		});
		await svc.saveTelegram("zy@example.com", { useEnv: false, users: [user("333", "Helper")], groups: [] });
		expect(lines.filter((l) => l.includes("replacing unreadable settings.json"))).toEqual([]);
		const text = new TextDecoder().decode((await mem.get(KEY)).body);
		expect(text.startsWith('{\n  "schema": 1,\n  "telegram": {')).toBe(true);
	});

	// A1 part two: the same scanner behind a real save. A file it refuses is
	// replaced with one warning; a file it reads keeps its other sections
	// byte for byte, number literals included.
	it("replaces a file the scanner refuses, and keeps the sections of one it reads", async () => {
		const broken = createMemoryStore();
		await broken.put(KEY, new TextEncoder().encode('{"stt":{"model":"whisper"},}'), null);
		const { log, lines } = createTestLog({ level: "warn" });
		const svc = createSettingsService({
			store: broken,
			log,
			env: DEFAULTS,
			secret: SECRET,
			now: () => new Date(START),
		});
		await svc.saveTelegram("zy@example.com", { useEnv: false, users: [user("333", "Helper")], groups: [] });
		const replaced = new TextDecoder().decode((await broken.get(KEY)).body);
		expect(replaced.includes("stt")).toBe(false);
		expect(replaced.startsWith('{\n  "schema": 1,\n  "telegram": {')).toBe(true);
		expect(lines.filter((l) => l.includes("replacing unreadable settings.json")).length).toBe(1);

		const good = createMemoryStore();
		const file = '{"stt":{"model":"whisper","n":12345678901234567890,"f":1.50}}';
		await good.put(KEY, new TextEncoder().encode(file), null);
		const svc2 = createSettingsService({
			store: good,
			log: createTestLog({ level: "warn" }).log,
			env: DEFAULTS,
			secret: SECRET,
			now: () => new Date(START),
		});
		await svc2.saveTelegram("zy@example.com", { useEnv: false, users: [user("333", "Helper")], groups: [] });
		const kept = new TextDecoder().decode((await good.get(KEY)).body);
		// Top level in byte order, the unknown section's own bytes inside.
		expect(kept.startsWith('{\n  "schema": 1,\n  "stt": {\n    "model": "whisper",\n')).toBe(true);
		expect(kept.includes('"n": 12345678901234567890')).toBe(true);
		expect(kept.includes('"f": 1.50')).toBe(true);
		expect(kept.includes('"telegram": {')).toBe(true);
	});
});

// failingGet is a store whose reads fail (an S3 blip).
function failingGet(inner: ObjectStore): ObjectStore {
	return {
		get: async () => {
			throw new Error("503 slow down");
		},
		put: inner.put.bind(inner),
		stat: inner.stat.bind(inner),
		delete: inner.delete.bind(inner),
		list: inner.list.bind(inner),
		putBlob: inner.putBlob.bind(inner),
		info: inner.info.bind(inner),
	};
}

// TestParseTelegramEnv
describe("parseTelegramEnv", () => {
	it("parses the env allowlist, naming a bare ID after itself", () => {
		const tg = parseTelegramEnv("111=ZY,222, 333=Lim Ah Kow ", "-100123, -456");
		expect([tg.users.length, tg.users.at(1)?.name, tg.users.at(2)?.name, tg.groups.length, tg.fromEnv]).toEqual([
			3,
			"222",
			"Lim Ah Kow",
			2,
			true,
		]);
		const empty = parseTelegramEnv("", "");
		expect(empty.users.length).toBe(0);
		expect(() => parseTelegramEnv("zy=ZY", "")).toThrow("TELEGRAM_ALLOWED_IDS / TELEGRAM_ALLOWED_CHATS: ");
	});
});

// TestTelegramSaveRetriesOnConflictAndKeepsTheOtherWrite: a store wrapper, so it
// runs on memory only (the retry is the service's, not a backend's).
describe("settings conflict retry", () => {
	it("retries the whole read-modify-write and keeps the other write", async () => {
		const mem = createMemoryStore();
		await mem.put(KEY, new TextEncoder().encode(v1File), null);
		// The first conditional write loses: someone else saves the llm section in between.
		let lost = false;
		const racing: ObjectStore = {
			...failingGet(mem),
			get: mem.get.bind(mem),
			put: async (k, b, m, sig) => {
				if (!lost && m !== null) {
					lost = true;
					await mem.put(k, new TextEncoder().encode('{"schema":1,"llm":{"model":"raced"}}'), m);
					throw new PreconditionError(k);
				}
				return await mem.put(k, b, m, sig);
			},
		};
		const svc = createSettingsService({ store: racing, log: createTestLog().log, env: DEFAULTS, secret: "" });
		await svc.saveTelegram("zy", { useEnv: false, users: [user("1", "A")], groups: [] });
		const body = new TextDecoder().decode((await mem.get(KEY)).body);
		expect(body.includes('"raced"')).toBe(true);
		expect(body.includes('"telegram"')).toBe(true);
	});

	it("gives up with ConflictError after MAX_RETRIES lost races", async () => {
		const mem = createMemoryStore();
		await mem.put(KEY, new TextEncoder().encode(v1File), null);
		let attempts = 0;
		const always: ObjectStore = {
			...failingGet(mem),
			get: mem.get.bind(mem),
			put: async () => {
				attempts++;
				throw new PreconditionError(KEY);
			},
		};
		const svc = createSettingsService({ store: always, log: createTestLog().log, env: DEFAULTS, secret: "" });
		await expect(svc.saveTelegram("zy", { useEnv: false, users: [user("1", "A")], groups: [] })).rejects.toBeInstanceOf(
			ConflictError,
		);
		expect(attempts).toBe(MAX_RETRIES + 1);
	});
});

// TestSlowReadDoesNotCacheOverASave: a read that started before a save and
// finished after it must not put the older settings back in the cache (a
// removed Telegram user would keep access for the TTL).
describe("settings slow read", () => {
	it("does not cache a read that finished after a save", async () => {
		const mem = createMemoryStore();
		const old = '{"schema":1,"llm":{},"telegram":{"users":[{"id":"1","name":"Old"}],"groups":[]}}';
		await mem.put(KEY, new TextEncoder().encode(old), null);
		let firstStarted: () => void = () => {};
		const started = new Promise<void>((r) => {
			firstStarted = r;
		});
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let first = true;
		const slow: ObjectStore = {
			...failingGet(mem),
			get: async (k, sig) => {
				const got = await mem.get(k, sig);
				if (first) {
					first = false;
					firstStarted();
					await gate;
				}
				return got;
			},
			put: mem.put.bind(mem),
		};
		const svc = createSettingsService({ store: slow, log: createTestLog().log, env: DEFAULTS, secret: "" });
		const read = svc.resolveTelegram();
		await started;
		await svc.saveTelegram("zy", { useEnv: false, users: [user("2", "New")], groups: [] });
		release();
		await read;
		const tg = await svc.resolveTelegram();
		expect(userName(tg, 1n)).toBeNull();
		expect(userName(tg, 2n)).toBe("New");
	});
});
