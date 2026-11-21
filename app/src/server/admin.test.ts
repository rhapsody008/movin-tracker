// The HTTP layer's ported Go tests for the admin, settings and documents
// routes: the T2.2 column of server-spec §7 (internal/server/server_test.go,
// docs_test.go and the v2 replacement for claude_settings_test.go).
//
// Like the Go suite, the tests that use both backends run on the memory store
// and on MinIO when S3_ENDPOINT_URL and S3_BUCKET are set (as they are under
// `make -C app test`).
import { randomUUID } from "node:crypto";
import { createServer as createNodeServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { CreateBucketCommand, PutBucketVersioningCommand, S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config.ts";
import { FakeConverter } from "../docs/convert/fake.ts";
import { createSyncer, type Syncer } from "../docs/sync.ts";
import { goTimeJSON } from "../gostr.ts";
import { createTestLog } from "../log.ts";
import { startServe } from "../main.ts";
import { createMemoryStore } from "../objstore/memory.ts";
import { createS3Store } from "../objstore/s3.ts";
import { type ObjectStore, PreconditionError } from "../objstore/store.ts";
import { CLAUDE_MESSAGE, DEFAULTS, type LLM, KEY as SETTINGS_KEY } from "../settings/settings.ts";
import { PROBE_PREFIX } from "./admin.ts";
import {
	type Answer,
	ENV_KEY,
	type FakeLLM,
	headerOf,
	STORED_KEY,
	send,
	startFakeLLM,
	startServer,
	testStaticFiles,
	ZY,
} from "./rig.ts";

/** The guide's bytes for the route's test: the Go test's four headings, and no trailing newline. */
const GUIDE = new TextEncoder().encode(
	"# Admin guide\n\nSet TELEGRAM_BOT_TOKEN and keep it in the NKP namespace.\n\n" +
		"## Secrets in the NKP namespace\n\n## Troubleshooting\n\nAsk in the group. It ends here",
);

const endpointUrl = process.env.S3_ENDPOINT_URL ?? "";
const bucket = process.env.S3_BUCKET ?? "";
const region = process.env.AWS_REGION ?? "ap-southeast-1";

if (process.env.REQUIRE_S3 === "1" && (endpointUrl === "" || bucket === "")) {
	throw new Error(
		"REQUIRE_S3=1 but S3_ENDPOINT_URL and/or S3_BUCKET are empty: the S3 half of the admin suite would be skipped",
	);
}

interface Variant {
	name: string;
	/** A store nothing else in the suite uses. */
	make: () => ObjectStore;
}

const runPrefix = `test-admin-ts-${Date.now()}`;
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
	await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: "Enabled" } }));
	client.destroy();
}

/** Go's setup's env LLM: the fake endpoint, the env key, the env model (server_test.go:107-109). */
function envFor(llm: FakeLLM): LLM {
	return { ...DEFAULTS, baseUrl: `${llm.base}/v1`, apiKey: ENV_KEY, model: "env-model", streaming: false };
}

function obj(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`not a JSON object: ${JSON.stringify(value)}`);
	}
	return value as Record<string, unknown>;
}

function list(value: unknown): unknown[] {
	if (!Array.isArray(value)) throw new Error(`not a JSON array: ${JSON.stringify(value)}`);
	return value;
}

/** The `checkin.setting` part of a telegramView. */
function settingOf(a: Answer): Record<string, unknown> {
	return obj(obj(a.json.checkin).setting);
}

/** Whether the store has no object under key. */
async function isMissing(store: ObjectStore, key: string): Promise<boolean> {
	try {
		await store.stat(key);
	} catch {
		return true;
	}
	return false;
}

/** The whole settings.json, as text. */
async function settingsFile(store: ObjectStore): Promise<string> {
	return new TextDecoder().decode((await store.get(SETTINGS_KEY)).body);
}

