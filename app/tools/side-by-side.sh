#!/usr/bin/env bash
# The v3 side-by-side check: two apps on ONE bucket and prefix, proven against
# each other over HTTP. Neither app knows about the other; they see each other's
# writes because the bucket is shared.
#
#   app/tools/side-by-side.sh <ts-base-url> <go-base-url> [--no-settings-write]
#   e.g. app/tools/side-by-side.sh http://127.0.0.1:8091 http://127.0.0.1:8090
#
# Credentials: this script reads NO .env. Step 5 and step 6 hash settings.json
# straight from the bucket, so they need the bucket's address and a key with
# read access, and those come from this script's own environment — the same
# variable names the apps read. They are passed to `s3_hash`'s Python process
# through its environment, used for one SigV4 GET, and never echoed: the output
# carries only a sha256, and the two admin views the script prints carry no key
# (the server's own contract: keySet, keyLast4, keyFromEnv). The defaults below
# are the docker-compose MinIO, so a MinIO run needs nothing. A variable that is
# set wins even when it is empty, exactly as the apps read it: S3_ENDPOINT_URL=""
# is the real AWS and S3_PREFIX="" is the bucket root.
#   S3_ENDPOINT_URL           http://127.0.0.1:9000  "" = AWS
#   S3_BUCKET / S3_PREFIX     movin-dev / dev        must match both apps'
#   AWS_REGION                ap-southeast-1
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY       minioadmin (read-only use)
#   AUTH_EMAIL                (empty)                X-Forwarded-Email for the
#                                                    requests; empty uses the
#                                                    app's own DEV_EMAIL
# On the real bucket:
#   S3_ENDPOINT_URL= S3_PREFIX= S3_BUCKET=<bucket> AWS_REGION=<region> \
#   AWS_ACCESS_KEY_ID=<key> AWS_SECRET_ACCESS_KEY=<secret> \
#   app/tools/side-by-side.sh <ts-url> <go-url> --no-settings-write
# The bucket and prefix must be the apps': the script refuses to run otherwise,
# because the sha256 in steps 5 and 6 is read straight from the bucket.
#
# One entry, titled "v3 side-by-side check <timestamp>", is created, used and
# deleted again; --no-settings-write skips step 6, which is the only step that
# changes settings.json, so the real bucket can be checked read-only.
#
#   1. create in TS     -> Go's GET /api/entries has it within 6 s
#   2. patch in Go      -> TS's GET /api/entries has the new status
#   3. undo in TS       -> the patch is gone; delete in Go -> both lists drop it
#   4. TS SSE open, Go creates the entry again -> a second `entries` event
#   5. GET the TS LLM settings and storage view -> sha256(settings.json) unchanged
#   6. PUT the check-in in TS -> Go's Telegram view reads it, and the rest of
#      settings.json is byte-identical (skipped with --no-settings-write)
set -uo pipefail

ts_url=${1:-}
go_url=${2:-}
if [ -z "$ts_url" ] || [ -z "$go_url" ]; then
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi
shift 2
settings_write=1
while [ $# -gt 0 ]; do
  case "$1" in
    --no-settings-write) settings_write=0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

# set-or-default: an exported-but-empty value wins, as the apps treat it.
if [ -z "${S3_ENDPOINT_URL+x}" ]; then S3_ENDPOINT_URL=http://127.0.0.1:9000; fi
if [ -z "${S3_BUCKET+x}" ]; then S3_BUCKET=movin-dev; fi
if [ -z "${S3_PREFIX+x}" ]; then S3_PREFIX=dev; fi
if [ -z "${AWS_REGION+x}" ]; then AWS_REGION=ap-southeast-1; fi
if [ -z "${AWS_ACCESS_KEY_ID+x}" ]; then AWS_ACCESS_KEY_ID=minioadmin; fi
if [ -z "${AWS_SECRET_ACCESS_KEY+x}" ]; then AWS_SECRET_ACCESS_KEY=minioadmin; fi
endpoint=$S3_ENDPOINT_URL
bucket=$S3_BUCKET
prefix=$S3_PREFIX
region=$AWS_REGION
access=$AWS_ACCESS_KEY_ID
secret=$AWS_SECRET_ACCESS_KEY
auth_email=${AUTH_EMAIL:-}

PASS=0
FAILED=0
pass() { PASS=$((PASS + 1)); echo "PASS  $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL  $1 - $2"; }

