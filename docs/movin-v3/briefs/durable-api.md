# pi-durable 1.5.2: facts for the durable adapter

Verified 2026-11-21 by reading the package, not by running it. Sources: `app/node_modules/@earendil-works/pi-durable/README.md` (cited as `R:NNN`), `app/node_modules/@earendil-works/pi-durable/dist/**` (cited as `D/…`), and pi-ai 1.5.2 next door (cited as `A/…`). Line numbers are 1-based, in the file named.

Path shorthand:

| Shorthand | Real path |
|---|---|
| `R` | `app/node_modules/@earendil-works/pi-durable/README.md` |
| `D/` | `app/node_modules/@earendil-works/pi-durable/dist/` |
| `A/` | `app/node_modules/@earendil-works/pi-ai/dist/` |
| `C/` | `app/node_modules/@earendil-works/chord/dist/` |

Everything below was confirmed in the `.d.ts`; where the types were silent or ambiguous I read the emitted `.js` and say so.

---

## 1. Opening and resuming

**Open.** `Harness.open(storage, options, context): Promise<Harness>` — `D/harness/harness.d.ts:20`. `context` is a Chord `Context`; `BACKGROUND_CONTEXT` never cancels (`C/context/index.d.ts`), `withCancel(context)` / `withAbortSignal(signal, context)` from `@earendil-works/chord/context` give real cancellation.

**Storage.** `openNodeSqliteStorage(path, options?): Promise<SqliteStorage>` — `D/storage/sqlite/node.d.ts:7`. Options are `NodeSqliteDatabaseOptions` (`mode: "read-write"|"read-only"`, `walAutoCheckpointPages`, `busyTimeoutMs`) plus `SqliteStorageOptions` (`prefix`) — `D/storage/sqlite/node.d.ts:5`, `C/sqlite/node.d.ts:5-15`. It is Node's built-in `node:sqlite` (`C/sqlite/node.js:3`), so no driver package; WAL + `synchronous=NORMAL`, one process per database, no cross-process locking (`R:866`, `R:894`). `MemoryStorage` is the in-memory backend (`D/index.d.ts`).

**HarnessOptions** — `D/harness/types.d.ts:626-694`:

| Field | Line | Note |
|---|---|---|
| `models: Models \| (() => Models)` | 638 | **function is called at each use** (`D/harness/harness.js:89-95`) |
| `registry: RegistryReader` | 646 | `createRegistry()` (`D/index.d.ts`) |
| `settings?: HarnessSettings \| (() => …)` | 648 | read at each use, never copied; getters fine |
| `identity?: ClientIdentity` | 645 | merged over `DEFAULT_HARNESS_IDENTITY` |
| `env?` | 650 | not needed (no file tools) |
| `conversationCreated?` | 656 | runs in *every* commit that creates or forks |
| `now?: () => number` | 661 | the harness clock (injected clock) |
| `setTimer?` | 669 | timers, incl. progress flushes |
| `onWake?` | 679 | only for evictable hosts; not needed in a pod |
| `onReport?` | 686 | failures that do not fail the call |
| `telemetry?` | 633 | optional |
| `readOnly?: boolean` | 694 | viewer mode |

**What open does.** It reconciles surviving `running` tasks to `pending` and increments `restarts` — `D/harness/scheduler.js:243-247`; `abandonOnRestart` tasks are marked abandoned in the same commit. Nothing else runs until `resume()` or a call that asks for progress.

**`harness.resume(): void`** — `D/harness/types.d.ts:835`. Synchronous, idempotent, throws after close, throws `ReadOnlySession` on a read-only harness. `submit`, `compact`, `abort`, `Submission.wait`, `waitForTask`, both `waitForIdle`s also start scheduling (`D/harness/types.d.ts:824-834`). **This matters for the restore path** — see §8.

**`waitForIdle`** — `harness.waitForIdle(ctx)` `D/harness/types.d.ts:865`; `conversation.waitForIdle(ctx)` `:818` ("its ordinary ownership scope has no live non-background task"). A run that answered and is running `afterRun` tasks is still busy (`R:682-715`).

**Close and the `failed` state.** `harness.close(ctx)` `D/types.d.ts:1054` (seal admission, settle committed writes, close storage); `harness.closed: Promise<SessionEnd>` `D/types.d.ts:1059` where `SessionEnd = {kind:"closed"} | {kind:"failed"; error}` `D/types.d.ts:1017-1022`. A storage error ends the harness by itself: the offending call rejects, every pending wait rejects with `SessionFailed` (`D/errors.d.ts:28-30`), watches end `failed`, `onReport` gets one `storage_failed` (`D/types.d.ts:129-175`). Restart-on-failure pattern at `R:931-937`. Closing waits for running task code, so code that ignores its abort signal delays `closed` (`R:923-939`).

```ts
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const storage = await openNodeSqliteStorage("/data/harness.db", { busyTimeoutMs: 5_000 });
const harness = await Harness.open(storage, { models: () => llmModels(cfg).models, registry, settings, now, onReport }, ctx);
harness.closed.then((end) => { if (end.kind === "failed") process.exit(1); }); // plan: pod restarts
await restoreIfNeeded(harness, ctx);  // §8
harness.resume();
```

