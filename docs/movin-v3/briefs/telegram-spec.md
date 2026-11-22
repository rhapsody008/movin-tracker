# Spec: Go Telegram bot (`internal/telegram`, wiring in `cmd/movin`) — porting reference for T4

Produced by code-explorer on 2026-11-22 from the frozen Go code: `internal/telegram/client.go`,
`bot.go`, `commands.go`, `docs.go` and their four test files; `internal/telegram/checkin*.go`
summarised only (it is T5.1); plus `internal/settings/telegram.go`, `internal/agent/{agent,history,
prompt,tools}.go` where the bot calls the agent, `cmd/movin/main.go` where the bot is wired,
`internal/server/admin.go` for the admin view, and the v3 side it must fit into:
`app/src/server/{admin,admin.test}.ts`, `app/src/config.ts`, `app/src/main.ts`,
`app/src/settings/telegram.ts`, `app/src/durable/adapter.ts`, `app/src/agent/{reply,prompt}.ts`,
`app/static/index.html`. Line numbers refer to those files. Where this file and the Go source
disagree, the Go source wins; report the difference.

Scope: T4.1–T4.4 (`plan.md:123-129`) — the client, the intake, the delivery of replies and the
commands/callbacks — and what T5.1 (`plan.md:131`) must find room for. Auth, the rejected list and the
admin view are `server-spec.md` §1.4/§6.3's shapes; this file says what the bot puts in them, not how
the route is written. The agent's own rules (`Run`, `CleanTurns`, `ChangeText`, the group-silence
rule) are `agent-spec.md` §2/§8 and `reply.ts`; this file only says how the bot calls them.

The one structural change v3 makes: **Go replies inside the turn; v3 replies through a durable
delivery task** (`plan.md:77`). Everything the user sees must stay byte-identical; only *when* the
bytes are sent and *what happens after a crash* change. Where a v3 change is planned, the section
says so with the plan/decisions line; everything else is "port as is".

---

## 0. Line-number map (anchors used below)

| File | Anchors |
|---|---|
| `client.go` | types `:29-131`, `APIError` `:133-144`, `IsConflict` `:146-149`, `scrubbedError` `:151-159`, `Client`/`New` `:163-176`, `scrub` `:178-195`, `call` `:197-245`, `callTimeout` `:247`, `GetUpdates` `:251-259`, `GetMe` `:261-265`, `SendMessage` `:267-272`, `SendChatAction` `:274-278`, `AnswerCallbackQuery` `:280-288`, `EditMessageReplyMarkup` `:290-295`, `SetMyCommands` `:297-299`, `GetFile` `:301-305`, `ErrTooLarge`/`Download` `:308-340` |
| `bot.go` | `Bot` `:25-53`, `chatHistory` `:55-58`, `Rejected` `:62-72`, `Status` `:74-83`, constants `:85-94`, `now` `:95-101`, `Status()` `:103-113`, `setErr` `:115-120`, `Run` `:122-179`, `start` `:183-209`, `pollRetry` `:211-225`, `sleep` `:227-236`, `displayName` `:238-250`, `authorise` `:252-274`, `reject` `:276-292`, `dispatch` `:294-334`, `work` `:339-363`, `Wait` `:365-374`, `handle` `:376-405`, `converse` `:409-457`, `historyFor` `:461-477`, `typing` `:479-494`, `changeText` `:496-503`, `undoKeyboard` `:505-534`, `handleCallback` `:536-592`, `reply` `:596-613`, `split` `:615-636`, `truncate` `:638-644` |
| `commands.go` | `Commands` `:15-22`, `helpText` `:24-40`, `command` `:42-72`, `recent` `:74-98`, `undoLast` `:100-116` |
| `docs.go` | `syncReasonPrefix` `:14`, `DocsChanged` `:18-38`, `syncCommand` `:40-79`, `counts` `:81-95`, `docList` `:97-119` |
| `cmd/movin/main.go` | bot built `:124-138`, check-in loop `:180-182`, shutdown drain `:187-189` |

v3 targets: `src/telegram/{client,intake,delivery,commands}.ts` (`plan.md:30`).

---

## 1. The Bot API client (`client.go`) — T4.1

Hand-written on `net/http`, no dependency (`client.go:1-10`). The token lives in the URL path, so
every error that could carry a URL is scrubbed (`client.go:4-7`).

### 1.1 Types: only the fields the bot uses

Decoded with `encoding/json`; unknown fields ignored (`client.go:27`).

| Type | Line | Fields (JSON name; `omitempty` marked) |
|---|---|---|
| `Update` | `:29-33` | `update_id`, `message?`, `callback_query?` |
| `Message` | `:35-51` | `message_id`, `from?`, `chat`, `date`, `text?`, `caption?`, `document?`, `photo?` (`[]PhotoSize`), `voice?`, `reply_markup?`, `migrate_to_chat_id?` (int64, 0 = absent) |
| `User` | `:53-59` | `id`, `is_bot`, `first_name`, `last_name?`, `username?` |
| `Chat` | `:61-68` | `id`, `type` (`private｜group｜supergroup｜channel`), `title?`, `username?`, `first_name?` |
| `Chat.IsGroup()` | `:70` | `type == "group" || type == "supergroup"` — **not** `channel` |
| `CallbackQuery` | `:72-77` | `id`, `from`, `message?`, `data?` |
| `Document` | `:79-85` | `file_id`, `file_unique_id`, `file_name?`, `mime_type?`, `file_size?` |
| `PhotoSize` | `:87-92` | `file_id`, `width`, `height`, `file_size?` |
| `Voice` | `:94-99` | `file_id`, `duration`, `mime_type?`, `file_size?` |
| `File` | `:101-105` | `file_id`, `file_size?`, `file_path?` |
| `InlineKeyboardMarkup` | `:107-109` | `inline_keyboard` = `[][]InlineKeyboardButton` |
| `InlineKeyboardButton` | `:111-114` | `text`, `callback_data?` |
| `BotCommand` | `:116-119` | `command`, `description` |
| `SendMessage` | `:123-128` | `chat_id`, `text`, `reply_to_message_id?`, `reply_markup?` — field order is the JSON order |

`Message.Caption` and `Message.Voice` are decoded and never read by the bot (§4.1). There is **no**
`reply_to_message` field: Go never looks at what a message replies to.

### 1.2 Requests: method, body, timeout

Every call is `POST {baseURL}/bot{token}/{method}` with `Content-Type: application/json` and a JSON
body (`client.go:197-215`). `baseURL` defaults to `https://api.telegram.org` and trailing `/` is
trimmed (`:22`, `:171-176`); tests point it at a fake server (`client_test.go:21-80`).

| Method | Params (JSON) | Timeout | Line |
|---|---|---|---|
| `getUpdates` | `{"offset":<int64>,"timeout":<int>,"allowed_updates":["message","callback_query"]}` | `pollSeconds + 15 s` | `:251-259` |
| `getMe` | `{}` | 30 s | `:261-265` |
| `sendMessage` | the `SendMessage` struct above | 30 s | `:267-272` |
| `sendChatAction` | `{"chat_id":<int64>,"action":"typing"}` | 30 s | `:274-278` |
| `answerCallbackQuery` | `{"callback_query_id":"…"}`; `text` added only when non-empty | 30 s | `:280-288` |
| `editMessageReplyMarkup` | `{"chat_id","message_id","reply_markup"}`; a nil markup becomes `{"inline_keyboard":[]}` (the field is always sent) | 30 s | `:290-295` |
| `setMyCommands` | `{"commands":[{"command","description"}…]}` | 30 s | `:297-299` |
| `getFile` | `{"file_id":"…"}` | 30 s | `:301-305` |
| `Download` | `GET {baseURL}/file/bot{token}/{filePath with leading "/" trimmed}` | 2 min | `:312-320` |

`callTimeout` is 30 s (`:247`). The `http.Client` has **no** timeout of its own; the per-call
`context.WithTimeout` is the whole budget (`:163-167`, `:203-205`). The response body is read through
`io.LimitReader(resp.Body, 8<<20)` into one envelope `{ok, result, error_code, description,
parameters{retry_after}}` (`:217-236`).

`Download` refuses over the limit in two places — declared `Content-Length`, and the 1-byte-over read
— and returns `ErrTooLarge` = `"file is larger than the download limit"` (`:308`, `:325-338`);
default limit `MaxDownload = 20 << 20` (`:25`). Non-200 → error `telegram download: HTTP <code>`.

