# movin-tracker v3: start here

The tracking folder for the v3 work: a TypeScript rewrite of the app on the pi-durable agent harness. Read this page first, then the files it points to. v2 history stays in `docs/movin-v2/`.

## Where things stand (2026-11-22)
**v2.0.1 is live on prod** (TypeScript, pi-durable, SQLite on PVC `movin-data`); Go is deleted and the app is the repo root. The volume is backed up daily by Velero, and a restore drill passed. Open work is tracked as GitHub issues (final review, UI, demo write-up, feature ideas, NKP test plan).

| Part | Status |
|---|---|
| T0 spikes | done 2026-11-20 |
| T1–T5 build (domain, web, agent, Telegram, scheduled work) | done, each phase approved by `ts-reviewer` |
| T6 cutover | `v2.0.0` live 2026-11-22; Velero Schedule plus drill done (T6.7) |
| T7 delete Go, move `app/` to the root | done; `v2.0.1` live 2026-11-22 |
| Final strict review of all code | open (GitHub issue) |

## Layout
Since T7.2 the app is the repo root, not `app/`: `src/`, `static/`, `eval/`, `test/`, `tools/`, `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `Dockerfile` and the root `.dockerignore` (the image's allowlist). The goldens stay next to their tests as `src/**/testdata`, frozen (Go v1, tag `v1.0.1`). `fixtures/`, `reference/`, `unitmaterial/` and `tmp/` stay where they were; the root `Makefile` runs everything in Docker.

## Files here
| File | What |
|---|---|
| `plan.md` | Design and steps |
| `progress.md` | Each step with its verification evidence; facts gathered before T0 |
| `decisions.md` | What ZY decided and why. Don't reopen these without asking |
| `history.md` | Per-session log |
| `velero.md` | Backup and restore of the chat-history volume (Schedule applied and restore drill done on 2026-11-22, T6.7) |

## How work is done here
- **Planning:** non-trivial work goes to the `planner` agent first; ZY sees the plan before code starts.
- **Who writes code:** the `coder` agent (zy-pi-uep, decided by ZY 2026-11-20) implements one step from the main session's brief (files, approach, verification, allowed paths and deps). The main session checks the actual diff and reruns the checks before ticking the step.
- **Steps:** one plan step at a time; `make lint test` after each (one app, one Makefile, in Docker); evidence into `progress.md`; commit per step on main only when ZY asks, never push (ZY pushes).
- **Tests prove something:** for each fix, a test that fails without it (revert the line, see it fail, restore).
- **Review (from 2026-11-20, ZY):** the main session verifies every step (reruns lint/test, reads the diff, runs targeted mutations on compatibility-critical code). `ts-reviewer` (Opus, read-only, stricter mode for `coder` output: brief item by item, coder's checks rerun, dependency calls against `.d.ts`, ported code against the Go source, the code line each test protects) reviews once per phase over the whole phase, plus separate reviews for T3.2 and T3.3. A phase is ticked only on **APPROVE**; fixes go back to `coder`, then a re-review. T1.1 and T1.2 were reviewed per step.
- **Go is gone** (T7.1). v1 is tag `v1.0.1`; a hotfix would need a `release/1.0` branch cut from it.

## Environment notes
- **One bucket** (`movintrackerbackend`) serves dev and prod; `make dev` uses it with the prod bot token, so it competes with the prod bot while running.
- **LLM:** the saved connection is the NAI gateway (`https://nai.yolocal.cloud/enterpriseai/gateway/v1`, model `movin-backend`), OpenAI-compatible. Claude native is being removed.
- **Harness state** (SQLite) lives on PVC `movin-data` at `/data` in prod, and in a local directory in dev; never shared between dev and prod.
- **Velero** runs on zy-all-in-one (namespace `zy-all-in-one-workspace`) with `EnableCSI`; Schedule `movin-data-daily` (02:30, 7 days) backs up the volume; drill passed 2026-11-22 (see `velero.md`).
- **Safety:** never print the Telegram token, API keys or AWS credentials; ZY creates secrets and runs any `kubectl apply`; never commit `/unitmaterial/` or `.env`.
