# movin-tracker

A renovation assistant for two people fitting out a new condo. You tell it things in a Telegram group ("Lim quoted 18k for carpentry, paid 30% today", "thinking of fluted glass for the dry kitchen door") and it keeps a structured record: ideas, decisions, tasks, notes and open questions, each with room, category, status, cost, vendor and date. Ask it later ("what did we decide for the kitchen and what did it cost?") and it answers from that record. Every change comes back with an Undo button.

The web page is for seeing everything: a kanban board by status, a calendar, the move-in countdown and cost totals, a secondary chat, and a Settings panel to run the app (storage, LLM endpoint, Telegram allowlist).

It runs as one stateless Node 24 container behind an auth proxy, keeps all state in one S3 bucket and the chat history on a small volume, and talks to any OpenAI-compatible LLM endpoint that supports tool calling.

**Operating it** (setup, secrets, deploy, adding people, troubleshooting): see the [admin guide](docs/admin-guide.md). The same guide is on the web page under **Admin guide** (`/guide.html`).

## Quick start (local)

You need Docker and make; everything else runs in containers (`node:24-alpine`, pinned digest).

```sh
make dev     # the app at http://127.0.0.1:8081, on the real bucket in .env
make lint    # Biome + tsc
make test    # unit + API tests against their own MinIO, stubbed LLM and fake Telegram
make help    # every target
```

`make dev` creates `.env` from [.env.example](.env.example) on first run, with a fresh `SETTINGS_SECRET`. Fill in the bucket and AWS keys: dev and production share one bucket (no prefix), so local edits are real. For the chat, set the LLM endpoint on the web page (Settings → LLM) or in `.env`; a model on this Mac is reachable from Docker at `http://host.docker.internal:<port>/v1`. For the bot, put a token from @BotFather in `TELEGRAM_BOT_TOKEN` and your Telegram user ID in `TELEGRAM_ALLOWED_IDS` (or add yourself later from Settings → Telegram → Recently refused).

If port 8081, 9000 or 9001 is taken, set `APP_TS_PORT=8088` (and likewise `MINIO_PORT` / `MINIO_CONSOLE_PORT`) on the make command.

There is no build step: the `.ts` files run directly on Node 24 (built-in type stripping, `.ts` import extensions), and `tsc` is a type-check only. Only `src/durable/adapter.ts` may import `@earendil-works/pi-durable` (enforced by Biome `noRestrictedImports`).

