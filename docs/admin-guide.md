# Admin guide

How to set up, run and look after movin-tracker. Written for the person who operates it. Last updated 11 Nov 2026, at the end of Phase 1.

Some parts are marked **(planned)**: the OCI + Flux deployment and the drawings feature are designed but not built yet. Everything else describes the app as it is.

## What runs where

| Part | What it is | Who uses it |
| --- | --- | --- |
| Telegram bot | The main way in. Lives inside the app and polls Telegram; nothing needs to reach it from outside. | You and your spouse, in a shared group or a private chat |
| Web page | Kanban board, calendar, countdown, totals, a secondary chat, and **Settings** (Storage, LLM, Telegram). | You, signed in with GitHub |
| oauth2-proxy | Sign-in in front of the web page (GitHub). Runs next to the app in the same pod. | Everyone who opens the web page |
| S3 bucket | All data: `entries.json` (entries, key dates, last 200 changes) and `settings.json` (LLM connection, Telegram allowlist). | The app only |
| LLM endpoint | Any OpenAI-compatible endpoint with tool calling. Set on the web page. | The app only |

The app runs as **one** pod and must stay at one replica: Telegram allows only one poller per bot token, and a second copy gets "409 Conflict".

## First-time setup

Do these once. They produce the values that go into the Secrets in the next section.

### 1. Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`. Pick a name and a username ending in `bot`. BotFather replies with the **bot token**. Keep it secret.
2. Still in BotFather, send `/setprivacy`, pick your bot, choose **Disable**. Without this the bot only sees commands in groups, not ordinary messages.
3. Create a Telegram group for the renovation with you and your spouse, and add the bot.
4. You don't need to know anyone's IDs yet. Once the app runs, message the bot; it ignores you and shows you under **Settings → Telegram → Recently refused**, with **Add** buttons.

### 2. GitHub OAuth App (web sign-in)

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Homepage URL: `https://<your host>`. Authorization callback URL: `https://<your host>/oauth2/callback`.
3. Create it, then **Generate a new client secret**. Note the **Client ID** and **Client secret**.
4. Sign-in is allowed by email: the GitHub account's verified primary email must be on the list (see "Who can open the web page" below). Your spouse needs a GitHub account only if they want the web page; Telegram doesn't need one.

### 3. AWS bucket and access key

1. Create the bucket in `ap-southeast-1` with **versioning on** and default encryption (SSE-S3). Versioning is your backup and undo-of-last-resort.
2. Create an IAM user for the app and attach [deploy/iam-policy.json](../deploy/iam-policy.json), changing the bucket name to yours. It allows read/write on the bucket's objects, delete only under `_probe/` (the storage test's scratch files), and listing the bucket. The same bucket and key serve your Mac (`make dev`) and production: there is one copy of the data.
3. Create an **access key** for that user. NKP clusters have no IRSA, so the pod uses this static key pair.

### 4. Two random secrets

Run this twice and keep both results (a password manager is fine):

```sh
openssl rand -base64 32 | tr '+/' '-_'
```

- The first is `SETTINGS_SECRET`: it encrypts the LLM API key saved on the web page. **Keep it stable.** If it changes, the saved key can't be read any more and you have to enter it again.
- The second is `OAUTH2_PROXY_COOKIE_SECRET`. Changing it signs everyone out of the web page, nothing worse.

Use different values in production and on your laptop.

### 5. GitHub packages

- The **app image** (`ghcr.io/<you>/movin-tracker`) can be **public**: it holds only the program, no config or secrets. GitHub → your profile → Packages → movin-tracker → Package settings → Change visibility.
- The **deploy artifact** (planned, `movin-tracker-deploy`) must stay **private**: it contains your host name, bucket and allowed emails.
- For Flux to pull the private artifact, create a GitHub token with only `read:packages` (fine-grained or classic). It goes into the `ghcr-pull` Secret.

## Secrets in the NKP namespace

Create these in the NKP project's namespace (NKP UI, or `kubectl`). They are not in git. The template with comments is [deploy/k8s/base/secrets.example.yaml](../deploy/k8s/base/secrets.example.yaml).

| Secret | Key | Value |
| --- | --- | --- |
| `movin-secrets` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The IAM user's access key (step 3) |
| `movin-secrets` | `SETTINGS_SECRET` | First random value (step 4) |
| `movin-secrets` | `TELEGRAM_BOT_TOKEN` | From BotFather (step 1). Leave out to run without the bot |
| `movin-secrets` | `LLM_API_KEY` | Optional. Better: enter the key on the web page (Settings → LLM) |
| `oauth2-proxy` | `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET` | From the GitHub OAuth App (step 2) |
| `oauth2-proxy` | `OAUTH2_PROXY_COOKIE_SECRET` | Second random value (step 4) |
| `ghcr-pull` | docker config | GitHub token with `read:packages` (step 5), for Flux (planned) |

