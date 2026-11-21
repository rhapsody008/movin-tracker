# Spec: Go HTTP layer (`internal/server`, `cmd/movin`) — porting reference for T2

Produced by code-explorer on 2026-11-21 from the frozen Go code: `internal/server/server.go`,
`admin.go`, `docs.go` and the three test files, plus `cmd/movin/main.go`, `internal/config`,
`internal/entries`, `internal/settings`, `internal/telegram`, `internal/docs`, `internal/llm`,
`static/` and `web.go` where they fix HTTP behaviour. Line numbers refer to those files.
Where this file and the Go source disagree, the Go source wins; report the difference.

Scope: everything T2 must reproduce byte-for-byte for the browser page (`static/index.html`,
`static/guide.html`) and for `docs/movin-v2/tools/ui-check/check.mjs`, and where the port
deliberately changes behaviour (`plan.md` T2.1–T2.3, `decisions.md` LLM section). `POST /api/chat`
and the `/api/events` chat frames belong to T3: they are listed and tagged, not specified.

---

## 1. Every route

### 1.1 Router topology (`server.go:78-115`)

Two `http.ServeMux` values, the inner one wrapped:

```
root  ("/")                       -> logRequests( root )
  GET /healthz                    -> "ok\n"                     (no auth, no log line)
  GET /readyz                     -> readyz                     (no auth, no log line)
  GET /manifest.webmanifest       -> static()   ┐
  GET /icon.svg                   -> static()   │ no auth: iOS fetches them
  GET /icon-192.png               -> static()   │ without the sign-in cookie
  GET /icon-512.png               -> static()   │ (`server.go:102-107`)
  GET /apple-touch-icon.png       -> static()   ┘
  /                               -> auth( api )                (everything else)

api   (mounted under auth)
  GET     /api/entries
  POST    /api/entries
  PATCH   /api/entries/{id}
  DELETE  /api/entries/{id}
  POST    /api/changes/{id}/undo
  PUT     /api/meta
  GET     /api/events
  POST    /api/chat
  GET     /api/admin/guide
  GET     /api/admin/storage
  POST    /api/admin/storage/test
  GET     /api/admin/telegram
  PUT     /api/settings/checkin
  GET     /api/docs
  POST    /api/docs/sync
  PUT     /api/settings/telegram
  GET     /api/settings/llm
  PUT     /api/settings/llm
  POST    /api/settings/llm/test
  POST    /api/settings/llm/models
  /       -> static()             (catch-all: the page, guide.html, icons)
```

`{id}` is Go 1.22 wildcard syntax: exactly one non-empty path segment, `r.PathValue("id")`
(`server.go:288`, `:300`, `:310`). An id containing `/` does not match.

### 1.2 Route table

T2 owns everything below except the rows tagged **T3**. "Auth" is the oauth2-proxy header
check of §2.1 (all `api` routes are behind it; nothing here has a second check).

| # | Method + path | Auth | Success | Errors | Step | Channel |
|---|---|---|---|---|---|---|
| 1 | `GET /api/entries` | yes | 200 `Snapshot`, `ETag` header; 304 when `If-None-Match` matches | 500 | T2.1 | web |
| 2 | `POST /api/entries` | yes | 201 `entryResp` | 400, 409 (doc+etag), 500 | T2.1 | web |
| 3 | `PATCH /api/entries/{id}` | yes | 200 `entryResp` | 400, 404, 409 (doc+etag), 500 | T2.1 | web |
| 4 | `DELETE /api/entries/{id}` | yes | 200 `entryResp` **without** `entry` | 404, 409 (doc+etag), 500 | T2.1 | web |
| 5 | `POST /api/changes/{id}/undo` | yes | 200 `entryResp` | 404 ×2 texts, 409 ×2 shapes, 500 | T2.1 | web |
| 6 | `PUT /api/meta` | yes | 200 `entryResp` without `entry`/`change` | 400 ×3 texts, 409 (doc+etag), 500 | T2.1 | web |
| 7 | `GET /api/events` | yes | 200 `text/event-stream` (see §3) | pre-header 500/409 | T2.1 | web |
| 8 | `POST /api/chat` | yes | 200 `agent.Result` or SSE | 400, 502 | **T3.5** | web chat |
| 9 | `GET /api/admin/guide` | yes | 200 `text/markdown; charset=utf-8` | 404, 500 | T2.2 | web |
| 10 | `GET /api/admin/storage` | yes | 200 `storageView` (always 200) | — | T2.2 | web |
| 11 | `POST /api/admin/storage/test` | yes | 200 `probeResult` (ok true or false) | 409 busy | T2.2 | web |
| 12 | `GET /api/admin/telegram` | yes | 200 `telegramView` | — | T2.2 | web |
| 13 | `PUT /api/settings/telegram` | yes | 200 `telegramView` | 400, 409 (settings text), 500 | T2.2 | web |
| 14 | `PUT /api/settings/checkin` | yes | 200 `telegramView` | 400, 409 (settings text), 500 | T2.2 | web |
| 15 | `GET /api/docs` | yes | 200 `docsView` | 500 | T2.2 | web |
| 16 | `POST /api/docs/sync` | yes | **202** `{"joined":…,"started":…}` | 404 when docs off | T2.2 | web + agent |
| 17 | `GET /api/settings/llm` | yes | 200 `settings.View` | — | T2.2 | web |
| 18 | `PUT /api/settings/llm` | yes | 200 `settings.View` | 400, 409 (settings text), 500 | T2.2 | web |
| 19 | `POST /api/settings/llm/test` | yes | 200 `testResult` (also on a failed probe) | 400, 500 | T2.2 | web |
| 20 | `POST /api/settings/llm/models` | yes | 200 `{"models":[…]}` | 400 ×3 texts, 502 | T2.2 | web |
| 21 | `GET /healthz` | **no** | 200 `ok\n` | — | T2.1 | probe |
| 22 | `GET /readyz` | **no** | 200 `ok\n` | 503 `S3 not reachable\n` | T2.1 | probe |
| 23 | `GET /manifest.webmanifest`, `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/apple-touch-icon.png` | **no** | 200 file | 404 | T2.3 | browser |
| 24 | `GET /`, `GET /guide.html` | yes | 200 `index.html` / `guide.html` | 401/403 | T2.3 | browser |

"web only" vs "agent/chat": every route above is reached by the browser page or a probe.
The agent and Telegram channels never call HTTP; they use the same services in-process
(`cmd/movin/main.go:88-137`). `POST /api/chat` is the only conversational route and is web-only.
`POST /api/docs/sync` is shared: Telegram's `/sync` command calls `docs.Syncer.Sync`
directly with reason `telegram`, the route with reason `web` (`internal/server/docs.go:62`).

**Correction to the T2 brief:** there is **no** HTTP route for a document *page view* or a page
*image*. `docs.Viewer` (on-demand `pdftocairo` renders, `internal/docs/render.go:33-68`) is wired
only into `agent.Runner.Viewer` (`cmd/movin/main.go:122-123`) and is reached solely through the
agent tool `view_document_page` → **T3.3**, not T2. `GET /api/docs` lists the index; nothing
serves PDFs or PNGs over HTTP.

### 1.3 Request bodies, decoding and limits (`server.go:222-230`)

One helper for every JSON body:

```go
r.Body = http.MaxBytesReader(w, r.Body, 1<<20)      // 1 MiB, server.go:223
if err := json.NewDecoder(r.Body).Decode(v); err != nil {
    writeErr(w, http.StatusBadRequest, "Request body must be JSON: "+err.Error())
}
```

Consequences the port must match:

- **1 MiB cap, and oversize is a 400, not a 413.** `MaxBytesReader` returns
  `*http.MaxBytesError` with the text `http: request body too large`; `decode` maps it to
  `400 {"error":"Request body must be JSON: http: request body too large"}`. No route in the repo
  ever sends 413 (grep: no `StatusRequestEntityTooLarge`). `MaxBytesReader` also marks the
  connection `requestTooLarge`, so Go closes it after the response.
- Go decodes **one** JSON value and ignores anything after it (`json.Decoder`, not
  `Unmarshal`). Trailing whitespace and a second concatenated object are accepted; the second is
  never read. `Decoder` also allows an empty body only if the target is a pointer/map? — no:
  an empty body yields `EOF`, so `PUT /api/settings/telegram` with no body is
  `400 {"error":"Request body must be JSON: EOF"}`.