**v3:** the client is `src/telegram/client.ts` on global `fetch` (`plan.md:123`, "fake API; token never
in errors"). Keep the shapes above, including the `allowed_updates` list and the +15 s poll headroom.

### 1.3 Response and error mapping

- `ok:true` → `result` is unmarshalled into the caller's value; a decode failure becomes
  `telegram <method>: decode result: <go json error>` (scrubbed) (`:239-243`).
- An unreadable body → `telegram <method>: HTTP <status>, unreadable answer: <decode error>`
  (`:223-225`). This is how a proxy's HTML error page surfaces.
- `ok:false` → `*APIError{Method, Code, Description, RetryAfter}` (`:133-144`, `:226-238`).
  `Code` is `error_code`, falling back to the HTTP status when `error_code` is 0 (`:227-230`);
  `RetryAfter` comes from `parameters.retry_after` (`:231-233`). The description is scrubbed of the
  token (`:234-236`).
- `APIError.Error()` is exactly `fmt.Sprintf("telegram %s: %d %s", Method, Code, Description)` →
  `telegram getUpdates: 409 Conflict: terminated by other getUpdates request; …` (`:140-142`).
- `IsConflict(err)` = `errors.As(err, &*APIError) && Code == 409` (`:146-149`).
- Transport errors go through `scrub` (`:178-195`): the token is replaced by the literal `<token>`
  everywhere in the message, the message is prefixed `telegram <method>: `, and the wrapper
  (`scrubbedError`, `:151-159`) unwraps **only** to `context.Canceled` / `context.DeadlineExceeded`
  — never to the original error, which quotes the full URL. So `errors.Is(err,
  context.DeadlineExceeded)` still works after scrubbing and the URL never escapes.
- A wrong token is not special: `401` arrives as an ordinary `APIError` with code 401
  (`client_test.go:180-183`).

### 1.4 The token never leaves the package

The token appears only in the request URL (`client.go:204`, `:321`). Consequences pinned by tests:

- `TestTokenNeverInErrors` (`client_test.go:189-244`) drives connection refused, a request that
  exceeds a 100 ms context, a 502 HTML page and a `{"ok":true,"result":"not a user"}` body through
  `GetMe`, and both `Download` failures — then walks the error, `%+v`, `%#v` and every `Unwrap` level
  and fails on the token or any substring of it (`"AAFakeToken"`).
- `TestScrubControl` (`client_test.go:269-277`) proves the test is meaningful: the same URL through
  bare `http.Post` **does** quote the token.
- `TestNonTextAndStatusHasNoToken` (`bot_test.go:520-542`) marshals `Bot.Status()` and greps the log
  buffer: no token (`:530-540`).
- The admin view carries only `tokenSet` (`server-spec.md` §1.4; `admin.test.ts:580-612` pins it for
  T2 with `tokenSet:false`).

Tooling that logs errors must log the scrubbed `Error()` only. There is no other place the token can
appear: nothing else in the package formats the URL.

### 1.5 Retry and backoff (the client does not retry)

`call` makes exactly one attempt; backoff lives in the bot's two loops.

**Start-up `getMe` (`start`, `bot.go:183-209`):** retries forever with `backoff` 1 s, doubling to a
1-minute cap (`:204`), logging `telegram getMe failed, retrying` with `in=<wait>` (`:200`). It gives
up only on **401** — `telegram bot token rejected; the bot is off` (`:196-198`) — or when the context
ends. `Run` returns that error and `main.go:131-136` logs `telegram bot stopped`; nothing restarts the
bot inside the process. On success it sets `st.BotUsername = me.Username`, `st.Running = true` and logs
`telegram bot started` (`:186-192`).

**Polling (`pollRetry`, `bot.go:211-225`)**, chosen in this order:

1. **409 Conflict** (`IsConflict`) → `ConflictWait`, default **15 s** (`:123-128`, `:214-216`), log
   `another poller is using this bot token (409); is a second replica or a local copy running?` with
   `retryIn`. Returned *without* touching the doubling backoff.
2. **`APIError` with `RetryAfter > 0`** (429 flood control) → sleep exactly `retry_after` seconds
   (`:217-218`). Again the doubling backoff is untouched and nothing is logged.
3. Anything else → `wait = backoff`, then `backoff = min(backoff*2, 1 min)`
   (`:219-224`), log `telegram getUpdates failed` with `err` and `retryIn`.

The doubling backoff is reset to 1 s after **every** successful `getUpdates` (`:163`), so a flapping
network costs 1,2,4…60 s and a single success starts it over. Every failure also records
`st.LastError` / `st.LastErrorAt` (`:157`, `:115-120`) — see §9.

`TestConflictBacksOffThenRecovers` (`bot_test.go:386-397`): two 409s then a normal answer; the message
still gets its reply and `Status().LastError` contains `409`, the log contains `another poller`. There
is no test for 429 timing in the bot; `TestAPIErrors` (`client_test.go:152-187`) pins the mapping
(`RetryAfter == 7`).

**v3:** same two policies. `plan.md:125`'s verify list names "409 backoff"; there is no v3 decision to
change the numbers.

---

## 2. Polling — T4.2

### 2.1 The loop

`Run` (`bot.go:122-179`):

1. Defaults: `PollSeconds = 50` if unset (`:123-125`), `ConflictWait = 15 s` if unset (`:126-128`).
   `main.go:126` sets neither, so production runs 50 s long-poll and 15 s conflict pause.
2. Fresh state: `workers` map emptied, `history` created **only if nil** (the check-in may have
   already started a chat's history, `:131-133`), `st.Rejected = []` (`:134`).
3. `start` (getMe, §1.5). Failure → return.
4. `defer` sets `st.Running = false` (`:140-144`).
5. `SetMyCommands(ctx, Commands)` — a failure only logs `telegram setMyCommands failed` and polling
   continues (`:145-147`). It is called once per `Run`, so a token with a stale menu keeps it.
6. `offset := int64(0)` (`:149`) — **in memory only**; a restart re-polls from 0 and Telegram
   redelivers whatever it still holds, so a message handled just before a restart can be handled
   again. (v3 fixes this: the offset is stored in SQLite, `plan.md:39`, and `tg:<update_id>` dedupes,
   `plan.md:76`.)
7. Each iteration: `GetUpdates(ctx, offset, PollSeconds)`; if the context ended, return `ctx.Err()`
   (`:152-155`); on error record and `sleep(pollRetry(...))`, then `continue` (`:156-162`); on success
   reset the backoff, set `st.LastPollAt`, and `st.LastUpdateAt` when the batch is non-empty
   (`:163-169`).
8. For each update **in the order Telegram returned it**: `if u.UpdateID >= offset { offset =
   u.UpdateID + 1 }`, then `dispatch` (`:170-177`). The next `getUpdates` with that offset is what
   confirms the batch to Telegram, hence "handed out once" (`:170-171`).

Two consequences worth keeping: the offset advances **before** the update is handled (Go has no
durable submit, so this is the only ordering that avoids double handling within a process), and
updates of one batch are dispatched strictly in order.

**v3:** submit first with `requestId "tg:<update_id>"`, *then* advance the stored offset
(`plan.md:76`; the adapter's field is `SubmitOptions.requestId`, `adapter.ts:385-386`). A duplicate
`update_id` after a crash must therefore answer from the submission record and send nothing new
(`plan.md:125`: "duplicate update once; crash before the offset moves → processed once").

### 2.2 `allowed_updates`

Always exactly `["message","callback_query"]` (`client.go:255`). Everything else Telegram can send
(`edited_message`, `my_chat_member`, `channel_post`, `inline_query`, …) is never delivered. A second
belt: `dispatch` ignores an update that is neither a `message` nor a `callback_query` with a message
(`bot.go:306-310`, "anything else: ignored on purpose").

### 2.3 Shutdown

`Run` returns when its context ends. Workers are not cancelled: `work` runs each turn on
`context.WithoutCancel(ctx)` with its own 15-minute timeout (`bot.go:341-344`), and when the context
ends it drains what is already queued and handles it (`:346-355`). `Bot.Wait(15 s)` is called by
`main.go:187-189` after the HTTP server has shut down; a timeout logs `telegram bot still busy at
shutdown; a turn may have been cut short`. `TestShutdownFinishesTakenTurns` (`bot_test.go:574-616`):
two updates are polled, the context is cancelled while the first is in flight, and both are answered
and both entries saved.

Rationale to keep in v3: once polled past, Telegram will not redeliver; so the turn must finish. v3's
durable submit makes the same guarantee differently (the submission is durable), so a killed pod may
still lose the *reply* of an un-submitted update — which the offset discipline prevents.

---

## 3. Auth — T4.2

### 3.1 The allowlist (`authorise`, `bot.go:252-274`)

Input: the resolved `settings.Telegram` — `{users:[{id:"<int64 as string>",name}], groups:["<negative
int64>"], fromEnv}` (`internal/settings/telegram.go:24-28`), resolved per call with
`ResolveTelegram(ctx)` (`:178-180`). `UserName(from.ID)` returns the configured **name**, which is
what every write records as `by` (`:31-39`); `GroupAllowed(chat.ID)` compares the decimal string
(`:42-50`).

Decision table, in this order:

| Condition | Result |
|---|---|
| `from == nil` or `from.IsBot` | refused, reason `not from a person` (`:253-255`) |
| `chat.type == "private"` and (`from.ID` not on the list **or** `chat.ID != from.ID`) | refused, reason `user not on the allowlist` (`:257-262`) |
| `chat.type` is `group`/`supergroup` and the chat ID is not on the group list | refused, reason `group not on the allowlist` (`:263-266`) |
| group, allowed, but the user is not on the list | refused, reason `user not on the allowlist` (`:266-269`) |
| any other chat type (`channel`, `"s"`, …) | refused, reason `unsupported chat type <type>` (`:270-272`) |
| otherwise | allowed; `name` is the configured name |

So a private chat needs only the user; a group needs the group **and** the user; an empty user list
allows nobody (`internal/settings/telegram.go:21-23`). In a private chat the bot also requires
`chat.ID == from.ID`, so a forwarded/asymmetric private update cannot masquerade.

Auth runs **twice** for messages: in `dispatch` before queueing (`:311-319`) and again in `handle`
when the update reaches the front of the chat queue, because the allowlist may have changed while it
waited (`:387-392`). Both call `reject` with the same reason, and the rejected list dedupes by
`(chatId, fromId)` (§3.2), so a double rejection is one row.

`TestAuthorisation` (`bot_test.go:348-384`): four updates — unknown user privately, allowed user in an
unlisted group, stranger in the allowed group, allowed user in the allowed group. Exactly one reply
(threaded, `ReplyTo == 7`), exactly one entry (`By == "Partner"`), and the three refusals appear with
their exact reasons; the log contains `"msg":"telegram message ignored"`.

### 3.2 The rejected list

`Rejected` (`bot.go:62-72`), JSON with the two IDs as **strings** and times as RFC 3339:

```
{"chatId":"-1001","chatType":"supergroup","chatTitle":"Reno","fromId":"333","fromName":"Stranger (@stranger)","reason":"user not on the allowlist","at":"2026-11-22T…Z"}
```

`chatId,string` / `fromId,string` (`:63`, `:66`), `chatTitle,omitempty` (`:64`), `fromName,omitempty`
(`:67`), `reason` (`:68`), `at` (`:69`).

`reject` (`bot.go:276-292`): builds the entry (`ChatID, ChatType=m.Chat.Type, ChatTitle` from the chat;
`FromID/FromName` only when `from != nil`), logs
`telegram message ignored` with `reason, chatId, chatType, chatTitle, fromId, from` (`:281`), then
prepends it and keeps at most **10** (`maxRejected`, `:86`) entries, dropping any older entry with the
same `(ChatID, FromID)` (`:284-290`). Newest first, deduplicated, bounded.

Not recorded: updates from bots (`dispatch` skips `reject` when `from == nil || from.IsBot`, `:312-314`).
Reset to `[]` at every `Run` start (`:134`), so a restart empties it — it is an operator aid, not
storage. `Status()` copies it (`append([]Rejected{}, …)`, `:111`) so the JSON is `[]`, never `null`.

Callers of `reject`: a refused message (`:313`), a refused callback whose *message* is set
(`:313-318`), and the supergroup migration (§3.4).

**Where the web view reads it:** `GET /api/admin/telegram` → `status.rejected`
(`internal/server/admin.go:167-187`). The page (`app/static/index.html:1246-1258`) renders, per row,
`Private chat` or ``Group “<chatTitle||chatId>” (<chatId>)``, then `· <fromName> (<fromId>)` when a
name is known, then `reason · ago(at)`, plus two buttons: `Add <first word of fromName>` when
`fromId != "0"` and the user is not on the draft list, and `Add this group` when `chatType !=
"private"` and the group is not on the draft list. Those buttons only fill the draft inputs; saving is
the normal `PUT /api/settings/telegram`. This is how an operator learns a new group's chat ID.

The status line uses the rest (`app/static/index.html:1183-1186`): `tokenSet` false → `The bot is off:
TELEGRAM_BOT_TOKEN is not set on the server. You can still prepare the lists below.`; `running` →
``Running as @<botUsername>. `` + `Last message <ago>.` or `No messages yet.`; then
`` Last error <ago>: <lastError>`` when set.

### 3.3 Settings the bot reads, and how changes arrive without a restart

| Read | Where | Used for |
|---|---|---|
| `Settings.ResolveTelegram(ctx)` | `bot.go:254` (authorise), `docs.go:25` (notices), check-in `checkin.go:45` | users, groups, for every message and every notice |
| `Settings.Resolve(ctx)` | `bot.go:421` | the LLM connection for each turn; the bot then forces `cfg.Streaming = false` (`:422`) |
| `Settings.ResolveCheckin(ctx)` | `checkin.go:346` | T5.1 only |
| `Agent.Loc` | `commands.go:87`, `checkin.go:35-41` | the zone for `/recent` timestamps and the check-in day |

No allowlist is cached in the bot: `authorise` resolves on every update, so a save applies to the
next message. The settings **service** caches `settings.json` for `CacheTTL = 30 s`
(`internal/settings/settings.go:119-122`, `:208-214`) but its own save re-reads into the cache
immediately (`remember` on write, `:271`), so:

- a save in the **same** process is live at once;
- a save by the other process (dev vs prod on one bucket) is live within 30 s.

`TestAllowlistChangeAppliesWithoutRestart` (`bot_test.go:457-480`): a stranger is refused; the
allowlist is saved through `SaveTelegram` adding them (and dropping the partner); their next message
is handled (`By == "Helper"`) and the dropped partner's is refused in the same process lifetime.

`TELEGRAM_ALLOWED_IDS` / `TELEGRAM_ALLOWED_CHATS` are the env-level list, parsed from
`id=name,id=name` and `-100…,-100…` with a bare id doubling as its name
(`internal/settings/telegram.go:128-153`); the saved `telegram` section replaces them entirely and
`useEnv:true` deletes it (`:192-213`). Parsing is validated at startup — a bad list fails
`loadConfig` (`internal/config/config.go:118-121`) — and re-validated on every resolve, a
hand-edited invalid section falling back to env with one warning
(`internal/settings/telegram.go:167-173`).

### 3.4 Group → supergroup migration

A service message carrying `migrate_to_chat_id` (Telegram changes a group's ID when it is upgraded)
is handled in `dispatch` before auth (`bot.go:300-304`): it logs `telegram group was upgraded to a
supergroup; its chat ID changed. Add the new ID on the admin page.` with `oldChatId`/`newChatId`, and
records a rejection **for the new chat ID** (`Chat{ID: m.MigrateToChatID, Type: "supergroup", Title:
m.Chat.Title}`, reason `group upgraded: new chat ID`) so the operator can add it from the admin page.
Nothing is sent. A migrated group's bot is silent until the new ID is on the list — that is the
documented behaviour, not a bug.

---

## 4. Message intake — T4.2

### 4.1 What counts as a message (`handle`, `bot.go:376-405`)

`handle` first installs a `recover()` that logs `telegram handler panicked` and swallows the panic
(`:377-381`), then:

1. `u.CallbackQuery != nil` → `handleCallback`, return (`:382-385`).
2. Re-authorise (`:387-392`), `reject` and return on failure.
3. `text := strings.TrimSpace(m.Text)` (`:393`). **`Caption` is not part of it.**
4. Empty text → if `m.Document != nil || len(m.Photo) > 0 || m.Voice != nil`, reply exactly
   `I can only read text for now. Drawings, photos and voice notes are coming.` (`:395-397`);
   otherwise stay silent (`:398`). Either way, no entry, no agent call.
5. Text starting with `/` → `command` (`:400-402`).
6. Anything else → `converse(..., think=false)` (`:404`).

Consequences, all deliberate in Go and all that v3 keeps unless a decision says otherwise:

- **A photo or document with a caption gets the "I can only read text" line**: the caption is never
  read (`client.go:41` decodes it; nothing else references it).
- **No file is ever downloaded during a turn.** `GetFile`/`Download` exist and are tested
  (`client_test.go:246-267`) but no bot path calls them — they are there for a future feature.
- **No image reaches the agent.** `plan.md:73` is about images a *tool* returns. v3's
  `SubmitOptions` (`adapter.ts:384-404`) has no image field, so Telegram images stay text-only in
  T4; adding them would be an adapter change and is not in the plan.
- A whitespace-only message with no attachment is silently dropped (`:393-399`).
- `TestNonTextAndStatusHasNoToken` (`bot_test.go:520-530`): a document message gets exactly one reply
  containing `only read text`, and creates no entry.

### 4.2 Mentions and replies in groups

There is **no** mention handling and **no** reply-threading awareness:

- The bot reads ordinary group messages because BotFather's privacy mode is disabled
  (`.env.example:42-44`); it does not require `@botname`.
- `Message` has no `reply_to_message` field (`client.go:35-51`), so a message that quotes another
  message is handled as plain text — the quoted text is not passed to the model.
- The only `@` handling is on commands: `/cmd@otherbot` is ignored (§6.1).
- Whether the bot answers at all in a group is the **model's** decision (group silence, §5.5).
  `TestGroupChatterGetsNoReply` (`bot_test.go:446-455`): "chat about dinner" (no reply) then "what's
  up?" (reply) → exactly one message, threaded under the second (`ReplyTo == 21`).

### 4.3 The per-chat conversation Go keeps (`bot.go:409-457`, `:461-477`)

In memory, per chat ID, lost on restart (`agent-spec.md` §2.2):

```
type chatHistory struct { turns []agent.Turn; last time.Time }   // bot.go:55-58
```

- **The request's turns** = a copy of the chat's history **plus** the new user turn (`:416-418`).
  `Turn{Role:"user", Content: text}`, and in a group `Content = name + ": " + text` (`:410-415`).
- **`Run`** is called with `agent.Request{By: name, Channel: "telegram", Group: group, Think: think,
  Turns: turns}`, `cfg.Streaming = false` and a nil emit function (`:420-424`) — the same fields
  `agent-spec.md` §8 lists; v3's equivalents are `submit(key, text, {requestId, think, actor,
  group, display, onEvent})` (`adapter.ts:384-404`).
- **After the run**, the history is re-fetched (the check-in may have appended while the turn ran)
  and, only when `err == nil`: the user turn is appended "stays even when the bot keeps quiet", then
  the assistant turn **unless `res.Silent`**, then `agent.CleanTurns` (`:426-436`). `h.last = now()`
  is set **always**, including on failure (`:437`) — a failing chat never resets on every message.
- **A failed run is not remembered**: neither the user turn nor an assistant turn is appended (the
  whole `if err == nil` block is skipped, `:430-436`). The person can just repeat the message.
- **`CleanTurns`** (`internal/agent/history.go:5-35`): keeps only `user`/`assistant` turns with
  non-blank content, cuts each to 4000 **runes** (`:23-25`), keeps the last **12** (`MaxTurns`, `:6`,
  `:28-30`), then drops leading turns until the first is `user` (`:31-33`).
- **Idle reset** (`historyFor`, `:461-477`): a new empty history starts when
  `now - last > IdleReset`, default **2 hours** (`:468-470`); `main.go:126` never sets `IdleReset`, so
  2 h is what ran in production. The reset is invisible to the user: the entries are the memory.

**v3 changes this** (`plan.md:52`, `decisions.md:27`, `decisions.md:104`): one durable conversation
per chat (`tg:<chat_id>`), history in SQLite surviving restarts, idle reset **6 h**
(`IDLE_RESET_MS`), **no** 12-turn trim (compaction instead), and the typed text and the model's text
may differ (`display`). The bot must not keep its own `chatHistory`; it asks the adapter. Two Go
properties still hold and need tests: a group's user content is `"<name>: <text>"`, and a silent
answer leaves the user turn in history.

### 4.4 Concurrency: one queue per chat, chats in parallel

- `dispatch` lazily creates, per chat ID, a buffered channel of **64** updates and one worker
  goroutine (`bot.go:320-328`); a full queue **drops** the update with
  `telegram chat queue full, dropping update` (`:329-333`). Dropping is accepted: Telegram has
  already been told it was consumed (the offset moved).
- `work` handles one update at a time per chat, in arrival order (`:339-363`). Different chats run in
  parallel.
- `TestOneChatIsSerialisedTwoChatsRunInParallel` (`bot_test.go:414-444`): with a 250 ms model delay,
  max in-flight for two group messages is 1, and the second turn's request carries
  `ZY: first thought | Partner: second thought` (shared history, speaker prefixes); then two private
  chats reach max in-flight ≥ 2.

**v3:** per-key serialisation is the adapter's chain (`decisions.md:116`), so the bot must submit
per chat and never rely on its own queue for ordering; the "one key at a time" rule also means a
second message in a chat waits for the first, which is the observable half of this test. "Two chats
run in parallel" is in `plan.md:125`'s verify list.

### 4.5 Turn timeout and the watchdog (`bot.go:85-94`, `:341-344`)

```
	maxRejected    = 10
	maxMessage     = 4000   // Telegram allows 4096; leave room
	maxUndoButtons = 8
	// turnTimeout bounds one message's work, which is not cancelled on
	// shutdown (Telegram won't redeliver an update once polled past). A
	// local thinking model can take minutes per round.
	turnTimeout = 15 * time.Minute
```

Each turn runs on `context.WithTimeout(context.WithoutCancel(ctx), turnTimeout)` — 15 minutes, not
cancelled by shutdown. There is no other watchdog: the `Run` loop is not blocked by a turn (workers
are separate goroutines), so polling continues while a turn runs.

**v3:** `plan.md:125` requires a "15-minute watchdog abort": pi-durable has no per-turn timeout, so the
bot must watch its own `submit()` and abort (`AbortSignal` in `SubmitOptions.signal`, whose semantics
are `decisions.md:114`: `submission.abort()`, then `conversation.abort()` on `already_placed`) at 15
minutes, then deliver a failure line via §5.6. Keep 15 minutes; keep "shutdown does not cancel a
turn in flight" — the durable submit already survives a restart, so the drain is not needed.

### 4.6 Typing indicator (`bot.go:479-494`)

`typing` starts a goroutine that sends `sendChatAction` with `"typing"` **immediately**, then every
**4 s**, until the returned cancel func is called; every send error is ignored (`_ =`). The bot calls
`stop := b.typing(ctx, m.Chat.ID)` right before `Run` and `stop()` right after (`:420`, `:424`), so
the indicator runs for the whole turn, including tool rounds. Nothing else sends a chat action.

### 4.7 `/think`

`/think <question>` runs the *same* `converse` with `think=true` (`commands.go:53-58`), which only
changes `Request.Think`. A bare `/think` answers
`Put your question after /think, e.g. /think which countertop fits our budget better?` (`:54-57`) and
does not call the model. The command word is matched case-insensitively (`:52`) and the rest of the
message is `strings.TrimSpace(text[len(word):])` (`:43-44`), so `/think\nrecord Compare quotes` sends
`record Compare quotes`.

`TestThinkCommand` (`bot_test.go:618-651`): a plain message sends `chat_template_kwargs
{enable_thinking:false}` (i.e. `Think` off) and the `/think` message sends no `enable_thinking`
(thinking on), reaches the model **without** the command prefix, and a bare `/think` gets the hint
instead of a request. In v3 this is `submit(..., {think: true, display: "/think …"})` —
`decisions.md:167` (the transcript keeps what was typed, the model sees the rest).

---

## 5. Replies — T4.3

### 5.1 Delivery: `reply` (`bot.go:596-613`)

```
parts := split(text, maxMessage)                  // maxMessage = 4000
for i, p := range parts:
    sm = SendMessage{ChatID: m.Chat.ID, Text: p}
    if i == 0 && m.Chat.IsGroup(): sm.ReplyToMessageID = m.MessageID
    if i == len(parts)-1:          sm.ReplyMarkup = kb
    on error: setErr, log "telegram sendMessage failed", return   // the remaining parts are NOT sent
```

- Parts are sent **sequentially, in order**, one `sendMessage` each.
- Threading: the first part is a reply to the triggering message **only in groups**; in a private chat
  `reply_to_message_id` is omitted (`bot_test.go:303-320` asserts `ReplyTo == 0` privately and
  `ReplyTo == 7` in a group).
- The inline keyboard goes on the **last** part only.
- A failure aborts the remainder: the user sees a truncated answer, `LastError` is set. This is the
  seam v3 replaces with the at-least-once delivery task (`plan.md:77`): each chunk is its own durable
  step so a crash mid-send repeats at most the chunk in flight.

### 5.2 `split` — the exact algorithm (`bot.go:615-636`)

```
split(text, n):
  r = runes(text)                       // code points, never bytes
  out = []
  while len(r) > n:
     cut = n
     for i = n down to (n/2 + 1):       // i > n/2, so the second half of the window
         if r[i] == '\n': cut = i; break
     out.append(TrimRight(string(r[:cut]), "\n"))   // all trailing newlines removed
     r = r[cut:]
     while len(r) > 0 && r[0] == '\n': r = r[1:]    // and all leading newlines of the rest
  if len(r) > 0 || len(out) == 0: out.append(string(r))
  return out
```

Properties (each pinned by `TestSplit`, `bot_internal_test.go:10-27`):

- Never splits a rune in half; a hard cut ignores newlines and cuts at `n` code points
  (`split(strings.Repeat("é", 25), 10)` → three parts of 10, 10, 5 runes, `:21-25`).
- Prefers the **last** line break within `(n/2, n]`, so a chunk is never shorter than half the window
  unless the text has no break at all (`split("aaaaaaa\nbbbbbbbbb\ncc", 10)` →
  `["aaaaaaa","bbbbbbbbb","cc"]`, `:16-20`).
- The newline at a break is consumed (both sides trimmed), so the reconstruction is *not* the original
  text: a blank line at a split point disappears.
- `split("", 10)` → `[""]` (`:15-17`) — one empty part, which `reply` would send as an empty message
  (Telegram answers 400). Callers never pass empty text today; keep it that way.
- Only a *reply* is split. Change lines, help text and command answers go through the same `reply`.

**v3 note (`plan.md:127` says "splitting at 4096"):** Go uses **4000**, leaving 96 of headroom for
the Bot API's 4096. Use 4000 and the same algorithm unless the brief deliberately changes it; if the
limit changes, the tests that pin the algorithm's shape do not.

### 5.3 Plain text, no parse mode

`SendMessage` has no `parse_mode` (`client.go:123-128`, comment "Text is sent as plain text (no
parse_mode), so nothing in it needs escaping"). `TestSendMessageAndButtons` (`client_test.go:114-150`)
asserts `b["parse_mode"] == nil`. Every message the bot sends — help text, change lines, errors,
document lists — is sent as-is. **No Markdown or HTML escaping exists anywhere in the package.**

### 5.4 Change lines and the Undo keyboard

`changeText` (`bot.go:496-503`): one `"• " + c.Text` per change, joined with `"\n"`. `c.Text` is
`agent.ChangeText` (`internal/agent/tools.go:355-…`, ported as `entries/changetext.ts`), e.g.
`Saved: note · Fluted glass door`, `Updated: Nook (status done, room flex)`,
`Undone: removed Fluted glass door`.

`undoKeyboard` (`bot.go:505-534`):

- Only changes with a non-empty `ID` get a button (`:507-511`); `set_dates` is the case with no id, so
  a reply that only set dates has no keyboard.
- At most **8** buttons (`maxUndoButtons`, `:86`, `:515-517`); later changes stay in the text but get
  no button.
- Label `Undo` when there is exactly one id, else `Undo 1` … `Undo 8` (`:519-524`) — `fmt.Sprintf("Undo
  %d", i+1)`, 1-based.
- `callback_data` = `"undo:" + id` (`:524`).
- Layout: **4 per row**, as many rows as needed (`:526-532`).

`TestUndoKeyboard` (`bot_internal_test.go:29-45`): nil changes or no ids → `nil`; one id → one row,
`Undo`/`undo:a`; ten ids → 8 buttons in 2 rows of 4, the 8th labelled `Undo 8`.

The 64-byte callback-data limit: Go never checks it. `undo:` + Go's 26-char ULID = 31 bytes; v3's
change ID is exactly 26 base32 chars (`plan.md:71`) → **31 bytes**, and the same for the check-in's
`ci:<op>:<id>:<YYYYMMDD>[:<days>]` at most 44 bytes (`checkin.go:132-134`). A v3 change that lengthens
the change ID breaks the button, not a test.

### 5.5 Group silence (`NO_REPLY`, `Silent`)

`res.Silent` → `return` before any send (`bot.go:449-451`); nothing is sent, but the user turn stays
in history (`:431`). Go's `Silent` is set only inside `turn.finish`: the reply
`strings.Contains(..., "NO_REPLY")` **and** `Request.Group` **and** no changes
(`internal/agent/agent.go:236-242`). The marker is `NO_REPLY` (`internal/agent/prompt.go:19`).

v3: the rule already lives in `reply.ts` — `channelReply(run, model, group)` returns `{outcome,
silent}`, and `decisions.md:190` fixes the reading (a group reply containing the marker among other
words is silent; with changes it never is). `plan.md:79`'s "a `stay_silent` tool" is **not** how it is
implemented; do not add a tool. The bot must call `channelReply(..., true)` for groups and send
nothing when `silent` is true: no `sendMessage` at all, and no failure line.

`TestGroupChatterGetsNoReply` (§4.2) is the end-to-end version; `agent_test.go:292-313` (agent-spec
§4.6) is the rule.

### 5.6 The failure line (`bot.go:440-447`)

```
msg := "Sorry, that didn't go through: " + truncate(err.Error(), 300)
if len(res.Changes) > 0 {
	msg += "\n\nSome changes were saved before it failed:\n" + changeText(res.Changes)
}
b.reply(ctx, m, msg, undoKeyboard(res.Changes))
```

`truncate(s, n)` (`:638-644`) counts **runes** and returns at most `n` runes, the last replaced by
`…` (`"…"`, U+2026): `if len(r) <= n { return s }; return string(r[:n-1]) + "…"`.

So the failure line is the detail after `Sorry, that didn't go through: `, cut to 300 characters, plus
the change block and its Undo buttons when something was saved before the failure. The changes are
kept, which is why the Undo buttons matter.

**v3:** `plan.md:77` replaces the detail with "the fixed failure line from the host". Decide the exact
wording in the T4.3 brief and keep the shape: `Sorry, that didn't go through: <detail>`, then
`\n\nSome changes were saved before it failed:\n` + the change lines, then the keyboard.
`agent-spec.md:1186` says these shared texts belong in a module both channels import. The detail must
be scrubbed: pi-durable's reasons are a closed vocabulary (`decisions.md:106`) and `reply.ts` already
passes `run.detail` through the key scrub for the web route.

### 5.7 Edits, streaming, trimming

- **No streaming in Go**: the bot waits for the whole answer, then sends it in parts (`:452-456`). No
  `editMessageText`, no progressive update, no "Thinking…" placeholder.
- The only edit the bot ever makes is `editMessageReplyMarkup` to drop a pressed button (§7).
- **No trimming of leading blank lines in Go** — `out := res.Reply` is sent as-is (`:452`). T0.3 saw a
  `/think` reply begin with blank lines (`progress.md`, T0.3 "the think-turn reply began with blank
  lines → trim before delivery (T4.3)"). So: v3 **does** trim leading blank lines before delivery, a
  deliberate difference; keep the rest of the bytes unchanged.
- The successful reply is `res.Reply`, and when changes exist `"\n\n" + changeText(changes)` is
  appended before sending (`:452-456`), with `undoKeyboard(changes)` on the last part.

---

## 6. Commands — T4.4

### 6.1 Parsing (`commands.go:42-72`)

```
word := strings.Fields(text)[0]                 // text was TrimSpace'd in handle
rest := strings.TrimSpace(text[len(word):])
cmd, target, _ := strings.Cut(strings.TrimPrefix(word, "/"), "@")
if target != "" && me != "" && !strings.EqualFold(target, me) { return }   // another bot's command
switch strings.ToLower(cmd) { … }
```

- `me` is `st.BotUsername` from `getMe` (`:46-48`), so a `/cmd@bot` is only ignored when the username
  is known; before `getMe` succeeds no command can arrive (polling starts after it).
- The command word is lower-cased for the switch, so `/HELP` works. The `default` branch prints the
  **original** casing: `I don't know /<cmd>. Send /help to see what I can do.` (`:69-70`).
- A message of just `/` gives `cmd == ""` → the `default` branch, `I don't know /. …`.
- Commands are also available in private chats; nothing is group-only.
- Commands never touch the chat history and never call the model (except `/think`).

Menu registration (`Commands`, `commands.go:15-22`), sent once per `Run` via `setMyCommands`, in this
order — **`/start` is not in the menu**:

| command | description |
|---|---|
| `think` | `Think it through first (slower), e.g. /think compare the quotes` |
| `recent` | `Show the last 10 changes` |
| `undo` | `Undo my last change` |
| `sync` | `Re-read the documents now` |
| `checkin` | `Today's and yesterday's tasks, now` |
| `help` | `What I can do` |

### 6.2 Each command

Who may run them: whoever passes §3.1 — the same allowlist as messages, checked in `dispatch` and
again in `handle`. There is no admin-only command.

**`/start`, `/help`** (`commands.go:59-60`) — send `helpText` (`:24-40`) verbatim, nothing else:

```
Tell me what's happening with the renovation and I'll keep the record: ideas, decisions, quotes, payments, dates, open questions. Ask me anything about it too.

Examples:
• Thinking of fluted glass for the dry kitchen sliding door
• Lim quoted 18k for carpentry, paid 30% today
• Electrician coming Friday 2pm to check the DB
• What did we decide for the kitchen and what did it cost?

Every change comes back with an Undo button.
/think   start a message with it when I should think it through first (slower), e.g. /think compare the two zip blind quotes
/recent  the last 10 changes
/undo    undo your last change
/sync    re-read the documents now (they also sync every night)
/checkin today's tasks and yesterday's open ones, with Done buttons (also sent every morning)
/help    this message
```

(`/start` exists because Telegram's client offers it; it is the same text.)

**`/think <text>`** — §4.7.

**`/recent`** (`commands.go:74-98`) — the last **10** journal changes, newest first, from
`Entries.Recent(ctx, 10, "")` (`internal/entries/journal.go:112-126`, which walks the journal
backwards). Replies:

- read failure → `Couldn't read the history right now.` (`:76-79`)
- none → `Nothing has been recorded yet.` (`:80-83`)
- else `Last changes, newest first:\n` + one line per change (`:96`), each
  `fmt.Sprintf("• %s — %s%s, %s", ChangeText(c), c.By, via, at)` (`:94`) where `via` is `" (web)"`
  for `c.Channel == "web"` and `""` otherwise (`:90-93`), and `at` is `c.At` parsed as RFC 3339 and
  formatted `Mon 2 Jan 15:04` in `Agent.Loc`; if parsing fails the raw string is used (`:86-89`).
  Example line: `• Saved: note · Theirs — Partner, Wed 12 Nov 14:00`; a web change:
  `• Saved: note · From web — zy@example.com (web), Wed 12 Nov 14:00`.
- No keyboard (`nil`).

`TestCommands` (`bot_test.go:482-518`) pins: `/help` contains `Undo button`; `/recent` contains
`Saved: note · Theirs — Partner` and `From web — zy@example.com (web)`.

**`/undo`** (`undoLast`, `commands.go:100-116`) — undoes **the caller's own** latest change, matched
by `c.By == name` (`Entries.Recent(ctx, 1, name)`, `journal.go:120`), never someone else's:

- no change of theirs, or a read failure → `You have no recent change to undo.` (`:102-105`)
- `ErrUndoStale` → `Your last change was to an entry that has been changed again since, so I left it
  alone.` (`:107-108`)
- any other error → `Couldn't undo that right now.` (`:109-110`)
- success → `"↩ " + ChangeText(res.Changes[0])` with a one-button keyboard
  `undoKeyboard([{ID: res.Changes[0].ID, Text: line}])` (`:111-115`). **No speaker prefix in a group**
  (unlike the callback path, §7).

`TestCommands` pins that `/undo` after a `ZY` change and a newer `Partner` change removes `ZY`'s
(`Undone: removed Mine`) and leaves `From web,Theirs`.

Because it is "my latest change", a repeat press or a repeated update must not undo the *previous*
change: that is `decisions.md:29` ("Commands such as `/undo` stay at-most-once") and `plan.md:129`
("`/undo` twice undoes two different changes, never the same one"). Go gets this from
`requestId`-less at-most-once delivery inside one process; v3 must key the command on the
`update_id` and dedupe.

**`/sync`** (`docs.go:40-79`) — §8.

**`/checkin`** (`commands.go:67-68` → `checkinCommand`, `checkin.go:193-219`) — T5.1. What T4 must
leave room for: the command name must exist in `Commands` and in the switch, and `ci:`-prefixed
callbacks must be routed to the check-in handler before the `undo:` prefix is examined
(`bot.go:543-545`). T4 may implement `/checkin` as the "send it now" half only (`checkin.go:193-219`
works with `b.Checkin == nil`: it reads entries, skips the missed-days window, and sends) — but the
state (`checkin.json` claim, once-a-day loop) is T5.1.

**Unknown command** — `I don't know /<cmd>. Send /help to see what I can do.` (`:69-70`).

### 6.3 The `/recent` crash on a meta journal record

`ChangeText` (`internal/agent/tools.go:355-…`) handles `create`, `delete` and `undo`, then falls
through to a field-diff over `c.Before` and `c.After` (`tools.go:371-372`: `b, a := c.Before, c.After`
then `a.Archived`). A journal record with both nil — the old journaled `set_dates` meta record
(`op:"meta"`) — **panics** there; `/recent` is the only path that feeds an arbitrary record through
`ChangeText` without knowing the op, so `/recent` crashed on it whenever a meta record was among the
last 10 changes. The panic is caught by `handle`'s `recover` (`bot.go:377-381`), which logs
`telegram handler panicked` — so in Go the effect is a missing reply plus a log line, not a crash.

v3 no longer writes that record: `set_dates` is not journaled (`decisions.md:141`, `plan.md:72`), and
the TS `ChangeText` port is typed over the known ops. Keep the `recover`-equivalent (a failed command
must not kill the intake) and keep `/recent` tolerant of an unknown op — the bucket is shared with a
Go 1.0.x that can still write meta records during a rollback.

`TestCommands` covers `/recent` only over well-formed records.

---

## 7. Callbacks: the Undo button — T4.4

### 7.1 Routing and auth

`dispatch` accepts a callback only when `u.CallbackQuery.Message != nil` (`bot.go:306-307`), takes
`chat = Message.Chat` and `from = &CallbackQuery.From`, and authorises **the chat, not the button**
(`:307-318`). A refused callback is reported in the rejected list and answered with the toast
`You're not on this bot's list.` (`:315-317`).

`handleCallback` (`bot.go:536-592`) re-authorises (the allowlist may have changed while it queued),
and on failure answers the same toast and returns (`:538-542`) — `dispatch` has already answered the refuse-at-arrival case, so this
second check is what protects a callback that was queued before the allowlist changed.

Then: `ci:`-prefixed data → the check-in handler (§6.2, T5.1); `undo:`-prefixed → undo; anything else
→ `AnswerCallbackQuery(ctx, cb.ID, "")` — an **empty answer, no text, no message** (`:546-550`). That
"acknowledge and ignore" is what keeps an unknown or already-handled button from spinning the
client's spinner forever.

`TestUndoButtonRefusedForStrangerInGroup` (`bot_test.go:544-572`): a stranger in the allowed group
presses someone's Undo → exactly one callback answer containing `not on this bot's list`, and the
entry is unchanged.

### 7.2 The undo flow

```
res, err := b.Entries.Undo(ctx, entries.Actor{By: name, Channel: "telegram"}, id)   // :552
if err != nil:
    msg := "Couldn't undo that."
    ErrUndoStale        → "That entry was changed again since, so it can't be undone."   // :556
    ErrChangeNotFound   → "That change is too old to undo."                              // :558
    default             → log "telegram undo failed"; keep "Couldn't undo that."
    AnswerCallbackQuery(cb.ID, msg); return
line := agent.ChangeText(res.Changes[0])
AnswerCallbackQuery(cb.ID, truncate(line, 190))                                      // :567
// drop the pressed button, keep the others
if m.ReplyMarkup != nil:
    keep every button whose CallbackData != cb.Data, row by row; drop empty rows
    if no rows remain → markup = nil            → EditMessageReplyMarkup(...) sends {"inline_keyboard":[]}   // :569-586
who := ""
if m.Chat.IsGroup(): who = name + ": "
b.reply(ctx, m, "↩ " + who + line, undoKeyboard([{ID: res.Changes[0].ID, Text: line}]))               // :587-591
```

Pinned by `TestPrivateMessageSavesEntryAndUndoButtonWorks` (`bot_test.go:303-346`): after the press the
entry is gone, the toast contains `Undone`, exactly one `editMessageReplyMarkup` with an **empty**
`inline_keyboard` array, the confirmation starts with `↩ Undone: removed Fluted glass door`, the new
message carries one Undo button for the undo record itself, and the journal's newest record has
`By: "ZY"`, `Channel: "telegram"`.

Details that matter:

- The toast is the change line cut to **190** runes; the *message* carries the full line. The undo
  confirmation is a new message, threaded under the bot's message in groups, with its own Undo button
  (so an undo can be undone).
- A second press on the same button is the expected path: the record is still there
  but the entry has changed since → `ErrUndoStale` or, after a later change, `ErrChangeNotFound`;
  the button is answered, nothing is written.
- The button removal trusts `Message.ReplyMarkup` from the callback, i.e. what Telegram sends back —
  a bot message edited elsewhere may carry a different keyboard, and Go simply filters it.
- All callbacks are at-most-once in v3 (`plan.md:78`): a redelivered `callback_query` must answer from
  the recorded outcome, not undo again. In Go the guarantee came from the offset (§2.1).

---

## 8. The documents bits (`docs.go`)

`docs.go` is small and entirely the bot's: the notification to groups after a nightly sync, the
`/sync` command, and two formatters shared by both.

### 8.1 `DocsChanged` — the notice (`docs.go:18-38`)

`Syncer.Notify` is a one-method interface (`internal/docs/sync.go:44`, called at `sync.go:264-265`
**only when** `res.Changes()` and the run is not the first import). `main.go:130` sets `syncer.Notify =
bot`. Text:

```
text := "Documents updated: " + counts(res) + "\n" + docList(changed, 10)
```

sent with `sendMessage` to **every** chat in `Settings.ResolveTelegram(ctx).Groups` (`:25-37`),
skipping the group whose ID matches the reason's `telegram:<chatID>` suffix (`:20-23`, §6.2/`/sync`),
skipping unparseable IDs silently (`:28-31`), and on a send error recording `setErr` + logging
`telegram documents notice failed` with `chatId` (`:33-36`). Private chats never get the notice;
only groups.

### 8.2 `/sync` (`docs.go:40-79`)

```
if b.Docs == nil          → "Documents aren't switched on, so there's nothing to sync."
else if b.Docs.Running()  → "A sync is already running; I'll post the result when it's done."
else                      → "Syncing the documents…"
res, err := b.Docs.Sync(ctx, syncReasonPrefix + <chat id>)       // "telegram:-1001"
if err                    → "The sync didn't finish: " + truncate(err.Error(), 300)
total := count of ix.Docs with Status == StatusOK
if !res.Changes() && res.Failed == 0 → "No changes. <total> documents are readable."
else → "Synced: " + counts(res) + ". <total> documents are readable."
       + "\n" + docList(touched, 15)      (when the index was readable)
```

`touched` = every index doc whose `SyncedAt`, `RemovedAt` or `ErrorAt` equals `res.At` (`:71-77`).

Note the reply happens **after** the sync completes, so a slow sync holds the chat's queue for the
whole run; the "already running" branch replies at once and still runs its own `Sync`, which
single-flights inside the syncer and returns the current run's result (`internal/docs/sync.go:107`).

`TestDocumentSyncAndNotices` (`bot_test.go:693-734`): `/sync` in the group sends `Syncing…` then
`Synced: 1 added` + `Fridge.pdf`, and the first import posts **no** group notice; a later nightly sync
with a new document posts exactly one `Documents updated: 1 added` + `Oven.pdf` to the group; a no-op
`/sync` in a private chat answers `No changes. 2 documents are readable.` and sends no notice.

### 8.3 The two formatters

`counts(r docs.Sync)` (`docs.go:81-95`): joins non-zero counts in the order **added, changed, removed,
failed** as `"%d %s"` with `", "`; all zero → `nothing changed`.
Examples: `1 added`, `2 added, 1 failed`, `nothing changed`.

`docList(ds []docs.Doc, max int)` (`docs.go:97-119`): one `"• " + d.Name() + state` per doc, at most
`max`, then `…and <n-max> more` when more remain (`:99-103`). `state` is, in this order:

| Condition | Suffix |
|---|---|
| `Status == StatusRemoved` | ` (removed)` |
| `Status == StatusFailed` | ` (couldn't be read)` |
| `Error != ""` (an unreadable new version with the previous one kept) | ` (the new version couldn't be read; the previous one is still used)` |
| `Class == ClassScanned && Status == StatusOK && Error == ""` | ` (pictures only: not searchable yet)` |
| otherwise | `` (empty) |

`Doc.Name()` is the file name without folders (`internal/docs/index.go:100-101`).

**v3:** the docs routes and the syncer are T1.5/T5.2's (`docs-spec.md`); the bot's part is only these
two functions and the two senders, called from the durable `DocSync` task rather than from
`Syncer.Notify` if T5.2 moves it. Keep the bytes.

---

## 9. Status for the web admin view

### 9.1 What Go puts in it

> **Correction (T4.2b):** with no check-in configured (`b.Checkin == nil`), Go's `CheckinStatus` returns `&CheckinView{}`, i.e. `{"on":false}` plus the route's `setting` (`checkin.go:450-453`); `{"until":"20:00"}` only appears once the check-in exists (T5.1). The text below says otherwise; Go wins.

`Status` (`bot.go:74-83`), JSON in this field order:

| Field | JSON | Source |
|---|---|---|
| `TokenSet` | `tokenSet` | `API != nil && API.token != ""` (`:110`) |
| `Running` | `running` | set true after `getMe` (`:189`), false when `Run` returns (`:141-143`) |
| `BotUsername` | `botUsername,omitempty` | `getMe` username (`:189`) |
| `LastPollAt` | `lastPollAt,omitzero` | after every successful `getUpdates` (`:165`) |
| `LastUpdateAt` | `lastUpdateAt,omitzero` | when a batch was non-empty (`:166-168`) |
| `LastError` | `lastError,omitempty` | last error text, **never cleared** (`:115-120`) |
| `LastErrorAt` | `lastErrorAt,omitzero` | when that error happened |
| `Rejected` | `rejected` | `[]` never `null`; newest first, max 10 (§3.2) |

`Status()` is nil-safe: `if b == nil { return Status{Rejected: []Rejected{}} }` (`:103-109`) — that is
the "no bot" body `{"tokenSet":false,"running":false,"rejected":[]}` (`server-spec.md` §1.4).

`setErr` is called on: a failed `getMe` (`:194`), a failed `getUpdates` (`:157`), a failed
`sendMessage` (`:607`), a failed group notice (`docs.go:33`), and (T5.1) a failed check-in send. So the
admin page's "Last error" is whatever went wrong last — an old 409 lingers until the next error, since
success never clears it.

`CheckinView` (`checkin.go:434-445`) is `/api/admin/telegram`'s `checkin` object. For T4 only the
shape with a bot and no check-in matters: `CheckinStatus` returns `&CheckinView{Until: "20:00"}`
(`checkin.go:452-455`, with `sched.CheckinCutoff = 20`, `internal/sched/sched.go:41-43`), i.e. JSON
`{"until":"20:00"}`, and the route appends the editable `setting` after it
(`internal/server/admin.go:177-184`). No bot → `{"noBot":true}`.

### 9.2 Where the server reads it

`getTelegram`, `putTelegram` and `putCheckin` all answer the same `telegramView`
`{status, allowlist, checkin}` built from `s.Bot.Status()` and `s.Bot.CheckinStatus(ctx)`
(`internal/server/admin.go:167-215`). The bot only fills `b.st` under `b.mu`; nothing else in the
server touches it.

### 9.3 What the TS server has today (T2), and what T4 must supply

- `TelegramStatusSource` (`app/src/server/admin.ts:53-58`): `status(): Record<string, unknown>` —
  "Go's telegram.Status, an object in Go's field order: tokenSet, running, … rejected" — and
  `checkinStatus(): Record<string, unknown> | null` — "Go's telegram.CheckinView without `setting`,
  or null when there is no bot".
- `noBotStatus()` returns `{ tokenSet: false, running: false, rejected: [] }`
  (`app/src/server/admin.ts:136-141`); `telegramBody()` uses `o.telegram?.status() ?? noBotStatus()`
  and `o.telegram?.checkinStatus() ?? { on: false, noBot: true }` (`:145-158`).
- `main.ts:187` passes `telegram: null`; `config.telegramToken` is parsed (`app/src/config.ts:191`)
  and reaches no body and no log. `admin.test.ts:580-612` pins `tokenSet:false` for T2 and that the
  token is in neither answer nor log.

T4's job: build the bot when `config.telegramToken !== ""` and hand `startServe`/`ServerDeps` a
`TelegramStatusSource` that returns

- `status()` in Go's order with Go's omission rules: `tokenSet`, `running`, `botUsername` (when set),
  `lastPollAt` (when set), `lastUpdateAt` (when set), `lastError` (when set), `lastErrorAt` (when
  set), `rejected` (always an array; `chatId`/`fromId` as **strings**, `at` as Go's `time.Time` JSON);
- `checkinStatus()` → `{"until":"20:00"}` while the check-in is T5.1's (`checkin.go:452-455`), and
  `null` only when there is no bot at all.

Do not put the token in a field, a log line or an error (§1.4). The page's `tokenSet` branch
(`app/static/index.html:1183`) starts working as soon as that flips to `true`.

---

## 10. Every Go test in `internal/telegram`, mapped

| Test | Line | Asserts | Step |
|---|---|---|---|
| `TestGetUpdatesDecodesAndSendsOffset` | `client_test.go:78` | three updates decode (`message`, `callback_query` with `data:"undo:01ABC"`, `document`); `getUpdates` body has `offset:10`, `timeout:1`, `allowed_updates:["message","callback_query"]`; `Chat.IsGroup()` true for supergroup only | T4.1 |
| `TestSendMessageAndButtons` | `client_test.go:114` | `sendMessage` carries `chat_id`, `reply_to_message_id`, `reply_markup.inline_keyboard[[text,callback_data]]`, **no `parse_mode`**; `answerCallbackQuery` sends `text`; `editMessageReplyMarkup(nil)` sends `{"inline_keyboard":[]}`; `sendChatAction`, `setMyCommands` reach their methods | T4.1 |
| `TestAPIErrors` | `client_test.go:152` | 409 → `IsConflict`; 429 → `Code 429`, `RetryAfter 7`, not a conflict; 400 → code 400; a wrong token → 401 as `*APIError` | T4.1 |
| `TestTokenNeverInErrors` | `client_test.go:189` | refused connection, context deadline (still `errors.Is(…DeadlineExceeded)`), 502 HTML, undecodable result, download refused, download 404 — the token appears in no `Error()`, `%+v`, `%#v` or `Unwrap` level | T4.1 |
| `TestGetFileAndDownload` | `client_test.go:246` | `getFile` returns `file_path`; `Download` returns the bytes; `maxBytes` 5 → `ErrTooLarge` | T4.1 |
| `TestScrubControl` | `client_test.go:269` | control: the raw `http.Post` error **does** contain the token (proves the previous test bites) | T4.1 |
| `TestSplit` | `bot_internal_test.go:10` | short text one part; empty → `[""]`; prefers the last newline in the second half; hard cut by runes (`é`×25, 10 → 10/10/5) | T4.3 |
| `TestUndoKeyboard` | `bot_internal_test.go:29` | nil/no-id → no keyboard; one → `Undo`/`undo:a`; ten → 8 buttons, 4+4 rows, 8th `Undo 8` | T4.3 |
| `TestPrivateMessageSavesEntryAndUndoButtonWorks` | `bot_test.go:303` | status `running/botUsername/tokenSet`; a private message saves an entry `By:"ZY", Channel:"telegram"`, reply has the change line and one Undo button, not threaded; pressing it removes the entry, toasts `Undone`, empties the keyboard, replies `↩ Undone: removed …` with a new Undo, and the undo record is `By:"ZY"` | T4.2/T4.4 |
| `TestAuthorisation` | `bot_test.go:348` | the three refusal reasons, one reply only, threaded in a group, one entry, rejections logged | T4.2 |
| `TestConflictBacksOffThenRecovers` | `bot_test.go:386` | two 409s then recovery; `LastError` contains `409`; log contains `another poller` | T4.2 |
| `TestBotWritesReachSubscribers` | `bot_test.go:399` | a bot write pushes an entries snapshot to `Entries.Subscribe` (the web page updates) | T4.2 (shared service) |
| `TestOneChatIsSerialisedTwoChatsRunInParallel` | `bot_test.go:414` | max in-flight 1 within a chat; shared history with `ZY: …`/`Partner: …`; ≥2 across chats | T4.2 |
| `TestGroupChatterGetsNoReply` | `bot_test.go:446` | a chatty group message sends nothing; the question sends one threaded reply | T4.3 |
| `TestAllowlistChangeAppliesWithoutRestart` | `bot_test.go:457` | a saved allowlist applies at once in-process; a removed user is refused | T4.2 |
| `TestCommands` | `bot_test.go:482` | `/help` text; `/recent` lines incl. ` (web)`; `/undo` hits the caller's own change, leaves the others, and returns a button; `/recent@other_bot` ignored, `/sync@movin_test_bot` handled and threaded; no docs → `Documents aren't switched on` | T4.4 |
| `TestNonTextAndStatusHasNoToken` | `bot_test.go:520` | a document gets the "only read text" reply and writes nothing; `Status()` JSON and the log contain no token | T4.2 |
| `TestUndoButtonRefusedForStrangerInGroup` | `bot_test.go:544` | a stranger's press is answered `not on this bot's list` and changes nothing | T4.4 |
| `TestShutdownFinishesTakenTurns` | `bot_test.go:574` | both polled turns are answered and both entries saved after the context ends; `Wait(10s)` true | T4.2 |
| `TestThinkCommand` | `bot_test.go:618` | plain message → `enable_thinking:false`; `/think …` → no kwargs and the command stripped; bare `/think` → the hint and no request | T4.2 |
| `TestThinkCommandOnClaude` | `bot_test.go:653` | **Claude-only, deleted in v3** (`decisions.md` · LLM): `/think` → effort `high`, plain → `low` | — (do not port) |
| `TestDocumentSyncAndNotices` | `bot_test.go:693` | `/sync` replies and posts no notice on a first import; a nightly change posts exactly one notice; a no-op `/sync` says `No changes. 2 documents are readable.` and posts nothing | T4.4 (command half) / T5.2 (sync) |
| `TestCheckinDue` | `checkin_state_test.go:14` | 09:29 no, 09:30 yes, 14:00 yes (catch-up), 19:59 yes, 20:00 no, SGT↔UTC | T5.1 |
| `TestCheckinClaim` | `checkin_state_test.go:32` | first claim asks "yesterday only"; second claim while sending is refused; after finish refused; next day's `since` is the previous day; release → retry with the same window; a claim older than `StaleClaim` is taken over with the crashed window; a quiet day advances the window | T5.1 |
| `TestCheckinAfterAnUnfinishedDay` | `checkin_state_test.go:90` | a crashed, never-taken-over day: the next day asks from the crashed claim's `since` | T5.1 |
| `TestCheckinReleaseOfFirstEver` | `checkin_state_test.go:110` | releasing the first-ever claim leaves the day claimable | T5.1 |
| `TestCheckinOneWinner` | `checkin_state_test.go:127` | 8 concurrent claims on memory and on MinIO: exactly one winner | T5.1 |
| `TestCheckinCommandAndButtons` | `checkin_test.go:71` | summary text (`Good morning! Thu 12 Nov`, `• 14:00 Electrician`, `Not marked done yet (3)`, `Still overdue (1):`), 4 buttons with `ci:d:/ci:m:/ci:r:…:1/:7` data, three journaled changes with `✓ <name>: …` replies and Undo, stale press → `Already done.`, stranger press refused, undo of Done restores, no model call | T5.1 |
| `TestCheckinCapsAskMessages` | `checkin_test.go:173` | 10 open tasks → summary + 8 ask messages, the rest listed as `Also open from earlier days` | T5.1 |
| `TestCheckinQuietDayAndTypedReply` | `checkin_test.go:191` | quiet day text; the check-in enters the chat history so a typed reply reaches the model with it | T5.1 |
| `TestCheckinScheduleCatchUpOncePerDay` | `checkin_test.go:250` | not before the time, catch-up at 14:00, one per day even with a second app copy, next day's window | T5.1 |
| `TestCheckinTakesOverACrashedClaim` | `checkin_test.go:302` | a fresh foreign claim blocks; after `StaleClaim` this copy takes over and asks | T5.1 |
| `TestCheckinTooLateQuietAndFailure` | `checkin_test.go:337` | after 20:00 nothing and no record; a failed send releases the day and retries | T5.1 |
| `TestCheckinButtonAfterTheTaskMoved` | `checkin_test.go:394` | a moved task → `That task was moved since (Fri 13 Nov), so I left it.`; malformed data changes nothing | T5.1 |
| `TestCheckinDuringAnAgentTurnKeepsBoth` | `checkin_test.go:427` | a check-in landing mid-turn: the next request has both the message and the check-in | T5.1 |
| `TestCheckinChatMustBeAllowed` | `checkin_test.go:459` | a disallowed check-in chat → status error and nothing sent; fixed the same day → goes out at the next tick | T5.1 |
| `TestCheckinTimeFromSettings` | `checkin_test.go:494` | the time comes from settings, `off` sends nothing, turning it back on sends | T5.1 |
| `TestCheckinSkipsWhenSettingsUnreadable` | `checkin_test.go:534` | an unreadable `settings.json` skips (never falls back to defaults), the status says so, the last record still shows | T5.1 |

Two `bot_test.go` tests are **not** T4's: `TestThinkCommandOnClaude` (Claude removed) and
`TestDocumentSyncAndNotices`'s sync half (T5.2). The TS side will pin the ported cases in
`src/telegram/*.test.ts` (fake Bot API, as `bot_test.go:30-180`'s `fakeTG` does) plus the admin
cases already in `admin.test.ts`.

The fake API Go tests use (`client_test.go:30-80`, `bot_test.go:30-180`) is the shape to copy: paths
`/bot<token>/<method>` and `/file/bot<token>/<path>`, bodies decoded as maps, per-method handlers,
records of `sent []{chatId,text,replyTo,buttons}`, of callback answers and of keyboard edits.

---

## 11. Traps

1. **Offsets are per-process in Go and durable in v3.** Submit before advancing the stored offset
   (`plan.md:76`). Advancing first (Go's order, `bot.go:172-176`) loses the update on a crash;
   advancing after a failed submit re-handles it, which the `tg:<update_id>` dedupe absorbs — so the
   order is: submit, await acceptance, then advance.
2. **`allowed_updates` is not optional.** Without it, Telegram sends `edited_message` and
   `my_chat_member`, which Go's `dispatch` drops but which still advance the offset.
3. **`split` counts code points, Telegram counts UTF-16 code units.** 4000 runes of ASCII is fine
   (96 units of room); 4000 emoji is 8000 UTF-16 units and Telegram answers 400. Either keep 4000 and
   accept emoji-heavy failures (Go's behaviour) or count UTF-16 — but do not count bytes, and do not
   use JavaScript `String.length` on a chunk without deciding this (it happens to be UTF-16, which is
   the right unit; `[...s].length` is the wrong one for the limit).
4. **`split` eats newlines.** Both the trailing newlines of a chunk and the leading newlines of the
   rest are removed, so blank lines vanish at a split and the joined parts are not the input. A
   "rejoin and compare" test would fail.
5. **`split("")` returns one empty part** and `reply` would post an empty message. Keep every caller
   non-empty (Go's `finish()` guarantees it; v3's `replyText` does too).
6. **A failed `sendMessage` drops the rest of the reply.** Any v3 retry must be per chunk, and must
   not resend earlier chunks (§5.1).
7. **Plain text only.** No `parse_mode` means no escaping *and* no formatting; a change line's `·`,
   `—`, `↩`, `✓`, `•`, `★`, `…` are literal characters. Adding `parse_mode` would corrupt every
   entry title containing `*`, `_`, `[` or `<`.
8. **`truncate` is inclusive of the ellipsis**: `truncate(s, 300)` is at most 300 runes *with* `…`
   (i.e. 299 of the input). 190 for the callback toast.
9. **Callback data must stay ≤ 64 bytes.** `undo:` + 26 = 31; a bigger change ID silently makes the
   button unpressable (`BUTTON_DATA_INVALID` at send time, so the whole message fails).
10. **The whole answer's keyboard goes on the last chunk only**, and the first chunk is threaded in
    groups. Sending the keyboard on the first chunk breaks `bot_test.go:303`'s button assertions and
    threads the rest nowhere.
11. **Auth twice, and the second check is not redundant.** A queued message can outlive an allowlist
    change; Go re-authorises in `handle` (`bot.go:387-392`). v3's queue is the durable submission, so
    the check must run before submit (`plan.md:79`) — and a refusal must still be recorded in the
    rejected list *and* logged with the same `telegram message ignored` line.
12. **`chat.ID == from.ID` is required in private chats.** A private-chat update whose chat and sender
    differ is refused, not handled.
13. **Commands are matched case-insensitively but the unknown-command text echoes the original
    casing** (`/HELP` → help; `/Foo` → `I don't know /Foo.`), and commands for another bot are
    silently dropped — which must happen *before* any side effect (`/undo@otherbot` must not undo).
14. **`/undo` is per person and at-most-once.** It matches `c.By ==` the configured name, so a rename
    in Settings orphans that person's older changes; and a redelivered update must not undo again.
15. **The undo confirmation is a new message, the pressed button is removed by edit**, and the edit
    sends `{"inline_keyboard":[]}` — never an omitted `reply_markup`: the field is always sent,
    and `TestSendMessageAndButtons` pins the empty array. Omitting it is a different request.
16. **`answerCallbackQuery` must be called for every callback**, including unknown data (empty text)
    and refusals — otherwise the pressed button keeps its spinner until the client gives up.
17. **Group silence produces no message at all** — not an empty one, not a "…" and not a keyboard.
    And it is decided by `reply.ts`, not by a tool (`decisions.md:190`).
18. **`LastError` is never cleared**, so the admin page shows a stale 409 forever. If v3 wants a
    "healthy" view it must clear it on success — a deliberate difference, to be decided, not a port
    accident.
19. **`SetMyCommands` runs once per `Run`** and its failure is only a warning: a stale menu is
    possible after a deploy that renames a command.
20. **A failed turn is not added to the conversation** in Go (`bot.go:430-436`); v3's durable
    transcript keeps what the user typed regardless (the submit is the row). Do not copy Go's "drop
    the user turn on failure" — it would drop a message the person can see in the app's history.
21. **Typing indicators are unthrottled per chat but must stop**; Go ignores their errors. Two chats
    typing at once is two goroutines; there is no global rate limit and no backoff on 429 for
    `sendChatAction` (a 429 there is logged by nobody).
22. **`/recent` may see a Go-written meta record** while the bucket is shared; it must not crash
    (§6.3). Go survives only because of `recover`.
23. **`DocsChanged` sends to groups only**, skips the group that asked for the sync by string equality
    of the chat ID, and sends nothing when the syncer is the first import — three conditions that are
    easy to collapse into one.
24. **`counts()` is used in two sentences with different punctuation**: the notice uses
    `"Documents updated: " + counts`, `/sync` uses `"Synced: " + counts + ". "`. Do not unify them.
25. **`Chat.IsGroup()` excludes `channel`**, and `authorise` refuses a channel with `unsupported chat
    type <type>`. A port that treats "not private" as "group" would answer channel posts.
26. **`migrate_to_chat_id` must be handled before auth** — the old chat is on the list, the new one is
    not; handling it "as a message" would process the service message.

---

## 12. What I could not determine

- **The exact v3 wording of the failure line** (`plan.md:77` says "the fixed failure line", without
  text). Go's shape is §5.6; the T4.3 brief must fix the detail text.
- **Whether v3 keeps 4000 or moves to 4096** for the split (plan says 4096, Go uses 4000).
- **How the delivery task is expressed in pi-durable.** `durable-api.md` covers tool tasks
  (`createTask`/`getTask`/`waitForTask`, `sleepUntil`) but the plan's "durable delivery task" with
  at-least-once semantics per chunk has no worked example in the docs I read; T4.3 must decide whether
  it is one task per chunk keyed by `tg:<update_id>:<n>` or a task that owns the whole reply.
- **Whether Telegram's 429 arrives on `getUpdates` in practice** for a single poller (the code path
  exists; no Go test drives it through the bot).
- **What `Bot.Status()` should say after a bot that never started** (token present, `Run` not called):
  Go answers `tokenSet:true, running:false` — I did not check whether the page's `running` branch
  leaves a confusing line there.
- **The check-in's `until` in a v3 view before T5.1**: I assume `{"until":"20:00"}` from
  `checkin.go:452-455`; nothing in T2's tests pins it with a bot present.
