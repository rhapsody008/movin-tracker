> Planner `7b213eaf-c83c-4a8`, adopted by the main session 2026-11-22 (ZY away). Answers to §5: (1) last v1 tag is `v1.0.1`; `git diff v1.0.1 HEAD -- cmd internal vendor go.mod Dockerfile deploy .github` is empty, so `release/1.0` can start at `v1.0.1`. (2) the compose MinIO bucket is `movin-test` (`docker-compose.yml:13`), not `movin-dev`. (3) overlay. (4) to measure in T6.1.

# Plan: T6.1 (image and CI) and T6.2 (manifests, files only)

## 1. Goal and assumptions
Add the TS image, CI and manifests on `main` with no push, no tag and no cluster contact. Nothing was run; all findings are from reading files.

**Hotfix finding.** A tag builds entirely from its own tree: `image.yml` is read at the tagged commit, and `render.sh` copies `$(dirname "$0")` from that checkout. So editing `main` is safe only if a v1.0.x hotfix is tagged from a v1 tree, not from `main`. After T6.2, a `v1.*` tag on `main` would ship v2 manifests (PVC mount, node probe) to prod, because the Flux pin is still `>=1.0.0`.

## 2. Design
- **Dockerfile location:** new `app/Dockerfile`, build context at the repo root. The root `Dockerfile`, `Makefile` and `.dockerignore` stay untouched.
- **Layout:** mirror the repo as `/srv/app/{src,static,package.json,node_modules}` plus `/srv/docs/admin-guide.md`. `config.ts` resolves the guide at `../../docs` and `static-disk.ts` resolves `../../static`, so no extra env is needed.
- **No build step:** dev already runs `node src/main.ts` (compose `app-ts`); `package.json` has no build script and `typescript` is dev-only.
- **Dependencies:** `npm ci --omit=dev --ignore-scripts`, as `app/Makefile` does. SQLite is `node:sqlite` via pi-durable. The only prod install scripts are `@google/genai` and `protobufjs`, which are never loaded. The platform binaries I saw in the lockfile are dev tools (biome, rolldown, tsc, lightningcss).
- **Digest:** reuse `node:24-alpine@sha256:116b800c…85f5`, already pinned in `app/Dockerfile.test` and `app/Makefile`. No new pull is needed.
- **Liveness:** exec is required because the app listens on `127.0.0.1`. `node src/main.ts healthcheck` loads the whole import graph every 30 s inside the 384Mi cgroup, so T6.1 must measure it.

## 3. Steps (all local file changes; rollback is reverting the listed files)

**T6.1**

1. **`app/Dockerfile`**
   - Stage `deps` (`FROM --platform=$BUILDPLATFORM` the pinned digest): copy `app/package.json` and `app/package-lock.json`, then `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`.
   - Stage `runtime` (same digest): `apk add --no-cache "poppler-utils~25.12" font-dejavu fontconfig && fc-cache -f && adduser -D -H -u 65532 nonroot && mkdir /data && chown 65532:65532 /data`.
   - Final stage: copy `node_modules`, `app/package.json` (needed for `"type":"module"`), `app/src`, `app/static`, `docs/admin-guide.md`.
   - `ENV NODE_ENV=production HOME=/tmp XDG_CACHE_HOME=/tmp/.cache TZ=Asia/Singapore`, `USER 65532:65532`, `WORKDIR /srv/app`, `EXPOSE 8080`.
   - `HEALTHCHECK CMD ["node","src/main.ts","healthcheck"]`, `ENTRYPOINT ["node","src/main.ts"]`, `CMD ["serve"]`. This keeps the manifest's `args: ["serve"]` valid.
2. **`app/Dockerfile.dockerignore`**: allowlist (`*`, then `!app/package*.json`, `!app/src`, `!app/static`, `!docs/admin-guide.md`), plus `app/src/**/*.test.ts`.
3. **`docker-compose.yml`**: add service `app-image` under profile `image`.
   - `image: movin-app:local`, no `env_file`, `<<: *minio-env`.
   - `S3_BUCKET: movin-dev`, `S3_PREFIX: image-check`, `MOVIN_INSTANCE: dev`, `TELEGRAM_BOT_TOKEN: ""`, `DEV_EMAIL: dev@localhost`, `LISTEN_ADDR: ":8080"`, `NODE_OPTIONS: --max-old-space-size=256`.
   - `read_only: true`, `mem_limit: 384m`, `tmpfs: ["/tmp:size=32m"]`, `user: "65532:65532"`, `cap_drop: [ALL]`, no-new-privileges.
   - Volume `app-data:/data`, port `127.0.0.1:8091:8080`, `depends_on: [minio]`.
4. **`app/Makefile`**: add two targets.
   - `image`: `docker build -f Dockerfile -t movin-app:local ..`
   - `run`: `image`, then `docker compose -f ../docker-compose.yml --profile image up -d app-image`.
5. **`.github/workflows/image.yml`**
   - In the `build` step, add `file: app/Dockerfile`.
   - Add a job that runs `make -C app lint test`, and make `image` need it.
   - Keep the Go test job and the Go poppler step.
   - Add a first step that fails when `github.ref` matches `refs/tags/v1.*`, with the message "tag v1 hotfixes from release/1.0".
   - Update the header comment.
