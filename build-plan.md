# Our new place v1 — build plan for Claude Code

Oct 13, 2026 · @ZY

## Goal and scope

v1 is a self-hosted, single-container port of the current "Our new place" board, used by two people, with all state in one S3 bucket, and fully runnable and testable on a laptop through a Makefile. The published Claude board is the visual and behavioural reference; ship it as `reference/condo-board.html` in the repo.

In v1:

- Three boards: Admin, Renovation, Shopping list. Cards carry title, board, status (to do, in progress, done), date, time, vendor, price or quote, paid, notes, archived.
- Status pill cycles to do → in progress → done. Archive and restore. Hard delete behind a confirm.
- Header: move-in countdown tag (days to move in, then days since), quoted / paid / still-to-pay totals.
- "Coming up" strip of the next 10 dated, unfinished items, overdue in red.
- Month calendar below the boards, with key collection and move-in as milestone markers; agenda list on narrow screens.
- Chat panel that reads the board and changes it through tool calls on ZY's OpenAI-compatible endpoint.
- Live sync: a change by one person appears for the other within a few seconds.
- Warm dark theme and the current light theme, following the OS setting.

Also in v1: a settings drawer for the LLM connection (endpoint, key, model and tuning), so switching models never needs a redeploy.

Not in v1: Apple Calendar sync (an ICS feed is the planned later step), photo uploads for defects, notifications, CSV export, more than one household.

## Architecture

No persistent volume: the container is stateless and S3 is the only store. The data is a few hundred small records, so one JSON object in S3 is enough, and S3 conditional writes give safe concurrent edits without a database.

- **One app container.** Python 3.12 + FastAPI. It serves the static frontend, the REST API, a server-sent events stream, and the chat endpoint.
- **S3 bucket** (ap-southeast-1, versioning on). It holds `board.json`. Bucket versioning doubles as backup and undo history at no extra work.
- **LLM endpoint.** ZY's OpenAI-compatible endpoint, called server-side only. The browser never sees the API key.
- **Auth in front, not in the app.** oauth2-proxy, Cloudflare Access or Tailscale passes the signed-in email in a header. The app trusts that header only from the proxy and uses it to stamp who changed what.

Request flow: browser → auth proxy → app → S3 / LLM. On every successful write the app broadcasts the new board over SSE to all open tabs.

Run one replica. Conditional writes keep two replicas correct, but SSE fan-out across replicas is not worth building for two users.

Rejected alternatives, for the record: SQLite on a PVC (ties the pod to a node and needs backups), and SQLite + Litestream to S3 (good, but a second moving part for no gain at this data size).

## Data model and S3 layout

The whole board lives in `s3://<bucket>/<prefix>/board.json`, and every write is read-modify-write guarded by the object's ETag.

```json
{
  "schema": 1,
  "meta": { "moveDate": "2026-12-05", "keyDate": "2026-10-29" },
  "items": [
    {
      "id": "01JB...",
      "title": "Book movers",
      "cat": "admin",
      "status": "todo",
      "due": "2026-11-20",
      "time": "10:00",
      "vendor": "",
      "quoted": 1200,
      "paid": null,
      "notes": "",
      "archived": false,
      "created": "2026-10-13T15:07:13Z",
      "updated": "2026-10-13T15:07:13Z",
      "by": "zy@example.com"
    }
  ]
}
```

| Field | Rule |
| --- | --- |
| id | ULID, generated server-side |
| cat | `admin` \| `reno` \| `shopping`; anything else is read as `admin` |
| status | `todo` \| `doing` \| `done` |
| due, time | `YYYY-MM-DD`, `HH:MM` 24h, Asia/Singapore local, or null |
| quoted, paid | SGD, number ≥ 0 or null; for Shopping, `quoted` is the price |
| title | 1–200 chars; vendor ≤ 200; notes ≤ 4000 |

Write path:

1. `GetObject` → body + ETag (cache both in memory).
2. Apply the change, validate with Pydantic.
3. `PutObject` with `If-Match: <etag>`.
4. On `412 Precondition Failed`, re-read and retry, up to 3 times, then return 409.
5. First run: if the object is missing, create it with `If-None-Match: *`.

Keep `GetObject` off the hot path: serve reads from the in-memory copy and refresh it when the ETag changes (a `HeadObject` every 5 s is plenty for two users). Chat history stays in the browser in v1; nothing else goes in the bucket.

### LLM settings

LLM settings live in a second object, `s3://<bucket>/<prefix>/settings.json`, written the same ETag-guarded way.

```json
{
  "schema": 1,
  "llm": {
    "baseUrl": "https://<endpoint>/v1",
    "apiKeyEnc": "<ciphertext>",
    "model": "<model name>",
    "temperature": 0.2,
    "maxTokens": 1024,
    "timeoutSec": 60,
    "maxToolRounds": 5,
    "streaming": true
  },
  "updated": "2026-10-13T15:07:13Z",
  "by": "zy@example.com"
}
```

