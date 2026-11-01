#!/usr/bin/env bash
# vp3-run.sh — keep a static app server (8090) + evil server (9777) alive for
# the duration of one command (the sandbox recycles processes between calls).
set -u
REPO=/home/z/my-project/calendar-web
EVIL=/tmp/vp3/evil
cleanup() { kill "${AP:-}" "${EP:-}" 2>/dev/null; }
trap cleanup EXIT INT TERM
cd "$REPO"
nohup node scripts/static-server.mjs 8090 > /tmp/vp3/static-8090.log 2>&1 & AP=$!
nohup node audit-vp/vp3-evil-server.mjs 9777 > /tmp/vp3/evil-9777.log 2>&1 & EP=$!
for i in $(seq 1 20); do
  A=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/index.html 2>/dev/null || true)
  E=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9777/frame.html 2>/dev/null || true)
  [ "$A" = "200" ] && [ "$E" = "200" ] && break
  sleep 1
done
[ "$A" = "200" ] || { echo "FATAL: app server down"; exit 2; }
cd "$REPO"
"$@"
