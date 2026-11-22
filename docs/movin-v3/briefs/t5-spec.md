# Spec: T5 — the check-in, the docs sync task, restore safety and Velero notes

Produced by code-explorer on 2026-11-23 from the frozen Go code (`internal/telegram/checkin.go`,
`checkin_state.go` and their two test files; `internal/sched/sched.go` + test; `internal/docs/schedule.go`,
`sync.go` (Notify) and `internal/telegram/docs.go` `DocsChanged`; `internal/settings/checkin.go`;
`internal/server/admin.go`; `cmd/movin/main.go`), plus the v3 side it must fit into:
`app/src/{sched,config,main}.ts`, `app/src/docs/{schedule,sync}.ts`, `app/src/settings/{checkin,settings}.ts`,
`app/src/entries/{agenda,service,model}.ts`, `app/src/telegram/{bot,commands,format,outbox}.ts`,
`app/src/server/admin.ts`, `app/src/durable/adapter.ts`, `app/src/objstore/*`, and
`app/node_modules/@earendil-works/pi-durable/dist/**/*.d.ts` (1.5.2, cited `D/…` = that `dist/`).
Where this file and the Go source disagree, the Go source wins; report the difference.

Scope: `plan.md:131-135` — T5.1 (check-in task), T5.2 (docs sync task), T5.3 (restore safety + Velero
notes) — against the Design section `plan.md:36-56` (Storage; Backup and restore) and
`decisions.md` entries for T5, check-in, restore, "T4 plan change", T4.2a and T4.3b. Everything here is
research: no step is decided in this file; where a decision is needed it is listed in §13.

The one structural change T5 makes: **Go ran two wall-clock loops in-process; v3 runs two durable
tasks, plus a restore path that runs before `resume()`.** Everything the user sees stays byte-identical
(the summary, the ask messages, the button data, the toasts, the notices); only *when* it is sent,
*where the state lives* and *what happens after a crash or a restore* change.

---

## 0. Line-number map (anchors used below)

| File | Anchors |
|---|---|
| `internal/telegram/checkin.go` | `Checkin` `:20-22`, constants `:24-30`, `ErrNoCheckinChat` `:33`, `loc` `:35-40`, `checkinChat` `:44-63`, `shortDay` `:66-72`, `agendaLine` `:74-83`, `checkinText` `:86-123`, `askText` `:125-131`, `askKeyboard` `:136-144`, `sendCheckin` `:149-180`, `remember` `:183-189`, `checkinCommand` `:193-217`, `checkinCallback` `:221-291`, `staleAsk` `:294-296`, `orNone` `:298-303`, `closeAsk` `:307-312`, `CheckinLoop` `:319-334`, `CheckinTick` `:337-415`, `warnCheckin` `:419-431`, `CheckinView` `:434-445`, `CheckinStatus` `:448-474` |
| `internal/telegram/checkin_state.go` | `CheckinKey` `:17`, statuses `:20-24`, `StaleClaim` `:28`, `CheckinRecord` `:31-41`, `CheckinStore` `:44-46`, `Load` `:50-63`, `Finished` `:66-68`, `Taken` `:72-81`, `NextSince` `:87-96`, `CheckinClaim` `:99-103`, `Claim` `:108-128`, `Finish` `:131-136`, `Release` `:141-146`, `put` `:148-155`, `stamp` `:157`, `CheckinDue` `:161-166` |
| `internal/sched/sched.go` | `Parse` `:14-29`, `NextRun` `:32-39`, `CheckinCutoff` `:43`, `Day` `:46`, `AddDays` `:49-55` |
| `internal/entries/agenda.go` | `MaxAskDays` `:10`, `Agenda` `:13-22`, `Doc.Agenda` `:30-63`, `when` `:66-72` |
| `internal/settings/checkin.go` | `DefaultCheckin` `:15`, `Checkin` `:18-29`, `ChatID` `:31-35`, `storedCheckin` `:36-41`, `CheckinInput` `:45-49`, `CheckinSetting` `:52-61`, `ParseCheckin` `:63-85`, `WithCheckinEnv` `:87`, `resolveCheckin` `:89-109`, `ResolveCheckin` `:111-117`, `ViewCheckin` `:119-127`, `SaveCheckin` `:129-150` |
| `internal/docs/schedule.go` | `DefaultSyncSchedule` `:11`, `Background` `:16-61` |
| `internal/docs/sync.go` | `Notifier` `:30-32`, `Syncer` `:41-54`, `MaxIndexRetries` `:63-64`, `Sync` `:75-104`, `Running` `:107-111`, `Subscribe` `:115-131`, `Index` `:134-152`, `Refresh` `:156-178`, `run` `:229-271`, `apply` `:285-…` |
| `internal/telegram/docs.go` | `syncReasonPrefix` `:14`, `DocsChanged` `:18-37`, `syncCommand` `:40-79`, `counts` `:81-95`, `docList` `:97-119` |
| `internal/telegram/bot.go` | `Bot` `:25-53`, `checkinDay`/`checkinWarned`/`checkinWarnDay` `:50-52`, `chatHistory` `:55-58`, `Status` `:74-83`, `maxMessage = 4000` `:87`, `remember`/`historyFor` `:183-189`/`:461-477` |
| `cmd/movin/main.go` | bot built `:124-138`, `bot.Checkin = …` `:129`, `syncer.Notify = bot` `:130`, `bot.Run` `:131-136`, `syncer.Background` `:172-179`, `go bot.CheckinLoop(ctx, time.Minute)` `:181` |
| v3 targets | `src/tasks/{checkin,docsync}.ts` (`plan.md:31`), `src/durable/adapter.ts` (the only pi-durable importer), `src/telegram/{bot,commands}.ts`, `src/docs/schedule.ts` |

---

## 1. Go's check-in, completely (`internal/telegram/checkin.go`)

### 1.1 The value and its constants

```go
type Checkin struct {
	State *CheckinStore
}
```
(`:20-22`.) It is nil on the `Bot` meaning "no check-in" (`bot.go:31`), and the bot only gets one when
`TELEGRAM_BOT_TOKEN` is set (`cmd/movin/main.go:129`).

```go
const (
	// maxAskMessages caps the per-task messages; the rest are listed.
	maxAskMessages = 8
	// maxOverdueTitles caps the overdue titles in the summary.
	maxOverdueTitles = 5
	checkinPrefix    = "ci:"
)
```
(`:24-30`.) `checkinPrefix` is the callback-data prefix (`ci:`), the one thing the port must keep byte
for byte: buttons already sitting in a chat since v1 must keep working after the cutover.

```go
// ErrNoCheckinChat means there is nowhere to send the check-in.
var ErrNoCheckinChat = errors.New("no group or person is allowed, and no check-in chat is set")
```
(`:33`.) The text goes straight onto the admin page (`CheckinView.Error`, §1.10).

`loc` (`:35-40`) is the app's time zone from `Bot.Agent.Loc` (the process `TZ`), UTC when the runner
has none. Every day/hour decision below reads through it.

### 1.2 Where it goes: `checkinChat` (`:44-63`)

Order, exactly:

1. `cfg.ChatID()` (the saved chat, `settings/checkin.go:31-35`, 0 when empty). If non-zero it **must** be
   on the allowlist — a configured name (`tg.UserName(id)`) or an allowed group (`tg.GroupAllowed(id)`).
   Not on it → error `the check-in chat %d is not an allowed group or person (Settings → Telegram)`.
   Reason, in the comment (`:42-43`): "every button press there would be refused".
2. Else the first parseable ID in `tg.Groups` (`strconv.ParseInt(g, 10, 64)`).
3. Else the first parseable `u.ID` in `tg.Users`.
4. Else `ErrNoCheckinChat`.

### 1.3 The texts (`shortDay`, `agendaLine`, `checkinText`, `askText`)

`shortDay(day string) string` (`:66-72`): parse `2006-01-02`, format `Mon 2 Jan` — e.g. `Thu 12 Nov`;
an unparsable day is returned unchanged.

`agendaLine(e entries.Entry) string` (`:74-83`): `title`, prefixed with `"<time> "` when the entry has
a time, suffixed with `" (<room>)"` when it has a room. So `14:00 Electrician` and
`Measure windows (living)`.

`checkinText(today string, ag entries.Agenda) (summary string, asks []entries.Entry)` (`:86-123`) builds,
in this order:

| Piece | Exact text |
|---|---|
| line 1 | `"Good morning! " + shortDay(today) + "\n"` |
| today, non-empty | `"\nToday:\n"` then per entry `"• " + agendaLine(e) + "\n"` |
| today, empty | `"\nNothing dated for today.\n"` |
| asks > 0 | `"\nNot marked done yet (%d), below. Tap a button or just tell me.\n"` with **`len(ag.Ask)`**, not the capped count (`:103`) |
| asks > 8 | the first 8 are the per-task messages; the rest become `"Also open from earlier days:\n"` then per entry `"• " + agendaLine(e) + " — " + shortDay(*e.Date) + "\n"` (`:105-110`) |
| overdue > 0 | `"\nStill overdue (%d):\n"` with `len(ag.Overdue)`; per entry `"• " + agendaLine(e) + " — " + shortDay(*e.Date) + "\n"`, and at index 5 the list stops with `"…and %d more\n"` (`n - maxOverdueTitles`) (`:111-120`) |
| last line | `"\nAnything else, just say it, e.g. \"move the tiler to Friday\"."` (`:121`) |

`askText(e entries.Entry, today string) string` (`:125-131`): `when + ": " + agendaLine(e) + "\nDone?"`
where `when` is `Yesterday` when `*e.Date == sched.AddDays(today, -1)`, else `shortDay(*e.Date)`. So
`Yesterday: Book movers\nDone?` and `Fri 13 Nov: Tiler\nDone?`.

### 1.4 The buttons (`askKeyboard`, `:136-144`)

```
base := e.ID + ":" + strings.ReplaceAll(*e.Date, "-", "")
```
one row, four buttons:

