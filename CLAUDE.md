# movin-tracker

Go service: a renovation agent (Telegram bot + web management page) over structured entries stored in S3.

## Current work: v2 reorg
Before doing anything on the v2 reorg, read `.claude/work/movin-v2/`:
- `plan.md`: the approved plan (steps per phase)
- `progress.md`: which steps are done, with verification evidence
- `decisions.md`: what ZY decided and why; don't re-open these without asking
- `history.md`: per-session log; add an entry at the end of each session

Work one plan step at a time. Run `make lint && make test` after each step and record the result in `progress.md`.

## Rules
- Tests and lint run in Docker (`make test`, `make lint`); modules are vendored, so new dependencies need `go mod tidy && go mod vendor`.
- Never commit real unit drawings or secrets. `/unitmaterial/` and `.env` are git-ignored.
- ZY creates secrets and runs any `kubectl apply` or IAM change.
