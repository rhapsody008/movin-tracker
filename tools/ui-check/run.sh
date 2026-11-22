#!/usr/bin/env bash
# UI check for static/index.html: headless Chrome against a THROWAWAY TS app
# on MinIO (never the real bucket: the check edits entries and settings).
#   app-ts on 127.0.0.1:8090 (bot off), fake LLM on :18090, screenshots and the
#   result in tmp/ui-check-ts/. Run from anywhere:
#   tools/ui-check/run.sh      (or: make ui-check)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
out="$root/tmp/ui-check-ts"
mkdir -p "$out"
cd "$root"
python3 "$here/fakellm.py" 18090 >/dev/null 2>&1 &
llm=$!
# MinIO is stopped again only if this run started it: a dev stack or another
# check may already be using it (F19).
minio_started=no
docker compose ps --status running --services 2>/dev/null | grep -qx minio || minio_started=yes
cleanup() {
  docker rm -f movin-uicheck-ts >/dev/null 2>&1 || true
  kill "$llm" 2>/dev/null || true
  if [ "$minio_started" = yes ]; then docker compose stop minio >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
docker compose up -d minio >/dev/null
docker rm -f movin-uicheck-ts >/dev/null 2>&1 || true
# The Go run.sh's overrides, so the bucket is the throwaway one and the bot is
# off; plus DEV_EMAIL (the user the check asserts on), and the LLM stub for the
# drawer's saved endpoint.
HOST_UID=$(id -u) HOST_GID=$(id -g) docker compose --profile ts run -d --name movin-uicheck-ts -p 127.0.0.1:8090:8080 \
  -e S3_ENDPOINT_URL=http://minio:9000 -e S3_BUCKET=movin-dev -e S3_PREFIX=dev \
  -e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin \
  -e TELEGRAM_BOT_TOKEN= -e DEV_EMAIL=dev@localhost \
  -e LLM_BASE_URL=http://host.docker.internal:18090/v1 -e LLM_API_KEY=stub-key \
  app-ts >/dev/null
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8090/readyz >/dev/null && break; sleep 3; done
curl -s -H 'X-Forwarded-Email: dev@localhost' http://127.0.0.1:8090/api/admin/storage | grep -q '"bucket":"movin-dev"' || { echo "not the throwaway bucket; stopping"; exit 1; }
node "$here/check.mjs" | tee "$out/last.txt"
echo "PASS $(grep -c '^PASS' "$out/last.txt"), not passing: $(grep -c -v '^PASS' "$out/last.txt" || true) line(s)"
