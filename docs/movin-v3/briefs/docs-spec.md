# Spec: Go `internal/docs` (+ `internal/docs/convert`) — porting reference for the TS rewrite

Produced by code-explorer on 2026-11-21 from the frozen Go code. Line numbers are from that tree. Where this file and the Go source disagree, the Go source wins; report the difference.

Package map: `internal/docs/{index,sync,schedule,search,summary,render}.go` (package `docs`), `internal/docs/convert/{convert,poppler,fake}.go` (package `convert`, imports `docs`). The Go app and the TS app share one bucket and the same `docs/**` keys, so every byte format, key and user-visible string below is a compatibility rule.

## 1. S3 layout under `docs/`

No key prefix inside the app (`index.go:19-25`); the bucket's own `S3_PREFIX` is applied by the store (`internal/objstore/s3.go:57`).

| Key | Written by | Format |
|---|---|---|
| `docs/raw/<path>.pdf` | ZY (S3 console) | source of truth; never written or deleted by the app |
| `docs/index.json` | sync, conditional `Put` (content type `application/json`, `s3.go:82`) | pretty JSON, 2-space indent, **no trailing newline** (`index.go:238`) |
| `docs/text/<same path as raw>.json` | sync, unconditional `PutBlob`, content type `application/json` (`sync.go:437`) | **compact** JSON (`json.Marshal`, `sync.go:433`) |

`TextKeyFor` = `"docs/text/" + strings.TrimPrefix(rawKey, "docs/raw/") + ".json"` (`index.go:116-118`). Raw text is never deleted: the text of a removed PDF stays until someone deletes it by hand.

### `docs/index.json` (`Index`, `index.go:56-95`)

Field order = JSON byte order; `omitempty` exactly as listed:

| # | Field | JSON | Type | Notes |
|---|---|---|---|---|
| 1 | Schema | `schema` | int | always written as `1` (`index.go:235`); no omitempty |
| 2 | Docs | `docs` | Doc[] | no omitempty; nil → `[]` on decode; sorted by `key` (byte order) on encode |
| 3 | LastSync | `lastSync` | Sync, `omitempty` | pointer; set to the run's result at `sync.go:336` |
| 4 | Updated | `updated` | string, `omitempty` | RFC3339 UTC, second precision (`index.go:236`) |

`Doc` (`index.go:64-82`), in order:

| # | Field | JSON | Type | omitempty | Meaning |
|---|---|---|---|---|---|
| 1 | ID | `id` | string | no | first 8 hex of SHA-256(key), `-2`, `-3` on collision (`index.go:202-213`) |
| 2 | Key | `key` | string | no | full bucket key `docs/raw/...` (the identity) |
| 3 | ETag | `etag` | string | no | the raw PDF's ETag, **verbatim as S3 returns it (quoted, e.g. `"6a1b…"`)** |
| 4 | Size | `size` | int | no | bytes, from the listing |
| 5 | Pages | `pages` | int | yes | page count from the last good read |
| 6 | Class | `class` | string | yes | `text` \| `drawing` \| `scanned` (`index.go:29-32`) |
| 7 | Status | `status` | string | no | `ok` \| `failed` \| `removed` \| `skipped` (`index.go:36-40`) |
| 8 | Reason | `reason` | string | yes | why skipped/failed |
| 9 | TextPages | `textPages` | int | yes | pages with ≥ `MinTextChars` (100) non-space chars |
| 10 | Summary | `summary` | string | yes | one line from the model |
| 11 | SyncedAt | `syncedAt` | string | yes | RFC3339 UTC; the run's `at` |
| 12 | Version | `v` | int | yes | `ConvertVersion` it was read with (now **3**, `index.go:45`) |
| 13 | RemovedAt | `removedAt` | string | yes | RFC3339 UTC of the run that saw it gone |
| 14 | Error | `error` | string | yes | last failed *re-read* of a document that is still `ok` |
| 15 | ErrorAt | `errorAt` | string | yes | when that happened |

`Sync` (`index.go:85-95`): `at` (no omitempty), `reason`, then `added`, `changed`, `removed`, `failed`, `skipped` (no omitempty, so `0` is written), `refreshed` (omitempty), `error` (omitempty). `Changes()` = `added+changed+removed > 0` (`index.go:98`) — failed/skipped/refreshed are not "changes".

`Decode` (`index.go:216-231`): empty body → empty index (`Schema:1, Docs:[]`); JSON error → `decode docs/index.json: <err>`; `schema != 1` → `docs/index.json: schema %d, this build reads 1`; nil `docs` → `[]`. **Unknown fields are silently ignored (Go default) and therefore dropped on the next write** — which is exactly why `v` exists (section 2).

`Encode` (`index.go:234-239`) sets `schema`, sets `updated`, sorts `Docs` by `Key` with `sort.Slice` (unstable, but keys are unique), and marshals with `MarshalIndent(ix, "", "  ")`. **Go's HTML escaping is on** (no `SetEscapeHTML(false)` anywhere): `<`→`\u003c`, `>`→`\u003e`, `&`→`\u0026`, U+2028/2029 escaped, in reasons, summaries and errors.

### `docs/text/<path>.json` (`PageText`, `index.go:261-291`)

| # | Field | JSON | Type | omitempty |
|---|---|---|---|---|
| 1 | Key | `key` | string | no |
| 2 | ETag | `etag` | string | no — the raw PDF's ETag this was made from |
| 3 | Pages | `pages` | Page[] | no (`null` if nil; the converter always fills len = page count) |

`Page`: `n` (1-based), `w`, `h` (float64 PDF points, **as displayed**: `/Rotate 90|270` swaps w/h), `text` (string, no omitempty), `words` (`omitempty`, drawings only).
`Word`: `t` (string) and `b` (`[4]float64`, `x0,y0,x1,y1`, origin top-left, in the same rotated space as the renders). `Region` (`index.go:286-291`): `x0,y0,x1,y1` fractions, origin top-left; `Valid()` requires all in [0,1] and width/height > 0.001 (`index.go:294`).

No per-page image is ever stored: renders are on demand (section 5).

## 2. Sync engine (`internal/docs/sync.go`)

**Sources.** Only the bucket listing under `docs/raw/` (`sync.go:240`, `RawPrefix`). Nothing reads local files, mtime, or hashes.

**Triggers** (the `reason` string is stored in the index and shown in the UI/logs):
- `"startup"` — one goroutine at boot (`schedule.go:21-25`), started after the listener is up (`cmd/movin/main.go:176`).
- `"daily"` — timer for `DOCS_SYNC_SCHEDULE` (`schedule.go:54-58`).
- `"web"` — `POST /api/docs/sync` (`internal/server/docs.go:60`), detached with `context.WithoutCancel`.
- `"telegram:<chatID>"` — `/sync` (`internal/telegram/docs.go:50`, prefix at `:14`).
- Also a once-a-minute `Refresh` (not a sync): re-reads the index if the bucket ETag changed (`schedule.go:50-53`, `sync.go:156-178`).

