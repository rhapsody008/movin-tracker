# T1 phase review — fixes (Amendment 1 to the whole of T1)

The whole-phase `ts-reviewer` review (agent `0abcb185-cebf-494`) returned **REJECT**. This brief fixes every finding. The main session checked findings 1, 3 and 10 against Go and Node itself (evidence below). Fix all ten now: T2 builds on these helpers.

## Read these first
- This brief, then the review findings summarised below.
- `internal/settings/settings.go:245-286` (`modify`, `setJSON`).
- `docs/movin-v3/briefs/settings-spec.md` §1.5 and §9 (traps 1 and 3).
- `docs/movin-v3/briefs/entries-spec.md` §10 trap 13.
- The current code in `app/src/`.

## Allowed paths
- `app/src/**`.
- `tmp/t14-golden/` (git-ignored) for the new settings golden.
- Nothing else. No new dependencies, no git commands, no changes under `internal/` or `cmd/`.

## Rules (unchanged from the step briefs)
- Prove every claim by running it and pasting the real output.
- Golden files come only from the Go program, never by hand.
- Each mutation runs on a copy inside the `app-test` container (`cp -r /app /tmp/m`, `node_modules` symlinked) and must fail a **named** test.
- `make -C app lint` must show 0 infos, and `make -C app test` must stay green.
- Stop and report if anything here is impossible as written.

## Must fix

### F1 [BLOCKER] settings.json writes must match Go's bytes
**What Go does** (`settings.go:248-276`, checked by the main session):
- `modify` reads the file into `map[string]json.RawMessage`.
- `fn` replaces only the sections it owns, via `setJSON` = `json.Marshal(v)` of the struct, so struct field order applies.
- It sets `raw["schema"] = 1`, then calls `json.MarshalIndent(raw, "", "  ")`.

**Effects of that:**
- Only the **top-level** keys are sorted (Go map order).
- Every other section keeps its own bytes: key order, number literals (`1.50`, `12345678901234567890`) and spacing.
- `MarshalIndent` compacts each `RawMessage`, then re-indents the whole output with 2 spaces.
- HTML escaping (`<`, `>`, `&`, U+2028, U+2029) applies to the raw sections too, because `Marshal` runs `compact` with escaping on RawMessage.

Confirm each of these with a Go probe in `tmp/t14-golden/`. Don't take this text's word for it.

**What TS does now:** `JSON.parse`s the whole file and re-encodes everything with keys sorted at every depth (`settings/gojson.ts:47-54`). Untouched sections get reordered and numbers go through doubles.

**Fix:**
- Split the top-level object into `key → raw text` without parsing the values into JS objects.
- Write a small top-level JSON object scanner that is string-, escape- and nesting-aware. It must reject anything that isn't a JSON object.
- Sections the save owns are encoded from their struct, in Go struct field order with omitempty, as now.
- Untouched sections are re-emitted from their raw text: compacted, Go-escaped, then indented at the right depth.
- Only the top level is sorted. There is no key sorting anywhere below it.
- The "unreadable file → start from `{}` and warn `replacing unreadable settings.json`" behaviour stays.
- Fix the `gojson.ts:4` comment so it says exactly what is byte-identical.

**Golden test (committed):**
- Extend `tmp/t14-golden/main.go` with a mode that starts from a fixture holding:
  - an `llm` section in Go struct order;
  - a `checkin` section;
  - an unknown section `{"zeta":1,"alpha":12345678901234567890,"f":1.50,"s":"<a&b>\u2028"}`.
- In that mode, run Go's real `SaveTelegram`, then `SaveCheckin`, against a memory store with a fixed clock. Write the bytes after each save to `app/src/settings/testdata/save-*.go.json`.
- The TS test runs the same saves from the same fixture with the same clock and compares the bytes exactly.
- Use a fixture without `apiKeyEnc`, or keep an LLM save out of the byte test, because the IV is random. Say which you chose.
- Also run the gate from spec §9 trap 1 as a command, not a vitest test: TS saves, Go re-saves the same section, and the bytes are identical. Paste the output.

### F2 [MAJOR] Add a test for each guard that mutations showed untested
Each row is a mutation that survived the reviewer's run. Add a test that kills it, then rerun the mutation and paste the failing test name.