6. **Verify and record in `progress.md`:**
   ```sh
   docker buildx imagetools inspect node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5   # amd64+arm64
   make -C app run
   docker image inspect movin-app:local --format '{{.Size}}'
   curl -sf 127.0.0.1:8091/readyz
   curl -s -H 'X-Forwarded-Email: dev@localhost' 127.0.0.1:8091/api/admin/storage | grep '"bucket":"movin-dev"'
   docker compose exec app-image sh -c 'id -u; touch /x; ls -l /data/harness.db; grep VmRSS /proc/1/status; cat /sys/fs/cgroup/memory.peak'
   time docker compose exec app-image node src/main.ts healthcheck
   docker compose logs app-image | grep -i warning
   docker run --rm --entrypoint sh movin-app:local -c 'pdftoppm -v; pdftotext -v; fc-list | head -1; find /srv/app/node_modules -name "*.node"'
   docker compose restart app-image && curl -sf 127.0.0.1:8091/readyz
   make lint && make test && make -C app lint test
   git diff --stat -- Dockerfile Makefile .dockerignore cmd internal go.mod
   ```
   Expected:
   - `id -u` prints 65532 and `touch /x` fails.
   - `find` prints no `.node` files.
   - `/data/harness.db` survives the restart.
   - The final `git diff --stat` is empty.
   - Also record the peak during one PDF render.

**T6.2**

7. **`deploy/k8s/base/deployment.yaml`**, app container only. Keep the container order, because the overlay patches `containers/1/env/0`.
   - Remove `GOMEMLIMIT`; add `NODE_OPTIONS=--max-old-space-size=256` and `DATA_DIR=/data`.
   - Append `- configMapRef: { name: movin-restore, optional: true }` to `envFrom`.
   - Resources: `requests: { cpu: 10m, memory: 128Mi }`, `limits: { memory: 384Mi }`.
   - Liveness: `exec: ["node","/srv/app/src/main.ts","healthcheck"]`, `periodSeconds: 30`, `timeoutSeconds: 5`. The default 1 s timeout is too short for Node.
   - Mount `data` at `/data`; add volume `data` with `persistentVolumeClaim: { claimName: movin-data }`; raise `tmp` to `sizeLimit: 32Mi`.
   - Add `fsGroupChangePolicy: OnRootMismatch`. `fsGroup: 65532` and `Recreate` are already there; extend the Recreate comment to mention the RWO volume.
8. **`deploy/k8s/overlays/prod/kustomization.yaml`**: add literal `MOVIN_INSTANCE=prod`. Leave `newTag` alone (it only affects local renders).
9. **`deploy/k8s/base/kustomization.yaml`**: no change. The configmap has no Claude variables (checked).
10. **`deploy/manual/pvc.yaml`** (new): PVC `movin-data`, label `app.kubernetes.io/name: movin-data`, RWO, 1Gi, `storageClassName: nutanix-volume`, no namespace. Add a header comment: hand-applied in T6.4, reclaim policy Delete.
11. **`deploy/render.sh`**: extend the forbidden-kinds check to `(Namespace|Secret|PersistentVolumeClaim|PersistentVolume)`.
12. **`.env.example`**: replace the `LLM_KIND` block (lines 15–18) with "OpenAI-compatible only". Add a commented `MOVIN_INSTANCE=dev` and `DATA_DIR`.
13. **Verify (local render only):**
    ```sh
    kubectl kustomize deploy/k8s/overlays/prod > /tmp/movin-prod.yaml
    grep -c '^kind: PersistentVolume' /tmp/movin-prod.yaml          # 0
    grep -nE 'claimName: movin-data|MOVIN_INSTANCE|max-old-space|movin-restore|32Mi|384Mi|oauth2/callback' /tmp/movin-prod.yaml
    KUSTOMIZE="kubectl kustomize" deploy/render.sh sha256:$(printf '0%.0s' $(seq 64)) /tmp/out
    kubectl kustomize deploy/flux >/dev/null
    grep -rn manual deploy --include=kustomization.yaml             # nothing
    ```

## 4. Risks and approval points
- **v1 tag on `main` after T6.2 breaks prod.** Mitigated by the step 5 guard and a `release/1.0` branch; ZY should confirm this convention.
- **Any v2 tag before T6.3 deploys at once.** No tags in these steps.
- **`:main` and `:latest` become the TS image on the next push.** Nothing I read consumes them; the cluster is pinned by digest.
- **The liveness probe's Node process shares the 384Mi limit.** If T6.1 shows more than about 1 s or 60 MB, add a standalone `app/src/healthcheck.ts` with no imports. That is an app change and needs the main session's OK.
- **`app/Dockerfile.test` and `app/Dockerfile` can drift.** They share the digest and apk line by hand.
- **Cutover ordering.** The pod stays Pending until the PVC exists (T6.4 before T6.6), and Flux has `wait: true` with a 5 m timeout.

## 5. Open questions
1. What is the last v1 tag, and does `main`'s Go tree equal it? Run `git tag -l 'v1*' --sort=-v:refname | head -1`, then `git diff <tag> main --stat -- cmd internal vendor go.mod Dockerfile deploy`. If they differ, `release/1.0` must start at the tag.
2. Does the MinIO bucket `movin-dev` exist or get created automatically? `ui-check` assumes it; if `/readyz` fails in step 6, create it the way that check gets it.
3. Should `MOVIN_INSTANCE=prod` go in the overlay (as planned) or in the base?
4. Does a `/tmp` of 32Mi cover the largest poppler render? Confirm with the A1 case from T0.2.