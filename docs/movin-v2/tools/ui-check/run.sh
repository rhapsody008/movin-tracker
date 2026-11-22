#!/usr/bin/env bash
# UI check for static/index.html: headless Chrome against a THROWAWAY app on
# MinIO (never the real bucket: the check edits entries and settings).
#   app on 127.0.0.1:8090 (bot off), fake LLM on :18090, screenshots and the
#   result in tmp/ui-check/. Run from the repo root:
#   docs/movin-v2/tools/ui-check/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p tmp/ui-check
python3 "$here/fakellm.py" 18090 >/dev/null 2>&1 &
llm=$!
cleanup() { docker rm -f movin-uicheck >/dev/null 2>&1 || true; kill "$llm" 2>/dev/null || true; docker compose stop minio >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker compose up -d minio >/dev/null
docker rm -f movin-uicheck >/dev/null 2>&1 || true
docker compose run -d --name movin-uicheck -p 127.0.0.1:8090:8080 \
  -e S3_ENDPOINT_URL=http://minio:9000 -e S3_BUCKET=movin-dev -e S3_PREFIX=dev \
  -e AWS_ACCESS_KEY_ID=minioadmin -e AWS_SECRET_ACCESS_KEY=minioadmin \
  -e TELEGRAM_BOT_TOKEN= -e LLM_CLAUDE_BASE_URL=http://host.docker.internal:18090 \
  app go run ./cmd/movin >/dev/null
for _ in $(seq 1 60); do curl -sf http://127.0.0.1:8090/readyz >/dev/null && break; sleep 3; done
curl -s http://127.0.0.1:8090/api/admin/storage | grep -q '"bucket":"movin-dev"' || { echo "not the throwaway bucket; stopping"; exit 1; }
node "$here/check.mjs" | tee tmp/ui-check/last.txt
echo "PASS $(grep -c '^PASS' tmp/ui-check/last.txt), not passing: $(grep -c -v '^PASS' tmp/ui-check/last.txt || true) line(s)"
