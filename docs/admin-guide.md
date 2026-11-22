# Admin guide

How to set up, run and look after movin-tracker. Written for the person who operates it. Last updated 15 Nov 2026, with the NKP deployment.

It describes the app as it is; what isn't built yet is listed at the end.

## What runs where

| Part | What it is | Who uses it |
| --- | --- | --- |
| Telegram bot | The main way in. Lives inside the app and polls Telegram; nothing needs to reach it from outside. | You and your spouse, in a shared group or a private chat |
| Web page | Kanban board, calendar, countdown, totals, a secondary chat, and **Settings** (Storage, LLM, Telegram). | You, signed in with GitHub |
| oauth2-proxy | Sign-in in front of the web page (GitHub). Runs next to the app in the same pod. | Everyone who opens the web page |
| S3 bucket | All data: `entries.json` (entries, key dates, last 200 changes) and `settings.json` (LLM connection, Telegram allowlist). | The app only |
| LLM endpoint | Any OpenAI-compatible endpoint with tool calling. Set on the web page. | The app only |
| Data volume | `movin-data` (1 Gi, mounted at `/data`): chat history, scheduled tasks and the Telegram inbox. Created and deleted by Flux with the release; see "Chat history backup". | The app only |

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

1. Create the bucket in `ap-southeast-1` with **versioning on** and default encryption (SSE-S3). Versioning is your backup and undo-of-last-resort. Add a lifecycle rule that deletes noncurrent versions after 90 days, so old copies of the PDFs and `entries.json` don't pile up.
2. Create an IAM user for the app with read, write, list and delete on the bucket (a home app: no fine-grained policy). The app itself only writes `entries.json`, `settings.json`, `checkin.json`, `docs/index.json`, `docs/text/` and the storage test's scratch files under `_probe/`; it never changes or deletes your PDFs in `docs/raw/`. The same bucket and key serve your Mac (`make dev`) and production: there is one copy of the data.
3. Create an **access key** for that user. NKP clusters have no IRSA, so the pod uses this static key pair.

### 4. Two random secrets

Run this twice and keep both results (a password manager is fine):

```sh
openssl rand -base64 32 | tr '+/' '-_'
```

- The first is `SETTINGS_SECRET`: it encrypts the LLM API key saved on the web page. **Keep it stable.** If it changes, the saved key can't be read any more and you have to enter it again.
- The second is `OAUTH2_PROXY_COOKIE_SECRET`. Changing it signs everyone out of the web page, nothing worse.

`SETTINGS_SECRET` must be the **same** in production and in your `.env`: both read the one `settings.json` in the bucket. The cookie secret can differ.

### 5. GitHub packages

- The **app image** (`ghcr.io/<you>/movin-tracker`) can be **public**: it holds only the program, no config or secrets. GitHub → your profile → Packages → movin-tracker → Package settings → Change visibility.
- The **deploy artifact** (`movin-tracker-deploy`, created by the first release) is **public** too, like the repo: it holds the rendered manifests (host name, bucket name, allowed emails and Telegram IDs, no secrets). After the first release, check its visibility the same way. Being public, Flux needs no token for it, and the NKP GitOps source needs none for the repo.

### 6. Cloudflare Tunnel (how the web page is reached)

There is no Ingress. A `cloudflared` pod next to the app holds an outbound tunnel (`zy-all-in-one-tunnel`) to Cloudflare. Cloudflare serves `https://<your host>` with its own certificate and sends the traffic through the tunnel to the `movin` Service (oauth2-proxy, then the app). Nothing in the cluster needs a certificate.

1. Your domain's DNS is on Cloudflare. Use a host one level deep (`board.yourdomain.com`); the free certificate doesn't cover deeper names.
2. The tunnel is managed in the dashboard: Cloudflare **Zero Trust → Networks → Tunnels → zy-all-in-one-tunnel**.
3. **Public hostname** tab → **Add a public hostname**: your host, service type **HTTP**, URL `movin.movin-tracker.svc:80`. Cloudflare creates the DNS record.
4. **Token**: open the tunnel's **Edit** (connector install) page; the install command ends in `--token eyJ...`. That string goes into the `cloudflared-token` Secret. Anyone with it can run your tunnel: keep it secret, and rotate it on that page if it leaks.
5. Every `cloudflared` running this tunnel gets traffic, so run it only in the cluster.

Cloudflare gives up on a request that sends nothing for 100 seconds. The live updates send a heartbeat every 25 s and streamed chat replies start at once, so only a very long non-streamed chat turn can hit it.