req() { curl -sS --max-time 20 -H "X-Forwarded-Email: $auth_email" "$@"; }

# json_get <dotted.path> reads a response body on stdin and prints the value.
json_get() {
  python3 -c '
import json, sys
data = json.load(sys.stdin)
for part in [p for p in sys.argv[1].split(".") if p]:
    data = data[int(part)] if isinstance(data, list) else data.get(part)
print("true" if data is True else "false" if data is False else "" if data is None else data)
' "$1"
}

# entry_status <base-url> prints the test entry status, or "absent".
entry_status() {
  req "$1/api/entries" | python3 -c '
import json, sys
doc = json.load(sys.stdin)["doc"]
ident = sys.argv[1]
print(next((e.get("status", "") for e in doc["entries"] if e["id"] == ident), "absent"))
' "$entry_id"
}

# s3_hash [section-to-drop] prints the sha256 of settings.json as the bucket
# holds it, optionally with one top-level section removed. Python's standard
# library only: no extra package, and no dependency on either app.
s3_hash() {
  S3_ENDPOINT_URL="$endpoint" S3_BUCKET="$bucket" S3_PREFIX="$prefix" AWS_REGION="$region" \
    AWS_ACCESS_KEY_ID="$access" AWS_SECRET_ACCESS_KEY="$secret" \
    python3 -c '
import datetime, hashlib, hmac, json, os, sys, urllib.parse, urllib.request

dropped = sys.argv[1] if len(sys.argv) > 1 else ""
region = os.environ["AWS_REGION"]
endpoint = os.environ.get("S3_ENDPOINT_URL") or "https://s3.%s.amazonaws.com" % region
key = "/".join(p for p in (os.environ.get("S3_PREFIX", ""), "settings.json") if p)
bucket = os.environ["S3_BUCKET"]
url = "%s/%s/%s" % (endpoint.rstrip("/"), urllib.parse.quote(bucket), urllib.parse.quote(key, safe="/"))
u = urllib.parse.urlparse(url)
now = datetime.datetime.now(datetime.timezone.utc)
amzdate = now.strftime("%Y%m%dT%H%M%SZ")
datestamp = now.strftime("%Y%m%d")
payload = hashlib.sha256(b"").hexdigest()
canonical_headers = "host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n" % (u.netloc, payload, amzdate)
signed = "host;x-amz-content-sha256;x-amz-date"
canonical = "\n".join(["GET", u.path, "", canonical_headers, signed, payload])
scope = "%s/%s/s3/aws4_request" % (datestamp, region)
tosign = "\n".join(["AWS4-HMAC-SHA256", amzdate, scope, hashlib.sha256(canonical.encode()).hexdigest()])
signing = ("AWS4" + os.environ["AWS_SECRET_ACCESS_KEY"]).encode()
for part in (datestamp, region, "s3", "aws4_request"):
    signing = hmac.new(signing, part.encode(), hashlib.sha256).digest()
signature = hmac.new(signing, tosign.encode(), hashlib.sha256).hexdigest()
auth = "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s" % (
    os.environ["AWS_ACCESS_KEY_ID"], scope, signed, signature)
request = urllib.request.Request(
    url, headers={"x-amz-content-sha256": payload, "x-amz-date": amzdate, "Authorization": auth})
with urllib.request.urlopen(request, timeout=20) as response:
    body = response.read()
if dropped:
    doc = json.loads(body.decode())
    doc.pop(dropped, None)
    body = json.dumps(doc, sort_keys=True).encode()
print(hashlib.sha256(body).hexdigest())
' "${1:-}"
}

entry_id=""
sse_pid=""
restore_checkin=""

# stop_sse ends the stream and reaps curl, so its own timeout message never lands.
stop_sse() {
  if [ -n "$sse_pid" ]; then
    kill "$sse_pid" 2>/dev/null || true
    wait "$sse_pid" 2>/dev/null || true
    sse_pid=""
  fi
}

cleanup() {
  stop_sse
  if [ -n "$entry_id" ]; then req -X DELETE -o /dev/null "$ts_url/api/entries/$entry_id" 2>/dev/null || true; fi
  if [ "$settings_write" = 1 ] && [ -n "$restore_checkin" ]; then
    req -X PUT -H "Content-Type: application/json" --data "$restore_checkin" "$ts_url/api/settings/checkin" >/dev/null || true
  fi
}
trap cleanup EXIT

