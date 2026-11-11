# movin-tracker v2: plan

Source: planner, 2026-11-11 (original plan + delta for ZY's decisions and the management plane). Decisions live in `decisions.md`; progress in `progress.md`.

Rules for every step: changes are to the local repo only; `make lint && make test` green after each step; rollback = revert that step's files against baseline `155d264`. Deletions, new vendored dependencies, `kubectl apply`, IAM changes and secrets need ZY's approval.

## Order
Phase 1: 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.6a → 1.7 → 1.7a → 1.8 → 1.8a → 1.9 → 1.9a → 1.10 → 1.11 → 1.12
Phase 1.5: 1.5.0 (spike, gate) → 1.5.1 → 1.5.2 → 1.5.3 → 1.5.4 → 1.5.5 → 1.5.6 → 1.5.7 → 1.5.8 → 1.5.9 → 1.5.11 → 1.5.10
(1.5.1, 1.5.2 and 1.5.4 with the fake converter can run before the spike.)

## Package layout
| Package | Files | Role |
|---|---|---|
| internal/entries | model.go, service.go, search.go, journal.go | Replaces internal/board |
| internal/agent | agent.go, tools.go, prompt.go, history.go | Replaces internal/chat; no HTTP/Telegram imports |
| internal/telegram | client.go, bot.go, commands.go | Bot API client (net/http, no deps), poller, auth, per-chat workers |
| internal/docs | index.go, sync.go, schedule.go, crop.go, summary.go | Phase 1.5; Notifier interface, must not import telegram |
| internal/docs/convert | convert.go, pdfium.go, fake.go | Converter interface; PDFium WASM; fake |
| internal/objstore | existing | + Delete, Info, Tracked decorator (1.6a); + List, PutBlob (1.5.1) |
| internal/llm | client.go | multimodal parts (1.5.5) |
| internal/settings | settings.go | + telegram section, cache, Save fix (1.8a) |

## Design
### Entries (`<prefix>/entries.json`)
- `{schema, meta{moveDate,keyDate}, entries[], changes[]}`.
- Entry: `id, kind, title, room?, category, status, cost{estimate?,actual?}, vendor, date?, time?, source, notes, tags[], archived, by, channel, created, updated`.
- Status validated per kind (task: todo/doing/done; others: idea/shortlisted/decided/done); kind change remaps status. `time` requires `date`.
- Write path ported from board.Service (writeMu, ETag If-Match, 3 retries, Poll, Subscribe). Every write takes `Actor{By, Channel}`.
- Undo journal: `changes[]` capped ~200 `{id, at, by, channel, op, entryId, before, after}`; Undo refused if the entry changed since; undo is itself journaled.

### Agent
- `Runner.Run(ctx, Request{By, Channel, Turns}, cfg, emit) -> Result{Reply, Changes[{ID,Text}], Model}`.
- Confirmations are built by the server from Changes (always confirmed, always with an undo handle).
- Prompt: rules, rooms, compact index of ~150 most recent non-archived entries, sheet index (1.5).
- Tools: add_entry (entries[], cap 30), update_entry (incl. archived), search_entries, set_dates, undo_change, ask_drawings (1.5.8).
- Rules: classify kind/room; one short question when genuinely ambiguous and write nothing; never invent dates/costs/vendors; update rather than duplicate.
- Both channels resolve LLM settings per message; bot forces Streaming=false.

### Telegram
- getUpdates long poll (50s) with backoff; 409 → log + backoff; in-memory update_id dedupe; at-least-once accepted.
- Auth: private chat → from.id in users. Group → chat.id in groups AND from.id in users. Callbacks checked the same way. Fail closed.
- Per-chat worker goroutine + queue: serialised within a chat, parallel across chats.
- History per chat (shared in the group), last 12 turns, in memory; user turns prefixed with speaker name.
- Group replies use reply_to_message_id. edited_message ignored. Plain text, split at 4096. Inline Undo button (`undo:<changeID>`).
- Rejected list (last ~10 chat id/title/from id/name) shown in admin to find the group ID.
- Token scrubbed from every error and log line.
- `Status()`: tokenSet, running, botUsername, lastPollAt, lastUpdateAt, lastError, lastErrorAt, rejected[].

### settings.json (schema stays 1)
- New optional `telegram: {users:[{id,name}], groups:[...], updated, by}`; IDs as strings.
- Missing section → env defaults (`TELEGRAM_ALLOWED_IDS` users `id=name`, `TELEGRAM_ALLOWED_CHATS` groups). Present section replaces env lists as a whole. Unreadable file → env, never allow-all.
- Save becomes read-modify-write of its own section only (fixes current `Save`, which rebuilds the file and would drop `telegram`). Top-level updated/by keep meaning "LLM last saved".
- In-process cache replaced on Save, re-read after ~30s TTL. Bot calls ResolveTelegram per update.
- Rollback hazard: a v1 binary saving LLM settings drops the telegram section (falls back to env; safe).

### Storage admin
- Read-only: bucket, region, prefix, endpoint, credential source label (env keys / IRSA / profile / instance role / other). Never return key material.
- Last successful write via a `Tracked` objstore decorator.
- Test connection on `<prefix>/_probe/<ulid>.json`, single-flight, per-step: create If-None-Match, head, get, stale-ETag put (expect 412), correct-ETag put, delete. A denied delete is reported as its own failed step.

### Drawings (1.5)
- Converter: PDFium WASM in-process (go-pdfium/wazero) behind an interface; poppler sidecar fallback. Lazy runtime per sync, closed after; one render at a time.
- Per page: full PNG capped ~6000 px long edge, overview PNG ~1568 px, text runs with normalised bboxes.
- S3: `docs/raw/<file>.pdf` (truth), `docs/pages/<sheet>/r1/pN.png` + `pN.overview.png`, `docs/text/<sheet>.json`, `docs/index.json` (manifest + sheet index + lastSync).
- ask_drawings{sheet, page?, region?, query?}: overview + text runs, or full-res crop + text runs in region. Images in a synthetic user message, never in history, cap ~4/turn.
- Sync: single-flight; diff raw ETags vs index; write index per sheet; removed sheets kept with status removed; render version r1 constant. Returns Result{at, reason, added, changed, removed, failed, error}, persisted as lastSync.
- Triggers: upload, startup, daily `DOCS_SYNC_SCHEDULE` (HH:MM in TZ, default 03:00, or off), /sync, web Sync now. Notify the group only when something changed; upload syncs reply only in the originating chat.

## Phase 1 steps
**1.0 Baseline** — done.

**1.1 Entries model** — `internal/entries/model.go`, `model_test.go`. Types, Rooms/Kinds/status tables, Patch.Apply (null clears), Clone, Decode (normalising), Empty, ValidationError, `time` (HH:MM, requires date). Verify: table tests per field rule, status per kind, kind-change remap, unknown room rejected, time rules.

**1.2 Entries service + journal** — `service.go`, `journal.go`, `service_test.go`. Port Load/Current/Refresh/Poll/Subscribe/mutate; Create/Update/Delete/SetMeta/Replace(ctx, Actor, …), Undo, Recent. Verify: ported conflict/concurrency/retry/poll tests on memory + MinIO; undo create/update; undo refused after later edit; journal cap; by/channel stamped.

**1.3 Search** — `search.go`, `search_test.go`. Filter{Kinds, Rooms, Statuses, Category, Tags, Vendor, Text, DateFrom, DateTo, IncludeArchived, Limit}; token AND keyword match; sort updated desc. Verify: table tests.

**1.4 Agent core** — `internal/agent/*`, `agent_test.go` (internal/chat stays until 1.11). Move loop (forced-answer round, preamble reset, CleanTurns). Tools incl. time. Verify: moved stub-LLM tests; changes carry IDs; channel recorded; unknown tool → error JSON.

**1.5 chateval port** — `cmd/chateval/main.go`, `fixtures/entries.sample.json`, Makefile. Cases: idea with room; decision; dated task; "electrician Friday 2pm" → date + 14:00; quote-then-paid updates not duplicates; ambiguity → question, zero diffs; question via search, zero diffs; "drop X" archives; "undo that"; move-in date. Count-based summary. Verify: `make chat-eval` (needs LLM_* from ZY).

**1.6 Server + main switch** — server.go, server_test.go, cmd/movin/main.go. Routes: GET/POST /api/entries, PATCH/DELETE /api/entries/{id}, PUT /api/meta, POST /api/changes/{id}/undo, GET /api/events (event `entries`), POST /api/chat (agent, channel web, done carries changes). readyz heads entries key; seed decodes entries. Verify: ported REST/409/SSE tests, settings tests unchanged, undo endpoint test. Frontend broken until 1.7.

**1.6a Storage introspection + probe** — objstore Delete, (*S3).Info, Tracked decorator; GET /api/admin/storage, POST /api/admin/storage/test. Verify: Delete on memory + MinIO; probe 6/6 on MinIO leaves nothing under _probe/; delete-denied stub → 5 pass + 1 fail; response never contains key material; last-write advances after an entry write.

**1.7 Frontend** — static/index.html: kanban (4 merged columns), filters (room/kind/category), card + edit dialog incl. time, calendar keyed on date/time, header countdown + totals (F3), chat change lines with Undo. Coming-up strip retired. Verify (`make dev`, `make seed`): add/edit/drag, filters, calendar, totals, two-tab live sync, chat write then undo.

**1.7a Admin shell: Storage + LLM tabs** — drawer becomes tabbed admin panel (Storage | LLM | Telegram | Drawings; last two hidden until their steps). LLM tab moved as-is. Verify: LLM save/test/models unchanged (TestSettingsKeyNeverLeaks green); Storage tab shows MinIO + "env keys"; Test shows 6 green steps.

**1.8 Telegram client** — `internal/telegram/client.go`, test. getUpdates, sendMessage, sendChatAction, answerCallbackQuery, editMessageReplyMarkup, setMyCommands, getFile + download; injectable base URL. Verify: httptest fake; token never in errors.

**1.8a Settings: Telegram section** — settings.go, config.go, tests. telegram section, ResolveTelegram, ViewTelegram (fromEnv), SaveTelegram, cache, Save fix. Validation: integer IDs, names 1–40 chars, no duplicates. Verify: v1 settings.json fixture resolves unchanged; LLM save keeps telegram and vice versa (incl. apiKeyEnc); section overrides env as a whole; unreadable → env; cache on save + TTL with injected clock.

**1.9 Telegram bot** — bot.go, commands.go, config.go, cmd/movin/main.go. Auth, per-chat workers, shared history, reply_to, rejected list, Status(). Commands /start /help /recent /undo (caller's own latest); /sync stub until 1.5. Non-text → "not supported yet". Verify (fake API + stub LLM): allowlisted text → entry with channel=telegram + Undo button; callback undoes; non-allowlisted ignored; 409 backoff; duplicate update_id once; SSE sees bot write; group allowed/unlisted/non-allowlisted cases; concurrent messages in one chat serialised with speaker prefixes; two chats parallel; allowlist change honoured without restart. Manual: `make dev` with a test bot token from ZY.

**1.9a Telegram admin** — GET /api/admin/telegram, PUT /api/settings/telegram, Telegram tab (status, user/group rows, Add from rejected list, env note). Verify: token never in any response; PUT then update from new user processed without restart; token unset → "not set", allowlist still editable. Manual: add the real group via the rejected list.

**1.10 Config + manifests (files only)** — switch oauth2-proxy to GitHub (`provider = "github"`, `scope = "user:email"`; README: create a GitHub OAuth App, callback `https://<host>/oauth2/callback`); secrets.example.yaml comments (no IRSA, add TELEGRAM_BOT_TOKEN, LLM_API_KEY optional, ghcr-pull example); `.dockerignore` adds `unitmaterial/` and `.claude/`; .env.example, secrets.example.yaml (TELEGRAM_BOT_TOKEN), configmap (TELEGRAM_ALLOWED_IDS, TELEGRAM_ALLOWED_CHATS), deployment comment (single poller), iam-policy.json (DeleteObject on `prod/_probe/*`), README (BotFather: privacy off, add to group, read group ID from admin). Verify: `kubectl kustomize deploy/k8s/overlays/prod` renders; `make run` on read-only rootfs. Rollout is a separate approval; ZY creates the secret.

**1.11 Retire old code (approval)** — delete internal/board, internal/chat, cmd/import, fixtures/board.sample.json, build-plan.md; fix Makefile seed and conflict-test names. Keep reference/condo-board.html. Verify: `make lint test build`; no references to internal/board or internal/chat.

**1.12 Admin operation guide (ZY deliverable)** — `docs/admin-guide.md`, linked from README. Written last in Phase 1 so it reflects what exists; updated again after Phase 1.5 and the deployment steps. Scope: see decisions.md "Admin operation guide". Verify: every command in it is run once (or marked as cluster-only), and ZY reviews it.

## Phase 1.5 steps
**1.5.0 Converter spike (gate; waits for a dense sheet from ZY)** — scratchpad only. Check: legibility vs `pdftoppm -r 300`; text runs map to pixels (rotation, y-flip); peak RSS + time per page, wazero memory vs GOMEMLIMIT; `docker run --read-only --memory=512m --user 65532` on amd64/arm64, no cache writes outside /tmp; binary/vendor growth, Go 1.27; memory returned after close. Fallback: poppler sidecar.

**1.5.1 objstore List + PutBlob** — PutBlob unconditional with content type. Verify: memory + MinIO incl. pagination.

**1.5.2 Docs index** — Index{schema, renderVersion, sheets, lastSync}; Sheet{id, file, rawKey, rawETag, pages[{n,wPx,hPx}], status, title, summary, confirmed, error, renderedAt, removedAt, uploadedBy}; slug from filename with collision suffix. Verify: unit tests.

**1.5.3 Converter (approval: vendored deps)** — convert.go, pdfium.go, fake.go; lazy init, mutex, close after sync; outputs full PNG, overview PNG, text runs. Verify: synthetic PDF in testdata; real sample only via env path, skipped when absent.

**1.5.4 Sync engine** — sync.go + tests; Result persisted as lastSync; Notifier interface. Verify: new/changed/deleted→removed/re-added/version bump/failure retry/idempotent (zero converter + zero notifier calls)/single-flight/one notifier call on change.

**1.5.5 Multimodal LLM + sheet summary** — llm Message Parts + MarshalJSON; summary.go; optional vision flag in Test connection. LLM failure leaves summary empty. Verify: marshal tests; stub asserts image part.

**1.5.6 Schedule + triggers** — schedule.go, config, main. HH:MM in TZ, default 03:00, or off; startup sync after listener up; notify only when counts > 0. Verify: next-run computation with injected clock across midnight.

**1.5.7 Telegram documents + /sync** — PDF ≤20MB → PutBlob docs/raw/ → async sync → "processing…" then summary with OK/Wrong buttons (sets confirmed); same-name replaces (say so); oversize/non-PDF refused with S3 path; /sync reports counts; upload syncs reply only in originating chat; group auth applies. Verify: fake-API tests incl. notify on change, silence on no-op, no double message.

**1.5.8 ask_drawings** — crop.go (SubImage, one-page decode cache; removed sheets excluded); agent tools/prompt/agent. Verify: crop maths; overview-then-crop messages; image cap.

**1.5.9 chateval drawings cases** — rooms (text layer); where is the DB (crop); what WD means (legend); master bedroom width → "no dimensions on this sheet". Skipped without the sample path.

**1.5.11 Drawings admin** — GET /api/docs, POST /api/docs/sync (202, joins in-flight), SSE `docs`, removed sheets greyed. Verify: POST → index change → docs event; second POST doesn't start a second sync; manual Sync now after dropping a PDF into MinIO.

**1.5.10 Deploy (files only)** — memory limit + GOMEMLIMIT from the spike (start 64Mi/512Mi; A1 may need 768Mi–1Gi); IAM DeleteObject on `prod/docs/pages/*` and `prod/docs/text/*` (+ lifecycle rule for noncurrent versions); compose mem_limit; .env.example; README. Verify: `make run`, upload the sample through the bot.

## Phase 1.5 inputs (2026-11-11; for the planner, not yet planned)
- Scope widens from drawings to all documents under `docs/raw/` (ZY). What is there now: 8 drawings (1.0, vector with text; 3 × A1, 5 × A3), checklists (2.0), Novade defects letter + guide (3.0), 24 manuals (4.0), e-voucher guides (5.0), letters (6.0), PPVC/PBU manual (7.0), useful contacts (8.0). 448 pages, ~343k chars of text.
- Text is too long for the prompt: needs a page-level text search tool (keyword is enough at this size; still no vector DB) plus a page/crop image tool for drawings.
- Converter: poppler (pdftoppm/pdftotext) worked as-is; the PDFium WASM spike may be unnecessary. Planner to decide (poppler means leaving distroless, ~+30 MB image).
- Memory: one A1 page at 6000 px peaks at 584 MB; consider ~4000 px, one page at a time, and a 768 Mi–1 Gi limit.
- Model: Claude via the OpenAI layer (vision, tool calling); the layer has no prompt caching and no thinking output.
- Upload path: ZY uploads in the S3 console; Telegram upload (1.5.7) becomes optional. Folders are part of each document's identity; skip `._*` and non-PDFs (report as skipped).
- 1.5.10 IAM paths are at the bucket root now (`docs/pages/*`, `docs/text/*`), not `prod/`.

## Later phase: scanned documents (vision or OCR; not in 1.5)
Documents whose pages have no usable text layer. Phase 1.5 indexes them as 'no text' and leaves them out of text search; reading them needs vision on every page or OCR, planned later.
| Document | Pages | Why |
|---|---|---|
| 4.4 Gas Water Heater / Gas Water Heater.pdf | 16 | no text on any page |
| 4.3 … / Ceiling Fan Operation Manual.pdf | 7 | no text on any page |
| 4.1 … / Main Door Digital Lock User Guide (YDM7116A).pdf | 2 | no text on any page |
| 4.5 Smart Home System / Yale Lockset Smart Control.pdf | 30 | 19 pages without text |
| 4.5 Smart Home System / Lighting Module, Mitsubishi Aircon, Motion Sensor, IoT Gateway guides | 24–28 each | mostly app screenshots, ~80–100 chars of text per page |
| 5.0 … / 5.1 Video on redemption of Guocoland e-Voucher.mp4 | – | video, not a document |
A few pages inside text manuals are also image-only (e.g. fridge 4 of 60, washer 2 of 32); text search simply misses them.

## Deployment via OCI + NKP (potential; not yet planned in detail)
Status: decided in principle (see decisions.md, "Deployment / GitOps"). Needs a planner pass and a read-only cluster check once ZY's NKP cluster is available. Likely shape:
- D.1 `.github/workflows/image.yml`: on `v*` tags, after the image push, `kustomize edit set image` with the digest in the workspace and `flux push artifact oci://ghcr.io/<owner>/movin-tracker-deploy:<version>`; optional cosign signing of image + artifact.
- D.2 `deploy/k8s/overlays/prod`: drop namespace.yaml and the namespace field.
- D.3 New `deploy/flux/`: kustomization.yaml + OCIRepository (semver >=1.0.0, secretRef ghcr-pull) + Flux Kustomization (./overlays/prod, prune, same service account as the NKP project).
- D.4 README: release, rollback, pause; ZY creates ghcr-pull and app secrets in the project namespace.

## Phase 2 (room left, not built)
attachments[]{key,mime} on entries + `<prefix>/media/`; agent.Request.Images; Telegram dispatch by message type; settings `stt` section; `docs/facts/<sheet>.json` + reviewed flag.

## Risks
- Bot token leaking through URL errors (scrub; tested in 1.8).
- Duplicate write on crash mid-turn (accepted).
- Model vision/tool-calling quality on dense CAD unknown until 1.5.9; default MaxTokens 1024 may truncate drawing answers.
- WASM blob grows vendor/.
- Telegram allowlist editable by anyone passing ALLOWED_EMAILS (same two people).
- A basic group upgraded to a supergroup gets a new chat ID; it shows up in the rejected list.