---

## 2. Conversations

**There is no create-or-get by stable key.** `ConversationId = Id<"conversation">` (`D/types.d.ts:21`) is minted by storage; the only host-chosen ID is the reserved root (`ROOT_CONVERSATION_ID`, `D/types.d.ts:32`). `ConversationQuery` filters by owner only (`D/types.d.ts:744-749`), and `Storage` has no "find by key" and no delete (`D/types.d.ts:1116-1180`). **The plan's directory must be our own document** (§9): a session-scoped doc mapping `"web:<email>"`/`"tg:<id>"` → conversation ID.

**Create.** `harness.createConversation({ownership:{kind:"ownerless"}, agent?, init?}, ctx)` — `D/harness/types.d.ts:849`; `ConversationCreateOptions` at `:486-491`, `ConversationInit = (tx, conversationId) => void` at `:485`. `init` runs *inside* the creating commit after the `agent` change; document access works there, table reads throw `ReadAfterWrite` (`D/harness/types.d.ts:481-485`). That is where the directory entry is written atomically with the conversation. `harness.root(ctx, {agent, init})` (`:844`) returns the reserved root, creating it on first use only — later calls use the stored agent.

**List.** No harness API; use a commit: `harness.commit((tx) => tx.scanConversations({}, 100, undefined), ctx)` (`D/types.d.ts:901`) → `Page<ConversationRecord>` (`id`, `parent`, `owner`; `D/types.d.ts:387-399`). Practical listing comes from the directory doc instead.

**Set model / thinking / tools / prompt / limits.** `conversation.configure(change, ctx)` — `D/harness/types.d.ts:766`; `AgentChange` at `:437-457`: `model`, `thinkingLevel`, `extensions`, `tools`, `modelTools`, `instructions`, `cwd`, `maxTurns`, `compaction`; a field replaces, `null` clears, `undefined` leaves it. It is stored as names in `pi.agent` and resolved per use (`R:380-405`). The **system prompt** is not per-conversation text alone: it is the selected extensions' `section()`s in order plus `instructions` rendered last (`R:370-379`), stored as positional `pi.system` entries so only changes are re-sent. The model, prompt and offered tools of a request are fixed when it is prepared; a change applies from the next request (`R:400-402`).

**Where history lives and how to read it back.** Entries are immutable transcript records — kinds `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system`, `pi.reset`, `pi.compaction`, plus our own kinds (`D/entries.d.ts:1-30`). Three readers:

- `conversation.context(ctx)` — the active transcript the model sees, as `Message[]` plus contributions (`D/harness/types.d.ts:803`).
- `conversation.entries({order:"descending"}, limit, cursor, ctx)` — fork-aware raw history, paged (`:807`; `Page` at `D/types.d.ts:732`). This is the source for "reload shows server history".
- `conversation.watch(ctx, {min, max})` — a window (default newest 50, max 100) plus `docs` (`D/harness/view.d.ts:6-34`); pair it with `ConversationTranscript` for a reloadable web transcript with "load earlier" (`R:499-517`).

Note `EntryRecord.model` is what the model saw, `data` is what the UI renders (`D/types.d.ts:412-429`) — so a submitted input can be placed as `{kind:"chat.message", data:{author}}` while the model still sees `content` (`D/harness/types.d.ts:21-30`, `R:544-560`).

---

## 3. Submitting a user turn

**Submit.** `conversation.submit(draft, ctx): Promise<Submission>` — `D/harness/types.d.ts:775`. `SubmissionDraft` (`D/harness/types.d.ts:35-57`):

```ts
{ type: "input", content: UserInput, requestId?, whenBusy?: "steer"|"followUp"|"reject", whenIdle?: "reject", entry?: {kind, data} }
| { type: "write", entry: EntryDraft }
| { type: "continue" }        // no new user message; idle only
```

`requestId` is host-provided and **scoped to the conversation** (`D/types.d.ts:466`); a duplicate returns the existing submission instead of admitting twice (`R:129-136`, `D/harness/submissions.d.ts:31-42`). `whenBusy:"reject"` throws `ConversationBusy`, `whenIdle:"reject"` throws `ConversationIdle` (`D/errors.d.ts:39-47`) — both write nothing (`D/harness/types.d.ts:40-52`).

**Await the end.** `submission.wait(ctx): Promise<SettledSubmissionRecord>` — `D/harness/types.d.ts:73`, `:68`. After a restart, `harness.submission(id, ctx)` reacquires it (`:854`).

```ts
const submission = await conversation.submit({ type: "input", content: text, requestId: `tg:${updateId}` }, ctx);
const settled = await submission.wait(ctx);
// { status: "done", entry, answer }  |  { status: "unanswered", reason, detail? }
```

**Stream while it runs.** There is no event stream: `watchEvents()` was removed in 1.5.0 (`CHANGELOG.md`, 1.5.0 breaking note) and the documented replacement is state (`R:477-528`). `conversation.watch(ctx)` gives a value whose `docs["pi.live"]` (`D/harness/live.d.ts:134-172`) holds:

