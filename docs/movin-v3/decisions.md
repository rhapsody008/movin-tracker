# movin-tracker v3: decisions

All decided by ZY on 2026-11-20 unless noted. Newest at the bottom of each section. Don't reopen these without asking.

## Direction
- Full TypeScript rewrite on pi-durable (one process, no Go at the end). Reason: wanted a harness framework; one language.
- pi-durable and pi-ai pinned at exactly 1.5.2, adopted now; upgrade only when something breaks. Reason: don't wait on an experimental API; the adapter file limits the damage.
- Conversations per chat. One web conversation, because only ZY uses the web.
- Write tools are replay-safe (change ID from the task ID). Reason: a crash must never write twice.
- Order: conversations, tools and Telegram first; check-in and docs sync as durable tasks after (main session's call, ZY: "go with what you think is optimal").
- chateval is ported and measured, not a hard gate.
- After the Go code is deleted, `app/` moves to the repo root.
- Code is written by the `coder` agent (zy-pi-uep) from the main session's per-step brief; the main session verifies. Every step is reviewed by `ts-reviewer` (TS version of strict-reviewer, with a stricter mode for coder-written code) and ticked only on APPROVE; plus a review per phase. Reason (ZY): the coder model is weaker, so the review is stricter.

## Storage and deploy
- 1Gi RWO PVC on `nutanix-volume` at `/data`, applied by ZY by hand, outside the Flux artifact. Reason: `prune: true` and reclaim policy Delete would otherwise let a rollback destroy it.
- Backup is Velero (already running on zy-all-in-one as the NKP workspace app); no in-app backup. Making it capture the volume's data is a separate ops change and does not block the cutover.
- movin's Velero Schedule covers the PVC/PV only. Reason: secrets and the rest come from Flux or are hand-applied.
- Velero captures the volume through CSI snapshots: label `nutanix-snapshot-class` with `velero.io/csi-volumesnapshot-class: "true"` (no node-agent, no data mover). Reason: cleaner. Accepted: snapshots stay on the same Nutanix storage as the volume (not off-site).
- The app detects a restore both from an explicit restore ID and from a start counter kept in SQLite and S3, and aborts live runs before resuming. Reason: a restored database must not resend old replies, even if the restore ID is forgotten.
- Memory: ~~192Mi request, 512Mi limit~~ → 128Mi request, 384Mi limit, 256 MB Node heap, from T0.2's measurements (main session, under ZY's "go with your recommendation"); re-measured in T6.1.
- Released as `v2.0.0`; Flux pinned to exact versions from T6.3.

## Behaviour
- Prompt: entries snapshot in the first user message, then deltas. Reason: stable prefix, small context.
- After a crash a rare duplicate reply chunk is accepted; a lost reply is not. Entry writes are never duplicated.
- History resets after 6 h idle; compaction as the fallback.
- Commands such as `/undo` stay at-most-once. Reason: "undo my latest" can't be repeated safely.
- A dev bot token and test group are used for the Telegram phases.

## LLM
- Claude native is removed: provider, SDK, cache marks, effort mapping, refusal fallbacks, settings and UI. One OpenAI-compatible endpoint: the NAI gateway (`movin-backend`), already the saved connection. ZY routes Claude through the gateway. Supersedes v2 "two kinds" and refusal fallbacks.
- No special handling for `api.anthropic.com`; that host is not supported. Reason: ZY uses the gateway.
- A `kind:"claude"` section written by v1 is ignored, never rewritten on read. Reason: dev and prod share `settings.json`, and a Go rollback must find it intact.
- Prompt caching is left to the gateway (accepted cost risk).

## Object store (T1.2)
- `put` with `ifMatch: ""` is a caller bug and throws; `null` means create-only. Go used `""` for create-only, but on MinIO `IfMatch: ""` is an unconditional write, so the TS API makes the empty string impossible to send.
- A successful S3 response without an ETag is an error (Go returned `""`, which could later disable the write guard).
- Admin page credential label: from the SDK's `$source` features. Instance-role credentials show "unknown" (this SDK doesn't attribute IMDS); non-credential features alone show "unknown" instead of Go's raw string. Prod uses env keys, so no visible change there.

## Run T1–T3 unattended (ZY, 2026-11-20: "go with recommendations")
- **Change ID carries the args hash.** Change ID = 16 chars of base32(sha256(`epoch|taskId|index`)) + 10 chars of base32(sha256(canonical args)), 26 chars total. A rerun that finds a record with the same 16-char prefix and the same suffix returns it; same prefix, different suffix = collision: logged, write goes ahead with a fresh ULID. No new field in `entries.json` (replaces "the journal record keeps a hash" in plan.md Tools). Go treats change IDs as opaque strings, so rollback is unaffected.
- **Real bucket for dev runs** in T2.3 / T3.5 / T3.6, like `make dev` for Go: one clearly named test entry, undone and deleted afterwards. Everything before T2.3 runs on MinIO.
- **Billed gateway calls** allowed for T3.1 probes and T3.6 chateval (saved key decrypted in memory only, as T0.3).
- **poppler-utils + font** (apk) in the app test image for T1.5; same packages as the Go image. No new npm packages in T1–T3; if one is needed, stop and ask.
- **Commits:** `git-ops` commits locally at the end of each phase (T1, T2, T3), no push, leaving the pre-existing staged renames alone.
- **Review cadence:** the main session verifies every step (lint/test rerun, diff, targeted mutations on compatibility-critical code); `ts-reviewer` reviews once per phase over the whole phase, plus separate reviews for T3.2 (durable adapter) and T3.3 (tools, replay safety). Stop and ask on: a new npm dependency, deletions outside `app/`, real-bucket use beyond the above, a plan error, or a review finding that changes an earlier decision.