**Types it needs** (`sync.go:16-38`): `Store` = `objstore.Store` + `objstore.Blobs` (`Get`, `Put(ifMatch)`, `Stat`, `Delete`, `List(prefix)`, `PutBlob`); `Converter{ Text(ctx, pdf) ([]Page, error) }`; `Notifier{ DocsChanged(ctx, Sync, []Doc) }`; `Summariser{ Summarise(ctx, Doc, text) (string, error) }`. `Notify` and `Summarise` may be nil. `Log *slog.Logger`, `Now func() time.Time` (injectable for tests).

**Concurrency / single-flight** (`sync.go:75-104`): one run at a time per `Syncer`. A concurrent caller does **not** queue and does not start a second run: it waits on the running flight's `done` channel and returns *that run's* result (`sync.go:77-85`), or `ctx.Err()` if its own context ends first. `Running()` (`:107`) is used by the UI and Telegram. After each run, all `Subscribe()` channels (buffered size 1, `:115-130`) get a non-blocking send; the server turns that into an SSE `docs` event (`internal/server/server.go:388-392, 420-424`). Conversions are **sequential**, one document at a time (`apply` loop, `:303-325`).

**Change detection** is ETag-only (`:320`): unchanged iff `known && status=="ok" && d.ETag == o.ETag && d.Version >= ConvertVersion`. `Size` is copied into the record but never compared; there is no hash and no mtime. Consequences:
- A replaced upload with an unchanged ETag is invisible (real S3 ETags change on any write; a multipart ETag is not an MD5).
- A `failed`/`skipped`/`removed` record is re-examined every run.
- `d.Version < ConvertVersion` (same ETag) ⇒ re-read, counted as `refreshed`, **not** announced (`:345`, `:372-374`).

**Run loop / ETag guard** (`Sync → run`, `:229-270`): up to `MaxIndexRetries = 3` (`:64`) retries, i.e. **4 attempts**:
1. `load` index (body + ETag; missing index ⇒ empty index + ETag `""`).
2. `newerThanThisBuild` (`:274-281`): any `Doc.Version > ConvertVersion` ⇒ `ErrNewerIndex` (`:212`), index untouched, nothing converted.
3. `Store.List(ctx, "docs/raw/")`.
4. `apply` (below) writes each converted document's text blob and fills the index.
5. `ix.Encode(now)` then `Store.Put(IndexKey, body, etag)` — the ETag read in step 1, i.e. conditional (`ifMatch=""` means *create only*, `If-None-Match: *`).
6. `ErrPrecondition` ⇒ log `"documents index changed while syncing; redoing"` (`attempt` field) and go to 1. Any other error ⇒ `fail`. Success ⇒ cache `ix`/new ETag under the mutex, log, notify.

**Per-run memo** (`runMemo`, `:217-227`): `converted[key|etag]` and `summaries[key|etag]` survive a redo, so a second attempt converts nothing twice (failures included) and does not buy a summary again. That is why `TestEndlessConflictIsErrConflict` sees exactly 1 conversion over 4 attempts.

**`apply`** (`:285-338`): `res.At = now().UTC().Format(RFC3339)`; `first` = no existing record has `status=="ok"` (so an all-failed first import stays silent). New keys get an ID via `AssignID` with the `taken` map and are appended (`:306-312`). Per listing entry (listing is sorted by key):
- `SkipReason(key) != ""` (`index.go:121-132`: trailing `/` → `folder marker`; basename starting `._` → `macOS metadata file, not a document`; extension not `.pdf` case-insensitively → `not a PDF (<ext lowercased, no dot>)`): sets `status=skipped`, `reason`, ETag, size, clears `removedAt`; `res.Skipped++` only when the status or ETag changed.
- unchanged-and-readable ⇒ `retrySummary` only (`:321`, section 6).
- otherwise `update`.
Then every index record not in the listing and not already `removed` becomes `status=removed`, `removedAt=res.At`, `reason=""`; `res.Removed++` and it is appended to `changed` **only if `SkipReason(key)==""`** (a removed junk file is not a change). Finally `ix.LastSync = &res`.

**`update`** (`:341-381`): `wasOK`, `readable = Pages>0 && status != removed` (decides *changed* vs *added*), `refresh = wasOK && d.ETag == o.ETag`. Conversion goes through the memo. On error:
- `res.Failed++`; always `Log.Warn("document sync failed", "key", …, "err", …, "keptPrevious", wasOK)`.
- If it was `ok`: keep the whole old record, only set `Error = "couldn't read the new version: " + err` and `ErrorAt = res.At`; not a change, not announced, still searchable.
- Otherwise: `status=failed`, `reason=err`, ETag, size, `syncedAt`, `Error`, `ErrorAt` — retried at every sync.
On success: `*d = converted record`, then keep the old ID, set `syncedAt=now`, `removedAt=""`, `v=ConvertVersion`, clear `error`/`errorAt`; count `refreshed` (return, silent) / `changed` / `added`; append to `changed` (which is what the notifier gets).

**Index caching / refresh** (`:134-191`): `Index` returns the cached pointer, loading once; it never fails for a missing index. `Refresh` compares `Stat(IndexKey).ETag` with the cached ETag and reloads only when different (another replica or a manual edit). `PageText` (`:194-204`) `Get`s the text key and unmarshals; error `decode <textKey>: <err>`.

**Errors and their exact strings** (`:208-212`, `:404-409`): `ErrConflict` = `documents index changed by someone else; try the sync again`; `ErrNewerIndex` = `documents index was written by a newer version of the app; this one leaves it alone`. Any terminal error goes through `fail`, which sets `res.error` (`err.Error()`), `res.at`, and logs `Log.Warn("documents sync failed", "err", err)`.

**Notification**: after a successful write, only if `res.Changes() && !first && Notify != nil` (`:264-266`); the notifier receives the result and the `changed` docs. Failures are logged, never pushed.

**Logs** (slog, JSON in tests via `testutil.Logger`): `Info "documents synced"` with `reason, added, changed, removed, failed, skipped, refreshed, firstImport` (`:262`); `Info "documents index changed while syncing; redoing"` (`:253`); `Warn "document sync failed"` per document (above); `Warn "document summary failed"` (`:453`); `Warn "documents sync failed"` (`:407`); `Info "next daily document sync", "at"` (`schedule.go:35`); `Warn "startup document sync failed"` / `"daily document sync failed"` (`schedule.go:23,56`); `Debug "documents index refresh failed"` (`schedule.go:52`).

**Schedule interaction** (`schedule.go`): `DefaultSyncSchedule = "03:00"` (`:11`). `Background` parses `DOCS_SYNC_SCHEDULE` with `sched.Parse` (`HH:MM` 24 h, or `off`/`none`/`false`, case-insensitive, trimmed; empty means the default; errors `DOCS_SYNC_SCHEDULE must be HH:MM (24 h) or off, not %q`, `internal/sched/sched.go:12-28`). It starts the startup sync in a goroutine, ticks `Refresh` every minute, and arms a one-shot timer at `sched.NextRun(now, hh, mm, loc)` (strictly after now, in `TZ`; at exactly 03:00 the next run is tomorrow, `sched.go:32-39`), re-arming after each daily run. `off` ⇒ no daily timer (startup sync still runs). Config validates the value at boot (`internal/config/config.go:107-110`).