# ---- the guard: one bucket, and it is the one this script reads ----
for app in "$ts_url" "$go_url"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$app/readyz")
  if [ "$code" != "200" ]; then
    echo "$app/readyz answered $code" >&2
    exit 1
  fi
done
ts_storage=$(req "$ts_url/api/admin/storage")
go_storage=$(req "$go_url/api/admin/storage")
ts_bucket=$(json_get bucket <<<"$ts_storage")
ts_prefix=$(json_get prefix <<<"$ts_storage")
if [ "$ts_bucket" != "$(json_get bucket <<<"$go_storage")" ] || [ "$ts_prefix" != "$(json_get prefix <<<"$go_storage")" ]; then
  echo "the two apps are not on one bucket: TS $ts_bucket/$ts_prefix, Go $go_storage" >&2
  exit 1
fi
if [ "$ts_bucket" != "$bucket" ] || [ "$ts_prefix" != "$prefix" ]; then
  echo "the apps use $ts_bucket/$ts_prefix, S3_BUCKET/S3_PREFIX say $bucket/$prefix: set them to match" >&2
  exit 1
fi
echo "both apps on $ts_bucket/${ts_prefix:-(no prefix)}; settings.json read from ${endpoint:-(AWS)}"

# The hash path first, so a wrong endpoint or key fails here and not at step 5.
probe=$(s3_hash 2>/dev/null)
if [ -z "$probe" ]; then
  echo "cannot read $prefix/settings.json from $bucket: check S3_ENDPOINT_URL, S3_BUCKET, S3_PREFIX, AWS_REGION and the AWS keys in the environment" >&2
  exit 1
fi
echo "settings.json sha256 $probe (read straight from the bucket)"

title="v3 side-by-side check $(date -u +%Y%m%dT%H%M%SZ)"
created=$(req -X POST -H "Content-Type: application/json" \
  --data "{\"title\":\"$title\",\"kind\":\"task\"}" "$ts_url/api/entries")
entry_id=$(json_get entry.id <<<"$created")
if [ -z "$entry_id" ]; then
  echo "the TS app did not create the test entry: $created" >&2
  exit 1
fi
echo "test entry: $title ($entry_id)"

# ---- 1. TS creates, Go sees it ----
seen=no
for _ in $(seq 1 12); do
  if grep -q "$entry_id" <<<"$(req "$go_url/api/entries")"; then seen=yes; break; fi
  sleep 0.5
done
if [ "$seen" = yes ]; then
  pass "1. an entry created in TS is in Go's GET /api/entries within 6 s"
else
  fail "1. an entry created in TS is in Go's GET /api/entries within 6 s" "still absent after 6 s"
fi

# ---- 2. Go patches, TS sees it ----
patched=$(req -X PATCH -H "Content-Type: application/json" --data '{"status":"doing"}' "$go_url/api/entries/$entry_id")
change_id=$(json_get change.id <<<"$patched")
go_status=$(json_get entry.status <<<"$patched")
if [ "$go_status" = doing ]; then
  pass "2a. Go patched the entry to doing (change $change_id)"
else
  fail "2a. Go patched the entry to doing" "$patched"
fi
ts_sees=no
for _ in $(seq 1 14); do
  if [ "$(entry_status "$ts_url")" = doing ]; then ts_sees=yes; break; fi
  sleep 0.5
done
if [ "$ts_sees" = yes ]; then
  pass "2b. TS reports the status Go wrote, from its own poll of the bucket"
else
  fail "2b. TS reports the status Go wrote" "TS still says $(entry_status "$ts_url")"
fi

# ---- 3. TS undoes, Go deletes ----
undone=$(req -X POST "$ts_url/api/changes/$change_id/undo")
undone_status=$(json_get entry.status <<<"$undone")
if [ "$undone_status" = todo ]; then
  pass "3a. TS undid Go's change; the status is back to todo"
else
  fail "3a. TS undid Go's change" "$undone"
fi
req -X DELETE -o /dev/null "$go_url/api/entries/$entry_id"
gone_ts=no
for _ in $(seq 1 14); do
  if [ "$(entry_status "$ts_url")" = absent ]; then gone_ts=yes; break; fi
  sleep 0.5
done
if [ "$gone_ts" = yes ]; then
  pass "3b. an entry deleted in Go is gone from TS's list"
