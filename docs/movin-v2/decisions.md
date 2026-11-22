# movin-tracker v2: decisions

All decided by ZY unless noted. Newest at the bottom of each section.

## Direction (2026-11-11)
- Reorg from a kanban board with chat into a renovation **agent**. Main channel: **Telegram**. The web page stays for visibility (kanban + calendar) and becomes a **management plane**; web chat is kept as a secondary channel.
- **Start fresh**: no migration of the old `board.json` (left untouched in S3).
- Model choice is ZY's, made later. Requirement: tool calling + image input. The runtime LLM settings drawer stays, and the Telegram bot uses the same runtime settings.

## Data
- Records are structured **entries**, not free-text memory. Fields: kind (idea|decision|task|note|question), room (optional), category, status, cost {estimate, actual}, vendor, date, **time (kept, F6)**, source, notes, tags, archived, by, channel, timestamps.
- Statuses: idea → shortlisted → decided → done; tasks use todo/doing/done. Notes and questions default to idea (F4).
- Rooms (from the C5 unit layout): living, dining, dry kitchen, wet kitchen, flex, master bedroom, bedroom 2, bedroom 3, master bathroom, bathroom 2, balcony, whole-house. No "AC ledge", no "unknown"; room is optional instead.
- Retrieval is structured filters + keyword search. No vector DB.
- Kanban: four merged columns, Idea/To do · Shortlisted/Doing · Decided · Done (F4).
- Costs: estimate = quoted, actual = paid, to-pay = estimate − actual. Header totals count only tasks and decided/done entries (F3).
- Header keeps the move-in countdown and the quoted/paid/to-pay totals.
- Agent tools: add_entry, update_entry, search_entries, set_dates, undo_change, ~~ask_drawings (1.5)~~ (became the three document tools, see "Connections + documents plan answers"). Archiving via update_entry; hard delete is web-only (F2).

## Telegram
- Long polling inside the app process; outbound only; single replica required (one poller per token).
- A **dedicated shared group** (ZY, spouse, bot), privacy mode off; every group message is input. Private chats with allowlisted users also allowed. Authorise on both group ID and sender ID.
- `by` names come from config (`id=name`).
- Sync notifications go to the group only when a sync changed something.

## Drawings (phase 1.5) — superseded
Superseded on 2026-11-11 by "Connections + documents plan answers" (no stored page images, on-demand crops, poppler instead of PDFium) and widened from drawings to all documents. Kept for history.
- Do not vectorize drawings. Raw PDF in S3 is the source of truth; renders are a disposable, versioned cache.
- Server-side conversion: PDF → high-res PNG + overview PNG + text layer with positions, all stored in S3. The LLM consumes PNGs (overview + crops) plus the text layer.
- Render cap ~6000 px long edge; one render/crop at a time (F1).
- Sync triggers: Telegram upload, startup, daily 03:00 SGT (in-process), `/sync`, and the web "Sync now" button. Manifest-based; deleted PDFs mark the sheet "removed".
- Converter: PDFium WASM in-process preferred, poppler sidecar fallback; decided by the 1.5.0 spike on a dense electrical/plumbing sheet (ZY to supply).

## Management plane
- Storage section is **read-only** (bucket, region, prefix, credential source, test connection). Credentials and bucket stay in env/Secret, because settings.json itself lives in S3 and the pod is stateless.
- LLM editable (as today). Telegram: status + editable allowlist (users, groups) in settings.json; token stays in the Secret. Drawings: sheet list + Sync now (built as the **Documents** tab). Later the Telegram tab also got the editable check-in time and chat (2026-11-12).

