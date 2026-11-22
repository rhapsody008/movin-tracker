<!-- planner c483e31a-d400-469, 2026-11-22; saved verbatim; adopted by the main session while ZY is away -->
# Plan: T5 — scheduled work and restore safety (movin-tracker v3)

## 1. Goal and assumptions

- **Goal:** `plan.md:131-135` holds: a durable check-in that keeps the `checkin.json` claim, the docs sync with its notice, and a restore path that runs before `resume()`.
- **Read:** t5-spec (all), `plan.md`, `decisions.md` (T3.2–T4.4), `T4-plan.md`, `adapter.ts` (all). I did not open `main.ts`, `bot.ts`, `admin.ts`, `schedule.ts` or the pi-durable `.js` files; line cites for those come from t5-spec.
- **Not run:** nothing was executed. Library claims I could not confirm from the `.d.ts` files are in §6 as Step 0 checks.
- **Scope of every step:** repo edits by the coder (state-changing, local repo only). Verify with `make -C app lint test`; roll back by reverting the step's files. No new npm packages. No skills apply (this is not `ops/`).
- **Ordering constraint:** T5.1a touches no T4 file, so it can start now. T5.1b and later edit `adapter.ts` and `bot.ts`, so they wait for the T4 review fixes to land.

## 2. Design

### 2.1 One generic schedule task in the adapter

Same style as the outbox: the adapter knows nothing about check-ins or documents.

```ts
// OpenAgentOptions
schedules?: readonly ScheduleSpec[];
startGuard?: StartGuard;                       // T5.3
// ScheduleSpec — the host half, lives in src/tasks/*
{ name: string;                                // "checkin" | "docsync"
  run(ctx: { target: number | null; signal?: AbortSignal }): Promise<number> }  // returns the next target, epoch ms
// Agent
schedule: { rearm(name: string): Promise<void> };
deliver(key, address, parts, options?: { note?: { tag: string; text: string } }): Promise<void>;
// test helper
inspectSchedules(agent): Promise<{ name; state; until; target }[]>
```

- **Task:** `movin.schedule` v1, input `{name}`, checkpoint `{phase:"run", target: number|null}`, registered in the `movin.agent` extension.
- **Phase `run`:** call `spec.run({target})`, then `sleepUntil(min(next, now + SCHEDULE_MAX_SLEEP_MS), {phase:"run", target: next})`. The cap is 15 minutes.
- **A throw from `run`** is caught, logged (`schedule run failed`, `name`, `err`) and slept 60 s. A phase that throws faults an extension task, so it must never throw.
- **No spec for the name in this process:** sleep the cap and warn once (same idea as `OUTBOX_UNCONFIGURED_MS`).
- **Owner:** a dedicated ownerless conversation, key `sys:schedule`, created through `conversationFor`. Tasks are `background: true`.
- **Guard doc:** `movin.schedule` (session), `{by: {<name>: taskId}}`. `ensureSchedules()` runs once before `resume()`: for each spec, create a task if the doc has none or the recorded task is terminal or missing. A faulted or aborted task is therefore replaced at the next open.
- **`rearm(name)`:** if the task is `sleeping`, abort it and create a new one (which runs at once). If it is running, set an in-memory flag so the run sleeps 0 afterwards. Never abort a running tick: it would leave a `sending` claim for 10 minutes.
- **Abort handler:** settles `aborted`, like the delivery's.

### 2.2 The check-in

- **Tick** is Go's `CheckinTick` step for step (t5-spec §1.8), in `src/tasks/checkin.ts`, with the per-process `checkinDay` and warn map in its closure. It returns the next target:

| Situation | Next target |
|---|---|
| Settings unreadable, chat not allowed, claim held by another copy, day released | now + 60 s |
| On, before the time | today hh:mm |
| Off, day finished, or at/after 20:00 | `nextRun` (off uses the default time; the cap re-reads settings) |

- **Send:** one `agent.deliver("tg:<chat>", {chat, messageId: 0, group: false}, parts, {note})`. Parts are the summary split at 4000, then one message per ask with its keyboard. Then `Finish(sent)`.
- **Known differences from Go, to record:**
  - "Sent" means "durably queued". A part that later fails six times is logged by the outbox and the day stays `sent`; Go would release and retry. `/checkin` is the manual resend.
  - A crash between the deliver commit and `Finish` re-sends the whole check-in after the 10-minute takeover. Go re-sends after a mid-send crash too.
  - Go leaves an ask whose send failed out of `Asked about:`; v3 lists every ask.
