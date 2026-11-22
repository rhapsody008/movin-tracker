# syntax=docker/dockerfile:1

# The v3 (TypeScript) production image: the pinned Node 24 plus the poppler
# tools the documents feature shells out to, running as uid 65532 on a
# read-only root filesystem (deploy/k8s/base/deployment.yaml). Build it from
# the repo root, because both app/ and docs/admin-guide.md are needed:
#   docker build -f app/Dockerfile -t movin-app:local .
# `make -C app run` does that and starts it as docker-compose.yml's app-image.
# app/Dockerfile.dockerignore is the allowlist for this context; the root
# Dockerfile, Makefile and .dockerignore stay the Go image's.
#
# There is no build step: Node 24 strips the types at load, exactly as the dev
# app runs (`node src/main.ts`, compose `app-ts`), and `typescript` is a dev
# dependency. The layout mirrors the repo, so config.ts resolves the guide at
# ../../docs and static-disk.ts the page at ../../static with no env:
#   /srv/app/{src,static,package.json,node_modules} + /srv/docs/admin-guide.md

# ---- the pinned dependencies: prod only, no install scripts ----
# The only prod packages with install scripts are @google/genai and
# protobufjs, which nothing here loads; the platform binaries in the lockfile
# (biome, rolldown, tsc, lightningcss) are dev tools. BUILDPLATFORM: what is
# installed has no platform-specific native module, so the arch that installs
# does not matter.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS deps
WORKDIR /srv/app
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---- the OS packages and the user: the same digest as deps and app/Dockerfile.test ----
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
# poppler-utils pinned to its minor release (patch fixes still come in), the
# same packages as the Go runtime image (Dockerfile:34-36) and
# app/Dockerfile.test. DejaVu is the fallback for drawings whose fonts are not
# embedded. fc-cache -f builds fontconfig's cache here, so a render cannot log
# "No writable cache directories" (docs-spec §9.11). /data is the volume; it
# is created here so the image also runs without one.
RUN apk add --no-cache "poppler-utils~25.12" font-dejavu fontconfig \
 && fc-cache -f \
 && adduser -D -H -u 65532 nonroot \
 && mkdir -p /data && chown 65532:65532 /data

# ---- production ----
FROM runtime
COPY --from=deps /srv/app/node_modules /srv/app/node_modules
# package.json carries "type": "module", which is what makes Node treat the
# .ts files as ES modules (package-lock.json is not copied: nothing reads it).
COPY app/package.json /srv/app/package.json
COPY app/src /srv/app/src
COPY app/static /srv/app/static
COPY docs/admin-guide.md /srv/docs/admin-guide.md
# HOME and XDG_CACHE_HOME are the writable places under the read-only root
# (/tmp is a tmpfs in k8s and compose): fontconfig wants a cache, and anything
# else that writes a dotfile in $HOME finds one. TZ is the Go image's.
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