| Field | Line | Meaning |
|---|---|---|
| `run` | 112-132 | present while busy: `taskId`, `inputs`, **`turns`** (tool rounds so far), `first`, `afterRun` |
| `generation.message` | 138-141 | committed partial `AssistantMessage` — the streaming text |
| `generation.retry` | 142-146 | `{at, error}` during a retry backoff |
| `generation.deferred` | 147-150 | provider-side deferred poll |
| `tools[]` | 152 | `ToolSlot`: `callId`, `name`, `status`, `output`, `droppedBytes/Lines`, `details`, `diagnostics`, `taskId`, `entry` |
| `nestedTools[]` | 158 | nested calls with `parentCallId`, `arguments`, `summary` |
| `compactions`, `compactionFailure` | 159-165 | |
| `runFailure` | 166-171 | why the last run ended without an answer, kept until the next run |

Watches see every commit **immediately**, storage later (deferred commits, `R:520-527`); partials commit at most every `settings.progress.partialIntervalMs` (default 100 ms; `D/harness/types.d.ts` `ProgressPolicy`). Finished entries arrive in `view.entries`; tool results also land there as `pi.tool-result`. So: one watch per conversation → push SSE frames from `generation.message` diffs and `tools[]` changes; the page's "reset" on a preamble is our own rendering rule (`agent-spec.md` §2.1), not the library's.

**End states.** `SubmissionSettlement` (`D/types.d.ts:540-547`) carries `status` plus `answer: EntryId` or `reason`/`detail`. Reasons:

- `RunFailureReason` — `model_error`, `no_model`, `aborted`, `reset`, `faulted`, `orphaned`, `interrupted`, `restart_limit`, `nothing_to_answer`, `turn_limit` (`D/harness/live.d.ts:94`), each with the `detail` semantics documented at `:78-93` and `:96-110` (`model_error` = error text; `no_model` = the missing model; `turn_limit` = `"N turns"`; `interrupted`/`restart_limit` = what was cut off and how often).
- Extras in the settlement only: `run_failed` when `settings.afterFailedRun: "withdraw"` settles queued inputs (`D/harness/generation.js:471`), `stale` for a queued write a reset outran (`D/harness/submissions.js:246`), `aborted` for withdrawn queued inputs (`D/harness/inbox.js:113`).

**Final text and its usage.** `settled.answer` is an `EntryId`: `harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx)` (`D/types.d.ts:899`) → `.model[0]` is the `AssistantMessage` with `content`, `stopReason`, `errorMessage`, `usage` (`A/types.d.ts:384-419`). The T0 spike instead read `root.context(ctx).messages` and took the last assistant (`tmp/v3-t0/spike.mjs:76-82`). `usage` of the whole conversation is `harness.usage(ctx)` (`D/harness/types.d.ts:867`).

---

## 4. The model and the connection

**How a request gets its models.** `HarnessOptions.models` may be a **function**, called at each use (`D/harness/types.d.ts:638`, `D/harness/harness.js:89-95`); tools and hooks see the same through `api.models` (`:199`, `:895`). So a settings change (base URL, model id, key) is picked up on the next request **without reopening**.

**What the harness passes to pi-ai.** `D/harness/generation.js:143-156` builds:

```js
const options = { ...streamOptions, signal, telemetry, sessionId, reasoning, onPayload };
```

and calls `runtime.models.streamSimple(model, { messages }, options)` (`D/harness/generation.js:549`). `streamOptions` is `settings.stream`, typed `ConversationStreamOptions` (`D/harness/types.d.ts:493-509`): `transport`, `timeoutMs`, `websocketConnectTimeoutMs`, `thinkingBudgets`, `maxRetries`, `maxRetryDelayMs`, `headers`, `metadata`, `cacheRetention`, `deferred`. **There is no `apiKey` and no `fetch`** — those exist in pi-ai's `ProviderRequestOptions` (`A/types.d.ts:47-70`) but the durable layer never forwards them.

Consequences:

- **`apiKey`** comes from the provider's auth resolution inside `Models`. That is what `app/src/llm/provider.ts:96-104` already does (`resolve: async () => ({ auth: { apiKey } })`). There is no per-request override route.
- **`fetch`** cannot be passed through `settings.stream`. The only route is a provider whose chat API is wrapped, since pi-ai forwards `options.fetch` to the SDK client (`A/api/openai-completions.js:187`, `:516-546`) and `createProvider` accepts any `ProviderStreams` (`A/models.d.ts:249`, `:263`):

```ts
const api = openAICompletionsApi();
const withFetch = (fetch: FetchFunction): ProviderStreams => ({
	stream: (m, c, o) => api.stream(m, c, { ...o, fetch }),
	streamSimple: (m, c, o) => api.streamSimple(m, c, { ...o, fetch }),
});
// createProvider({ id, baseUrl, auth, models: [modelEntry(cfg)], api: withFetch(withoutAuthorization) })
```

  `ModelsRequestTransforms.transformHeaders` (`A/models.d.ts:56-60`) rewrites headers only — it cannot strip the Authorization header that the SDK builds from the key, so it is **not** a substitute for the keyless-endpoint `fetch`. This belongs in `src/llm/provider.ts` (pi-ai is allowed there); the adapter then just consumes `llmModels(cfg)`.