describe("the LLM settings drawer", () => {
	for (const variant of variants) {
		it(`never leaks a key into a response or a log line (TestSettingsKeyNeverLeaks, ${variant.name})`, async () => {
			const llm = await startFakeLLM();
			const rig = await startServer({ store: variant.make(), settingsEnv: envFor(llm) });
			try {
				const bodies: string[] = [];
				const save = `{"baseUrl":${JSON.stringify(`${llm.base}/v1`)},"apiKey":"${STORED_KEY}","model":"model-b","streaming":false}`;
				const saved = await rig.do("PUT", "/api/settings/llm", save);
				bodies.push(saved.raw);
				expect([saved.status, saved.json.keySet, saved.json.keyLast4, saved.json.by]).toEqual([200, true, "7f3a", ZY]);
				bodies.push((await rig.do("GET", "/api/settings/llm")).raw);
				bodies.push((await rig.do("POST", "/api/settings/llm/test", save.replace(STORED_KEY, ""))).raw);
				bodies.push((await rig.do("POST", "/api/settings/llm/models", "{}")).raw);

				// The stored key is what the endpoint receives.
				expect(llm.calls[llm.calls.length - 1]?.auth).toBe(`Bearer ${STORED_KEY}`);

				// At rest it is encrypted.
				const file = await settingsFile(rig.store);
				expect([file.includes(STORED_KEY), file.includes("apiKeyEnc")]).toEqual([false, true]);

				for (const [i, body] of bodies.entries()) {
					expect([i, body.includes(STORED_KEY) || body.includes(ENV_KEY)]).toEqual([i, false]);
				}
				const lines = rig.lines.join("\n");
				for (const [i, line] of lines.split("\n").entries()) {
					expect([i, line.includes(STORED_KEY) || line.includes(ENV_KEY)]).toEqual([i, false]);
				}
				// The save is logged, which is what makes the check above meaningful.
				expect(lines).toContain("LLM settings saved");

				// An empty key keeps the stored one; clearKey falls back to the env key.
				await rig.do("PUT", "/api/settings/llm", save.replace(STORED_KEY, ""));
				expect((await rig.do("GET", "/api/settings/llm")).json.keyLast4).toBe("7f3a");
				await rig.do(
					"PUT",
					"/api/settings/llm",
					save.replace(`"apiKey":"${STORED_KEY}"`, `"apiKey":"","clearKey":true`),
				);
				const cleared = (await rig.do("GET", "/api/settings/llm")).json;
				expect([cleared.keyFromEnv, cleared.keyLast4]).toEqual([true, "aaaa"]);
			} finally {
				await llm.close();
				await rig.close();
			}
		}, 60_000);
	}

	it("falls back to the env and refuses three bad inputs (TestSettingsEnvFallbackAndBounds)", async () => {
		const llm = await startFakeLLM();
		const store = createMemoryStore();
		const rig = await startServer({ store, settingsEnv: envFor(llm) });
		try {
			const view = await rig.do("GET", "/api/settings/llm");
			expect([view.status, view.json.model, view.json.keyFromEnv]).toEqual([200, "env-model", true]);

			const base = { baseUrl: `${llm.base}/v1`, model: "m", streaming: true };
			for (const [field, bad] of [
				["baseUrl", "ftp://x"],
				["model", ""],
				["kind", "gpt"],
			] as const) {
				const bad400 = await rig.do("PUT", "/api/settings/llm", JSON.stringify({ ...base, [field]: bad }));
				expect([field, bad400.status]).toEqual([field, 400]);
			}
		} finally {
			await llm.close();
			await rig.close();
		}

		// An unreadable settings.json must not break the app.
		const corrupt = createMemoryStore();
		await corrupt.put(SETTINGS_KEY, new TextEncoder().encode("{not json"), null);
		const rig2 = await startServer({ store: corrupt, settingsEnv: envFor(llm) });
		try {
			const view = await rig2.do("GET", "/api/settings/llm");
			expect([view.status, view.json.model]).toEqual([200, "env-model"]);
		} finally {
			await llm.close();
			await rig2.close();
		}
	});

	it("probes a connection that calls tools, and does not save it (TestSettingsTestEndpoint)", async () => {
		const llm = await startFakeLLM();
		const rig = await startServer({ settingsEnv: envFor(llm) });
		try {
			const input = `{"baseUrl":${JSON.stringify(`${llm.base}/v1`)},"model":"model-a","streaming":true}`;
			const ok = await rig.do("POST", "/api/settings/llm/test", input);
			expect([ok.status, ok.json.ok, ok.json.toolCalls]).toEqual([200, true, true]);
			// The ids come back in byte order, whatever order the endpoint listed them.
			expect(ok.json.models).toEqual(["model-a", "model-b"]);
			expect(ok.json.vision).toBe(true);

			llm.noTools.value = true;
			const noTools = await rig.do("POST", "/api/settings/llm/test", input);
			expect([noTools.json.ok, String(noTools.json.error).includes("tool_calls")]).toEqual([false, true]);

			// Testing does not save.
			expect((await rig.do("GET", "/api/settings/llm")).json.model).toBe("env-model");
		} finally {
			await llm.close();
			await rig.close();
		}
	});

	it("refuses a Claude kind through models, test and save (v2 for TestClaudeKindThroughTheAPI)", async () => {
		const llm = await startFakeLLM();
		const rig = await startServer({ settingsEnv: envFor(llm) });
		try {
			const claudeModels = await rig.do(
				"POST",
				"/api/settings/llm/models",
				`{"kind":"claude","baseUrl":"https://evil.example"}`,
			);
			expect([claudeModels.status, claudeModels.json.error]).toEqual([400, CLAUDE_MESSAGE]);
			const claudeTest = await rig.do("POST", "/api/settings/llm/test", `{"kind":"claude","model":"m"}`);
			expect([claudeTest.status, claudeTest.json.error]).toEqual([400, CLAUDE_MESSAGE]);
			const claudeSave = await rig.do("PUT", "/api/settings/llm", `{"kind":"claude","model":"m"}`);
			expect([claudeSave.status, claudeSave.json.error]).toEqual([400, CLAUDE_MESSAGE]);

			// The request never reached a host it named.
			expect(llm.calls).toHaveLength(0);

			// v2's view has no claudeOrigin anywhere.
			const view = await rig.do("GET", "/api/settings/llm");
			expect(view.raw.includes("claudeOrigin")).toBe(false);
			expect(view.json.kind).toBe("openai");

			// Any other kind gets the one-kind wording.
			for (const [method, path, body] of [
				["POST", "/api/settings/llm/models", `{"kind":"gpt"}`],
				["POST", "/api/settings/llm/test", `{"kind":"gpt","baseUrl":"http://x/v1","model":"m"}`],
				["PUT", "/api/settings/llm", `{"kind":"gpt","baseUrl":"http://x/v1","model":"m"}`],
			] as const) {
				const bad = await rig.do(method, path, body);
				expect([path, bad.status, bad.json.error]).toEqual([path, 400, "kind must be openai"]);
			}
		} finally {
			await llm.close();
			await rig.close();
		}
	});

	it("sends the stored key only to its own origin (TestStoredKeyOnlyGoesToItsOwnEndpoint)", async () => {
		const llm = await startFakeLLM();
		const other = await startFakeLLM();
		const rig = await startServer({ settingsEnv: envFor(llm) });
		try {
			const save = `{"baseUrl":${JSON.stringify(`${llm.base}/v1`)},"apiKey":"${STORED_KEY}","model":"m","streaming":false}`;
			expect((await rig.do("PUT", "/api/settings/llm", save)).status).toBe(200);
			const otherAuths = (): string[] => other.calls.map((c) => c.auth);

			// A model list for another host gets no key.
			const otherModels = await rig.do(
				"POST",
				"/api/settings/llm/models",
				`{"baseUrl":${JSON.stringify(`${other.base}/v1`)}}`,
			);
			expect(otherModels.status).toBe(200);
			// "Test connection" against another host without typing a key: no key either.
			const otherTest = save.replace(STORED_KEY, "").replace(llm.base, other.base);
			await rig.do("POST", "/api/settings/llm/test", otherTest);
			for (const auth of otherAuths()) expect(auth).toBe("");
			expect(otherAuths().length).toBeGreaterThan(0);

			// A key typed for the other host goes to it: that is the point of typing one.
			await rig.do(
				"POST",
				"/api/settings/llm/models",
				`{"baseUrl":${JSON.stringify(`${other.base}/v1`)},"apiKey":"sk-typed-other-1111"}`,
			);
			expect(otherAuths()[otherAuths().length - 1]).toBe("Bearer sk-typed-other-1111");

			// The same host still gets the stored key.
			await rig.do("POST", "/api/settings/llm/models", "{}");
			expect(llm.calls[llm.calls.length - 1]?.auth).toBe(`Bearer ${STORED_KEY}`);

			// A plain link (GET) cannot trigger the model list.
			const before = otherAuths().length;
			const viaGet = await rig.do("GET", `/api/settings/llm/models?baseUrl=${other.base}/v1`);
			expect(viaGet.status).not.toBe(200);
			expect(otherAuths().length).toBe(before);

			// Moving to another host without a key drops the stored key, so it never follows.
			const moved = save.replace(STORED_KEY, "").replace(llm.base, other.base);
			const movedAnswer = await rig.do("PUT", "/api/settings/llm", moved);
			expect([movedAnswer.status, movedAnswer.json.keySet]).toEqual([200, false]);
			const after = otherAuths().length;
			await rig.do("POST", "/api/settings/llm/models", "{}");
			expect(otherAuths().slice(after)).toEqual([""]);
		} finally {
			await llm.close();
			await other.close();
			await rig.close();
		}
	}, 60_000);

	it("answers the models route's own 400s and its 502", async () => {
		const llm = await startFakeLLM();
		const rig = await startServer({ settingsEnv: envFor(llm) });
		try {
			const bad = await rig.do(
				"POST",
				"/api/settings/llm/models",
				`{"baseUrl":${JSON.stringify(`${llm.base}/bad/v1`)}}`,
			);
			expect([bad.status, bad.json.error]).toEqual([502, "endpoint returned 404: Invalid API key"]);

			const empty = await rig.do("POST", "/api/settings/llm/models", `{`);
			expect([empty.status, String(empty.json.error).startsWith("Request body must be JSON: ")]).toEqual([400, true]);
		} finally {
			await llm.close();
			await rig.close();
		}

		// With no endpoint configured at all, the route asks for one.
		const bare = await startServer();
		try {
			const noUrl = await bare.do("POST", "/api/settings/llm/models", "{}");
			expect([noUrl.status, noUrl.json.error]).toEqual([400, "Set an endpoint URL first."]);
		} finally {
			await bare.close();
		}
	});
});

