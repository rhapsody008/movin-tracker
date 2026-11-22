# T5 phase review, round 1 (ts-reviewer `74695f0b-0c2c-449`, verbatim)

**REQUEST CHANGES**

I found 2 blockers, 2 majors and 3 minors. Lint passes, but the crash tests are flaky, and there are three real ways to lose or duplicate work: a lost check-in schedule, a duplicated one, and a lost check-in note.

**House style I judged against:** only `adapter.ts` imports pi-durable; host code is plain functions plus small interfaces; errors are plain `Error` with `{cause}` or typed subclasses; logging goes through `log.ts` with Go's message text and fields; clocks and timers are injected; tests use vitest with fakes and real MinIO, and crash children are separate processes.

## Blocker

### B1. Two crash tests are flaky and fail about 2 runs in 7
- **Location:**
  - `app/src/durable/crash.test.ts:1061`
  - `app/src/durable/crash-schedule-child.ts:58` together with `crash.test.ts:855-867`
- **Evidence (rerun by me):** I ran `crash.test.ts` 7 times; 5 runs passed.
  - Run 1: `expected [ '222a', '222b' ] to deeply equal [ '222a', '222b', 'Saved it.' ]`
  - Run 3: `runs an overdue schedule at once…`: `expected [ null ] to deeply equal [ 1795329154155 ]`
- **Cause:**
  - **Restore test:** after `settle()` creates chat 111's delivery, control B waits only for `SENDING` (tg:222) and then calls `close()`. 111's "Saved it." delivery races the close.
  - **Schedule test:** the child writes the marker inside `run`, before the `sleepUntil` commit. If the kill lands in that gap, the reopen reruns with `target: null`.
- **Impact:** the main session's "1277 passed" happens to be one of the green runs. A flaky crash test cannot back the "restart mid-sleep keeps the schedule" claim.
- **Fix:**
  - Add `await whenIdle(b.agent, CHAT)` after the settle.
  - Have the child write a `slept` line only once `inspectSchedules` shows `sleeping`, and make the test wait for that line, as the restore child does with `ready`.

### B2. `rearm` uses two commits and is not serialised, so it can lose or duplicate the schedule task
- **Location:** `app/src/durable/adapter.ts:1593-1643`
- **Brief vs code:** `T5.1b.md:51` says "abort the task and create a new one **in one commit**", and `decisions.md` (T5.1b, check 4) says it does. The code instead calls `harness.abortTask` (its own commit), then `createSchedule` (a second commit). pi-durable's `Tx` (`types.d.ts:895-960`) has no abort, so one commit is not possible. That fact is not recorded anywhere.
- **Failure 1 (lost task):** a crash or close between the two commits leaves the guard pointing at an abort-marked `sleeping` task.
  - `ensureSchedules` keeps it, because it only checks `status !== "terminal"` and ignores `TaskRecord.abortRequested` (`types.d.ts:649-650`).
  - `resume()` then runs the abort handler, and the process has **no check-in task until the next restart**.
  - The T5.1b coder saw this exact effect in a test ("an abort-marked task… the replacement is then never created") and only worked around it in the `abortSchedules` helper.
- **Failure 2 (duplicate task):** two overlapping `PUT /api/settings/checkin` requests (a double-click, or two tabs) both see `sleeping`.
  - Both call `abortTask`, which returns `"marked"` and does not throw.
  - Both call `createSchedule`, which blindly sets `guard.by[name] = id`.
  - Two live `movin.schedule` tasks now loop for ever. Only the one in the guard is ever looked at again, so the other survives every normal restart.
- **Fix:**
  - In `ensureSchedules` and `rearm`, treat `abortRequested` the same as terminal.
  - Run `rearm` through `serial(\`${SCHEDULE_KEY}:${name}\`)`.
  - In `createSchedule`'s commit, skip when `guard.by[name] !== was`.
  - Add a concurrent-rearm test and an abort-marked-at-open test.
  - Correct the claim in `decisions.md`.