## 3. Conversion — `internal/docs/convert` (poppler)

`docs.Converter` is `Text(ctx, pdf []byte) ([]docs.Page, error)` (`sync.go:23-25`); `docs.Renderer` is `Render(ctx, pdf, page int, region *Region, longEdge int) ([]byte, error)` (`render.go:11-13`). `convert.Region = docs.Region` (`convert/convert.go:16`).

**`Poppler`** (`poppler.go:23-35`): fields `Timeout` (render, default 60 s), `TextTimeout` (pdfinfo/pdftotext, default 30 s), `MaxOutput` (stdout cap, default 16 MiB = `16<<20`) (`:38-42`); zero values mean the defaults. **`pdftoppm` is not used at all** — there is no `pdftoppm` anywhere in the repo; rendering is `pdftocairo` only.

**Concurrency**: one tool process at a time per `Poppler` value, enforced by a lazily-created buffered channel of size 1 (`slot`, `:33-34, 59-67`). The app has exactly one `Poppler` shared by the Syncer and the Viewer (`cmd/movin/main.go:119-122`), so a chat's page view and a sync take turns. Waiting for the slot is context-aware: `"<tool>: waiting for the PDF tools: <ctx err>"` (`:65`).

**Process mechanics** (`run`, `:69-101`): the PDF goes in on **stdin** and results come back on **stdout**; nothing touches the disk (the production rootfs is read-only). Args are always `… "-" "-"` (input stdin, output stdout).

| Call | Command and arguments |
|---|---|
| page sizes | `pdfinfo -f 1 -l 100000 -` |
| text | `pdftotext -layout -enc UTF-8 - -` |
| word boxes | `pdftotext -bbox-layout -enc UTF-8 - -` (only if some page is ≥ `wordsMinArea`) |
| whole page render | `pdftocairo -png -singlefile -f <n> -l <n> -scale-to <pixels> - -` |
| region render | `pdftocairo -png -singlefile -f <n> -l <n> -r <dpi, 2 dp> -x <x> -y <y> -W <w> -H <h> - -` |

- `-scale-to N` scales the page's **longest** side to N px (page 1191×842 at 800 → 800×566, `poppler_test.go:87`).
- Each call gets `context.WithTimeout(ctx, timeout)`; render uses `Timeout`, the other three use `TextTimeout`.
- Child lifetime: `exec.CommandContext` sends **SIGKILL to the direct child only** — no `Setpgid`, no process group anywhere in the repo — and `cmd.WaitDelay = 2 * time.Second` (`:86`) makes Go stop waiting for the inherited stdout/stderr pipes 2 s after the kill. That combination is what makes `TestPopplerTimeoutKillsTheTool` finish in ~2.3 s against a `#!/bin/sh\nsleep 30` fake (see §9).
- stdout goes through `capped` (`:107-125`): appends up to `max` bytes, then sets `over = true` and silently swallows the rest (`Write` still returns `len(b), nil`, so the tool runs to completion). **The cap is checked only after a successful exit**: `"<tool>: output larger than <limit> bytes"` (`:97-99`). A tool that both overflows and exits non-zero reports the exit error instead. stderr is capped at 4096 bytes and only its **last line** is used in the error (`:91-95`).
- Errors, exact: timeout/ctx end → `"<tool>: context deadline exceeded"` / `"<tool>: context canceled"` (`:88-90`); failure → `"<tool>: <exec error>: <last stderr line>"` e.g. `pdftotext: exit status 1: Syntax Error: Couldn't find trailer dictionary`; no pages → `pdfinfo: no pages found` (`:158`).
- Bad page: `no such page %d (the document has %d)` (`ErrBadPage`, `convert.go:19,41-46`; also in `Render`, `:250-252`). Invalid region: `region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1` (`:257-259`).

**Text extraction** (`Text`, `:163-190`):
1. `sizes` (`:135-161`) parses `pdfinfo` with `(?m)^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+)` and `(?m)^Page\s+(\d+) rot:\s+(\d+)`; a page with `rot % 180 == 90` swaps w/h so sizes are **as displayed**. No regex match at all ⇒ error above.
2. `pdftotext -layout` output is split on `"\f"` (`:172`); chunk *i* is page *i* (there is a trailing form feed per page, so the last empty chunk is ignored by the `i < len(texts)` bound). Each chunk is `tidy`d (`:223-240`): trailing spaces/tabs/CR trimmed per line, runs of >1 blank line collapsed to one, whole result `TrimSpace`d.
3. `docs.Page{N:i+1, W, H, Text}`.
4. If **any** page has `W*H >= wordsMinArea` (0.95 × 842 × 1191 pt, `convert.go:22`) then `words` runs for all pages (`:194-220`): split the `-bbox-layout` XML at `<page width=` matches, keep the chunks whose page is big enough, extract `<word xMin=… yMin=… xMax=… yMax=…>NAME</word>`, HTML-unescape the name (`html.UnescapeString`), skip whitespace-only words. Boxes are in points in the **rotated/as-displayed** space (they match the renders).

**Rendering** (`Render`, `:242-267`): `longEdge` is clamped to `MaxLongEdge = 2000` when `<= 0` or `> 2000` (`convert.go:26`). Page bounds are checked against `pdfinfo` sizes (so `pdfinfo` runs on every render, cached PDF or not). Whole page ⇒ `-scale-to <longEdge>`. Region ⇒ `pixelBox` (`convert.go:31-39`): `dpi = longEdge*72/long` where `long` is the longer region edge in points; `x=int(x0*w*scale)`, `y=int(y0*h*scale)`, `cw=int(rw*scale+0.5)`, `ch=int(rh*scale+0.5)`, `scale = dpi/72`; dpi is formatted with `%f` 2 decimals. `pdftocairo` then rasterises only the crop, so memory stays flat at any zoom.

**Fonts and environment**: no fonts are loaded by the code; poppler substitutes with whatever fontconfig offers (see §11). The tests shell out to the real tools and skip when absent (`needPoppler`, `poppler_test.go:16-23`). No temp dirs are created by this package at all.

**`Fake`** (`fake.go`) is the test double: `Pages map[string][]docs.Page` and `Fail map[string]error` keyed by the *raw PDF bytes as a string*; `Text` sleeps `Delay`, increments `Calls`, then fails or returns a copy; `Render` increments `Renders`, validates the page via `checkPage`, and returns the literal `[]byte(fmt.Sprintf("PNG page=%d region=%v edge=%d", page, region, longEdge))` (`fake.go:49`) — `%v` of a `*Region` prints `&{0.5 0.5 1 1}` and of nil prints `<nil>`; tests assert those strings.

## 4. Search and summary (what the agent tools return)

### Search (`search.go`)