- **The claim is unchanged:** claim before reading entries, release when `deliver` rejects, `quiet` finishes the day.

### 2.3 How the check-in reaches the model (13.4)

A pending note, not transcript entries.

- **Storage:** conversation doc `movin.notes`, `{pending: [{tag, text}]}`. `deliver(..., {note})` writes it in the commit that creates the delivery. A note with the same tag replaces the old one.
- **Consumption:** `submit` reads the notes, passes them to `userContent` as `UserContentOptions.notes`, and `commitSubmitted` clears them in the admission commit. `prompt.ts` places them after the delta block and before the date line, under one fixed header line, followed by Go's `(morning check-in)` and Go's `reply` text (lead plus `\n\nAsked about:\n…`).
- **Why not `appendEntry`:**
  - The 6 h idle reset would hide it. The chat's last activity is usually yesterday, so the 10:00 answer starts a new context, and entries appended at 09:30 sit before the reset head.
  - An entry appended mid-run can end the context on an assistant message (`nothing_to_answer`) or split a tool call from its result.
  - It would need an idle wait while the claim is held.
- **Effect on history:** none. The web history shows `data.text` only.

### 2.4 Restore path (T5.3)

The adapter stays free of S3. A `StartGuard` (in `src/durable/startguard.ts`, no pi-durable import) owns `harness/<instance>/epoch.json`.

```ts
StartGuard = {
  check(db: { starts: number; restoreId: string }): Promise<{ restore: false | "id" | "counter"; starts: number; restoreId: string }>;
  committed(starts: number): Promise<void>;
}
```

Sequence, between `openedHarness()` and `resume()` (`adapter.ts:795-799`):

1. Read session doc `movin.start` (`{starts, restoreId}`, initial `{0, ""}`).
2. `guard.check` reads S3 (`NotFound` means 0) and decides:
   - `starts === 0` → new database, never a restore.
   - env ID non-empty and different from the recorded one → `"id"`.
   - `starts < s3.starts` → `"counter"`.
   - It returns `max(db, s3) + 1`.
3. If restore, run the restore path (§4.2). Any abort that fails means no `resume()`: throw, exit 1, the pod retries.
4. Last SQLite commit: `movin.start = {starts, restoreId}`, clear `movin.schedule`, `ensureSchedules()`. This is the acknowledgement, so a crash before it reruns the whole path (every part is idempotent).
5. `guard.committed(starts)` does the conditional S3 put; on `PreconditionError` it re-reads and writes the max. A failure here only warns: SQLite ahead of S3 heals at the next start through `max`.
6. `resume()`.

SQLite is written before S3 on purpose. The other order would turn a crash between the two into a false restore, which drops pending replies.

## 3. Answers to the open questions

