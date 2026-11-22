# T3 phase review, round 1: fixes (REJECT → fix)

The review is the last message in the ts-reviewer `54766639-de87-409` output. The decisions below are final. Every behavioural fix needs a named test that fails against today's code; add a mutation for each of P1 to P5.

- **P1 (blocker), refusal → 200.**
  - In `submit()`, when `settled.reason === "model_error"` and the run's last assistant message has `stopOf(...) === "refusal"` (`runOf` already finds it), return `{status:"answered", stop:"refusal", text, changes, toolsUsed, usage}`.
  - Tests:
    - **adapter:** content filter gives `answered`/`refusal`, and the earlier changes are kept.
    - **`chat.test.ts`:** both modes. JSON: 200 with `RefusalReply`. SSE: `reset` then `done` with `RefusalReply`, as in Go `agent.go:193-196`.
  - Check that chat-eval prints the reply, not `agent error`.
- **P2, history paging.**
  - Never split a run across pages. If the limit is reached inside a run, end the page at that run's boundary, so the cursor is a user row.
  - The "failed run" decision comes from the run itself (whether an answer entry exists between its user entry and the next), not from what the page emitted.
  - Test: two answered tool runs plus one failed run, read with `limit` 1, 2, 3 and 4. The union of the pages has each change line exactly once, and no page is empty while `more` is true.
- **P3, `/think` only.** Check blank text after `parseThink`, with Go's 400 `the last turn must be a user message`. Add a row to `TestChatInputErrorsAre400`.
- **P4, history keeps the typed text** (the decision stands).
  - The model gets the stripped text. The `movin.user` entry data and the `user` frame carry the typed text (`/think why?`).
  - Add `display` (or equivalent) to the submit path.
  - Test the history row's text and the frame's text.
- **P5, `afterRun`.**
  - **(a)** Take each touched entry's line from the journal record the change line names (`ChangeLine.id` → that change's `after`; `after === null` means removed, so drop it from `seen`). Don't re-read the live entries.
    - A change line without an id (`set_dates`) touches no entry.
    - Test: the agent updates X; the entries service edits X before the run settles; the next turn has exactly one `updated` line for X.
  - **(b)** After a crash, fix the comments and `decisions.md` T3.4 to say the truth: the next turn re-echoes the run's own writes once, and nothing is double-applied. Don't add lazy recompute.
- **P6, streaming input errors.** Follow Go. In stream mode (`streaming` set and `Accept` includes `text/event-stream`), input errors and the missing connection start SSE and send `event: error` with `{"changes":[],"error":"…","model":"…"}` (`server.go:459-476`). The JSON mode keeps the 400s. Pin both in `chat.test.ts`, and check that the page shows the error text in both.
- **P7, `chat-eval-docs` bucket.**
  - Make `app/Makefile` pass the bucket variables with explicit values from the calling shell (`-e S3_ENDPOINT_URL="$$S3_ENDPOINT_URL"` and the same for `S3_BUCKET`, `S3_PREFIX`, `AWS_*` and `SETTINGS_SECRET`), so an unset `S3_ENDPOINT_URL` means real AWS and never the service's MinIO default.
  - The target refuses to run when `S3_BUCKET` is empty, with a clear message.
  - Comment it. Show `make -n -C app chat-eval-docs` output, with values elided, as proof.

Record P1 to P7 in `decisions.md` as "T3 phase review round 1", and amend the T3.4/T3.5 bullets they correct.

**Verification:** run format, lint, test, root lint and ui-check. Paste the summaries, the new test names and the mutation results.

# Round 2: CHANGES REQUIRED → fix (decided)

The review is the last message of the ts-reviewer `54766639-de87-409` output.

- **Q1: history uses the same reply rules as the live turn (option a).**
  - `HistoryItem` carries the neutral `stop` and what `reply.ts` needs (`toolsUsed`, and whether the row has changes).
  - The adapter keeps empty-text answer rows and imports nothing from `src/agent`. Revert `adapter.ts:56` and the `REFUSAL_REPLY` substitution at `:1520`.
  - The history route (`chat.ts`) maps assistant rows through the same `reply.ts` function the live path uses, so these four cases show the same text on reload as live: `Done.`, refusal, cut-off note, and docs-not-found.
  - Add a test for each of the four, live vs reload, through the route. Add one test asserting `src/durable/adapter.ts` has no runtime import from `src/agent` (extend `imports.test.ts`).
  - Amend the P1 decision bullet.
- **Q2:** Delete `ChangeLine.entryId` everywhere (details, `tools.ts:216`, `wireChanges`, `prompt.ts` `recordIds` filters on `id` only). Amend `decisions.md:158`.
- **Q3: follow Go.**
  - The stream `error` frame for input errors and a missing connection carries `"changes":null`.
  - The stream branch logs `WARN chat failed by=<email> model=<model> err=<msg>` the way the 502 path does.
  - Pin both in `chat.test.ts`. The JSON 400s are unchanged.
- **Q4:** `history()` keeps scan order inside a run; drop `toReversed` or use a single answer slot. The P2 test compares rows in order, not sorted.
- **Q5:** `chat-eval-docs` forwards the secrets by name only (`-e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e SETTINGS_SECRET -e LLM_API_KEY`). Explicit values only for `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_PREFIX` and `AWS_REGION`. Show `make -n`.

Run a mutation for Q1 (rule skipped on reload) and Q3 (`[]` instead of null). Record everything in `decisions.md` as "T3 phase review round 2".

**Verification:** run format, lint, test, root lint and ui-check.

# Round 3: REJECT → fix (decided)

- **R1:** Put `-e LLM_API_KEY` (by name) back in `EVAL_ENV`, so both `chat-eval` targets get it. Show `make -n -C app chat-eval` with the name present. The main session reruns it live.
- **R2: reload vs live for "cut off before any text" and `turn_limit`.**
  - In the history route, an assistant row where `cutOffBeforeText(stop, text)` holds is treated like a failed run: there is no assistant row, and its changes go on the user row. The adapter stays neutral.
  - For `turn_limit`, show on reload what the live turn showed. If the adapter can tell that the run ended `turn_limit` (the run's last entry or the stored status), the route gives the user row an assistant row with the same `replyText` result as live.
  - If that isn't reachable from durable data without a new doc, record it as a known difference.
  - Add both cases to the Q1 live-vs-reload test.
- **R3: Go's order for refusals and cut-offs.** `replyText` and `channelReply` return the refusal and cut-off texts without `finish` (no marker stripping, no group silence), as in Go `agent.go:129-130` / `:191-204`. Add `reply.test.ts` rows for `"NO_REPLY then more"` with `max_tokens`, in a group and on the web.
- **R4:** Delete the vacuous `prompt` lines in `imports.test.ts`.

Mutation for R2 and R3. Record them as "T3 phase review round 3".

**Verification:** run format, lint, test, root lint and ui-check.
