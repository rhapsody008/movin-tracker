# movin-tracker

A renovation assistant for two people fitting out a new condo. You tell it things in a Telegram group ("Lim quoted 18k for carpentry, paid 30% today", "thinking of fluted glass for the dry kitchen door") and it keeps a structured record: ideas, decisions, tasks, notes and open questions, each with room, category, status, cost, vendor and date. Ask it later ("what did we decide for the kitchen and what did it cost?") and it answers from that record. Every change comes back with an Undo button.

The web page is for seeing everything: a kanban board by status, a calendar, the move-in countdown and cost totals, a secondary chat, and a Settings panel to run the app (storage, LLM endpoint, Telegram allowlist).

It runs as one stateless Go container behind an auth proxy, keeps all state in one S3 bucket, and talks to any OpenAI-compatible LLM endpoint that supports tool calling.

**Operating it** (setup, secrets, deploy, adding people, troubleshooting): see the [admin guide](docs/admin-guide.md). The same guide is on the web page under **Admin guide** (`/guide.html`).

## Quick start (local)

You need Docker and make.

```sh
make dev     # app + MinIO with live reload at http://localhost:8080
make seed    # load fixtures/entries.sample.json
make test    # unit + API tests against MinIO, stubbed LLM and fake Telegram
make help    # every target
```

`make dev` creates `.env` from [.env.example](.env.example) on first run, with a fresh `SETTINGS_SECRET`. For the chat, set the LLM endpoint on the web page (Settings → LLM) or in `.env`; a model on this Mac is reachable from Docker at `http://host.docker.internal:<port>/v1`. For the bot, put a token from @BotFather in `TELEGRAM_BOT_TOKEN` and your Telegram user ID in `TELEGRAM_ALLOWED_IDS` (or add yourself later from Settings → Telegram → Recently refused).

If port 8080, 9000 or 9001 is taken, set `APP_PORT=8088` (and likewise `MINIO_PORT` / `MINIO_CONSOLE_PORT`) on the make command.

| Target | Does |
| --- | --- |
| `make dev` | Compose up app + MinIO with live reload |
| `make down` | Stop the stack |
| `make seed` | Load `fixtures/entries.sample.json` into MinIO |
| `make test` | Unit + API tests in the container, against MinIO (race detector on) |
| `make conflict-test` | Two writers on one ETag; both changes must survive |
| `make chat-eval` | Run the agent eval messages against the real endpoint in `.env`; prints the entry diff and PASS/FAIL per message |
| `make lint` | gofmt + go vet |
| `make build` | Build the production image (`movin:local`, distroless, non-root) |
| `make run` | Run the production image against MinIO with a read-only root filesystem, as in k8s |
| `make clean` | Remove containers, volumes and the MinIO bucket |

## How it works

- **Entries.** Everything is in `s3://$S3_BUCKET/$S3_PREFIX/entries.json`: the entries, the move-in and key dates, and a journal of the last 200 changes (the undo history). Every write reads, changes, then writes with `PutObject If-Match: <etag>`; a `412` means someone else wrote first, so the app re-reads, re-applies and retries up to 3 times before answering `409`. Reads come from memory; a `HEAD` every 5 s picks up writes made elsewhere. Undo restores an entry only if nobody changed it since.
- **Agent.** One tool-calling loop serves both the web chat and Telegram. Tools: `add_entry`, `update_entry`, `search_entries` (structured filters plus keywords; no vector search), `set_dates`, `undo_change`. The server, not the model, builds the confirmation lines, so every change is reported and carries its undo handle.
- **Telegram.** The bot long-polls from inside the app (outbound only, no webhook, no extra ingress), which is why the Deployment must stay at one replica. Private chats need an allowed person; groups need an allowed group and an allowed person. Each chat has its own queue, so two people typing at once never race; the group history is shared and labelled by speaker, and ordinary chatter gets no reply.
- **Web page.** `GET /api/events` is a server-sent events stream that pushes the document after every change, including the bot's. The page applies its own edits immediately and then takes the server's copy.
- **Settings.** `settings.json` next to the entries holds the LLM connection (the key Fernet-encrypted with `SETTINGS_SECRET`; the API only says whether one is set and its last 4 characters) and the Telegram allowlist. Each section is saved on its own, so saving one never touches another. Env vars are the defaults; the web page overrides them. Storage settings are read-only on the page: they come from env and Secrets.
- **Auth.** In front of the app, not inside it: oauth2-proxy (GitHub sign-in) sets `X-Forwarded-Email`, and the app checks it against `ALLOWED_EMAILS`. In k8s the app listens on `127.0.0.1`, so only its oauth2-proxy sidecar can reach it. For local dev, `DEV_EMAIL` stands in for the proxy.

Code map: [cmd/movin](cmd/movin) (server, `healthcheck`, `init-bucket`, `seed`), [cmd/chateval](cmd/chateval) (agent eval against a real model), [internal/entries](internal/entries) (model, rules, search, journal, ETag write path), [internal/agent](internal/agent) (tool loop, prompt, change lines), [internal/telegram](internal/telegram) (Bot API client and bot), [internal/llm](internal/llm), [internal/settings](internal/settings), [internal/objstore](internal/objstore), [internal/server](internal/server) (HTTP and admin API), [static/index.html](static/index.html) and [static/guide.html](static/guide.html) (frontend, no build step; the guide page renders the embedded [docs/admin-guide.md](docs/admin-guide.md)).

Plan, progress and decisions for the current work: [.claude/work/movin-v2](.claude/work/movin-v2).

## Deployment, in short

Single-replica Deployment (`Recreate`, no PVC) with the app and an oauth2-proxy sidecar; read-only root filesystem, 16 Mi `/tmp`. Manifests are in [deploy/k8s](deploy/k8s); the Secrets to create by hand are described in [deploy/k8s/base/secrets.example.yaml](deploy/k8s/base/secrets.example.yaml); the S3 permissions are in [deploy/iam-policy.json](deploy/iam-policy.json). The target is an NKP project with Flux pulling a versioned OCI artifact that CI publishes on each `v*` tag (planned; CI never commits to the repo). The admin guide has the step-by-step.

## Notes

- **Go modules are vendored**, so building and testing need no network beyond Docker Hub (the one exception is installing `air` for `make dev`).
- **MinIO image.** Upstream `minio/minio` images are no longer published, so compose uses the community build `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`. It honours `If-Match` and `If-None-Match` on PUT, which `TestConditionalWrites` checks on every `make test`.
- **Max tool rounds** counts rounds that may call tools; if the model is still calling tools after that, one more round is forced to answer in words. The default of 5 means at most 6 LLM calls.
- **Public paths.** The manifest and home-screen icons are served without sign-in, because iOS fetches them without the cookie.