- **`timeoutMs`** is `settings.stream.timeoutMs` (`D/harness/types.d.ts:495`). It is captured into the generation checkpoint at prepare (`D/harness/generation.d.ts:23-24`: "a resend after recovery uses them unchanged"), so a change applies to the next prepared request, not to an in-flight retry.
- **Thinking level** is `conversation.configure({thinkingLevel}, ctx)`; values `off|minimal|low|medium|high|xhigh|max` (`A/providers/model-schema.d.ts:8`). It reaches pi-ai as `reasoning` unless `"off"` (`D/harness/generation.js:153`). So `/think` costs one small `configure` commit before the submit — there is no per-submission thinking field.
- **Model ref** must resolve in `Models`: `runtime.models.getModel(ref.provider, ref.modelId)`; `undefined` ends the run `no_model` before any request (`D/harness/generation.js:47-51`), matching T0.2.

**Can model/thinking/timeout change per turn without reopening?** Yes: `configure()` for model and thinking (apply from the next prepared request), `settings` as a function or a live getter object for `stream`/`retry`/`compaction` (`D/harness/types.d.ts:648`), and `models` as a function for the key and base URL. Nothing needs a reopen.

---

## 5. Retries

`settings.retry: Partial<ConversationRetryPolicy>` = `{enabled, maxRetries, baseDelayMs, maxAgentDelayMs?}` (`D/harness/types.d.ts:511-516`, `:568`). Defaults `{enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000}` (`D/harness/agent.js:4-9`), delay `min(baseDelayMs * 2^(attempt-1), maxAgentDelayMs)` — i.e. 2 s, 4 s, 8 s (`agent-spec.md` §1.7).

Two things are retried:

1. A terminal response with `stopReason === "error"` whose text pi-ai classifies as retryable, and which is not a context overflow — `D/harness/generation.js:625-632`.
2. A host that died during a request or a poll: `restarts` makes it a failed attempt — `D/harness/generation.js:346-380`.

Set it in `HarnessSettings` at open (harness-wide, never per conversation; `D/harness/types.d.ts:548-575`). Live settings are fine because the object is read at each use (`D/harness/harness.js:97-99`).

**How attempts surface.** Each failed attempt is (a) appended to the transcript as an assistant entry with `stopReason:"error"` and counted in `pi.usage` (`D/harness/generation.js:636-638`, `:933`), and (b) shown as `pi.live.generation.retry = {at, error}` during the backoff (`D/harness/live.d.ts:142-146`; `D/harness/generation.js:639`, `:364`). Retries are **not** reported to `onReport`; only the terminal outcome is (`model_error`, or `interrupted`/`restart_limit` — `R:216`). For the Go-free "no second retry loop" rule (`agent-spec.md` trap 1), read the retry policy nowhere else.

`restartLimit` (same settings object, `D/harness/types.d.ts:590-600`, default 5 `D/harness/agent.d.ts:11`) bounds crash loops, not retries.

---

## 6. Tool rounds

**`maxTurns` semantics** (`AgentState.maxTurns`, `D/harness/types.d.ts:427`; `Agent` at `:477`; `configure` accepts it at `:454`). It counts **tool rounds** (`pi.live.run.turns`), incremented when a tool round starts (`D/harness/generation.js:836`). The round that reaches it *runs its tools*, then the run ends `unanswered` with `turn_limit` (`D/harness/generation.js:897-906`; `R:404`). It is per conversation, persisted in `pi.agent`, inherited by forks/children, needs an integer ≥ 1 or `null`, and a change applies at the end of the current round.

**Can a run force a final no-tools round?** Not through settings: `tool_choice` is absent from `ConversationStreamOptions` (`D/harness/types.d.ts:493-509`). Three mechanisms exist:

1. `control: { terminate: true }` on a tool result ends the run **without** another model request when every result of the round asks for it (`D/harness/types.d.ts:120-126`, `R:277`) — the opposite of a forced answer.
2. `submit({type:"continue"})` after `turn_limit` starts a **new run** with a fresh turn budget on the same context (`D/harness/live.d.ts:92`, `R:563-593`) — a second submission, not Go's single turn.
3. **`beforeProviderRequest`** — "after pi-ai builds the provider request body, before it is sent; the result replaces the body for that request only" (`D/harness/types.d.ts:919-925`, `D/harness/generation.js:490-498`). This is the exact equivalent of Go's `ForceAnswer` (pi-ai writes `params.tool_choice = options.toolChoice` — `A/api/openai-completions.js:602-603`, `A/types.d.ts:28`).

**What happens to tool calls on the last round:** they run. `finishToolRound` reads their outcomes, applies `terminate`/`handoff`/`addTools`, then checks the limit (`D/harness/generation.js:846-905`). Go instead *ignores* calls on the forced round (`agent-spec.md` §2.1, trap 3) — a provider that emits calls despite `tool_choice:"none"` therefore diverges: we would run them.

**Recommendation to reproduce "N tool rounds, then one forced answer":**