`Library` (`:16-24`) holds `*Syncer` and a BM25 snapshot: `built *Index` (the index pointer it was built from), `pages []indexedPage`, `df map[string]int`, `avg float64`. `ensure` (`:57-104`) rebuilds when `l.built != ix` (**pointer identity**: a new index object after a sync/refresh triggers a rebuild; that is the intended staleness check — in TS keep a version counter). Build: for every doc with `status=="ok"` and `class!="scanned"`, `PageText` is fetched (`Warn "document text unreadable; left out of search"` on error); for each page, tokenize the text, skip pages with 0 tokens (they are not indexed and do not count towards `n` or `avg`), build `tf`, increment `df` per distinct term, add to `total`. `avg = total terms / indexed pages`.

Tokenizer (`:188-207`): lowercase, `strings.FieldsFunc` split on anything that is **not** a Unicode letter or digit, drop a fixed stopword set (`:179-184`: the,a,an,and,or,of,to,in,on,for,is,are,be,with,by,it,at,as,this,that,from,what,where,how,do,does,our,we,my,i,you,your,can,which), then a two-rule stem: `len>4 && ends "ies"` → `…y`; `len>3 && ends "s" && not "ss" && not "us"` → drop the `s`. Query terms are de-duplicated (`uniq`, `:209-219`).

Scoring (`Search`, `:107-155`): `n = len(pages)`, `bm25K1 = 1.2`, `bm25B = 0.75` (`:51-54`);
`idf = ln(1 + (n - df + 0.5)/(df + 0.5))`;
`score += idf * f * (K1+1) / (f + K1*(1 - B + B*terms/avg))` with `f = tf[term]`, `terms = page token count`.
Filters: `o.Doc != ""` ⇒ `p.doc.ID == o.Doc`; `o.Folder` (trimmed of `/`, lowercased) ⇒ `HasPrefix(lower(doc.Folder()), folder)`. Pages scoring 0 are dropped. Each hit's score is rounded to 2 decimals (`math.Round(score*100)/100`) **before** sorting. Sort is stable: score desc, then `Name` asc, then `Page` asc. `Limit`: `<=0` → 8, capped at 20 (`:111-115`). Returned slice may be nil.

`Hit` JSON (`:35-42`, the shape the `search_documents` tool returns inside `{"hits": …}`): `doc` (id), `name` (file name), `folder` (`omitempty`), `page`, `score`, `snippet`.

`snippet` (`:223-253`): collapse whitespace (`strings.Join(strings.Fields(text), " ")`) and work on **runes**; lowercase rune-by-rune into a parallel slice (so positions stay aligned: `Ⱥ`→`ⱥ` changes byte length); find the earliest query term occurrence (byte `Index` on the lowered string, converted to a rune index); start at `max(0, at-80)`, end at `min(len, start+240)`; prefix `…` when `start>0`, suffix `…` when `end<len`.

`Library.Page(ctx, docID, n)` (`:158-177`): doc must exist and be `ok`, else `(Doc{}, Page{}, false, nil)`; then the page with `p.N == n` from the stored text; missing page ⇒ `(*d, Page{}, false, nil)`; a text read error ⇒ `(*d, Page{}, false, err)`.

### Summary (`summary.go`)

`Summariser` interface (`sync.go:36-38`); nil ⇒ summaries stay empty. `LLMSummariser{Settings *settings.Service}` (`summary.go:17-19`) resolves the saved connection each call; no connection ⇒ error `no LLM connection configured`. It forces `Streaming = false`, and sends (non-streaming `Complete`, `internal/llm`) system `summaryPrompt` (`:21-23`) + one user message `"File: <folder/>name\n\nStart of the text:\n<text>"`. Prompt text: *"You write one-line descriptions of a family's household documents (a new condo: drawings, checklists, letters, appliance manuals). Given a file name and the start of its text, answer with one plain line of at most 20 words saying what the document is and what it is useful for. No quotes, no lead-in, no personal details such as names, phone numbers, emails or passwords."*

Fixture summary type in tests returns `"About <file name>"`.

`tidySummary` (`:46-58`): first non-empty line, `TrimSpace` then trimmed of `"`, `'`, `“`, `”`; longer than `MaxSummaryLen = 160` runes ⇒ cut to 159 runes, `TrimSpace`, append `…`.

Where summaries are written: on a successful conversion when `Summarise != nil && class != scanned` (`sync.go:442-444`), from `firstText(pages, 3000)`, which concatenates `p.Text + "\n"` from the first pages and truncates by **runes** at 3000 (`:471-483`). Errors are logged (`document summary failed`, key, err) and stored as `""` — retried next sync. For an otherwise unchanged document, `retrySummary` (`:385-402`) gives at most one attempt per run, and never for `scanned` or when a summary already exists; a summary bought during a conversion earlier in the same run is reused.

## 5. Rendering for the LLM (`render.go`)

`Viewer{Sync *Syncer, Conv Renderer}` (`:37-44`). Nothing is pre-rendered or stored in the bucket; the raw PDF is read per view and cached in memory.

`View(ctx, id, n, region)` (`:68-110`):
1. `Sync.Index` → `Find(id)`; missing or `status != "ok"` ⇒ `not viewable: no document "<id>"` (`ErrNotViewable`, `:31`).
2. `n` outside `1..d.Pages` ⇒ `not viewable: <name> has <pages> pages; there is no page <n>`.
3. invalid region ⇒ `region must be inside the page: 0 ≤ x0 < x1 ≤ 1 and 0 ≤ y0 < y1 ≤ 1`.
4. `PageText` (best-effort) gives `W`, `H` and `Words` = `wordsIn(page, region)` (`:142-157`): keep words whose **centre** falls inside the region (all words when no region, or when `W`/`H` are 0), in extraction order, capped at `MaxViewWords = 300`.
5. Cache key `fmt.Sprintf("%s|%s|%d|%v", d.Key, d.ETag, n, region)` (`:89`) → `views` LRU (`maxCachedViews = 24`, `maxCachedViewBytes = 16 MiB`, `:49-55`).
6. Else `pdf(ctx, d)` (`:112-138`): key `d.Key+"|"+d.ETag`; `d.Size > MaxPDFBytes` (32 MiB, `:24`) ⇒ `not viewable: <name> is too large to view (<n> MB; the limit is 32 MB)` (`mbUp` rounds **up**, `:28`); `Get` the object and compare its ETag with `d.ETag` — different ⇒ `not viewable: <name> was replaced and is waiting to be re-read; try again after the next sync (/sync)` and nothing is cached; only PDFs `<= 16 MiB` are cached (`maxPDFToCache`, `maxCachedPDFs = 3`, `maxCachedPDFBytes = 32 MiB`).
7. `Conv.Render(ctx, pdf, n, region, ViewEdge)` with **`ViewEdge = 1568`** (`:17`) — the long edge of every image handed to a model: whole page ⇒ 1568 px on the longer side; region ⇒ 1568 px on the region's longer side (upscaling small crops is allowed). Format is **PNG** (grayscale/RGB per poppler); no other sizes are ever requested. `MaxLongEdge = 2000` in the converter is a hard cap only.
8. Cache and return `View{Doc, Page, Region, PNG, Words, W, H}`.

