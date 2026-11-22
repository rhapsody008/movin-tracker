# movin-tracker

Go service: a renovation agent (Telegram bot + web management page) over structured entries stored in S3.

## Current work: v2 reorg
Before doing anything on the v2 reorg, read `docs/movin-v2/`, starting with `README.md` (status, backlog, how work is done, environment notes):
- `plan.md`: the approved plan (steps per phase)
- `progress.md`: which steps are done, with verification evidence
- `decisions.md`: what ZY decided and why; don't re-open these without asking
- `history.md`: per-session log; add an entry at the end of each session

Work one plan step at a time. Run `make lint && make test` after each step and record the result in `progress.md`.

## Rules
- Tests and lint run in Docker: `make lint` and `make test` at the root forward to `app/Makefile` (Biome, tsc, vitest). The app is TypeScript under `app/`; its dependencies are the pinned packages in `app/package-lock.json`, so a new dependency needs a pinned install, not a vendored copy.
- The Go v1 code is gone (deleted in T7.1). Line cites in comments such as `internal/…`, `cmd/…` or `*.go` refer to tag `v1.0.1`.
- Never commit real unit drawings or secrets. `/unitmaterial/` and `.env` are git-ignored.
- ZY creates secrets and runs any `kubectl apply` or IAM change.