```ts
const N = Math.max(cfg.MaxToolRounds, 1);           // Go: agent.go:114-117
await conversation.configure({ maxTurns: N + 1 }, ctx);   // backstop only, not the mechanism

const ForceAnswer = defineExtension({
	name: "movin.force-answer",
	hooks: [hook(GenerationTask, {
		beforeProviderRequest: async ({ payload }, api, ctx) => {
			const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
			if ((live?.run?.turns ?? 0) < N) return undefined;      // not the forced round
			return { payload: { ...(payload as object), tool_choice: "none" } };
		},
	})],
});
```

`pi.live.run.turns` is committed before the request is prepared, so the hook sees "N tool rounds are done" on the request that must answer. Keep `maxTurns: N + 1` so a model that ignores `tool_choice` is still bounded (it ends `turn_limit`, and a `continue` then answers). Note the patched body puts `tool_choice` last, while Go sends it between `tools` and `stream` (`agent-spec.md` trap 4) — only relevant to a byte-diff harness.

---

## 7. Tools

**`defineTool`** (`D/harness/define.d.ts:7`) takes a `ToolRegistration` (`D/harness/types.d.ts:285-317`):

| Field | Line | Note |
|---|---|---|
| `name`, `description`, `parameters` | — | pi-ai `Tool` fields; `parameters` is JSON Schema, `obj/str/num` from `@earendil-works/pi-schema`; `args` typed via `Static` |
| `replay?: "safe" \| "unsafe"` | 287 | default `unsafe` |
| `executionMode?` | 289 | default `settings.toolExecution` (`"parallel"` unless set) |
| `prepareArguments?` | 295 | pure repair before validation |
| `structuredOutputSchema?` | 300 | for nested callers only |
| `callers?` | 306 | `"model"` / `"tools"` |
| `deferred?` | 311 | tool_search only |
| `outputLimits?` | 312 | bytes/lines/retain |
| `execute(args, api, context)` | 317 | see below |

**Handler context.** `api: ToolExecutionApi` (`D/harness/types.d.ts:190-283`): `taskId` (`:191` — the durable tool-task ID), `conversationId` (`:192`), `callId` (`:193`), `registry`, `agent(ctx)`, `models`, `env`, `now()`, `output(chunk, skipped?)` (streams into the result), `outputWindow`, `retainedOutput()`, `diagnostic(d)`, `details(v, ctx)`, `commit(fn, ctx, opts?)`, `memo`, `createTask`, `getTask`, `waitForTask`, `conversation(id, ctx)`, `executeTool(name, args, ctx, {key, progress})` (`:270-282`). **There is no call index** — the nearest things are `callId` (provider call ID, stable once the assistant entry is committed) and `taskId` (a per-database counter, unique per call). The abort signal is Chord's: `context.abortSignal` (the scheduler binds the invocation signal — `C/context/index.d.ts:10`, `D/harness/scheduler.js:2037`).

For the plan's change ID, `sha256(epoch | api.taskId)` is enough: T0.2 R4 showed the epoch salt fixes the cross-database collision (`progress.md` T0.2), and the spike already used `sha256(epoch|taskId|0)` (`tmp/v3-t0/spike.mjs:35`).

**Images from a tool.** `output?: ToolResultMessage["content"]` = `(TextContent | ImageContent)[]`, `ImageContent = { type:"image", data, mimeType }` (`D/harness/types.d.ts:100-108`, `A/types.d.ts:273-277`, `:434-449`). pi-ai sends the image as an extra user message right after the tool message (`"Attached image(s) from tool result"`, T0.2), the same shape Go sends — proven in `tmp/v3-t0/imgcheck.mjs:46-52`. Each image is ≈1.8k tokens and stays in every later request (`progress.md` T0.3), hence the placeholder work in §8.

**Error results.** Throwing from `execute()` gives the model an error result (`R:277`); `harnessError(code, message)` builds one with an `error` diagnostic (`D/harness/tool.d.ts:67`). Harness-written codes, told apart for `afterTool`: `tool_unavailable`, `invalid_arguments`, `blocked`, `interrupted`, `restart_limit`, `aborted`, `abandoned` (`D/harness/types.d.ts:978-989`). Diagnostics travel in `pi.tool-result` `data` and are rendered at the end of the message (`D/entries.d.ts:12-18`).

**Unknown tool names.** A call to a tool the request did not offer settles `tool_unavailable` without resolving the name (`D/harness/tool.d.ts:13-14`, `D/harness/live.d.ts:26-27`) — an error result for the model, which is exactly T3.3's "unknown tool → error result".

**Replay after a crash.** Each call is a durable task; the intent (final arguments + replay policy) is committed before `execute()` (`D/harness/tool.d.ts:24-32`). On restart: `replay:"safe"` re-runs; otherwise the model gets an `interrupted` error result carrying the output committed so far (`R:277`). A replay-safe call cut off `settings.restartLimit` times ends with a `restart_limit` error result. Nested calls follow the same rule, and a caller that is not replay-safe never reruns (`R:307-333`). Our write tools become `replay: "safe"` *because* their change ID makes the write idempotent — the intent stays durable, the effect is deduplicated by the journal.

