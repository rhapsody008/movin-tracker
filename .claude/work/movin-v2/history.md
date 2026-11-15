# movin-tracker v2: session history

One entry per working session: what was done, what is next, blockers. Newest first.

## 2026-11-15 — NKP deployment built
- Cluster `zy-all-in-one` ready; project `movin-tracker` created by ZY. Sanity check: CI green, image pushed; ZY made the image public. Ingress replaced by a cloudflared Deployment (dashboard tunnel `zy-all-in-one-tunnel`, token Secret, route in the dashboard to `movin.movin-tracker.svc:80`); real bucket name.
- Planner on D.1–D.4 with cluster evidence (NKP rewrites OCIRepositories unless annotated skip; Kustomizations forced to SA movin-tracker). ZY approved; repo and deploy artifact go public (history scanned clean).
- Built and committed D.2 (overlay without namespace), D.3 (`deploy/flux/`), D.1 (`deploy/render.sh` + CI `deploy-artifact` job), D.4 (guide + README).
- Not yet verified on the real pipeline/cluster: first tag run, Flux pull through the cluster's proxy, NKP leaving the annotated OCIRepository alone.
- Then: repo public, secrets checked (names/sizes), host movin.yolocal.cloud, rehearsal `v1.0.0-rc.1` green (artifact public), NKP GitOps source added (NKP left the OCIRepository alone), local app stopped, **`v1.0.0` released and running** on zy-all-in-one (Flux applied 1.0.0; bot started, no 409; tunnel up; https://movin.yolocal.cloud redirects to GitHub sign-in).
- Next: ZY checks sign-in, Storage test and Telegram in the browser; optional strict review of the deploy changes. From now on don't run `make dev` against the bucket without stopping production first.

## 2026-11-12 (end) — phase close
- ZY pushed (…2c43940) and turned bucket versioning on (+ 90-day noncurrent rule). All planned work done; open: admin guide review. Next session: backlog when ZY picks it (scanned documents, Phase 2, NKP).
- Final tidy-up of this folder: `README.md` (start here: status, files, how work is done, environment notes), status notes at the top of plan.md and progress.md, superseded decisions marked, a Phase 2 brief for the planner in plan.md, the UI check kept in `tools/ui-check/` with `run.sh` (87/87 from there).

## 2026-11-12 (later) — after acceptance
- ZY accepted milestones + check-in; check-in live in the dev app (first sent 12:23); page order milestones → calendar → board; 'Jump to calendar' removed; ZY pushed (…f13a50c).
- Backlog: scanned documents, Phase 2 media, NKP deployment. Pending on ZY: admin guide review; turning bucket versioning on in the console (+ 90-day noncurrent lifecycle rule).
- Done: group line out of the cached rules (group messages now hit the cache); check-in time/chat editable on the Telegram tab (settings.json `checkin`, env as default); PDF size cap 32 MiB; atomic check-in presses (`UpdateIf`); lint/tidy-ups incl. all production functions under gocognit 30 and `.golangci.yml` (0 issues). Eval 12/12 twice.
- Strict review of the later changes → fixes → re-review → fixes → third review APPROVE WITH NITS → nits fixed. Next: ZY pushes; ZY turns on bucket versioning; admin guide review.

## 2026-11-12 — milestones + morning check-in
- Planner on the backlog (NKP not ready): plan merged into plan.md; ZY accepted all recommendations (decisions.md), quiet days explained (default: no message).
- Built and committed M.1–M.4 (milestone flag + done day on entries, agent tools/prompt, web dialog + timeline, guide + eval 12/12 on Sonnet 5.5) and C.1–C.5 (agenda, checkin.json claim protocol + CHECKIN_SCHEDULE/CHECKIN_CHAT, messages + buttons + /checkin, once-a-minute loop with catch-up until 20:00, Telegram-tab status + guide). UI check 79/79 on the throwaway app.
- Dev app: `.env` has `CHECKIN_SCHEDULE=off` (container recreated before the loop was wired) so the hot-reloading dev bot sends nothing until ZY approves the live check.
- Strict review of da0320d..HEAD started (report only).
- Next: ZY's go-ahead for the live check (`/checkin` in the real group, then remove `CHECKIN_SCHEDULE=off` for a scheduled run); ZY reads the review; push.

## 2026-11-12 — review fixes
- ZY read the strict review (review-2026-11-12.md, REJECT) and chose fixes: the blocker and all majors (9af245e, eb1ef86, 65415b5, 9b58984), then the five minors + cache-mark guard (727ebe4), the docs/raw/ Deny in the IAM policy (5f5bc19, files only), and both memory/lock suggestions (25001c9; found the stdout cap had never applied).
- Re-review by the strict reviewer before pushing: APPROVE WITH NITS. N1–N5 and Q1 fixed (3b2d49f); N6 nits and the remaining lint extras left by choice.
- ZY pushed main (e103d33..3b2d49f).
- /doctor (Claude Code itself, not the repo): the 'auto-update failed' message was transient (already on the newest release); auto mode made the default permission mode in `~/.claude/settings.json` (backup `settings.json.bak-doctor`).
- Tracking files brought up to date: this entry, superseded lines marked in decisions.md, package table in plan.md.
- ZY dropped fine-grained IAM (home app): `deploy/iam-policy.json` deleted, docs say read/write/list/delete on the bucket.
- Open for ZY: check the first CI run with QEMU + poppler-test.
- Next: ZY picks between the backlog (milestones, 09:30 check-in; planner) and deployment (waits for the NKP cluster).

## 2026-11-11 — kickoff
- Done: discussion of the reorg; sample drawing inspected (`1.1 Type C5 Unit Layout Plan.pdf`: vector PDF with a real text layer, ~200 text runs, no dimensions, no electrical/plumbing); planner produced the plan; ZY answered flags F1–F6 and the open questions (see decisions.md); baseline committed (155d264) with lint + tests green; this folder created.
- Planner delta merged into plan.md (management plane, Telegram group auth + per-chat workers, time kept). Step 1.1 done.
- ZY answered the delta questions (see decisions.md). Steps 1.2, 1.3, 1.4 done, all tests green.
- Committed 1.1–1.4 as e7b3fa1. Deployment decision (OCI artifact + NKP/Flux bridge) recorded; planner + cluster check wait until ZY's NKP cluster is up.
- Local LLM: vMLX on 127.0.0.1:8081 (another project's container `secure-intake-app-standby-1` also publishes 8081 on all interfaces, so `localhost` from the Mac can hit the wrong one; from Docker use `host.docker.internal:8081`). Step 1.5 done: 10/10.
- Step 1.6 done. Local MinIO's settings.json (saved via the drawer earlier) points the app at `nai-uep-backend` behind a Cloudflare tunnel that is down; `.env`'s vMLX values only apply when no drawer settings are saved.
- Secrets plan + GitHub OAuth + public image decided (decisions.md). Step 1.6a done.
- Step 1.7 done. UI check script lives in git-ignored `tmp/ui-check/check.mjs` (headless Chrome over CDP against `make dev` on :8080, DEV_EMAIL auth); rerun it after frontend changes.
- Step 1.7a done.
- Step 1.8 done.
- Step 1.8a done.
- Step 1.9 done (automated). Manual check waits for ZY: BotFather /newbot, /setprivacy → Disable, TELEGRAM_BOT_TOKEN in .env, own Telegram user ID in TELEGRAM_ALLOWED_IDS (find it from the 'telegram message ignored' log line, or the rejected list once 1.9a lands).
- Step 1.9a done. Admin guide recorded as step 1.12 (ZY: 'I need an admin operation guide at the end of the day').
- Step 1.10 done (files only; nothing applied).
- ZY stopped the mid-build review: reviews wait until all code is complete (decisions.md). Step 1.11 done with ZY's OK.
- Step 1.12 done: admin guide in repo + on the web page (/guide.html). Phase 1 coding complete; manual Telegram check still waits for ZY's bot token.
- Strict review of all Phase 1 code (verdict REJECT: key exfiltration via ?baseUrl=, dialog overwriting concurrent edits, plus majors); ZY approved fixing all but deleting the Telegram download code; fixed and verified (progress.md 'Review fixes').
- ZY widened 1.5 from drawings to all documents (contracts, developer and management-office material); discussion only so far, questions pending (volume/scans, upload path, which model reads contracts, task suggestions, embeddings, samples).
- Moved to the real AWS bucket (decisions.md 'One bucket for everything'): one bucket, no prefix, shared by dev and production; MinIO for tests only (76ea439). Copied entries.json (13 entries, 4 of them old samples) + settings.json from local MinIO with If-None-Match; dev app restarted on the bucket: storage test 6/6, 13 entries, bot running. Documents go to `s3://<bucket>/docs/raw/`. Thinking stays on; prompt caching on the model server is ZY's, later.
- Option A built: Settings → LLM 'Think only when asked' (thinkOnDemand, env LLM_THINK_ON_DEMAND); when on, requests carry chat_template_kwargs enable_thinking=false unless the message starts with /think (Telegram command + web chat). Turned on for ZY's vMLX endpoint. vMLX check: off 3.2 s / 41 tokens (wrong sum), on 16.7 s / 288 tokens (right). Friendlier timeout errors not done.
- LLM tab simplified (ZY): temperature, max tokens, timeout and tool rounds removed from the page, settings.json and env. Temperature/max_tokens are no longer sent (vMLX has no small default: 2692 tokens unprompted); timeout 600 s per call and 5 tool rounds are fixed in code; Telegram turn timeout 3 → 15 min. New order: URL + key → Test connection (lists models) → pick model → Save (runs the tool-calling check first; 'Save even though…' after a failure). UI check now runs only against a throwaway app on MinIO (BASE :8090, bot off) because it edits entries and the Telegram allowlist: 52/52.
- Documents: ZY uploaded 43 PDFs + 1 video to `docs/raw/` (8 folders). Read-only analysis (poppler in a container): mostly text; 8 vector drawings render crisp; A1 full render (584 MB first quoted, corrected by 1.5.0 to 136 MB); scanned ones moved to a later phase (plan.md). Deleted 20 `._*` files; added 5 entries from the documents. Documentation audit: progress.md gained 'After Phase 1' (dev env, cache check, one bucket, /think, LLM tab, Anthropic, document intake); README and guide stale lines fixed. Bucket versioning found off. Checkpoint confirmed with ZY before engaging the planner for the widened Phase 1.5.
- Planner engaged for Claude native + documents; plan merged (cc00352). 1.13 provider seam (fb72922), 1.5.0 poppler spike (e103d33), 1.14 settings kind. A duplicate session briefly edited 1.14 in parallel; stopped, its edits discarded. Cleanup: MinIO stopped, stale containers and spike images removed. Repo made private and pushed by ZY. Next: 1.15 Claude provider — report the SDK's version/licence/deps to ZY before vendoring.
- Claude native connection done: 1.15 SDK provider (v2.3.0), 1.16 cache layout + stop reasons, 1.17 LLM tab kinds, 1.18 eval (Sonnet 5.5 10/10, 2.6 s/message, 80–90% cache reads; vMLX 10/10, 34 s/message), 1.19 refusal fallbacks (lookup needs the beta header, found live). Documents: 1.5.1 store listing, 1.5.2 index model. Next: 1.5.3 converter (poppler, alpine image).
- Overnight Phase 1.5 run (ZY's go-ahead; decisions.md 'Overnight run'): 1.5.3 poppler converter + alpine image, 1.5.4 sync engine, 1.5.5 BM25 search, 1.5.6 document tools + prompt section, 1.5.7 startup/daily/`/sync` + group notices, 1.5.8 Documents tab + live checkpoint, 1.5.9 summaries, 1.5.10–1.5.11 images + view_document_page, 1.5.12 document evals (15/15 on Opus 5.5), 1.5.13 deploy sizing (256 Mi, GOMEMLIMIT 128MiB). Live on the real bucket: 43 documents read silently (26 text, 8 drawings, 9 scanned after two fixes: a big no-text leaflet and a garbled-font manual now count as scanned, via quiet ConvertVersion refreshes); all 34 readable documents summarised; drawing questions answered from views. Found and fixed along the way: an import that failed before poppler would later have announced 43 documents; the fallback lookup needs the beta header; Region literals; several test expectations. Then the strict review of all code since c27d770 (report only, for ZY).
- Next (morning): ZY reads the review findings and decides on fixes; optionally re-save Settings → LLM; push; then the planner for the backlog (milestones, 09:30 check-in) or deployment.