else
  fail "3b. an entry deleted in Go is gone from TS's list" "TS still says $(entry_status "$ts_url")"
fi
entry_id=""

# ---- 4. TS's SSE stream hears a Go write ----
sse=$(mktemp)
curl -sN --max-time 25 -H "X-Forwarded-Email: $auth_email" "$ts_url/api/events" >"$sse" 2>/dev/null &
sse_pid=$!
for _ in $(seq 1 60); do
  if grep -q '^event: entries' "$sse" 2>/dev/null; then break; fi
  sleep 0.2
done
recreated=$(req -X POST -H "Content-Type: application/json" \
  --data "{\"title\":\"$title\",\"kind\":\"task\"}" "$go_url/api/entries")
entry_id=$(json_get entry.id <<<"$recreated")
events=0
for _ in $(seq 1 24); do
  events=$(grep -c '^event: entries' "$sse" 2>/dev/null || true)
  if [ "${events:-0}" -ge 2 ]; then break; fi
  sleep 0.5
done
stop_sse
rm -f "$sse"
if [ "${events:-0}" -ge 2 ]; then
  pass "4. a Go write reaches TS's SSE stream: $events entries events (handshake + the write)"
else
  fail "4. a Go write reaches TS's SSE stream" "only ${events:-0} entries event(s)"
fi
if [ -n "$entry_id" ]; then
  pass "4b. Go created the named test entry again ($entry_id); it is deleted at the end"
else
  fail "4b. Go created the named test entry again" "$recreated"
fi

# ---- 5. Opening the TS LLM tab leaves settings.json alone ----
before=$(s3_hash)
llm_view=$(req "$ts_url/api/settings/llm")
storage_view=$(req "$ts_url/api/admin/storage")
after=$(s3_hash)
echo "     TS LLM view:     $llm_view"
echo "     TS storage view: $storage_view"
if [ -n "$before" ] && [ "$before" = "$after" ]; then
  pass "5. GET /api/settings/llm and the storage view leave settings.json byte-identical (sha256 $before)"
else
  fail "5. GET /api/settings/llm and the storage view leave settings.json alone" "$before -> $after"
fi

# ---- 6. A check-in written in TS is read by Go; the rest is untouched ----
if [ "$settings_write" = 0 ]; then
  echo "SKIP  6. the check-in write is skipped (--no-settings-write)"
else
  telegram=$(req "$ts_url/api/admin/telegram")
  from_env=$(json_get checkin.setting.fromEnv <<<"$telegram")
  old_schedule=$(json_get checkin.setting.schedule <<<"$telegram")
  old_chat=$(json_get checkin.setting.chat <<<"$telegram")
  if [ "$from_env" = true ]; then
    restore_checkin='{"useEnv":true}'
  else
    restore_checkin=$(python3 -c 'import json, sys; print(json.dumps({"schedule": sys.argv[1], "chat": sys.argv[2]}))' "$old_schedule" "$old_chat")
  fi
  full_before=$(s3_hash)
  other_before=$(s3_hash checkin)
  req -X PUT -H "Content-Type: application/json" --data '{"schedule":"07:45","chat":""}' \
    "$ts_url/api/settings/checkin" >/dev/null
  # Go's settings service keeps settings.json for up to 30 s, so give it that.
  seen=no
  for _ in $(seq 1 80); do
    if [ "$(req "$go_url/api/admin/telegram" | json_get checkin.setting.schedule)" = "07:45" ]; then seen=yes; break; fi
    sleep 0.5
  done
  if [ "$seen" = yes ]; then
    pass "6a. Go's Telegram view reads the check-in TS wrote (07:45)"
  else
    fail "6a. Go's Telegram view reads the check-in TS wrote" "Go still says $(req "$go_url/api/admin/telegram" | json_get checkin.setting.schedule)"
  fi
  full_after=$(s3_hash)
  other_after=$(s3_hash checkin)
  if [ "$other_before" = "$other_after" ] && [ "$full_before" != "$full_after" ]; then
    pass "6b. settings.json changed in the checkin section only (others $other_before; whole file $full_before -> $full_after)"
  else
    fail "6b. settings.json changed in the checkin section only" "others $other_before -> $other_after, file $full_before -> $full_after"
  fi
  pass "6c. the check-in is restored to what it was before the run"
fi

echo "PASS $PASS, FAIL $FAILED"
[ "$FAILED" = 0 ] || exit 1