**Hook before a write (auth).** `beforeTool(call, api, ctx)` — `D/harness/types.d.ts:973-980`: the first `block` wins, otherwise `arguments` replace the call's; a throw blocks. It runs after resolution and validation, before the intent commit (`D/harness/tool.d.ts:60-64`), and sees the whole `call` (`ToolCall` + `parent` for nested calls, `D/harness/types.d.ts:966-971`) plus `HookApi` reads (`snapshot`, `entry`, `entries`, `memo`, `taskId`, `conversationId` — `D/harness/types.d.ts:888-906`). Do the Telegram/web authorisation check here, not in `execute()`.

```ts
defineExtension({
	name: "movin.tools",
	tools: [addEntry, patchEntry /* … */],
	hooks: [hook(ToolTask, {
		beforeTool: async (call, api, ctx) => {
			if (call.name === "stay_silent") return undefined;
			const ok = await isAuthorised(await api.snapshot(AuthorDoc, api.conversationId, ctx));
			return ok ? undefined : { block: "not allowed to change entries from this chat" };
		},
	})],
});
```

---

## 8. Before each request

**Transform or replace messages.** `beforeRequest` hook — `D/harness/types.d.ts:909-917`, called on **every** attempt including recovery (`D/harness/generation.js:143-147`); returning `{ messages }` replaces them for that request only. The transcript is untouched, which is what the plan wants:

```ts
hook(GenerationTask, {
	beforeRequest: async ({ messages }, api, ctx) => {
		const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
		const older = live?.run === undefined ? undefined : 0;      // our own bookkeeping decides "earlier runs"
		return { messages: replaceOldImages(messages, "[image from an earlier message]") };
	},
})
```

`HookApi` gives committed reads (`snapshot`, `entry`, `entries`, `memo`) and runs off the Session line, so it may see more after a crash (`D/harness/types.d.ts:886-906`). For body-level needs use `beforeProviderRequest` (`:919-925`). For the per-turn delta (date, "changed since your last message") the cheaper route is the submitted `content` itself — the plan already puts the delta in the user message, and an `entry` override keeps the transcript clean (`D/harness/types.d.ts:21-30`).

**Compaction.** Manual: `conversation.compact(instructions | undefined, ctx): Promise<TaskId<CompactionResult>>` (`D/harness/types.d.ts:796`); it summarizes in the background and places the summary at the next boundary (`R:606-619`). Automatic: `settings.compaction` / `configure({ compaction })` with `{ enabled, reserveTokens, keepRecentTokens, backgroundTokens, modelOverrides }` (`D/harness/types.d.ts:518-541`, `R:621-657`). Triggers: `manual | threshold | overflow` (`D/harness/types.d.ts:544`); a context-overflow rejection compacts and retries once. `beforeCompact` can decline or supply its own summary (`:998-1012`). The summary is a `pi.compaction` entry with `head` = first kept entry (`D/entries.d.ts:28-30`); old entries stay in storage. The blocking-threshold failure makes the run `model_error` with detail `Compaction failed: <error>` (`R:655`).

**Idle reset after 6 h, same key.** No built-in mechanism; there is no session/history TTL (`contextRetentionMs` only drops cached context from memory — `D/harness/types.d.ts:573-577`). Two routes:

- *Same key, fresh history:* keep our own `lastActivity` per conversation (a session doc or a conversation doc, written after each run) and, on the next submit, if `now() - lastActivity > 6h`, call `conversation.reset(undefined, ctx)` (`D/harness/types.d.ts:791`, `R:593-604`). This appends a `pi.reset` entry with `head:"self"`; the model sees nothing earlier, storage keeps everything, and the web transcript shows a divider.
- *Rotate the key:* create a new conversation and re-point the directory entry; the old one stays in storage forever — **there is no conversation delete** (`D/types.d.ts:1116-1180`). Compaction (`settings.compaction`) stays the fallback either way.

The clock is ours: `HarnessOptions.now` (`D/harness/types.d.ts:661`) — the same clock for every process on that database (`R:164`).

**Restore path caution.** `conversation.abort()`, `harness.waitForIdle()` and `Submission.wait()` all **start the scheduler** (`D/harness/types.d.ts:824-834`, `D/harness/harness.js:214-221`) — so "abort live work before `resume()`" via `root.abort()` silently resumes first. Use `harness.inspect(ctx)` (`:852`) for the live task IDs and `harness.abortTask(id, ctx)` (`:861`, `D/harness/scheduler.js:389-422` — commits the abort mark, joins an active invocation, does not enable scheduling), rotate `movin.epoch` in one `harness.commit`, then `resume()`. The abort handlers then run under `resume()`, which is what the T0.2 R2 result (nothing resent, nothing replayed) depends on.

---

## 9. Docs and session state (`movin.epoch`)

`defineDoc` overloads: `{scope:"session"}` → `SessionDocToken`; conversation docs need `history: "latest"|"rewindable"` and `fork` (`D/documents.d.ts:9-19`). `CommonDocDefinition` requires `kind`, `version`, `initial()`, and **`checkpointWhen`** (`D/types.d.ts:61-72`) — return `true` for a rarely changed doc so each change is stored as a complete base.

