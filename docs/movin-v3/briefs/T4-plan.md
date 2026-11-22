<!-- planner e5f86084 lineage, 2026-11-22; saved verbatim by the main session -->
# Plan: T4.2 intake and T4.3 delivery (movin-tracker v3)

## 1. Goal and assumptions

- **Goal:** port Telegram intake and reply delivery so that `plan.md:125` and `:127` hold, without stalling the poll loop and without breaking the prompt-state rule (G11/P5a).
- **Your finding is correct.** `submit` holds `serial(key)` from `adapter.ts:996` through `submission.wait` (`:1068`), so a second message's commit waits for run 1. Brief §2a (offset in the submit commit) is rejected.
- **Verdict:** inbox, per-chat workers and stored deadline are accepted with changes. Delivery by `afterRun` and "run commands right after the batch commit" are rejected.
- **Scope of every step:** local repo edits under `app/` by the coder, state-changing in the repo only. Verify with `make -C app lint test`; roll back by reverting that step's files. No new npm packages. No skills apply (this is not `ops/`).
- **Not run:** nothing below was executed. Library claims come from reading `dist/`; the three I could not confirm are in §5.

## 2. Design

### 2.1 Changes to your proposal

| Your item | Verdict | Change |
|---|---|---|
| 1. Durable inbox, offset in the batch commit | Accept | One session doc `movin.intake = {cursor, recent[≤256], queue[], open[]}`. `recent` holds accepted update ids, so dedupe never depends on `submit`. |
| 2. Per-chat workers, entry removed in the submit commit | Accept | The submit commit moves the item `queue → open` with `{submission, deadline}`. Use a neutral `SubmitOptions.intake`, not `alsoCommit(tx)`, which would leak pi-durable's `Tx`. |
| 3. Commands run after the batch commit | Reject | Commands and callbacks go through the same per-chat queue, take-then-act (see 2.4). |
| 4. Delivery by `afterRun` → `runEndTask` | Reject | The host creates the delivery task in a "settle" commit that also drops the ledger item (see 2.3). |
| 5. Watchdog by host tick and `abortTask` | Simplify | Every open turn has an in-process waiter, so the watchdog is a timer on the stored deadline. No tick. |

### 2.2 Three adapter gaps the inbox exposes

All three are in `adapter.ts` and belong to T4.2a.

- **Idle wait.** After a restart `tails` is empty, so a queued message would submit while the recovered run 1 is still going. That is the same prompt-state, `configure` and idle-reset hazard you found. Fix: inside `serial`, before the idle reset, `await conversation.waitForIdle()` (`types.d.ts:818`). This also fixes the web case.
- **Duplicate `requestId`.** `admitSubmission` returns the existing id without writing (`submissions.js:173-180`), but `commitSubmitted` would still write `movin.prompt`, and the idle reset and `configure` would already have run. Fix: check `tx.submissionByRequest` (`types.d.ts:913`) first; on a hit, skip all of that and attach.
- **`closed` and `faulted` are not outcomes.** `submit` answers `failed/closed` during shutdown while the run is still durable. The worker must leave the item `open` and stop. Restart recovery settles it.

### 2.3 Why not `afterRun` for delivery

- It fires only for answered runs. Refusal (`model_error`) and `turn_limit` are "failed" runs that still need `reply.ts`, so the failure sweep would need the reply rules anyway. That makes two paths.
- Run-end tasks are children of the generation and the run waits in `drain` for them (`generation.js:243-255`). An abort of the conversation would take the delivery with it.
- It needs reply rules injected into a library hook, plus a sniff of web against Telegram on every run.

Host settle instead, one path for answered, failed, refused and recovered turns:

1. The worker gets a `RunResult` from `submit`, or from `attach` after a restart.
2. `src/telegram` renders it with `channelReply` into parts, or null for silence.
3. `agent.intake.settle(id, parts)` runs one commit: if the item is still in `queue` or `open`, drop it and `tx.createTask(Delivery, …, {conversationId})`.

The atomic drop gives exactly-once task creation. A crash before it leaves the item open, and startup settles it again from the transcript.

### 2.4 Adapter API (neutral: no Telegram and no `src/agent` import)