## Deployment and safety
- No egress restrictions assumed.
- ~~IAM DeleteObject only on `<prefix>/docs/pages/*` and `<prefix>/docs/text/*` (F5).~~ Superseded: there is no prefix (one bucket), no `docs/pages/` (renders aren't stored), and sync never deletes, so no DeleteObject beyond `_probe/*` (1.5.13). The IAM policy file was dropped on 2026-11-12 (see 'No fine-grained IAM').
- ZY creates secrets and runs any kubectl apply / IAM change.
- Real unit drawings never go into git (`/unitmaterial/` is ignored).

## Housekeeping
- Baseline committed on main: 155d264 (2026-11-11).
- Delete `build-plan.md` in step 1.11; keep `reference/condo-board.html` for now.
- Track work in `docs/movin-v2/` (committed).

## Planner delta answers (2026-11-11)
- Storage test connection deletes its probe object: grant `s3:DeleteObject` on `prod/_probe/*` (step 1.10).
- Group-ID env default is `TELEGRAM_ALLOWED_CHATS`.
- "Last successful write" on the storage page reads `LastModified` of `entries.json`, so it survives restarts.
- Group chatter: the bot stays silent unless it recorded something or was asked a question.

## Deployment / GitOps (2026-11-11)
- Target: an NKP project. Flux runs there; the project namespace exists and NKP's project GitOps watches a git path with a kustomization.yaml.
- No CI commits to the repo. Releases are `git tag vX.Y.Z`.
- CI on `v*` tags: push the image, render the prod overlay with the image pinned by digest (in the CI workspace only), and `flux push artifact` it to a private GHCR package `movin-tracker-deploy:X.Y.Z` (optionally cosign-signed).
- Bridge: NKP watches a static `deploy/flux/` folder holding an OCIRepository (semver `>=1.0.0`, secretRef ghcr-pull) and a Flux Kustomization (path ./overlays/prod, prune). Rollback = hand-edit a tag pin there.
- The overlay drops namespace.yaml and `namespace: movin`; the NKP project owns the namespace.
- NKP service-account permissions for creating Flux objects: ZY will fix if needed. No cluster available yet; planner + cluster check happen when ZY says it's up.

## Secrets and sign-in (2026-11-11)
- Secrets are created by hand in the NKP project namespace for now; SOPS + Flux (one age key) is the later option if rotation gets tedious.
- Manual secrets: `movin-secrets` (AWS_ACCESS_KEY_ID/SECRET — static IAM user, NKP has no IRSA; SETTINGS_SECRET — self-generated Fernet key, separate from dev, kept stable; TELEGRAM_BOT_TOKEN; LLM_API_KEY optional, prefer the admin page), `oauth2-proxy` (client id/secret + cookie secret), `ghcr-pull` (GitHub token, read:packages, for Flux to pull the private deploy artifact).
- Web sign-in: **GitHub OAuth App** via oauth2-proxy (`provider = "github"`, ~~`scope = "user:email"`~~ `scope = "user:email read:org"` since 2026-11-15: oauth2-proxy v7.12 lists orgs during sign-in and got 403 without it; email allowlist kept). Telegram does not use OAuth.
- The app image on GHCR is **public** (binary + embedded frontend only, no config or secrets). The deploy artifact stays **private**.
- After editing a hand-made secret: `kubectl rollout restart deploy/movin` (or Reloader annotation if NKP has it).

## Admin operation guide (2026-11-11)
- ZY needs an **admin operation guide** as a Phase 1 deliverable (step 1.12), written at the end of Phase 1 so it matches what was built. Audience: ZY operating the app. Covers: first-time setup (BotFather, privacy off, GitHub OAuth App, Fernet key, IAM user, GHCR token), the NKP secrets and what each is for, deploy/release/rollback/pause (OCI + Flux, once D.* lands), the admin page (Storage, LLM, Telegram tabs), adding people and the group (rejected list), rotating secrets and restarting, local dev (`make dev`, `.env`, vMLX via host.docker.internal), and troubleshooting (409 second poller, saved LLM endpoint down, storage test failures, supergroup ID change).

## Review timing (2026-11-11)
- No separate code review while steps are still being built. Run one review (strict-reviewer) once all planned code is complete; per-step lint/tests/UI checks continue as usual.

## One bucket for everything (2026-11-11)
- Production isn't ready, so ZY uses the real AWS bucket now. **Dev and production share one bucket and no prefix**: one copy of the data; later only where the containers run changes.
- So: `make dev` / `make run` read S3 from `.env`; MinIO is for `make test` only (fixed values in compose, never from `.env`). The dev port is published on 127.0.0.1 only (real data, no sign-in).
- **Same SETTINGS_SECRET in dev and production** (replaces "separate from dev" above): settings.json is shared.
- One bot poller per token: once production runs the bot, `.env` drops TELEGRAM_BOT_TOKEN.
- ~~IAM policy covers the bucket root (`<bucket>/*`, delete on `_probe/*`)~~ (dropped 2026-11-12); kustomize `S3_PREFIX=` empty. Documents go to `docs/raw/` (and the 1.5 caches to `docs/pages/`, `docs/text/`, no prefix).
- Latency: thinking stays on for now; prompt caching on the model server is ZY's, later.

## LLM settings kept minimal (2026-11-11)
- ZY: no temperature, max tokens, timeout or tool-round settings; leave them to the model. The page has endpoint, key, model, streaming and 'Think only when asked'. Test connection comes before picking a model.

## Documents in the bucket (2026-11-11)
- Raw documents live under `docs/raw/`, and ZY may organise them in subfolders (`docs/raw/<folder>/.../<file>.pdf`). Phase 1.5 must list `docs/raw/` recursively and treat the full key (folder path included) as the document's identity; derived caches mirror that path under `docs/pages/` and `docs/text/`.
- First upload: `docs/raw/1.1 Type C5 Unit Layout Plan.pdf` (2026-11-11).

## Checkpoint before the Phase 1.5 planner (2026-11-11)
- LLM: **Claude** is the plan for now (may switch later), ~~through the OpenAI-compatible endpoint `https://api.anthropic.com/v1/`~~ (superseded: Claude native connection, built in 1.15; saved connection today is Claude native, Opus 5.5). Recommendation given: `claude-opus-5-5` (best on dense drawings and tool use); `claude-sonnet-5-5` is the faster, cheaper option. ZY picks in Settings → LLM.
- Scanned / image-only documents (list in plan.md 'Later phase: scanned documents') go to a later phase; 1.5 covers documents with a text layer plus drawing images.
- Deleted the 20 `._*` files from `docs/raw/` (ZY OK).
- Entries from the documents: broadband + router (ZY: needed before smart home works), Fermax activation, ask Fermax before renovation, defects via Novade, contacts.
- Novade password in 3.1: ZY already changed it; no special handling needed for that document.
- ~~Bucket versioning stays **off** for now (ZY, 2026-11-11), until there is a need.~~ Superseded 2026-11-12: versioning **on** (see the end of this file). Consequence: no S3-level undo; the in-app journal (last 200 changes) is the only undo. The admin guide's "Recover older data" applies only once versioning is on.
- LLM connection gets **two kinds** (ZY): OpenAI-compatible (vMLX now, NAI later) and **Claude native** (Messages API, for prompt caching). Planned together with the widened Phase 1.5.

## Connections + documents plan answers (2026-11-11)
1. Refusal fallbacks on Claude: yes (server-side "default", no UI; step 1.19).
2. Drawings: no stored page images; crops rendered on demand from the PDF (replaces F1's stored 6000 px PNGs; confirmed by the 1.5.0 spike). Sync still extracts text, classifies, summarises and writes the index ahead of time.
3. Base image: leave distroless for alpine + poppler.
4. Vendoring anthropic-sdk-go/v2: approved in principle; version, licence, min Go and transitive modules reported before vendoring (1.15).
5. /think on Claude: effort low by default, high with /think; 'Think only when asked' on by default; low must pass the 1.18 eval or becomes medium.
6. Telegram PDF upload: not in 1.5; the S3 console stays.
7. Prompt-cache TTL: 5 minutes for now; revisit with 1.18's usage logs (1 hour pays off only for messages 5–60 minutes apart).
- Tool rename: `ask_drawings` → `search_documents`, `read_document_page`, `view_document_page`.
- 1.15: vendoring `github.com/anthropics/anthropic-sdk-go/v2` approved by ZY at **v2.3.0** (23 Oct 2026; Apache-2.0; Go ≥ 1.25; 17 small indirect modules, no Bedrock/AWS deps; vendor/ +~10 MB). Pinned to a release ≥ 2 weeks old; v2.9.0 (10 Nov) was the newest.

## Overnight run of Phase 1.5 (ZY, 2026-11-11)
- Run 1.5.3 → 1.5.13 without further approval.
- Sync notifications: the **first import is silent**; later syncs tell the group only when something changed.
- Model calls on the saved Anthropic key are fine (document summaries, document eval cases; est. < $1); document text and drawing crops go to Claude.
- Sync writes only `docs/text/**` and `docs/index.json`; never deletes or changes `docs/raw/`; no new IAM permission.
- After the last step: run the strict review and **report** its findings for ZY to approve; don't fix them unasked.

## Review outcome (2026-11-12)
- Fixed: the blocker, all majors, all minors, the cache-mark guard, the memory and poppler-lock suggestions, and the re-review's N1–N5 + Q1. Left as they are: the N6 nits and the remaining lint extras.
- The env key without `LLM_BASE_URL` stays unbound (predates v2; ZY sees no issue).
- ~~`docs/raw/` protected by an IAM Deny for the app user~~: dropped, see below.

## No fine-grained IAM (2026-11-12)
- ZY: home-use app, no fine-grained IAM. `deploy/iam-policy.json` deleted; docs now just say the app's AWS key needs read/write/list/delete on the bucket. `docs/raw/` is protected only by the app's code (sync never writes or deletes there).

## Milestones + morning check-in (2026-11-12)
ZY accepted the planner's recommendations (plan.md 'Milestones + morning check-in'):
1. Milestones are a flag + done-date on entries (no new kind, no separate list).
2. Every entry gets a done-date when it moves to done; milestones are the flagged subset.
3. Done never makes a milestone by itself; the check-in has a separate Done ★ button.
4. Web page: Milestones timeline under the calendar; Milestone checkbox and 'Done on' in the dialog.
5. The check-in goes to the shared group by default (`CHECKIN_CHAT` can point it elsewhere).
6. One summary + one message per task to answer (max 8); buttons and typed replies both work.
7. Listed: today's undone dated items; undone tasks since the last check-in (asked about); older overdue as text; undated items not listed.
9. Reschedule buttons Tomorrow and +1 week from the day pressed; other dates by typing.
10. Mac-only for now: catch up when the app starts, until 20:00, else skip the day.
11. `CHECKIN_SCHEDULE` env (default 09:30, or off); status read-only on the Telegram tab.
12. Run the two milestone eval cases on Claude (a few cents).
- 8 (quiet days: no message, the day recorded as quiet) — recommendation explained to ZY; open until C.3, default as recommended.
- M.1–M.4 may proceed; the C.5 live send in the real chat needs ZY's go-ahead.

## After milestones + check-in (ZY, 2026-11-12)
- Milestones and the morning check-in accepted after trying both. CI after the push (QEMU + poppler-test) passed: done until it fails.
- Pending on ZY: review the admin guide (step 1.12).
- Backlog (not now): scanned documents (vision/OCR), Phase 2 (photos and voice notes), NKP deployment (waits for the cluster).
- Do now: move the group rule out of the cached rules section; check-in time and chat editable on the Telegram tab; the older review nits + lint extras; the two edge cases (no size cap on a viewed PDF; a check-in press racing a web edit).
- **Bucket versioning: turn it on** (reverses 'versioning stays off'). ZY flips it in the console; docs updated.
- 2026-11-12: ZY turned bucket versioning on in the S3 console, with a lifecycle rule deleting noncurrent versions after 90 days ("Recover older data" in the guide now applies).

## NKP cluster (2026-11-15)
- Cluster: `zy-all-in-one` (kubeconfig `ops/kubeconfigs/zy-all-in-one.conf`, k8s v1.36.2). Has Flux (kommander-flux, OCIRepository CRD), cert-manager (issuers: kommander-ca, selfsigned-issuer), ingress class `kommander-traefik` (default).
- The app runs in an NKP project namespace that ZY creates; manifests carry no namespace (D.2 stands).
- Ingress: `kommander-traefik`, nginx annotations dropped (Traefik doesn't buffer; SSE heartbeat every 25 s).
- Cutover: local and k8s share the bucket and bot token, so stop the local app (`make dev`) before the pod starts. Downtime is fine.
- ZY fills the prod overlay (hostname later); the release tag and D.1–D.4 (planner) come after ZY sorts out the prerequisites.
- **Superseded the same day:** no Ingress. A `cloudflared` Deployment in the project (deploy/tunnel/, image pinned) runs the dashboard-managed tunnel `zy-all-in-one-tunnel` (843cdce6-3498-4a3a-81a7-d1e61290b753) with its token (Secret `cloudflared-token`). The public hostname route (→ `movin.<namespace>.svc:80`) lives in the Cloudflare dashboard, not git (ZY chose this over recreating the tunnel as locally managed). Cloudflare's edge certificate is the only TLS; no cert-manager.
- `SETTINGS_SECRET` is the same in prod and `.env` (one `settings.json`).

## NKP deployment plan (2026-11-15; planner, ZY approved)
- **Repo and deploy artifact go public** (ZY: nothing sensitive inside; history scanned 2026-11-15: no secrets, only fake test tokens and a synthetic test PDF). Supersedes "the deploy artifact stays private": no `ghcr-pull` Secret, no secretRef on the OCIRepository, and the NKP GitOps source needs no credential. Public: the allowed email, Telegram IDs/group, bucket name, host.
- Deploy artifact = one rendered file (`movin.yaml`, image pinned by digest), Flux path `./` (not ./overlays/prod).
- No cosign for now.
- `targetNamespace: movin-tracker` and `serviceAccountName: movin-tracker` only in `deploy/flux/`; app manifests carry no namespace.
- OCIRepository carries `nkp.nutanix.com/skip-oci-registry-patches: "true"` so NKP's mirror patch doesn't rewrite it.
- New CI actions/tools pinned exactly; pinning the existing actions is a separate later commit.
- Rehearse with `v1.0.0-rc.1` (Flux's `>=1.0.0` ignores prereleases), wire the NKP GitOps source before the first real tag.
- Keep `deploy/render.sh` (the local test of the CI render).
