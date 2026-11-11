# syntax=docker/dockerfile:1

# ---- source; also the image `make test` and `make lint` run in ----
# Modules are vendored, so building and testing need no network beyond
# Docker Hub.
FROM --platform=$BUILDPLATFORM golang:1.27 AS base
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

# ---- production: one binary, non-root, works on a read-only root filesystem ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/movin /movin
USER nonroot:nonroot
EXPOSE 8080
ENV TZ=Asia/Singapore
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["/movin", "healthcheck"]
ENTRYPOINT ["/movin"]
