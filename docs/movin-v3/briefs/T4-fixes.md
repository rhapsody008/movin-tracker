# T4 fixes (phase review round 1)

The review is `briefs/T4-review1.md`, by ts-reviewer, verdict REQUEST CHANGES. Fix every blocker and major, plus minors 1, 2 and 4. Minor 3 stays as it is: it is consistent with `promptState`.

Each fix comes with a test that fails without it. The required mutation for each is listed at the end.

## Blockers

**B1: the cursor must be able to go back.**
- `accept` sets `doc.cursor = batch.cursor` unconditionally.
- The bot sets `cursor = last + 1` (not `Math.max`).
- Remove or replace the adapter test "never takes the cursor back", and replace the T4.2a mutation it served.
- Extend the reset-guard test in `bot.test.ts`: after the reset batch (id 3), push ids 4 and 5. Both must be answered, and the next poll offset must be 6.

**B2: the request id is `tg:<chat_id>:<message_id>`.**
- `message_id` is unique per chat forever; `update_id` is re-randomised after a quiet week.
- Payload or address already carries `messageId`.
- Test: two different updates whose `update_id`s collide (same id after a simulated reset, different `message_id`) in one chat. Both are answered with fresh model calls.
- Also, when the stale guard triggers (polling from 0 after 6 quiet days), `recent` holds only ids that Telegram dropped long ago, because Telegram keeps updates for at most 24 h. So the batch accepted from a stale poll must not be deduped against `recent`.
  - Add an `accept` option `{fresh: true}` that clears `recent` before appending. The bot passes it for the first non-empty batch of a stale poll.
  - Test it.
  - Record the reasoning in `decisions.md`.

**B3: `/think@botname`.**
- In the command branch, use `commandOf(text)`'s `rest` with `think: true`, so the `@target` check applies as for every command.
- A bare `/think@bot` gets `THINK_HINT`.
- Add both `@bot` cases to `TestThinkCommand`.
- Keep `display` as typed.

## Majors

**M1: no LLM configured.**
- Move `NO_CONNECTION_MESSAGE` from `server/chat.ts` to `agent/reply.ts`, and import it in both places.
- In the bot's `message()`, resolve the connection the way `chat.ts:131` does. If `baseUrl` or `model` is empty, `settle` with `FAILURE_PREFIX + NO_CONNECTION_MESSAGE` (Go `agent.go:152-154`), with no submit.
- Test it.

**M2: respect `take`'s result.**
- At each `take` call site, `if (!(await agent.intake.take(item.id))) return …;` so nothing acts on a lost take.
- Test: take the item from outside first (simulating a second waker); the job then does nothing.

**M3: workers and `stop()`.**
- `drain` checks `stopping.signal.aborted` before each job and returns; the rest is durable.
- After a job throws (message or recover), stop that chat's worker instead of continuing, and log it. Commands and callbacks were already taken, so for those, log and continue.
- `stop()` waits for in-flight jobs to reach a safe point, or document why it doesn't need to.
- Test: stop while two items are queued. No job starts after stop, no `telegram handler panicked`, and a reopen answers both.

**M4:** `run()` never rejects unhandled. Wrap `recover()`, log, and make `main.ts`'s `void bot?.run()` catch and log.

**M5: the reset-guard flake.**
- `fake-api.ts` records an offset only for polls it answered, not ones whose client went away.
- Fix the comment at `bot.test.ts:870`.
- Run `bot.test.ts` 5 times in a loop and paste the results.

**M6:** delete the 6 s sleep and the `DEBUG2` `console.log` in `telegram/crash.test.ts:274-285`. Rely on `waitFor`.

**M7: rejected-list parity with Go.**
- `refuse` records a row when `from` is missing, with `fromId` `"0"` as Go does (`bot.go:309`). Check Go's exact condition, `from == nil || !from.IsBot`, and port it.
- Auth check 2 for a callback sends only the toast: no row and no log line (`bot.go:536-541`).
- Fix `bot.ts`'s header (lines 23–27) to match, and correct the T4.2b decision entry.

**M8: log lines.**
- Add `telegram agent turn failed` (`bot.go:440`) for failed turns, with Go's fields.
- The migration goes through the same path as `reject`, logging `telegram message ignored`.
- `getMe failed` uses Go's field name `in`.
- Check every other `log.` call in `src/telegram` against Go's message text and field names, and list any you changed.

## Minors
1. Remove the doubled `/**` in `adapter.ts` around line 1187.
2. Make `OpenTurn.submission` a number end to end, with no `Number()` round trip. Old ledger docs don't exist in production yet, so no migration is needed.
4. The idle wait in `submit` honours the caller's signal: if it aborts while waiting, return `aborted()` without submitting. Derive the wait's context from the signal, using the pi-durable API that `durable-api.md` lists for contexts and confirming it in the `.d.ts`, or race the wait against the signal. Test: a Stop during the idle wait returns `aborted` promptly and no run is created.

## Rules
- **Allowed paths:** `app/src/telegram/**`, `app/src/durable/**`, `app/src/agent/reply.ts`, `app/src/server/chat.ts` (the import only), `app/src/main.ts`, `docs/movin-v3/plan.md` (line 76: `requestId tg:<chat_id>:<message_id>`), `docs/movin-v3/decisions.md` (append "T4 fixes").
- No new npm packages, no git, never read `.env`, never run `docker compose config`.
- Only `adapter.ts` imports pi-durable.
- Prove every claim by running it and paste the real output.
- Write with spaces; never put raw tabs or control characters in tool arguments, and write `\n` inside TS strings as an escape. Run `make -C app format`. Zero Biome infos.

## Verification (paste real output)
1. A table of fix → test → the mutation that reverts it → the failing test name, for B1–B3 and M1–M5, M7 and minor 4.
2. `make -C app lint`.
3. The full suite with `--maxWorkers=3`, run twice.
4. Root `make lint`.
5. `git status --short`.