describe("the storage admin", () => {
	for (const variant of variants) {
		it(`shows where the objects live and probes the store (TestStorageAdmin, ${variant.name})`, async () => {
			const rig = await startServer({ store: variant.make() });
			try {
				const view = await rig.do("GET", "/api/admin/storage");
				expect([view.status, view.json.backend]).toEqual([200, variant.name === "s3" ? "s3" : "memory"]);
				if (variant.name === "s3") {
					expect([view.json.bucket === "", view.json.credentialSource]).toEqual([false, "env keys"]);
				}
				const first = obj(view.json.lastWrite);
				expect(first.key).toBe("entries.json");
				// Go writes a time.Time: RFC 3339 with no trailing zeros in the fraction.
				// S3's LastModified is whole seconds, so the exact string is checkable (F9).
				const head = await rig.store.stat("entries.json");
				expect(String(first.at)).toBe(goTimeJSON(head.lastModified));
				if (variant.name === "s3") expect(String(first.at)).toMatch(/T\d\d:\d\d:\d\dZ$/);
				// Key material must never reach the browser.
				for (const name of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) {
					const value = process.env[name] ?? "";
					expect([name, value.length >= 4 && view.raw.includes(value)]).toEqual([name, false]);
				}

				// S3's LastModified has one-second resolution.
				await sleep(1100);
				expect((await rig.do("POST", "/api/entries", `{"title":"after"}`)).status).toBe(201);
				const second = obj((await rig.do("GET", "/api/admin/storage")).json.lastWrite);
				expect(String(second.at) > String(first.at)).toBe(true);

				const probed = await rig.do("POST", "/api/admin/storage/test");
				expect([probed.status, probed.json.ok, list(probed.json.steps).length]).toEqual([200, true, 6]);
				expect(await isMissing(rig.store, String(probed.json.key))).toBe(true);
			} finally {
				await rig.close();
			}
		}, 60_000);
	}

	it("reports a denied delete and still answers 200 (TestStorageProbeReportsDeniedDelete)", async () => {
		const rig = await startServer({ store: denyDelete(createMemoryStore()) });
		try {
			const probed = await rig.do("POST", "/api/admin/storage/test");
			const steps = list(probed.json.steps);
			expect([probed.status, probed.json.ok, steps.length]).toEqual([200, false, 6]);
			for (const [i, step] of steps.entries()) {
				expect([i, obj(step).ok]).toEqual([i, i < 5]);
			}
			const last = obj(steps[5]);
			expect([last.name, String(last.error).includes("AccessDenied")]).toEqual(["delete", true]);
		} finally {
			await rig.close();
		}
	});

	it("catches storage that ignores If-Match, and still cleans up (TestStorageProbeCatchesIgnoredConditions)", async () => {
		const store = staleAccepted(createMemoryStore());
		const rig = await startServer({ store });
		try {
			const probed = await rig.do("POST", "/api/admin/storage/test");
			const steps = list(probed.json.steps).map(obj);
			expect([probed.json.ok, steps[3]?.ok, steps[4]?.skipped, steps[5]?.ok]).toEqual([false, false, true, true]);
			expect(await isMissing(store, String(probed.json.key))).toBe(true);
		} finally {
			await rig.close();
		}
	});

	it("refuses a second probe at once instead of queueing it (TestStorageProbeRefusesASecondRun)", async () => {
		const store = slowProbe(createMemoryStore());
		const rig = await startServer({ store });
		try {
			const first = rig.do("POST", "/api/admin/storage/test");
			await waitFor(() => store.started);
			const second = await rig.do("POST", "/api/admin/storage/test");
			expect([second.status, second.json.error]).toEqual([409, "A storage test is already running."]);
			store.release();
			expect((await first).json.ok).toBe(true);
			// The lock is released, not a one-shot: a third probe runs (F8).
			const third = await rig.do("POST", "/api/admin/storage/test");
			expect([third.status, third.json.ok]).toEqual([200, true]);
		} finally {
			store.release();
			await rig.close();
		}
	});
});