Caps the agent adds on top (`internal/agent`): at most `MaxImagesPerTurn = 6` images per user message (`doctools.go:32`, enforced in `agent.go:223-226`, refusal text `{"error":"image limit for this message reached; answer from what you have seen"}`); the image is passed as `llm.Image{MediaType:"image/png"}` and becomes `data:image/png;base64,…` for OpenAI or an Anthropic base64 image block. `read_document_page` truncates page text at `MaxPageChars = 8000` runes with `"truncated":true` (`doctools.go:14,115-121`).

`byteLRU` (`:161-209`, internal test `lru_internal_test.go`): get touches; put ignores values larger than the whole byte budget; evicts oldest while over entries or bytes; replacing a key fixes the byte count. `CacheSize` in `export_test.go` exposes the counters.

## 6. Every test, by name and line

### Shared fixture (`sync_test.go`)
Keys (`:18-23`): `manual = "docs/raw/4.0 Manuals/Fridge.pdf"`, `drawing = "docs/raw/1.0 Plans/1.3 Power.pdf"`, `junk = "docs/raw/1.0 Plans/._1.3 Power.pdf"`, `video = "docs/raw/5.0 Vouchers/5.1 Video.mp4"`. `a4(text) = Page{W:595,H:842,Text:text}` (`:25`); `long` = 3× the sentence `"Defrost the freezer every six months. Keep the door seal clean with warm soapy water. "` (`:27`, ≥ 100 chars, so pages count as text). `rig` (`:44-78`): memory store + `convert.Fake` seeded with `pdf-manual-v1`/`pdf-manual-v2` (2 A4 pages of `long`) and `pdf-drawing-v1` (2384×1684, `"POWER LEGEND "+long`, one word `DB` box `{100,900,120,910}`); fixed `Now = 2026-11-11T03:00:00Z`; `notes` records `DocsChanged` calls; helpers `put/run/doc`. PDF bodies are plain strings used as opaque blobs — the fake never parses them.

### `internal/docs` package
- `TestByteLRU` (`lru_internal_test.go:5`): get touches; byte budget evicts the oldest; entry cap; an entry bigger than the whole budget is not cached and evicts nothing; replacing a key keeps `bytes` right (40+30+10).
- `TestSkipReason` (`index_test.go:11`): the table of 8 keys (incl. `Manual.PDF` kept, `._` skipped, `.mp4`, `.txt`, folder marker, no extension) and the exact reason `not a PDF (mp4)`.
- `TestClassify` (`:31`): 10 cases — A4 manual→text/3; A3 rotated and A1→drawing/1; blank scan→scanned/0; mostly screenshots→scanned/1; half text→text/1; no pages→scanned/0; landscape A4 (842×595)→text/1; big pages without text (1464×822, 0 and 3 chars)→scanned/0.
- `TestAssignIDIsStableAndUnique` (`:58`): 8 hex chars, stable, `-2` then `-3` on collisions.
- `TestPathsAndRoundTrip` (`:73`): `Name`/`Folder`/`TextKey` exact strings, top-level folder `""`; encode sorts by key (`b` before `a` → `docs/raw/a.pdf` first), round-trips `LastSync`, `Find`; empty body → empty index; `schema:2` rejected with `schema 2` in the message; `Changes()` truth table.
- `TestGarbled` (`:107`): good text, `""`, `"DB TV P3 2G"` not garbled; a shifted-letters-with-control-chars sample garbled; a 12-word vowel-less line garbled.
- `TestSyncLifecycle` (`sync_test.go:95`): first import = 2 added / 2 skipped / 0 failed / 0 notes; manual `ok/text/2 pages/2 textPages` with a non-empty ID; the A1 shape classified `drawing`; junk `skipped` with a reason; the stored text has 1 page and word `DB`; a second run converts nothing and notifies nobody; a new version → `changed:1`, exactly one notice naming that document, **same ID**; delete → `removed:1`, status `removed`, second notice; re-upload → `added:1`, `ok`, same ID.
- `TestSyncFailureIsRetried` (`:151`): conversion error → `failed:1`, status `failed`, `reason` equals the error string; after clearing the error → `added:1`, `ok`.
- `TestSyncIsSingleFlight` (`:164`): 4 concurrent `Sync("web")` with `Delay 100ms` → converter called **2** times (2 docs, once each) and every caller got `added:2`.
- `TestSyncRedoesAfterAnotherWriter` (`:204`, `racingStore` at `:191`): another writer replaces `docs/index.json` just before our `Put`; our run redoes, keeps their record verbatim (`ID abc12345`, `summary "theirs"`), total 2 docs in the index, `res.Added == 1`, and the converter ran only twice overall.
- `TestFailedThenFixedImportStaysSilent` (`:242`): all conversions fail → `failed:2`, no notice; the fixed run → `added:2`, **still no notice**; a later change → `changed:1`, one notice.
- `TestOlderVersionIsRefreshedQuietly` (`:264`): set every `v` to `ConvertVersion-1` → run gives `refreshed:2`, no changes, +2 conversions, no notice, `v` back to 3; the next run refreshes nothing.
- `TestNewerIndexIsLeftAlone` (`:295`): a record with `v = ConvertVersion+1` → `Sync` returns `ErrNewerIndex`, the index bytes are byte-identical afterwards, no conversion.
- `TestFailedRereadKeepsTheDocument` (`:320`): a new version that fails → `failed:1`, not a change, status stays `ok`, 2 pages, no notice, `error` contains the message and `errorAt == res.At`; search still finds it; recovery → `changed:1`, `added:0`, one notice, `error`/`errorAt` cleared.
- `TestRedoRemembersEverything` (`:352`): a redo converts exactly 3 times total and buys exactly 2 summaries; the manual keeps `summary "About Fridge.pdf"`.
- `TestEndlessConflictIsErrConflict` (`:399`, `alwaysConflict` at `:390`): every index `Put` returns `ErrPrecondition` → `ErrConflict` after the retries and only **1** conversion.
- `TestViewer` (`render_test.go:12`): a 1000×500 page with words `BALCONY` (top-left) and `DB` (bottom-right); full view PNG string contains `page=1 region=<nil> edge=1568`, 2 words, `W == 1000`; the `{0.5,0.5,1,1}` crop returns only `DB`; the same view twice renders once (cache); unknown id and page 2 → `ErrNotViewable`; inverted region → error; after the file is deleted and a sync runs, the same view → `ErrNotViewable`.
- `TestViewerDoesNotCacheHugePDFs` (`:58`): a 17 MiB body is viewed once but caches 0 PDFs; a small one caches 1 PDF of exactly its own length and 2 view entries.
- `TestViewerRefusesAnUnreadNewVersion` (`:84`): re-upload without a sync → `ErrNotViewable` with `waiting to be re-read`, and nothing cached.
- `TestPDFSizeLimit` (`limits_test.go:15`): a `MaxPDFBytes+1` body → `failed` with `too large to read (33 MB; the limit is 32 MB)` and **no** converter call; then a readable sheet whose *index* size is forged to 33 MiB (rewritten JSON, `Refresh`) → `View` returns `ErrNotViewable` containing `too large to view`.
- `TestSearchRanksAndFilters` (`search_test.go:33`, rig at `:11`): 4 docs (Fridge 2 pages, Oven 1, A1 Power 1, a scanned 2-page one); `"how do I defrost the freezer?"` → top hit `Fridge.pdf` page 2 with `defrost the freezer` in the snippet and folder `4.0 Manuals/4.2 Kitchen`; `"socket"` → exactly the Power sheet (plural folding); `"door"` → 2 hits, folder `1.0 plans` → 0, `Doc` filter → 1; stopwords-only query → 0; the scanned doc is `scanned` and unsearchable; `Page(oven,1)` OK, `Page(oven,7)` not ok.
- `TestSearchSeesNewDocumentsAfterSync` (`:78`): no hits before, one after uploading + syncing (the rebuild-on-new-index-pointer behaviour).
- `TestSnippetWithLengthChangingCase` (`:94`): 120× `Ⱥ` + `" valve"`; snippet must end with `valve` and not panic.
- `TestSummaries` (`summary_test.go:37`, `fakeSummaries` at `:19`): model down → OK with empty summary, 1 call; next run retries once (2 calls) with no reconversion and gives `About Fridge.pdf`; an unchanged summarised doc makes no call; a new version makes a third call. Scans never summarised.
- `TestLLMSummariser` (`:70`): a fake OpenAI server; the reply `"\"SMEG fridge manual: …\"\nSecond line."` is tidied to the first line without quotes; the request has `stream:false`, 2 messages, the second containing `File: 4.0 Manuals/Fridge.pdf`, the first containing `no personal details`; without a saved connection → error.