With `kubectl` (replace the namespace and values):

```sh
kubectl -n <namespace> create secret generic movin-secrets \
  --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --from-literal=SETTINGS_SECRET=... --from-literal=TELEGRAM_BOT_TOKEN=...
kubectl -n <namespace> create secret generic oauth2-proxy \
  --from-literal=OAUTH2_PROXY_CLIENT_ID=... --from-literal=OAUTH2_PROXY_CLIENT_SECRET=... \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET=...
kubectl -n <namespace> create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<github user> --docker-password=<token>
```

**After changing any Secret, restart the pod**, because the app reads them only at start:

```sh
kubectl -n <namespace> rollout restart deploy/movin
```

## Configuration in git

These are not secret and live in [deploy/k8s/overlays/prod/kustomization.yaml](../deploy/k8s/overlays/prod/kustomization.yaml):

- **Host name**: the Ingress host, its TLS host and the oauth2-proxy redirect URL (three places, all in that file).
- **Bucket**: `S3_BUCKET` (the same bucket as `.env`; `S3_PREFIX` stays empty).
- **Image and version**: `images:` (today; replaced by the OCI artifact when Flux lands).

### Who can open the web page

The email must be in **both** places, because oauth2-proxy and the app each check:

1. [deploy/auth/authenticated-emails.txt](../deploy/auth/authenticated-emails.txt), one email per line (oauth2-proxy).
2. `ALLOWED_EMAILS` in the prod overlay, comma-separated (the app).

### Who can use the bot

Managed on the web page: **Settings → Telegram**. The env vars `TELEGRAM_ALLOWED_IDS` (`id=name,...`) and `TELEGRAM_ALLOWED_CHATS` (`-100...`) are only defaults for the first start; once you save the list on the page, it replaces them.

## Deploy, release, roll back

### Today: apply by hand

1. Tag a release: `git tag v1.2.3 && git push --tags`. GitHub Actions tests it and pushes the image `ghcr.io/<you>/movin-tracker:1.2.3`.
2. Set `newTag: "1.2.3"` in the prod overlay.
3. Apply: `kubectl apply -k deploy/k8s/overlays/prod` (cluster).
4. Check: the pod is Ready (readiness goes through `/readyz`, which reads S3), then open the web page → **Settings → Storage → Test connection**, and **Settings → Telegram** shows "Running as @yourbot".

Roll back: set the previous `newTag` and apply again, or `kubectl -n <namespace> rollout undo deploy/movin`.

### Planned: OCI artifact + Flux in the NKP project

Designed, not built (see [.claude/work/movin-v2/plan.md](../.claude/work/movin-v2/plan.md), "Deployment"). Once it lands:

- **Release** = `git tag vX.Y.Z` and push. CI builds the image and publishes the manifests, with the image pinned by digest, as `movin-tracker-deploy:X.Y.Z`. CI never commits to the repo.
- Flux in the NKP project watches the small, static `deploy/flux/` folder, which points it at the newest `X.Y.Z`, and applies it.
- **Roll back** = pin a version in `deploy/flux/` (a deliberate commit). **Pause** = `flux suspend kustomization movin`.

This section will be rewritten with exact commands when the deployment steps are done.

## Using the web page

### Board, calendar, header

- Four columns: **Ideas & to do · Shortlisted & doing · Decided · Done**. Cards are coloured by kind (idea, decision, task, note, question). Click the status pill to move a card on; on a computer you can also drag it.
- Filters (room, kind, category, search) apply to the board and the calendar, and are remembered per browser.
- The header totals count **tasks and anything decided or done**. Priced ideas show separately as "Not yet decided".
- After any change you see a banner with **Undo**.

### Settings → Storage

Shows where the data is (bucket, region, prefix, endpoint), what kind of AWS credentials the app found, and when `entries.json` last changed. These come from the Secrets and config; they can't be changed here.

