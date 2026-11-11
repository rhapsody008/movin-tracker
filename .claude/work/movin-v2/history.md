# movin-tracker v2: session history

One entry per working session: what was done, what is next, blockers. Newest first.

## 2026-11-11 — kickoff
- Done: discussion of the reorg; sample drawing inspected (`1.1 Type C5 Unit Layout Plan.pdf`: vector PDF with a real text layer, ~200 text runs, no dimensions, no electrical/plumbing); planner produced the plan; ZY answered flags F1–F6 and the open questions (see decisions.md); baseline committed (155d264) with lint + tests green; this folder created.
- Planner delta merged into plan.md (management plane, Telegram group auth + per-chat workers, time kept). Step 1.1 done.
- ZY answered the delta questions (see decisions.md). Steps 1.2, 1.3, 1.4 done, all tests green.
- Next: 1.5 chateval port — needs ZY's LLM endpoint in `.env` (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`) to run `make chat-eval`. Code can be written without it; only the eval run waits.
- Blocked: 1.5.0 converter spike waits for a dense electrical/plumbing sheet from ZY.