- The error text is Go's `encoding/json` text (`json: cannot unmarshal string into Go value of
  type entries.Patch`, `invalid character 'x' looking for beginning of value`, …). It is part of
  the response body; see §9.2 and §10 for what to do about it.
- Bodies with no `decode` call: `POST /api/admin/storage/test` (`admin.go:73`), `POST /api/docs/sync`
  (`docs.go:52`). Any body they receive is never read (and never drained — keep-alive may then
  see a closed connection; Go's server drains up to 256 KiB on its own).

Body shapes:

| Route | Type | Notes |
|---|---|---|
| `POST /api/entries`, `PATCH /api/entries/{id}` | `entries.Patch` = `map[string]json.RawMessage` (`internal/entries/model.go:185`) | raw field map; unknown keys are rejected by `Patch.Apply` → `unknown field "x"` (400). Allowed keys: `title, vendor, source, notes, category, room, status, date, time, cost, tags, archived, milestone, completed, kind` (`model.go:281-286`). Per-field rules and texts: `entries-spec.md` |
| `PUT /api/meta` | `map[string]json.RawMessage`, then only `moveDate`/`keyDate` (`server.go:315-333`) | each value must be a string or `null` |
| `POST /api/chat` | `{"turns":[{"role","content"}…]}` (`server.go:436-439`) | T3 |
| `PUT /api/settings/llm` | `settings.Input` (`internal/settings/settings.go:84-93`): `vision, kind, baseUrl, apiKey, clearKey, model, streaming, thinkOnDemand` | full replacement except the key; `settings-spec.md` §3 |
| `POST /api/settings/llm/test` | `settings.Input` (same) | nothing is saved |
| `POST /api/settings/llm/models` | `{"kind":"…","baseUrl":"…","apiKey":"…"}` (`server.go:575-579`) | key and URL only for this call |
| `PUT /api/settings/telegram` | `{"users":[{"id","name"}],"groups":[…],"useEnv":bool}` (`settings/telegram.go:61-65`) | |
| `PUT /api/settings/checkin` | `{"schedule":"…","chat":"…","useEnv":bool}` (`settings/checkin.go:45-49`) | |

`PUT /api/meta` has its own three 400 texts (`server.go:317-333`): `<k> must be a string or null`
(no quotes around the key) and `unknown field <k>` (no quotes) — note that this differs from the
entries patch rejection, which is `unknown field "x"` **with** `%q` quotes
(`internal/entries/model.go:230`).

### 1.4 Response bodies and field order

`writeJSON` (`server.go:182-186`) sets `Content-Type: application/json` (exactly that string, no
charset), writes the status, then `json.NewEncoder(w).Encode(v)` — which appends **one `\n`** and
HTML-escapes strings (§9.1, §9.2). `writeErr` (`:188-190`) is `writeJSON(status, {"error": msg})`.

Field order is Go struct order; **map bodies are alphabetically sorted** (`json.Marshal` sorts map
keys). The page only parses JSON, so order matters for byte-diff checks, not for the browser.

**`GET /api/entries` 200** — `entries.Snapshot.MarshalJSON` (`internal/entries/service.go:37-62`)
sends a `wireSnapshot{doc, etag}`, i.e. the document **without** the journal:

```json
{"doc":{"schema":1,"meta":{"moveDate":null,"keyDate":null},"entries":[ … ]},"etag":"\"6a1b…\""}
```

`Entry` field order (`internal/entries/model.go:37-57`): `id, kind, title, room, category, status,
cost{estimate,actual}, vendor, date, time, source, notes, tags, archived, milestone?, completed?,
by, channel, created, updated` (`?` = `omitempty`; `room` is `*string` **without** omitempty, so
`null` when unset). The ETag is sent verbatim **with its S3 quotes**, in the body and in the
`ETag` response header (`server.go:239`).

**`entryResp`** (`server.go:250-266`) — the answer to every write:

```json
{"entry":{…}?, "change":{"id":"…","text":"…"}?, "doc":{…}, "etag":"\"…\""}
```

- `entry` = the first entry the write touched (`Entries[0]`), omitted when empty; `DELETE` clears
  it explicitly (`server.go:302-303`) so a delete response never carries the removed entry.
- `change` = `agent.ChangeLine{ID, Text}` of the first journal record — the undo handle plus the
  ready-made banner line (`internal/agent/agent.go:54-57`, text from `agent.ChangeText`,
  `internal/agent/tools.go:355-372`). `PUT /api/meta` sends neither field (meta is not journaled).
  **`ChangeText`/`Summary` live in `internal/agent` but are pure functions over an entry** — T2.1
  needs them without the agent; port them next to `entries` (or in `src/server/changetext.ts`) and
  let T3 import them from there.
- `doc` = `View` (`model.go:665-669`): `{"schema","meta","entries"}`.

**409 from an entries conflict or a stale undo** (`server.go:205-212`) — a map, so keys sort:

```json
{"doc":{…},"error":"Someone else just changed this. Showing the latest.","etag":"\"…\""}
```
```json
{"doc":{…},"error":"That entry was changed again since, so it can't be undone.","etag":"\"…\""}
```

**409 from a settings conflict** — no `doc` (`server.go:213-214`):
`{"error":"These settings were changed somewhere else at the same moment. Reopen Settings and try again."}`

**500** — `writeErr(w, 500, "That change didn't save. Try again.")` and a log line
`ERROR "request failed" {method, path, err}` (`server.go:216-220`).

**`storageView`** (`admin.go:20-32`): `{"backend","bucket"?,"region"?,"prefix"?,"endpoint"?,`
`"credentialSource"?,"credentialError"?,"lastWrite":{"key":"entries.json","at":"2026-…Z"}|null,`
`"error"?}`. `lastWrite` has **no** omitempty: it is `null` when entries.json is absent, when the
store could not be reached, and before the first load. `at` is RFC 3339 with milliseconds
(`time.Time` JSON) in UTC. `error` = `"Could not read entries.json from storage."` on a stat
failure other than not-found (`admin.go:43-45`).

**`probeResult`** (`admin.go:52-66`): `{"ok","key":"_probe/<ULID>.json","steps":[`
`{"name","ok","skipped"?,"ms","error"?}…]}` — six steps in order: `create (only if absent)`,
`head`, `get`, `refuse stale write`, `write with current ETag`, `delete` (`admin.go:92-155`).

**`telegramView`** (`admin.go:167-175`): `{"status":{…},"allowlist":{…},"checkin":{…}}`.
- `status` = `telegram.Status` (`telegram/bot.go:74-83`): `tokenSet, running, botUsername?,
  lastPollAt?, lastUpdateAt?, lastError?, lastErrorAt?, rejected` (always an array; each
  `Rejected` = `chatId` (string!), `chatType`, `chatTitle?`, `fromId` (string!), `fromName?`,
  `reason`, `at`, `telegram/bot.go:62-70`; times use `omitzero`).
- `allowlist` = `settings.TelegramView` = `{users:[{id,name}], groups:[…], fromEnv, updated?, by?}`.
- `checkin` = `telegram.CheckinView` (`telegram/checkin.go:434-445`): `on, at?, until?, chat?,
  error?, last?{schema,day,status,since?,at,chat?}, noBot?, setting{schedule,chat,fromEnv,
  updated?,by?,unreadable?}`. `setting` is **always** present (`admin.go:177-184`).
- **With no bot (T2, no `TELEGRAM_BOT_TOKEN`)** the exact body is
  `{"status":{"tokenSet":false,"running":false,"rejected":[]},"allowlist":{…},"checkin":{"noBot":true,"setting":{…}}}`
  — a nil `*telegram.Bot` method call is legal in Go and returns the zero `Status` / a
  `CheckinView{NoBot:true}` (`telegram/bot.go:103-113`, `telegram/checkin.go:448-454`,
  `admin.go:177-184`). T2 must reproduce this without a bot object (see §6.3).

**`docsView`** (`docs.go:11-39`): `{"on","running","lastSync"?, "docs":[…]}` with
`lastSync` = `docs.Sync` (`internal/docs/index.go:85-95`: `at, reason, added, changed, removed,
failed, skipped, refreshed?, error?`) and each doc = the `docs.Doc` fields (`index.go:64-83`)
followed by `{"name":"Fridge.pdf","folder":"4.0 Manuals"}`. `docs` is `[]` (never null) and `on`
is `false` when the syncer is nil. Full field list: `docs-spec.md` §1.

**`{"started":bool,"joined":bool}`** for `POST /api/docs/sync` (`docs.go:64`) — a map, so the bytes
are `{"joined":…,"started":…}` (alphabetical).

**`settings.View`** (`settings/settings.go:97-111`): `vision, claudeOrigin, kind, baseUrl, model,
streaming, thinkOnDemand, keySet, keyLast4?, keyFromEnv, canStoreKey, updated?, by?`. v2 removes
`claudeOrigin` (`settings-spec.md` §11); the TS `View` already omits it (`app/src/settings/settings.ts:95`).

**`testResult`** (`server.go:503-519`): `{"ok","latencyMs","toolCalls","models"?,"modelsError"?,
"vision","error"?}` — always 200, even when `ok:false`.

**`{"models":["…"]}`** for the model list (`server.go:610`); ids are **sorted**
(`internal/llm/openai.go:129`), and the Anthropic `?limit=1000` special case is gone in v2.

### 1.5 Error mapping — `fail()` (`server.go:196-221`)

`fail` is the single mapper; it is called from every handler that touches a service. Order
matters (first match wins):

| `errors.As` / `errors.Is` | Status | Body |
|---|---|---|
| `*entries.ValidationError` | 400 | `{"error": <ve.Msg>}` — e.g. `title must be 1–200 characters`, `unknown field "x"` |
| `*settings.ValidationError` | 400 | `{"error": <se.Msg>}` — e.g. `baseUrl must start with http:// or https://`, `kind must be openai`, the check-in texts |
| `entries.ErrEntryNotFound` | 404 | `{"error":"That entry no longer exists."}` |
| `entries.ErrChangeNotFound` | 404 | `{"error":"That change is too old to undo."}` |
| `entries.ErrUndoStale` | 409 | `{"doc":…,"error":"That entry was changed again since, so it can't be undone.","etag":…}` |
| `settings.ErrConflict` | 409 | `{"error":"These settings were changed somewhere else at the same moment. Reopen Settings and try again."}` |
| `entries.ErrConflict` | 409 | `{"doc":…,"error":"Someone else just changed this. Showing the latest.","etag":…}` |
| anything else | 500 | `{"error":"That change didn't save. Try again."}` + `ERROR "request failed"` |

The two entries-conflict cases re-read `s.Entries.Current(ctx)` and **ignore its error**. If that
re-read also fails, the zero snapshot is used: `Doc` is nil, `(*Doc).View()` answers nil
(`internal/entries/model.go:671-676`), so the body is
`{"doc":null,"error":"…","etag":""}`. Reproduce that instead of throwing.

`settings.ErrConflict` has **no** `doc` (asserted: `server_test.go:867-873`). The two 409 texts and
the 500 text are asserted verbatim (`server_test.go:310-320`, `:867`).

Two more status codes outside `fail`:

- **404 `no such endpoint`** — `static()` answers any path under `/api/` it did not serve
  (`server.go:156-162`), as `{"error":"no such endpoint"}` **with 404** (JSON, not `http.Error`).
- **502** — `POST /api/settings/llm/models` when the endpoint fails:
  `{"error":"endpoint returned 401: Invalid API key"}` (`server.go:606-609`, text from
  `llm.APIError`, `internal/llm/llm.go:59-66`, body trimmed to 300 chars + `…`,
  `openai.go:77-89`). `POST /api/chat` uses 502 the same way (T3).

### 1.6 Status codes by handler (exhaustive)

| Handler | Codes it can emit |
|---|---|
| `getEntries` (`server.go:233-248`) | 200, 304, 400/404/409/500 via `fail` (a decode error in `entries.json` surfaces as 500) |
| `createEntry` (`:268-279`) | 201, 400, 409, 500 |
| `patchEntry` (`:281-292`) | 200, 400, 404, 409, 500 |
| `deleteEntry` (`:294-304`) | 200, 404, 409, 500 |
| `undoChange` (`:306-313`) | 200, 404 (×2), 409 (×2), 500 |
| `putMeta` (`:315-349`) | 200, 400 (×3), 409, 500 |
| `events` (`:385-433`) | 200 (SSE), or `fail` before the first byte |
| `getGuide` (`admin.go:217-231`) | 200, 404 (`no admin guide in this build`), 500 (`The admin guide could not be read.`) |
| `getStorage` (`admin.go:34-50`) | 200 only |
| `testStorage` (`admin.go:73-84`) | 200, 409 (`A storage test is already running.`) |
| `getTelegram`, `putTelegram`, `putCheckin` | 200; PUT adds 400/409/500 |
| `getDocs` (`docs.go:41-50`) | 200, 500 (via `fail`, so the message is `That change didn't save. Try again.`) |
| `syncDocs` (`docs.go:52-66`) | 202, 404 (`Documents are not switched on.`) |
| `getSettings`/`putSettings` (`:486-501`) | 200; PUT adds 400/409/500 |
| `testSettings` (`:521-561`) | 200, 400 (bad input), 500/other via `fail` |
| `listModels` (`:573-611`) | 200, 400 (×3), 502 |
| `readyz` (`:169-180`) | 200, 503 |

---

## 2. Middleware

There is no framework and no middleware chain beyond three wrappers: `logRequests`, `auth`, and
the `statusRecorder`. Everything else is per-handler.

### 2.1 Auth — `auth()` (`server.go:117-134`)

