# movin-tracker v3: plan

> **Status 2026-11-20:** approved in outline by ZY (see `decisions.md`); progress in `progress.md`.

Source: planner, 2026-11-20 (original v3 plan + revision for ZY's answers, Velero and the Claude removal), with facts checked in the main session the same day. Decisions live in `decisions.md`; progress in `progress.md`.

Rules for every step: changes are to the local repo only, under `app/` until T7; the Go code is not touched before T7 (a `v1.0.x` hotfix must stay possible). `make lint && make test` (Go) and `make -C app lint test` green after each step; rollback = revert that step's files. New dependencies, deletions, `kubectl apply`, tags and secrets need ZY's approval. Cluster commands end with `--kubeconfig kubeconfigs/zy-all-in-one.conf` (in `zy-ops`) and changes are run by ZY.

## Order
T0: T0.1 → T0.2 → T0.3 (gate)
T1 domain: T1.1 → T1.2 → T1.3 → T1.4 → T1.5
T2 web: T2.1 → T2.2 → T2.3
T3 agent: T3.1 → T3.2 → T3.3 → T3.4 → T3.5 → T3.6 (checkpoint: TS dev app usable on the web)
T4 Telegram: T4.1 → T4.2 → T4.3 → T4.4
T5 scheduled work: T5.1 → T5.2 → T5.3
T6 cutover: T6.1 → T6.2 → T6.3 → T6.4 → T6.5 → T6.6; T6.7 (Velero) any time, not blocking
T7: T7.1 → T7.2
(T6.3, the Flux pin, may merge any time earlier; it must be live before any tag above 1.0.x.)

## Layout (`app/` until T7.2, then the repo root)
| Path | Role |
|---|---|
| src/objstore | S3 + memory store: conditional put, list, stat, delete |
| src/entries | model, service (ETag retry, poll, subscribe), journal, search, agenda |
| src/settings | settings.json sections, Fernet (node:crypto), LLM resolve, Telegram, check-in |
| src/docs | index, sync, search, summary, poppler convert + render |
| src/llm | one OpenAI-compatible connection on pi-ai; models list, probes |
| src/durable/adapter.ts | the only file that imports pi-durable; SQLite store at `/data/harness.db` |
| src/agent | tools, prompt (snapshot + deltas), run limits, hooks |
| src/telegram | client, intake, delivery task, commands |
| src/tasks | checkin.ts, docsync.ts |
| src/server | REST + SSE, admin, web chat |
| static/ | index.html, guide.html (copied, then edited) |
| eval/ | chateval port |

## Design
### Storage
- S3, formats unchanged: `entries.json`, `settings.json`, `checkin.json`, `docs/**`. No migration either way. No new entry or settings fields in v2.0.0 (a Go rollback would drop them on save).
- SQLite on the volume: transcripts, durable tasks, request-ID dedupe, chat → conversation directory, Telegram polling offset. Losing it loses chat history only.
- Volume: PVC `movin-data`, 1Gi RWO, `nutanix-volume`, mounted at `/data`; root filesystem stays read-only; fsGroup 65532 already set. The class has reclaimPolicy **Delete** (deleting the PVC destroys the volume), WaitForFirstConsumer (the PVC stays Pending until the v2 pod is scheduled) and allows expansion. The PVC is applied by hand from `deploy/manual/pvc.yaml` and is never in the Flux artifact, so `prune: true` cannot remove it.

### Backup and restore (Velero; no in-app backup)
- Velero runs on zy-all-in-one (NKP workspace app, namespace `zy-all-in-one-workspace`, checked 2026-11-20): BSL `default` = AWS S3 `zyallinonebackups` (ap-southeast-1), Available; Schedule `velero-default` daily 00:00, whole cluster, TTL 720h; uploader kopia but **no node-agent** DaemonSet; `nutanix-snapshot-class` has **no** `velero.io/csi-volumesnapshot-class` label; no backup has run yet. As it stands, Velero would back up the PVC object but **not its data**.
- What T6.7 needs (cluster change, ZY approves): label `nutanix-snapshot-class` with `velero.io/csi-volumesnapshot-class: "true"` (decided 2026-11-20; snapshots stay on the same Nutanix storage, not off-site). Check whether this Velero version needs `--features=EnableCSI`.
- movin's own Schedule covers namespace `movin-tracker`, PVC/PV only (secrets and the rest come from Flux or are hand-applied). Note: `velero-default` already copies the whole cluster, `movin-secrets` included, into the backup bucket; that is a cluster-wide choice, outside this plan.
- App side, restore-safe start, two triggers:
  - **Explicit:** optional env `HARNESS_RESTORE_ID` from a hand-applied ConfigMap `movin-restore` (`envFrom … optional: true`, outside the artifact). If the ID differs from the one recorded in SQLite, the restore path runs, then the ID is recorded (one-shot, leaving it set is harmless).
  - **Automatic:** a start counter kept both in SQLite and in S3 (`harness/<instance>/epoch.json`, `instance` = `dev` | `prod`, conditional put). Each start increments both. If the SQLite counter is behind the S3 one, the database was restored and the restore path runs.
  - **Restore path, before `resume()`:** rotate `movin.epoch`; abort every non-terminal run and pending delivery task (no old reply resent, no tool replayed); drop the stored polling offset (Telegram's own pending queue is used; known request IDs are ignored); recreate the scheduled tasks from settings (the `checkin.json` claim still prevents a double send).

### Conversations
- One per Telegram chat (`tg:<chat_id>`); one web conversation for ZY's email (`web:<email>`; ZY is the only web user), history on the server.
- Idle reset after 6 h, compaction as the fallback.

### LLM: one OpenAI-compatible connection
- The connection in use (`settings.json`, read 2026-11-20): `kind:"openai"`, NAI gateway `https://nai.yolocal.cloud/enterpriseai/gateway/v1`, model `movin-backend`, vision on, streaming on, thinkOnDemand on, key saved. ZY routes any model (Claude included) through this gateway. v2 docs saying "Claude native" are out of date.
- Removed: `kind=claude`, the Anthropic SDK, cache breakpoints, effort mapping, refusal fallbacks, `LLM_CLAUDE_BASE_URL`, `claudeOrigin`, the `api.anthropic.com` special case on the models list (that host is not supported). `LLM_KIND` may be unset or `openai`; `claude` fails at start with a clear message.
- Reading settings.json: `llm.kind` absent or `openai` → used as today. `llm.kind == "claude"` (only from an old v1 save) → the stored llm section is ignored (key never decrypted or sent), env `LLM_*` applies, the view carries `legacyKind: "claude"`. Nothing is rewritten on read.
- Saving writes Go's exact field set (`kind:"openai"`, baseUrl, apiKeyEnc, model, vision, streaming, thinkOnDemand) by read-modify-write of the raw sections with the ETag guard; unknown sections are kept.
- Key rules ported unchanged: a stored or env key goes only to the origin it was saved for; moving host without typing a key drops it.
- `thinkOnDemand` keeps its OpenAI meaning (thinking off unless the message starts with `/think`). Vision comes from the Save probe.
- Retries are the same for every endpoint (pi-durable `settings.retry`).
- Prompt caching is the gateway's: the app keeps a stable prefix and logs `cached_tokens` when reported. A content-filter stop gives the neutral "declined, rephrase" reply and keeps earlier changes.

### Prompt
- System prompt: rules, rooms, document index (static between syncs).
- First user message of a conversation (and after a reset or compaction): snapshot of the ~150 latest entries. Later turns: "changed since your last message" deltas. Today's date and key dates travel with each user message.

### Tools
- Same eight. Reads are replay-safe.
- Writes derive the change ID from `sha256(epoch|taskId|index)` (base32, 26 chars, so `undo:<id>` fits Telegram's 64-byte callback data); a rerun finds its earlier journal record and returns it instead of writing again. `epoch` is a UUID in a session doc (`movin.epoch`), created with the database and rotated by the restore path: task ids are small per-database counters, so without it dev and prod collide on the shared journal and a restored database reuses ids, silently skipping new writes (found in T0.2). As a second guard the last 10 characters of the change ID are a hash of the call's arguments (decisions.md, 2026-11-20); a found record with the same prefix but a different hash is a collision, logged, and the write goes ahead with a fresh id.
- `set_dates` is not journaled, as in Go: a meta record would become "the latest change", so an undo without an id would be refused, and Go's `/recent` crashes on it while the bucket is shared. A rerun after a crash writes the same dates again (decisions.md, 2026-11-22).
- Images: at most 6 per run, counted in the tool; images from earlier runs are replaced by a placeholder before each request.

### Telegram
- Each update is submitted with `requestId tg:<update_id>` before the offset moves.
- Replies and Undo buttons are sent by a durable delivery task: at-least-once, a rare duplicate chunk after a crash is accepted. A run that ends without an answer gets the fixed failure line from the host.
- Commands (`/undo`, `/recent`, `/sync`, `/start`, `/help`, `/checkin`) and callbacks stay at-most-once.
- Auth and the rejected list as today, checked before submit. Group silence is a `stay_silent` tool.

### Deploy
- One Node 24 container (alpine + poppler-utils + font, uid 65532), oauth2-proxy and the tunnel unchanged.
- Memory: request 128Mi, limit 384Mi, `NODE_OPTIONS=--max-old-space-size=256` (T0.2: cgroup peak 46 MB with an A1 render, Node RSS 75–87 MB); re-measured in T6.1.
- Every conversation the adapter creates gets the model set explicitly (T0.2: no model → `no_model`).
- `main.ts` exits when the harness closes with `failed`, so Kubernetes restarts the pod.
- Released as `v2.0.0`; Flux pinned to exact versions from T6.3 on.

## Steps
**T0.1 Dependency list [approval]** — report for each: version, licence, transitive count, native builds. pi-durable + pi-ai (+ chord, pi-schema) pinned at exactly 1.5.2 (adopted now; upgraded only when something breaks), S3 client, SQLite driver (whatever pi-durable's backend needs), TypeScript toolchain. No Anthropic SDK; Fernet on node:crypto, no package. Verify: `npm ci` from the lockfile in a clean container; report whether pi-ai pulls a provider SDK transitively and that nothing loads it at start; the API names this plan relies on (`requestId`, `resume()`, `sleepUntil`, `api.taskId`, faux provider, image output from own tools) exist in 1.5.2.

**T0.2 Crash, replay and memory spike (scratchpad; gate)** — container with `--read-only --user 65532 --memory=512m`, `/data` volume, `--max-old-space-size=256`. Verify: kill -9 during a write tool and again after it → after restart exactly one journal record and one reply; RSS at rest and while poppler renders an A1 crop; restore path aborts a live run before `resume()`; numbers in progress.md decide the limits.

**T0.3 Prompt layout confirmation** — snapshot + deltas is decided; this checks it on the NAI gateway (`movin-backend`). Verify: request k+1 starts byte-equal to request k; tool calling passes; whether `cached_tokens` is reported; latency and cost per message recorded next to v1's (2.6 s, 80–90% cache reads on Claude native). Fails the gate only if tool calling fails.

**T1.1 Scaffold** — `app/` package, tsconfig, lint, tests, Makefile targets, Docker test image. Verify: `make -C app lint test` green on an empty suite; Go targets unchanged.

**T1.2 Object store** — S3 + memory. Verify: conditional put, 412, list pagination, delete on memory + MinIO.

**T1.3 Entries, journal, search, agenda** — port with replay-safe change IDs. Verify: ported Go table tests; `fixtures/entries.sample.json` round-trips byte-compatible for Go; same change ID twice → one record; undo rules; journal cap; conflict test ported.

**T1.4 Settings** — sections, Fernet, LLM resolve as in Design, Telegram, check-in. Verify: a Go-encrypted key fixture decrypts; `kind:"claude"` fixture → env connection, `legacyKind` set, key not used, file untouched after read; save writes `kind:"openai"` and keeps telegram/check-in/unknown sections; a Go-style re-save of the result loses nothing; origin-binding tests ported; `LLM_KIND=claude` refuses to start.

**T1.5 Documents** — index, sync engine, search, summary, poppler convert + render. Verify: ported tests on the synthetic PDF; index written by TS reads in Go; timeout kills the child.

**T2.1 REST + SSE** — entries, meta, undo, events, readyz/healthz. Verify: ported REST/409/SSE tests.

**T2.2 Admin routes** — storage + probe, Telegram view, check-in, docs, guide, LLM settings. `/api/settings/llm/test` and `/models` take a URL only; a body with `kind:"claude"` → 400; the view has no `claudeOrigin`. Verify: key-leak tests ported; test/models never send the saved key to another origin.

**T2.3 Page + side-by-side run** — `static/index.html`: remove the kind radios, `claudeNote`, `anthHint`, `connKind`/`claudeOrigin`/`targetURL` and the per-kind think wording (around lines 401–405, 998–1046, 1283–1284); add the legacy notice and a confirm before saving over a Claude connection. `check.mjs` drops the Claude block (218–238); `fakellm.py` drops `/v1/messages`. Verify: UI check green except chat; Go and TS dev apps on the shared bucket see each other's entry edits; opening the TS LLM tab leaves `settings.json` unchanged.

**T3.1 LLM layer** — pi-ai, OpenAI-compatible only; models list, tool-calling and vision probes; usage logging. Verify: against the stub: request shape, think on/off, images, 401/429/5xx mapping and retry, key scrubbed from errors; no Anthropic code path in the build.

**T3.2 Durable adapter** — `durable/adapter.ts`, SQLite at `/data`, conversation directory, idle reset, compaction. Verify: restart keeps history; 6 h reset with an injected clock; only this file imports pi-durable (lint rule).

**T3.3 Tools** — eight tools, auth hook for writes, image cap. Verify: scripted runs on the faux provider; crash between write and reply replays to one record; unknown tool → error result.

**T3.4 Prompt** — sections, snapshot, deltas. Verify: no write between turns → no delta and identical prefix; one edit → one delta line; reset → fresh snapshot.

**T3.5 Web chat** — one conversation for ZY's email, streaming over the existing live-update stream, change lines with Undo. Verify: reload shows server history; two tabs stay in step; UI check fully green.

**T3.6 chateval port** — `eval/`, `make chat-eval` (env endpoint or `-saved`, i.e. the NAI gateway), document cases kept; `chat-eval-claude` target removed. Verify: 12/12 on `movin-backend` (measured, not a gate); usage totals printed next to v1's. **Checkpoint: TS dev app usable on the web.**

**T4.1 Client** — Bot API client. Verify: fake API; token never in errors.

**T4.2 Intake** — polling, auth, submit-then-advance, 15-minute watchdog abort. Verify: duplicate update once; crash before the offset moves → processed once; group/private auth cases; 409 backoff; two chats run in parallel.

**T4.3 Delivery task** — replies, splitting at 4096, Undo buttons, `stay_silent`, failure line. Verify: crash before send → sent after restart; crash mid-send → at most one duplicate chunk.

**T4.4 Commands + callbacks** — at-most-once. Verify: `/undo` twice undoes two different changes, never the same one; callback auth. Manual: dev bot token and test group from ZY.

**T5.1 Check-in task** — durable `sleepUntil`; the send step keeps the `checkin.json` claim. Verify: Go and TS dev apps both due → one message; restart mid-sleep keeps the schedule; a settings change reschedules; catch-up until 20:00.

**T5.2 Docs sync task** — daily, startup, `/sync`, web button; single-flight; conditional index write. Verify: ported sync tests; notify only on change; fake clock across midnight.

**T5.3 Restore safety + Velero notes** — restore path with both triggers (Design); `docs/movin-v3/velero.md`; guide section "Chat history backup". The notes cover: the movin Schedule (namespace `movin-tracker`, PVC `movin-data` only, daily, keep 7 days), the snapshot-class label, a restore drill into a scratch namespace with an integrity check, and the real restore order (suspend Flux → scale to 0 → restore the PVC → apply `movin-restore` with a new ID → resume). Verify: tests with a DB copied mid-run: new ID → run aborted, nothing resent, offset reset, tasks recreated; same ID again → normal start; no ID but SQLite counter behind S3 → restore path; counters equal → normal start; dev and prod counters independent.

**T6.1 Image + CI** — Dockerfile (Node 24 alpine + poppler, by digest), `.github/workflows/image.yml` builds from `app/`. Verify: `make run` on a read-only rootfs with a `/data` volume; image size and RSS recorded.

**T6.2 Manifests (files only)** — deployment: `/data` mount, resources, `NODE_OPTIONS`, exec liveness, optional `movin-restore` envFrom, `/tmp` 32Mi; `deploy/manual/pvc.yaml` outside every kustomization; `.env.example` and configmap lose the Claude variables. Verify: `kubectl kustomize deploy/k8s/overlays/prod` renders; the rendered artifact contains no PVC.

**T6.3 Flux pin [approval]** — `deploy/flux/ocirepository.yaml`: `semver: "1.0.x"` (today `">=1.0.0"`, which would roll out any v2 tag at once). Verify (read-only): `kubectl get ocirepository movin -n movin-tracker` still shows the current 1.0.x revision. Rollback: restore `">=1.0.0"`.

**T6.4 Volume [ZY applies]** — `kubectl apply -f deploy/manual/pvc.yaml -n movin-tracker`. Verify (read-only): `kubectl get pvc movin-data -n movin-tracker` → Pending (WaitForFirstConsumer) until T6.6, then Bound. Rollback: none needed; deleting the PVC destroys the volume and needs approval.

**T6.5 LLM connection check** — the saved connection is already OpenAI-compatible (NAI gateway, `movin-backend`; read 2026-11-20). Verify: `settings.json` still shows `kind:"openai"` just before cutover; one Telegram and one web message answer on v1 through it. If it was switched back to Claude meanwhile, ZY re-saves it in the v1 page.

**T6.6 Cutover [approval]** — stop both dev apps; pin `semver: "2.0.0"`, tag `v2.0.0`. Verify: pod 2/2, PVC Bound, `/readyz`; one Telegram write + Undo; web chat history survives a pod delete; check-in fires once next morning. Rollback: pin back to the last 1.0.x; entries, settings and docs need nothing; the PVC stays; chat history made on v2 is not visible to v1.

**T6.7 Velero for the volume (separate ops change, not blocking)** — ZY approves the cluster part (snapshot-class label), then applies the movin Schedule from `velero.md`, runs the restore drill, records it in progress.md. Until then the README and guide state that the volume's data is not backed up.

**T7.1 Delete Go [approval]** — after ZY accepts v2 in production: `cmd/`, `internal/`, `vendor/`, `go.mod`, `go.sum`, `.golangci.yml`, `.air.toml`, Go Makefile targets, Go test fixtures no longer used. Verify: no Go file left; CI green.

**T7.2 Move `app/` to the root** — `git mv`, fix Dockerfile, Makefile, CI, compose, `AGENTS.md` (TypeScript, `docs/movin-v3/`), admin guide (Claude sections at lines 185–199, 215, 352–354 rewritten for one endpoint). Verify: `make lint test build`; tag `v2.0.1` deploys with no behaviour change.

After the last step: one strict review of all new code.

## Migration and risks
- Rollback to Go is safe while v2 adds no entry or settings fields and the PVC stays outside Flux.
- pi-durable is experimental: one adapter file, exact pins, T0 gate.
- Prompt caching depends on the gateway: expect higher cost and slower first tokens than v1's Claude native if the gateway does not cache (T0.3 records the numbers).
- A `kind:"claude"` connection saved by v1 is ignored, not converted: chat on v2 then falls back to env `LLM_*`.
- The volume's data has no backup until T6.7 (Velero is up, but the snapshot class is not labelled yet). After T6.7 the snapshots sit on the same Nutanix storage as the volume (accepted).
- The PVC's reclaim policy is Delete.
- Instructions inside documents: unchanged rule, only entry tools write, each with Undo.