| # | Recommendation | Reason |
|---|---|---|
| 13.1 / 14.2 | Dedicated conversation `sys:schedule` owns both tasks | A chat change in settings needs no task recreation; no chat's abort path can reach it |
| 13.2 | `background: true` | A sleeping non-background task would keep its chat from ever being idle |
| 13.3 | One looping task per name, guarded by the `movin.schedule` doc | Fewest tasks; `ensureSchedules` is idempotent for open and for restore |
| 13.4 / 14.3 | Pending note in the next user message (§2.3) | Survives the idle reset; cannot break message alternation; invisible in history |
| 13.5 | `/checkin` never writes `checkin.json` | Go's rule; the scheduled one still goes out |
| 13.6 | Test on memory and MinIO only; no two-app run on the real bucket | A real run would consume the day's real check-in |
| 13.7 | Go golden for the record bytes (`app/golden/t51`) | A missing `at` would cause a double send |
| 13.8 | Generic task in `adapter.ts`; host halves in `src/tasks/checkin.ts` and `src/tasks/docsync.ts`; texts and keyboard in `src/telegram/checkin.ts` | Keeps the one-importer rule and still matches the Layout row in `plan.md` |
| 13.9 | `checkinStatus()` becomes async; built in `src/tasks/checkin.ts` from the store and settings; `telegramBody()` awaits it | It needs two S3 reads |
| 13.10 | `agent.deliver` per group, address `{chat, messageId: 0, group: false}` | `deliver` already creates the conversation; it adds no entry, so the notice stays out of model context as in Go |
| 13.11 / 14.1 | Durable **daily trigger** as a second `ScheduleSpec` (`docsync`); startup sync, minute refresh, `/sync` and the web button keep calling the same single-flight `syncer.sync` | With the generic task it costs about 40 lines, gives a retry after a crash mid-sync, and matches `plan.md:133` literally |
| 13.12 | Tick re-checks the window on every wake; sleep capped at 15 min; tests use `setTimer` and the manual clock | Never trusts that a sleep elapsed on time |
| 13.13 | Abort every live task from `inspect()`, whatever its state; pin with a test | Sleeping and waiting deliveries are live tasks |
| 13.14 | `cursor = 0`, `queue = []`, `open = []`; keep `recent` and `acceptedAt` | Clearing `recent` would replay up to 256 old updates |
| 13.15 | `guard.check` retries S3 with backoff (1 s up to 30 s, warn each time) until it answers or shutdown; no `resume()` meanwhile | "Start as equal" would resend silently; "refuse to start" is needless. The listener is already up, and chat already answers 503 while the harness opens |
| 13.16 | movin Schedule `ttl: 168h0m0s`; `velero.md` names both schedules and both TTLs | So a restore is looked for in the right backup |
| 13.17 | No guide change expected; re-read `admin-guide.md:281` at the end of T5.1c | Catch-up, cutoff and missed days are unchanged |
| 14.4 | Nothing faster than the 10-minute takeover | T6.6 stops both dev apps; the worst case is a 10-minute delay |
| 14.5 | `{"schema":1,"starts":N,"at":"<RFC 3339, seconds>"}`; the restore ID is stored only in SQLite | The plan says the ID is "recorded in SQLite"; `at` is for a person reading the bucket |
| 14.6 | `MOVIN_INSTANCE`, exactly `dev` or `prod`, **required, no default**; error `MOVIN_INSTANCE must be "dev" or "prod"` | A default would let prod share dev's counter and run a false restore. T6.2 sets `prod`; compose `app-ts` and `app-test` set `dev` in T5.3a |
| 14.7 | Volume only; one paragraph says entries, settings and docs live in S3 and are not rolled back by a volume restore | `plan.md:135` names the volume |

**Flags against ZY's decisions and the approved plan:**

- **13.11 does not contradict the plan.** If the main session prefers the in-process timer instead, that changes the mechanism only. The Direction line in `decisions.md` calls it the main session's call, so record it and report it; it is not a stop.
- **Start-counter blind spot (new finding, for ZY).** "Each start increments both" cannot detect a restore when no start happened between the snapshot and the restore: both sides still read N. That is the normal drill (scale to 0, restore, start). The explicit ID covers it. T5.3 implements the approved design as written, and `velero.md` makes the new ID mandatory. A fix (also bump both counters hourly) changes the Design text, so it needs ZY.
- **13.14** follows `plan.md:49` ("known request IDs are ignored"). No change.
- **Nothing else** changes a ZY decision. No new dependency.

## 4. Steps

Order: T5.1a → T5.1b → T5.1c → T5.2 → T5.3a → T5.3b.

### T5.1a: check-in store, texts, keyboard (pure)

- **Files:** `src/telegram/checkin.ts`, `src/tasks/checkin.ts` (store half), their tests, `app/golden/t51/main.go`, `src/telegram/testdata/checkin.go.json`, a row in `app/golden/README.md`.
- **Design:**
  - `src/telegram/checkin.ts`: `shortDay`, `agendaLine`, `checkinText`, `askText`, `askKeyboard`, `parseCheckinCallback` (the table in t5-spec §1.7, returning an op or "bare ack"), the stale-ask toasts, `checkinMessages(today, agenda)` returning `{parts, note}`.
  - `src/tasks/checkin.ts`: `CheckinStore` (`load`, `claim`, `finish`, `release`), `finished`, `taken`, `nextSince`, `checkinDue`, `checkinChat`, `STALE_CLAIM_MS`, `CHECKIN_KEY`. The record is encoded with `goMarshal` in Go's field order, `schema: 1`, `at` to the second.
  - The generator runs Go's real functions (the unexported ones copied verbatim with line cites) and prints: the summary and asks for six agendas (empty today, 3 asks, 10 asks, 7 overdue, `Yesterday`, a room and a time), the keyboard bodies, the record bytes for `sending`/`sent`/`quiet` with and without `since`/`chat`, and the due table.