- The API key is encrypted before it is written, with a Fernet key from the `SETTINGS_SECRET` env var, and the bucket uses SSE-S3 or SSE-KMS on top. The key is never sent back to the browser.
- Resolution order per field: `settings.json`, then the `LLM_*` env vars, then built-in defaults. A missing or unreadable settings file falls back to env without failing the app.
- Bounds: temperature 0–1, maxTokens 128–8192, timeoutSec 10–300, maxToolRounds 1–8.

## API and chat

The board and the chat share one service layer, so a change made by hand and a change made by the LLM go through the same validation and the same S3 write.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/board` | Whole board + ETag |
| POST | `/api/items` | Create one item |
| PATCH | `/api/items/{id}` | Change fields of one item |
| DELETE | `/api/items/{id}` | Hard delete |
| PUT | `/api/meta` | Set `moveDate` and/or `keyDate` |
| GET | `/api/events` | SSE stream; sends the full board after every write |
| POST | `/api/chat` | Runs one chat turn; body is the recent turns |
| GET | `/healthz` | Liveness; `/readyz` also checks S3 read access |

Settings endpoints:

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/settings/llm` | Current settings; key shown only as set or not set, plus its last 4 characters |
| PUT | `/api/settings/llm` | Save; an empty key field keeps the stored key, an explicit clear removes it |
| POST | `/api/settings/llm/test` | Try the given settings without saving: lists models, then sends one tool-calling request; returns ok, latency and whether `tool_calls` came back |
| GET | `/api/settings/llm/models` | Proxies `GET {baseUrl}/models` for the model dropdown |

The chat endpoint reads settings on every turn, so a save takes effect on the next message.

Chat turn on the server:

1. Build a system message with today's date (Asia/Singapore), both key dates, the board categories with their hints, and the live items as compact JSON (non-archived only, notes cut to 200 chars).
2. Call `POST {LLM_BASE_URL}/chat/completions` with the user's last 12 turns and four tools: `add_items`, `update_item`, `archive_item`, `set_dates`. Copy their JSON schemas from the reference HTML.
3. Execute tool calls through the service layer, feed results back, and loop. Cap at 5 rounds; the last round is forced to answer.
4. Return `{reply, changes[]}`; `changes` is the list of human-readable lines shown under the reply ("Added: Book movers").

Keep these prompt rules from the reference: resolve relative dates from today, "18k" = 18000, update instead of duplicating, never invent dates, amounts or vendors, reply in 1–3 plain sentences.

Stream the reply with SSE from `/api/chat` if the endpoint supports streaming with tools; otherwise return it whole and show "Thinking…" meanwhile. Log each tool call (name, args, result) at INFO so a wrong edit can be traced.

## Frontend

Port the reference HTML as-is and swap its platform calls for the app's own API; do not redesign it.

- Plain HTML, CSS and vanilla JS, no build step, served from `/` by FastAPI. Keep the reference's design tokens, fonts, warm dark palette, layout breakpoints (1100 px chat becomes a full-screen sheet, 820 px boards scroll sideways, 700 px calendar becomes an agenda).
- Replace `claude.use("db")` reads with `GET /api/board` plus an `EventSource` on `/api/events`. Replace writes with the REST calls above. Replace `sample(...)` with `POST /api/chat`.
- Drop everything tied to the Claude runtime: consent handling, `user.can`, read-only banners. Every signed-in user can edit.
- Optimistic updates: apply the change locally, then reconcile with the board the server returns; on 409 show "Someone else just changed this. Showing the latest." and re-render.
- Add a web app manifest and icons so it installs to the home screen on both iPhones. No service-worker offline mode in v1.

### LLM settings drawer

A gear button in the chat panel header opens a drawer that slides in from the right, over the page, full-screen on phones.

- Fields: endpoint URL, API key (password field showing "Saved, ending 7f3a" when set), model (dropdown filled from the models list, with free text as a fallback), temperature, max tokens, timeout, max tool rounds, streaming on/off.
- Buttons: Test connection (shows latency and "Tool calling works" or the error from the endpoint), Save, Cancel. Save stays disabled until a test with the current values has passed or the user confirms saving anyway.
- A small line under the chat input shows the active model, so it is always clear what is answering.
- Both of you can open it; changes are stamped with who saved them.

## Config and deployment

Everything is configured by environment variables, and the same image runs locally under Docker Compose and on Kubernetes.

| Variable | Example | Notes |
| --- | --- | --- |
| S3\_BUCKET | `zy-condo-board` | Versioning on |
| S3\_PREFIX | `prod` | Lets dev and prod share a bucket |
| AWS\_REGION | `ap-southeast-1` |  |
| AWS\_ACCESS\_KEY\_ID / AWS\_SECRET\_ACCESS\_KEY | from a Secret | Omit when a role is available (IRSA, instance profile) |
| S3\_ENDPOINT\_URL | `http://minio:9000` | Local dev only |
| LLM\_BASE\_URL | `https://<endpoint>/v1` | OpenAI-compatible |
| LLM\_API\_KEY | from a Secret | Server-side only |
| LLM\_MODEL | `<model name>` | Must support tool calling |
| AUTH\_HEADER | `X-Forwarded-Email` | Set by the proxy |
| ALLOWED\_EMAILS | `zy@…,spouse@…` | Anyone else gets 403 |
| TZ | `Asia/Singapore` |  |

