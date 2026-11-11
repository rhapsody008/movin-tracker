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
- Agent tools: add_entry, update_entry, search_entries, set_dates, undo_change, ask_drawings (1.5). Archiving via update_entry; hard delete is web-only (F2).

## Telegram
- Long polling inside the app process; outbound only; single replica required (one poller per token).
- A **dedicated shared group** (ZY, spouse, bot), privacy mode off; every group message is input. Private chats with allowlisted users also allowed. Authorise on both group ID and sender ID.
- `by` names come from config (`id=name`).
- Sync notifications go to the group only when a sync changed something.

## Drawings (phase 1.5)
- Do not vectorize drawings. Raw PDF in S3 is the source of truth; renders are a disposable, versioned cache.
- Server-side conversion: PDF → high-res PNG + overview PNG + text layer with positions, all stored in S3. The LLM consumes PNGs (overview + crops) plus the text layer.
- Render cap ~6000 px long edge; one render/crop at a time (F1).
- Sync triggers: Telegram upload, startup, daily 03:00 SGT (in-process), `/sync`, and the web "Sync now" button. Manifest-based; deleted PDFs mark the sheet "removed".
- Converter: PDFium WASM in-process preferred, poppler sidecar fallback; decided by the 1.5.0 spike on a dense electrical/plumbing sheet (ZY to supply).

## Management plane
- Storage section is **read-only** (bucket, region, prefix, credential source, test connection). Credentials and bucket stay in env/Secret, because settings.json itself lives in S3 and the pod is stateless.
- LLM editable (as today). Telegram: status + editable allowlist (users, groups) in settings.json; token stays in the Secret. Drawings: sheet list + Sync now.

## Deployment and safety
- No egress restrictions assumed.
- IAM DeleteObject only on `<prefix>/docs/pages/*` and `<prefix>/docs/text/*` (F5).
- ZY creates secrets and runs any kubectl apply / IAM change.
- Real unit drawings never go into git (`/unitmaterial/` is ignored).

## Housekeeping
- Baseline committed on main: 155d264 (2026-11-11).
- Delete `build-plan.md` in step 1.11; keep `reference/condo-board.html` for now.
- Track work in `.claude/work/movin-v2/` (committed).

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
- Web sign-in: **GitHub OAuth App** via oauth2-proxy (`provider = "github"`, `scope = "user:email"`, email allowlist kept). Telegram does not use OAuth.
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
- IAM policy covers the bucket root (`<bucket>/*`, delete on `_probe/*`); kustomize `S3_PREFIX=` empty. Documents go to `docs/raw/` (and the 1.5 caches to `docs/pages/`, `docs/text/`, no prefix).
- Latency: thinking stays on for now; prompt caching on the model server is ZY's, later.

## LLM settings kept minimal (2026-11-11)
- ZY: no temperature, max tokens, timeout or tool-round settings; leave them to the model. The page has endpoint, key, model, streaming and 'Think only when asked'. Test connection comes before picking a model.