## Secrets in the NKP namespace

Create these in the NKP project's namespace, `movin-tracker` (NKP UI, or `kubectl`). They are not in git. The template with comments is [deploy/k8s/base/secrets.example.yaml](../deploy/k8s/base/secrets.example.yaml).

| Secret | Key | Value |
| --- | --- | --- |
| `movin-secrets` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The IAM user's access key (step 3) |
| `movin-secrets` | `SETTINGS_SECRET` | First random value (step 4) |
| `movin-secrets` | `TELEGRAM_BOT_TOKEN` | From BotFather (step 1). Leave out to run without the bot |
| `movin-secrets` | `LLM_API_KEY` | Optional. Better: enter the key on the web page (Settings → LLM) |
| `oauth2-proxy` | `OAUTH2_PROXY_CLIENT_ID`, `OAUTH2_PROXY_CLIENT_SECRET` | From the GitHub OAuth App (step 2) |
| `oauth2-proxy` | `OAUTH2_PROXY_COOKIE_SECRET` | Second random value (step 4) |
| `cloudflared-token` | `token` | The Cloudflare Tunnel's token (step 6) |

With `kubectl` (replace the namespace and values):

```sh
kubectl -n movin-tracker create secret generic movin-secrets \
  --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --from-literal=SETTINGS_SECRET=... --from-literal=TELEGRAM_BOT_TOKEN=...
kubectl -n movin-tracker create secret generic oauth2-proxy \
  --from-literal=OAUTH2_PROXY_CLIENT_ID=... --from-literal=OAUTH2_PROXY_CLIENT_SECRET=... \
  --from-literal=OAUTH2_PROXY_COOKIE_SECRET=...
kubectl -n movin-tracker create secret generic cloudflared-token --from-literal=token=...
```

**After changing any Secret, restart the pod**, because the app reads them only at start:

```sh
kubectl -n movin-tracker rollout restart deploy/movin
```

## Configuration in git

These are not secret and live in [deploy/k8s/overlays/prod/kustomization.yaml](../deploy/k8s/overlays/prod/kustomization.yaml):

- **Host name**: the oauth2-proxy redirect URL in that file. The host itself is routed in the Cloudflare dashboard (step 6).
- **Bucket**: `S3_BUCKET` (the same bucket as `.env`; `S3_PREFIX` stays empty).
- **Image and version**: set by the release (CI pins the image by digest); `newTag` there only matters for local renders.

### Who can open the web page

The email must be in **both** places, because oauth2-proxy and the app each check:

1. [deploy/auth/authenticated-emails.txt](../deploy/auth/authenticated-emails.txt), one email per line (oauth2-proxy).
2. `ALLOWED_EMAILS` in the prod overlay, comma-separated (the app).

### Who can use the bot

Managed on the web page: **Settings → Telegram**. The env vars `TELEGRAM_ALLOWED_IDS` (`id=name,...`) and `TELEGRAM_ALLOWED_CHATS` (`-100...`) are only defaults for the first start; once you save the list on the page, it replaces them.

## Deploy, release, roll back

How it fits together: `git tag vX.Y.Z` → GitHub Actions tests, builds the image, renders the prod manifests with the image pinned by digest ([deploy/render.sh](../deploy/render.sh)) and pushes them as `ghcr.io/<you>/movin-tracker-deploy:X.Y.Z`. In the NKP project, Flux watches [deploy/flux/](../deploy/flux/) in git: it picks the newest `X.Y.Z` (1.0.0 or later, no prereleases) and applies it to `movin-tracker`. CI never commits to the repo.

Status: `kubectl -n movin-tracker get ocirepository,kustomization` (the `movin` rows show the version applied) and `kubectl -n movin-tracker get pods`.

### Release

1. Check the render first (needs the real host in the overlay; it refuses `example.com`): `KUSTOMIZE="kubectl kustomize" deploy/render.sh sha256:$(printf x | shasum -a 256 | cut -d' ' -f1) /tmp/out` and read `/tmp/out/movin.yaml`.
2. Push main, then tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. Wait for the `image` workflow (about 10 minutes; its last job, `deploy-artifact`, publishes the manifests). Flux checks every 5 minutes.
4. Check: the `movin` Kustomization says `Applied revision: 1.2.3@sha256:…`, the pod is Ready (readiness reads S3), **Settings → Storage → Test connection** passes and **Settings → Telegram** shows "Running as @yourbot".

