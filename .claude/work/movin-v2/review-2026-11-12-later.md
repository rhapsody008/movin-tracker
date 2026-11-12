# Strict review, 2026-11-12 (later): f13a50c..961db38

Verdict: **CHANGES REQUIRED** (no blocker; report only, ZY decides). `make lint`, `make test`, `golangci-lint run` all clean for the reviewer.

## Major
- **M1** A failed settings.json read (S3 blip, decode error) makes `resolveCheckin` fall back to the env defaults: a check-in saved as Off or to a private chat could go to the group once. Fix: the tick skips when settings can't be read (or keeps the last good copy).
- **M2** Telegram tab: adding/removing a person or group (or saving the allowlist) re-renders the check-in form from the saved setting, wiping unsaved edits; "Save check-in" then saves the old values. Fix: render the form only on load and after its own save.
- **M3** No test for "invalid stored checkin section → env".

## Minor
1. Invalid-section warning logged every resolve (check-in and allowlist); use `warnOnce`.
2. `patchable` and `setters` duplicate the field list; derive one from the other.
3. chateval: 12 single-use check factories just for gocognit; prefer the inline table + a lint exclusion for cmd/chateval.
4. Two types named `CheckinView` (settings + telegram); rename the settings one.
5. Oversize message rounds down: "too large (32 MB; the limit is 32 MB)".

## Nits
Empty time saves 09:30 silently; the default-chat label omits the person fallback; "Invalid Date" for a hand-edited section without `updated`; config error no longer names which variable.

## Checked fine
All refactors behaviour-preserving (line by line); prompt layout; settings sections interplay; UpdateIf; warnOnce; PDF cap; check-in polling cost.