```go
email := strings.ToLower(strings.TrimSpace(r.Header.Get(s.AuthHeader)))   // :119
if email == "" { email = s.DevEmail }                                     // :120-122
if email == "" { http.Error(w, "Not signed in.", 401); return }           // :123-126
if len(s.AllowedEmails) > 0 && !slices.Contains(s.AllowedEmails, email) {  // :127-131
    log.Warn("rejected user not on ALLOWED_EMAILS", "email", email, "path", r.URL.Path)
    http.Error(w, "This page is private. "+email+" is not on the list.", 403); return
}
next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, email)))  // :132
```

- **Header**: `AUTH_HEADER`, default `X-Forwarded-Email` (`internal/config/config.go:64`), set by
  the oauth2-proxy sidecar with `pass_user_headers = true` (`deploy/auth/oauth2-proxy.cfg:26`).
  oauth2-proxy strips a client-supplied copy, and the app listens on `127.0.0.1:8080`
  (`deploy/k8s/base/deployment.yaml:31`) so nothing else can reach it. That — not a CSRF token —
  is the whole security model.
- **Value**: lowercased, trimmed. `Partner@Example.com` passes for `partner@example.com`
  (`server_test.go:200-202`).
- **Dev bypass**: an empty header falls back to `DEV_EMAIL` (already lowercased in config,
  `config.go:65`). Both empty → 401. It is impossible to be authenticated as *two* users; the
  header wins over `DEV_EMAIL`.
- **Allowlist**: empty `ALLOWED_EMAILS` = allow every signed-in user (config logs a warning,
  `cmd/movin/main.go:104-106`). Otherwise exact match against the lowercased, comma-split,
  trimmed list (`config.go:89-93`).