| Target | Does |
| --- | --- |
| `make dev` | Run the app on the bucket in `.env` (compose `app-ts`, 127.0.0.1:8081) |
| `make down` | Stop the stack |
| `make lint` | Biome check + tsc type-check |
| `make test` | Vitest: the S3 half against the compose MinIO; then the poppler tests on the production runtime |
| `make format` | Biome check `--write` |
| `make chat-eval` | Run the agent eval messages against the saved connection; prints the entry diff and PASS/FAIL per message |
| `make chat-eval-docs` | The same plus the document questions (billed; read only) |
| `make chat-eval-env` | The eval against the `LLM_*` in your environment instead |
| `make build` | Build the production image `movin-app:local` (the same target as `make image`) |
| `make image` | Build the production image `movin-app:local` |
| `make run` | Run the production image at http://127.0.0.1:8091 with a read-only root filesystem, as in k8s |
| `make ui-check` | Headless Chrome against the app on MinIO; screenshots in `tmp/ui-check-ts` |
| `make shell` | An interactive shell in the pinned Node image |
| `make clean` | Remove containers and volumes (the test MinIO's data; never the real bucket) |

## How it works

- **Entries.** Everything is in `s3://$S3_BUCKET/entries.json`: the entries, the move-in and key dates, and a journal of the last 200 changes (the undo history). Every write reads, changes, then writes with `PutObject If-Match: <etag>`; a `412` means someone else wrote first, so the app re-reads, re-applies and retries up to 3 times before answering `409`. Reads come from memory; a `HEAD` every 5 s picks up writes made elsewhere. Undo restores an entry only if nobody changed it since.
- **Agent.** One tool-calling loop serves both the web chat and Telegram. Tools: `add_entry`, `update_entry`, `search_entries` (structured filters plus keywords; no vector search), `set_dates`, `undo_change`. The server, not the model, builds the confirmation lines, so every change is reported and carries its undo handle.
- **Chat history.** The agent runs on the pi-durable harness, whose SQLite file lives in `DATA_DIR` (`/data` in k8s, the `movin-data` PVC): the conversation, the scheduled work and this deployment's S3 start counter. One replica only, and a restore is announced by `HARNESS_RESTORE_ID` (see the admin guide).
- **Telegram.** The bot long-polls from inside the app (outbound only, no webhook, no extra ingress), which is why the Deployment must stay at one replica. Private chats need an allowed person; groups need an allowed group and an allowed person. Each chat has its own queue, so two people typing at once never race; the group history is shared and labelled by speaker, and ordinary chatter gets no reply.
- **Documents.** PDFs in the bucket are converted with poppler (`pdfinfo`, `pdftotext`, `pdftocairo`), indexed for search and rendered for the documents tab; a nightly sync picks up new ones.
- **Web page.** `GET /api/events` is a server-sent events stream that pushes the document after every change, including the bot's. The page applies its own edits immediately and then takes the server's copy.
- **Settings.** `settings.json` next to the entries holds the LLM connection (the key Fernet-encrypted with `SETTINGS_SECRET`; the API only says whether one is set and its last 4 characters) and the Telegram allowlist. Each section is saved on its own, so saving one never touches another. Env vars are the defaults; the web page overrides them. Storage settings are read-only on the page: they come from env and Secrets.
- **Auth.** In front of the app, not inside it: oauth2-proxy (GitHub sign-in) sets `X-Forwarded-Email`, and the app checks it against `ALLOWED_EMAILS`. In k8s the app listens on `127.0.0.1`, so only its oauth2-proxy sidecar can reach it. For local dev, `DEV_EMAIL` stands in for the proxy.

Code map: [src/main.ts](src/main.ts) (entry point, `serve`, `healthcheck`), [src/server](src/server) (HTTP, SSE and admin API), [src/entries](src/entries) (model, rules, search, journal, ETag write path), [src/agent](src/agent) (tool loop, prompt, change lines), [src/telegram](src/telegram) (Bot API client and bot), [src/llm](src/llm), [src/settings](src/settings), [src/objstore](src/objstore), [src/docs](src/docs) (PDF conversion, index, render, nightly sync), [src/durable](src/durable) (the pi-durable adapter), [eval/chateval.ts](eval/chateval.ts) (agent eval against a real model), [static/index.html](static/index.html) and [static/guide.html](static/guide.html) (frontend, no build step; the guide page renders the [docs/admin-guide.md](docs/admin-guide.md)). The `testdata` next to the tests are Go v1 goldens, frozen: see [src/testdata/README.md](src/testdata/README.md).

The app is the repo root since T7.2 (it was `app/` before). Plan, progress and decisions for the current work: [docs/movin-v3](docs/movin-v3); the Go v1 history, with its plan and decisions: [docs/movin-v2](docs/movin-v2). v1 is tag `v1.0.1`.

## Deployment, in short

Single-replica Deployment (`Recreate`) with the app and an oauth2-proxy sidecar; read-only root filesystem, 32 Mi `/tmp`, 384 Mi memory limit with `NODE_OPTIONS=--max-old-space-size=256` (the poppler children share the limit; measured idle 57 MB, a probe +47 MB, a render +2 MB). The chat history is on the `movin-data` PVC, mounted at `/data`; it is in the Flux artifact, so a rollback to a release without it would prune the volume. Manifests are in [deploy/k8s](deploy/k8s); the Secrets to create by hand are described in [deploy/k8s/base/secrets.example.yaml](deploy/k8s/base/secrets.example.yaml); the app needs an AWS key that can read, write, list and delete in the bucket. It runs in an NKP project: on each `v*` tag CI publishes the rendered manifests (image pinned by digest) as an OCI artifact, and Flux, pointed at [deploy/flux](deploy/flux), applies the newest release (CI never commits to the repo). The web page is reached through a Cloudflare Tunnel (no Ingress). The admin guide has the step-by-step.

## Notes

- **No vendoring.** The dependencies are the pinned packages in [package-lock.json](package-lock.json), installed by `npm ci` inside Docker (`make lint test`); a new dependency needs a pinned install, not a vendored copy. `node_modules` holds Linux binaries and is git-ignored.
- **MinIO image.** Upstream `minio/minio` images are no longer published, so compose uses the community build `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`. It honours `If-Match` and `If-None-Match` on PUT, which `objstore.test.ts` checks on every `make test`.
- **Model limits are fixed in code, not settings**: at most 5 rounds that may call tools per message (then one more forced to answer in words, so at most 6 model calls), 10 minutes per model call, 15 minutes per Telegram message. Temperature and reply length are left to the model server.
- **Image base.** The production image is `node:24-alpine` (pinned by digest) with `poppler-utils` (GPL; unmodified Alpine packages) and DejaVu fonts, because the documents feature runs `pdfinfo`, `pdftotext` and `pdftocairo`. It runs as uid 65532 on a read-only root filesystem; fontconfig's cache goes to `/tmp`.
- **Public paths.** The manifest and home-screen icons are served without sign-in, because iOS fetches them without the cookie.