| Button text | `callback_data` |
|---|---|
| `Done` | `ci:d:<entry id>:<YYYYMMDD>` |
| `Done ★` | `ci:m:<entry id>:<YYYYMMDD>` |
| `Tomorrow` | `ci:r:<entry id>:<YYYYMMDD>:1` |
| `+1 week` | `ci:r:<entry id>:<YYYYMMDD>:7` |

The date is the one **as asked**, so a press after the task was moved elsewhere changes nothing
(`:133-135`). Entry IDs are 26-char ULIDs (`internal/entries/service.go:296`), so the longest data is
`ci:r:` + 26 + `:` + 8 + `:7` = 44 bytes; Go's comment says "at most 44 bytes (Telegram allows 64)".

### 1.5 Sending (`sendCheckin`, `:149-180`)

1. `checkinText` → `summary`, `asks`.
2. `split(summary, maxMessage)` with `maxMessage = 4000` (`bot.go:87`); each part is a plain `SendMessage`
   (no keyboard, no thread). The **first** part failing returns the error; a later part failing only logs
   `telegram check-in part failed` with `chatId`, `err` — the summary already reached the chat (`:154-159`).
   Every part is accumulated into `lead`.
3. Per ask: `askText` + `askKeyboard`, `SendMessage`; a failure logs
   `telegram check-in task message failed` with `chatId`, `entryId`, `err` and the task is left out of
   `asked` (`:163-171`). A success appends `"• " + strings.ReplaceAll(txt, "\nDone?", "")` to `asked`.
4. History (`:172-178`): `reply := lead`, plus `"\n\nAsked about:\n" + strings.Join(asked, "\n")` when
   anything was asked; then
   `remember(chatID, agent.Turn{Role:"user", Content:"(morning check-in)"}, agent.Turn{Role:"assistant", Content: reply})`.
   This is what makes a typed answer ("booked them") reach the agent together with the check-in it
   answers.
5. `remember` (`:183-189`) appends and `agent.CleanTurns`-trims the chat's in-memory history under the
   bot mutex and stamps `h.last = b.now()`.

Both `b.setErr(err)` calls (`:154`, `:166`) put the failure on the admin page's `lastError`, as every
send failure does.

### 1.6 `/checkin` — send it now (`checkinCommand`, `:193-217`)

1. `Entries.Current` failure → `Couldn't read the entries right now.` (plain reply, no history).
2. `today := sched.Day(b.now(), b.loc())`.
3. `since := ""`; if check-in state exists and `r.NextSince()` is non-empty and **strictly before**
   `sched.AddDays(today, -1)`, `since = that`. Days missed since the last check-in are asked about too
   (`:201-208`).
4. `ag := snap.Doc.Agenda(today, since)`; `ag.Quiet()` → `Nothing dated for today, and no open tasks from before.`
5. Else `sendCheckin(ctx, m.Chat.ID, today, ag)`; a failure logs `telegram check-in failed` with `chatId`,
   `err` (the user already saw whatever part went out).
6. **It does not touch the day's record** (`:191-192`): the scheduled one still goes out.

### 1.7 The `ci:` callbacks (`checkinCallback`, `:221-291`)

Parsing: strip `ci:`, split on `:`.

| Case | Behaviour |
|---|---|
| `len(parts) < 3` **or** `len(parts[2]) != 8` | bare `AnswerCallbackQuery(id, "")`, nothing else |
| `asked := parts[2][0:4] + "-" + [4:6] + "-" + [6:8]`; `!entries.ValidDate(asked)` | bare ack |
| op `d` | patch `{"status": "done"}` |
| op `m` | patch `{"status": "done", "milestone": true}` |
| op `r` with 4 parts | `days` from `parts[3]`; `days < 1 \|\| days > 31` → bare ack; patch `{"date": sched.AddDays(sched.Day(now, loc), days)}` |
| op `r` with 3 parts | `days = 0` → out of range → bare ack |
| any other op | bare ack |

Then a precondition evaluated **inside** the write, against the entry as it is then (`:254-266`):

| Condition | Answer (toast) |
|---|---|
| `e.Archived` | `That entry was archived.` |
| `e.Status == done` | `Already done.` |
| `e.Date == nil \|\| *e.Date != asked` | `That task was moved since (<shortDay(*e.Date) \| no date>), so I left it.` |

On success (`:270-279`): `line := agent.ChangeText(res.Changes[0])`; `closeAsk(ctx, cb, truncate(line, 190))`;
`who := ""` in a private chat, `name + ": "` in a group; and a reply
`"✓ " + who + line` carrying `undoKeyboard` for that one change.
Example lines pinned by the Go test: `✓ ZY: Updated: Book movers (status done)`,
`✓ Partner: Updated: Order tiles (status done, ★ milestone)`,
`✓ ZY: Updated: Measure windows (date 2026-11-19)`.

Failure branch (`:281-290`): a `staleAsk` toasts its own text; `entries.ErrEntryNotFound` toasts
`That entry is gone.`; anything else logs `telegram check-in update failed` with `by`, `entryId`, `err`
and toasts `Couldn't save that; try again or tell me in words.` — that last one is an
`AnswerCallbackQuery` with text, not `closeAsk`: the buttons stay.

`closeAsk` (`:307-312`): `AnswerCallbackQuery(cb.ID, text)`, then, **only when the pressed message had a
keyboard**, `EditMessageReplyMarkup(chat, messageID, nil)` — the buttons of that one message go, so the
task can't be answered twice (the other three messages keep theirs).

### 1.8 The loop and the tick (`CheckinLoop` `:319-334`, `CheckinTick` `:337-415`)

`CheckinLoop(ctx, every)`: returns at once when there is no `Checkin`; logs
`morning check-in loop running` with `until = "20:00"`; then `CheckinTick` immediately and on every
tick of a `time.NewTicker(every)` (the app passes `time.Minute`, `cmd/movin/main.go:181`). The comment
(`:314-318`) says why a wall-clock tick and not one long timer: "timers drift while a laptop sleeps …
if the app wasn't running at the scheduled time, the check-in goes out when it starts, until
`sched.CheckinCutoff`".

`CheckinTick`, in order:

1. `now := b.now()`; `day := sched.Day(now, b.loc())`.
2. `cfg, err := b.Settings.ResolveCheckin(ctx)`. On error it **skips the minute** and does not fall back
   to the defaults (`:344-353`): "a check-in saved as Off (or to a private chat) must not go to the group
   after one failed read". Logged through `warnCheckin("read", …)` as
   `morning check-in: couldn't read the settings; skipping this minute`.
3. `!cfg.On || !CheckinDue(now, cfg.Hour, cfg.Minute, loc)` → return (silently).
4. `b.checkinDay == day` (the per-process memory) → return.
5. `checkinChat` failure → `warnCheckin("chat", …)`:
   `morning check-in can't go out until this is fixed`, `err` = the §1.2 error. **Not** remembered as
   finished, so fixing the allowlist on the web page lets it go out the same day (`:369-374`).
6. `ci.State.Claim(ctx, day, strconv.FormatInt(chat, 10), now)`; an error logs
   `morning check-in: couldn't read or claim the day; will retry` and returns.
7. `claim == nil` (someone else has the day): if `cur.Finished(day)` mark the day finished for this
   process, then return. While another run's claim is fresh it keeps checking every minute, so a copy
   that crashed mid-send is taken over (comment `:361-362`).
8. `release(why, err)`: logs `"morning check-in: " + why + "; will retry"`, then `State.Release`; a
   Release failure logs `morning check-in: couldn't give the day back; it can be retaken in 10 minutes`.
9. `Entries.Current` failure → `release("couldn't read the entries", err)`.
10. `ag := snap.Doc.Agenda(day, claim.Record.Since)`; if quiet →
    `Finish(claim, CheckinQuiet)` (a failure logs `morning check-in: couldn't record a quiet day`), then
    logs `morning check-in: nothing to report today` with `day`, marks finished, returns.
11. `sendCheckin` failure → `release("couldn't send it", err)`.
12. `Finish(claim, CheckinSent)`; a failure logs `morning check-in sent but not recorded`.
13. Logs `morning check-in sent` with `day`, `chatId`, `today`, `asked`, `overdue` (the three agenda
    lengths), marks finished.

### 1.9 `warnCheckin` (`:419-431`)

One warning per `kind + " " + day`: a new day resets the map. A problem that persists for hours
(settings unreadable, chat not allowed) produces one line a day, not one a minute.

### 1.10 `CheckinView` for the admin page (`:434-474`)

```go
type CheckinView struct {
	On    bool           `json:"on"`
	At    string         `json:"at,omitempty"`    // HH:MM
	Until string         `json:"until,omitempty"` // HH:MM cutoff
	Chat  string         `json:"chat,omitempty"`  // where it goes
	Error string         `json:"error,omitempty"` // why it can't go anywhere
	Last  *CheckinRecord `json:"last,omitempty"`
	NoBot bool           `json:"noBot,omitempty"`
	Setting settings.CheckinSetting `json:"setting"`
}
```

`CheckinStatus` (`:448-474`): nil receiver → nil; no `Checkin`/`State` → `&CheckinView{}`, i.e.
`{"on":false}` (T4.2b already pinned that, `decisions.md:313`, `app/src/telegram/bot.test.ts:755-758`);
else `Until = "20:00"` (`fmt.Sprintf("%02d:00", sched.CheckinCutoff)`), `Last` from `State.Load` when
`r.Day != ""` (a load error is ignored here), then `ResolveCheckin`; its error goes to `Error` and the
view is returned **before** `On`/`At`/`Chat` are filled (`:459-463`). With `On` false, `At` and `Chat`
stay empty. `Setting` is filled by the server, not here (`internal/server/admin.go:177-184`).

Field order matters for the pinned JSON: `on`, `at`, `until`, `chat`, `error`, `last`, `noBot`,
`setting`. The TS `admin.ts` already appends `setting` after whatever the bot returns
(`app/src/server/admin.ts:147-156`), and with no bot it sends `{on:false, noBot:true}`.

---

## 2. The `checkin.json` claim protocol (`internal/telegram/checkin_state.go`)

