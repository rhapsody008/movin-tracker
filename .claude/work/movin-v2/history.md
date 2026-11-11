# movin-tracker v2: session history

One entry per working session: what was done, what is next, blockers. Newest first.

## 2026-11-11 — kickoff
- Done: discussion of the reorg; sample drawing inspected (`1.1 Type C5 Unit Layout Plan.pdf`: vector PDF with a real text layer, ~200 text runs, no dimensions, no electrical/plumbing); planner produced the plan; ZY answered flags F1–F6 and the open questions (see decisions.md); baseline committed (155d264) with lint + tests green; this folder created.
- Planner delta merged into plan.md (management plane, Telegram group auth + per-chat workers, time kept). Step 1.1 done.
- ZY answered the delta questions (see decisions.md). Steps 1.2, 1.3, 1.4 done, all tests green.
- Committed 1.1–1.4 as e7b3fa1. Deployment decision (OCI artifact + NKP/Flux bridge) recorded; planner + cluster check wait until ZY's NKP cluster is up.
- Local LLM: vMLX on 127.0.0.1:8081 (another project's container `secure-intake-app-standby-1` also publishes 8081 on all interfaces, so `localhost` from the Mac can hit the wrong one; from Docker use `host.docker.internal:8081`). Step 1.5 done: 10/10.
- Next: 1.6 server + main switch, then 1.6a storage admin.
- Blocked: 1.5.0 converter spike waits for a dense electrical/plumbing sheet from ZY.
