# movin-tracker

"Our new place": a self-hosted board for two people moving into a new condo, covering admin, renovation and shopping lists. It has a countdown to move-in, a calendar, and a chat panel that edits the board through an OpenAI-compatible LLM. It runs as one stateless Go container, keeps all its state in one S3 bucket, and syncs live between your phones.

The design comes from [build-plan.md](build-plan.md). The visual reference, the original Claude-hosted board, is in [reference/condo-board.html](reference/condo-board.html).

## Quick start

You need Docker and make, and nothing else.

```sh
make dev     # app + MinIO with live reload at http://localhost:8080
make seed    # load fixtures/board.sample.json
make test    # unit + API tests against MinIO, stubbed LLM
make help    # every target
```

`make dev` creates `.env` from [.env.example](.env.example) on first run and puts a fresh `SETTINGS_SECRET` in it. To use the chat, either add your `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` to `.env`, or open the gear in the chat panel and set them there.

If port 8080, 9000 or 9001 is already in use, set `APP_PORT=8088` (and likewise `MINIO_PORT` / `MINIO_CONSOLE_PORT`) on the make command.

| Target | Does |
| --- | --- |
| `make dev` | Compose up app + MinIO with live reload |
| `make down` | Stop the stack |
| `make seed` | Load `fixtures/board.sample.json` into MinIO |
| `make test` | Unit + API tests in the container, against MinIO, with a stubbed LLM (race detector on) |
| `make conflict-test` | Two writers on one ETag; both changes must survive |
| `make chat-eval` | Sends the four Phase 3 messages to the real endpoint in `.env` and prints the board diff and PASS/FAIL for each |
| `make lint` | gofmt + go vet |
| `make build` | Build the production image (`movin:local`, about 22 MB, distroless, non-root) |
| `make run` | Run the production image against MinIO with a read-only root filesystem, as in k8s |
| `make clean` | Remove containers, volumes and the MinIO bucket |

## How it works

- **Storage.** The whole board is `s3://$S3_BUCKET/$S3_PREFIX/board.json`. Every write reads, changes, then writes the object with `PutObject If-Match: <etag>`. A `412` means someone else wrote first: the app re-reads, re-applies the change, and retries up to 3 times before answering `409`. The first run creates the object with `If-None-Match: *`. Reads come from memory, and a `HEAD` every 5 s picks up writes made elsewhere. LLM settings live next to the board in `settings.json`.
- **Live sync.** `GET /api/events` is a server-sent events stream that sends the full board after every change. The browser applies its own edits immediately, then reconciles with the board the server returns.
- **Chat.** `POST /api/chat` sends the model the board plus four tools (`add_items`, `update_item`, `archive_item`, `set_dates`), the same as the reference. It then runs the tool loop through the same service layer as the REST API, streams the reply, and returns the change lines ("Added: Sofa"). Every tool call is logged at INFO.
- **Settings drawer.** The gear in the chat panel sets the endpoint, key, model and tuning. Save stays disabled until "Test connection" confirms that tool calling works. The key is Fernet-encrypted with `SETTINGS_SECRET`, and the API only ever says whether a key is set and its last 4 characters. Each field falls back to `settings.json`, then the `LLM_*` env vars, then built-in defaults.
- **Auth.** This is done in front of the app, not inside it. oauth2-proxy (Google) sets `X-Forwarded-Email`, and the app checks it against `ALLOWED_EMAILS` (anyone else gets 403). In k8s the app listens on `127.0.0.1` and only its oauth2-proxy sidecar can reach it, so the header can be trusted. For local dev, `DEV_EMAIL` stands in for the proxy.

Code map: [cmd/movin](cmd/movin) (server, `healthcheck`, `init-bucket`, `seed`), [internal/board](internal/board) (model, rules, ETag write path), [internal/chat](internal/chat), [internal/llm](internal/llm), [internal/settings](internal/settings), [internal/server](internal/server) (HTTP), [static/index.html](static/index.html) (frontend, no build step).

## Deploy (Phase 4)

1. **Bucket.** Create it in `ap-southeast-1` with versioning and default encryption (SSE-S3) on. Give the app an IAM user or role with [deploy/iam-policy.json](deploy/iam-policy.json), changing the bucket and prefix names.
2. **Google OAuth client.** Create one (type Web) with the redirect URI `https://<host>/oauth2/callback`.
3. **Secrets.** Fill in [deploy/k8s/base/secrets.example.yaml](deploy/k8s/base/secrets.example.yaml) and apply it out of band. It is deliberately not part of the kustomization.
4. **Config.** Put the real host, image and emails in [deploy/k8s/overlays/prod/kustomization.yaml](deploy/k8s/overlays/prod/kustomization.yaml) and [deploy/auth/authenticated-emails.txt](deploy/auth/authenticated-emails.txt).
5. **Apply.** Build and push the image (`make build`, then tag and push), then run `kubectl apply -k deploy/k8s/overlays/prod`.

The Deployment runs 1 replica with the `Recreate` strategy and no PVC. The app container has a read-only root filesystem with a 16 Mi `/tmp` emptyDir. Readiness goes through oauth2-proxy to the app's `/readyz`, which checks S3.

### Migrating the current board

Export the Claude board's `items` collection and `meta/settings` document to JSON, then:

```sh
go run ./cmd/import -in export.json -out board.import.json -by zy@example.com
# local:  docker compose run --rm -v $PWD:/x bucket-init seed /x/board.import.json
# prod:   S3_BUCKET=… S3_PREFIX=prod go run ./cmd/movin seed board.import.json
```

The importer accepts `{items, meta}`, `{items: [{id, data}]}`, or a bare item array. It converts millisecond timestamps and runs every item through the same field rules as the API.

## Changes from the build plan

- **Go instead of Python + FastAPI.** The plan listed this as the alternative. Pydantic became explicit validation in [internal/board/model.go](internal/board/model.go), ruff became gofmt + go vet, and `python:3.12-slim` became `distroless/static:nonroot`. Go modules are vendored, so building and testing need no network beyond Docker Hub. The one exception is installing `air` for `make dev`.
- **MinIO image.** Upstream `minio/minio` images are no longer published, so compose uses the community build `pgsty/minio:RELEASE.2026-08-04T00-00-00Z`. It honours `If-Match` and `If-None-Match` on PUT, which `TestConditionalWrites` checks in every `make test` run.
- **Max tool rounds.** This counts rounds that may call tools. If the model is still calling tools after that, one more round is forced to answer in words. So the default of 5 means at most 6 LLM calls, and a setting of 1 can still edit the board.
- **Validation.** The API rejects bad values with 400 (the reference silently truncated them). An unknown category is still read as `admin`, and an empty date or time string clears the field.
- **Public paths.** The manifest and home-screen icons are served without sign-in, because iOS can fetch them without the cookie.
- **Narrow-screen fix.** One CSS fix over the reference: below 1100 px the main grid uses `minmax(0,1fr)`, so the sideways-scrolling board no longer widens the page on phones.