```ts
// OpenAgentOptions
outbox?: { send(address: Json, part: Json, signal?): Promise<void> }  // throws {retryAfterMs?} | {permanent:true}
// SubmitOptions
intake?: { id: number; deadlineAt: number }  // queue→open in the submit commit
// Agent
intake: {
  accept(batch: { cursor: number; items: IntakeItem[] }): Promise<IntakeItem[]>; // one commit: skip ids in `recent`, cap 64 per key (drop + log), set cursor
  state(): Promise<{ cursor: number; queue: IntakeItem[]; open: OpenTurn[] }>;
  take(id): Promise<boolean>;                         // remove; true only for the first caller
  settle(id, key, address, parts: Json[] | null): Promise<void>;
};
attach(key, submissionId, { signal }): Promise<RunResult>;  // wait + result; no settlePrompt (P5b)
idle(key): Promise<void>;
deliver(key, address, parts): Promise<void>;                // for T4.4 and T5
// IntakeItem = { id /*update_id*/, key, address: Json, payload: Json, at }
```

- **Shared result code.** `attach` reuses the tail of `submit` (`adapter.ts:1085-1150`), extracted as `resultOf(conversation, settled)`.
- **Delivery task.** `movin.outbox.delivery`, registered through `tasks:` in the existing `movin.agent` extension. No Telegram-only extension is needed, because there is no hook.
  - Checkpoint: `{phase:"send", next, attempts}`.
  - One part per phase run; the commit moves `next` only after a successful send.
  - Retry is a sleeping commit with `attempts+1`.
  - The abort handler settles `aborted` without sending (T5.3 needs this).
  - Conversation-owned and not `background`, so the idle wait in 2.2 orders reply N before run N+1.

### 2.5 Telegram side

- **Poll loop** (spec §2.1, §1.5): `getMe` backoff, `setMyCommands`, then `getUpdates(cursor)`.
- **Per batch, in order:**
  1. Migration notice (spec §3.4).
  2. Auth check 1. A refusal goes to the in-memory rejected list and the log line.
  3. Classify as `message`, `command` or `callback`.
  4. `intake.accept({cursor: last+1, items})`.
  5. Only after the commit: toasts for refused callbacks, and wake the workers.
- **Nothing is sent before the commit.**
- **Worker per chat**, for each item:
  1. `agent.idle(key)`.
  2. Auth check 2. A refusal is `take` plus reject, with no reply.
  3. By kind:
     - **message:** typing on, then `submit(key, group ? name+": "+text : text, {requestId:"tg:<id>", intake:{id, deadlineAt: now+15min}, actor, group, think, display, signal})`, then render, then `settle`.
     - **non-text or bare `/think`:** `settle` with the fixed line. No model call.
     - **command or callback:** `take(id)` first, then act and send directly. A crash loses it and never repeats it. Order within the chat is kept, as in Go: `/undo` sent right after "add X" still runs after that turn.
- **Startup:** read `intake.state()`. Each `open` item gets a waiter (`attach`, with typing and the deadline timer), then render and settle. `queue` items go to the workers. No periodic sweep.
- **Watchdog:** `AbortSignal` at `deadlineAt`. The existing `abortRun` withdraws a queued submission or aborts the conversation, and does nothing once the turn has settled. `conversation.abort()` is precise here, because pi-durable never holds a second queued input for the chat.

### 2.6 Answers to your questions

**Q1. Does the verify list hold? Yes. Crash windows:**

| Window | Durable state | After restart |
|---|---|---|
| W1 before the batch commit | nothing | Telegram redelivers the batch; processed once |
| W2 after the batch commit, before the next poll | queue and cursor | next poll confirms; no redelivery |
| W3 queued, before the submit commit | queue | worker submits once |
| W4 after the submit commit | open and the run | `resume()`, then attach and settle |
| W5 run settled, before settle | open | attach returns at once, then settle; the prompt state echoes once (P5b, accepted) |
| W6 after settle | delivery task | resumes at `next` |
| W7 during a send | `next` not moved | that one part is sent again; earlier parts never |
| W8 command taken, before acting | removed | lost (at-most-once) |
| W9 restore path (T5.3), cursor dropped | — | `recent` and `requestId` drop known ids |

