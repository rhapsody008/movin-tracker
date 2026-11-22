// Test fixture for the T4.3b delivery crash cases in crash.test.ts: one process
// that queues a reply and hangs inside its outbox's send, so the test can
// SIGKILL it in the middle of a delivery and then reopen the same database.
//
//   MOVIN_CRASH_DB=<dbPath> MOVIN_CRASH_MARKER=<file> MOVIN_CRASH_URL=<recorder>
//   MOVIN_CRASH_PARTS=a,b,c MOVIN_CRASH_MODE=before|after
//   node src/durable/crash-outbox-child.ts
//
// `before`: every send appends its part to the marker and then hangs *before*
// reaching the recorder, so nothing was sent when the process dies.
// `after`: every send POSTs its part to the recorder and returns, except the
// second, which hangs *after* the POST: that part reached the channel and the
// commit that would move past it never happened.
//
// It imports the adapter and nothing of pi-durable, so the rule that only
// src/durable/adapter.ts may import pi-durable still holds.

import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createLog } from "../log.ts";
import { openAgent } from "./adapter.ts";

const dbPath = process.env.MOVIN_CRASH_DB ?? "";
const marker = process.env.MOVIN_CRASH_MARKER ?? "";
const url = process.env.MOVIN_CRASH_URL ?? "";
const parts = (process.env.MOVIN_CRASH_PARTS ?? "").split(",");
const mode = process.env.MOVIN_CRASH_MODE === "after" ? "after" : "before";

/** hang is a promise that never settles: the process is killed while awaiting it. */
function hang(): Promise<void> {
	return new Promise(() => undefined);
}

/**
 * stay keeps this process alive for the kill. A phase that hangs in its send arms
 * no referenced timer, and the harness's own are background, so without this the
 * event loop would empty and Node would exit on its own instead of being killed.
 */
function stay(): void {
	setInterval(() => undefined, 60_000);
}

/** sends counts the calls, so `after` knows which part to stop on. */
let sends = 0;

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

const agent = await openAgent({
	dbPath,
	settings: {
		resolve: async () => ({
			kind: "openai",
			vision: false,
			baseUrl: "http://faux.test/v1",
			apiKey: "",
			model: "faux-1",
			timeoutSec: 60,
			maxToolRounds: 3,
			streaming: true,
			thinkOnDemand: false,
		}),
	},
	log: createLog({ level: "error", write: () => undefined }),
	outbox: {
		send: async (_address, part) => {
			sends += 1;
			appendFileSync(marker, `${String(part)}\n`);
			if (mode === "before") return await hang();
			await fetch(url, { method: "POST", body: JSON.stringify(part) });
			if (sends === 2) return await hang();
		},
	},
	models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
});

await agent.deliver("tg:4242", { chat: 4242, group: false }, parts);
// The delivery task runs in the background: keep the process up for the kill.
stay();
await hang();
