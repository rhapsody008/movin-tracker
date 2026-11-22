// Test fixture for the T5.1b schedule crash cases in crash.test.ts: one process
// that runs a scheduled task which either sleeps towards a target or hangs
// inside its own `run`, so the test can SIGKILL it and then reopen the same
// database in the test's own process.
//
//   node src/durable/crash-schedule-child.ts <dbPath> <marker> <sleep|hang> <target>
//
// `<sleep>`: `run` appends the target it was called with to the marker and
// answers `<target>`, so the task sleeps towards it (the target is under the
// fifteen-minute cap, so the sleep is the whole distance). Once the scheduler
// shows the task sleeping at that target, the child appends `slept <target>`: the
// kill may not land between the run's marker line and the sleep's own commit, or
// the reopen would run the phase again with `target: null`.
// `<hang>`: `run` appends and then hangs, so the kill lands inside the phase,
// after the task was reserved for this invocation.
//
// It imports the adapter and nothing of pi-durable, so the rule that only
// src/durable/adapter.ts may import pi-durable still holds.

import { appendFileSync } from "node:fs";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createLog } from "../log.ts";
import { inspectSchedules, openAgent } from "./adapter.ts";

const dbPath = process.argv[2] ?? "";
const marker = process.argv[3] ?? "";
const mode = process.argv[4] === "hang" ? "hang" : "sleep";
const target = Number(process.argv[5] ?? "0");

/** hang is a promise that never settles: the process is killed while awaiting it. */
function hang(): Promise<void> {
	return new Promise(() => undefined);
}

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
	schedules: [
		{
			name: "checkin",
			run: async (ctx) => {
				appendFileSync(marker, `${ctx.target === null ? "null" : String(ctx.target)}\n`);
				// The hang is the kill's window: the line after it never runs.
				if (mode === "hang") await hang();
				return target;
			},
		},
	],
	models: () => ({ models, modelRef: { provider: model.provider, modelId: model.id } }),
});

// The spawned task runs in the background: keep the process up for the kill.
setInterval(() => undefined, 60_000);

// The kill's window: only once the task is really asleep at the target is a kill
// there a kill between the two commits rather than one inside the phase.
if (mode === "sleep") {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const [only] = await inspectSchedules(agent);
		if (only?.state === "sleeping" && only.target === target) break;
		if (Date.now() > deadline) {
			// Never fall through to `slept`: that would bring the old race back as a
			// pass. The test fails on this line instead.
			appendFileSync(marker, "timeout\n");
			process.exit(1);
		}
		await new Promise((done) => setTimeout(done, 25));
	}
	appendFileSync(marker, `slept ${String(target)}\n`);
}

await hang();
void agent;
