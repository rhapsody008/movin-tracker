# Session history (v3)

Earlier sessions are summarised in `progress.md` (evidence per step) and `decisions.md`.

## 2026-11-22: cutover, T6.7, T7, v2.0.1
- ZY's live checks of v2.0.0 passed (Telegram save, Undo, `/checkin`, web chat across a restart); a cluster re-check found nothing.
- Committed the long-staged doc moves (`46c42cc`).
- T6.7: Velero Schedule as a hand-applied file (the movin Flux SA can't write in Velero's namespace). The first backup held no data: Velero ran without `EnableCSI`, so `velero-default` had no volume data either. ZY set it in the NKP UI; it only rolled out after annotating the AppDeploymentInstance. Backup with a CSI snapshot, then a restore drill into `movin-drill`: integrity `ok`, real rows.
- T7.1 deleted Go (`af4ed66`); T7.2 moved `app/` to the root (`f8aca3b`), with a no-change proof against the 2.0.0 image; `v2.0.1` tagged and live.
- Found: `kubectl rollout restart` is reverted by Flux, which restarts the pod a second time; the guide now says `kubectl delete pod`.
- Next: the GitHub issues (final review, UI, demo write-up, feature brainstorm, NKP test plan).