- **Tests, Go names:** `TestCheckinDue`, `TestCheckinClaim`, `TestCheckinAfterAnUnfinishedDay`, `TestCheckinReleaseOfFirstEver`, `TestCheckinOneWinner` (memory and MinIO via `variants`), the text half of `TestCheckinCapsAskMessages`, and the data strings of `TestCheckinButtonAfterTheTaskMoved`. New: the golden; callback data at most 64 bytes; `checkinChat` order and its two errors.
- **Mutations:**
  - `at` with milliseconds.
  - `since` always written.
  - `taken` true for an unparsable `at`.
  - A takeover that drops `since`.
  - `release` stamping a new `at`.
  - Due as `>` at the minute.
  - The count from the capped list.
  - The button date taken from today.
- **Verify:** the golden is byte-stable on a second run; no import of pi-durable or of `bot.ts`.

### T5.1b: adapter schedule task and notes

- **Files:** `adapter.ts`, `adapter.test.ts`, `crash-schedule-child.ts`, `crash.test.ts`, `src/agent/prompt.ts` and its test (the `notes` option only).
- **Step 0 (about 40 lines of test, first):** checks 1–4 in §6. If check 1 or 2 fails, stop and report.
- **Design:** §2.1 and §2.3. `ensureSchedules` runs before `resume()` on every open.
- **Tests:**
  - `run` is called at creation with `target: null`, then again at the stored target.
  - The 15-minute cap: a target 24 h away wakes at +15 min with the same target.
  - A throwing `run` logs and reruns after 60 s; the task is not faulted.
  - A second open creates no second task.
  - A terminal task is replaced.
  - `rearm` on a sleeping task runs it at once; `rearm` during a run reruns once and aborts nothing.
  - The schedule task does not hold `idle("tg:1")`, nor `whenIdle` on its own conversation.
  - A name with no spec parks and warns.
  - `deliver` with a note: one commit holds the doc change and the task (`observeCommits`).
  - The next submit's content carries the note once; the turn after has none.
  - A same-tag note replaces the old one.
  - A duplicate `requestId` consumes nothing.
  - A turn after a 6 h gap still carries the note.
  - Web history is unchanged.
- **Crash tests:**
  - Kill while the task sleeps. Reopen: one task, same `until` and `target`, `run` not called before the target. This is "restart mid-sleep keeps the schedule".
  - Kill inside `run`. Reopen: `run` is called again; still one task.
- **Mutations:**
  - `ensureSchedules` without the doc check (two tasks).
  - `background` removed (the idle test hangs).
  - The cap removed.
  - The note cleared outside the admission commit.
  - The note not cleared.
  - `rearm` aborting a running task.
- **Verify:** `imports.test.ts` green; the adapter imports nothing from `src/tasks` or `src/telegram`.

### T5.1c: check-in tick, `/checkin`, `ci:` callbacks, admin view

- **Files:** `src/tasks/checkin.ts` (tick, status), `src/telegram/bot.ts`, `commands.ts`, `bot.test.ts`, `src/tasks/checkin.test.ts`, `src/server/admin.ts` and its test, `main.ts`.
- **Design:**
  - `createCheckin({store, settings, entries, deliver, now, timeZone, log})` returns `{spec, tick, status, sendNow}`. Wired only when a token is set (Go: no token, no check-in). Logs `morning check-in loop running` once.
  - `/checkin`: `take`, then Go's three outcomes (t5-spec §1.6); `sendNow` delivers with the note and never writes the record.
  - `ci:` callback: `take`, auth check 2, `parseCheckinCallback`, `entries.updateIf` with the precondition inside the write.
    - Success: the toast (`truncate` 190) and the keyboard edit are direct and awaited, as the undo button's are. The `✓ <who>line` confirmation with `undoKeyboard` is an `agent.deliver`.
    - Failure: the toasts in §1.7; the buttons stay on `Couldn't save that…`.
  - `PUT /api/settings/checkin` calls `agent.schedule.rearm("checkin")` after a successful save.
  - Every log line in t5-spec §6 keeps its text and fields.
