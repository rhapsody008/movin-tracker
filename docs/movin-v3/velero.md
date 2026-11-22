# Velero: backup and restore of the chat-history volume

What this file covers: the SQLite database on PVC `movin-data` (mounted at `/data`). It holds chat history, durable tasks, the Telegram inbox ledger and the start counter.

What it doesn't cover: `entries.json`, `settings.json`, `checkin.json` and the documents. They live in the S3 bucket `movintrackerbackend`, with object versioning; see the admin guide, "Recover older data". A volume restore never rolls them back.

Status: **written in T5.3b; v2 is live since 2026-11-22 and the PVC exists, but the Schedule and drill below are not applied yet.** The Schedule and the drill pod are files: `deploy/velero/movin-data-daily.yaml`, `deploy/velero/drill-pod.yaml` (paths relative to the movin-tracker repo). The Schedule and the drill are T6.7. Until the drill is recorded in `progress.md`, the volume's data counts as not backed up.

Every command below:
- runs from the `zy-ops` repo root;
- ends with `--kubeconfig kubeconfigs/zy-all-in-one.conf`;
- is marked **read-only** or **state-changing**.

ZY runs every state-changing command.

## 1. What Velero looks like on zy-all-in-one (checked 2026-11-20)

| Thing | State |
|---|---|
| Velero | v1.18.0, NKP workspace app, namespace `zy-all-in-one-workspace` |
| Backup storage location | `default`: AWS S3 `zyallinonebackups` (ap-southeast-1), Available |
| Cluster schedule | `velero-default`: daily 00:00, whole cluster, `ttl: 720h` (30 days) |
| Uploader | kopia, but **no node-agent** DaemonSet, so there are no file-system backups |
| Snapshot class | `nutanix-snapshot-class`, labelled `velero.io/csi-volumesnapshot-class: "true"` on 2026-11-22 (`decisions.md`, "ZY's answers on the open items") |

- **CSI in v1.18 still needs the feature flag (corrected 2026-11-22).** The first manual backup (`movin-data-manual-20261122`) completed with the PVC object only: the log says `Skip action velero.io/csi-pvc-backupper … because the CSI feature is not enabled`, and `velero-default` takes no volume snapshots either. The server runs without `--features=EnableCSI`. Fix: add `configuration.features: EnableCSI` to the Velero app's config overrides in NKP (ConfigMap `velero-config-overrides`, owned by Kommander), then re-run the backup and check for a VolumeSnapshot. **Until then nothing on this cluster has its volume data backed up.**
- **The label can be lost.** The snapshot class belongs to the `nutanix-csi` Helm release (`ntnx-system`), and a chart upgrade can drop an extra label. Without it, a backup copies the PVC object but **not its data**.
- **Where snapshots live:** on the same Nutanix storage as the volume, not off-site. That was accepted, see `decisions.md`.
- **Secrets are in the cluster backup.** `velero-default` already copies the whole cluster into `zyallinonebackups`, `movin-secrets` included. That's a cluster-wide choice, outside this plan.

Check the label (**read-only**) after any NKP or CSI upgrade:

```sh
kubectl get volumesnapshotclass nutanix-snapshot-class -o jsonpath='{.metadata.labels.velero\.io/csi-volumesnapshot-class}{"\n"}' --kubeconfig kubeconfigs/zy-all-in-one.conf
# expect: true
```

## 2. The movin Schedule (T6.7, state-changing)

The Schedule covers only `movin-data` and its PV. It runs daily and keeps 7 days, `ttl: 168h0m0s`. Don't confuse it with `velero-default`'s 30 days: when you look for a restore point, a movin backup older than 7 days is gone, while the whole-cluster one may still hold the volume.

```yaml
apiVersion: velero.io/v1
kind: Schedule
metadata:
  name: movin-data-daily
  namespace: zy-all-in-one-workspace
spec:
  schedule: "30 2 * * *"          # 02:30 cluster time: after velero-default (00:00), before the 03:00 docs sync
  template:
    includedNamespaces: [movin-tracker]
    includedResources: [persistentvolumeclaims, persistentvolumes]
    labelSelector:
      matchLabels: { app.kubernetes.io/component: data }   # set on the PVC in deploy/k8s/base/pvc.yaml
    snapshotVolumes: true
    ttl: 168h0m0s
```

Apply it (**state-changing**; ZY):

```sh
kubectl apply -f <file> --kubeconfig kubeconfigs/zy-all-in-one.conf
```

Check it (**read-only**):

```sh
kubectl get schedule movin-data-daily -n zy-all-in-one-workspace --kubeconfig kubeconfigs/zy-all-in-one.conf
kubectl get backups -n zy-all-in-one-workspace -l velero.io/schedule-name=movin-data-daily --kubeconfig kubeconfigs/zy-all-in-one.conf
```

Back up once by hand before the drill (**state-changing**). It writes a backup and takes a snapshot:

```sh
velero backup create movin-data-manual-$(date +%Y%m%d) --from-schedule movin-data-daily -n zy-all-in-one-workspace --kubeconfig kubeconfigs/zy-all-in-one.conf
```

## 3. Restore drill into a scratch namespace (T6.7)

The goal is to prove that a backup holds a readable database, without touching the live app.

