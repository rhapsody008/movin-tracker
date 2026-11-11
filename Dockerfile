# syntax=docker/dockerfile:1

# ---- source; also the image `make test` and `make lint` run in ----
# Modules are vendored, so building and testing need no network beyond
# Docker Hub.
FROM --platform=$BUILDPLATFORM golang:1.27 AS base
# poppler-utils: the PDF tools the documents feature runs (tests use them too).
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .

# ---- local dev: rebuilds and restarts on Go changes (static/ is served from disk) ----
FROM base AS dev
# Dev only: fetching air is the one step that needs the Go module proxy.
RUN go install github.com/air-verse/air@v1.67.4
CMD ["air", "-c", ".air.toml"]

# ---- static binary, cross-compiled for the target platform (no emulation) ----
FROM base AS build
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/movin ./cmd/movin

# ---- production: the binary plus poppler's PDF tools, non-root, read-only root filesystem ----
# Alpine rather than distroless because the documents feature runs pdfinfo,
# pdftotext and pdftocairo (GPL, unmodified packages). DejaVu is the fallback
# for drawings whose fonts aren't embedded.
FROM alpine:3.20
RUN apk add --no-cache poppler-utils font-dejavu fontconfig \
 && fc-cache -f \
 && adduser -D -H -u 65532 nonroot
COPY --from=build /out/movin /movin
USER 65532:65532
# Fontconfig wants a per-user cache; /tmp is the one writable place.
ENV XDG_CACHE_HOME=/tmp/.cache
EXPOSE 8080
ENV TZ=Asia/Singapore
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["/movin", "healthcheck"]
ENTRYPOINT ["/movin"]