- **Bodies** are `http.Error`: `text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, a
  trailing `\n` (§9.1). 401 body `Not signed in.\n`; 403 body
  `This page is private. stranger@example.com is not on the list.\n`.
- Applied to **everything except**: `/healthz`, `/readyz`, the manifest and the four icon files.
  `GET /` (the page), `/guide.html`, every `/api/*` route and the static catch-all are behind it
  (`server_test.go:186-206` asserts 401/403 for `/api/entries` and `/`, and 200 for `/icon.svg`
  without a header).

### 2.2 CSRF and origin checks — none

There is no CSRF token, no `Origin`/`Referer`/`Sec-Fetch-Site` check, no CORS headers (no
`Access-Control-*` anywhere in `internal/server`), no `Content-Security-Policy`, `X-Frame-Options`
or `Strict-Transport-Security` header. Two accidental mitigations:

- oauth2-proxy sets a `SameSite=Lax` cookie (`deploy/auth/oauth2-proxy.cfg:32`), so a cross-site
  form POST does not carry the session;
- the page always sends `Content-Type: application/json` (`static/index.html:540`), which a
  cross-site HTML form cannot.

One deliberate design choice that *is* a CSRF defence: `POST /api/settings/llm/models` is a POST
so that following a link cannot trigger it (and leak the key to a host named in the query string,
`server.go:571-574`, `server_test.go:855-860`). **Keep the port free of a "GET also works"
convenience** — `check.mjs` and `server_test.go` both rely on GET not working.

### 2.3 Request logging — `logRequests()` (`server.go:136-154`)

```go
rec := &statusRecorder{ResponseWriter: w, status: 200}
next.ServeHTTP(rec, r)
if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" { return }   // :150-152
s.Log.Debug("request", "method", r.Method, "path", r.URL.Path, "status", rec.status,
            "ms", time.Since(start).Milliseconds())                 // :153
```

- Level **DEBUG**, so with the default `LOG_LEVEL=info` no request line is written at all. The
  message is `request` and the four fields are `method, path, status, ms` (slog JSON → one line
  `{"time":…,"level":"DEBUG","msg":"request","method":"GET",…}`). The TS logger already writes
  that shape (`app/src/log.ts:28-40`).
- `status` is what the handler passed to `WriteHeader` (default 200, so an implicit 200 counts); a
  handler that never calls `WriteHeader` and writes nothing logs 200.
- `statusRecorder` implements `Unwrap() http.ResponseWriter` (`server.go:141`) — that is what makes
  `http.NewResponseController` (SSE flush, write deadline) keep working through it. Node has no
  equivalent; just pass the `ServerResponse` around.
- Only the four other log lines in the server matter to tests: `entry deleted` (Info,
  `by,id,title`, `:299`), `rejected user not on ALLOWED_EMAILS` (Warn, `email,path`, `:128`),
  `LLM settings test` (Info, `by,model,ok,latencyMs`, `:558`), `storage test` (Info,
  `by,ok,key`, `:82`), `document sync requested` (Info, `by,joined`, `docs.go:63`), plus
  `WARN storage stat failed`, `WARN readyz: S3 not reachable`, `WARN admin guide unreadable`,
  `WARN document sync from the web page failed`, `ERROR request failed`.

### 2.4 Body limits, timeouts, compression, cache headers

| Concern | Go | Where |
|---|---|---|
| Body size | 1 MiB per request body, on the JSON routes only (400 on exceed) | `server.go:223` |
| Read header timeout | 10 s | `cmd/movin/main.go:147` |
| Read timeout | none (unbounded) | — |
| Write timeout | **none**, deliberately: SSE streams stay open | `main.go:149` |
| Idle timeout | 120 s | `main.go:148` |
| Per-request work deadlines | `readyz` 5 s; `GET /api/admin/storage` 10 s; `POST /api/admin/storage/test` 30 s; `POST /api/settings/llm/models` 15 s (as `cfg.TimeoutSec`); chat is unbounded | `server.go:170`, `admin.go:35`, `admin.go:79`, `server.go:604` |
| Compression | **none** (no gzip middleware anywhere) | — |
| `Cache-Control` | `no-cache` on static files (`server.go:164`) and on the admin guide (`admin.go:229`); **nothing** on any `/api/` JSON response, so `GET /api/entries` has no cache headers at all and the browser's `EventSource`/`fetch` never caches it in practice |  |
| ETag | only `GET /api/entries` (from S3, quoted) | `server.go:239` |
| `Server` header | Go's default: none set (Go's `net/http` sends no `Server` header) | — |
| `Date` | added by Go; Node adds it too | — |
| Max header bytes | Go default 1 MiB | — |

The one thing that must not regress: a `Content-Encoding` or buffering layer in front of
`/api/events` breaks the page. Go sets `X-Accel-Buffering: no` for that reason (§3).

### 2.5 Static files (`server.go:156-167`, `web.go`)

```go
files := http.FileServerFS(s.Static)          // server.go:157
if strings.HasPrefix(r.URL.Path, "/api/") {   // :159-162
    writeErr(w, 404, "no such endpoint"); return
}
w.Header().Set("Cache-Control", "no-cache")   // :164
files.ServeHTTP(w, r)
```

- `s.Static` is an `fs.FS`: the embedded `static/` tree in production (`web.go:11-22`,
  `//go:embed static`), or `os.DirFS(STATIC_DIR)` in dev (`main.go:108-116`). Content:
  `index.html` (88 KB), `guide.html` (8 KB), `icon.svg`, `icon-192.png`, `icon-512.png`,
  `apple-touch-icon.png`, `manifest.webmanifest`. No subdirectories.
- `GET /` serves `index.html` as the directory index. **`GET /index.html` answers 301 with
  `Location: ./`** (Go's `serveFile`, `fs.go:684-690`) — the page must keep working when the
  browser follows that relative redirect.
- There is **no template rendering**: `index.html` is served byte-for-byte. Any server-side
  injection is a behaviour change (T2.3 says "served as today").
- Content types come from the file extension via Go's `mime` package: `.html` →
  `text/html; charset=utf-8`, `.svg` → `image/svg+xml`, `.png` → `image/png`. `.webmanifest` is
  **not** in Go's built-in table (`$GOROOT/src/mime/type.go`), and the alpine runtime has no
  `/etc/mime.types`, so Go falls back to content sniffing → `text/plain; charset=utf-8`. Keep that
  (the manifest is fetched with `rel="manifest"`; Chrome does not require the JSON type), or send
  `application/manifest+json` and note the intentional difference.
- No `Last-Modified` and no `ETag` from the embedded FS (zero modtime in `embed.FS`), so a
  conditional GET always returns the full file; `Cache-Control: no-cache` makes the browser
  revalidate on every load, which is the intent ("a deploy shows up on the next load",
  `server.go:163`). With `STATIC_DIR` the real modtime **is** sent and `If-Modified-Since`/Range
  work (Go's `ServeContent`).
- Range requests are supported (Go `ServeContent` answers 206 with `Content-Range`); HEAD works
  (Go serves headers only).
- **No method check**: `http.FileServer` serves a POST to `/` too (the catch-all is method-less),
  so `POST /` returns `index.html`. Any `POST /api/unknown` answers the JSON 404 from the prefix
  check above.
- No directory listing can happen in practice (no subdirectory), but a stray directory in
  `STATIC_DIR` in dev would produce Go's HTML listing — do not port that.

---

## 3. SSE: `GET /api/events` (§T2.1)

### 3.1 Handshake and headers (`server.go:351-382`)

```go
h.Set("Content-Type", "text/event-stream")
h.Set("Cache-Control", "no-cache")
h.Set("X-Accel-Buffering", "no")   // nginx ingress: do not buffer
w.WriteHeader(http.StatusOK)       // :362 — headers committed here, nothing else ever changes them
rc := http.NewResponseController(w)
_ = rc.SetWriteDeadline(time.Time{})   // no write deadline on this connection
```

- Exactly these three headers (plus Go's `Date`/`Transfer-Encoding: chunked`); no `Connection:
  keep-alive` explicitly, no `retry:`, no `id:` (see 3.4).
- `Content-Type` must be exactly `text/event-stream` — asserted by `server_test.go:331-333`.
- A failure **before** `startSSE` (the initial `s.Entries.Current` read, `server.go:394-398`) goes
  through `fail()` and is a normal JSON error with the matching status.

### 3.2 Events and payloads (`server.go:367-382`, `:385-433`)

| Event | When | `data:` payload |
|---|---|---|
| `entries` | once at connect, then after every ETag change of `entries.json` | the full `Snapshot` wire form — byte-identical to the `GET /api/entries` body minus the trailing newline: `{"doc":{"schema","meta","entries"},"etag"}` |
| `docs` | after every finished document sync (success **or** failure of a run that started) | the full `docsView` (same body as `GET /api/docs`) |
| *(comment)* `: ping` | every heartbeat | none — the literal bytes `: ping\n\n` |
| `delta`, `reset`, `change`, `error`, `done` | **T3.5** web chat only; see §1.2 row 8 | `agent.Event` / `agent.Result` |

Wire format per event, from `sse.send` (`server.go:367-376`):

```go
b, _ := json.Marshal(v)                                   // HTML-escaped, no newline
fmt.Fprintf(e.w, "event: %s\ndata: %s\n\n", event, b)     // then Flush()
```

so on the wire (exactly one blank line after `data:`, `\n` line endings, no `id:`):

```
event: entries
data: {"doc":{"schema":1,...},"etag":"\"…\""}

: ping

```

`json.Marshal` (not `Encoder`) is used, so there is **no trailing newline inside the data line**
(beyond the format's own `\n`) and HTML escaping **is** on. The page parses with
`JSON.parse(e.data)` (`static/index.html:1387-1392`), so escaping is invisible to it — but a
byte-comparison test against Go will see it.

The heartbeat is a **comment**, not an event, so `EventSource.onmessage`/`addEventListener` never
sees it. Default 25 s, overridable by `Server.SSEHeartbeat` (`server.go:399-402`); the tests set
50 ms (`server_test.go:161`). It must stay under the proxy's `upstream_timeout = "300s"`
(`deploy/auth/oauth2-proxy.cfg:47-49`).

### 3.3 Subscriptions

- **entries**: `s.Entries.Subscribe()` → `(chan Snapshot, cancel)` (`internal/entries/service.go:229-239`).
  The channel has capacity 1 and the writer is latest-wins/non-blocking
  (`sendLatest`, `service.go:156-166`): a slow client silently skips intermediate docs and only
  ever receives the newest. Notifications fire from `set()` **only when the ETag changed**
  (`service.go:142-154`), so a self-write, a Telegram write, or a poll (`Poll` every 5 s,
  `config.go:69`, `service.go:120-129`) all produce exactly one event per changed ETag, and an
  unchanged re-read produces none.
- **docs**: `s.Docs.Subscribe()` → `<-chan struct{}` closed-value per finished sync
  (`internal/docs/sync.go:115-130`). The handler keeps **no** payload: on a signal it re-reads
  `s.docsView(ctx)` and sends that, dropping the event if the read fails (`server.go:415-421`).
  The syncer is nil when the documents feature is off; then `docsCh` is nil and Go's `select`
  simply never fires on it (`server.go:387-392`).
- **settings changes**: **not** on the stream. `settings.json` has a 30 s cache TTL and no
  notifications (`settings-spec.md` §9 item 15). The page re-reads settings itself after saving.

### 3.4 Reconnect and `Last-Event-ID`

- The server never sends an `id:` field, so a browser's `Last-Event-ID` is always empty; and the
  handler **ignores** `Last-Event-ID` (and `If-None-Match`) entirely. Every (re)connect gets a
  fresh `event: entries` snapshot first, then live events. No replay buffer, no gap detection, no
  `retry:` hint: the reconnection delay is the browser default.
- The page tolerates the duplicate snapshot by comparing ETags (`static/index.html:1387-1390`:
  `if (snap.etag && snap.etag === S.etag) return;`) and holds pushes back while own writes are in
  flight (`pending`/`pushedEtag`).
- On reconnect the **docs** state is not re-sent; the page refetches `GET /api/docs` when the tab
  is opened (`static/index.html:1336`). Preserve that asymmetry; adding an initial `docs` event
  would be a behaviour change (harmless, but it changes `check.mjs` timings).

### 3.5 Client disconnect, shutdown and flushing

- Disconnect: `case <-r.Context().Done()` (`server.go:409`) → the handler returns, `defer cancel()`
  unsubscribes from entries, `defer stop()` from docs, `defer tick.Stop()`. A write to a gone
  client fails and also ends the loop (`send` returns the error, `server.go:372-374`, `:411-413`,
  `:418-420`, `:422-424`). In Node: `res.on("close")` must clear the heartbeat timer and remove
  the listeners from both services — otherwise the fallback is a third source of leaks.
- Shutdown: `Server.CloseStreams()` (`server.go:62-70`) closes `s.closing`, which is another
  `select` arm (`server.go:408`), so `http.Server.Shutdown` does not wait for open streams.
  `RegisterOnShutdown(srv.CloseStreams)` in `main.go:154`. The TS equivalent: on SIGTERM, end every
  open SSE response, then `server.close()`; otherwise the 10 s shutdown budget is spent waiting.
- Flush: after **every** event and every ping (`e.rc.Flush()`, `server.go:375`, `:381`). Go's
  `ResponseController` flushes the `bufio.Writer` and (for HTTP/1.1) the TCP buffer. In Node,
  `res.flushHeaders()` once after the headers and then nothing is buffered — `res.write()` on a
  `ServerResponse` goes straight out unless `cork()`ed; if the implementation adds any wrapper, it
  must call `res.flushHeaders()` synchronously (before the first await) so the browser's
  `EventSource` reports `open` promptly.
- `SetWriteDeadline(time.Time{})` clears the deadline for this connection because Go's
  `WriteTimeout` would otherwise kill long streams. Node's `server.requestTimeout` (default 300 s
  in Node 18+) applies to receiving a complete request, not to an open response; still, set
  `keepAliveTimeout`/`headersTimeout` deliberately and note that `server.requestTimeout` also
  bounds *headers+body*, so a long stream is unaffected — but `server.timeout` (default 0) must
  stay 0 for streams to survive.

---

## 4. Health and readiness

Both are registered on the **root** mux, outside `auth` and outside `logRequests`' log line
(`server.go:108-109`, `:150-152`), because Docker's `HEALTHCHECK` (`Dockerfile:56`) and
oauth2-proxy's readiness probe (`deploy/k8s/base/deployment.yaml:63-66`, via `skip_auth_routes`)
call them without a user.

**`GET /healthz`** (`server.go:108`): writes `ok\n` with status 200, no other header. Go sniffs the
content type → `text/plain; charset=utf-8`. It does not touch S3: liveness only.

**`GET /readyz`** (`server.go:169-180`):

```go
ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
if _, err := s.Store.Stat(ctx, entries.Key); err != nil && !errors.Is(err, objstore.ErrNotFound) {
    s.Log.Warn("readyz: S3 not reachable", "err", err)
    http.Error(w, "S3 not reachable", http.StatusServiceUnavailable)   // 503
    return
}
_, _ = w.Write([]byte("ok\n"))                                          // 200
```

- One `Stat` of `entries.json` with a 5 s budget. A **missing** object is fine (the service creates
  it on first write): 200. Any other error (auth, network, DNS, timeout) → 503 with body
  `S3 not reachable\n`, `Content-Type: text/plain; charset=utf-8`,
  `X-Content-Type-Options: nosniff`.
- It does not check the LLM, settings, the bot or the docs index. Keep it that way: the pod must not
  go unready because the gateway is down.
- The TS store's `stat` throws `NotFoundError` on a missing key (`app/src/objstore/store.ts:20-24`),
  so the mapping is `NotFoundError → ok`, anything else → 503. An `AbortSignal` with a 5 s timeout
  replaces the context.

`GET /readyz` is also the readiness gate of the ui-check script
(`docs/movin-v2/tools/ui-check/run.sh:21`) and must therefore answer before the first entries load
finishes (`main.go:90-93` keeps serving when the initial load fails).

---

## 5. The LLM settings endpoints (T2.2)

Both endpoints touch the network with a key, so both are part of the key-leak contract
(`server_test.go:418-480`, `:793-866`): **no response body and no log line may contain the key**,
and **the stored/env key goes only to its own origin**.

### 5.1 `POST /api/settings/llm/models` — `listModels()` (`server.go:573-611`)

```go
var in struct{ Kind, BaseURL, APIKey string }  // json: kind, baseUrl, apiKey
cfg := s.Settings.Resolve(ctx)                 // the SAVED connection (kind, baseUrl, apiKey, …)
switch in.Kind {
case "claude":                                 // v1: fixed origin; REMOVED in v2 (§5.3)
    cfg.Kind, cfg.BaseURL = "claude", s.Settings.ClaudeBaseURL()
case "", "openai":
    if cfg.Kind != "openai" { cfg.BaseURL = "" }        // a claude saved URL is not an OpenAI URL
    cfg.Kind = "openai"
    if u := strings.TrimRight(strings.TrimSpace(in.BaseURL), "/"); u != "" { cfg.BaseURL = u }
default:
    writeErr(w, 400, "kind must be openai or claude"); return
}
if cfg.BaseURL == "" { writeErr(w, 400, "Set an endpoint URL first."); return }
cfg.APIKey = s.Settings.KeyFor(ctx, cfg.BaseURL, in.APIKey)   // typed key wins; stored/env key only for its own origin
cfg.TimeoutSec = 15
ids, err := llm.New(cfg).Models(ctx)
if err != nil { writeErr(w, 502, err.Error()); return }
writeJSON(w, 200, map[string]any{"models": ids})
```

What actually goes on the wire (`internal/llm/openai.go:46-107`, `:108-131`):

```
GET  {baseUrl}/models                     (baseUrl has no trailing "/"; Go appends "/models")
Content-Type: application/json
Authorization: Bearer {key}               — omitted entirely when key == ""
```

The `?limit=1000` suffix and the `anthropic-version` / `x-api-key` headers existed only for
`api.anthropic.com` (`openai.go:61-70`, `:109-112`) and are **gone in v2** (`plan.md` Design · LLM:
"no special handling for `api.anthropic.com`"). Response handling: decode `{"data":[{"id":…}]}`,
take `id`s, `sort.Strings` them, ignore everything else. Non-2xx: status + message (see §1.5, 502).
Decode failure: `502 {"error":"decode models list: <go json error>"}`.

Three 400s and one 502 are the whole error surface; a network error reaches the client as
`{"error":"Get \"http://…/models\": dial tcp …: connect: connection refused"}` — Go's `net/http`
error text, which the UI check matches loosely (`/Couldn't connect/` is a page-side string).

**A minimal T2 implementation is a plain `fetch`** — no `src/llm` needed: build the URL, set
`Authorization` only when the key is non-empty, `AbortSignal.timeout(15_000)`, parse `data[].id`,
sort with a byte-order comparison (`Array.prototype.sort()` on ASCII ids), and map errors to the
same `endpoint returned {status}: {body}` shape (body: read up to 2000 bytes, prefer
`error.message` from a JSON body, trim, cut at 300 characters + `…`).

### 5.2 `POST /api/settings/llm/test` — `testSettings()` (`server.go:521-561`)

1. `decode` → `settings.Input`; `s.Settings.ForTest(ctx, in)` — resolves exactly what the drawer
   shows **without saving** (`settings.ForTest`, `internal/settings/settings.go:447-467`; the key
   comes from `KeyFor`, so the same origin-binding rule applies). Validation errors → 400 via
   `fail` (bad URL, empty model, `kind` not openai).
2. `cfg.Streaming = false` (`server.go:530`) — the probe is never streamed.
3. `c := llm.New(cfg)`; **first call**: `c.Models(ctx)` — the list is informational. An error is
   stored in `modelsError` and the probe **continues** (`:532-534`).
4. **Second call** (`:535-546`), timed for `latencyMs`:

```
POST {baseUrl}/chat/completions
{"model":"<model>","messages":[
   {"role":"system","content":"You set dates on a board. Always use the tool."},
   {"role":"user","content":"We move in on 2026-12-05."}],
 "tools":[{"type":"function","function":{"name":"set_dates",
           "description":"Set the move-in date (YYYY-MM-DD).",
           "parameters":{"type":"object","properties":{"move_in":{"type":"string"}},"required":["move_in"]}}}],
 "chat_template_kwargs":{"enable_thinking":false}}      // only when thinkOnDemand is on
```

   (`probeTool` = `server.go:514-517`; the body field order is `model, messages, tools,
   tool_choice?, stream?, chat_template_kwargs?` from `internal/llm/openai.go:24-35`; `stream` is
   omitted when false.) Success is decided **only** by `choices[0].message.tool_calls` being
   non-empty (`:547-555`):

   | Outcome | Response fields |
   |---|---|
   | network/non-2xx/decode error | `error` = the text, `ok:false` |
   | answered, no `tool_calls` | `error` = `The endpoint answered but did not return tool_calls. Pick a model that supports tool calling.`, `ok:false` |
   | `tool_calls` present | `ok:true, toolCalls:true`, and vision is probed |

5. **Third call**, only when tool calling worked (`probeVision`, `:563-571`): one image, no tools:

```
POST {baseUrl}/chat/completions
{"model":"<model>","messages":[{"role":"user","content":[
   {"type":"text","text":"Reply with one word: what colour is this square?"},
   {"type":"image_url","image_url":{"url":"data:image/png;base64,<1×1 red pixel>"}}]}]}
```

   The literal is `probePNG`, 70 bytes, `server.go:558-559` (the standard 1×1 red PNG); copy the
   bytes rather than retyping a base64. Any error → `vision:false`; success → `vision:true`. The
   *response* is ignored.
6. `s.Log.Info("LLM settings test", "by", user, "model", cfg.Model, "ok", res.OK, "latencyMs", …)`
   and `200` with `testResult`. **Always 200** when the input parsed — a dead endpoint is a
   200 with `ok:false`, not a 502 (unlike `/models`). Asserted by `server_test.go:528-555`.

`latencyMs` covers call 2 only, in milliseconds. `vision` does not include call 3's time.

**This is the only T2 route that needs more than `fetch`-level work**: three requests, a
tool-call check, an image probe. T3.1's `src/llm` client will provide `models()`/`complete()`, but
T2.2 cannot wait for it. Two acceptable implementations, in order of preference:

- (a) a small `src/server/llmprobe.ts` (~100 lines of `fetch`) that does exactly the three calls
  above, with its own request types; T3.1 then replaces it and the tests move;
- (b) a thin `src/llm/http.ts` with only `models(cfg)` and `complete(cfg, req)` for the probe,
  which T3.1 extends. Do **not** stub the endpoint with a constant `ok:false`: `check.mjs`
  (`:222-244`) requires a real "Connected" from the stub at `host.docker.internal:18090` and the
  page's Save flow is gated on it.

What the stub returns (`docs/movin-v2/tools/ui-check/fakellm.py:11-27`): `/v1/models` →
`{"data":[{"id":"stub-openai-model"},{"id":"claude-opus-5-5"},{"id":"claude-sonnet-5-5"}],
"has_more":false}`; `/v1/chat/completions` → a `set_dates` tool call, which is what makes
`ok:true`. Any chat completion without `tool_calls` fails the UI check.

### 5.3 What changes in v2 (plan.md T2.2, `decisions.md` · LLM)

| v1 behaviour | v2 |
|---|---|
| `kind:"claude"` selects a fixed Anthropic origin (`s.Settings.ClaudeBaseURL()`) | **removed**: a body with `"kind":"claude"` is a **400**, text `Claude connections are no longer supported; use an OpenAI-compatible endpoint` (`app/src/settings/settings.ts:47`, thrown by `normalise` → `ValidationError` → `fail` → 400) |
| `kind:"gpt"` → `400 kind must be openai or claude` | `400 kind must be openai` (`app/src/settings/settings.ts:320`) |
| `settings.View.claudeOrigin` present (`settings.go:99`) | gone from the view (already ported: `app/src/settings/settings.ts:95`) |
| `res.Vision = cfg.Kind == "claude" \|\| s.probeVision(...)` (`server.go:553`) | `res.Vision = await probeVision(...)` — one code path, always the image probe |
| `LLM_CLAUDE_BASE_URL` redirecting the claude origin | env var removed (`app/src/config.ts:1-5`); `LLM_KIND=claude` refuses to start |
| `?limit=1000` + `anthropic-version`/`x-api-key` for `api.anthropic.com` | removed |
| kind radios, `claudeNote`, `anthHint`, `connKind`, `targetURL` in the page | T2.3 removes them and adds the legacy notice + confirm-before-overwriting-a-Claude-connection |

The **origin-binding contract** is unchanged and is the part the tests guard: `KeyFor(baseUrl,
typedKey)` returns the typed key when there is one, else the stored/env key **only if its own
base URL has the same origin** (`settings-spec.md` §3, `server_test.go:793-866`). Consequences the
port must keep:

- `POST /api/settings/llm/models {"baseUrl":"http://other:9/v1"}` must send **no**
  `Authorization` header at all (not an empty Bearer) to that host;
- a typed `apiKey` in the request is sent to the named host (that is the point of typing it);
- an empty `baseUrl` in the request means "the saved one" and then gets the saved key;
- `{}` = list the saved connection's models with the saved key;
- `GET /api/settings/llm/models?baseUrl=…` must not work (§2.2).

---

## 6. The admin routes (T2.2)

### 6.1 Storage — `GET /api/admin/storage` (`admin.go:34-50`)

Always 200, one JSON body, one `Stat` of `entries.json` in a 10 s budget:

```json
{"backend":"s3","bucket":"movin-dev","region":"ap-southeast-1","prefix":"dev",
 "endpoint":"http://minio:9000","credentialSource":"env keys",
 "lastWrite":{"key":"entries.json","at":"2026-11-21T03:04:05.678Z"}}
```

- `backend/bucket/region/prefix/endpoint/credentialSource/credentialError` come from
  `Store.Info(ctx)` when the store implements `Describer` (`internal/objstore/objstore.go:52-67`);
  otherwise only `lastWrite` is filled. The TS port has `info()` on the `ObjectStore` interface
  (`app/src/objstore/store.ts:37`), so this is a direct call.
- `lastWrite` = S3's `LastModified` **UTC** (`admin.go:41`), or `null` when the object is missing
  **or** the stat failed with anything other than not-found; in that second case `error` =
  `Could not read entries.json from storage.` and a `WARN storage stat failed` line is logged.
  S3 timestamps have one-second resolution — `server_test.go:557-598` sleeps 1.1 s to see it move.
- **Never** key material: the credential *source* label only. The test greps the body for the
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` **values** (`server_test.go:575-580`).
- `check.mjs:190-192` requires the page to show bucket `movin-dev`, endpoint `minio:9000`,
  `env keys` and `entries.json`, so the field names are load-bearing.

### 6.2 Storage probe — `POST /api/admin/storage/test` (`admin.go:68-165`)

- One probe at a time: `s.probeMu.TryLock()`; if another runs → **409**
  `{"error":"A storage test is already running."}` (`admin.go:74-77`). No queueing.
- 30 s budget (`admin.go:79`); no request body is read.
- Scratch key `_probe/<ULID>.json` (`ProbePrefix = "_probe/"`, `admin.go:68`) — the **only** place
  the app deletes anything (`internal/docs/decisions` note, `plan.md` Storage).
- Six steps, each timed, in order (`admin.go:92-155`):
  1. `create (only if absent)` — create-only conditional put of `{"probe":true}`; remembers the ETag.
  2. `head` — stat; a different ETag than the write → `head returned a different ETag than the write`.
  3. `get` — read back; different bytes or ETag → `read back different content or ETag`.
  4. `refuse stale write` — write `{"probe":2}` with the current ETag (remembers the new ETag), then
     write `{"probe":3}` with the **stale** ETag. `ErrPrecondition` = pass; an accepted write →
     `a write with a stale ETag was accepted; concurrent edits could be lost`; any other error is
     reported as-is; a failure of the setup write → `setup write failed: <err>`.
  5. `write with current ETag` — `{"probe":4}` with the ETag from step 4.
  6. `delete` — delete, then stat; still there → `object still there after delete`.
- Skip/failure semantics: after the first failure every later step is recorded as
  `{"name":…,"skipped":true}` with **no** `ok` and no `ms` (`ok:false` on the wire, `admin.go:92-96`).
  Exception: once the create succeeded (`etag != ""`) the failure flag is reset before the delete
  step, so cleanup runs even after a failure (`admin.go:144-146`).
- `ok` = every step's `ok` is true (`admin.go:156-161`) — so a skipped step also makes the whole
  probe `ok:false` (asserted, `server_test.go:634-645`).
- Always 200 with the result; the response body is `{"ok","key","steps":[…]}`.
- `admin.go:82` logs `storage test` with `by, ok, key`.
- Asserted behaviours: six passing steps and the scratch object gone
  (`server_test.go:588-598`); a denied `DeleteObject` → 5 ok, step 6 fails with `AccessDenied`, 200
  and `ok:false` (`:600-632`); storage that ignores `If-Match` → step 4 fails, step 5 skipped,
  step 6 still runs and cleans up (`:634-645`).
- Port note: the TS store throws `PreconditionError`/`NotFoundError`
  (`app/src/objstore/store.ts:20-46`) and its `put` rejects `""` as an `ifMatch` — use `null` for
  create-only (`decisions.md` · Object store). Wrap a `tryLock`-style mutex (the entries service
  already has that pattern, `app/src/entries/service.ts:57-95`).

### 6.3 Telegram view, allowlist, check-in — `admin.go:167-231`

**`GET /api/admin/telegram`** returns `telegramView` (§1.4). With no bot (T2) it is exactly
`{"status":{"tokenSet":false,"running":false,"rejected":[]},"allowlist":{…},"checkin":{"noBot":true,"setting":{…}}}`.
**The token must never appear** — not in `status`, not in a log line. `Status.TokenSet` is the
only exposure (`internal/telegram/bot.go:110`); asserted by `server_test.go:741-757` which greps
both responses and the log buffer for the token and for `AAsecret`.

**`PUT /api/settings/telegram`** (`admin.go:190-201`): decode `settings.TelegramInput` →
`SaveTelegram` → the same `telegramView` with the **saved** allowlist. Errors: 400 from
`settings.ValidationError` (e.g. `Telegram user IDs must be positive`, `at most 20 Telegram users`,
`duplicate …` — texts in `settings-spec.md` §4), 409 settings conflict, 500. `useEnv:true` deletes
the section and falls back to `TELEGRAM_ALLOWED_IDS`/`TELEGRAM_ALLOWED_CHATS`
(`internal/settings/telegram.go:192-215`).

**`PUT /api/settings/checkin`** (`admin.go:203-215`): decode `settings.CheckinInput` →
`SaveCheckin` → the same `telegramView` (the check-in's `setting` reflects the save; the `on/at/
chat/last` fields still come from the bot, which is absent in T2 → `noBot:true` plus the saved
setting). 400 texts include `Pick a time` cases and `the check-in time must be before 20:00`
(`settings/checkin.go:61-71`, `server_test.go:715-739`). Saving one section must not clobber the
other (asserted, `:733-739`) — that is the settings service's job, not the server's.

`checkinView` (`admin.go:177-184`): `v := s.Bot.CheckinStatus(ctx)`; when nil →
`&CheckinView{NoBot:true}`; then **always** `v.Setting = s.Settings.ViewCheckin(ctx)`. So the
setting is editable even with no bot — a `check.mjs` requirement (`:264-320` writes the check-in
through this route and reads `checkin.setting.schedule` back).

In T2 the server has no `Bot`: implement `status()` and `checkinStatus()` as the **no-bot**
answers above (a `{ tokenSet:false, running:false, rejected: [] }` constant and
`{ noBot:true }`), with the bot wiring arriving in T4. Do not invent a fake `running`.

### 6.4 Documents — `docs.go`

**`GET /api/docs`** (`docs.go:41-50`) → `docsView` (§1.4). With the syncer absent
(`s.Docs == nil`) the body is `{"on":false,"running":false,"docs":[]}` and the status is 200
(asserted, `docs_test.go:19-27`). `lastSync` is omitted when the index has none. An index read
failure goes through `fail()` → 500 `That change didn't save. Try again.` (odd text, but it is what
Go sends).

**`POST /api/docs/sync`** (`docs.go:52-66`):

```go
if s.Docs == nil { writeErr(w, 404, "Documents are not switched on."); return }
joined := s.Docs.Running()
go func() { _, err := s.Docs.Sync(context.WithoutCancel(r.Context()), "web") … }()
s.Log.Info("document sync requested", "by", user, "joined", joined)
writeJSON(w, http.StatusAccepted, map[string]any{"started": !joined, "joined": joined})
```

- **202 Accepted**, body `{"joined":false,"started":true}` for a fresh sync or
  `{"joined":true,"started":false}` when one is already running (alphabetical key order).
- The sync runs **detached**: `context.WithoutCancel` means a client disconnect does not stop it.
  The response is written without waiting for the run.
- The result reaches the page over SSE `docs` (§3.2), never in this response.
- Two POSTs: the second joins the in-flight run, the converter runs once
  (`docs_test.go:29-95`, `conv.CallCount() == 1`).
- Reason string `"web"` ends up in `lastSync.reason` and in the page's status line
  (`/Last sync .*\(web\): no changes/`, `check.mjs:330`).

### 6.5 The guide — `GET /api/admin/guide` (`admin.go:217-231`)

- `s.Guide == nil` → 404 `{"error":"no admin guide in this build"}`.
- `s.Guide()` error → `WARN admin guide unreadable` + 500 `{"error":"The admin guide could not be read."}`.
- Success: `Content-Type: text/markdown; charset=utf-8`, `Cache-Control: no-cache`, then the raw
  bytes (`w.Write(b)`, **no** trailing newline added, no JSON encoding).
- Production reads it from the embedded copy (`//go:embed docs/admin-guide.md`, `web.go:13-14`, `:26`,
  `main.go:109`); dev (`STATIC_DIR` set) reads `<static dir>/../docs/admin-guide.md` from disk on
  **every request** (`main.go:110-116`) — live edits, no caching.
- `static/guide.html` fetches this route and renders the Markdown client-side
  (`static/guide.html:144-151`); `check.mjs` asserts four headings from the real file
  (`server_test.go:758-791`). So the TS app must ship `docs/admin-guide.md` (T2.3 copies `static/`,
  and the embed equivalent is a build-time read).
- Behind auth like everything else: no header → 401 (`server_test.go:783-785`).

**There is no docs page/image route** (§1.2): `docs.Viewer` is agent-only (T3.3).

---

## 7. Every Go test in `internal/server`

Three files, 28 tests. "Owns" is the T2 step that must carry the ported test; **T3** marks tests
that need the agent, the LLM client or the chat route and therefore cannot pass in T2.

Shared harness, which the TS tests must mirror (`server_test.go:100-198`): `fakeLLM` is an
`httptest.Server` answering `/v1/models` (`model-b`, `model-a`, deliberately unsorted) and
`/v1/chat/completions` (tool call for "move in", plain text otherwise, SSE when `stream:true`), and
recording every `Authorization` header and model name; `setup()` wires an in-memory or S3 store, a
generated Fernet key, env LLM `…/v1` + `env-model` + `streaming:false`, `AuthHeader`
`X-Forwarded-Email`, `AllowedEmails` `{zy@example.com, partner@example.com}`, `SSEHeartbeat` 50 ms
and a two-file `fstest.MapFS` (`index.html` with the title "Our new place", `icon.svg`); `e.do()`
sends `X-Forwarded-Email: zy@example.com` unless a header pair overrides it, and returns
`(status, decoded map, raw body)`.

### `server_test.go`

| Line | Test | Asserts | Owns |
|---|---|---|---|
| `:176` | `TestHealth` | `/healthz` and `/readyz` answer 200 **without** an auth header | T2.1 |
| `:186` | `TestAuth` | 401 without header; 403 for a stranger on `/api/entries` **and** on `/`; `Partner@Example.com` passes (case-insensitive); `/icon.svg` needs no auth; `GET /` serves the HTML title | T2.1 (+ T2.3 for the page body) |
| `:208` | `TestDevEmailFallback` | an empty header + `DevEmail` authenticates, and a created entry is stamped `by:"zy@example.com"` | T2.1 |
| `:216` | `TestRESTCRUD` | the full CRUD walk, on both stores: 201 with `by/channel:"web"/status:"todo"` and a non-empty `etag`; the **exact** change line `Saved: task · Book movers · Fri, 20 Nov 10:00 · est $1,200`; 400 for empty title, `date:"tomorrow"`, `room:"garage"`; PATCH by the partner restamps `by`; PATCH unknown id 404; `PUT /api/meta` 200 and 400 for `"5 Dec"`; list has 1 entry; DELETE 200 with 0 entries and a change id; DELETE twice 404; undo delete 200 → 1 entry and text starting `Undone:`; the same undo again 409 **with** `doc`; unknown change 404 | T2.1 |
| `:310` | `TestConflictReturns409WithLatestDoc` | `MaxRetries+1` lost conditional puts → 409, `error` exactly `Someone else just changed this. Showing the latest.`, non-nil `doc` (`conflictStore` fake) | T2.1 |
| `:322` | `TestSSEBroadcastsWrites` | `Content-Type: text/event-stream`; first `data:` decodes to an empty doc; a POST produces an `entries` event with the new entry within 5 s | T2.1 |
| `:361` | `TestChatToolLoop` | streaming and non-streaming chat, tool loop, change text `Move-in set to Sat, 5 Dec`, tool-call log line | **T3** |
| `:407` | `TestChatForcedAnswerWhenModelKeepsCallingTools` | a model that never stops calling tools still gets a text answer | **T3** |
| `:418` | `TestSettingsKeyNeverLeaks` | save/view/test/models/chat bodies and every log line are free of the stored and env key; the endpoint received `Bearer <stored key>`; `settings.json` holds `apiKeyEnc` and not the key; `keySet/keyLast4/by` in the view; an empty `apiKey` keeps the key; `clearKey:true` falls back to the env key (`keyFromEnv`, last4 `aaaa`) | T2.2 |
| `:481` | `TestSettingsEnvFallbackAndBounds` | the view shows the env model with `keyFromEnv:true`; 400 for `baseUrl:"ftp://x"`, `model:""`, `kind:"gpt"`; a corrupt `settings.json` still answers 200 with the env model | T2.2 |
| `:511` | `TestModelSwitchTakesEffectNextMessage` | saving a new model changes the very next chat call, no restart | **T3** (chat) |
| `:528` | `TestSettingsTestEndpoint` | `/test` → 200, `ok:true`, `toolCalls:true`, two models; without `tool_calls` → `ok:false` and an `error` containing `tool_calls`; the test never saves | T2.2 |
| `:557` | `TestStorageAdmin` | storage view has `backend`, S3 has bucket + `credentialSource:"env keys"`; `lastWrite` is `entries.json` and advances by ≥1 s after a write; key values never appear; probe 200 `ok:true` with 6 steps and the scratch object gone | T2.2 |
| `:600` | `TestStorageProbeReportsDeniedDelete` | `DeleteObject` denied → 200, `ok:false`, steps 1–5 ok, step 6 error contains `AccessDenied` | T2.2 |
| `:634` | `TestStorageProbeCatchesIgnoredConditions` | storage that accepts a stale ETag: step 4 fails, step 5 `skipped:true`, step 6 ok, scratch object still cleaned up | T2.2 |
| `:647` | `TestTelegramAdmin` | no bot: `tokenSet:false, running:false`, allowlist `fromEnv:true` and empty, `checkin.noBot:true` **with** a `setting`; save 2 users + a group → `fromEnv:false`, `by`; the bot would read the saved list without a restart; `{"id":"-5"}` → 400 containing `positive`; `useEnv` restores `fromEnv:true` | T2.2 |
| `:678` | `TestTelegramAdminCheckinStatus` | with a bot but no check-in: `on:false`, `setting.schedule:"09:30"`, `fromEnv:true`; with a check-in and no target: `on:true, at:"09:30", until:"20:00"`, an `error` containing `no group or person`, `last:null`; with a group and a sent record: `chat:"-1001"`, `last.day/last.status` | T2.2 for the no-bot half; the rest needs the Telegram domain (**T4**) — in T2 keep the assertions that only need `setting` |
| `:715` | `TestCheckinSettingThroughTheAPI` | `{"schedule":"8:05"}` → `08:05`, `fromEnv:false`, `by`; 400 for `21:00`, `9am`, `chat:"group"`; `useEnv` → `09:30`/`fromEnv:true`; saving the check-in and the allowlist does not clobber the other | T2.2 |
| `:741` | `TestTelegramAdminNeverShowsToken` | with a real-looking token: GET and PUT bodies and the log buffer never contain it, `tokenSet:true` | T2.2 |
| `:758` | `TestAdminGuide` | 200, `Content-Type` prefix `text/markdown`, four headings of the real guide, 401 without auth, 404 when `Guide` is nil | T2.2 (+ T2.3 for the file) |
| `:793` | `TestStoredKeyOnlyGoesToItsOwnEndpoint` | models for another host gets **no** `Authorization`; `/test` at another host without a typed key gets none; a typed key is sent; `{}` still uses the stored key at its own origin; `GET …/models?baseUrl=` fails; saving another host without a key drops it so chat sends nothing there | T2.2 |
| `:867` | `TestSettingsConflictHasItsOwnMessage` | 409, `doc` absent, body contains `settings were changed` | T2.2 |
| `:875` | `TestPageNeverReceivesTheJournal` | no response contains `"changes"` and every one contains `"entries"`; the write response still carries `"change":{"id":"…"`; `If-None-Match` with the current ETag → 304 and no body | T2.1 |
| `:906` | `TestChatInputErrorsAre400` | a bad `turns` body → 400; a dead endpoint → 502 | **T3** |

### `docs_test.go`

| Line | Test | Asserts | Owns |
|---|---|---|---|
| `:19` | `TestDocsOff` | `GET /api/docs` → 200 `on:false`; `POST /api/docs/sync` → 404 | T2.2 |
| `:29` | `TestDocsListSyncAndEvent` | SSE client first; sync → 202 `started:true`; a second POST 30 ms later → 202 `joined:true`; one `docs` event with `on:true`, 2 docs (the `._` file too), `running:false`; converter ran once; `GET /api/docs` has `folder:"4.0 Manuals"`, `status:"ok"`, `class:"text"`, `lastSync.reason:"web"` | T2.2 (the sync engine itself is T1.5/T5.2) |

### `claude_settings_test.go`

| Line | Test | Asserts | Owns |
|---|---|---|---|
| `:54` | `TestClaudeKindThroughTheAPI` | v1 only: claude models/test/save through a fake Anthropic endpoint, key stays with its origin, `kind:"gpt"` → 400. **Deleted in v2**; replace with: `POST /settings/llm/models {"kind":"claude"}` → 400 `Claude connections are no longer supported; …`, same for `/test` and `PUT`, and no `claudeOrigin` in `GET /api/settings/llm` | T2.2 |
| `:109` | `TestThinkStrippedFromEveryWebTurn` | `/think` is stripped from every user turn and only the newest turn decides `enable_thinking` | **T3** |

### Fakes to port with the tests

`conflictStore` (`:296-308`, loses the first *n* conditional puts), `denyDelete`
(`:557-564`, `Delete` → 403 `AccessDenied`), `staleAccepted` (`:600-616`, rewrites the ETag on
`_probe/` writes), `alwaysConflictSettings` (`:860-866`, every `settings.json` put is a 412), and
`fakeLLM` (`:27-98`). In TS these are small `ObjectStore`/`Service` wrappers around the in-memory
implementations, exactly as `app/src/objstore/memory.ts` allows.

---

## 8. Server startup wiring — `cmd/movin/main.go`

### 8.1 Commands (`main.go:37-71`)

`movin [serve|healthcheck|init-bucket|seed FILE]`; `serve` is the default. `healthcheck`
(`:207-224`) reads `LISTEN_ADDR` (default `:8080`, `:8080` → `127.0.0.1:8080`), `GET
http://<addr>/healthz` with a 3 s client timeout, exit 0 only on 200. It is the Docker
`HEALTHCHECK` (`Dockerfile:56`) and the k8s liveness exec (`deploy/k8s/base/deployment.yaml:44-45`).
`init-bucket` and `seed` are ops commands (T6/T5 territory, not T2).

### 8.2 Construction order in `serve()` (`main.go:75-192`)

1. `config.Load()` — any bad value aborts the process (`:76-79`).
2. JSON slog logger at `LOG_LEVEL` (`:80`, `:73-77`).
3. `signal.NotifyContext(SIGINT, SIGTERM)` → `ctx` (`:81-82`). This same context drives the poller,
   the bot and the docs schedule.
4. S3 store from `S3_BUCKET/S3_PREFIX/AWS_REGION/S3_ENDPOINT_URL` (`:84-87`).
5. `entries.Service` + `SetLocation(TZ)`, `Load` (**failure is only logged**, `:90-93`), then
   `go ents.Poll(ctx, 5s)` (`:94`).
6. `settings.Service` (aborts on a bad `SETTINGS_SECRET`, `:96-99`), then
   `WithTelegramEnv/WithCheckinEnv/WithClaudeBaseURL` (`:100`; the last one goes away in v2), plus
   the two startup warnings for a missing secret and an empty `ALLOWED_EMAILS` (`:101-106`).
7. Static FS + guide func: embedded, or `os.DirFS(STATIC_DIR)` + `../docs/admin-guide.md` when
   `STATIC_DIR` is set (`:108-116`).
8. Documents: one `convert.Poppler`, `docs.Syncer` (with `docs.LLMSummariser{Settings: sets}`),
   `docs.Library`, `docs.Viewer` (`:117-122`).
9. `agent.Runner` (`:123`) — the server only needs it for `POST /api/chat` and for `ChangeText`
   (§1.4); T2 should not construct it.
10. Telegram bot only when `TELEGRAM_BOT_TOKEN` is set (`:124-138`); its `Checkin` store and the
    `syncer.Notify = bot` hook live here. Otherwise `bot` is nil and the server sees the no-bot
    paths of §6.3.
11. `server.Server{Entries, Settings, Store, Static, Log, Agent, Bot, Docs, Guide, AuthHeader,
    AllowedEmails, DevEmail}` (`:139-143`) — note `SSEHeartbeat` is left 0 for the 25 s default.
12. `http.Server{Addr: LISTEN_ADDR, Handler: srv.Handler(), ReadHeaderTimeout: 10s,
    IdleTimeout: 120s}` and **no** `WriteTimeout` (`:144-150`).
13. `RegisterOnShutdown(srv.CloseStreams)` (`:154`).
14. A goroutine waits on `ctx`, then `hs.Shutdown(10 s budget)`, warning if it does not finish, and
    closes `shutdown` (`:155-164`).
15. `net.Listen("tcp", LISTEN_ADDR)` (`:169`) — the listen address is **`127.0.0.1:8080` by
    default** so only the oauth2-proxy sidecar can reach it; a non-loopback address logs a warning
    (`:165-167`), and `log.Info("listening", addr, bucket, prefix, authHeader, devEmail)` follows
    (`:168`).
16. Only **after** the listener is up do the background jobs start: the docs schedule
    (`syncer.Background(ctx, DOCS_SYNC_SCHEDULE, TZ)`, `:175-179`) and the check-in loop
    (`bot.CheckinLoop(ctx, 1m)`, `:180-182`) — so readiness and the page never wait for a sync.
17. `hs.Serve(ln)`; `http.ErrServerClosed` is the normal exit (`:183-185`).
18. After `shutdown` closes: `bot.Wait(15s)` (warns when a Telegram turn was cut short), then
    `log.Info("stopped")` (`:186-190`).

Shutdown order matters for T2: **stop accepting, end SSE streams, let in-flight requests finish,
then stop the rest**. In Node the equivalent is: `server.close()`, then for each open SSE response
`res.end()` and clear its timers, then `await` the close promise with a 10 s timeout.

### 8.3 Env vars the HTTP layer reads

| Var | Default | Used for |
|---|---|---|
| `LISTEN_ADDR` | `127.0.0.1:8080` | listen address; compose sets `:8080`, k8s `127.0.0.1:8080` |
| `AUTH_HEADER` | `X-Forwarded-Email` | §2.1 |
| `ALLOWED_EMAILS` | empty (allow all) | §2.1 |
| `DEV_EMAIL` | empty | §2.1 dev bypass |
| `STATIC_DIR` | empty (embedded) | static + guide from disk (§2.5) |
| `LOG_LEVEL` | `info` | suppresses the DEBUG request lines |
| `TZ` | `Asia/Singapore` | entry `completed` day, check-in/sync schedules; the Go image also imports `time/tzdata` for distroless |
| `S3_BUCKET` (required), `S3_PREFIX`, `AWS_REGION` (`ap-southeast-1`), `S3_ENDPOINT_URL` | | store + storage view + `readyz` |
| `SETTINGS_SECRET` | empty | key storage; a bad value aborts startup |
| `TELEGRAM_BOT_TOKEN` | empty | bot on/off → the `telegramView` shape (§6.3) |
| `DOCS_SYNC_SCHEDULE`, `CHECKIN_SCHEDULE`, `CHECKIN_CHAT`, `TELEGRAM_ALLOWED_IDS`, `TELEGRAM_ALLOWED_CHATS` | defaults | surfaced through the admin views |
| `LLM_BASE_URL`, `LLM_KIND`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_STREAMING`, `LLM_THINK_ON_DEMAND` | | the env layer under `settings.json` (§5) |
| `LLM_CLAUDE_BASE_URL` | — | **removed in v2** |
| `GOMEMLIMIT` (k8s) | — | Go only; the TS port uses `NODE_OPTIONS` (`plan.md` Deploy) |

`config.Load` also refuses to start on: missing `S3_BUCKET` (`config.go:71-73`), an unknown `TZ`,
a bad `LLM_KIND` (v2: `claude` is the failure, `app/src/config.ts:1-5`), a bad
`LLM_STREAMING`/`LLM_THINK_ON_DEMAND`, a bad `DOCS_SYNC_SCHEDULE` or `CHECKIN_SCHEDULE`, and a bad
`TELEGRAM_ALLOWED_IDS`/`CHATS`. Those messages are the TS `loadConfig` contract already
(`app/src/config.ts`).

---

## 9. Traps for a Node port

1. **`http.Error` is not `writeErr`.** `http.Error` (`$GOROOT/src/net/http/server.go:2377-2395`)
   sets `Content-Type: text/plain; charset=utf-8`, `X-Content-Type-Options: nosniff`, **deletes any
   `Content-Length`**, writes the status and then `Fprintln` — so the body has a **trailing `\n`**
   (`ok\n`, `Not signed in.\n`, `S3 not reachable\n`, `This page is private. <email> is not on the
   list.\n`). Every JSON error goes through `writeErr` instead: `application/json`, no `nosniff`,
   no trailing newline except the encoder's. Only three places use `http.Error`: `auth` (401/403),
   `readyz` (503) and Go's own 405/404 handler (which this app never reaches, see 5).
2. **`json.NewEncoder(w).Encode` appends `\n`.** Every JSON body this server writes ends with exactly
   one newline — including the `{"models":…}` and `{"started":…}` map bodies. The SSE path uses
   `json.Marshal` and therefore does **not** (`server.go:368-375`). In TS the equivalent of
   `writeJSON` is `res.end(goMarshal(v) + "\n")`.
3. **HTML escaping in JSON.** Go's encoder escapes `<`→`\u003c`, `>`→`\u003e`, `&`→`\u0026`,
   U+2028/2029. Entry titles and notes are free text, so `"Paint & seal"` goes out as
   `"Paint \u0026 seal"`. `JSON.stringify` does not, so **use `goMarshal` from
   `app/src/gojson.ts`** for every response body and every SSE payload. The browser does not care
   (`JSON.parse` decodes both), but byte-diff tests against Go, and any cache/IF-None-Match
   comparison treating the body as a string, do.
4. **Map bodies come out alphabetically sorted.** `json.Marshal` sorts map keys, so the conflict
   body is `doc,error,etag` (not `error,doc,etag`), the sync answer is `joined,started`, the model
   list is a single key, and the chat error body is `changes,error,model`. Struct bodies keep struct
   order (§1.4). If the port emits objects in a different key order it is still correct HTTP; only
   `goMarshal` on an `Ordered` or an explicitly ordered literal gives byte equality — do it, because
   `docs/movin-v3` treats byte equality as the cheap way to diff the two apps.
5. **`ServeMux` semantics: no 405 in this app, and a method-less `/` is why.** Go 1.22+ matches
   method-specific patterns first and falls back to patterns **without** a method
   (`routing_tree.go:132-148`), and `HEAD` is served by the `GET` pattern (`:140-145`). Because the
   `api` mux registers `api.Handle("/", s.static())` (`server.go:100`), every method mismatch
   (`PUT /api/entries`, `GET /api/settings/llm/models`, `POST /api/meta`, …) matches that catch-all
   and becomes the static handler's answer: **404 `{"error":"no such endpoint"}` for anything under
   `/api/`, and for anything else whatever the file server makes of the path** — the file if it
   exists (`/index.html` redirects, `/guide.html` serves), otherwise Go's plain
   `404 page not found\n` (`text/plain`, with `nosniff`). Never a 405, never an `Allow` header. The
   same at the root: `/healthz` is `GET /healthz`, so `POST /healthz` lands on `auth(api)` → the
   catch-all → `404 page not found` behind auth, while `POST /` returns `index.html`. Reproduce the
   catch-all as an explicit fallback, not with Node's default 404.
6. **Path handling inside the mux.** Go cleans the path before matching and redirects when the raw
   path differs (`//api//entries`, `/a/../b`) with a 301 to the cleaned path; a wildcard `{id}`
   matches **one** non-empty segment and is percent-decoded (`r.PathValue` unescapes). So
   `DELETE /api/entries/a%2Fb` matches with id `a/b`, while a literal `/` in the id does not match.
   The page always sends `encodeURIComponent(id)` (`static/index.html:597-623`) — the TS router must
   `decodeURIComponent` each segment exactly once.
7. **`/index.html` and trailing slashes.** `GET /index.html` → **301 `Location: ./`** (Go's
   `serveFile`), `GET /` → 200 `index.html`, `GET /api/entries/` → JSON `404 no such endpoint`,
   `GET /healthz/` → plain `404 page not found`. Do not "fix" the redirect: a `<link rel=manifest>`
   or a bookmark may hit it.
8. **Static files: no ETag, no `Last-Modified` from the embedded FS.** With the embedded copy Go has
   a zero modtime, so `If-Modified-Since`/`If-None-Match` never produce a 304; `Cache-Control:
   no-cache` forces revalidation, so every load re-downloads 88 KB. With `STATIC_DIR` (dev) the real
   mtime is sent and 304s work. Content types are extension-based (§2.5); `.webmanifest` gets
   `text/plain; charset=utf-8` in the alpine image. Node's `fs.readFile` + a hand-written header is
   fine; do not add an ETag "improvement" (it changes what `check.mjs` and the page's service-worker
   logic — there is none — would see, and it diverges from Go).
9. **`304` must have no body and must keep the `ETag` header** (`server.go:239-243`): set `ETag`,
   `WriteHeader(304)`, return — no `Content-Type` at all. Node happily writes a body on a 304 if you
   let it; send `res.writeHead(304, {ETag}); res.end()`.
10. **Body limit: 400, not 413** (§1.3). And the message embeds Go's error text:
    `Request body must be JSON: http: request body too large`. Also, after an oversize body Go
    **closes** the connection (`requestTooLarge`), so a client retrying on the same keep-alive socket
    is not a thing the port needs to support — but Node should also stop reading and destroy the
    request stream, or the peer's remaining bytes are parsed as a new request.
11. **An empty body is an error** on every route that decodes: `400` with `… : EOF`
    (`json.Decoder` returns `io.EOF`). Do not turn "no body" into "empty object": `PUT
    /api/settings/telegram` with no body must be 400 (the page always sends one).
12. **`json.Decoder` is not `JSON.parse`.** It accepts one value and ignores the rest, accepts
    duplicate keys (last wins), rejects trailing commas/comments, and its messages are the ones in
    the body (`json: cannot unmarshal string into Go value of type entries.Patch`, `invalid
    character 'x' looking for beginning of value`, `unexpected EOF`). The status and the prefix
    `Request body must be JSON: ` are the contract; the tail is Go's. See §10 for the decision.
13. **Change lines are asserted verbatim.** `agent.ChangeText` (`internal/agent/tools.go:355-372`)
    produces `Saved: <Summary>`, `Deleted: <title>`, `Undone: removed|restored|()`… and the page
    shows it in the banner, with the `change.id` behind an Undo button. `check.mjs:179` feeds
    `Saved: flex · note · test` into the renderer and expects exactly one Undo button. `Summary`
    (`tools.go:309-342`) is a `·`-joined list: room, kind, title, `Fri, 20 Nov 10:00`, `est $1,200`,
    `paid $5,400`, vendor, `done 20 Nov`, `★ milestone` — port it exactly (it also drives the
    Telegram replies).
14. **`omitempty` everywhere.** `entry`/`change` vanish from `entryResp`; `ChangeLine.ID` vanishes
    for a non-journaled change; `keyLast4`, `updated`, `by`, `claudeOrigin` (gone), `models`,
    `modelsError`, `error`, `skipped`, `botUsername`, `lastPollAt`… all vanish when empty/zero;
    `room`, `date`, `time`, `completed`, `milestone` are pointers. `lastWrite` is the exception:
    present as `null`. `tags` is `[]`, never null. `users`/`groups`/`rejected`/`docs` are `[]`.
15. **Timestamps.** `lastWrite.at`, `lastPollAt`, `lastUpdateAt`, `lastErrorAt` and `Rejected.at`
    are Go `time.Time` → RFC 3339 **with** milliseconds and `Z` (`2026-11-21T03:04:05.678Z`). Entry
    `created/updated/completed` and `lastSync.at` are strings the services produce (second
    precision, `…:00Z`) — do not re-format them (§`entries-spec.md`, `docs-spec.md` §9 item 5).
16. **SSE: three headers, then flush, then only `event:`/`data:`/comments.** No `id:`, no `retry:`,
    `\n` line endings, one blank line after each event, `: ping\n\n` for the heartbeat, and
    `Accept` is not consulted (`EventSource` sends `text/event-stream`, nothing checks it). The
    first `entries` event must arrive **before** the first heartbeat, and the stream must never be
    buffered: `res.writeHead(200, {…, "X-Accel-Buffering": "no"}); res.flushHeaders();`.
    `Last-Event-ID` is ignored (§3.4) — do not implement resume, it would double-send snapshots.
17. **Client disconnect cleanup.** Go gets it from `r.Context().Done()`; Node gets
    `req.on("close")`/`res.on("close")`. Both subscriptions and the 25 s timer must be released, and
    writes after close must not throw unhandled (`res.write` returns false / emits `error`). A
    leaked timer per reload is the classic bug here: the page reloads in `check.mjs` several times.
18. **Header case and lookup.** Go's `r.Header.Get("X-Forwarded-Email")` is case-insensitive; Node's
    `req.headers` is already lowercased, but the configured name comes from `AUTH_HEADER` and may be
    mixed case — look it up as `req.headers[config.authHeader.toLowerCase()]`. Multiple header
    values: Node joins them with `, `; Go's `Get` returns the first. (Not reachable via
    oauth2-proxy, which sets exactly one.)
19. **`TryLock`, not `Lock`, on the storage probe** (`admin.go:74-77`): a second concurrent request
    gets 409 immediately; it must not queue (a queued request would hold the connection for up to
    30 s and the page's spinner would be wrong).
20. **`POST /api/docs/sync` answers before the work** and must not be tied to the request's
    cancellation: Node's `req`/`res` are not a context, so simply do not pass any abort signal into
    the sync — and be careful that a `res.on("close")` handler does not cancel it.
21. **`GET /api/settings/llm/models` must not work** (§2.2). If the TS router is written with a
    permissive "any method" fallback for convenience, this regression is silent and the key-leak
    test loses its teeth.
22. **`Content-Length` and HEAD.** Go buffers small JSON bodies and sends `Content-Length`;
    `res.end(body)` in Node does the same. For `HEAD`, Node drops the body automatically (Go does
    too), so a `GET /api/entries` HEAD returns the headers including `ETag` and no body — no special
    code needed, but do not throw when `req.method === "HEAD"`.
23. **Do not compress.** Adding gzip/brotli for `index.html` would change `Content-Length`, add
    `Content-Encoding: vary`, and (if applied to `/api/events`) break the stream. Go has none (§2.4).
24. **Logging shape.** Request lines are DEBUG, message `request`, fields `method, path, status,
    ms`, and `/healthz`/`/readyz` are never logged (§2.3). The admin log lines (`entry deleted`, `LLM
    settings test`, `storage test`, `document sync requested`) are asserted indirectly by the
    key-leak and tool-call tests — keep the messages and field names, never include a key or a token.

---

## 10. What I could not determine

- **Go `encoding/json` error texts in 400 bodies.** `decode` forwards them verbatim (§1.3, §9.12).
  A TS port cannot reproduce `json: cannot unmarshal string into Go value of type entries.Patch`
  without a Go-compatible decoder. Nothing in the repo asserts the tail (`server_test.go` checks
  statuses only; `check.mjs` never reads it), so the pragmatic choice is: keep the prefix
  `Request body must be JSON: ` and use a short, stable description of your own; record the
  difference in the step notes. Do not spend T2 on a JSON-error-text emulator.
- **The `text/plain` content type for `manifest.webmanifest`.** It depends on whether the runtime
  image has `/etc/mime.types` (Go's `mime.TypeByExtension` consults it on Unix). I did not build or
  run the image. `curl -sI` against a running Go app on `:8090` answers it in one command; decide
  there and write the answer into the brief's amendment.
- **The exact bytes of `probePNG`.** Read from `server.go:558-559` (70 bytes, a 1×1 red PNG); I did
  not decode it to verify, and only endpoint acceptance matters, so copying the Go literal (or any
  valid 1×1 PNG) is equivalent.
- **`check.mjs:193` asserts `li.ok` count 7 for a six-step probe.** The extra element must be the
  page's own summary line (client-side); the server returns exactly six `steps` (asserted by
  `server_test.go:590-592`). I did not open the page's storage-test renderer to confirm which element
  it is, so treat "six steps from the server" as the contract and re-check the page count in T2.3.
- **Whether the browser or oauth2-proxy ever sends an `Origin` header on the page's `fetch` calls**
  (it does for cross-origin only) — irrelevant because nothing checks it, but it means a future
  origin check would need a request log to calibrate.
- **Node's exact default timeouts** (`requestTimeout` 300 s, `headersTimeout` 60 s,
  `keepAliveTimeout` 5 s) in Node 24 — I did not run Node to confirm the current defaults; the plan
  requires long-lived SSE responses, so set them explicitly in `main.ts` rather than relying on
  defaults, and record the values.
- **Whether any client besides the page and `check.mjs` calls these routes** (a script, a bookmarklet,
  the old `cmd/chateval`). `cmd/chateval` calls the services in-process, not HTTP
  (`cmd/chateval/main.go:398-409`), and no other HTTP client exists in the repo — but I did not
  search ZY's machine or the `zy-ops` repo.