/** denyDelete is IAM without s3:DeleteObject (server_test.go:557-564). */
function denyDelete(inner: ObjectStore): ObjectStore {
	return {
		...inner,
		delete: async () => {
			throw new Error("operation error S3: DeleteObject, StatusCode: 403, AccessDenied");
		},
	};
}

/** staleAccepted accepts a stale ETag on the probe's keys (server_test.go:600-616). */
function staleAccepted(inner: ObjectStore): ObjectStore {
	return {
		...inner,
		put: async (key, body, ifMatch, signal) => {
			if (key.startsWith(PROBE_PREFIX) && ifMatch !== null) {
				let current: string | null = null;
				try {
					current = (await inner.stat(key, signal)).etag;
				} catch {
					current = null;
				}
				return await inner.put(key, body, current, signal);
			}
			return await inner.put(key, body, ifMatch, signal);
		},
	};
}

/** slowProbe holds the first probe's first write open, so a second request meets it. */
function slowProbe(inner: ObjectStore): ObjectStore & { started: boolean; release: () => void } {
	let open: (() => void) | null = null;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	const wrapped = {
		...inner,
		started: false,
		release: (): void => {
			if (open !== null) open();
		},
		put: async (key: string, body: Uint8Array, ifMatch: string | null, signal?: AbortSignal) => {
			if (key.startsWith(PROBE_PREFIX) && !wrapped.started) {
				wrapped.started = true;
				await gate;
			}
			return await inner.put(key, body, ifMatch, signal);
		},
	};
	return wrapped;
}