1. **Restore** (**state-changing**; it creates the namespace `movin-drill` and a PVC in it):
   ```sh
   velero restore create movin-drill-$(date +%Y%m%d) --from-backup <backup> --namespace-mappings movin-tracker:movin-drill -n zy-all-in-one-workspace --kubeconfig kubeconfigs/zy-all-in-one.conf
   kubectl get pvc -n movin-drill --kubeconfig kubeconfigs/zy-all-in-one.conf    # read-only; expect movin-data Bound
   ```
2. **Inspect it** with a throwaway pod that mounts the restored PVC read-only. It uses a minimal image with `sqlite3`, and the app never runs in the drill namespace. Apply the pod (**state-changing**), then run these read-only checks:
   ```sh
   kubectl exec -n movin-drill drill -- sqlite3 /data/harness.db "PRAGMA integrity_check;"   # expect: ok
   kubectl exec -n movin-drill drill -- sqlite3 /data/harness.db "SELECT count(*) FROM sqlite_master;"
   kubectl exec -n movin-drill drill -- ls -l /data
   ```
   Record the backup name, the integrity result, the table count and the file sizes in `progress.md`, under T6.7.
3. **Clean up** (**state-changing**; it deletes only the drill namespace):
   ```sh
   kubectl delete namespace movin-drill --kubeconfig kubeconfigs/zy-all-in-one.conf
   ```

## 4. The real restore, in order

Use this only when the live database is lost or damaged. Every step is **state-changing** and is run by ZY.

1. **Suspend Flux,** so it doesn't scale the app back up mid-restore:
   ```sh
   flux suspend kustomization movin -n movin-tracker --kubeconfig kubeconfigs/zy-all-in-one.conf
   ```
   (Or set `suspend: true` in `deploy/flux/release.yaml`.)
2. **Stop the app:**
   ```sh
   kubectl scale deployment movin -n movin-tracker --replicas=0 --kubeconfig kubeconfigs/zy-all-in-one.conf
   ```
3. **Restore the PVC.** First delete the damaged PVC. This destroys the volume (reclaim policy Delete), so be sure you have the backup name. Then restore:
   ```sh
   kubectl delete pvc movin-data -n movin-tracker --kubeconfig kubeconfigs/zy-all-in-one.conf
   velero restore create movin-restore-$(date +%Y%m%d) --from-backup <backup> -n zy-all-in-one-workspace --kubeconfig kubeconfigs/zy-all-in-one.conf
   ```
4. **Set a new restore id. This step is mandatory.** The app's automatic detection compares a start counter in SQLite with one in S3 (`harness/prod/epoch.json`). It can't see a restore when the app did not start between the snapshot and the restore, which is exactly this procedure. The id is what tells the app:
   ```sh
   kubectl create configmap movin-restore -n movin-tracker --from-literal=HARNESS_RESTORE_ID=$(date +%Y%m%d-%H%M) --dry-run=client -o yaml | kubectl apply -f - --kubeconfig kubeconfigs/zy-all-in-one.conf
   ```
   Any value that differs from the last one works. Leaving it set afterwards is harmless: the app records it and doesn't run the restore path again for the same id.
5. **Resume Flux,** which scales the app back to 1:
   ```sh
   flux resume kustomization movin -n movin-tracker --kubeconfig kubeconfigs/zy-all-in-one.conf
   ```
6. **Check** (**read-only**):
   ```sh
   kubectl logs deploy/movin -n movin-tracker -c app --kubeconfig kubeconfigs/zy-all-in-one.conf | grep '"harness start"'
   ```
   Expect `"restore":"id"`, plus the counts `tasksAborted`, `submissionsAborted` and `intakeDropped`.

### What the app does on a restore (T5.3a)
Before anything runs, the app:
- cancels every unfinished turn, tool call, queued message and unsent reply in the restored database, so nothing old is sent again and no tool is run twice;
- empties the Telegram inbox ledger, keeping its list of seen update ids, and polls Telegram from its own pending queue;
- starts a fresh change-id series;
- re-creates the scheduled check-in and docs sync. The `checkin.json` claim in S3 stops a second check-in on the same day.

Chat history made after the snapshot is lost. Entries, settings and documents are untouched, because they live in S3.

## 5. Traps
- **`MOVIN_INSTANCE` must be right.** Each deployment keeps its own counter (`harness/dev/…`, `harness/prod/…`). A laptop run with `MOVIN_INSTANCE=prod` on the real bucket bumps prod's counter, and prod's next start then takes itself for a restored database and drops its pending replies. Dev runs use `dev`.
- **S3 unreachable at start:** the app waits and retries (`harness start counter unreadable`). It never starts as if nothing happened.
- **The PVC is in the Flux artifact** (`deploy/k8s/base/pvc.yaml`, ZY 2026-11-22). Keep Flux suspended for the whole restore, or it recreates an empty PVC the moment the damaged one is deleted. A rollback to a 1.0.x release (which has no PVC) makes Flux prune the PVC and its data; restore from a backup if v2 comes back.
- **Was:** the PVC was not in the Flux artifact (`deploy/manual/pvc.yaml`, T6.2), so Flux's `prune` can't delete it, and a restore doesn't fight Flux over it.
