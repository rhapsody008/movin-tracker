# movin-tracker

TypeScript service (Node 24, no build step): a renovation agent (Telegram bot + web management page) over structured entries stored in S3, with the chat history on a small volume. The app is the repo root: `src/`, `static/`, `eval/`, `test/`. The Go v1 app that used to live here was deleted in T7.1; a comment citing `internal/…`, `cmd/…` or `*.go` means that code, tag `v1.0.1`.

## Current work: v3
Before doing anything, read `docs/movin-v3/`, starting with `README.md` (status, how work is done, environment notes):
- `plan.md`: the design and steps
- `briefs/`: the plan and one brief per step; the brief is the contract for that step
- `progress.md`: which steps are done, with verification evidence
- `decisions.md`: what ZY decided and why; don't re-open these without asking

Work one plan step at a time. Run `make lint test` after each step and record the result in `progress.md`.

## Rules
- Tests, lint and the app run in Docker: `make lint` (Biome + tsc) and `make test` (vitest, the S3 half against the compose MinIO). The only prerequisite is Docker.
- **No vendoring.** Dependencies are the pinned packages in `package-lock.json`, installed with `npm ci`; a new dependency needs a pinned install, and no new package without approval.
- **The goldens are frozen.** The `testdata/*.go.json` and `*.go.err` files are the Go v1 code's own bytes (tag `v1.0.1`); never hand-edit them, and new behaviour gets an ordinary TS test (`src/testdata/README.md`).
- Line cites in comments to `internal/`, `cmd/` or `*.go` refer to the Go v1 code, tag `v1.0.1`; the tree itself is gone.
- Never commit real unit drawings or secrets. `/unitmaterial/` and `.env` are git-ignored, and `.env` values are never printed.
- ZY creates secrets and runs any `kubectl apply` or IAM change.