The key is `checkin.json` in the bucket root (`:17`), **shared between the Go and TS dev apps and
production** — that is what makes "both due → one message". Deleting it means "not sent today"
(`:14-16`, `docs/admin-guide.md:377`).

```go
type CheckinRecord struct {
	Schema int    `json:"schema"`
	Day    string `json:"day"`             // YYYY-MM-DD in the app's TZ
	Status string `json:"status"`
	Since  string `json:"since,omitempty"`
	At     string `json:"at"`              // RFC 3339, when the status was set
	Chat   string `json:"chat,omitempty"`
}
```

Field order as above; `put` always sets `Schema = 1` and `json.Marshal`s (`:148-155`); `stamp` is
`t.UTC().Format(time.RFC3339)` — **seconds, no milliseconds** (`:157`).

Statuses (`:20-24`): `sending` (claimed, messages going out), `sent`, `quiet` (nothing to report; nothing
sent). `StaleClaim = 10 * time.Minute` (`:28`).

| Function | Rule |
|---|---|
| `Load` `:50-63` | `Get`; `ErrNotFound` → zero record and `""` ETag; a decode failure is `decode checkin.json: <err>` |
| `Finished(day)` `:66-68` | `r.Day == day && (status == sent \|\| status == quiet)` |
| `Taken(day, now)` `:72-81` | `Finished(day)`, or the same day with `sending` and `now.Sub(at) < StaleClaim` (an unparsable `at` is **not** taken) |
| `NextSince()` `:87-96` | `""` when there was none (the agenda then asks about yesterday); a `sending` claim with a `since` asks its own window again; otherwise the last day it went out |
| `Claim` `:108-128` | read, `Taken` → `(nil, prev, nil)`; else write `{Day: day, Status: sending, Since: prev.NextSince(), At: stamp(now), Chat: chat}` with `ifMatch` = what was read; a takeover of a same-day `sending` keeps the crashed claim's `Since` (`:117-119`); `ErrPrecondition` (lost the race) → `(nil, prev, nil)` |
| `Finish` `:131-136` | rewrite with the claim's ETag, new status and stamp |
| `Release` `:141-146` | rewrite **the previous record** with the claim's ETag — its `At` too, so a stale claim stays stale. With no previous record this writes an empty one, which reads as "never sent" (there is no conditional delete) |
| `CheckinDue` `:161-166` | `now` in `loc` is `>= today hh:mm` **and** `< today CheckinCutoff:00` |

Consequences worth keeping in the port:

- The claim is a conditional put on the same object the other app writes, so exactly one run wins —
  pinned by `TestCheckinOneWinner` on memory **and** MinIO (`checkin_state_test.go:127-157`).
- The claim is taken **before** the entries are read and held across the send, so a crash between the
  first and the last message leaves a `sending` record that blocks the day for 10 minutes and is then
  taken over with the same `Since` (`TestCheckinTakesOverACrashedClaim`).
- A failed send releases the day, so a retry at the next minute asks the same days
  (`TestCheckinTooLateQuietAndFailure`).