**Test connection** runs six steps on a scratch file under `_probe/`: create, read back (head, get), check that a **stale write is refused** (this is what keeps two people's edits from overwriting each other), write with the current version, delete. All six green means storage is fine.

### Settings → LLM

Endpoint URL, API key, model and tuning. **Test connection** must show "Tool calling works" before **Save** is allowed (or tick "Save without a passing test"). The key is stored encrypted; the page only ever shows its last four characters. Saving here overrides the `LLM_*` env vars, and the bot uses the new model from its next message.

A key is only ever sent to the endpoint it belongs to. If you switch to a **different host**, type that host's key: the saved key is dropped rather than sent to the new host, and the server's `LLM_API_KEY` only goes to `LLM_BASE_URL`.

### Settings → Telegram

- **Status**: "Running as @yourbot" with the time of the last message, or why it isn't running.
- **People**: Telegram user ID and the name entries will show as "by".
- **Groups**: group chat IDs (they start with `-`).
- **Recently refused**: everyone who messaged the bot but isn't allowed, with **Add** buttons. **Save** applies the list from the next message; no restart.
- **Go back to the server's defaults** drops the saved list and uses the env vars again.

## Everyday tasks

### Add your spouse (or yourself)

Ask them to send the bot any message in a private chat. Open **Settings → Telegram**, find them under **Recently refused**, press **Add**, check the name, **Save**.

### Add the group

Make sure privacy mode is off (BotFather `/setprivacy` → Disable) and the bot is in the group. Send any message in the group. Under **Recently refused** press **Add this group** (and **Add** for the person, if needed), then **Save**. In a group, the bot needs both the group and the person on the list.

### The group suddenly stopped answering

When Telegram upgrades a group to a "supergroup", its ID changes. The new ID shows under **Recently refused** as "group upgraded: new chat ID". Add it and remove the old one.

### Switch the model or endpoint

**Settings → LLM**, change it, **Test connection**, **Save**. No restart.

### Undo a change

- In Telegram, press the **Undo** button under the bot's reply, or send `/undo` to undo your own last change.
- On the web page, press **Undo** in the banner or next to a change line in the chat.
- Undo is refused if someone changed that entry again since; that protects their later edit.
- Only the last 200 changes can be undone from the app. For anything older, see "Recover older data".

### Recover older data

The bucket keeps every version of `entries.json`. In the AWS console, open the object → **Versions**, download the version you want, and upload it as the current version (or use `aws s3api copy-object` with `--copy-source <bucket>/entries.json?versionId=...`). The app notices within 5 seconds and the web page updates.

### Rotate a secret

| What | Steps |
| --- | --- |
| AWS access key | Create a second key for the IAM user, update `movin-secrets`, restart the pod, check Settings → Storage, then delete the old key in AWS |
| Bot token | BotFather `/revoke`, put the new token in `movin-secrets`, restart the pod |
| GitHub OAuth secret | Generate a new client secret in the OAuth App, update `oauth2-proxy`, restart the pod, delete the old secret in GitHub |
| GHCR token | New token with `read:packages`, recreate `ghcr-pull` |
| `SETTINGS_SECRET` | Avoid. If you must: update it, restart, then re-enter the LLM key in Settings → LLM |

## Using the bot

Tell it what's happening, in plain words. It records ideas, decisions, quotes, payments, dates and questions, and answers questions from the record.

- "Thinking of fluted glass for the dry kitchen sliding door"
- "Lim quoted 18k for carpentry, paid 30% today" (updates the existing carpentry entry instead of adding a second one)
- "Electrician coming Friday 2pm to check the DB"
- "What did we decide for the kitchen and what did it cost?"

If something is unclear (which bathroom?), it asks instead of guessing. In the group it stays quiet for ordinary chat between the two of you.

| Command | Does |
| --- | --- |
| `/recent` | The last 10 changes, who made them and when |
| `/undo` | Undo your own last change |
| `/help` | What the bot can do |
| `/sync` | Re-read the drawings (planned; says "not switched on" for now) |

PDFs, photos and voice notes get "I can only read text for now" until those features land.

## Local development

You need Docker and make.

```sh
make dev       # the app with live reload, http://localhost:8080, on the real bucket
make test      # all tests (their own MinIO, race detector)
make lint      # gofmt + go vet
make run       # the production image, read-only filesystem, as in k8s
make down      # stop
make clean     # stop and delete the test MinIO's data (never the bucket)
```

- `make dev` creates `.env` from `.env.example` the first time. Locally there's no sign-in; you act as `DEV_EMAIL`, so the page is published on 127.0.0.1 only.
- **Local is live**: `make dev` and `make run` use the bucket and keys in `.env`, the same data production uses. Edits, undo and Settings changes made locally are real. `make test` never touches the bucket.
- **Same `SETTINGS_SECRET` everywhere**: `settings.json` is shared, so the saved LLM key only decrypts with the key that saved it.
- **LLM on your Mac**: from inside Docker use `http://host.docker.internal:<port>/v1`, not `localhost`. Check the port isn't also used by another container: `lsof -nP -iTCP:<port> -sTCP:LISTEN`.
- **Saved settings win over `.env`**: if the chat uses an unexpected endpoint, check Settings → LLM; it was saved there earlier.
- **Bot locally**: put a test bot's token in `TELEGRAM_BOT_TOKEN` in `.env`, then `docker compose up -d app`. Only one copy may run the bot per token (otherwise 409): once production runs the bot, leave `TELEGRAM_BOT_TOKEN` empty in `.env`.
- `make chat-eval` runs 10 real messages through the agent against the model in `.env` and prints PASS/FAIL for each.
- Ports in use? Run `APP_PORT=8088 make dev` (likewise `MINIO_PORT`, `MINIO_CONSOLE_PORT` for the test MinIO).

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Bot never answers in the group | Privacy mode on, or the group or person isn't allowed | BotFather `/setprivacy` → Disable; check Settings → Telegram → Recently refused |
| Bot answers privately but not in the group | Group not on the list, or its ID changed (supergroup) | Add the group from Recently refused |
| Telegram tab: "The bot is off: TELEGRAM_BOT_TOKEN is not set" | No token in `movin-secrets` | Add it, restart the pod |
| Telegram tab: not running, error mentions 401 | Wrong or revoked token | Put the right token in `movin-secrets`, restart |
| Last error mentions 409 / "another poller" | A second copy uses the same token (second replica, or a laptop running it) | Stop the other copy; keep replicas at 1 |
| Replies say "Sorry, that didn't go through" | The LLM endpoint is down or wrong | Settings → LLM → Test connection; fix and Save |
| Chat uses a model you didn't expect | An endpoint saved on the page overrides env | Change it in Settings → LLM |
| Storage test fails at "create" | No write permission, wrong bucket or prefix | Check the IAM policy and `S3_BUCKET` / `S3_PREFIX` |
| Storage test fails at "refuse stale write" | The storage ignores conditional writes | Use AWS S3 (or MinIO); concurrent edits are not safe otherwise |
| Storage test fails only at "delete" | IAM policy lacks DeleteObject on `<bucket>/_probe/*` | Add that statement; the app still works without it |
| Web page 403 "not on the list" | Email missing in one of the two lists | Add it to `authenticated-emails.txt` and `ALLOWED_EMAILS` |
| Web page shows "Couldn't reach the server" | Pod not ready, usually S3 unreachable | `kubectl -n <namespace> get pods`; check the app logs and Secrets |
| Saved LLM key "could not be decrypted" in the logs | `SETTINGS_SECRET` changed | Re-enter the key in Settings → LLM |
| LLM tab shows "No key saved" after changing the endpoint | Keys don't follow a change of host | Type the new endpoint's key, Test, Save |
| Log warns "listening beyond loopback" | `LISTEN_ADDR` set to something other than `127.0.0.1` | Fine locally; in k8s keep the default so only oauth2-proxy can reach the app |

Logs are JSON lines: `kubectl -n <namespace> logs deploy/movin -c app` (locally `docker compose logs -f app`). Useful messages: `telegram message ignored` (who was refused and why), `agent tool call` (every change the agent made), `storage test`, `telegram bot started`.

## Reference

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `S3_BUCKET` | (required) | Bucket name |
| `S3_PREFIX` | empty | Key prefix. Leave empty: dev and production share the bucket root |
| `AWS_REGION` | `ap-southeast-1` | Bucket region |
| `S3_ENDPOINT_URL` | empty | Only for a non-AWS store such as MinIO |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | from the AWS chain | Secret `movin-secrets` |
| `SETTINGS_SECRET` | empty | Fernet key for the saved LLM key (Secret) |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | empty | Defaults; Settings → LLM overrides |
| `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_TIMEOUT_SEC`, `LLM_MAX_TOOL_ROUNDS`, `LLM_STREAMING` | 0.2, 1024, 60, 5, true | Defaults; Settings → LLM overrides |
| `TELEGRAM_BOT_TOKEN` | empty | Bot token (Secret); empty = bot off |
| `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_ALLOWED_CHATS` | empty | Defaults; Settings → Telegram replaces them |
| `LISTEN_ADDR` | `127.0.0.1:8080` | Keep on loopback in k8s: the app trusts the auth header, so only the proxy beside it may reach it |
| `AUTH_HEADER` | `X-Forwarded-Email` | Header oauth2-proxy sets |
| `ALLOWED_EMAILS` | empty | Who may use the web page (empty = anyone the proxy lets in) |
| `DEV_EMAIL` | empty | Local only: act as this user without a proxy. Never in production |
| `TZ` | `Asia/Singapore` | Time zone for dates |
| `LOG_LEVEL` | `info` | `debug` logs every request |

### What's in the bucket

| Key | Content |
| --- | --- |
| `entries.json` | Entries, key dates, last 200 changes |
| `settings.json` | LLM connection (key encrypted), Telegram allowlist |
| `_probe/...` | Storage test scratch files, deleted right after |
| `docs/raw/...` | Your documents: drawings, contracts, developer and management-office papers (upload here; reading them is planned) |

## Not built yet

- **Drawings**: send PDFs to the bot; it stores them, renders pages and answers questions about them. Will add a Drawings tab, `/sync` and a daily re-sync.
- **Photos and voice notes** on entries.
- **OCI + Flux deployment** in the NKP project, replacing the manual apply.

This guide gets updated when each lands.