/** waitFor polls a condition the event loop can change. */
async function waitFor(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 500; i++) {
		if (condition()) return;
		await sleep(5);
	}
	throw new Error("the condition never became true");
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the Telegram admin", () => {
	it("shows the no-bot view, saves the allowlist and restores the env list (TestTelegramAdmin)", async () => {
		const rig = await startServer();
		try {
			const got = await rig.do("GET", "/api/admin/telegram");
			const status = obj(got.json.status);
			const allowlist = obj(got.json.allowlist);
			expect([got.status, status.tokenSet, status.running]).toEqual([200, false, false]);
			expect([allowlist.fromEnv, list(allowlist.users).length]).toEqual([true, 0]);
			expect(list(status.rejected)).toEqual([]);
			const checkin = obj(got.json.checkin);
			expect([checkin.noBot, checkin.setting !== undefined]).toEqual([true, true]);

			// The allowlist is editable even without a token.
			const saved = await rig.do(
				"PUT",
				"/api/settings/telegram",
				`{"users":[{"id":"111","name":"ZY"},{"id":"222","name":"Partner"}],"groups":["-1001"]}`,
			);
			const savedList = obj(saved.json.allowlist);
			expect([saved.status, savedList.fromEnv, list(savedList.users).length, savedList.by]).toEqual([
				200,
				false,
				2,
				ZY,
			]);
			// What the app reads next is the saved list, with no restart.
			const tg = await rig.settings.resolveTelegram();
			expect([tg.users.find((u) => u.id === "222")?.name, tg.groups]).toEqual(["Partner", ["-1001"]]);

			const invalid = await rig.do("PUT", "/api/settings/telegram", `{"users":[{"id":"-5","name":"x"}]}`);
			expect([invalid.status, invalid.raw.includes("positive")]).toEqual([400, true]);

			const useEnv = await rig.do("PUT", "/api/settings/telegram", `{"useEnv":true}`);
			expect([useEnv.status, obj(useEnv.json.allowlist).fromEnv]).toEqual([200, true]);
		} finally {
			await rig.close();
		}
	});

	it("shows the check-in setting with no bot to run it (TestTelegramAdminCheckinStatus)", async () => {
		const rig = await startServer();
		try {
			const got = await rig.do("GET", "/api/admin/telegram");
			const checkin = obj(got.json.checkin);
			// No bot: nothing is on, but the setting is still shown and editable.
			expect([checkin.noBot, checkin.on]).toEqual([true, false]);
			const setting = settingOf(got);
			expect([setting.schedule, setting.fromEnv]).toEqual(["09:30", true]);
		} finally {
			await rig.close();
		}
	});

	it("saves the check-in through the API, and keeps both sections (TestCheckinSettingThroughTheAPI)", async () => {
		const rig = await startServer();
		try {
			const saved = await rig.do("PUT", "/api/settings/checkin", `{"schedule":"8:05","chat":""}`);
			const setting = settingOf(saved);
			expect([saved.status, setting.schedule, setting.fromEnv, setting.by]).toEqual([200, "08:05", false, ZY]);

			for (const bad of [`{"schedule":"21:00"}`, `{"schedule":"9am"}`, `{"schedule":"09:30","chat":"group"}`]) {
				const rejected = await rig.do("PUT", "/api/settings/checkin", bad);
				expect([bad, rejected.status]).toEqual([bad, 400]);
			}

			const useEnv = await rig.do("PUT", "/api/settings/checkin", `{"useEnv":true}`);
			const back = settingOf(useEnv);
			expect([useEnv.status, back.schedule, back.fromEnv]).toEqual([200, "09:30", true]);

			// Saving the check-in keeps the Telegram allowlist, and the other way round.
			await rig.do("PUT", "/api/settings/telegram", `{"users":[{"id":"1","name":"A"}]}`);
			await rig.do("PUT", "/api/settings/checkin", `{"schedule":"off"}`);
			const both = await rig.do("GET", "/api/admin/telegram");
			expect([list(obj(both.json.allowlist).users).length, settingOf(both).schedule]).toEqual([1, "off"]);
		} finally {
			await rig.close();
		}
	});

	it("never shows the bot token, only that one is set (TestTelegramAdminNeverShowsToken)", async () => {
		// TELEGRAM_BOT_TOKEN is in the config, as it would be in a deployment; T2's
		// server has no bot, so Go answers the zero Status and TokenSet is false
		// (bot.go:103-113). The token itself must appear in no body and no log (F21).
		const token = "987654321:AAsecretTokenValueThatMustNotLeak";
		const config = {
			...loadConfig({
				S3_BUCKET: "movin-test",
				TELEGRAM_BOT_TOKEN: token,
				DEV_EMAIL: ZY,
				ALLOWED_EMAILS: ZY,
				MOVIN_DOCS: "off",
			}),
			listenAddr: "127.0.0.1:0",
		};
		const { log, lines } = createTestLog();
		const running = await startServe(config, { store: createMemoryStore(), log, staticFiles: testStaticFiles() });
		try {
			const call = async (method: string, path: string, body?: string): Promise<Answer> =>
				await send(running.port, method, path, body, { "X-Forwarded-Email": ZY });
			const got = await call("GET", "/api/admin/telegram");
			expect([got.status, obj(got.json.status).tokenSet]).toEqual([200, false]);
			const saved = await call("PUT", "/api/settings/telegram", `{"users":[{"id":"1","name":"A"}]}`);
			expect(saved.status).toBe(200);
			for (const [i, body] of [got.raw, saved.raw, lines.join("\n")].entries()) {
				expect([i, body.includes(token) || body.includes("AAsecret")]).toEqual([i, false]);
			}
		} finally {
			await running.stop();
		}
	});
});

