# T2 fixes: phase review round 1 (ts-reviewer `3e733192-1482-48c`, REJECT)

The main session decided every item below. Fix them in order, each with a test that fails without the fix.

## Allowed paths
- `app/src/**` and `app/tools/ui-check/**`.
- `docs/movin-v3/decisions.md`: append only, under a new heading "T2 review round 1".
- `tmp/t2x-mut.mjs` (new).

No new npm packages, no git. Write with spaces and run `make -C app format`. Never put raw tabs or control characters in tool arguments.

## Items

### Blockers
- **F1 (blocker):** the key can leak through `JSON.parse` messages.
  - **Problem:** V8's message quotes the input. `node -e 'JSON.parse("sk-live-…")'` gives `Unexpected token 's', "sk-live-…" is not valid JSON`.
  - **Fix:**
    - In `src/llm/models.ts` and `src/llm/probe.ts`, never surface a `JSON.parse` message. Use fixed tails: `decode models list: invalid JSON` and `decode chat response: invalid JSON` (check Go's prefixes in `openai.go:126` and `:171`).
    - Also pass every error that leaves `src/llm` through `scrub(…, apiKey)` as a backstop.
  - **Tests:** a fake endpoint answers 200 with the body equal to the key, and with `{"a": <key>`, on both `/models` and `/test`. Assert that the key appears nowhere in the response bodies or log lines.
  - **Docs:** record the rule in `decisions.md`: errors from `src/llm` never include a body parser message.
- **F2 (blocker):** the verb in network errors.
  - **Fix:** build it from the method as Go's `urlErrorOp` does (`net/http/client.go:546-553`: first letter upper-case, rest lower-case, so `Get` or `Post`).
  - **Tests:** fix `probe.test.ts:103` to expect `Post "…/chat/completions"`. Extend the transcript mask to `(Get|Post) "<url>": ` only if the Go transcript has a Post network error; otherwise leave it.

### Major
- **F3:** in `listModels`, a missing or null `data` gives `[]`, as Go does. A non-array value is still an error. Add the `{}` and `{"data":null}` tests.
- **F4:** `encodeTestResult` follows Go `omitempty`: leave out `models` when it is empty, and leave out `modelsError` and `error` when they are `""`. Add a test with an endpoint that lists no models.
- **F5:** `closeStreams` sets a permanent `closing` flag.
  - A stream that starts afterwards sends its first `entries` event and then ends, as Go's closed channel does.
  - Test: open a stream after `closeStreams` and assert that it ends.
- **F6:** a docs event before the SSE headers.
  - **Fix:** a docs signal that arrives before the first `entries` event is remembered and sent after it. Use the same pending/started pattern as entries; `send()` never writes before `startSSE`.
  - **Test:** a docs signal fires during a slow `current()`. Use a fake entries wrapper with a gate. The stream must be well formed: headers, `entries`, then `docs`.
- **F7:** LLM calls are tied to the request.
  - **Fix:** `/api/settings/llm/models` and `/test` pass a signal that aborts on `res.on("close")` when the response is not finished. It goes to `listModels`/`probe` and through to `fetch`, alongside the timeout.
  - **Test:** a client aborts mid-call. The fake endpoint sees its request socket close, or the call is aborted, within about 1 s.
- **F8:** in `TestStorageProbeRefusesASecondRun`, after the first probe finishes, run a third probe and expect 200 with `ok:true`. Add the mutation "remove the release".
- **F9:**
  - Move `goTimeJSON` to `src/gostr.ts`, next to `goStamp`.
  - Add table tests: `.000Z`→`Z`, `.810Z`→`.81Z`, `.123Z` unchanged, and a whole-second value.
  - In `admin.test.ts`, assert the exact `at` string for the S3 store, rather than checking that it is a string.
- **F10:** in `admin.ts`, replace `sameBytes` with `Buffer.compare(a, b) === 0` and delete the helper.
- **F11:** delete `docView`/`DocView` from `entries/model.ts` and their test. Fold the shape assertion into a test of `encodeDocView`, if that test doesn't already cover it.
- **F12:** remove the `scanJsonValue` wrapper. Export the scanner under one name and update `http.ts`.
- **F13:** `GUIDE_FILE` and `MOVIN_DOCS` go into `Config` (`guideFile`, `docsOff`), parsed in `loadConfig` with the existing `env()` helper.
  - `MOVIN_DOCS` is `off` or `on`, default `on`. Any other value is a startup error, worded in the style of the existing config errors.
  - `main.ts` reads only `config`. Add `config.test.ts` cases.
- **F14:** in `app/tools/ui-check/check.mjs`, add a legacy-Claude check.
  - Before loading the LLM tab, write a v1 Claude `llm` section into MinIO's `settings.json` through the app's store. The simplest route is a small node script in the container, or `docker compose exec minio mc`; pick what works, and use only `movin-dev/dev`.
  - Assert the notice is visible.
  - Stub `window.confirm` to return false, click Save, and assert that no PUT was made and the page shows nothing saved.
  - Stub it to return true, click Save, and assert that the save went through and the notice is gone.
  - Run the full UI check and report the PASS count.
- **F15:** settings, telegram, checkin and the models request bodies match keys case-insensitively, as Go's `encoding/json` does.
  - An exact match wins. Otherwise the last case-insensitive match wins: check Go's rule (`encoding/json` `fold`) with the Go harness, write a Go probe for `{"apikey":"a","APIKEY":"b"}` and copy what it gives.
  - Implement it in the `jsonString`/`jsonBool`/`jsonStrings` helpers. Test it.
  - Also check the entries routes. If `decodeBody` callers there use exact keys while Go uses structs (`entries.Input`/`Patch`), apply the same rule. Patch with explicit nulls needs care: only the presence rule must stay the same.
- **F16:** in `transcript-admin.test.ts`, compare the endpoint calls by normalising the TS side with `normalise(…, llm.base)`. Remove the no-op split/join.

### Minor
- **F17:** pass `connectionsCheckingInterval: 1_000` to `createServer` so that `headersTimeout` fires near 10 s. Confirm the option in `@types/node`. Add a comment.
- **F18:** when a body goes over the cap, answer the 400, set `Connection: close` and stop reading. Don't drain. The client must still receive the 400; test that with `node:http`.
- **F19:** `ui-check/run.sh` stops MinIO only if it started it.
- **F20:** drop the `docs event failed` warning. Go drops it silently.
- **F21 (main-session decision):** in T2, `tokenSet` follows Go's nil-bot form, which is always `false`.
  - Remove `telegramTokenSet` from `ServerDeps`, `admin.ts`, `rig.ts` and `main.ts`.
  - When T4 adds the bot, its status source supplies `tokenSet`.
  - Keep `TestTelegramAdminNeverShowsToken` meaningful: there is a token in config, and it appears in no body and no log.

## Verification (paste real output)
1. `make -C app lint` (0 infos) and `make -C app test`: summaries plus the new test names. Root `make lint`.
2. A mutation table run on container copies, each mutation failing a named test. At least: F1 (raw parse message), F2 (hard-coded Get), F3, F4, F5 (no flag), F6 (send before start), F7 (signal dropped), F8 (no release), F9 (`toISOString`), F15 (exact keys only), F18 (drain).
3. The UI check PASS count, plus the new legacy lines.
4. `git status --short`.

## Amendment 2 — round 2 (CHANGES REQUIRED)
- **G1 (major):** `events.ts` `pendingDocs` block: a `docsView` failure at stream start kills the stream; Go drops the event (`server.go:415-419`). Delete the duplicated block; after `started = true` run `if (pendingDocs) await sendDocs().catch(() => undefined);`. Test: syncer `index` rejects while a docs signal is queued during the handshake → stream stays open, next heartbeat/entries arrives, no `request failed` log. Mutation: remove the catch.
- **G2:** F15 comment + `decisions.md`: record the two gaps (a repeated exact key keeps JSON.parse's first position, Go takes the last in document order; folding is JS lower-case, not Go `SimpleFold`, e.g. U+017F). Confirm Go's answer for `{"SCHEDULE":"8:05","schedule":"7:00","SCHEDULE":"9:00"}` with `tmp/t2x-golden` and quote it. No positional scanner.
- **G3:** `listModels`: a top-level `null` body → `[]` (Go decodes null into the struct as a no-op). Add `"null"` to the F3 test loop.
- **G4:** `scanJsonValue(text, from: number)`: `from` required.
- **G5:** text fixes: `llmsettings.ts:41` (15 s is the models route only; /test uses `timeoutSec`); `decisions.md` "T2 review round 1" — limit the abort statement to the two LLM routes (admin probe keeps its own 30 s budget on purpose: a cancelled probe must not leave its scratch object; say so); `main.ts:149` "above" → correct; rename the `probe.test.ts:122` title to say what it checks; oversize 400 = `res.setHeader("Connection","close")` + `writeErr(...)`.