A prerelease tag (`v1.2.3-rc.1`) runs the whole pipeline and publishes the artifact, but Flux ignores it: a safe rehearsal.

The Deployment uses `Recreate`: the old pod stops before the new one starts (one Telegram poller), so each release has a short gap.

### First release

1. Secrets in `movin-tracker` (above): `movin-secrets` (same `SETTINGS_SECRET` as `.env`), `oauth2-proxy`, `cloudflared-token`. Check: `kubectl -n movin-tracker get secrets`.
2. Host name in the prod overlay (redirect URL); the GitHub OAuth App callback and the Cloudflare public hostname use the same host. Commit and push.
3. Optional rehearsal: tag `v1.0.0-rc.1`; check the workflow is green and the `movin-tracker-deploy` package exists.
4. In the NKP project, add a GitOps source: this repo, branch `main`, path `deploy/flux` (give it a name other than `movin`). Expect the `movin` OCIRepository to report no matching version until step 6.
5. Stop the local app: `make down` (local and production share the bucket and the bot token; two bots get 409s).
6. Tag `v1.0.0` and push the tag.
7. Check as in "Release", plus: the OCIRepository still has no `secretRef`/proxy (NKP left it alone), the pod's image is `…@sha256:…`, sign-in works, and the app log has no 409: `kubectl -n movin-tracker logs deploy/movin -c app`.

To use `make dev` again later, stop production first ("Stop the app" below).

### Roll back

In [deploy/flux/ocirepository.yaml](../deploy/flux/ocirepository.yaml) set an exact version, `semver: "1.2.2"`, commit and push; Flux applies it within minutes. After a fixed release, set it back to `">=1.0.0"`.

**Don't roll back past the milestones release** (or run an older image against the bucket): older builds don't know an entry's `milestone` and `completed` fields and drop them from every entry the next time they save `entries.json`. Every 1.x release has them. If it happened, restore `entries.json` from an earlier version ("Recover older data").

### Pause, stop, resume

- **Pause** (Flux leaves the app as it is): `flux suspend kustomization movin -n movin-tracker`, or for good, `suspend: true` in [deploy/flux/release.yaml](../deploy/flux/release.yaml) (commit, push).
- **Stop the app** (e.g. to run `make dev`): pause first, then `kubectl -n movin-tracker scale deploy/movin --replicas=0`.
- **Resume**: `flux resume kustomization movin -n movin-tracker` (or remove `suspend`); Flux scales the app back to one.

## Using the web page

### Board, calendar, header

- Four columns: **Ideas & to do · Shortlisted & doing · Decided · Done**. Cards are coloured by kind (idea, decision, task, note, question). Click the status pill to move a card on; on a computer you can also drag it.
- Filters (room, kind, category, search) apply to the board and the calendar, and are remembered per browser.
- The header totals count **tasks and anything decided or done**. Priced ideas show separately as "Not yet decided".
- After any change you see a banner with **Undo**.
- **Milestones**: tick **Milestone ★** in an entry's dialog to mark a notable step (keys collected, kitchen installed). Done milestones are listed under the calendar, newest first, by month; click one to open it. Every entry records the day it moved to done (**Done on**, shown once the status is Done and filled with today); change it there if it happened on another day. Moving an entry out of Done clears its day.

### Settings → Storage

Shows where the data is (bucket, region, prefix, endpoint), what kind of AWS credentials the app found, and when `entries.json` last changed. These come from the Secrets and config; they can't be changed here.