Access: `tx.doc(Epoch)` inside a commit (`D/types.d.ts:945`), `harness.snapshot(Epoch, ctx)` (`D/types.d.ts:1089`), `harness.observeDoc`/`harness.watchDoc` for live reads. `movin.epoch` created with the database, exactly as T0.2 validated (`tmp/v3-t0/spike.mjs:11`, `:65-72`):

```ts
const Epoch = defineDoc<{ id: string }>({
	kind: "movin.epoch", version: 1, scope: "session",
	initial: () => ({ id: "" }), checkpointWhen: () => true,
});

async function openEpoch(rotate: boolean): Promise<string> {
	return harness.commit(async (tx) => {
		const doc = await tx.doc(Epoch);
		if (rotate || doc.id === "") doc.id = randomUUID();
		return doc.id;
	}, ctx);
}
```

The same doc shape serves the conversation directory (`{ by: Record<string, number> }`) and the Telegram polling offset, if you prefer one document per concern.

---

## 10. Testing

**Faux provider** — `fauxProvider()` from `@earendil-works/pi-ai/providers/faux` (`A/providers/faux.d.ts:92-102`): `models.setProvider(faux.provider)`, then `setResponses`/`appendResponses` with an `AssistantMessage` or a factory `(context, options, state, model) => AssistantMessage` (`:36-37`), `fauxText`, `fauxThinking`, `fauxToolCall(name, args, {id})`, `fauxAssistantMessage(content, {stopReason, errorMessage, deferred})` (`:19-30`), `state.callCount`, `getPendingResponseCount()`, plus scripted deferred responses and token streaming (`:31-52`). The factory's `options` lets a test assert what the harness sent — useful for the forced-answer/`tool_choice` test and the `timeoutMs` test. Modelled on `tmp/v3-t0/spike.mjs:50-61` (a responder that returns a tool call, then text).

**Injected clock.** `HarnessOptions.now` + `setTimer` (`D/harness/types.d.ts:661-678`, `R:164`). Sleep deadlines are stored on `now`, so the 6 h idle test and any `sleepUntil` test just move that function forward.

**Storage.** `MemoryStorage` (`D/index.d.ts`) for behaviour; `openNodeSqliteStorage(path)` on a `fs.mkdtemp` directory for restart tests. SQLite-specific knobs (`busyTimeoutMs`, `mode:"read-only"`) at `C/sqlite/node.d.ts:5-15`. `commitWrites(storage, writes, ctx)` from `@earendil-works/pi-durable/testing` seeds a storage directly (`D/testing/index.d.ts:2`).

**Simulating a crash.** There is no in-process crash simulator, and `close()` is explicitly not a crash (`R:216`: "A close is not a crash: a request it stopped is sent again"; a close does not increment `restarts`). The only faithful way is the T0.2 pattern: spawn a child process that submits, `SIGKILL` it inside the tool window, reopen the same SQLite file in a new process, `resume()`, then assert the journal/entry counts (`tmp/v3-t0/spike.mjs:1-3`, `:85-112`; `run-t03.sh` shows the container harness). Restart counting on open is `D/harness/scheduler.js:243-247`.

---

## 11. Usage per round (the `llm call` line)

- Per response: `AssistantMessage.usage` — `{input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost}` (`A/types.d.ts:292-320`, `:395`). `cacheRead` is `cached_tokens` (T0.2 finding), `cacheWrite` is 0 on this path.
- Per round, live: the `afterResponse` hook receives every terminal provider message before classification (`D/harness/types.d.ts:926`, `D/harness/generation.js:600`) — that is where Go's line goes. `message.stopReason` gives Go's `stop` (`stop`/`length`/`toolUse`/`error` — `A/types.d.ts:321`); the round number is `pi.live.run.turns` at that moment (`api.snapshot(LiveDoc, …)`), 0 for the first round.
- Ledger: `pi.usage` per `provider/modelId` and per tool name (`D/harness/usage.d.ts:6-12`), written in the same commit as the entry (`D/harness/generation.js:933`); `harness.usage(ctx)` sums the session (`D/harness/types.d.ts:867`).
- Tool-level spend: `ToolExecutionResult.usage` is added to `pi.usage.tools` (`D/harness/types.d.ts:114`).

```ts
hook(GenerationTask, {
	afterResponse: async (message, api, ctx) => {
		const live = await api.snapshot(LiveDoc, api.conversationId, ctx);
		log.info("llm call", { model: message.model, round: (live?.run?.turns ?? 0) + 1, stop: message.stopReason,
			in: message.usage.input, out: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: 0 });
	},
})
```

---

## 12. Imports and entry points