- A quiet day still finishes, so the window advances (`TestCheckinClaim`'s last block).

### 2.1 The catch-up and the missed-days window

- **Catch-up:** the tick runs every minute, so a check-in missed at 09:30 (app not running, or booted
  at 14:00) goes out at the first tick after `09:30` and before `20:00` on that day. At or after 20:00
  the day is skipped entirely and `checkin.json` is not written (`TestCheckinDue`, `TestCheckinTooLate…`).
- **Missed days:** the agenda window is `claim.Record.Since` → yesterday (`agenda.go:30-63`): today's
  dated entries are `Today`; undone **tasks** from `since` to yesterday are `Ask`; earlier undone tasks
  are `Overdue`. `since` is clamped to `today - MaxAskDays` (7, `agenda.go:10`), so "up to a week back"
  in the guide. `since == ""` means yesterday.
- `CheckinDue` is `>=` at the scheduled minute and `<` the cutoff: 09:29 false, 09:30 true, 14:00 true,
  19:59 true, 20:00 false, and the same instants expressed in UTC behave the same
  (`checkin_state_test.go:16-29`).

---

## 3. `internal/sched` and the settings it resolves

`sched.go` is the one schedule parser (check-in setting, `DOCS_SYNC_SCHEDULE`, both loops):

| Item | Rule |
|---|---|
| `Parse(name, s, def)` `:14-29` | trim + lowercase; `off`/`none`/`false` → off; `""` takes `def`; else `hh:mm` with `0<=hh<=23`, `0<=mm<=59`; error text `"<name> must be HH:MM (24 h) or off, not %q"` (the quoted **normalised** value) |
| `NextRun(now, hh, mm, loc)` `:32-39` | today at hh:mm when that is strictly after now, else tomorrow (so at exactly 03:00 the next run is tomorrow's) |
| `CheckinCutoff` `:43` | `20` — the local hour after which a missed morning check-in is skipped |
| `Day(now, loc)` `:46` | `YYYY-MM-DD` in `loc` |
| `AddDays(day, n)` `:49-55` | `""` stays `""`; normalises across month/year ends |

Check-in settings (`internal/settings/checkin.go`): `DefaultCheckin = "09:30"` (`:15`); the resolved
value keeps the raw `Schedule` string for display and the parsed `On/Hour/Minute` for the tick
(`:18-29`); `ParseCheckin` (`:63-85`) refuses `>= 20:00` with
`the check-in time must be before 20:00 (later ones are skipped)` and a chat that is not a number with
`the check-in chat must be a Telegram chat ID (a number), not %q`; `ResolveCheckin` reads
`settings.json`'s `checkin` section and falls back to the env-level `CHECKIN_SCHEDULE` / `CHECKIN_CHAT`
(`:89-117`), and **fails** rather than falling back when the file cannot be read.

---

## 4. How `cmd/movin/main.go` starts it

| Line | Code |
|---|---|
| `:124-128` | `bot = &telegram.Bot{API: telegram.New(token, ""), Agent: runner, Entries: ents, Settings: sets, Docs: syncer, Log: log}` — only when `c.TelegramToken != ""` |
| `:129` | `bot.Checkin = &telegram.Checkin{State: &telegram.CheckinStore{Store: store}}` — one store, the bucket |
| `:130` | `syncer.Notify = bot` — the docs notice (§7) |
| `:131-136` | `go func(){ if err := bot.Run(ctx); … }()` |
| `:172-179` | `go func(){ syncer.Background(ctx, c.DocsSync, c.Location) }()` — after the listener is up |
| `:181` | `go bot.CheckinLoop(ctx, time.Minute)` — after the listener, **after** `Background` |
| `:187-189` | on shutdown `bot.Wait(15*time.Second)`, warning `telegram bot still busy at shutdown; a turn may have been cut short` |

So: no bot token → no check-in at all (`CheckinStatus` is nil → the admin route shows Go's nil-bot
shape). The check-in loop is independent of `bot.Run` (the poll loop): it reads settings and entries
directly, and only needs the Telegram client to send.

---

## 5. What the admin page and the settings drawer already do

Go's route is `internal/server/admin.go:167-215`: `telegramView` = `status`, `allowlist`, `checkin`
(`CheckinStatus` + `setting`). The check-in half is written; the bot's half is a placeholder — see §8.1.

The resolved setting (`settings.CheckinSetting`, `internal/settings/checkin.go:52-61`) is the resolved
`Checkin` plus `updated`, `by`, `unreadable`; `On/Hour/Minute` never go out (`json:"-"`).

TS today, all ported in T1.4/T2.2:

| Piece | Where |
|---|---|
| `parseSchedule` / `nextRun` / `day` / `validDate` / `addDays` / `rfc3339` | `app/src/sched.ts:28`, `:54`, `:62`, `:83`, `:96`, `:111` |
| `DEFAULT_CHECKIN`, `CHECKIN_CUTOFF`, `parseCheckin`, `chatID`, `CheckinSetting` | `app/src/settings/checkin.ts:13`, `:16`, `:62`, `:54`, `:46` |
| `resolveCheckin` / `viewCheckin` / `saveCheckin` / `withCheckinEnv` | `app/src/settings/settings.ts:509-529`, `:532-548`, `:550-563`, `:585-587` |
| `agenda` / `isQuiet` / `MAX_ASK_DAYS` | `app/src/entries/agenda.ts:35`, `:24`, `:11` |
| `updateIf` (the in-write precondition the buttons need) | `app/src/entries/service.ts:134`, `:438-…` |
| `Patch` as a plain record (`{status:"done"}`, `{status:"done",milestone:true}`, `{date:…}`) | `app/src/entries/model.ts:258`, `applyPatch` `:333` |
| `PUT /api/settings/checkin` | `app/src/server/admin.ts:187-211` |
| `checkin` in the telegram view with `setting` appended | `app/src/server/admin.ts:147-156`, `encodeCheckinSetting` `:268` |
| `checkinStatus()` seam on the bot | `app/src/server/admin.ts:57`, `app/src/telegram/bot.ts:195`, `:272` |

---

## 6. Every log line (check-in and docs), for the port

| Level | Message | Fields |
|---|---|---|
| info | `morning check-in loop running` | `until` (`"20:00"`) |
| warn | `morning check-in: couldn't read the settings; skipping this minute` | `err` |
| warn | `morning check-in can't go out until this is fixed` | `err` |
| warn | `morning check-in: couldn't read or claim the day; will retry` | `err` |
| warn | `morning check-in: <why>; will retry` (`why` = `couldn't read the entries` / `couldn't send it`) | `err` |
| warn | `morning check-in: couldn't give the day back; it can be retaken in 10 minutes` | `err` |
| warn | `morning check-in: couldn't record a quiet day` | `err` |
| info | `morning check-in: nothing to report today` | `day` |
| warn | `morning check-in sent but not recorded` | `err` |
| info | `morning check-in sent` | `day`, `chatId`, `today`, `asked`, `overdue` |
| warn | `telegram check-in part failed` | `chatId`, `err` |
| warn | `telegram check-in task message failed` | `chatId`, `entryId`, `err` |
| warn | `telegram check-in failed` (the `/checkin` command) | `chatId`, `err` |
| warn | `telegram check-in update failed` (a button) | `by`, `entryId`, `err` |
| info | `next daily document sync` | `at` (RFC 3339 in the app zone) |
| info | `documents synced` | `reason`, `added`, `changed`, `removed`, `failed`, `skipped`, `refreshed`, `firstImport` |
| info | `documents index changed while syncing; redoing` | `attempt` |
| warn | `startup document sync failed` / `daily document sync failed` | `err` |
| debug | `documents index refresh failed` | `err` |
| warn | `telegram documents notice failed` | `chatId`, `err` |

The four docs lines are already ported byte for byte (`app/src/docs/sync.ts` `:261-271`, `:277`;
`app/src/docs/schedule.ts:57`, `:65`, `:90`; pinned by `app/src/docs/sync.test.ts:732` and
`app/src/docs/schedule.test.ts:191-243`). `telegram documents notice failed` (§7.3) is **not** written
yet.

---

## 7. Go's docs sync: the schedule, the notice, and whether it needs a durable task

### 7.1 `internal/docs/schedule.go` `Background` (`:16-61`)

1. `sched.Parse("DOCS_SYNC_SCHEDULE", schedule, DefaultSyncSchedule="03:00")` — a bad value is returned to
   the caller, which logs `document sync schedule` and keeps serving (`cmd/movin/main.go:176-178`).
2. A goroutine runs `Sync(ctx, "startup")` immediately; a failure logs
   `startup document sync failed` and is otherwise ignored.
3. `refresh := time.NewTicker(time.Minute)` → `s.Refresh(ctx)` per tick; a failure logs
   `documents index refresh failed` at **debug**. This is how a second replica (or a manual edit) is
   noticed within a minute.
4. `arm()` (once at start, and after each daily run): when the schedule is on, `next := sched.NextRun(now,
   hh, mm, loc)`, logs `next daily document sync` with `at` = RFC 3339 in the app's zone, and arms a
   `time.NewTimer(time.Until(next))`.
5. On the timer: `Sync(ctx, "daily")` (a failure logs `daily document sync failed`), then `arm()` again.
   `off` means no daily timer at all; the startup sync and the minute refresh still run.
6. Returns when `ctx` ends, stopping the timer.

The important properties: **a timer, not a sleep loop** (so it re-computes the next wall-clock time after
every run), **one timer at a time**, and `Now` injectable for tests.

### 7.2 `internal/docs/sync.go`: single flight and Notify

- `Sync(ctx, reason)` (`:75-104`) is the whole single-flight mechanism: a caller that finds `s.running`
  non-nil waits for that flight's `done` channel (or its own ctx) and returns the same result. There is
  no queue. After the run it clears `running`, closes `done` and non-blockingly signals every subscriber.
- `run` (`:229-271`) loops `0..MaxIndexRetries` (3): load the index (ETag), list `docs/raw/`, `apply`
  (which writes per-document text but not the index), encode, then `Put(IndexKey, body, etag)` — the
  **conditional** index write. `ErrPrecondition` → `documents index changed while syncing; redoing`,
  next attempt on top of the other writer's index, with the run's conversions/summaries memoised.
- After the successful write it logs `documents synced` and then, and only then:

  ```go
  if res.Changes() && !first && s.Notify != nil {
      s.Notify.DocsChanged(ctx, res, changed)
  }
  ```
  (`:264-266`.) So the notice is sent **only when something changed** and **never for the first import**
  (defined at `:288-295` as "no document was readable before"). `refreshed` (a document re-read because
  `ConvertVersion` moved) is not a change (`:373`).
- `Running()` (`:107-111`) is what `/sync` and the web button read to say a sync is already going.
- `Refresh` (`:156-178`) is `Stat(IndexKey)` and, when the ETag moved, a reload — the minute tick.

### 7.3 `internal/telegram/docs.go` `DocsChanged` — the group notice (`:18-37`)

```go
text := "Documents updated: " + counts(res) + "\n" + docList(changed, 10)
```

- `counts` (`:81-95`) joins the non-zero counters in the order `added, changed, removed, failed` as
  `"1 added"`, `", "`-joined, or `nothing changed`.
- `docList(ds, 10)` (`:97-119`): `"• " + d.Name()` per document, with ` (removed)`, ` (couldn't be read)`,
  ` (the new version couldn't be read; the previous one is still used)` (status/error dependent),
  ` (pictures only: not searchable yet)` for a scanned OK document, and `…and N more` past the cap.
- Recipients: **every** configured group (`ResolveTelegram(ctx).Groups`), skipping the one chat that asked
  for the sync — `syncReasonPrefix = "telegram:"` (`:14`), the reason `/sync` passes
  (`"telegram:" + chat id`). A per-group send failure logs `telegram documents notice failed` with
  `chatId`, `err` and does not stop the others.
- It is a plain `SendMessage` with no keyboard and no thread, straight from the bot: in v1 the notice is
  **not** a delivery and does not enter any chat's history.

Go's test `TestDocumentSyncAndNotices` (`internal/telegram/bot_test.go:693-735`) pins: `/sync` replies
`Syncing…` then `Synced: 1 added` naming the file; the first import posts **no** group notice; a later
`Sync("daily")` posts exactly one `Documents updated: 1 added` naming `Oven.pdf` to the group; a no-op
`/sync` says `No changes. 2 documents are readable.` and posts no notice.

### 7.4 What the TS app already does, and what a durable task would add

`app/src/docs/schedule.ts` (`:46-105`) is a faithful port of `Background`: `startup` sync in a
`void run(...)`, a re-armed 60 s refresh timer, a daily timer re-armed from `nextRun` after each run, no
timer when off, every timer `unref`'d, clock and `SetTimer` injected. `startDocsBackground` returns the
stop function and `main.ts` calls it once the listener is up (`app/src/main.ts:245-253`) and stops it in
`shutdown` (`:259`). `app/src/docs/sync.ts` ports single flight (`:198-214`), the conditional index write
(`:262-275`), the redo on `PreconditionError` (`:277-284`) and the `notify` option (`:59-62`, `:90`,
`:271`) — but **`main.ts` passes no notifier** (`app/src/main.ts:172-179`), so today nothing is announced.

So the gap between today and T5.2 is: (a) the `DocsChanged` half in the bot (text, group fan-out,
`telegram:` skip, `telegram documents notice failed`), (b) a `notify` wired from `main.ts`, and (c)
whatever a "durable docs sync task" adds. What a pi-durable task adds over the in-process schedule:

| Property today (in-process) | With a durable task |
|---|---|
| Daily timer lives in the process; a restart re-runs `startup` and re-arms from the current clock | The next run is a durable `sleepUntil`; a restart does not re-run or skip it, and a crash mid-sync is retried by the scheduler |
| A crash mid-sync leaves `docs/index.json` as it was (the write is conditional and atomic, so no corruption) and the run is simply lost | The sync is retried after the restart (`restarts` + backoff), so a poppler OOM does not silently skip a night |
| Single flight is in-process only; two pods would sync concurrently, and the conditional write makes one of them redo | A durable task is single-instance **per database**, not per bucket; two pods on one bucket still race exactly as today |
| The notice is sent by whichever process ran the sync, from its own memory | The notice can be a durable delivery (at-least-once, survives a crash after the index write) |

Evidence that a durable task is **not** needed for correctness: the index write is already conditional
and idempotent (`sync.ts:271-275`), `apply` writes per-document text before the index so a lost run is
always redone from a clean state, the startup sync already covers "the app was not running at 03:00"
(the schedule is 03:00 daily and the app is a long-lived pod), and the minute `Refresh` covers the other
replica. Nothing user-visible can be lost by a crash beyond one night's notice.

Evidence that it **is** wanted: `plan.md:133` names it as a step ("daily, startup, `/sync`, web button");
the notice is the one side effect that is not idempotent (a retried sync that finds no change sends no
notice, so a crash between the index write and the notice loses the announcement forever — the same
window v1 has); and a durable task is the only way to give the nightly run a retry after a crash. There
is also a real cost: a durable task cannot call `conversation.abort()`/`waitForIdle()`
(`D/harness/types.d.ts:824-834`), needs an owner conversation (see trap 13.1), and would run the sync
inside a task invocation, so `poppler` child processes would run under the task's abort signal.

**This is a design decision for the main session.** A middle path that satisfies the verify list without
a scheduler: keep `startDocsBackground` and add the notifier plus a test that the notice is not sent for
a no-op run. A full path: `movin.docs.sync` task with `sleepUntil(nextRun)` + `phase: "sync"` that calls
the same `Syncer.sync(reason)` and then `deliver()`s the notice, ignoring `telegram:` reasons.

### 7.5 T5.2's verify list, item by item

- **"ported sync tests"** — already done in T1.5. `app/src/docs/sync.test.ts` carries all ten Go tests
  under their own names/shapes: lifecycle (`:207`), retry after failure (`:289`), single flight (`:314`),
  redo after another writer (`:395`), silence while nothing was ever readable (`:433`), older
  `ConvertVersion` refreshed quietly (`:450`), newer index left alone (`:475`), failed re-read keeps the
  document (`:496`), memo across a redo (`:535`), `ConflictError` after the retries (`:580`). T5.2 does
  not need to re-port them; it needs the *notice* half.
- **"notify only on change"** — the Go test to port is `TestFailedThenFixedImportStaysSilent`
  (`internal/docs/sync_test.go:242-262`) and the notice assertions of `TestSyncLifecycle` (`:95-150`):
  no notice for the first import, no notice for a no-op run, no notice for `refreshed`, exactly one for a
  change/removal, never for the skipped junk file. `app/src/docs/sync.test.ts:433` already covers the
  silence-while-unreadable rule against its `notify` spy; the missing piece is the bot's fan-out.
- **"fake clock across midnight"** — `nextRun` across midnight, month end and year end is pinned by the
  Go golden (`app/src/testdata/sched.go.json`, from `app/golden/t15c/main.go`): 2026-11-30T23:50 →
  2026-12-01T03:00, 2027-01-01, and both 2026 London DST changes; `app/src/sched.test.ts:89-99` asserts
  every row and `nextRun(after) > now`. What is *not* pinned is the **daily task** running across
  midnight: today's `app/src/docs/schedule.test.ts:121-150` moves the clock within one evening. T5.2 should
  add the case where the run completes at 23:59 and the next run is 03:00 the next morning, and (for the
  durable variant) the case where `sleepUntil` is armed at 03:00 on day D and fires at 03:00 on D+1 after a
  restart in between.

---

## 8. What the TS app has today, Go piece by Go piece

### 8.1 The check-in

| Go piece | State in v3 | Where |
|---|---|---|
| `sched.Parse`, `NextRun`, `Day`, `AddDays` | **ported** (plus `validDate`, `rfc3339`) | `app/src/sched.ts:28`, `:54`, `:62`, `:96`, `:83`, `:111` |
| `settings.Checkin`, `ParseCheckin`, `resolveCheckin`/`viewCheckin`/`saveCheckin` | **ported** | `app/src/settings/checkin.ts:13-90`, `app/src/settings/settings.ts:509-563` |
| `sched.CheckinCutoff` | **ported**, but lives in `settings/checkin.ts:16` (`CHECKIN_CUTOFF`) | — |
| `entries.Doc.Agenda` + `Quiet` + `MaxAskDays` | **ported** | `app/src/entries/agenda.ts:11`, `:24`, `:35` |
| `checkinText`, `shortDay`, `agendaLine`, `askText` | **missing** | — (no `checkin` module under `app/src/telegram`) |
| `askKeyboard` (`ci:` data) | **missing** | — |
| `sendCheckin` (+ history remember) | **missing** | — |
| `checkinCommand` (`/checkin`) | **placeholder**: answers `The check-in isn't available yet.` | `app/src/telegram/commands.ts:60`, `:265-267` |
| `checkinCallback` (`ci:`) | **placeholder**: routed and answered empty | `app/src/telegram/commands.ts:381` |
| `CheckinStore` (`checkin.json`, claim/finish/release) | **missing** — no `checkin.json` string anywhere under `app/src` | — |
| `CheckinDue` | **missing** | — |
| `CheckinLoop` / `CheckinTick` / `warnCheckin` | **missing** — nothing ticks; `main.ts` starts no check-in | `app/src/main.ts:245-253` is docs only |
| `CheckinStatus` with state | **placeholder**: `checkinView()` returns `{on:false}` | `app/src/telegram/bot.ts:195-197`, `:272` |
| admin `checkin` view + `PUT /api/settings/checkin` | **ported**, pinned | `app/src/server/admin.ts:147-156`, `:187-211`, `:268` |
| the bot's `checkinStatus` seam | **ported** | `app/src/server/admin.ts:57` |

`/help`'s check-in line is already Go's (`app/src/telegram/commands.ts:56`) and `BOT_COMMANDS` already
lists `/checkin` with Go's description (`app/src/telegram/bot.ts:107`), so no text changes when the
placeholder goes.

### 8.2 The docs sync

| Go piece | State in v3 | Where |
|---|---|---|
| `docs.Background` | **ported** | `app/src/docs/schedule.ts:46-105`, started/stopt at `app/src/main.ts:245-253`, `:259` |
| `Syncer.Sync` single flight, `Running`, `Subscribe`, `Index`, `Refresh` | **ported** | `app/src/docs/sync.ts:198-214`, `:484`, `:235`, `:150-190` |
| conditional index write + redo | **ported** | `app/src/docs/sync.ts:262-284` |
| `Notifier` interface + `notify` option | **ported but unused** | `app/src/docs/sync.ts:59-62`, `:90`; `main.ts` passes none (`app/src/main.ts:172-179`) |
| `DocsChanged` (text, group fan-out, `telegram:` skip) | **missing** | `bot.test.ts:1274-1277` keeps `it.todo("posts one Documents updated notice to the group (T5.2)")` |
| `counts` / `docList` (the two formatters) | **ported and exported**, reusable as-is | `app/src/telegram/commands.ts:85`, `:102`; golden `app/src/telegram/commands.test.ts:101` |
| `syncReasonPrefix` | **ported** | `app/src/telegram/commands.ts:73` (`SYNC_REASON_PREFIX`) |
| `syncCommand` (`/sync`) | **ported**, including the two-message shape | `app/src/telegram/commands.ts:312-350` |
| the web button's sync | **ported** (the same `syncer.sync`) | `app/src/server/*`, `app/src/docs/sync.ts` |

A `DocsChanged` port has one v3-specific choice: the notice is a **send**, and every send in v3 goes
through the delivery task (`plan.md:77`, `decisions.md:283`). Options: (a) `agent.deliver("tg:<group>",
{bare chat address}, parts)` per group, which is durable and at-least-once but creates one delivery per
group per notice and puts the notice into that chat's conversation history; (b) a direct
`client.sendMessage`, which is Go's behaviour but breaks the "one place that sends" invariant and loses
the notice on a crash; (c) a direct send plus the bot's `state.lastError` on failure only, as a command's
answer is *not* handled today (commands go through `deps.send` → `agent.deliver`). The `ReplyAddress`
shape needed by `textMessages` is `{chat, messageId, group}` (`app/src/telegram/format.ts:57-61`), and
`messageId: 0` with `group: false` yields `{chat_id, text}` — exactly Go's notice message.

---

## 9. The restore path (T5.3): what exists, what pi-durable offers

### 9.1 What `app/src/durable/adapter.ts` has today

| Thing | Value / place | Note for T5.3 |
|---|---|---|
| Epoch doc | `Epoch = defineDoc({kind:"movin.epoch", version:1, scope:"session", initial:()=>({id:""}), checkpointWhen:()=>true})` — `adapter.ts:238-248` | Created with the database at open: `epoch = await opened.commit(async tx => { const doc = await tx.doc(Epoch); if (doc.id === "") doc.id = randomUUID(); return doc.id; })` (`:841-847`). **Nothing rotates it yet** — the comment says so (`:238-243`) |
| Epoch on the adapter | `Agent.epoch` (`:657-658`), the closure variable `epoch` (`:749`, assigned `:841`), handed to tools as `ToolContext.epoch` (`:339-340`) | After rotation, new change IDs are automatically distinct |
| Intake doc | `export const INTAKE_DOC = "movin.intake"` (`:162-166`), `Intake = defineDoc(...)` (`:307-322`), `IntakeLedger = IntakeState & {recent:number[]}` (`:299`), `IntakeState = {cursor, acceptedAt, queue[], open[]}` (`:579-587`), `OpenTurn = IntakeItem & {submission, deadlineAt}` (`:575`) | T5.3 must clear `queue` and `open`. Note `recent` is the dedupe list and the offset is `cursor`; clearing the offset is `cursor = 0` (Telegram's own pending queue is then used) |
| Outbox task | `const OUTBOX_TASK = "movin.outbox.delivery"` (`:136`), definition `deliveryTask()` (`:1394-1500`), registered in the `movin.agent` extension (`:770-776`) | Its abort handler already settles `{status:"terminal", outcome:{status:"aborted"}}` with **no reason** (`:1493-1497`), because it serves both a conversation abort and this restore path (`decisions.md:290`) |
| Test helper for aborts | `abortDeliveries(agent, key)` (`:2065-2082`) — inspects a key's live tasks, aborts every `OUTBOX_TASK` one and waits | The precedent for the restore path's "abort every non-terminal run and pending delivery task": same `inspect` + `abortTask` calls, over every conversation instead of one key |
| Start counter | **does not exist**: no `epoch.json`, no `startCount`, no `HARNESS_RESTORE_ID` anywhere in `app/` | The whole S3 half of the restore path is new |
| `resume()` call site | `harness.resume()` at `:799`, with the comment `// G7: resume() straight after open. The restore path (abort live work before scheduling) is T5.3's` (`:795-798`) | The restore path goes **between** `openedHarness()` and `:799` |
| Settings-backed conversations | `lookup(key)` / `attach` / `idle` / `deliver` on `Agent` (`:656-687`) | The "recreate the scheduled tasks from settings" half needs the check-in chat's conversation to exist after a restore even if it never spoke |

`Agent.close()` (`:1973`) and `harness.closed` (`:807`) are the shutdown path; the restore path must not
run on a normal close.

### 9.2 The pi-durable APIs the restore path needs (verified in 1.5.2)

`D/` = `app/node_modules/@earendil-works/pi-durable/dist/`.

| Question | Answer | Citation |
|---|---|---|
| Does `Harness.open` resume automatically? | **No.** `Harness.open(storage, options, context)` (`D/harness/harness.d.ts:20`) calls `harness.openTasks(context)` (`D/harness/harness.js:411`), which is the scheduler's `open` (`D/harness/scheduler.js:221-250`): in one commit it scans every `LIVE_STATUSES` record, mirrors it into `#live`, and rewrites `running` → `pending` with `restarts + 1`; `abandonOnRestart` tasks are marked abandoned and `waiting`+`failFast` records are queued for a check. **No task code runs.** `resume()` (`D/harness/types.d.ts:835`) is what enables scheduling; `Conversation.submit/compact/abort`, `Submission.wait`, `waitForTask`, both `waitForIdle`s also enable it (`:824-834`) | `D/harness/harness.d.ts:20`, `D/harness/harness.js:405-420`, `D/harness/scheduler.js:221-250`, `D/harness/types.d.ts:824-835` |
| How to list non-terminal runs/tasks before `resume()`? | `harness.inspect(context): Promise<HarnessInspection>` — "Live tasks and unsettled submissions. Writes nothing and runs no task code." `HarnessInspection = {scheduling: "paused"｜"running"｜"closing", tasks: TaskInspection[], submissions: SubmissionRecord[]}` (`:743-748`). Each `TaskInspection = {record: TaskRecord, state}` with `state.kind` one of `running` (`:710-712`), `pending` (`:713-717`), `waiting` (with `on: TaskId[]`, `:718-725`), `sleeping` (with `until: number`, `:726-730`), `completing` (`:731-737`), `blocked`/`orphaned` (`:735`) | `D/harness/types.d.ts:852`, `:708-748` |
| How to abort them? | `harness.abortTask(id, context): Promise<"marked"｜"terminal">` — "Commit the abort mark, signal and join an active run invocation, and schedule the abort invocation" (`:861`). The abort handler then "runs in a fresh invocation after an abort mark and must commit a terminal outcome" (`D/types.d.ts:334`). For admitted-but-not-placed user inputs: `harness.abortSubmission(id, ctx, conversationId?)` → `"aborted"｜"already_placed"｜"settled"｜"not_found"` (`:856`) | `D/harness/types.d.ts:856-861`, `D/types.d.ts:328-334` |
| What must NOT be used | `conversation.abort()` (`:813`) and `conversation.waitForIdle()` (`:820`) **start scheduling** (`:824-834`), so "abort live work before `resume()`" via them silently resumes first — already written down in `docs/movin-v3/briefs/durable-api.md:283` and `decisions.md:105` (`G7`) | `D/harness/types.d.ts:813-834` |
| Rotation and the counter in one commit | `harness.commit(tx => …)`; `tx.doc(Epoch)` and a new start-counter doc in the same callback, then `harness.resume()` | `adapter.ts:841-847` is the existing precedent |
| Does a run's abort lose its reply? | No: the delivery task is a separate conversation-owned task, and aborting it settles `aborted`, so nothing is resent. T0.2 R2 measured this: `{"journal":1,"replies":0,"toolRuns":0,"llmCalls":0}` (`progress.md:31`) | — |
| Are background tasks reachable by an abort? | `inspect()` lists **every** live task regardless of `background`; `conversation.abort()` without `background` skips them (`D/harness/scheduler.js:463`, `#idle` at `:2446-2466`). So the restore path must abort explicit IDs from `inspect()`, not call `abort()` | `D/harness/scheduler.js:455-475`, `:2446-2466` |

### 9.3 The S3 half: `harness/<instance>/epoch.json`

The object store API is already conditional (`app/src/objstore/store.ts:24-38`):

```ts
get(key, signal?): Promise<{body: Uint8Array; etag: string}>            // throws NotFoundError
put(key, body, ifMatch: string | null, signal?): Promise<string>        // null = If-None-Match: "*"; "" throws TypeError
stat(key, signal?): Promise<ObjectInfo>                                 // throws NotFoundError
```

`put(key, body, etag)` → `IfMatch: <etag>` and `put(key, body, null)` → `IfNoneMatch: "*"`
(`app/src/objstore/s3.ts:54-57`), `PreconditionError` on 412/409 (`store.ts:49-54`). Keys are relative to
`S3_PREFIX` (`s3.ts` `storeKey`), so `harness/prod/epoch.json` lands under the prefix next to
`checkin.json`, `entries.json` and `docs/` — the same bucket the Go app shares.

The counter object therefore needs: read (`get`, `NotFoundError` → create with `put(…, null)`), increment
with `put(…, etag)` and a retry on `PreconditionError` (the other instance bumped it concurrently), and a
compare of the SQLite-side counter against the S3-side one. Note the S3 counter is shared by **both**
instances only if the instance name differs (`dev` vs `prod` are separate objects, `plan.md:48`).

### 9.4 Config

`app/src/config.ts:40-71` lists every environment-derived field; `loadConfig` (`:112-201`) validates each
and throws with Go's style (`S3_BUCKET is required`, `TZ: unknown time zone "…"`, `MOVIN_DOCS must be
"on" or "off"`). **Neither `HARNESS_RESTORE_ID` nor an instance name exists today.** What T5.3 needs:

- `HARNESS_RESTORE_ID` — optional, `""` when unset (from the hand-applied ConfigMap `movin-restore`,
  `envFrom … optional: true`, `plan.md:47`).
- An instance name — `dev` | `prod` for the `harness/<instance>/epoch.json` path (`plan.md:48`). It must be
  validated like `MOVIN_DOCS` (a bad value throws at start) and it must be the **same** value for every
  replica of one deployment; today both dev and prod would default to the same thing unless it is explicit.
- The object store is **not** currently reachable from the restore path: `startServe` creates `store`
  (`app/src/main.ts:130-137`) but `openDurableAgent(config, settings, log, deps, outbox)`
  (`app/src/main.ts:307-329`) is not given it, and `OpenAgentOptions` (`adapter.ts:712-739`) has no store
  or instance field. Either `openDurableAgent` gains an `epoch: {store, instance, restoreId, now}` option
  or the counter/compare lives in `main.ts` and only the decision is passed in.

### 9.5 The four behaviours T5.3 must implement (from `plan.md:47-49`)

1. **Explicit trigger.** `HARNESS_RESTORE_ID` differs from the ID recorded in SQLite → restore path, then
   record the ID (one-shot; leaving it set is harmless).
2. **Automatic trigger.** Each start increments the SQLite counter and the S3 counter. SQLite behind S3 →
   the database was restored → restore path. Equal → normal start.
3. **Restore path, before `resume()`:** rotate `movin.epoch`; abort every non-terminal run and pending
   delivery task; clear `movin.intake` (queue **and** open turns) and reset the polling cursor; recreate
   the scheduled tasks from settings (the `checkin.json` claim still prevents a double send).
4. **Ordering.** All of it in commits before `harness.resume()` at `adapter.ts:799`; the abort handlers
   (the delivery task's, and whatever the T5.1 check-in task defines) only run afterwards, under
   `resume()`.

---

## 10. Velero notes (`docs/movin-v3/velero.md`)

`plan.md:135`, in full:

> **T5.3 Restore safety + Velero notes** — restore path with both triggers (Design); it also clears `movin.intake` (queue and open turns) and aborts pending `movin.outbox.delivery` tasks before `resume()`; `docs/movin-v3/velero.md`; guide section "Chat history backup". The notes cover: the movin Schedule (namespace `movin-tracker`, PVC `movin-data` only, daily, keep 7 days), the snapshot-class label, a restore drill into a scratch namespace with an integrity check, and the real restore order (suspend Flux → scale to 0 → restore the PVC → apply `movin-restore` with a new ID → resume).

So `velero.md` must contain, at minimum:

1. **The movin Schedule** — namespace `movin-tracker`, `movin-data` PVC (and its PV) only, daily, TTL
   7 days (keep 7). Not secrets, not the rest: those come from Flux or are hand-applied
   (`plan.md:45`, `decisions.md:18`). Note that `velero-default` already copies the whole cluster into
   `zyallinonebackups`, `movin-secrets` included — a cluster-wide choice, outside this plan
   (`plan.md:45`).
2. **The snapshot-class label** — `volumesnapshotclass nutanix-snapshot-class` carries
   `velero.io/csi-volumesnapshot-class: "true"`; CSI needs no `--features=EnableCSI` on Velero v1.18.0.
   Already applied by the main session on ZY's instruction (`decisions.md:244`), and the class belongs to
   the `nutanix-csi` Helm release, so the label must be re-checked after NKP/CSI upgrades.
3. **A restore drill** into a scratch namespace with an integrity check (e.g. `sqlite3
   /data/harness.db "PRAGMA integrity_check"` plus a row count, and the volume's size/mount).
4. **The real restore order** — suspend Flux → scale the deployment to 0 → restore the PVC → apply the
   `movin-restore` ConfigMap with a **new** restore ID → resume (release the Flux suspend / scale up).
5. **The state of the world it depends on** (`plan.md:43`): BSL `default` = AWS S3 `zyallinonebackups`
   (ap-southeast-1), Schedule `velero-default` daily 00:00 whole cluster TTL 720h, uploader kopia but no
   node-agent DaemonSet, and — without the label — a backup would copy the PVC object but **not its data**.
   Until T6.7 is done, the README and the guide must say the volume's data is not backed up
   (`plan.md` T6.7).
6. **Where it is referenced**: `docs/movin-v3/README.md:21` already promises
   `velero.md | Backup and restore of the chat-history volume (written in T5.3)`, and
   `README.md:35`-ish says the volume is not yet backed up. The guide section **"Chat history backup"**
   goes into `docs/admin-guide.md` (its neighbours are "Recover older data" `:254` and
   "Rotate a secret" `:258`; sections are `###` under `## Everyday tasks`, `:221`).

T5.3 writes notes only: no `kubectl apply`, no cluster change (the label is T6.7's, already done; the
Schedule and the drill are T6.7's), `plan.md:135` vs `T6.7`.

---

## 11. T5.1's verify list, item by item (what a test has to do)

`plan.md:131`: "durable `sleepUntil`; the send step keeps the `checkin.json` claim. Verify: Go and TS dev
apps both due → one message; restart mid-sleep keeps the schedule; a settings change reschedules;
catch-up until 20:00."

| Verify item | Go evidence | How a v3 test proves it |
|---|---|---|
| Go and TS dev apps both due → one message | `TestCheckinOneWinner` (`checkin_state_test.go:127`, memory + MinIO, 8 goroutines, exactly 1 winner) and `TestCheckinScheduleCatchUpOncePerDay`'s second-copy block (`checkin_test.go:266-275`) | Two claim stores on **one** memory store (and MinIO when `S3_ENDPOINT_URL` is set, as `app/src/objstore/objstore.test.ts:39-40` and `app/src/docs/sync.test.ts:206` do with `variants`); both ticks due → exactly one summary. The claim object must stay `checkin.json` with Go's exact bytes, so a Go app on the same bucket and the TS app see each other |
| Restart mid-sleep keeps the schedule | Go has no such notion (the tick simply re-fires) | Close the harness while the check-in task is `sleeping`, reopen the same SQLite file, `resume()`, and assert the task is still there with the same `until` and that only one task of that kind exists — no duplicate created by the second start |
| A settings change reschedules | `TestCheckinTimeFromSettings` (`checkin_test.go:494-520`): 09:45 + `10:00` → nothing; `off` → nothing and `CheckinStatus{On:false, At:""}`; back to `10:00` → sent | The task must re-read the setting after waking (Go reads `ResolveCheckin` every tick) and re-arm on the new time; the test moves the clock to 09:45, asserts no send, saves `10:00`, moves to 10:30 and asserts one send. Note the settings read happens **inside** the tick in Go; in v3 it has to happen inside the task too, or a settings change would need a restart |
| Catch-up until 20:00 | `TestCheckinDue` (`checkin_state_test.go:14-30`) and `TestCheckinTooLateQuietAndFailure` (`checkin_test.go:337-346`: started 21:00 → nothing sent, `checkin.json` day still `""`) | Fake clock at 08:00 (nothing), 14:00 (sends), 19:59 (sends), 20:00 (nothing, no claim written). With `sleepUntil` this is the interesting case: a sleep armed for 09:30 that elapses at 21:00 after a restart must **not** send — Go's `CheckinDue` window is what blocks it, so the task must re-check the window after every wake, not trust that it woke on time |

The Go behaviours a v3 test must keep that are not in the plan's list but are in the Go tests: the day is
released on a failed send and retried the same minute; a quiet day is finished as `quiet` so the window
advances; a crash mid-send blocks the day for 10 minutes and is then taken over with the crashed claim's
`Since`; a settings read failure skips the minute instead of falling back to the defaults; a chat that is
not on the allowlist is never marked finished, so fixing the list sends the same day.

---

## 12. Every Go test, mapped

### 12.1 `internal/telegram/checkin_test.go` (11 tests) → T5.1

| Go test | Line | Covers | v3 target |
|---|---|---|---|
| `TestCheckinCommandAndButtons` | `:71` | `/checkin` summary + 3 asks with `Yesterday:` text and the four `ci:` data strings; Done / Done ★ / +1 week each one journaled change with an Undo and Go's `✓ who: …` text; three keyboard edits; a second press on an answered task → toast `Already done.` and no write; a stranger's press → `not on this bot's list`; the Undo under a Done reply puts it back; **the LLM is never called** | new `checkin` tests in `app/src/telegram/` (a bot test with a fake ledger) |
| `TestCheckinCapsAskMessages` | `:173` | 10 open tasks → summary says `Not marked done yet (10)`, `Also open from earlier days:` lists `Task 09`/`Task 10`; exactly 9 messages (summary + 8 asks) | same |
| `TestCheckinQuietDayAndTypedReply` | `:191` | quiet day → `Nothing dated for today, and no open tasks`; after a check-in, a typed answer reaches the model **with the check-in in history** (`Asked about:\n• Yesterday: Book movers`) | same, plus the v3 history question (§13.4) |
| `TestCheckinScheduleCatchUpOncePerDay` | `:250` | 08:00 nothing; 14:00 catch-up once; the record `{day, sent, chat}`; a second copy sends nothing; next morning asks about the previous day's task; 14th/15th missed → both asked on the 16th with the older ones overdue | same, two claim stores on one bucket |
| `TestCheckinTakesOverACrashedClaim` | `:302` | a fresh foreign claim blocks; after `StaleClaim` this copy takes over and asks the crashed claim's days; record `{sent, since: 2026-11-12}` | same |
| `TestCheckinTooLateQuietAndFailure` | `:337` | 21:00 start → nothing, no record; a failed send gives the day back; retry at 09:31 sends; a quiet day sends nothing and records `quiet` | same |
| `TestCheckinButtonAfterTheTaskMoved` | `:394` | the `Tomorrow` button data is `ci:r:<id>:20261111:1`; after the entry moved, the toast is `That task was moved since (Fri 13 Nov), so I left it.`; `ci:d:<id>:20261111` (the old date) changes nothing; a 3-part `ci:d:<id>` does nothing | same |
| `TestCheckinDuringAnAgentTurnKeepsBoth` | `:427` | a check-in landing mid-turn: the next request contains both the hello and the check-in | same (needs the durable equivalent of `remember`, §13.4) |
| `TestCheckinChatMustBeAllowed` | `:459` | `chat: -999` → `CheckinStatus.Error` = `the check-in chat -999 is not an allowed group or person (Settings → Telegram)`, nothing sent, no record; a person on the list is fine (`Chat` = their ID); fixed the same day → sends at the next tick | same |
| `TestCheckinTimeFromSettings` | `:494` | the saved time applies at the next tick without a restart; `off` stops it and the status shows `On:false, At:""`; back on → sends | same |
| `TestCheckinSkipsWhenSettingsUnreadable` | `:534` | with a `settings.json` read failure: nothing sent, `checkin.json` day unchanged, status `Error` contains `read settings.json`, `On:false`, `Last` still yesterday, `ViewCheckin.Unreadable`; a readable control does send | same (`settingsReadFails` wrapper around the memory store) |

### 12.2 `internal/telegram/checkin_state_test.go` (5 tests) → T5.1

| Go test | Line | Covers |
|---|---|---|
| `TestCheckinDue` | `:14` | the 7-case due table in SGT and UTC (09:29 false … 19:59 true, 20:00 false) |
| `TestCheckinClaim` | `:32` | first claim has `Since:""`; a second claim while sending gets nil and is `Taken` not `Finished`; after `Finish(sent)` a claim gets nil and `Finished`; next day `Since` = the previous day; `Release` then re-claim keeps the window; a fresh claim blocks until `StaleClaim`; after it, a takeover keeps `Since` and sees `Prev.Status == sending`; a quiet day advances the window |
| `TestCheckinAfterAnUnfinishedDay` | `:90` | a claim that crashed and was never taken over: the next day's claim still asks from the crashed claim's window |
| `TestCheckinReleaseOfFirstEver` | `:110` | releasing the first-ever claim leaves an empty record that reads as claimable |
| `TestCheckinOneWinner` | `:127` | 8 concurrent claims → exactly 1 winner, on memory **and** MinIO (`testutil.Stores`) |

All five are `checkin.json` mechanics: they belong with the TS `CheckinStore` port and can be ported
nearly verbatim (the Go tests use `objstore.NewMemory()`; the TS equivalent is `createMemoryStore()` from
`app/src/objstore/memory.ts`, with the `variants` pattern for MinIO).

### 12.3 `internal/sched/sched_test.go` (2 tests) → already ported in T1.5c

| Go test | Line | v3 |
|---|---|---|
| `TestSchedule` | `:10` | `app/src/sched.test.ts:53-99` (parse cases incl. `off`/`OFF`, the four rejects, and `nextRun` from the Go golden: 02:59 → today 03:00, 03:00 exactly → tomorrow, 23:50 on 11-30 → 12-01 03:00, and a UTC instant) |
| `TestDays` | `:44` | `app/src/sched.test.ts:101-115` (`day` in SGT; `addDays` across month/year end, a bad day and `""`) |

T5 adds no sched work; it only **uses** `nextRun`/`day`/`addDays` from a durable task.

### 12.4 `internal/docs/sync_test.go` (10 tests) and the notice → T5.2

| Go test | Line | v3 |
|---|---|---|
| `TestSyncLifecycle` | `:95` | ported: `app/src/docs/sync.test.ts:207` |
| `TestSyncFailureIsRetried` | `:151` | ported: `:289` |
| `TestSyncIsSingleFlight` | `:164` | ported: `:314` (plus a joiner with an aborted signal, `:335`) |
| `TestSyncRedoesAfterAnotherWriter` | `:204` | ported: `:395` |
| `TestFailedThenFixedImportStaysSilent` | `:242` | ported: `:433` (**the notify-only-on-change test**) |
| `TestOlderVersionIsRefreshedQuietly` | `:264` | ported: `:450` |
| `TestNewerIndexIsLeftAlone` | `:295` | ported: `:475` |
| `TestFailedRereadKeepsTheDocument` | `:320` | ported: `:496` |
| `TestRedoRemembersEverything` | `:352` | ported: `:535` |
| `TestEndlessConflictIsErrConflict` | `:399` | ported: `:580` |
| `TestDocumentSyncAndNotices` | `bot_test.go:693` | `/sync` halves ported (`bot.test.ts`, T4.4); the **notice half is `it.todo`** (`app/src/telegram/bot.test.ts:1274-1277`) |

So for T5.2 the only unported Go test is the notice half of `TestDocumentSyncAndNotices`: `/sync` in a
group replies `Syncing…` + `Synced: 1 added` + the file name; the first import is silent; a later
`Sync("daily")` posts exactly one `Documents updated: 1 added` naming the second file to the group; a
no-op `/sync` says `No changes. 2 documents are readable.` and posts no notice.

### 12.5 Restore path → T5.3

Go has no equivalent (v1 has no durable state). The tests are the plan's own (`plan.md:135`): a DB copied
mid-run → new ID → run aborted, nothing resent, offset reset, tasks recreated; same ID again → normal
start; no ID but SQLite counter behind S3 → restore path; counters equal → normal start; dev and prod
counters independent. The precedent for the harness/DB half is
`app/src/durable/crash.test.ts` + `crash-*-child.ts` (spawn, `SIGKILL`, reopen, assert) — the same
pattern T0.2 used (`progress.md:31-32`).

---

## 13. Traps and open questions (the main session decides each)

**13.1 A scheduled task needs an owner.** `TaskOptions.ownership` is required
(`D/types.d.ts:358-364`) and is either `{kind:"conversation"}` (with `conversationId` required for a
commit not bound to a conversation) or `{kind:"task"}`. A check-in task belongs to no chat turn, so it
must be owned by a conversation — the check-in target chat's (`tg:<chat id>`) or a dedicated scheduler
conversation. Owning it by the check-in chat is the natural choice (the messages go there and the claim
is per day anyway), but it ties the task's lifetime to that conversation's abort path. Decide: which
conversation, and what happens when the check-in chat changes in settings (the task must be recreated
for the new chat, or it keeps sending to the old one).

**13.2 Background or not.** A non-background task counts in `conversation.waitForIdle()`
(`D/harness/scheduler.js:2446-2466`, `LIVE_STATUSES` includes `"sleeping"`, `:13`). A check-in task that
sleeps until tomorrow is live all night, so a **non-background** one would make its chat's conversation
never idle: `submit()` waits for idle, deliveries wait for the previous one, and the T4.3b delivery tail
would park behind a sleeping check-in. So a sleeping scheduled task must be `background: true`
(`D/types.d.ts:370-371`) — which has the consequence that `conversation.abort()` skips it, and the
restore path must find it through `inspect()` (as `abortDeliveries` already does,
`adapter.ts:2065-2082`). Decide and write it down: the check-in and docs-sync tasks are `background`.

**13.3 One task or one per wake.** Two shapes: a single long-lived task whose phase loops
(`commit({status:"sleeping", until: next})` then re-arm) or one task per run created by the previous
run's last phase. The loop shape is fewer tasks and needs a "does one already exist?" guard at start
(otherwise every restart adds one); the per-run shape is self-trimming but needs a creator that is not a
turn. Either way the restore path's "recreate the scheduled tasks from settings" (`plan.md:49`) has to be
idempotent — the natural guard is a session doc holding the current scheduled-task IDs, the way
`movin.outbox` holds the delivery tail (`adapter.ts:227-233`).

**13.4 The check-in must be in the conversation's model context (Go's `remember`).** Go appends
`(morning check-in)` + the summary to the chat's in-memory history (`checkin.go:172-189`), which is what
`TestCheckinQuietDayAndTypedReply` and `TestCheckinDuringAnAgentTurnKeepsBoth` prove. In v3 the history is
the transcript, so the equivalent is a committed entry carrying `model: [{role:"user"…}]` and
`model: [{role:"assistant"…}]` — `tx.appendEntry(conversationId, {kind, model, data})`
(`D/types.d.ts:415-433`, `:923-925`), with a `kind` the page's history route will render
(`historyItem()` in `adapter.ts:2265-2292` only renders `movin.user` and the assistant kind, so a new
kind is invisible in the web history but still in the model's context). This is a real adapter change; Go
also had to keep the two consistent under a concurrent turn, and the pi-durable analogue is one commit.
Decide: append two entries with a new kind (invisible in history, visible to the model) or reuse
`movin.user`/the assistant kind (visible in history, but a check-in row in the web chat that no one typed).

**13.5 `/checkin` must not advance the day.** Go's `checkinCommand` reads `NextSince()` only to widen the
window and never writes `checkin.json` (`:191-192`). Keep that: a `/checkin` before 09:30 must not stop
the scheduled one.

**13.6 The cutover window: two apps, one bucket, one claim.** T6.6 stops both dev apps before the tag, so
the 10-minute `StaleClaim` never bites in practice; but during dev, the Go app (`make dev`) and the TS app
share `checkin.json`, which is exactly what `TestCheckinOneWinner` protects. Consequence for testing T5.1:
a manual test with both apps running writes `checkin.json` in the **real** bucket, which the Go app then
honours for the day. Use MinIO or accept that the day's real check-in went out.

**13.7 `checkin.json` bytes are shared with Go.** Field order (`schema`, `day`, `status`, `since`, `at`,
`chat`), `Schema: 1`, second-precision RFC 3339 `at` and `omitempty` on `since`/`chat` must match exactly,
or a Go re-save and a TS re-save churn the object (and, worse, a `sending` claim written with
milliseconds would still parse — but an empty `at` would not, and `Taken` would then say "not taken", so
two check-ins would go out). This is a golden-fixture case like `testdata/sched.go.json`.

**13.8 Where the check-in task lives.** `plan.md:31` puts `checkin.ts` and `docsync.ts` under
`src/tasks/`, but only `src/durable/adapter.ts` may import pi-durable — enforced twice
(`app/biome.json:26-37`, `app/src/durable/imports.test.ts:7-23`). So either `src/tasks/*.ts` holds the
pure half (texts, keyboard, claim, due-window — no pi-durable) and `adapter.ts` holds the `defineTask`
definitions, or the lint/test rule gains a second allowed file. The first keeps the invariant that made
T3.2 reviewable. Decide.

**13.9 `CheckinStatus` needs state the adapter cannot currently give.** The view needs `Last`
(`checkin.json`), `Until = "20:00"`, `At`, `Chat` and `Error` from the settings resolve and the allowlist
(§1.10). Today `checkinStatus()` is a pure function returning `{on:false}` (`bot.ts:195-197`) with no
access to a store or to settings (`bot.ts:238`, `:272`). The seam in `server/admin.ts:57` is
synchronous; a check-in view needs `checkin.json` (an S3 read) and `resolveCheckin` (an S3 read), so
`checkinStatus` must become async or be resolved before the view is built. Decide the shape: `await
checkinStatus()` in `telegramBody()` (`admin.ts:147`), ideally reusing the settings service the route
already has.

**13.10 The docs notice and the delivery task.** See §8.2: a notice is a send, and v3 sends through the
delivery task. `agent.deliver(key, address, parts)` (`adapter.ts:1270-1275`) needs a conversation key, so a
group that never spoke has no conversation — `lookup(key)` would fail, or `deliver` would create one.
Go's notice reaches a group that only ever received messages. Decide: `deliver` to a possibly-new
conversation, or a direct send for notices only.

**13.11 Does docs sync need a durable task at all?** §7.4. The evidence both ways is there; the cheapest
path that satisfies T5.2's verify list is the in-process schedule + `notify`. The main session decides.

**13.12 `sleepUntil` and the system clock.** `sleepUntil(until)` commits against the harness clock
(`D/types.d.ts:308-315`), and `HarnessOptions.now` is injected (`adapter.ts:718`, `now` default
`Date.now`). A clock that jumps (laptop sleep, NTP) does not wake a sleeping task early or late in a way
the code can see — Go handled this with a one-minute wall-clock tick (`checkin.go:314-318`: "timers drift
while a laptop sleeps"). The port must therefore re-check the due-window **after every wake** (§11) and
must not assume the sleep elapses at the intended instant. Tests need the adapter's `setTimer` seam
(`adapter.ts:729-733`) or pi-durable's faux clock; Go's equivalent was an injected `Now`
(`checkin_test.go:19-22`).

**13.13 What "abort pending `movin.outbox.delivery` tasks" means for a sleep-backoff.** A delivery that is
`sleeping` on a 429 backoff is a live task and must be aborted by the restore path (nothing resent). A
delivery that is `waiting` on its predecessor (`adapter.ts:1410-1422`) also counts. `inspect()` gives both
with their `state.kind`; the abort handler settles `aborted` with no reason (`adapter.ts:1493-1497`), so
neither is resent. Confirm with a test: a restored DB with a sleeping delivery sends nothing.

**13.14 `recent` in the intake ledger after a restore.** Clearing `queue` and `open` (`plan.md:135`) leaves
`recent` (the dedupe list). `plan.md:49` also says "drop the stored polling offset (Telegram's own pending
queue is used; known request IDs are ignored)": `cursor = 0` **and** `recent` kept means updates Telegram
redelivers are dropped as already-known, which is the intent. Decide explicitly, because the reverse
(clearing `recent`) would replay up to 256 old updates.

**13.15 The start counter's failure mode.** If S3 is unreachable at start, the counter cannot be compared.
Failing the start is wrong (Go's app starts without S3 only to fail every write); treating it as "equal"
means a restored DB starts silently. Decide: log a warning and start normally (with the explicit
`HARNESS_RESTORE_ID` as the fallback), or refuse to start. `plan.md:47` makes the explicit trigger
"harmless to leave set", which suggests the former plus a doc line.

**13.16 Velero's TTL wording.** `plan.md:135` says "keep 7 days"; `velero-default` uses `ttl: 720h` and
`plan.md:43` says TTL 720h. movin's own Schedule should say `ttl: 168h` (7 days) and `velero.md` must
state which one is which, so a restore is looked for in the right place.

**13.17 The guide's existing check-in text is now the spec.** `docs/admin-guide.md:281` already describes
the finished behaviour ("Every day at 09:30 … If the app wasn't running at 09:30, it goes out when the app
starts, until 20:00; after that the day is skipped, and the next check-in also asks about the missed days
(up to a week back)"), and `:208`/`:290`/`:324`/`:364-365` describe the settings and the status line. If
T5.1 ends up differing anywhere (e.g. no catch-up after a restore), the guide is the file that must
change — the plan's T5.3 only adds "Chat history backup".

---

## 14. What I could not determine

1. **Whether T5.2 should be a durable task.** §7.4 gives both sides; `plan.md:133` names the step but not
   the mechanism, and nothing in `decisions.md` decides it. The judgement call is the main session's.
2. **Which conversation owns the check-in and docs-sync tasks**, and whether a dedicated scheduler
   conversation is acceptable in the admin page's chat list. Nothing in `plan.md`/`decisions.md` says.
3. **How the check-in enters the transcript** (13.4). Go's `remember` has no direct v3 equivalent that is
   both invisible to the web history and present in the model context without a new entry kind; the
   choice changes `history()`'s output.
4. **Whether a Go-written `checkin.json` mid-`sending` is taken over by the TS app inside the 10-minute
   window** — the code says yes after 10 minutes; whether the cutover needs anything faster is a product
   question, not a code one.
5. **The exact `epoch.json` contents** beyond "a counter and the recorded restore ID" — `plan.md:48` only
   says "a start counter kept both in SQLite and in S3 … conditional put". Field names, whether the
   restore ID is stored there too, and whether the object needs a `schema` field are undecided.
6. **The instance name's source** — `plan.md:48` says `dev` | `prod` but not which env var, and
   `deploy/k8s` has no such variable today; T6.2 (manifests) and T6.1 (compose) would both need it.
7. **Whether `docs/movin-v3/velero.md` should also cover `entries.json`/`settings.json` restore** — those
   live in S3 with versioning (guide `:254`), not on the volume, so the answer is presumably no, but
   `plan.md:135` only names the volume.