| # | Location | Mutation that must now fail |
|---|---|---|
| a | `entries/service.ts:244` | `tryLock` replaced by no lock. The test is a refresh during a write: the older document must not come back (entries-spec §10 trap 13). |
| b | `docs/sync.ts:167-168` | "newer index wins" guard removed. Test: `index()` racing a sync must not replace the newer index. |
| c | `docs/sync.ts:212` | pre-aborted joiner check removed. Test: a joiner whose signal is already aborted rejects at once. |
| d | `poppler.ts` `acquire` | `release()` before `throw waitingError` removed. Test: a caller gives up while waiting, and a **later** call must still get the slot and succeed. |
| e | `poppler.ts` `execTool` | abort listener removed. Test: aborting the caller's signal kills a running tool well before its timeout. |
| f | `docs/schedule.ts:86` | `stopped` check removed. Test: no timer is armed after `stop()`. |
| g | `docs/index.ts` `compareKeys` | byte order replaced by UTF-16 `<`. Test: keys with a non-BMP character and a U+E000–U+FFFF character sort as Go sorts them. Take the expected order from a Go golden, not by hand. |
| h | `settings/stored.ts:140` | `chat` always written. This is covered by the F1 byte golden once a fixture has an empty chat; make sure one does. |
| i | `settings/settings.ts:276` | `!sameOrigin` removed. Test: a stored key whose `baseUrl` has no host, or can't be parsed, is not used. |
| j | `settings/settings.ts` cache | `<` changed to `<=`. Go uses `s.now().Sub(s.at) < s.ttl` (settings.go:210). Test: at exactly 30 s the cache is stale. |

### F3 [MAJOR] Delete `lookup()` from poppler
The main session checked this on the pinned node:24-alpine: `spawnSync("mytool", [], {env:{PATH:"/tmp/pb"}})` runs `/tmp/pb/mytool`, and with `{PATH:"/nonexistent"}` it fails with ENOENT. Node does resolve a bare command from `options.env.PATH`. Your T1.5a finding came from a different setup; if you can reproduce it, paste the exact command, and stop.

**Fix:**
- Delete `lookup()`, the `statSync` import and the `path` option ternary.
- Pass `env` (with the fake-tools `PATH` in tests) and spawn the bare tool name.
- Correct the comment. The fake-tool tests must still pass.

## Fix now (cheap, and T2 would copy them)

### F4–F7: one home for the Go helpers and shared utilities
- **New `app/src/gostr.ts`:** `goTrimSpace`, `goFields`, `goQuote`, `goTrim(s, cutset)` (Go `strings.Trim`), `goTrimRight(s, cutset)` if needed, and `compareBytes` (UTF-8 byte order).
  - Move them from `entries/model.ts`, `settings/text.ts`, `docs/index.ts` `compareKeys`, `docs/search.ts` `compareStrings`, `config.ts` `trim`/`trimRight`, `search.ts` `trimSlashes` and `summary.ts` `trimQuotes`.
  - Callers that are only a Go `strings.Trim` become `goTrim(s, "/")` and so on.
- **New `app/src/gojson.ts`:** `goMarshal` (compact) and `goMarshalIndent` with **one** escape table, plus `Ordered` and the raw-section helpers from F1. Move them from `entries/gojson.ts` and `settings/gojson.ts`, and delete those two files.
- **In `app/src/log.ts`:** one `errorMessage(err: unknown): string`. Replace `message` (settings, entries), `messageOf` (schedule, search, render), `asError(err).message` (sync) and the `(err as Error).message` casts in `config.ts`.
- **One `goStamp(date)`** (RFC 3339, whole seconds, `Z`) in `gostr.ts` or `sched.ts`. Replace `settings.ts` `stamp`, the copy in `entries/service.ts` and `docs/index.ts` `goStamp`.
- **Errors:**
  - `ValidationError` moves to a neutral `app/src/errors.ts`.
  - `settings/errors.ts` stops re-exporting it from entries.
  - Each domain still owns its own `ConflictError`, but with the Go messages unchanged.
- **Imports:** no module outside `entries/` imports from `entries/model.ts` for string helpers, and no re-export shims stay behind. Fix every import, and keep each moved helper's tests next to its new home.