**Test connection** runs six steps on a scratch file under `_probe/`: create, read back (head, get), check that a **stale write is refused** (this is what keeps two people's edits from overwriting each other), write with the current version, delete. All six green means storage is fine.

### Settings → LLM

The connection is any **OpenAI-compatible** `…/v1` endpoint, such as NAI or vMLX on your Mac. Type its **endpoint URL** and, if it needs one, its **API key**. (Since v2 the app no longer talks to Claude directly: a Claude connection saved by v1 is ignored, the page says so, and the server's `LLM_*` settings apply until you save a new one.)

Then, in order: press **Test connection** (it lists the endpoint's models), **pick a model**, then **Save**. Save first checks that the model can call tools; if it can't, nothing is saved and you can tick "Save even though the tool-calling check failed". Temperature and reply length are left to the model server; each model call may take up to 10 minutes and a message up to 5 tool rounds (fixed in the app). The key is stored encrypted; the page only ever shows its last four characters. Saving here overrides the `LLM_*` env vars, and the bot uses the new model from its next message.

A key is only ever sent to the endpoint it belongs to. If you switch to a **different host**, type that host's key: the saved key is dropped rather than sent to the new host, and the server's `LLM_API_KEY` only goes to `LLM_BASE_URL`.

**Think only when asked**: with this ticked, ordinary messages get quick answers and a message that starts with `/think` (Telegram or the web chat) gets the model's careful thinking, e.g. `/think compare the two zip blind quotes`. On thinking models (Qwen3 on vMLX or vLLM) every other request sends `chat_template_kwargs: {"enable_thinking": false}`. Leave it off for OpenAI itself and other endpoints that reject that field (Test connection fails with a 400 if so); with it off the model server decides and `/think` makes no difference.

**Dev and production share `settings.json`**, so don't edit the LLM tab from an older build while a newer one runs.

### Settings → Telegram

- **Status**: "Running as @yourbot" with the time of the last message, or why it isn't running.
- **People**: Telegram user ID and the name entries will show as "by".
- **Groups**: group chat IDs (they start with `-`).
- **Recently refused**: everyone who messaged the bot but isn't allowed, with **Add** buttons. **Save** applies the list from the next message; no restart.
- **Go back to the server's defaults** drops the saved list and uses the env vars again.
- **Morning check-in**: a line with when it's sent, where to, and when it last went out; below it the **time** (or **Off**) and **Send to** (the first allowed group by default, another group, or a person's private chat). **Save check-in** applies within a minute, no restart. Until you save here, `CHECKIN_SCHEDULE` / `CHECKIN_CHAT` on the server apply; **Go back to the server's defaults** drops what you saved.

### Settings → Documents

The PDFs under `docs/raw/` in the bucket, grouped by folder, with pages and what kind each is:

- **text**: the bot can search and read it.
- **drawing**: a sheet of A3 or larger with text (floor plan, M&E plans); searchable, and the bot can look at it as an image: the whole sheet first, then zoomed-in parts to read small labels. That needs a model that takes images: **Save** on the LLM tab checks it with a tiny test image.
- **scanned**: pictures only, or a text layer that comes out as gibberish; listed but not searchable yet (the later OCR phase).
- **skipped** (not a PDF, or a macOS `._` file), **couldn't be read** (with the reason; retried at every sync) or **removed** (gone from the bucket).

The line at the top gives the counts and the last sync. **Sync now** re-reads the bucket at once; the list updates by itself when it finishes.

## Everyday tasks

### Add your spouse (or yourself)

Ask them to send the bot any message in a private chat. Open **Settings → Telegram**, find them under **Recently refused**, press **Add**, check the name, **Save**.

### Add the group

Make sure privacy mode is off (BotFather `/setprivacy` → Disable) and the bot is in the group. Send any message in the group. Under **Recently refused** press **Add this group** (and **Add** for the person, if needed), then **Save**. In a group, the bot needs both the group and the person on the list.

### The group suddenly stopped answering

When Telegram upgrades a group to a "supergroup", its ID changes. The new ID shows under **Recently refused** as "group upgraded: new chat ID". Add it and remove the old one.

### Add or replace documents

1. In the S3 console open the bucket, then `docs/raw/` (make folders freely, e.g. `docs/raw/9.0 Contracts/`).
2. Upload the PDFs. Replacing a file with the same name counts as a new version.
3. Wait for the nightly sync (03:00), or send `/sync` to the bot, or press **Settings → Documents → Sync now**.

The group gets one message listing what was added, changed or removed (never for the very first import, and not again in the chat that sent `/sync`, which gets the result as a reply). Deleting a PDF from the bucket marks it removed at the next sync. Video and other non-PDF files are skipped.

### Switch the model or endpoint

**Settings → LLM**, change it, **Test connection**, **Save**. No restart.

### Undo a change

- In Telegram, press the **Undo** button under the bot's reply, or send `/undo` to undo your own last change.
- On the web page, press **Undo** in the banner or next to a change line in the chat.
- Undo is refused if someone changed that entry again since; that protects their later edit.
- Only the last 200 changes can be undone from the app. For anything older, see "Recover older data".

### Recover older data

The bucket keeps earlier versions of every object (for 90 days with the lifecycle rule): `entries.json`, `settings.json` and your PDFs under `docs/raw/`. A deleted PDF shows up again under **Show versions** (delete the "delete marker" to bring it back). In the AWS console, open the object → **Versions**, download the version you want, and upload it as the current version (or use `aws s3api copy-object` with `--copy-source <bucket>/entries.json?versionId=...`). The app notices within 5 seconds and the web page updates.

### Chat history backup

Chat history, scheduled tasks and the Telegram inbox are kept in a small database on the app's volume (`movin-data`, mounted at `/data`). Everything else (entries, settings, the check-in record and your documents) is in the S3 bucket and is covered by "Recover older data" above.

- **Backups:** Velero snapshots the volume daily and keeps 7 days. **Until that is set up and a restore drill has been recorded, the volume's data is not backed up**; losing it loses chat history only.
- **Restoring:** follow `docs/movin-v3/velero.md`, section "The real restore, in order". The one step that's easy to miss: set a **new** restore id in the `movin-restore` ConfigMap before starting the app again. With it, the app cancels any half-finished replies and tool calls from the snapshot instead of sending them again.
- **After a restore:** chat made after the snapshot is gone; entries, settings and documents are not affected.
- **Rolling back to a 1.0.x release deletes the volume:** Flux removes it with the release, since v1 has no volume. Coming back to v2 starts with an empty chat history unless you restore it from a backup.

### Rotate a secret

| What | Steps |
| --- | --- |
| AWS access key | Create a second key for the IAM user, update `movin-secrets`, restart the pod, check Settings → Storage, then delete the old key in AWS |
| Bot token | BotFather `/revoke`, put the new token in `movin-secrets`, restart the pod |
| GitHub OAuth secret | Generate a new client secret in the OAuth App, update `oauth2-proxy`, restart the pod, delete the old secret in GitHub |
| `SETTINGS_SECRET` | Avoid. If you must: update it, restart, then re-enter the LLM key in Settings → LLM |

## Using the bot

Tell it what's happening, in plain words. It records ideas, decisions, quotes, payments, dates and questions, and answers questions from the record.

- "Thinking of fluted glass for the dry kitchen sliding door"
- "Lim quoted 18k for carpentry, paid 30% today" (updates the existing carpentry entry instead of adding a second one)
- "Electrician coming Friday 2pm to check the DB"
- "What did we decide for the kitchen and what did it cost?"
- "How do I defrost the fridge?" or "Who do we contact about defects?" (it searches the documents and says which document and page it used)
- "Where is the DB on the power plan?" (it looks at the drawing)
- "We collected the keys today, that's a milestone" or "What milestones have we hit so far?" (it marks milestones only when you call something one)

If something is unclear (which bathroom?), it asks instead of guessing. In the group it stays quiet for ordinary chat between the two of you.

**Morning check-in.** Every day at 09:30 (change it on **Settings → Telegram**) the bot posts to the group: today's dated items, then one message per task from yesterday that isn't done, with **Done**, **Done ★** (done and a milestone), **Tomorrow** and **+1 week**. Each press is one change with an Undo; whoever presses it is recorded. Or just reply in words ("booked the movers, tiles moved to Saturday"). If a task was moved meanwhile, its old buttons do nothing. Older open tasks are listed as overdue. On a day with nothing dated and nothing open it sends nothing. It goes out once a day, even with both your Mac and production running (`checkin.json` in the bucket records it). If the app wasn't running at 09:30, it goes out when the app starts, until 20:00; after that the day is skipped, and the next check-in also asks about the missed days (up to a week back). To send it to a private chat instead, pick the person under **Send to** on the Telegram tab; they must have sent the bot `/start` once. The chosen chat must be on the allowlist; until it is, the check-in waits and the tab says why, and it goes out once you fix the list (until 20:00).

| Command | Does |
| --- | --- |
| `/think <message>` | Think it through before answering (slower); for comparisons and analysis. Only matters with Settings → LLM → Think only when asked |
| `/recent` | The last 10 changes, who made them and when |
| `/undo` | Undo your own last change |
| `/help` | What the bot can do |
| `/sync` | Re-read the documents now (they also sync at startup and every night) and say what changed |
| `/checkin` | The morning check-in now, in this chat (doesn't replace the scheduled one) |

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
| No morning check-in | The app wasn't running between 09:30 and 20:00, the check-in is Off, or no group/person is allowed | Settings → Telegram shows the check-in line; send `/checkin` to get it now |
| Last error mentions 409 / "another poller" | A second copy uses the same token (second replica, or a laptop running it) | Stop the other copy; keep replicas at 1 |
| Replies say "Sorry, that didn't go through" | The LLM endpoint is down or wrong | Settings → LLM → Test connection; fix and Save |
| Chat uses a model you didn't expect | An endpoint saved on the page overrides env | Change it in Settings → LLM |
| Storage test fails at "create" | No write permission, wrong bucket or prefix | Check the key's S3 permissions and `S3_BUCKET` / `S3_PREFIX` |
| Storage test fails at "refuse stale write" | The storage ignores conditional writes | Use AWS S3 (or MinIO); concurrent edits are not safe otherwise |
| Storage test fails only at "delete" | The key can't delete objects | Allow s3:DeleteObject on the bucket; the app still works without it |
| Web page 403 "not on the list" | Email missing in one of the two lists | Add it to `authenticated-emails.txt` and `ALLOWED_EMAILS` |
| Web page shows "Couldn't reach the server" | Pod not ready, usually S3 unreachable | `kubectl -n movin-tracker get pods`; check the app logs and Secrets |
| Saved LLM key "could not be decrypted" in the logs | `SETTINGS_SECRET` changed | Re-enter the key in Settings → LLM |
| LLM tab shows "No key saved" after changing the endpoint | Keys don't follow a change of host | Type the new endpoint's key, Test, Save |
| Log warns "listening beyond loopback" | `LISTEN_ADDR` set to something other than `127.0.0.1` | Fine locally; in k8s keep the default so only oauth2-proxy can reach the app |

Logs are JSON lines: `kubectl -n movin-tracker logs deploy/movin -c app` (locally `docker compose logs -f app`). Useful messages: `telegram message ignored` (who was refused and why), `agent tool call` (every change the agent made), `storage test`, `telegram bot started`.

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
| `LLM_KIND` | `openai` | Only `openai` (OpenAI-compatible). `claude` is refused at start since v2 |
| `LLM_STREAMING`, `LLM_THINK_ON_DEMAND` | true, false | Defaults; Settings → LLM overrides |
| `TELEGRAM_BOT_TOKEN` | empty | Bot token (Secret); empty = bot off |
| `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_ALLOWED_CHATS` | empty | Defaults; Settings → Telegram replaces them |
| `LISTEN_ADDR` | `127.0.0.1:8080` | Keep on loopback in k8s: the app trusts the auth header, so only the proxy beside it may reach it |
| `AUTH_HEADER` | `X-Forwarded-Email` | Header oauth2-proxy sets |
| `ALLOWED_EMAILS` | empty | Who may use the web page (empty = anyone the proxy lets in) |
| `DEV_EMAIL` | empty | Local only: act as this user without a proxy. Never in production |
| `TZ` | `Asia/Singapore` | Time zone for dates |
| `LOG_LEVEL` | `info` | `debug` logs every request |
| `DOCS_SYNC_SCHEDULE` | `03:00` | Daily document sync time in `TZ` (HH:MM), or `off` |
| `CHECKIN_SCHEDULE` | `09:30` | Default morning check-in time in `TZ` (HH:MM, before 20:00), or `off`; Settings → Telegram overrides it |
| `CHECKIN_CHAT` | (first allowed group, else first person) | Default chat ID for the check-in; Settings → Telegram overrides it |
| `GOMEMLIMIT` | `128MiB` in k8s | Go's heap target, below the 256 Mi pod limit (the PDF tools run beside it) |

### What's in the bucket

| Key | Content |
| --- | --- |
| `entries.json` | Entries, key dates, last 200 changes |
| `settings.json` | LLM connection (key encrypted), Telegram allowlist, check-in time and chat |
| `_probe/...` | Storage test scratch files, deleted right after |
| `docs/raw/...` | Your documents: drawings, contracts, developer and management-office papers (upload here, subfolders welcome, e.g. `docs/raw/contracts/...`) |
| `docs/index.json` | The documents list the app keeps (kind, pages, status, last sync); rebuilt by a sync if deleted |
| `checkin.json` | The last morning check-in (day, sent or quiet); deleting it means "not sent today" |
| `docs/text/...` | The text of each page, one file per document (`<same path>.json`); safe to delete, the next sync recreates it. The app never deletes anything, so the text of a removed PDF stays until you delete it |

## Not built yet

- **Scanned documents**: reading pages that are pictures only (OCR or the model's vision), and the garbled text layers. Listed today, not searchable.
- **Photos and voice notes** on entries.

This guide gets updated when each lands.