describe("the admin guide", () => {
	it("serves the Markdown bytes as they are, behind the sign-in (TestAdminGuide)", async () => {
		// T2.3 ships docs/admin-guide.md inside the app; until then the route's own
		// bytes are what is under test, and the four headings the Go test reads are
		// in the fixture. It has no trailing newline, so a route that added one
		// would show up in the comparison below.
		const guide = GUIDE;
		const rig = await startServer({ guide: async () => guide });
		try {
			const got = await rig.do("GET", "/api/admin/guide");
			expect(got.status).toBe(200);
			expect(headerOf(got.headers, "content-type")).toBe("text/markdown; charset=utf-8");
			expect(headerOf(got.headers, "cache-control")).toBe("no-cache");
			for (const want of [
				"# Admin guide",
				"## Secrets in the NKP namespace",
				"## Troubleshooting",
				"TELEGRAM_BOT_TOKEN",
			]) {
				expect([want, got.raw.includes(want)]).toEqual([want, true]);
			}
			// No byte added, no newline added: the answer is the file.
			expect(got.raw).toBe(new TextDecoder().decode(guide));

			// Behind sign-in like everything else.
			const anon = await rig.do("GET", "/api/admin/guide", undefined, { "X-Forwarded-Email": "" });
			expect(anon.status).toBe(401);
		} finally {
			await rig.close();
		}

		// A build without a guide answers 404.
		const bare = await startServer();
		try {
			const none = await bare.do("GET", "/api/admin/guide");
			expect([none.status, none.json.error]).toEqual([404, "no admin guide in this build"]);
		} finally {
			await bare.close();
		}
	});

	it("answers 500 when the guide cannot be read (TestAdminGuideUnreadable)", async () => {
		const rig = await startServer({
			guide: async () => {
				throw new Error("no such file");
			},
		});
		try {
			const got = await rig.do("GET", "/api/admin/guide");
			expect([got.status, got.json.error]).toEqual([500, "The admin guide could not be read."]);
			expect(rig.lines.join("\n")).toContain("admin guide unreadable");
		} finally {
			await rig.close();
		}
	});
});