### F8 Replay detection for a batch whose first record has been trimmed
`entries/service.ts:326-344` checks only index 0's prefix.
- **Fix:** check the prefixes of indices `0..k-1`, where `k` is the number of records the call writes, and treat any hit as a replay. Compare the full id, prefix plus args-hash suffix, as now: same suffix means a replay, a different suffix means a collision.
- **Test:** a create batch whose index-0 record has been trimmed past the 200 cap, but whose index-1 record is still in the journal, is recognised as a replay and writes nothing.

### F9 Small cleanups
- `config.ts:142-146`: drop the try/catch that rethrows the same message.
- `sched.ts` `atoi`: drop the no-op `s === "" ? "x" : s`.
- `sched.ts` `hhmm`: it formats `HH:MM:SS`, so rename it to `hhmmss`.
- `poppler.ts`: inline `concatBytes`.
- `docs/schedule.test.ts:280-306`: use `vi.spyOn(globalThis, "setTimeout")` instead of swapping it by hand.

### F10 Cache TTL boundary
Covered by F2 row j.

## Verification (paste real output)
1. `make -C app lint` (0 infos) and `make -C app test`, with summary lines. The test count must be at least 573 plus the new tests; list the new test names.
2. F1:
   - the Go golden program's output;
   - the committed byte test passing;
   - the TS-save → Go-re-save gate output;
   - a mutation that re-sorts a nested section, which must fail the byte test.
3. All F2 mutations, a to j, plus a mutation of F8 (only index 0 checked), each failing a named test.
4. Evidence that `lookup()` is gone: `grep -rn "lookup\|statSync" app/src/docs/convert/` should show none. The fake-tool tests must still pass.
5. The F4–F7 moves:
   - `grep -rn "from \"../entries/model.ts\"\|from \"./entries/model.ts\"" app/src --include=*.ts | grep -v "^app/src/entries/"` should print nothing;
   - `ls app/src/entries/gojson.ts app/src/settings/gojson.ts` should report both as missing;
   - `grep -rn "messageOf\|function message(" app/src` should print nothing.
6. Root `make lint`, and `git status --short`.
7. Go/TS differences still not coded around, as a list. F1 must remove the "numbers in unknown sections" difference from T1.4's list.

Report in the standard format.

---

# Amendment 2 — T1 re-review (ts-reviewer, CHANGES REQUIRED, no blockers)

The F1–F10 fixes are confirmed. The reviewer ran 45 inputs through Go 1.27.4 and the TS `RawObject` and got identical bytes for every valid input; both refused the same 16 invalid ones. What's left is mostly tests that pin that behaviour.

## A1 [must] Golden table for the raw-section scanner
- **Golden:** extend `tmp/t14-golden/main.go` with a mode that writes `app/src/gojson-raw.go.json` (or `app/src/testdata/raw.go.json`).
  - It holds an array of `{name, input, ok, output}`.
  - `input` is base64 or a JSON string, whichever keeps raw bytes intact. Generate it in Go; never type control characters into a tool argument.
  - For each input, Go does `json.Unmarshal` into `map[string]json.RawMessage`, then `raw["schema"]=1`, then `json.MarshalIndent(raw,"","  ")`.
  - `ok:false` means Unmarshal failed.
- **Valid inputs:**
  - escaped quotes and backslashes, and brackets inside strings;
  - CRLF, tab and space whitespace;
  - empty `{}` and `[]` at depth 1 and 2;
  - duplicate top-level keys;
  - a `\u0061`-style key next to a plain `a` key, and a `<k>&` key;
  - top-level keys with a non-BMP character, U+E000 and U+FFFF;
  - `\/`, `\u00E9` and a lone `\ud800` kept as written;
  - the numbers `1.50`, `12345678901234567890`, `1E3`, `-0`, `-0.0e+5`, `-1.5E-3`;
  - raw U+2028 and U+2029, generated by Go, and `<>&`.
- **Invalid inputs:**
  - a trailing comma;
  - `[1]`, `"x"`, `tru`, `01`, `1.`, `1e+`, `-`;
  - text after the object;
  - a missing colon, and a missing comma;
  - a raw control character in a string;
  - the escapes `\x` and `\u12G4`;
  - `nullx`;
  - empty input, and whitespace-only input.