The `LLM_*` variables are now defaults: values saved in the settings drawer override them. Add `SETTINGS_SECRET` (a Fernet key from a Secret) to the table above; `make dev` generates one into `.env` on first run.

IAM policy for the app's credentials: `s3:GetObject` and `s3:PutObject` on `arn:aws:s3:::<bucket>/<prefix>/*`, `s3:ListBucket` on the bucket. Nothing else.

Image: multi-stage Dockerfile on `python:3.12-slim`, non-root user, read-only root filesystem with a small `/tmp` emptyDir, port 8080, `HEALTHCHECK` on `/healthz`.

Repo deliverables:

- `docker-compose.yml`: app + MinIO + a one-shot bucket-init container, for local dev. Check that the MinIO version used honours `If-Match` on PUT; if not, run the conflict test against real S3.
- `deploy/k8s/`: Deployment (1 replica, `Recreate` strategy), Service, Ingress, Secret template, no PVC. Plain YAML with a Kustomize overlay; a Flux `Kustomization` is a drop-in later.
- `deploy/auth/`: oauth2-proxy config as the default front door, Google as the identity provider.

### Local testing with make

Everything runs on a laptop with Docker and make as the only prerequisites: no local Python, no AWS account, no LLM needed for the default test run. Tests run inside the app image so they match production.

| Target | Does |
| --- | --- |
| `make dev` | Compose up app + MinIO with live reload, at http://localhost:8080 |
| `make down` | Stop the stack |
| `make seed` | Load `fixtures/board.sample.json` into MinIO |
| `make test` | Unit + API tests in the container, against MinIO, with a stubbed LLM |
| `make conflict-test` | Two concurrent writers on one ETag; both changes must survive |
| `make chat-eval` | Runs the Phase 3 messages against the real endpoint from `.env`; prints the board diff per message |
| `make lint` | ruff + format check |
| `make build` | Build the production image |
| `make run` | Run the production image locally against MinIO, read-only rootfs, as in k8s |
| `make clean` | Remove containers, volumes and the MinIO bucket |

`make test` must pass with no network beyond Docker Hub. Real secrets live in a git-ignored `.env`; a committed `.env.example` lists every variable. `make help` prints the targets.

## Build order

Five phases; Claude Code finishes and passes each check before starting the next.

**Phase 0: skeleton**

- [ ] FastAPI app, config from env, `/healthz`, Dockerfile, compose with MinIO
- [ ] Check: `make dev` serves a page and `/healthz` returns 200

**Phase 1: S3 store and REST API**

- [ ] Store module with ETag read, `If-Match` write, retry on 412, first-run create
- [ ] Pydantic models with the field rules; service layer; the REST endpoints
- [ ] Check: make test covers validation, CRUD, and a forced conflict (two writers on one ETag) ending with both changes kept

**Phase 2: frontend port and live sync**

- [ ] Reference HTML moved to `static/`, wired to the API and SSE
- [ ] Check: two browsers side by side; a change in one shows in the other within 5 s, on desktop and phone widths

**Phase 3: chat**

- [ ] `/api/chat` with the tool loop, 5-round cap, change lines, tool-call logging
- [ ] Check: make chat-eval sends these four messages and each produces the right board change: "We move in on 5 Dec", "Lim quoted 18k for carpentry, paid 30% today", "Add a 3-seater sofa, budget 2k, to the shopping list", "Drop the post-reno cleaning"

* [ ] Settings drawer, settings endpoints, key encryption, env fallback
* [ ] Check: `make test` covers the key never appearing in any API response or log line; switching the model in the drawer changes the model used by the very next chat message

**Phase 4: deploy and migrate**

- [ ] k8s manifests, oauth2-proxy, real S3 bucket with versioning, IAM user or role
- [ ] Import the current board: a one-off script turns an export of the Claude board into `board.json`
- [ ] Check: both of you sign in from your phones, see the migrated items, and a non-allowed account gets 403

Later, not v1: ICS feed at `/cal/<secret>.ics` for Apple Calendar subscriptions, defect photos in S3 under `attachments/`, reminder notifications.

## Open decisions

The plan assumes the defaults below; change any before handing it to Claude Code.

| Decision | Default in this plan | Alternative |
| --- | --- | --- |
| Backend language | Python + FastAPI | Go single binary, smaller image |
| Where it runs | Home-lab Kubernetes | Small AWS instance next to the bucket |
| Front door | oauth2-proxy with Google sign-in | Tailscale only, or Cloudflare Access |
| LLM model | Whichever model on the endpoint handles tool calls reliably | Test 2–3 against the Phase 3 messages |
| Bucket | New bucket in ap-southeast-1, versioning on | Prefix in an existing bucket |

One thing to confirm with the endpoint: that its `/chat/completions` supports the `tools` parameter and returns `tool_calls`. Phase 3 depends on it.
