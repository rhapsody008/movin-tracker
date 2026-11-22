<!-- ts-reviewer 4ae114a6-9b03-437, T4 phase review round 1, saved verbatim -->
**REQUEST CHANGES**

There are three blockers. Two of them make the bot miss or wrongly answer messages after Telegram re-randomises update ids, and the third is a Go-parity bug in `/think`. Lint is clean and 202 tests pass, but one of those tests (`bot.test.ts:876`) asserts the first bug as correct behaviour.

**House style I judged against:** errors are turned into result values (`ended()`); logs are `log.warn(msg, {fields})` and Go's messages are kept; settings and clock are injected; text uses the `goTrimSpace`/`goFields` helpers; JSON goes through `goMarshal`/`Ordered`; tests are vitest with real-process SIGKILL crash children and a fake Bot API on `node:http`.

## Blockers

### B1. The update-id reset guard never works: the cursor can't go back
- **Where:** `adapter.ts:1332` has `if (batch.cursor > doc.cursor) doc.cursor = batch.cursor;`, and `bot.ts:446` has `cursor = Math.max(cursor, last + 1);`.
- **What happens:**
  1. After 6 days of silence the bot polls at 0 and gets a random lower id, say 3.
  2. It accepts that batch, but the cursor stays at the old high value (51).
  3. The next `getUpdates(51)` confirms everything below 51, and Telegram drops it, so updates 4…50 are lost.
  4. The bot stays deaf until there are 6 more silent days, then it happens again.
- **Against the plan:** T4-plan §4 says "The cursor is set to the batch's last id + 1, never `max`."
- **The test agrees with the bug:** `bot.test.ts:876` waits for `offsets…includes(51)`. It pushes only one new update, so it never sees the loss.
- **Fix:**
  - `accept` sets `doc.cursor = batch.cursor` and the bot sets `cursor = last + 1`, since a batch polled at the stored cursor can only move it forward.
  - Extend the test: after the reset, push ids 4 and 5 and assert both are answered.

### B2. `requestId: tg:<update_id>` can collide after an id reset, so a new message gets an old reply
- **Where:** `bot.ts:711` sets the id; the new pre-check is at `adapter.ts:1546-1550`.
- **What happens:**
  - The dedupe is per conversation and never expires.
  - After a reset, the new random sequence can reuse an id this chat already had.
  - `submit` then takes the duplicate path: `attachTo` replays the old settled result, the new message never runs, and the user gets a stale answer.
- **Against Go:** Go has no such dedupe.
- **Fix:** use an id that is unique per chat forever, for example `tg:<chat_id>:<message_id>`. Telegram never reuses `message_id` within a chat. The plan line `plan.md:76` needs amending; tell ZY.

### B3. `/think@botname` is sent to the model as plain text
- **Where:** `bot.ts:696` calls `parseThink(typed)`, which is the web's `ParseThink`.
- **Against Go:** `commands.go:43-58` cuts the first word at `@` and uses `rest`.
- **What happens:**
  - Groups send `/think@movin_bot …` from the command menu. `parseThink` sees `rest[0] === "@"` and returns `think:false`.
  - So the whole `/think@movin_bot foo` goes to the model without thinking.
  - A bare `/think@movin_bot` also goes to the model instead of getting `THINK_HINT`.
- **Fix:** in the command branch, use `commandOf(text).rest` with `think: true`, and add the two `@bot` cases to `TestThinkCommand`.

## Majors

### M1. The "no LLM configured" line isn't implemented
- **Where:** `bot.ts:704-722` and `format.ts:21-26`.
- **Against Go:** `agent.go:152-154` returns `no LLM endpoint or model is configured; set one in Settings → LLM` without calling a model. T4-plan §2.6 Q6 says to use it.
- **What the port does:** the web route checks this at `server/chat.ts:131`. The bot and the adapter never check, so the turn goes to the model with an empty URL and fails with some other detail. No test covers it.
- **Fix:**
  - Move `NO_CONNECTION_MESSAGE` to `agent/reply.ts`.
  - In `message()`, check `baseUrl === "" || model === ""` and call `settleText(FAILURE_PREFIX + …)`.
  - Add a test.

### M2. The result of `take` is ignored
- **Where:** `bot.ts:593`, `:625`, `:664`.
- **Problem:** the API's whole contract is "true only for the first caller", but `command()` and `callback()` act whatever it returns. At-most-once then rests entirely on no job ever being woken twice. That holds today, but not under T5.3's restore path.
- **Fix:** `if (!(await agent.intake.take(item.id))) return true;` at each site, plus a test.

### M3. Workers keep running after `stop()` and call a closed agent
- **Where:** `bot.ts:534-549` and `main.ts` (shutdown).
- **What happens:**
  - `stop()` only stops polling. `drain` keeps starting jobs.
  - Once `opened.close()` runs, every remaining job throws, logs a misleading `telegram handler panicked`, and the loop moves on to the next job.
  - The same "continue after a throw" means a failed `settle` (item still open) lets the chat's next turn run first, so replies can arrive out of order.
