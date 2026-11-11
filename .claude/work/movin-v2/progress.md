# movin-tracker v2: progress

Tick a step only after its verification passes; put the evidence (command + result) next to it.

## Phase 1
- [x] 1.0 Baseline — 2026-11-11: `make lint` → lint ok; `make test` → board, objstore, server ok. Committed 155d264.
- [x] 1.1 Entries model — 2026-11-11: `internal/entries/model.go` + `model_test.go`; `make lint` → lint ok; `make test` → all packages ok; entries: 41 test cases pass (field rules, status per kind, kind-change remap, time needs date, decode normalisation, deep clone, meta).
- [x] 1.2 Entries service + journal — 2026-11-11: `service.go`, `journal.go`, `service_test.go`; `make lint` ok; `make test` all ok; `-v` shows memory + s3 (MinIO) subtests pass for CRUD, Undo, ConflictBothChangesSurvive, ConcurrentWriters (19–20 kept, 0–1 409s, none lost). Undo: create/update/delete, undo-of-undo, refused after later edit, refused twice; journal cap 200; Recent by person. Note: undo compares the whole entry to the change's After (not timestamps), so same-second edits can't fool it.
- [x] 1.3 Search — 2026-11-11: `search.go`, `search_test.go`; `make lint` ok; `make test` all ok. 15 filter cases (kind/room/status any-of, category, tags all-of, vendor substring, text words across title/notes/vendor/category/source/kind/tags/room, inclusive date range, archived excluded by default, newest first, limit) + total/default 50/max 200/copies.
- [x] 1.4 Agent core — 2026-11-11: `internal/agent/{agent,tools,prompt,history}.go` + `agent_test.go` (scripted stub LLM, stream and non-stream); `make lint` ok; `make test` all ok. Covers: change lines carry journal IDs; by/channel stamped; search→update flow; archive; tool errors (unknown tool, bad room, bad JSON) returned to the model; forced final round; undo_change without id undoes the caller's latest; set_dates; group silence (NO_REPLY honoured only in groups and only with zero changes); prompt caps at 150 entries. `internal/chat` still exists and is wired to the server until 1.6; its server tests move/retire in 1.6/1.11.
- [x] 1.5 chateval port — 2026-11-11: `cmd/chateval/main.go` rewritten for entries + `fixtures/entries.sample.json`; 10 cases (move-in date, idea with room, decision with cost+vendor, Friday 2pm task, quote+30% paid updates not duplicates, ambiguous bathroom → question + no change, countertop Q&A → no change, drop → archive, undo, group chatter → silent). `make chat-eval` against local vMLX `mlx-community/Qwen3.8-27B-mxfp4` (`LLM_BASE_URL=http://host.docker.internal:8081/v1`): 10/10 pass twice, 25–58 s per message. Found vMLX leaking `<|im_end|>` into replies → `llm.StripSpecialTokens` added (+ test); `make lint`/`make test` ok.
- [x] 1.6 Server + main switch — 2026-11-11: `internal/server/server.go`, `server_test.go`, `cmd/movin/main.go`, Makefile `seed` → entries.sample.json. Routes: GET/POST /api/entries, PATCH/DELETE /api/entries/{id}, POST /api/changes/{id}/undo, PUT /api/meta, SSE event `entries`, POST /api/chat via agent (channel web; changes are {id,text}). Write responses carry `change{id,text}`. `make lint` ok, `make test` all ok (12 server tests incl. memory+s3 REST CRUD with undo 200/409/404, 409 with latest doc, SSE, settings tests unchanged). Smoke: `make dev` + `make seed` → 5 entries served from MinIO; POST returns `Saved: flex · note · Smoke test`. Web chat call hit the LLM settings saved earlier in local MinIO (`nai-uep-backend`, Cloudflare 530/1033 tunnel down) — settings.json overrides .env; not changed. Frontend still on the old API until 1.7.
- [x] 1.6a Storage introspection + probe — 2026-11-11: objstore `Stat` (LastModified), `Delete`, `Info`/`Describer` (credential source label only), `CredentialLabel`; `internal/server/admin.go`: GET /api/admin/storage (last write = entries.json LastModified, per decision; no Tracked decorator needed), POST /api/admin/storage/test (6 steps on `_probe/<ulid>.json`, single-flight, delete always attempted once the object exists). `make lint` ok, `make test` all ok; memory + s3 subtests: view, no key material in body, lastWrite advances, probe 6/6 leaves nothing; denied delete → 5 pass + 1 fail; storage ignoring If-Match → stale step fails, cleanup still runs. Live on dev stack: s3 / movin-dev / dev / minio / env keys; probe 6/6 in <10 ms.
- [x] 1.7 Frontend — 2026-11-11: `static/index.html` rewritten on entries (look kept). Four merged columns (Ideas & to do · Shortlisted & doing · Decided · Done, Done capped at 12 with Show all), cards coloured by kind, status pill cycles within the kind's statuses, desktop drag between columns (task → Decided refused), filters room/kind/category/search (remembered per browser), dialog with kind/status/room/category/date/time/estimate/paid/vendor/source/tags/notes, calendar on date+time, header countdown + F3 totals (+ 'not yet decided' line), banner and chat change lines with Undo, coming-up strip retired, settings drawer unchanged. Verified with headless Chrome over CDP (`tmp/ui-check/check.mjs`, git-ignored): 18/18 checks (load, columns, totals, status cycle + Undo, dialog create, kind→status remap, filter/clear, SSE outside change, calendar, chat Undo lines, no phone-width overflow, no console errors); screenshots reviewed (desktop 1440, phone 390). `make lint`/`make test` ok.
- [x] 1.7a Admin shell: Storage + LLM tabs — 2026-11-11: settings drawer → tabbed 'Settings' panel (Storage | LLM; Telegram and Drawings tabs present but hidden), opened from a new header 'Settings' link (last tab remembered) or the chat gear (LLM tab). Storage tab: read-only bucket/region/prefix/endpoint/credential source/last write + Test connection with per-step results. LLM tab is the old form, unchanged. Arrow keys move between tabs; Escape closes and returns focus. Screenshot review caught the LLM footer still showing on the Storage tab (`.drawer .foot2{display:flex}` beat `[hidden]`) → fixed, and the UI check now asserts computed visibility. `tmp/ui-check/check.mjs` 26/26; `make lint`/`make test` ok, TestSettingsKeyNeverLeaks green.
- [ ] 1.8 Telegram client
- [ ] 1.8a Settings: Telegram section
- [ ] 1.9 Telegram bot
- [ ] 1.9a Telegram admin
- [ ] 1.10 Config + manifests (files only)
- [ ] 1.11 Retire old code (needs ZY approval)

## Phase 1.5
- [ ] 1.5.0 Converter spike — blocked: waiting for a dense electrical/plumbing sheet from ZY
- [ ] 1.5.1 objstore List + PutBlob
- [ ] 1.5.2 Docs index
- [ ] 1.5.3 Converter (needs approval for vendored deps)
- [ ] 1.5.4 Sync engine
- [ ] 1.5.5 Multimodal LLM + sheet summary
- [ ] 1.5.6 Schedule + triggers
- [ ] 1.5.7 Telegram documents + /sync
- [ ] 1.5.8 ask_drawings
- [ ] 1.5.9 chateval drawings cases
- [ ] 1.5.11 Drawings admin
- [ ] 1.5.10 Deploy files
