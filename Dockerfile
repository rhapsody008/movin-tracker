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

# ---- the PDF tools the app runs; the production image and its poppler tests share it ----
# Alpine 3.24 (supported until about May 2028), pinned by digest; poppler is
# GPL, unmodified Alpine packages. DejaVu is the fallback for drawings whose
# fonts aren't embedded.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS runtime
# poppler-utils is pinned to its minor release (patch fixes still come in);
# make test and CI run the converter tests on this same stage.
RUN apk add --no-cache "poppler-utils~25.12" font-dejavu fontconfig \
 && fc-cache -f \
 && adduser -D -H -u 65532 nonroot

# ---- `make test` (last step): the converter tests against the poppler that ships ----
FROM base AS poppler-test-bin
ARG TARGETOS TARGETARCH
RUN --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go test -c -o /out/convert.test ./internal/docs/convert
FROM runtime AS poppler-test
COPY --from=poppler-test-bin /out/convert.test /t/convert.test
COPY internal/docs/convert/testdata /t/testdata
WORKDIR /t
USER 65532:65532
RUN set -o pipefail && ./convert.test -test.count=1 -test.v | grep -E "^(--- |ok|FAIL|PASS)"

# ---- production: the binary on the runtime above, non-root, read-only root filesystem ----
FROM runtime
COPY --from=build /out/movin /movin
USER 65532:65532
# Fontconfig wants a per-user cache; /tmp is the one writable place.
ENV XDG_CACHE_HOME=/tmp/.cache
EXPOSE 8080
ENV TZ=Asia/Singapore
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s CMD ["/movin", "healthcheck"]
ENTRYPOINT ["/movin"]