## Major

### M1. A note that arrives mid-submit is cleared without ever being shown
- **Location:** `adapter.ts:2002` (`pendingNotes`, a snapshot read outside any commit) and `adapter.ts:1480` (`pending.length = 0`)
- **Problem:** `deliver` does not go through `serial(key)`. A check-in `deliver` that commits during `submitted()` (the async `userContent` hook, which reads S3) adds a note. The admission commit then wipes it along with the notes that were read.
- **Impact:** at 09:30, with a user typing at the same moment, the next turn loses the morning check-in context, which is what the note exists for. No test covers this window. `TestCheckinDuringAnAgentTurnKeepsBoth` only covers a note arriving after admission.
- **Fix:** in the admission commit, remove only the notes that were read (match on `tag` and `text`), and add a test that delivers between the read and the commit.

### M2. `startguard.pause` reimplements a stdlib timer and misses an already-aborted signal
- **Location:** `app/src/durable/startguard.ts:152-194`
- **Problem:** if the shutdown signal aborts during `store.get`, the `AbortError` lands in the retry branch. It logs a false `harness start counter unreadable`, then `pause` adds a listener to an already-aborted signal; that listener never fires. The pod then sleeps up to 30 s inside its SIGTERM grace period.
- **Fix:** use `setTimeout(ms, undefined, { signal })` from `node:timers/promises`, which rejects at once on an aborted signal. Also check `signal.aborted` before warning.

## Minor

1. **`committed()` can block `resume()` for ever.**
   - **Location:** `startguard.ts:121-126`.
   - **Problem:** after a `PreconditionError` it calls `read()`, which retries without end during an S3 outage. The plan and the code comment both say a failure here "only warns".
   - **Fix:** do a single plain `get` here, not the retrying `read()`.

2. **The import rule for `startguard.ts` is broken and not pinned.**
   - **Problem:** `startguard.ts` also imports `gostr.ts` and `log.ts`; `T5.3a.md:115` says objstore and gojson only. `imports.test.ts` has no rule for it.
   - **Fix:** either widen the brief's rule or add the rule to the test.

3. **Two small leftovers.**
   - `admin.ts:158` has a doc comment glued onto `async function telegramBody()` on the same line, left behind by an edit.
   - `docsync.ts` logs `daily document sync failed` even when the sync was aborted by shutdown; Go skips it when `ctx.Err() != nil` (`internal/docs/schedule.go:55`).

## What I found correct
- Go parity of the tick, `/checkin`, the `ci:` callback and the toasts checked out line by line against `checkin.go:193-474`.
- The restore order is right: refresh, then check, then aborts, then one acknowledging SQLite commit, then `ensureSchedules`, then the S3 put, then `resume()`. Each step is idempotent on a rerun, and nothing is scheduled before `resume()`.
- The decision rules for "new database", "id" and "counter" are right.
- pi-durable calls match `harness/types.d.ts:850-861` and `context.abortSignal` exists in chord's `context/index.d.ts:10`. No `any` and no casts on untrusted input.

## Net simplification
- About 15 lines in `pause`.
- B2's fix is about 6 lines and makes no new abstraction.

## Verification run
- `make -C app lint`: 161 files, no fixes, `tsc` silent.
- Targeted vitest over the T5 files (12 files): 328 passed, 1 failed (B1, restore test).
- `crash.test.ts` alone, 3 runs: pass, fail (B1, schedule test), pass.
- `crash.test.ts`, `src/telegram/crash.test.ts`, `src/tasks` and `adapter.test.ts`, 3 runs: 182/182 each time.

## Not reviewed
- The T5.3b documents beyond a grep for the restore id and `MOVIN_INSTANCE`.
- The text and keyboard bytes of `src/telegram/checkin.ts`; I relied on its golden instead of reading `app/golden/t51/main.go` line by line.
- The full `bot.test.ts` check-in cases.
- The test-by-test mutation claims for T5.1a and T5.2; I only spot-checked one.