### `internal/docs/convert`
`testdata/sample.pdf` is a **hand-built 1203-byte PDF 1.4 with no generator script in the repo** (nothing references it but the test). Objects: 1 catalog; 2 pages `/Kids [3 0 R 5 0 R 7 0 R] /Count 3`; 3 A4 page `MediaBox [0 0 595 842]` contents `BT /F1 18 Tf 72 760 Td (Kitchen countertop: sintered stone, 4200 dollars.) Tj 0 -30 Td (Warranty 10 years from handover.) Tj ET`; 5 A3 page `MediaBox [0 0 842 1191] /Rotate 90` contents `BT /F1 24 Tf 100 1050 Td (BALCONY) Tj 0 -300 Td (LIVING ROOM) Tj 300 -400 Td (DB DISTRIBUTION BOARD) Tj ET`; 7 A4 page with an empty content stream; 9 `/Type /Font /Subtype /Type1 /BaseFont /Helvetica`; classic `xref`/`trailer /Size 10 /Root 1 0 R`. A TS port needs a byte-equivalent fixture (or regenerates the same pages) because the assertions are about poppler's output, not about the bytes.
- `TestPopplerText` (`poppler_test.go:41`): 3 pages; page 1 is 595×842 containing `Kitchen countertop: sintered stone` with **no** words; page 2 is **1191×842** (rotation applied) containing `BALCONY` and having a `BALCONY` word box inside the displayed page (`xMax<=W`, `yMax<=H`, `xMin>=0`, `xMin<xMax`); page 3 text is `""`.
- `TestPopplerRender` (`:78`): whole page 2 at 800 → PNG with IHDR width 800, height 560–570 (`1191×842 → 800×566`); quarter crop `{0.5,0,1,0.5}` at 400 → 400 wide, 280–285 high; page 9 → `ErrBadPage`; inverted region → error; `Text([]byte("not a pdf"))` → error.
- `TestPopplerTimeoutKillsTheTool` (`:109`): a `#!/bin/sh\nsleep 30` `pdfinfo` first on `PATH`, `TextTimeout 300ms` → error satisfying `errors.Is(err, context.DeadlineExceeded)` and the call returns within 5 s.
- `TestPixelBox` (`:129`): right half of an A1 (2384×1684) at 1568 → `h==1568`, `w` and `x` in 1108–1111, `y==0`, dpi 67.0–67.1; plus `Valid()` truth table (whole page valid, zero-width invalid, negative invalid).
- `TestPopplerRealSample` (`:142`): skipped unless `MOVIN_SAMPLE_PDF` points at a real PDF; then only asserts ≥1 page and logs stats.
- `TestPopplerWaitRespectsContext` (`:161`): one caller holds the slot for 3 s; a second with a 200 ms context gets an error containing `waiting for the PDF tools` and `DeadlineExceeded`, within 1 s.
- `TestPopplerOutputCap` (`:183`): `MaxOutput: 50` → error containing `output larger than 50 bytes`; also pins `DefaultMaxOutput == 16<<20` and `DefaultTextTimeout == 30s`.

### Outside the package (they constrain the same behaviour)
- `TestDocsOff` (`internal/server/docs_test.go:19`): `GET /api/docs` → 200 with `on:false`; `POST /api/docs/sync` → 404.
- `TestDocsListSyncAndEvent` (`:29`): starts an SSE client first; `POST /api/docs/sync` → **202** with `started:true`; a second POST 30 ms later → 202 `joined:true`; one `event: docs` with `on:true`, 2 docs (the `._` file too), `running:false`; converter ran once; `GET /api/docs` shows `folder:"4.0 Manuals"`, `status:"ok"`, `class:"text"`, `lastSync.reason:"web"`.
- `TestDocumentToolsOnOpenAI` (`internal/agent/doctools_test.go:50`): tool results carry `"doc":"<id>"`/`"page":2` and the page text; the system prompt has `\n\nDocuments (` **before** `\n\nCurrent entries` and a line `<id> | 4.0 Manuals/Fridge.pdf | 2 page(s) | text`.
- `TestDocumentToolErrors` (`:89`): exact tool errors `no document "nope"`, `Fridge.pdf has 2 pages; there is no page 9`, `query is required`.
- `TestDocumentToolsOnClaude` (`:107`): the tool list is byte-identical with and without documents; 4 system blocks with documents (the Documents block has its own `cache_control`) and 3 without.
- `TestEmptyAnswerAfterDocumentSearch` (`:149`): an empty reply after a doc tool becomes `agent.NotFoundInDocsReply`.
- `TestViewDocumentPage` (`:160`): view tool only offered with vision, last in the list; 7 view calls → 6 images plus a tool result containing `image limit for this message reached`; the echoed region JSON is `{"x0":0,"y0":0,"x1":0.5,"y1":0.5}`.
- `TestDocumentSyncAndNotices` (`internal/telegram/bot_test.go:692`): `/sync` replies `"Syncing…"` then `Synced: 1 added` + file name, and the first import posts no group notice; a later `Sync("daily")` posts one `Documents updated: 1 added` naming `Oven.pdf`; a no-op `/sync` says `No changes. 2 documents are readable.` and sends no notice.
- `TestSchedule` (`internal/sched/sched_test.go:10`): `""`→03:00 on, `off`/`OFF`→off, `3`/`24:00`/`07:61`/`noon` rejected; `NextRun` across midnight and month end (`02:59`→today 03:00, exactly `03:00`→tomorrow, `2026-11-11T19:30Z` = 03:30 SGT on the 12th → the 13th).