describe("the document routes", () => {
	it("answers on false and refuses a sync when the documents are off (TestDocsOff)", async () => {
		const rig = await startServer();
		try {
			const view = await rig.do("GET", "/api/docs");
			expect([view.status, view.json.on, view.json.running]).toEqual([200, false, false]);
			expect(list(view.json.docs)).toEqual([]);
			const sync = await rig.do("POST", "/api/docs/sync");
			expect([sync.status, sync.json.error]).toEqual([404, "Documents are not switched on."]);
		} finally {
			await rig.close();
		}
	});

	it("lists, syncs once for two requests, and pushes a docs event (TestDocsListSyncAndEvent)", async () => {
		const store = createMemoryStore();
		const pad = " words on the page".repeat(10);
		const conv = new FakeConverter();
		conv.pages.set("pdf-1", [{ n: 1, w: 595, h: 842, text: `Manual${pad}` }]);
		conv.delay = 150;
		const syncer = makeSyncer(store, conv);
		const rig = await startServer({ store, docs: syncer });
		const stream = await rig.open("/api/events");
		try {
			await store.putBlob("docs/raw/4.0 Manuals/Fridge.pdf", new TextEncoder().encode("pdf-1"), "application/pdf");
			await store.putBlob(
				"docs/raw/4.0 Manuals/._Fridge.pdf",
				new TextEncoder().encode("x"),
				"application/octet-stream",
			);

			// The 202 comes back before the work starts, and a second request joins it.
			const first = await rig.do("POST", "/api/docs/sync");
			expect([first.status, first.json.started]).toEqual([202, true]);
			await sleep(30);
			const second = await rig.do("POST", "/api/docs/sync");
			expect([second.status, second.json.joined]).toEqual([202, true]);

			const event = await nextDocsEvent(stream);
			expect([event.on, list(event.docs).length, event.running]).toEqual([true, 2, false]);
			// The converter ran once: the second request joined the first run.
			expect(conv.callCount()).toBe(1);

			const listed = await rig.do("GET", "/api/docs");
			expect(listed.status).toBe(200);
			const fridge = list(listed.json.docs)
				.map(obj)
				.find((d) => d.name === "Fridge.pdf");
			expect([fridge?.folder, fridge?.status, fridge?.class]).toEqual(["4.0 Manuals", "ok", "text"]);
			expect(obj(listed.json.lastSync).reason).toBe("web");
		} finally {
			stream.close();
			await rig.close();
		}
	});
});

describe("a settings conflict", () => {
	it("has its own 409 text and no document (TestSettingsConflictHasItsOwnMessage)", async () => {
		const rig = await startServer({ store: alwaysConflictSettings(createMemoryStore()) });
		try {
			const got = await rig.do("PUT", "/api/settings/telegram", `{"users":[{"id":"1","name":"A"}]}`);
			expect(got.status).toBe(409);
			expect(got.raw.includes("settings were changed")).toBe(true);
			// No doc, which is what tells this 409 from the entries one.
			expect(got.json.doc).toBeUndefined();
		} finally {
			await rig.close();
		}
	});
});

/** alwaysConflictSettings loses every settings.json ETag race (server_test.go:860-866). */
function alwaysConflictSettings(inner: ObjectStore): ObjectStore {
	return {
		...inner,
		put: async (key, body, ifMatch, signal) => {
			if (key === SETTINGS_KEY) throw new PreconditionError(key);
			return await inner.put(key, body, ifMatch, signal);
		},
	};
}

/** The syncer the docs route needs, with a fixed clock like the Go test's. */
function makeSyncer(store: ObjectStore, conv: FakeConverter): Syncer {
	return createSyncer({
		store,
		converter: conv,
		log: {
			debug: () => undefined,
			info: () => undefined,
			warn: () => undefined,
			error: () => undefined,
		},
		now: () => new Date("2026-11-12T10:00:00Z"),
	});
}

