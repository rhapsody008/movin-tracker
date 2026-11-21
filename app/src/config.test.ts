// loadConfig: the port of config_test.go, plus the v2 refusal and the TZ check.
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

function env(extra: Record<string, string> = {}): Record<string, string | undefined> {
	return { S3_BUCKET: "bucket", ...extra };
}

/** loadConfig with the defaults the Go tests assume, returning the check-in. */
function checkin(extra: Record<string, string>) {
	return loadConfig(env(extra)).checkin;
}

describe("loadConfig", () => {
	it("fills in every default", () => {
		const c = loadConfig({ S3_BUCKET: "bucket" });
		expect(c.listenAddr).toBe("127.0.0.1:8080");
		expect(c.awsRegion).toBe("ap-southeast-1");
		expect(c.s3Bucket).toBe("bucket");
		expect(c.authHeader).toBe("X-Forwarded-Email");
		expect(c.pollEveryMs).toBe(5000);
		expect(c.logLevel).toBe("info");
		expect(c.timeZone).toBe("Asia/Singapore");
		expect(c.docsSync).toBe("03:00");
		expect(c.checkin.schedule).toBe("09:30");
		expect(c.checkin.chat).toBe("");
		expect(c.llm.kind).toBe("openai");
		expect(c.llm.timeoutSec).toBe(600);
		expect(c.llm.maxToolRounds).toBe(5);
		expect(c.llm.streaming).toBe(true);
		expect(c.allowedEmails).toEqual([]);
	});

	it("is frozen, so no caller can drift the config", () => {
		const c = loadConfig(env());
		expect(Object.isFrozen(c)).toBe(true);
		expect(Object.isFrozen(c.llm)).toBe(true);
		expect(Object.isFrozen(c.checkin)).toBe(true);
	});

	// TestCheckinConfig: "off" turns it off, and the chat is kept for a later switch on.
	it("turns the check-in off and keeps the chat", () => {
		const c = checkin({ CHECKIN_SCHEDULE: "off", CHECKIN_CHAT: "-100123" });
		expect(c.schedule).toBe("off");
		expect(c.chat).toBe("-100123");
	});

	it("accepts neither, giving the 09:30 default and no chat", () => {
		const c = checkin({ CHECKIN_SCHEDULE: "", CHECKIN_CHAT: "" });
		expect(c.schedule).toBe("09:30");
		expect(c.chat).toBe("");
	});

	// TestCheckinConfigValidate: each half is checked on its own, with its var named.
	it("names the variable a bad schedule came from", () => {
		expect(() => loadConfig(env({ CHECKIN_SCHEDULE: "9am" }))).toThrow(
			'CHECKIN_SCHEDULE: the check-in time must be HH:MM (24 h) or off, not "9am"',
		);
	});

	it("names the variable a bad chat came from", () => {
		expect(() => loadConfig(env({ CHECKIN_SCHEDULE: "off", CHECKIN_CHAT: "the group" }))).toThrow(
			'CHECKIN_CHAT: the check-in chat must be a Telegram chat ID (a number), not "the group"',
		);
	});

	it("refuses a check-in that would be skipped at the 20:00 cutoff", () => {
		expect(() => loadConfig(env({ CHECKIN_SCHEDULE: "20:00" }))).toThrow(
			"CHECKIN_SCHEDULE: the check-in time must be before 20:00 (later ones are skipped)",
		);
	});

	it("accepts 19:59", () => {
		expect(checkin({ CHECKIN_SCHEDULE: "19:59" }).schedule).toBe("19:59");
	});

	// v2: the Claude path is gone, so a config asking for it refuses to start.
	it("refuses LLM_KIND=claude with the v2 message", () => {
		expect(() => loadConfig(env({ LLM_KIND: "claude" }))).toThrow(
			"LLM_KIND=claude is no longer supported (v2): use an OpenAI-compatible endpoint",
		);
	});

	it("refuses any other kind", () => {
		expect(() => loadConfig(env({ LLM_KIND: "anthropic" }))).toThrow('LLM_KIND must be "openai"');
	});

	it("takes LLM_KIND=openai and the empty default", () => {
		expect(loadConfig(env({ LLM_KIND: "openai" })).llm.kind).toBe("openai");
		expect(loadConfig(env({ LLM_KIND: "" })).llm.kind).toBe("openai");
	});

	it("refuses a time zone Intl does not know", () => {
		expect(() => loadConfig(env({ TZ: "Mars/Olympus" }))).toThrow('TZ: unknown time zone "Mars/Olympus"');
	});

	it("accepts a real time zone", () => {
		expect(loadConfig(env({ TZ: "Europe/Berlin" })).timeZone).toBe("Europe/Berlin");
	});

	it("requires S3_BUCKET", () => {
		expect(() => loadConfig({})).toThrow("S3_BUCKET is required");
	});

	it("parses booleans the way strconv.ParseBool does", () => {
		expect(loadConfig(env({ LLM_STREAMING: "0" })).llm.streaming).toBe(false);
		expect(loadConfig(env({ LLM_STREAMING: "TRUE" })).llm.streaming).toBe(true);
		expect(() => loadConfig(env({ LLM_STREAMING: "yes" }))).toThrow(
			'LLM_STREAMING: strconv.ParseBool: parsing "yes": invalid syntax',
		);
	});

	it("lowercases and splits ALLOWED_EMAILS", () => {
		expect(loadConfig(env({ ALLOWED_EMAILS: " ZY@x.com, partner@Y.com ,," })).allowedEmails).toEqual([
			"zy@x.com",
			"partner@y.com",
		]);
	});
});

describe("MOVIN_DOCS and GUIDE_FILE (F13)", () => {
	it("defaults to the documents on and the repo's admin guide", () => {
		const c = loadConfig(env());
		expect(c.docsOff).toBe(false);
		expect(c.guideFile.endsWith("/docs/admin-guide.md")).toBe(true);
	});

	it("reads MOVIN_DOCS as on or off", () => {
		expect(loadConfig(env({ MOVIN_DOCS: "off" })).docsOff).toBe(true);
		expect(loadConfig(env({ MOVIN_DOCS: "on" })).docsOff).toBe(false);
		// Blank is unset, as every other env() read treats it.
		expect(loadConfig(env({ MOVIN_DOCS: "  " })).docsOff).toBe(false);
	});

	it("refuses any other MOVIN_DOCS value", () => {
		expect(() => loadConfig(env({ MOVIN_DOCS: "maybe" }))).toThrow('MOVIN_DOCS must be "on" or "off"');
	});

	it("lets GUIDE_FILE move the admin guide", () => {
		expect(loadConfig(env({ GUIDE_FILE: "/tmp/guide.md" })).guideFile).toBe("/tmp/guide.md");
	});
});