- **Duplicate update:** `recent`, plus `requestId`.
- **409 backoff:** the poll loop is untouched by the inbox.
- **Two chats in parallel:** one worker per chat, `serial` per key.
- **Reword `plan.md:76`:** "accepted durably before the offset moves; submitted with `requestId tg:<update_id>`".

**Q2. Keep both auth checks.** Check 1 runs at poll and decides inbox acceptance. Check 2 runs in the worker after `idle(key)` and before `submit` or `take`, and supplies the actor name. Recovered `open` turns are not checked again, as in Go once `handle` has started.

**Q3. Addressing lives in the ledger item, nowhere else.** `address = {chat, messageId, group}`; it is not copied into the entry `data`. The delivery task carries its own copy once created. The startup waiters and the watchdog read `open`.

**Q4. One extension, with injection.** `outbox.send` is injected through `OpenAgentOptions`, the same way as `tools` and `hooks`. Rendering stays in `src/telegram` and never enters the adapter.

**Q5. Reorder so delivery comes first.** No stub is needed; steps are in §3.

**Q6. Decisions,** all within the main session's authority unless listed in §4:

- **Failure line:** `Sorry, that didn't go through: ` + `truncate(detail, 300)` + Go's change block and keyboard (spec §5.6).
  - `detail` is `channelReply`'s error, which is already scrubbed.
  - Watchdog abort: `the turn took longer than 15 minutes and was stopped` (not the web's `Stopped.`).
  - `settings_error` and "no connection": Go's `no LLM endpoint or model is configured; set one in Settings → LLM`.
- **Send retry:**
  - 429: sleep `retry_after + 1 s`.
  - Transport, timeout or 5xx: 1, 2, 4, 8, 16 s.
  - At most 6 attempts per part, then `failed`, the rest dropped, `lastError` set.
  - 400, 403 or any other 4xx: fail at once.
- **Split:** 4000 code points, Go's algorithm. Trap 3 (emoji-heavy text) stays as in Go.
- **Leading blank lines:** already handled, because `shownText` trims.
- **Typing indicator:** keep it, tied to "someone is awaiting this open turn" (worker or startup waiter), every 4 s, errors ignored.
- **`/sync`:** fully ported in T4.4 on the existing syncer. The group notice stays in T5.2.
- **`/checkin`:** stays in the menu. Until T5.1 it answers `The check-in isn't available yet.`, and `ci:` callbacks get an empty answer.
- **`lastError`:** never cleared, as in Go.

## 3. Steps

Order: T4.3a → T4.3b → T4.2a → T4.2b → T4.4.

### T4.3a: reply formatting (pure)

- **Files:** `src/telegram/format.ts` and its test.
- **Change:** `split`, `truncate`, `changeText`, `undoKeyboard`, `replyParts(channelReply result, address)`, `failureText`.
  - `replyParts` returns `{text, reply_to_message_id?, reply_markup?}[]` or null.
  - First part threaded in groups; keyboard on the last part.
- **Tests:** `TestSplit`, `TestUndoKeyboard`; a table over answered, `Done.`, refusal, cut-off, failed with changes, and silent returning null; `truncate` 300 and 190; callback data ≤ 64 bytes.
- **Verify:** mutations — keyboard on the first part; split by UTF-16 units.

### T4.3b: adapter outbox

- **Files:** `adapter.ts`, `adapter.test.ts`, `crash-outbox-child.ts`, `crash.test.ts`.
- **Change:** the Delivery task, `outbox.send`, `agent.deliver`.
- **Tests:**
  - Parts sent in order.
  - 429 sleeps and then sends.
  - A permanent error stops the rest.
  - Six transient failures end in `failed`.
  - An aborted task sends nothing.
- **Crash tests:**
  - `send` writes a marker and hangs before calling the server; SIGKILL; reopen. Each part is sent exactly once.
  - `send` reaches the recorder and then hangs; SIGKILL; reopen. Total is n+1, the duplicate is that part, no earlier part repeats.
- **Verify:** `imports.test.ts` still green.

### T4.2a: adapter intake

- **Files:** `adapter.ts`, `adapter.test.ts`, `crash-intake-child.ts`, `crash.test.ts`.
- **Change:** the `movin.intake` doc, `accept`, `state`, `take`, `settle`, `SubmitOptions.intake`, `attach`, `idle`, the idle wait, and the `requestId` pre-check.
- **Tests:**
  - `accept` twice with the same ids gives one item.
  - The 65th item for one key is dropped while the cursor still moves.
  - `take` is true exactly once.
  - `settle` twice creates one task.
  - A duplicate `requestId` makes no second run, no `movin.prompt` write, no reset and no `configure` (watch the committed docs).
  - Message 2 for a key is submitted only after run 1 and its delivery are idle.
- **Crash tests:**
  - W3: kill after `accept`. Reopen gives one submission.
  - W4: kill inside the tool with a second item queued. Reopen: `attach` answers, run 2's request contains run 1's answer, one journal record.
  - W5: kill after the run settles and before `settle`. Reopen gives one delivery.
- **Verify:** mutations — remove the idle wait; write the prompt state on a duplicate.

### T4.2b: bot intake and wiring

- **Files:** `src/telegram/intake.ts`, `auth.ts`, `status.ts`, their tests, `fake-api.ts` (test helper), `crash-bot-child.ts`, `main.ts`, and `server/admin` wiring through `TelegramStatusSource`.
- **Go tests ported:**
  - `TestAuthorisation`
  - `TestConflictBacksOffThenRecovers`
  - `TestBotWritesReachSubscribers`
  - `TestOneChatIsSerialisedTwoChatsRunInParallel`
  - `TestGroupChatterGetsNoReply`
  - `TestAllowlistChangeAppliesWithoutRestart`
  - `TestNonTextAndStatusHasNoToken`
  - `TestThinkCommand`
  - The message half of `TestPrivateMessageSavesEntryAndUndoButtonWorks`
  - `TestShutdownFinishesTakenTurns`, restated as: close mid-turn and reopen; both are answered exactly once.
- **New tests:**
  - The watchdog fires at the stored deadline, including after a reopen.
  - A 429 on `getUpdates` sleeps for `retry_after`.
  - The migration row appears in the rejected list.
  - Status JSON order and omissions match Go.
  - Auth check 2 refuses an item queued before an allowlist change.
- **Crash test:** the parent hosts the fake Bot API and the LLM stub; SIGKILL the child mid-turn; the second child produces exactly one reply and one entry.
- **Commands here:** only `/think` and the unknown-command line. The rest is T4.4.

### T4.4: commands and callbacks (unchanged scope)

- Uses `take`-then-act and `deliver`.
- `plan.md:129` holds, because a redelivered id is in `recent` and a taken item is gone.

## 4. Risks and approval points

- **Needs ZY (small):** this amends approved plan lines.
  - `plan.md:76` wording.
  - T4 order becomes T4.1 → T4.3 → T4.2 → T4.4.
  - The T5.3 restore path must also clear `movin.intake.queue` and `open`, and abort `movin.outbox.delivery` tasks. Otherwise restored open turns would get failure lines.
- **Update id reset:** Telegram may pick a random `update_id` after a week with no updates. A stored cursor above the new ids is untested territory. Mitigation: if the last update is more than 6 days old, poll with offset 0 and rely on `recent`. The cursor is set to the batch's last id + 1, never `max`.
- **`restartLimit` 5:** a crash-looping pod can end a delivery `failed`, losing the reply. Log it.
- **A sleeping delivery holds its chat:** bounded at about 31 s of backoff plus any 429 waits.
- **`adapter.ts` size:** it grows by about 400 lines from ~1650. Splitting would mean widening the lint rule to `src/durable/*`. The main session can decide; my recommendation is not now.
- **Callbacks behind a long turn** may expire before they are answered. Go behaves the same.

## 5. Open questions (the coder checks these first in T4.3b, about 30 lines of test)

1. The exact `TaskOptions.ownership` value for a conversation-owned task created from `harness.commit` (`dist/types.d.ts:355-380`).
2. Whether `conversation.waitForIdle()` waits for such a task when it is sleeping. The type comments suggest yes.
3. Whether `Extension.tasks` type-checks under `exactOptionalPropertyTypes` (brief §6).

If 1 or 2 fails, the fallback is a `background` task plus the worker awaiting the delivery's task id, stored on the ledger item, before the next turn.