- **Tests, Go names (all eleven of §12.1):**
  - `TestCheckinCommandAndButtons` — includes "the LLM is never called".
  - `TestCheckinCapsAskMessages` — 9 messages.
  - `TestCheckinQuietDayAndTypedReply` — the next request contains `Asked about:\n• Yesterday: Book movers`.
  - `TestCheckinScheduleCatchUpOncePerDay` — two check-ins on one store.
  - `TestCheckinTakesOverACrashedClaim`.
  - `TestCheckinTooLateQuietAndFailure` — the failure half restated: `deliver` rejects, the day is given back, 09:31 sends.
  - `TestCheckinButtonAfterTheTaskMoved`.
  - `TestCheckinDuringAnAgentTurnKeepsBoth` — a check-in during a hanging turn; the next request has both.
  - `TestCheckinChatMustBeAllowed`.
  - `TestCheckinTimeFromSettings` — through the durable task and `rearm`: 09:45 with `10:00` saved sends nothing; 10:30 sends one.
  - `TestCheckinSkipsWhenSettingsUnreadable`.
- **New tests:** a sleep armed for 09:30 that fires at 21:00 sends nothing and writes no record; a redelivered `ci:` press writes once; a stranger's press gets the toast; the status JSON field order; the next-target table of §2.2.
- **Crash test:** kill after the claim and before the deliver commit. Reopen with the clock at +11 min: one check-in, record `sent` with the crashed claim's `since`.
- **Mutations:**
  - The window check skipped after a wake.
  - Settings failure falling back to the defaults.
  - A refused chat marked finished.
  - `/checkin` writing the record.
  - The precondition checked outside the write.
  - The command's or callback's `take` removed.
  - The note dropped.
  - `Finish` before `deliver`.
- **Verify:** `checkinStatus` with no bot is still `{on:false, noBot:true}`; the guide text at `admin-guide.md:281` still matches.

### T5.2: docs notice and the durable daily trigger

- **Files:** `src/tasks/docsync.ts` and its test, `src/docs/schedule.ts` and its test, `bot.test.ts` (the `it.todo`), `main.ts`.
- **Design:**
  - `createDocsNotifier({settings, log})` returns `{notify, attach(deliver)}`. Text: `Documents updated: ` + `counts` + `\n` + `docList(changed, 10)`, through `textMessages`.
    - One `deliver` per configured group, skipping the chat named by a `telegram:<id>` reason.
    - A rejected `deliver` logs `telegram documents notice failed` (`chatId`, `err`) and the others continue.
    - Notices raised before `attach` are held (at most 8): the startup sync runs before the agent opens.
    - No token means no notifier.
  - `docsyncSpec({syncer, schedule, timeZone, now, log})`: `run({target})` syncs with reason `daily` when `target !== null && now >= target`, then returns `nextRun`. With the schedule `off` it returns now + 24 h and never syncs.
  - `startDocsBackground` gets `daily: false` when the spec is wired, so there is one daily run. Startup sync and the minute refresh stay.
- **Tests:**
  - The notice half of `TestDocumentSyncAndNotices` (Go name): first import silent; `Sync("daily")` posts exactly one `Documents updated: 1 added` naming `Oven.pdf`; a no-op `/sync` posts none; the asking chat is skipped.
  - `TestFailedThenFixedImportStaysSilent` through the notifier.
  - One group failing does not stop the next.
  - Across midnight: a run finishing at 23:59 gives 03:00 the next day; a task armed for 03:00 on day D, closed and reopened at 02:00, syncs once at 03:00 and next targets D+1; 2026-11-30 gives 12-01.
  - `off` never syncs.
  - A sync that throws logs `daily document sync failed` and keeps the schedule.
- **Crash test:** kill inside the daily sync. Reopen: it runs again, one index write.
- **Mutations:**
  - A notice on the first import.
  - The `telegram:` skip removed.
  - A sync at creation (`target === null`).
  - The in-process daily timer left on (two syncs).
  - `nextRun` computed from the old target.
- **Verify:** the ten ported sync tests are untouched and green.

### T5.3a: restore path, start guard, config