## 7. Callers outside the package

| Caller | Members used |
|---|---|
| `cmd/movin/main.go:119-122` | one `&convert.Poppler{}`; `&docs.Syncer{Store, Conv: poppler, Summarise: &docs.LLMSummariser{Settings: sets}, Log, Now: time.Now}`; `&docs.Library{Sync: syncer}`; `&docs.Viewer{Sync: syncer, Conv: poppler}` |
| `cmd/movin/main.go:126-130` | `telegram.Bot.Docs = syncer`, `syncer.Notify = bot` (only when `TELEGRAM_BOT_TOKEN` is set) |
| `cmd/movin/main.go:141` | `server.Server.Docs = syncer` |
| `cmd/movin/main.go:176` | `go syncer.Background(ctx, c.DocsSync, c.Location)` after `Listen`, before/while `Serve` |
| `internal/server/server.go:93-94` | routes `GET /api/docs`, `POST /api/docs/sync` |
| `internal/server/docs.go:11-39` | `docsView`: `Syncer.Running()`, `Index()`, `ix.LastSync`, `d.Name()`, `d.Folder()`; output `{on, running, lastSync?, docs:[{…Doc, name, folder}]}` (Doc's own JSON keys flattened in) |
| `internal/server/docs.go:52-66` | `syncDocs`: 404 `Documents are not switched on.` when `Docs == nil`; else `go Docs.Sync(context.WithoutCancel(ctx), "web")`, answers 202 `{"started":!joined,"joined":joined}`, logs `document sync requested` / `document sync from the web page failed` |
| `internal/server/server.go:388-392, 420-424` | `Syncer.Subscribe()`; on signal sends SSE `event: docs` with the whole `docsView` |
| `internal/telegram/bot.go:30` | `Docs *docs.Syncer` (nil = off) |
| `internal/telegram/docs.go:18-37` | `DocsChanged`: `"Documents updated: " + counts + "\n" + docList(changed,10)`, skips the chat in the reason (`telegram:<id>`); per-group `SendMessage`, warn `telegram documents notice failed` |
| `internal/telegram/docs.go:40-79` | `syncCommand` (`/sync`, dispatched at `commands.go:66`, help line `commands.go:36`): messages `Documents aren't switched on, so there's nothing to sync.` / `A sync is already running; I'll post the result when it's done.` / `Syncing the documents…` / `The sync didn't finish: <err, 300 runes>` / `No changes. N documents are readable.` / `Synced: <counts>. N documents are readable.`; "touched" docs are those whose `syncedAt`/`removedAt`/`errorAt` == `res.At` (max 15) |
| `internal/telegram/docs.go:81-119` | `counts` (added, changed, removed, failed, omitting zeros; `nothing changed`) and `docList` (bullet + `(removed)`, `(couldn't be read)`, `(the new version couldn't be read; the previous one is still used)`, `(pictures only: not searchable yet)`, `…and N more`) |
| `internal/agent/agent.go:94-95, 160` | `Runner.Docs *docs.Library`, `Runner.Viewer *docs.Viewer`, `docsSection` inserted into the system prompt |
| `internal/agent/doctools.go:19-29` | `DocTools` = `search_documents`, `read_document_page` (always offered when Docs != nil); `ViewTool` = `view_document_page` only when `Viewer != nil && cfg.Vision` |
| `internal/agent/doctools.go:74-96` | `search_documents` → `Library.Search(query, {Doc, Folder, Limit})`, returns `{"hits": Hit[]}` (`[]` when nil) |
| `internal/agent/doctools.go:98-126` | `read_document_page` → `Library.Page`, returns `{doc,name,folder,page,pages,class,text}` + `truncated` + `note` |
| `internal/agent/doctools.go:49-72` | `view_document_page` → `Viewer.View`, returns `{doc,name,page,pages,class,words}` (+`region`) and one `image/png` |
| `internal/agent/doctools.go:130-166` | `docsSection`: one line per `ok` doc `- <id> | <folder/name> | <pages> page(s) | <class>` + ` (pictures only: not searchable yet)` + ` | <summary>`; plus the "use search_documents…" hint and the anti-prompt-injection sentence |
| `cmd/chateval/main.go:398-409` (`-docs`) | build-only: `&convert.Poppler{}`, `&docs.Syncer{Store: bucket, Conv: pop, Log}` used **read only** (`Index`), `Library`, `Viewer`; aborts with `no documents index in the bucket (%v); run a sync in the app first` |
| `cmd/chateval/docs.go:15-55` | the five document eval cases (defrost → `search_documents`; rooms; DB location → `view_document_page`; `WP` legend; "no dimensions on the plan") |
| `cmd/movin/main.go:113` (unrelated) | serves `docs/admin-guide.md` from disk in dev — same directory as this brief, different meaning |

Wire-format note for the admin UI (`static/index.html:1325-1372`): it reads `d.status`/`d.class`/`d.pages`/`d.reason`/`d.summary`/`d.removedAt`/`d.error`/`d.errorAt`/`d.name`/`d.folder`, `lastSync.{at,reason,added,changed,removed,failed,refreshed,error}` and `v.on`/`v.running`.

## 8. Config / environment

| Var | Default | Where |
|---|---|---|
| `DOCS_SYNC_SCHEDULE` | `03:00` (`docs.DefaultSyncSchedule`, `schedule.go:11`) | `internal/config/config.go:107-110` (validated at boot), `deploy/k8s/base/kustomization.yaml:28` |
| `TZ` | `Asia/Singapore` | `config.go:79`; the daily timer uses this location |
| `S3_BUCKET`, `S3_PREFIX`, `AWS_REGION` (`ap-southeast-1`), `S3_ENDPOINT_URL` | — | `config.go:60-63`; the prefix is trimmed of `/` and applied by the store |
| `LLM_*` / saved settings | — | what `LLMSummariser` resolves per call |
| `GOMEMLIMIT`, memory limits | `128MiB` in k8s | the 256 MiB budget the 32 MiB PDF caps are sized for |
| `MOVIN_SAMPLE_PDF` | unset | **test only**, `poppler_test.go:143` |
| `XDG_CACHE_HOME` | `/tmp/.cache` (prod image) | fontconfig needs a writable cache dir |

No env var turns the documents feature off: it is on whenever `Server.Docs`/`Bot.Docs` are wired, which they always are (`main.go:120`).

## 9. Traps for a TypeScript port

1. **Process groups / kill semantics.** Go uses `exec.CommandContext` without `Setpgid`: on timeout/ctx-cancel it sends **SIGKILL to the direct child only**, then `WaitDelay = 2s` stops waiting for the inherited pipes. The test fake is `#!/bin/sh\nsleep 30` — the `sleep` is a *grandchild* that keeps stdout open; only `WaitDelay` makes the test finish in ~2 s instead of 30 s. In Node, `child.kill("SIGKILL")` has the same limitation, and the `stdout` stream stays open until every holder exits: after killing, **do not await stream end** — destroy the streams (or race a 2 s timer) and settle the promise then. If you want the whole tree gone (`detached: true` + `process.kill(-pid)`), that is a behaviour change: the Go app does *not* kill grandchildren.
2. **Stdout cap.** The Go `capped` writer keeps the first N bytes, flips `over`, and **does not kill the tool**; the error is raised only if the exit status was 0 (`poppler.go:87-99`). A Node implementation that aborts the read stream early can make the child die of EPIPE and report the wrong error. Also `capped` deliberately does not embed `bytes.Buffer` because `io.Copy` would prefer `ReadFrom` and bypass the cap (`:103-106`) — in Node just count bytes in the `data` handler.
3. **Encoding.** Text is `pdftotext -enc UTF-8` split on `"\f"`; decode as UTF-8. Go coerces invalid bytes into a Go string losslessly; Node's `toString("utf8")` replaces them with U+FFFD. Word names go through HTML unescaping (`&amp;` → `&`) — port that (`poppler.go:214`). Truncation limits are in **runes** (`MaxPageChars`, `MaxSummaryLen`, `firstText` 3000, snippet 240), not bytes or UTF-16 code units: use `[...str]`/`Array.from`, never `.slice`/`.length`.
4. **JSON byte format.** Output must match Go for anything else reading it (the Go app stays live, and the Go app may write between TS writes):
   - field order = struct order (this spec's tables), `omitempty` exactly as listed (note `Docs []Doc` and `Pages []Page` have **no** omitempty, `Sync`'s five counters have none, `Schema` has none);
   - index is `JSON.stringify(ix, null, 2)`-shaped but with **Go's HTML escaping** (`<`→`\u003c`, `>`→`\u003e`, `&`→`\u0026`, U+2028/2029) if you want byte equality; a TS-only writer that skips it still round-trips fine through both apps, but golden tests comparing bytes will differ;
   - text blobs are compact (`JSON.stringify`), no trailing newline anywhere;
   - Go prints floats in shortest round-trip form; JS `JSON.stringify` agrees for normal values but emits `-0` as `0` and `1e+21` where Go emits `1e+21` too — the only realistic divergence is `-0` page sizes, which cannot occur;
   - **unknown properties are dropped** by Go on decode. A TS `Decode` must ignore them too, and must not invent a "preserve unknown fields" behaviour — `Doc.Version > ConvertVersion` (`ErrNewerIndex`) is the guard that stops an older build destroying newer data.
5. **Times.** Every stored timestamp is `now.UTC().Format(time.RFC3339)` = `2026-11-11T03:00:00Z` (second precision, no fraction, `Z` for UTC). `Date.toISOString()` gives milliseconds — strip them (`.replace(/\.\d{3}Z$/, "Z")`). Equality matters: Telegram finds "touched" docs by string-comparing `syncedAt`/`removedAt`/`errorAt` with `res.at`, so every field in one run must get the **same** string.
6. **The `%v` in the view cache key.** Go's key is `fmt.Sprintf("%s|%s|%d|%v", key, etag, page, region)` where `region` is `*Region` → `<nil>` or `&{0.5 0.5 1 1}`. Nothing persists it; any deterministic key in TS is fine, but keep it inside one process only (the Go and TS apps never share this cache).
7. **Pointer-identity rebuild.** `Library.ensure` rebuilds when the index *object* is new, even if the bytes are identical. Port it as a monotonically increasing generation/etag that `Refresh` and a successful sync bump, not as a byte comparison.
8. **Single flight, not a queue.** Concurrent syncs must join the running one and receive its result (`started:false, joined:true` in the API, `A sync is already running…` in Telegram). A promise that resolves to the in-flight run's result is the right shape.
9. **ETag quoting.** S3 ETags arrive with their quotes (`"6a1b…"`) and are stored verbatim; `If-Match` must be sent back exactly as received. Do not normalise, lowercase or strip quotes.
10. **One poppler slot per process.** The slot is per `Poppler` instance and there is exactly one instance; a page view during a sync waits (or fails with `waiting for the PDF tools` when its own context ends). Keep that serialisation — it is what the 256 MiB memory budget was measured with (135 MiB peak for an A1 question).
11. **Fonts.** Drawings whose fonts are not embedded are rendered with fontconfig's fallback (DejaVu); a container without a writable cache dir logs `No writable cache directories` on stderr, which pollutes the "last stderr line" in error messages. Keep `XDG_CACHE_HOME` writable and run `fc-cache -f` at image build.
12. **Read-only rootfs.** Nothing is written to disk: PDF in on stdin, PNG/text out on stdout, no temp dirs (assert: a TS port must not need `tmpdir()` either).

## 10. What the Go image installs for poppler (`Dockerfile`)

- **Base stage** (Debian, `golang:1.27 AS base`, used for dev, build, lint and `make test`): `apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core` (`Dockerfile:8-9`).
- **Runtime stage** (`alpine:3.24@sha256:f59abe65…`, `Dockerfile:31-36`): `apk add --no-cache "poppler-utils~25.12" font-dejavu fontconfig` then `fc-cache -f`, then `adduser -D -H -u 65532 nonroot`. The pin is the minor release (`~25.12`).
- **`poppler-test` stage** (`Dockerfile:38-48`): builds `go test -c ./internal/docs/convert` in the base stage, copies `convert.test` **and** `internal/docs/convert/testdata` into the runtime image, runs as `65532:65532`, `-test.count=1 -test.v` piped through `grep -E "^(--- |ok|FAIL|PASS)"`; `make test` builds this stage last so the converter is exercised against the poppler that ships.
- **Production** (`Dockerfile:51-59`): the binary as `65532:65532`, `ENV XDG_CACHE_HOME=/tmp/.cache`, `TZ=Asia/Singapore`, healthcheck `movin healthcheck`.
- Binaries relied on: `pdfinfo`, `pdftotext`, `pdftocairo` (all in `poppler-utils`; `pdftoppm` ships too but is never called). Fonts: `fonts-dejavu-core` (Debian) / `font-dejavu` (Alpine) plus `fontconfig` on Alpine only.

## 11. What I could not determine

- The exact history of the `MaxOutput` default: `docs/movin-v2/progress.md:52` says "stdout capped at 64 MiB" while the code (and `TestPopplerOutputCap`) says 16 MiB. The code wins; the note is stale.
- No generator script or Makefile target exists for `internal/docs/convert/testdata/sample.pdf`; its structure above was reconstructed from the bytes, so treat it as the fixture contract, not as a file the build can regenerate.
- The TS side has no `src/docs` yet (`app/src` holds only `entries` and `objstore`), so nothing there constrains the port beyond `docs/movin-v3/plan.md:26` (`src/docs`) and `:31` (`src/tasks/docsync.ts`).
- Whether the TS port will run the converter tests inside an image with poppler (the Go `poppler-test` stage) is not decided anywhere I could find; without it the converter tests must skip, which would lose the only real-tool coverage.
