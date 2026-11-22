# movin-tracker v3: start here

The tracking folder for the v3 work: a TypeScript rewrite of the app on the pi-durable agent harness. Read this page first, then the files it points to. v2 history stays in `docs/movin-v2/`.

## Where things stand (2026-11-20)
T0 done (gate passed); T1.1, T1.2 done. Next: T1.3 entries.

| Part | Status |
|---|---|
| T0 spikes (deps, crash/replay/memory, prompt layout) | done 2026-11-20 |
| T1–T5 build (domain, web, agent, Telegram, scheduled work) | T1.1, T1.2 done |
| T6 cutover to `v2.0.0` on zy-all-in-one | not started |
| T7 delete Go, move `app/` to the root | not started |

## Files here
| File | What |
|---|---|
| `plan.md` | Design and steps |
| `progress.md` | Each step with its verification evidence; facts gathered before T0 |
| `decisions.md` | What ZY decided and why. Don't reopen these without asking |
| `velero.md` | Backup and restore of the chat-history volume (written in T5.3b; the Schedule and the drill are T6.7, not applied yet) |

## How work is done here
- **Planning:** non-trivial work goes to the `planner` agent first; ZY sees the plan before code starts.
- **Who writes code:** the `coder` agent (zy-pi-uep, decided by ZY 2026-11-20) implements one step from the main session's brief (files, approach, verification, allowed paths and deps). The main session checks the actual diff and reruns the checks before ticking the step.
- **Steps:** one plan step at a time; Go `make lint && make test` and `make -C app lint test` after each; evidence into `progress.md`; commit per step on main only when ZY asks, never push (ZY pushes).
- **Tests prove something:** for each fix, a test that fails without it (revert the line, see it fail, restore).
- **Review (from 2026-11-20, ZY):** the main session verifies every step (reruns lint/test, reads the diff, runs targeted mutations on compatibility-critical code). `ts-reviewer` (Opus, read-only, stricter mode for `coder` output: brief item by item, coder's checks rerun, dependency calls against `.d.ts`, ported code against the Go source, the code line each test protects) reviews once per phase over the whole phase, plus separate reviews for T3.2 and T3.3. A phase is ticked only on **APPROVE**; fixes go back to `coder`, then a re-review. T1.1 and T1.2 were reviewed per step.
- **The Go code is frozen** until T7, so a `v1.0.x` hotfix stays possible.

## Environment notes
- **One bucket** (`movintrackerbackend`) serves dev and prod; the TS dev app runs beside the Go one on it during T2–T5. No new entry or settings fields until Go is gone.
- **LLM:** the saved connection is the NAI gateway (`https://nai.yolocal.cloud/enterpriseai/gateway/v1`, model `movin-backend`), OpenAI-compatible. Claude native is being removed.
- **Harness state** (SQLite) lives on PVC `movin-data` at `/data` in prod, and in a local directory in dev; never shared between dev and prod.
- **Velero** runs on zy-all-in-one (namespace `zy-all-in-one-workspace`) and the snapshot class is labelled (2026-11-22), but no movin Schedule exists and no drill has run, so the volume's data is not backed up yet (see `velero.md`).
- **Safety:** never print the Telegram token, API keys or AWS credentials; ZY creates secrets and runs any `kubectl apply`; never commit `/unitmaterial/` or `.env`.
