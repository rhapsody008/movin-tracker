# movin-tracker v2: session history

One entry per working session: what was done, what is next, blockers. Newest first.

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
- Next: 1.11 retire old code — needs ZY's explicit OK (deletes internal/board, internal/chat, cmd/import, fixtures/board.sample.json, build-plan.md); then 1.12 admin guide.
- Blocked: 1.5.0 converter spike waits for a dense electrical/plumbing sheet from ZY.