- **Fix:**
  - In `drain`, check `stopping.signal.aborted` before each job; anything left is durable.
  - After a throw in a message or recover job, stop that chat's worker (as for `isUnsettled`) instead of continuing.

### M4. `void bot?.run()` can reject with nobody listening
- **Where:** `main.ts:398`, and `recover()` at `bot.ts:269`.
- **Problem:** `recover()` (`agent.intake.state()`) is the one await in `poll()` with no handler. If it rejects, the process dies from an unhandled rejection instead of logging.
- **Fix:** add `.catch` with a log, or wrap `recover()` the way `accept` is wrapped.

### M5. The reset-guard test is timing-dependent, which explains the `expected 51 to be +0` flake
- **Where:** `fake-api.ts:127` and `bot.test.ts:868-872`.
- **Cause:** the fake API records an offset when the request arrives at the server. The first rig's aborted `getUpdates(51)` can arrive after `before` is captured, so `offsets[before]` is the old process's 51.
- **Fix:** record offsets only for polls that were actually answered (not `gone`), or tag the offsets per client. Also fix the comment at `:870` ("the ledger says 6"; it is 51).

### M6. Debug leftover in the crash test
- **Where:** `telegram/crash.test.ts:274-285`.
- **Problem:** an unconditional 6 s sleep plus a `console.log("DEBUG2 ledger=" …)`. It inflates the case to 6.9 s and is noise in the output (it showed in my run). `waitFor` with its 25 s deadline already covers the retry.
- **Fix:** delete both.

### M7. Rejected-list parity with Go
- **Where:** `bot.ts:508` and `bot.ts:590-594`.
- **Problem 1:** `refuse` returns early when `from === undefined`. Go records a row whenever `from == nil || !from.IsBot` (`bot.go:309`), so Go records it with `fromId 0`. The port records none.
- **Problem 2:** for a callback, auth check 2 calls `refuse` (a row and the log line). Go's `handleCallback` (`bot.go:536-541`) only sends the toast; it records no row and writes no log line. The file header (`bot.ts:23-27`) says the opposite of the Go source.
- **Fix:** match Go in both places, or record the deviation in the decisions log.

### M8. Missing or renamed log lines compared with Go
- **Missing:** `telegram agent turn failed` (`bot.go:440`).
- **Missing:** the migration's `telegram message ignored` line. Go's migration goes through `reject` (`bot.go:302`), which logs it.
- **Renamed:** `getMe failed` uses `retryIn` where Go and spec §2.1 use `in` (`bot.ts:320`).
- **Fix:** match Go's field names and add the two missing lines.

## Minors
1. `adapter.ts:1187-1188` has a doubled `/**` opener.
2. `OpenTurn.submission` is a `string` that `attach` turns back with `Number()` (`adapter.ts:1738`). Storing the number would avoid the conversion and its NaN path.
3. The duplicate pre-check spends a write commit on a read (`adapter.ts:1548`). It is consistent with `promptState`, but the committed-read form at `types.d.ts:1174` exists.
4. The idle wait in `submit` (`adapter.ts:1556`) ignores the caller's signal. A Stop or a watchdog during the wait only takes effect after the chat is idle. It is correct but delayed; a chord context derived from the signal would fix it.

## What holds up
- **Crash windows W1, W3–W8:** they hold as coded. The submit commit moves the item queue→open atomically, `settle` drops it and creates the delivery in one commit, and the delivery's checkpoint moves only after a successful send. Crash tests are real child processes killed with SIGKILL.
- **W2:** holds, apart from B1.
- **Web chat:** I found no deadlock in `submit`'s idle wait or the `serial` chain. Web keys never get deliveries, and nothing the chain waits on needs the chain.
- **`isUnsettled`:** results pass through unchanged everywhere I looked (`serial`'s `.then` and every bot call site).
- **The token:** every client error is rebuilt with the token scrubbed and no `cause`, and `errorMessage` doesn't follow causes. Status and outbox text come only from those messages.
- **`main.ts` ordering:** the bot starts after `openDurableAgent`, and `bot.stop()` runs before `opened.close()`. M3 is the remaining gap.
- **Import rules:** only `adapter.ts` imports pi-durable (the other hits are comments). `src/telegram` has no `.trim()`, and the only `JSON.stringify` is in the test fake.

**Net simplification:** about 15 lines (the debug block, the doubled comment, the string↔number id) and one bad assertion. The fixes add a few lines each.

## Verification run
- `make -C app lint`: Biome checked 149 files, nothing reported; `tsc` clean.
- `docker compose … app-test npx vitest run src/telegram src/durable src/imports.test.ts`: 10 files, 202 passed, 1 todo, nothing skipped, so the MinIO crash cases ran. The `DEBUG2` output appeared in the run (M6).

## Not reviewed
- The bodies of `commands.ts` past `undoLast` and `syncNow`.
- `fake-api.ts` beyond `getUpdates`.
- `crash-*-child.ts` in detail.
- The Go golden generators under `app/golden/`.
- Whether `testdata/*.go.json` match what the generators produce (not regenerated).
- The comment-only path edits elsewhere in `app/src`.