/** The next `docs` event of a stream, skipping the snapshot and the pings. */
async function nextDocsEvent(stream: { next: () => Promise<string> }): Promise<Record<string, unknown>> {
	for (;;) {
		const chunk = await withTimeout(stream.next(), 5000);
		const at = chunk.indexOf("event: docs\ndata: ");
		if (at < 0) continue;
		const end = chunk.indexOf("\n\n", at);
		return obj(JSON.parse(chunk.slice(at + "event: docs\ndata: ".length, end)));
	}
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return await new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`nothing arrived within ${ms} ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

describe("the key-leak and case-folding contracts", () => {
	it("never prints a body it could not parse, on models or on test (F1)", async () => {
		// V8's JSON.parse quotes its input, so a body that IS the key would print
		// it. The tails are fixed strings, and every src/llm error is scrubbed.
		const key = "sk-live-1234567890abcdef";
		const endpoint = await fixedEndpoint(key);
		const rig = await startServer({
			settingsEnv: { ...DEFAULTS, baseUrl: `${endpoint.base}/v1`, apiKey: key, model: "model-a" },
		});
		try {
			const models = await rig.do("POST", "/api/settings/llm/models", "{}");
			expect([models.status, models.json.error]).toEqual([502, "decode models list: invalid JSON"]);

			const tested = await rig.do(
				"POST",
				"/api/settings/llm/test",
				`{"baseUrl":${JSON.stringify(`${endpoint.base}/v1`)},"model":"model-a"}`,
			);
			expect([tested.status, tested.json.error]).toEqual([200, "decode completion: invalid JSON"]);

			for (const [i, body] of [models.raw, tested.raw, rig.lines.join("\n")].entries()) {
				expect([i, body.includes(key)]).toEqual([i, false]);
			}
		} finally {
			await endpoint.close();
			await rig.close();
		}
	});

	it("leaves models out of the test result when the endpoint lists none (F4)", async () => {
		const endpoint = await fixedEndpoint(
			`{"data":[]}`,
			`{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c"}]}}]}`,
		);
		const rig = await startServer();
		try {
			const tested = await rig.do(
				"POST",
				"/api/settings/llm/test",
				`{"baseUrl":${JSON.stringify(`${endpoint.base}/v1`)},"model":"model-a"}`,
			);
			// Go's omitempty: no `models` key at all, not "models":[].
			expect([tested.status, tested.json.ok, "models" in tested.json]).toEqual([200, true, false]);
		} finally {
			await endpoint.close();
			await rig.close();
		}
	});

	it("stops an endpoint call when the browser goes away (F7)", async () => {
		const endpoint = await hangingEndpoint();
		const rig = await startServer();
		try {
			// /models and /test both hand the request's abort signal to fetch.
			for (const [i, [path, body]] of [
				["/api/settings/llm/models", `{"baseUrl":${JSON.stringify(`${endpoint.base}/v1`)},"apiKey":"sk-typed-1"}`],
				[
					"/api/settings/llm/test",
					`{"baseUrl":${JSON.stringify(`${endpoint.base}/v1`)},"model":"model-a","apiKey":"sk-typed-1"}`,
				],
			].entries()) {
				const req = request({
					host: "127.0.0.1",
					port: rig.port,
					method: "POST",
					path,
					headers: { "X-Forwarded-Email": ZY, "Content-Type": "application/json" },
					agent: false,
				});
				req.on("error", () => undefined);
				req.end(body);
				await waitFor(() => endpoint.hits() > i);
				req.destroy();
				// The endpoint's socket closes within about a second, not after the
				// 15 s timeout: the drawer that went away is not kept waiting.
				await withTimeout(endpoint.closedAt(i + 1), 1500);
			}
		} finally {
			await endpoint.close();
			await rig.close();
		}
	});

	it("matches body keys case-insensitively, the last match winning (F15)", async () => {
		const rig = await startServer();
		try {
			// Go's encoding/json folds a struct's field names; tmp/t2x-golden holds
			// Go's own answers for these bodies.
			const checkin = await rig.do("PUT", "/api/settings/checkin", `{"SCHEDULE":"8:05","CHAT":"","USEENV":false}`);
			expect([checkin.status, settingOf(checkin).schedule]).toEqual([200, "08:05"]);

			const lastWins = await rig.do("PUT", "/api/settings/checkin", `{"schedule":"7:00","SCHEDULE":"8:05"}`);
			expect(settingOf(lastWins).schedule).toBe("08:05");

			const telegram = await rig.do("PUT", "/api/settings/telegram", `{"USERS":[{"ID":"7","NAME":"Ada"}],"GROUPS":[]}`);
			const users = list(obj(telegram.json.allowlist).users).map(obj);
			expect([telegram.status, users.length, users[0]?.id, users[0]?.name]).toEqual([200, 1, "7", "Ada"]);

			// A struct's key folding does not reach the entries routes: Go decodes
			// those into a map, so "Title" is still an unknown field (tmp/t2x-golden).
			const entry = await rig.do("POST", "/api/entries", `{"title":"x","TITLE":"y"}`);
			expect([entry.status, entry.json.error]).toEqual([400, 'unknown field "TITLE"']);
		} finally {
			await rig.close();
		}
	});
});

/** fixedEndpoint answers every request with one body (or one per models/chat). */
async function fixedEndpoint(models: string, chat = models): Promise<{ base: string; close: () => Promise<void> }> {
	return await answerEndpoint((path) => (path.endsWith("/models") ? models : chat));
}

/** answerEndpoint answers every request from one function. */
async function answerEndpoint(answer: (path: string) => string): Promise<{ base: string; close: () => Promise<void> }> {
	const server = createNodeServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const path = (req.url ?? "").split("?")[0] ?? "";
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(answer(path));
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

/** hangingEndpoint never answers; it counts requests and reports each closed socket. */
async function hangingEndpoint(): Promise<{
	base: string;
	hits: () => number;
	closedAt: (n: number) => Promise<void>;
	close: () => Promise<void>;
}> {
	let received = 0;
	let closedCount = 0;
	const waiting: (() => void)[] = [];
	const server = createNodeServer((req, res) => {
		received++;
		req.resume();
		// A hanging answer: the only way this socket closes is the caller aborting.
		res.on("close", () => {
			closedCount++;
			const next = waiting.shift();
			if (next !== undefined) next();
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		base: `http://127.0.0.1:${address.port}`,
		hits: () => received,
		closedAt: (n: number) => {
			if (closedCount >= n) return Promise.resolve();
			return new Promise<void>((resolve) => {
				waiting.push(resolve);
			});
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}