## T2 review round 1
- **Errors from `src/llm` never include a body parser's message.** V8's `JSON.parse` quotes its input, so a body that *is* the API key would print it in a 502's `error` and in the log. Decode failures carry fixed tails (`decode models list: invalid JSON`, `decode completion: invalid JSON` — Go's prefixes from `openai.go:126`/`:171`, with a stable tail of our own), and every error that leaves `src/llm` passes through the key scrub as a backstop. Go's own `encoding/json` tails are not reproduced; nothing asserts them.
- **A network error's verb is Go's `urlErrorOp`**: the method's first byte plus the lower-cased rest, so `Get "…"` or `Post "…"` (verified in `tmp/t2x-golden`). Only what follows the URL still differs from Go (`dial tcp …` vs Node's cause text).
- **A missing or null `data` in a models answer is an empty list**, as Go's nil slice is; a non-array is a decode error.
- **`testResult` follows Go's `omitempty`**: no `models` when the list is empty, no `modelsError`/`error` when the text is empty. The page distinguishes "not probed" from "probed and empty" by the key's presence, as Go does.
- **Every struct body is matched case-insensitively, as Go's `encoding/json` folds struct field names**, and when two keys match one field the last in the document wins — position, not exactness (`{"apiKey":"exact","APIKEY":"folded"}` is `"folded"`). Go's answers are in `tmp/t2x-golden`. The entries routes decode into Go *maps*, so they keep exact keys and `"Title"` stays an unknown field; the rule is implemented only in the struct helpers.
- **`closeStreams` is permanent**, like Go's closed `s.closing` channel: a stream that starts after a shutdown sends its first snapshot and then ends. A docs signal that arrives before the SSE handshake is remembered and sent after the first `entries` event, so no frame can ever be written before the headers.
- **The two LLM routes abort their endpoint call when the browser goes away** (`POST /api/settings/llm/models` and `/test`: `res.on("close")` → `AbortSignal` next to the call's own timeout — 15 s for the models list, the connection's `timeoutSec` for the probe). Reason: a closed drawer must not keep a call carrying the key running. The admin storage probe is deliberately *not* wired to it: it has its own 30 s budget and must finish its cleanup, or a cancelled probe would leave `_probe/<ULID>.json` behind.
- **An oversize body is answered, not drained**: 400 with `Connection: close` and no further reads, as `MaxBytesReader` makes Go hang up (F18).
- **`tokenSet` is always `false` in T2**, which is Go's nil-`*telegram.Bot` form; `TELEGRAM_BOT_TOKEN` is in the config and reaches no body and no log. T4's bot supplies its own `tokenSet`.
- **`MOVIN_DOCS` and `GUIDE_FILE` are config**, parsed once in `loadConfig` (`docsOff`, `guideFile`); `main.ts` reads only the config, and `MOVIN_DOCS` accepts only `on`/`off`.

## T2 review round 2
- **A failed docs view at stream start is dropped, not fatal** (G1). Go's select re-reads the index and drops the event when it cannot be read (`server.go:415-419`); a stream that has already answered must not die of it. The queue-then-send path now reuses the same `sendDocs()` as later signals, with one `.catch`, so there is exactly one place that decides.
- **The struct-field lookup accepts two gaps against Go's `encoding/json`** (G2), both recorded in `fieldOf`:
  - a repeated *exact* key. `JSON.parse` keeps the first key's position with the last value, so `{"SCHEDULE":"8:05","schedule":"7:00","SCHEDULE":"9:00"}` resolves to `"7:00"` here and to `"9:00"` in Go, which assigns every occurrence in document order (confirmed: `tmp/t2x-golden` prints `schedule="9:00"`). Closing it needs a positional scanner over the raw body; not done.
  - folding is JavaScript lower-casing, not Go's `strings.EqualFold`/`unicode.SimpleFold`: `{"\u017fchedule":"x"}` matches `schedule` in Go (the long s folds to s; the probe prints `schedule="long-s"`) and does not match here.
- **A top-level `null` models answer is an empty list** (G3): Go's decode of `null` into the struct is a no-op, leaving the nil slice that `Models` turns into `[]`.
- **`scanJsonValue`'s `from` is required** (G4): a defaulted offset is one more place a caller can silently scan from the wrong byte.
- **Text corrections** (G5): the abort comment names the models route's 15 s and the probe's `timeoutSec` separately; the `connectionsCheckingInterval` comment points at the `headersTimeout` set below it; the F4 probe test title says what it checks; the oversize 400 sets `Connection: close` and then writes through `writeErr`, so the body has one writer.
