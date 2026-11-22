# T5 fixes, round 1

The review is in `briefs/T5-review1.md`; read it in full. Fix every item listed here. Main-session decisions are in **bold**.

## B1: two flaky crash tests
- **Restore test** (`app/src/durable/crash.test.ts:~1061`): after the settle, control B waits for chat 111's delivery before it closes, as the review suggests (`whenIdle(b.agent, CHAT)` or an equivalent). The assertion stays as it is.
- **Schedule test** (`crash-schedule-child.ts:58`, `crash.test.ts:855-867`): the child prints a `slept` line only once `inspectSchedules` shows the task `sleeping` with its target, and the test kills only after that line. Do the same in the overdue-at-open case.
- **Proof:** run `src/durable/crash.test.ts` **10 times** in a loop, and paste the pass count from each run. It must be 10 out of 10.

## B2: `rearm` and the schedule guard
pi-durable's `Tx` has no abort (`types.d.ts:895-960`), so "abort and recreate in one commit" is impossible.
- **Accepted design:** the abort is its own commit, and every reader tolerates the gap:
  1. `ensureSchedules` and `rearm` treat a task with `abortRequested` as gone, the same as `terminal`. `ensureSchedules` at open then replaces an abort-marked task.
  2. `rearm(name)` runs inside `serial(\`${SCHEDULE_KEY}:${name}\`)`, or an equivalent per-name chain local to the adapter.
  3. `createSchedule`'s commit re-reads the guard, and writes only when `guard.by[name]` still equals the id the caller saw. When it doesn't, it returns the current id and creates nothing.
- **Tests:**
  - concurrent `rearm` ×2: there is exactly one live `movin.schedule` task for the name afterwards, and the guard points at it;
  - an abort-marked task at open: crash or close between the abort and the create (inject this through an adapter test seam if needed), then reopen. Exactly one live task, and it runs.
- **Mutations:**
  - remove the `abortRequested` check, and the abort-marked test must fail;
  - remove the serialisation or the guard compare-and-set, and the concurrent test must fail.
- **`decisions.md`:** correct the T5.1b "check 4" claim. Say the abort is its own commit, and why that is safe.

## M1: a note that arrives during submit is lost
- **Fix:** the admission commit removes only the notes it read. Match each on `tag` and `text`, or give notes an id if they have one or can cheaply get one. A note delivered between the read and the admission commit survives into the next turn.
- **Test:** a delivery with a note lands while `userContent` (the async hook) is running. Use a hook that awaits a gate the test controls. Assert:
  - the note is absent from this turn's content;
  - it is present in the next turn's;
  - it is cleared after that.
- **Mutation:** restore `pending.length = 0`, and the test must fail.

## M2: `startguard.pause`
- **Fix:**
  - Use `setTimeout(ms, undefined, {signal})` from `node:timers/promises`.
  - Check `signal.aborted` before logging the warning, and throw at once when it is set.
- **Test:** abort the signal during `store.get`. Assert there is no `harness start counter unreadable` line and the check rejects promptly. Use fake timers or a real clock bound below 500 ms.

## Minors
1. **`committed()`:** after a `PreconditionError`, do one plain `get` with no retry. If that fails, warn `harness start counter not saved` and return. Add a test where the S3 read fails after the precondition, and `committed` must resolve.
2. **Import rule for `startguard.ts`:** **widen it** to objstore, gojson, gostr and log, the leaf modules. Pin the rule in `app/src/imports.test.ts`, which already holds the adapter rule. Mutation: add an import of `./adapter.ts` or `../agent/...` to `startguard.ts`, and the test must fail.
3. **`admin.ts:158`:** put the doc comment on its own line.
4. **`docsync.ts`:** don't log `daily document sync failed` when the run's signal is aborted, as in Go's `internal/docs/schedule.go:55`. Add a test.

## Rules
- **Allowed paths:**
  - `app/src/durable/**`;
  - `app/src/imports.test.ts`;
  - `app/src/server/admin.ts`;
  - `app/src/tasks/docsync.ts` and its test;
  - `docs/movin-v3/decisions.md`: append "T5 fixes, round 1", and correct T5.1b check 4 in place.
- **Another coder (T6) is working in parallel** on `app/Dockerfile`, `app/Makefile`, `docker-compose.yml`, `deploy/**`, `.github/**`, `.env.example` and `progress.md`. It may also append to `decisions.md`, so re-read that file right before you edit it, and make one small `edit`. Don't touch the T6 coder's files. It may run `make -C app test`; if a run collides, rerun it.
- **Environment:**
  - No new npm packages, no git.
  - Never read `.env`. Never run `docker compose config`. Use MinIO only.
  - Format only your own files with `npx biome check --write <files>`. Never run `make -C app format`.
- Write with spaces, never raw tabs or control characters in tool arguments.

## Verification (paste the real output)
1. `make -C app lint`.
2. The 10× `crash.test.ts` loop.
3. Your test files.
4. The full suite with `--maxWorkers=3`.
5. Root `make lint`.
6. The mutation table.
