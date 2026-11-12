# Strict review, 2026-11-12: milestones + morning check-in (da0320d..67b2eeb)

Verdict: **REJECT** (report only; ZY decides). `make lint` / `make test` passed for the reviewer.

## Blocker
- **B1** Daily check-ins never ask about yesterday: `CheckinRecord.Since()` returns the day after the last check-in, but that day's tasks were listed as "Today" then, not asked. On the 13th after a 12th check-in, Since = 13th → Ask is empty, the 12th's open tasks only appear as "Still overdue" without buttons. Tests jump 12th → 15th and one asserts the wrong value. Fix: Since() = r.Day for sent/quiet; add a back-to-back-days test. (Confirmed by reading checkin_state.go.) The plan had the same off-by-one.

## Major
- **M1** Taking over a stale `sending` claim asks about nothing (Since = today). Fix: store the window (`since`) in the claim record.
- **M2** The in-memory "handled today" shortcut is set when another copy holds a fresh claim (or our own unreleased one), so this process never retakes it after 10 min. Fix: shortcut only on sent/quiet for today.
- **M3** Check-in history injection vs an agent turn in flight: `converse` assigns its earlier copy back to `h.turns`, overwriting the check-in turns (or writes to an orphaned history). Fix: append under the lock to the current history.
- **M4** Hand-rolled patch JSON round trip with ignored errors; use `entries.PatchFromMap`.

## Minor
- `IdleReset` default written by Run while the check-in reads it (data race); one default place.
- Release error dropped in one path, logged in the other.
- `CHECKIN_CHAT` not checked against the allowlist (buttons would all be refused); warn/report it.
- `docs` forwarders to `sched`; two clocks (`CheckinStore.Now` + `Bot.Now`); `sched.Day` duplicates `Service.today`.

## Nits
- Explicit `completed:null` on a done entry → "done on " with nothing.
- "09:30" default in three places; main re-parses and drops the error; config imports telegram for one constant.
- No `internal/sched` tests; `CheckinTick` exported without a nil check; a server test ignores errors.

## Questions for ZY
- A press after the task was rescheduled elsewhere still applies (Tomorrow moves it back). Treat as stale? (put the asked date in the callback data; fits in 64 bytes)
- A press racing a web edit isn't atomic (no conditional update in the Service).

## Checked fine
settleCompleted (create/update, TZ boundary, explicit day, leaving done, kind change, undo); web dialog diffing; prompt-cache layout; callback size; claim protocol (one winner on memory + MinIO).

## Status (2026-11-12)
- ZY: fix all, including Q1. Fixed in 32d0741 (B1, M1–M4, minors, nits; Q1: buttons carry the asked date). Q2 (press racing a web edit) left open: tiny window, two users.

## Re-review: APPROVE WITH NITS
All earlier findings confirmed resolved against code and tests. New nits N1–N7 (config dead field / two schedule styles, alias constant, untested NextSince branch, mid-turn test could pass vacuously, config errors remembered for the day, ignored test errors, bad-date answer) — all fixed next (see progress.md).