- **Test, part one:** for each row, `RawObject.parse → set("schema",1) → encode()` must equal `output` byte for byte, or throw when `ok` is false.
- **Test, part two:** drive at least one invalid row and one valid row through the settings save path (`modify`), so that the "replacing unreadable settings.json" branch is covered.
  - An invalid file is replaced, and the warning is logged.
  - A valid file keeps its other sections byte for byte.
- **Mutations:** each must fail a named test.
  - S2: top level sorted by UTF-16 `.sort()`.
  - S3: the empty `{}`/`[]` branch in `indent` disabled.
  - S4: duplicate key, first wins.
  - S5: tab not dropped by `compact`.
  - S6: text after the object accepted.
  - S7: raw control character accepted.
  - S8: invalid escape accepted.
  - S9: missing separator accepted.

## A2 [must] F8 collision at index > 0
- **Test:** create a batch, trim index 0 off the journal, then replay the same task and epoch with **different** args for index 1.
- **Expect:** a collision warning, a fresh write with ULIDs, and no replay.
- **Mutation:** `if (hit.id !== id && index === 0)` must fail that test.

## A3 Comment on `Ordered` in `gojson.ts`
Rewrite it to say what the code does:
- `encode()` throws on a plain object in indented mode.
- In compact mode it keeps insertion order.

## A4 Remove the shim
- Delete `export { addDays };` from `entries/agenda.ts`.
- `agenda.test.ts` imports `addDays` from `../sched.ts`.

## A5 Document two read-path differences
Keep the TS behaviour, and list both as known differences in `gojson.ts`'s header. Pin each with a test.
- **BOM:** Go fails to unmarshal and replaces the whole file, dropping every section. TS strips the BOM and keeps the sections. This is decided: keeping the sections is the safer behaviour.
- **Invalid UTF-8 inside a string:** Go keeps the raw bytes. TS writes U+FFFD.

## A6 Pin the `compareBytes` call sites
- Add a top-level key with a non-BMP character, and one with a U+E000–U+FFFF character, to an input that runs through `RawObject.encode`. Row S2 of A1 covers this.
- Add the same kind of key to the docs index golden input (`docs/testdata/`), and regenerate the golden with the Go program.
- **Mutations:** `docs/index.ts` sorting by UTF-16, and `RawObject.encode` sorting by UTF-16, must each fail a named test.

## Verification
1. `make -C app lint` (0 infos) and `make -C app test`, with summary lines and the new test names.
2. The Go golden program's output for A1 and A6.
3. Mutations S2–S9, the A2 mutation, and both A6 mutations, each failing a named test.
4. Root `make lint`, and `git status --short`.

---

# Amendment 3 — final re-review (REJECT on one item; a test-data change only)

The main session checked the golden origin: regenerating `raw.go.json` and the docs `index.go.json` with the Go harnesses leaves both SHA-1s unchanged (`9ec255b9…`, `c094fbdf…`).

## B1 [must] Nested structural refusals and root edge cases in `rawtable`
The old S9 mutation script mutated the top-level loop in `RawObject.parse`, not `scanContainer`. These mutations still survive:
- `scanContainer` accepting a missing `,`;
- `scanContainer` skipping its `:` check;
- the top-level `:` check skipped;
- the `{` root check disabled;
- the empty-root branch disabled.

Add these rows to the `rawtable` mode of `tmp/t14-golden/main.go` and regenerate `app/src/testdata/raw.go.json` with Go (never by hand):
- **refused:** `{"a":[1 2]}`, `{"a":{"b":1 "c":2}}`, `{"a":{"b" 1}}`, `{"a":{"b"x1}}`, `{"a"x1}`, `["a":1}`;
- **valid:** `{}`, ` { } `.

Then rerun these mutations on a container copy. Each must fail a named test:
- **N1:** `scanContainer` accepts a missing separator.
- **N2:** `scanContainer` skips its `:` check.
- **N3:** the top-level `:` check is skipped.
- **N4:** the `{` root check is disabled.
- **N5:** the empty-root branch is disabled.

For N5, also check that a stored `{}` doesn't log `replacing unreadable settings.json`, and add an assertion to the settings test if one is missing.

## Verification
1. lint: 0 infos;
2. the test summary;
3. the Go `rawtable` output with the new row count;
4. mutations N1–N5, each with its failing test name.