| Need | Import |
|---|---|
| Harness, registry, tools, hooks, docs, entries, errors, `LiveDoc`, `UsageDoc`, `ConversationTranscript`, `ROOT_CONVERSATION_ID` | `@earendil-works/pi-durable` (`D/index.d.ts`) |
| SQLite storage | `@earendil-works/pi-durable/storage/sqlite/node` → `openNodeSqliteStorage` (`D/storage/sqlite/node.d.ts:7`) |
| In-memory storage (tests) | `@earendil-works/pi-durable` → `MemoryStorage` |
| Contexts | `@earendil-works/chord/context` → `BACKGROUND_CONTEXT`, `withCancel`, `withAbortSignal` |
| Schema builders | `@earendil-works/pi-schema` → `obj`, `str`, `num` |
| pi-ai (already used by `src/llm/`) | `@earendil-works/pi-ai/models`, `…/api/openai-completions.lazy`, `…/providers/faux` (tests) |

**Does an import pull a provider SDK?** No, not at start. The package root only reaches pi-ai through `/utils/*` subpaths (`utils/transcript`, `utils/retry`, `utils/validation`, `utils/uuid`, `utils/streaming-json`, `utils/overflow`, `utils/identity`, `utils/estimate`) — grep of `D/**/*.js` — never `@earendil-works/pi-ai` itself. `storage/sqlite/node` pulls `node:sqlite`. pi-ai *depends* on `openai`, `@anthropic-ai/sdk`, `@google/genai` and bedrock (T0.1), but the openai client is loaded lazily on the first completions request (`progress.md` T0.1 loader trace), and `app/src/llm/nosdk.test.ts:26-53` already asserts the app's module graph loads none of them — extend that test's entry point when the adapter lands.

---

## Gaps vs the plan

Ordered by how much they change the design.

1. **No conversation lookup by key (`web:<email>`, `tg:<chat_id>`).** IDs are storage-minted and `Storage` has no key index or delete (`D/types.d.ts:21`, `:744-749`, `:1116-1180`). The directory must be a session-scoped doc written in the creating commit via `init` (`D/harness/types.d.ts:485-490`). Rotating a key leaves an orphan conversation forever.
2. **No forced final answer round.** `tool_choice` is not in `ConversationStreamOptions` (`D/harness/types.d.ts:493-509`) and `maxTurns` ends `unanswered`/`turn_limit`, not with an answer (`D/harness/generation.js:897-906`). The `beforeProviderRequest` patch above reproduces Go's request, but calls the model still emits are *executed* while Go ignores them (`agent-spec.md` trap 3) — a divergence to accept or to guard in `afterTool`.
3. **No `apiKey`/`fetch` route.** The plan's "merge `requestOptions(cfg)` into the harness options" has nowhere to go: only `settings.stream` reaches pi-ai, and it has neither field (`D/harness/generation.js:148-155`). Key → provider `auth.apiKey.resolve()`; keyless `fetch` → a wrapped `ProviderStreams` in `src/llm/provider.ts` (`A/models.d.ts:249`, `A/api/openai-completions.js:187`). `transformHeaders` is headers-only and cannot remove the SDK's Authorization header. T3.1's brief should be extended.
4. **No call index for change IDs.** `ToolExecutionApi` has `taskId` and `callId` only (`D/harness/types.d.ts:191-193`). Use `sha256(epoch|taskId)` (T0.2 R4 already proved the salt suffices) and drop the index from the plan's formula, or keep an index in a `memo`.
5. **Streaming granularity is commit granularity.** No token callback, no `onProviderStreamEvent` (not in `ConversationStreamOptions`); the watch sees partials throttled by `settings.progress.partialIntervalMs` (100 ms default) and storage later (`R:520-527`). SSE frames become ~100 ms batches, not Go's per-chunk `OnText`.
6. **No idle reset and no history trimming.** Neither the 6 h reset (`bot.go:459-475` semantics) nor Go's `CleanTurns` (12 turns, 4000 runes, `agent-spec.md` §2.2, trap 19) exists. Both must be built: a `lastActivity` doc + `reset()`/key rotation, and either `beforeRequest` surgery or reliance on compaction. Compaction is *not* Go's 12-turn window.
7. **`abort()`/`waitForIdle()` start scheduling** (`D/harness/types.d.ts:824-834`). The restore path ("abort live work before `resume()`") must use `inspect()` + `abortTask()` (`:852`, `:861`) inside one commit, or state explicitly that scheduling starts early.
8. **Failure vocabulary differs from Go's.** `model_error`, `no_model`, `interrupted`, `restart_limit`, `turn_limit`, `nothing_to_answer`, `reset`, `faulted`, `orphaned`, plus `run_failed`/`stale` settlements (`D/harness/live.d.ts:94`, `D/harness/generation.js:471`, `D/harness/inbox.js:53`). Go's `refusal`/`max_tokens`/`ErrCutOff` texts (`agent-spec.md` traps 12-13) must be derived from `stopReason` + `errorMessage`, not read off the settlement.
9. **Every conversation must be given a model explicitly** — unchanged from the plan, but note `harness.root()` only applies its `agent` when it creates the root (`D/harness/types.d.ts:844`); a host-level default does not exist (`AgentState.model` is optional, `D/harness/types.d.ts:410`).
10. **Per-turn thinking costs a commit.** There is no thinking field on `SubmissionDraft` (`D/harness/types.d.ts:35-57`); `/think` needs `configure({thinkingLevel})` before each submit, i.e. one extra write per turn.
