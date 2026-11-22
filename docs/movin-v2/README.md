# movin-tracker v2: start here

The tracking folder for the v2 work. Read this page first, then the files it points to.

## Where things stand (2026-11-12)
Everything planned so far is **built, reviewed, accepted by ZY and pushed** (main at `2c43940`, plus tracking commits after it).

| Part | Status |
|---|---|
| Phase 1: entries, agent, web page + Settings (Storage, LLM, Telegram, Documents), Telegram bot, admin guide | done |
| Connections: provider seam, Claude native (prompt caching, effort low / `/think` high, refusal fallbacks), OpenAI-compatible | done |
| Phase 1.5: documents under `docs/raw/` (text search, drawings read through on-demand views, nightly sync, summaries) | done |
| Milestones (flag + done day on entries, timeline on the page) and the morning check-in (09:30 Telegram, buttons, catch-up) | done, accepted |
| Follow-ups: group chats share the prompt cache; check-in time/chat on the Telegram tab; PDF cap 32 MiB; atomic check-in presses (`UpdateIf`); lint/complexity clean-up | done |
| Bucket versioning (+ 90-day noncurrent rule) | on (ZY, console) |
| NKP deployment D.1–D.4 (Cloudflare Tunnel, deploy/flux, CI deploy artifact) | live: v1.0.0 on zy-all-in-one since 2026-11-15, https://movin.yolocal.cloud |

**Open on ZY:** review the admin guide (`docs/admin-guide.md`, step 1.12).

**Backlog (pick one, then run the planner):**
1. **Phase 2: photos and voice notes** (plan.md "Phase 2").
2. **Scanned documents**: 9 picture-only PDFs (plan.md "Later phase: scanned documents").
3. ~~NKP deployment~~: built; first release runbook in docs/admin-guide.md.

## Files here
| File | What |
|---|---|
| `plan.md` | Design and steps of every phase, newest sections near the end; the backlog with a Phase 2 brief |
| `progress.md` | Each step with its verification evidence (commands, results, commits) |
| `decisions.md` | What ZY decided and why. Don't reopen these without asking; superseded lines are marked |
| `history.md` | One entry per session, newest first |
| `review-*.md` | The strict reviews and how each finding was handled |
| `tools/ui-check/` | The page check (headless Chrome) and its fake LLM; `run.sh` |

## How work is done here
- **Planning:** non-trivial work goes to the `planner` agent first, with the goal and evidence; ZY sees and answers the plan before code starts (workspace CLAUDE.md).
- **Steps:** one plan step at a time; `make lint && make test` after each; evidence into `progress.md`; **commit per step on main, never push** (ZY pushes).
- **Tests prove something:** for each fix, a test that fails without it (a quick mutation check: revert the line, see the test fail, restore).
- **Review:** one `strict-reviewer` pass when a phase's code is complete, then re-reviews until it approves. It reports; ZY decides what to fix.
- **Lint beyond `make lint`:** `golangci-lint run` (installed locally, config in `.golangci.yml`) should stay at 0 issues.

## Environment notes
- **One bucket** (`movintrackerbackend`, ap-southeast-1, no prefix) serves the dev app and, later, production. MinIO is only for `make test` and the UI check.
- **The dev app is live:** `make dev` runs on ZY's Mac with hot reload (air), the real bucket and ZY's real bot token. Every code edit is picked up within seconds, so a half-finished change runs against real data and the real Telegram group. Turn a risky feature off in `.env` before wiring it in (as with `CHECKIN_SCHEDULE=off` during the check-in work); `.env` changes need `docker compose up -d app`.
- **Settings in the bucket** (`settings.json`): the LLM connection (Claude native, Opus 5.5, vision on), the Telegram allowlist, and the check-in setting override `.env`.
- **Never run an older build against the bucket:** it would drop `milestone`/`completed` from every entry when it saves.
- **UI check:** `docs/movin-v2/tools/ui-check/run.sh` from the repo root (throwaway app on :8090 over MinIO, bot off, fake LLM on :18090; screenshots in `tmp/ui-check/`). Look at the screenshots, not just the PASS count. 87 checks today.
- **Evals (billed to the saved key, cents):** `make chat-eval-claude MODEL=claude-sonnet-5-5` (12 cases on an in-memory copy of the sample entries); `make chat-eval-docs` (adds 5 questions about the real documents, read only). Sonnet is enough to prove a point; use Opus only when needed (ZY).
- **Safety:** never print the Telegram token or read AWS credentials; ZY creates secrets and runs any `kubectl apply` or IAM change; never commit unit drawings or secrets (`/unitmaterial/`, `.env` are git-ignored); sync never writes or deletes under `docs/raw/`.
