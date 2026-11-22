# syntax=docker/dockerfile:1

# The production image of the TypeScript app: the pinned Node 24 plus the
# poppler tools the documents feature shells out to, running as uid 65532 on a
# read-only root filesystem (deploy/k8s/base/deployment.yaml). The app is the
# repo root (T7.2 moved app/ up), so the build context is the repo root too:
#   docker build -f Dockerfile -t movin-app:local .
# `make run` does that and starts it as docker-compose.yml's app-image.
# .dockerignore is the allowlist for this context: src/, static/,
# docs/admin-guide.md and the config files get in, nothing else in the repo.
#
# There is no build step: Node 24 strips the types at load, exactly as the dev
# app runs (`node src/main.ts`, compose `app-ts`), and `typescript` is a dev
# dependency. The image keeps /srv/app, because the liveness probe hardcodes
# /srv/app/src/main.ts (deploy/k8s/base/deployment.yaml:60), so config.ts
# resolves the guide at ../docs and static-disk.ts the page at ../static:
#   /srv/app/{src,static,docs,package.json,node_modules} + /data

# ---- the pinned dependencies: prod only, no install scripts ----
# The only prod packages with install scripts are @google/genai and
# protobufjs, which nothing here loads; the platform binaries in the lockfile
# (biome, rolldown, tsc, lightningcss) are dev tools. BUILDPLATFORM: what is
# installed has no platform-specific native module, so the arch that installs
# does not matter.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
WORKDIR /srv/app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- the OS packages and the user: the same digest as deps ----
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
# poppler-utils pinned to its minor release (patch fixes still come in), the
# same packages the compose `app-test` and `app-ts` containers run with.
# DejaVu is the fallback for drawings whose fonts are not embedded. fc-cache -f
# builds fontconfig's cache here, so a render cannot log "No writable cache
# directories" (docs-spec §9.11). /data is the volume; it is created here so
# the image also runs without one.
RUN apk add --no-cache "poppler-utils~25.12" font-dejavu fontconfig \
 && fc-cache -f \
 && adduser -D -H -u 65532 nonroot \
 && mkdir -p /data && chown 65532:65532 /data

# ---- the poppler tests: the converter and the render, on the tools above ----
# The CI step `poppler-test` builds this stage on linux/amd64, so a poppler
# bump that breaks a converter fails before the image is published. It used to
# be `go test` in the Go image (T7.1 replaced it). The compose containers that
# run the whole vitest suite (`app-test`, `app-ts`) are this `runtime` stage
# with the sources mounted, so they carry the same tools.
# No S3_* here: vitest's global setup (test/s3-setup.ts) returns at once
# without S3_ENDPOINT_URL, and these files use the memory store only.
FROM runtime AS poppler-test
WORKDIR /srv/app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY test ./test
# The user gets /srv/app itself, because vitest bundles the config into
# vitest.config.ts.timestamp-*.mjs next to it, and its module cache dir, so the
# run does not warn that both are unwritable. The rest of node_modules is read
# only and stays root's. HOME is /tmp, as in production.
RUN chown 65532:65532 /srv/app \
 && mkdir -p /srv/app/node_modules/.vitest-cache \
 && chown 65532:65532 /srv/app/node_modules/.vitest-cache
ENV HOME=/tmp
USER 65532:65532
RUN npx vitest run src/docs/convert/poppler.test.ts src/docs/render.test.ts

# ---- the sources the image ships: no tests, no goldens ----
# The poppler-test stage needs both, so .dockerignore admits src/ whole; this
# stage is the filter. The image must ship 0 testdata directories and 0
# *.test.ts files (checked at T6.1, T7.1 and T7.2).
FROM runtime AS app-src
COPY src /srv/app/src
RUN find /srv/app/src \( -name '*.test.ts' -o -name testdata \) -exec rm -rf {} +

# ---- production ----
FROM runtime
COPY --from=deps /srv/app/node_modules /srv/app/node_modules
# package.json carries "type": "module", which is what makes Node treat the
# .ts files as ES modules (package-lock.json is not copied: nothing reads it).
COPY package.json /srv/app/package.json
COPY --from=app-src /srv/app/src /srv/app/src
COPY static /srv/app/static
COPY docs/admin-guide.md /srv/app/docs/admin-guide.md
# HOME and XDG_CACHE_HOME are the writable places under the read-only root
# (/tmp is a tmpfs in k8s and compose): fontconfig wants a cache, and anything
# else that writes a dotfile in $HOME finds one. TZ is the Go v1 image's.
ENV NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    TZ=Asia/Singapore
USER 65532:65532
WORKDIR /srv/app
EXPOSE 8080
# The app listens on 127.0.0.1, so the probe is an exec of the same
# `healthcheck` the Go binary had (main.go:207-224): GET /healthz, 3 s.
HEALTHCHECK CMD ["node", "src/main.ts", "healthcheck"]
# The manifest's `args: ["serve"]` replaces CMD, so the entrypoint stays this.
ENTRYPOINT ["node", "src/main.ts"]
CMD ["serve"]