- **Files:** `adapter.ts`, `src/durable/startguard.ts`, `config.ts`, `main.ts`, their tests, `crash-restore-child.ts`, `crash.test.ts`, `docker-compose.yml` (`MOVIN_INSTANCE=dev` for `app-ts` and `app-test`).
- **Step 0:** checks 5–7 in §6.
- **Design:** §2.4 and §4.2. `Config` gains `instance` and `restoreId` (`HARNESS_RESTORE_ID`: optional, trimmed, at most 128 printable characters). One info line per start: `harness start` with `starts`, `restore` (`none`/`id`/`counter`), and for a restore the counts of tasks aborted, submissions withdrawn and intake items dropped.
- **Tests (the `plan.md:135` list):**
  - New ID: run aborted, nothing resent, cursor 0, tasks recreated.
  - Same ID again: normal start.
  - No ID, SQLite behind S3: restore path.
  - Counters equal: normal start.
  - `dev` and `prod` objects independent.
- **More tests:**
  - A new database with S3 ahead is not a restore.
  - The S3 put loses a race and retries with the max.
  - `check` waits while S3 is down and `resume()` has not happened (a delivery's send is not called).
  - A crash before the acknowledging commit reruns the path.
  - A sleeping 429 delivery and a waiting delivery send nothing (13.13).
  - `recent` kept: a redelivered known id is dropped.
  - Epoch rotated, and `agent.epoch` is the new one.
  - A failed abort means no resume and a throw.
  - The config errors.
- **Crash test:** §4.3.
- **Mutations:**
  - `resume()` before the path.
  - The intake clear removed (the bot sends a failure line for the old open turn).
  - Deliveries skipped.
  - `recent` cleared.
  - The epoch not rotated.
  - S3 written before SQLite.
  - `starts === 0` treated as behind.
  - The ID never recorded (the path runs on every start).
- **Verify:** an agent opened with no guard (tests, eval) behaves as today.

### T5.3b: `velero.md`, guide section, README (docs only)

- **Files:** `docs/movin-v3/velero.md`, `docs/admin-guide.md` (new `### Chat history backup` after "Recover older data"), `docs/movin-v3/README.md`.
- **Content:** the six items of t5-spec §10, plus:
  - `ttl: 168h0m0s` for movin's Schedule against `720h` for `velero-default`.
  - The restore order, with a **new** `HARNESS_RESTORE_ID` as a mandatory step and the reason (the blind spot in §3).
  - What the app does on a restore, and the log line to look for.
  - The integrity check: `PRAGMA integrity_check` and a row count.
  - The S3 paragraph from 14.7.
  - "Not backed up until T6.7".
- **Rules:** commands are written for ZY to run, each ending with `--kubeconfig kubeconfigs/zy-all-in-one.conf`, each marked read-only or state-changing. No secret values. Nothing is applied in this step.
- **Verify:** every command names its namespace; the label line matches the 2026-11-22 entry in `decisions.md`.

## 5. Risks, the restore path, and the proof

### 5.1 Risks

- **Counter blind spot** (§3). Mitigated by the runbook only, until ZY decides.
- **False restore from a shared instance name.** A laptop run with `MOVIN_INSTANCE=prod` on the real bucket bumps prod's object, and prod's next start drops its pending replies. Two dev databases on `dev` do the same to each other, which is harmless but noisy. Say so in `velero.md` and next to the config field.
- **`restartLimit` is 5.** A schedule task cut off five times in a row is faulted by the scheduler. `ensureSchedules` replaces it at the next open; log the replacement.
- **Duplicate check-in** after a crash between the deliver commit and `Finish` (§2.2). Accepted, same class as Go.
- **A failed delivery leaves the day `sent`.** Known difference; visible in `lastError`.
- **One replayed update after a restore.** An update accepted by the lost timeline but never confirmed to Telegram (a crash between `accept` and the next poll) is redelivered and run again under the new epoch. The window is one request long.
- **`adapter.ts` grows** by about 350 lines from 2395. Do not split it during T5; the final strict review can decide.
- **Wake cost:** 96 commits a day per schedule. Check in T5.1b that 1000 wakes do not grow the database without bound.
- **Approval points:** none for ZY in T5.1–T5.3a. T5.3b writes commands and runs none. The hourly-bump fix needs ZY.

### 5.2 What the restore path does with what T4 added

| Thing | Action | Why |
|---|---|---|
| Unsettled submissions (`inspect().submissions`) | `abortSubmission`; `already_placed` is covered by its task | A queued input must not start |
| Every live task from `inspect().tasks`: generations, tools, compactions, deliveries (pending, waiting, sleeping), schedule tasks | `abortTask(id)`; `terminal` is fine; any other failure stops the start | Never `conversation.abort()`: it starts scheduling and skips background tasks |
| `movin.intake` | `queue = []`, `open = []`, `cursor = 0`; keep `recent` and `acceptedAt` | No waiter means no failure line; Telegram's own pending queue is used |
| `movin.epoch` | New UUID; update the closure variable before the `agent` object is built | New change IDs cannot collide with the lost timeline's |
| `movin.schedule` | Cleared, then `ensureSchedules()` | "Recreate from settings"; the `checkin.json` claim stops a second send |
| `movin.outbox` tail | Left | It points at an aborted, terminal task, so the next delivery proceeds |
| `movin.notes`, `movin.prompt`, `movin.activity`, the directory | Left | A stale note is old context only; the next turn's delta block reports what changed |
| Bot | Nothing | It reads `intake.state()` after open: no open turns, cursor 0 |

### 5.3 The test: a restored database sends no old reply and replays no tool

`crash.test.ts`, "a restored database resends nothing and replays no tool". The parent hosts MinIO, the LLM stub and the outbox recorder.

1. **Child A** (directory 1, instance `dev`, real clock) sets up four things, then the parent SIGKILLs it:
   - chat 111 submits a turn whose `add_entry` writes to the bucket and then hangs (an open turn, a pending tool);
   - chat 111 has a second item queued behind it;
   - chat 222 has a two-part delivery whose first send hangs;
   - chat 333 has a delivery sleeping on a 429.
2. The parent copies `harness.db`, `-wal` and `-shm` to directory 2. That copy is the snapshot.
3. **Child B** opens directory 1 normally and finishes. Record: 111's reply sent once; one entry; one journal record; 222 and 333 delivered; `starts` is 2 on both sides. This is also the "counters equal → normal start" case, and the control: the same state without the restore path does resend and does re-run the tool (deduplicated by its change id).
4. The parent notes the recorder length, the stub's request count, the tool's execution marker count and the journal length.
5. **Child C** opens directory 2 with no restore ID (SQLite 1, S3 2), starts the bot against the fake API, and waits until every conversation is idle. A new message for chat 111 then arrives. Assert:
   - before the new message: zero recorder sends, zero stub requests, the tool marker unchanged, the journal unchanged;
   - the ledger is `queue: []`, `open: []`, `cursor: 0`, and `recent` still holds the old ids;
   - the epoch differs from A's;
   - no live delivery task; exactly one sleeping schedule task per name;
   - the log has `harness start` with `restore: "counter"`;
   - the new message is answered once, and its write gets a change id that is not in the journal.
6. **Variants in the same file:**
   - Directory 2 opened with `HARNESS_RESTORE_ID=r1` and the counters forced equal gives the same assertions with `restore: "id"`.
   - Reopening that directory with `r1` again is a normal start (`restore: "none"`).
7. **Mutations that must fail it:** `resume()` moved above the path (recorder and stub counts rise); deliveries not aborted (222's part arrives); the intake kept (the failure line for 111 arrives).

## 6. Open questions (coder Step 0 checks)

For T5.1b:

1. A conversation-owned `background: true` task created from `harness.commit` survives a reopen, and `inspect()` shows it `sleeping` with `until` before `resume()`.
2. `waitForIdle` on its owner and on other conversations ignores it.
3. `abortTask` on a sleeping task, with scheduling on, disarms the timer and runs the abort handler.
4. Whether pi-durable has a call that wakes a sleeping task early. If so, `rearm` uses it instead of abort and recreate.

For T5.3a:

5. `abortTask` and `abortSubmission` before `resume()` resolve, start no scheduling and run no task code. T0.2 R2 measured this for a run; confirm it for a delivery and for a sleeping background task.
6. After `resume()`, an aborted generation settles its submission, and `settings.afterFailedRun` (`harness/types.d.ts:621`) starts nothing new.
7. A task that was `running` at the kill shows as `pending` in `inspect()`, and aborting a generation whose tool child is pending leaves the tool unexecuted.

For the main session:

- **ZY, on return:** fix the counter blind spot with an hourly bump, or accept "the explicit ID is mandatory"?
- **Evidence I do not have:** whether `saveCheckin` has a single call site (`admin.ts:187-211`) for the `rearm` hook. `grep -n saveCheckin app/src -r` answers it.
