#!/usr/bin/env bash
# s5-stack.sh — PRIVATE S5 stack (avoids the shared 8787/8788 pkill wars with
# concurrent agents): wrangler 8799 (persist /tmp/wrangler-s5) + static 8099,
# bootstrap to /tmp/s5-material.json. Never pkills anything.
set -u
REPO=/home/z/my-project/calendar-web
PORT_W=8799
PORT_S=8099
PERSIST=/tmp/wrangler-s5
MAT=/tmp/s5-material.json
FRESH=${S5_FRESH:-1}

cleanup() {
  [ -n "${WP:-}" ] && kill "$WP" 2>/dev/null
  [ -n "${SP:-}" ] && kill "$SP" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

if [ "$FRESH" = "1" ]; then rm -rf "$PERSIST"; fi
cd "$REPO/worker"
nohup ../node_modules/.bin/wrangler dev --port $PORT_W --persist-to $PERSIST > /tmp/wrangler-s5.log 2>&1 &
WP=$!
for i in $(seq 1 90); do
  W=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_W/rows" 2>/dev/null || true)
  if [ "$W" != "000" ]; then break; fi
  sleep 1
done
if [ "$W" = "000" ]; then echo "FATAL: worker $PORT_W never came up"; exit 2; fi

cd "$REPO"
nohup node scripts/static-server.mjs $PORT_S > /tmp/static-s5.log 2>&1 & SP=$!
for i in $(seq 1 30); do
  S=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_S/index.html" 2>/dev/null || true)
  if [ "$S" = "200" ]; then break; fi
  sleep 1
done
if [ "$S" != "200" ]; then echo "FATAL: static $PORT_S never came up"; exit 2; fi

set -a
eval "$(grep -E '^(ADMIN_SECRET|INTERNAL_TOKEN)=' "$REPO/worker/.dev.vars" | sed 's/^/export /')"
set +a
node "$REPO/test/api-suite.mjs" --url "http://127.0.0.1:$PORT_W" --material-out "$MAT" > /tmp/bootstrap-s5.log 2>&1 \
  || { echo "FATAL: bootstrap failed"; tail -12 /tmp/bootstrap-s5.log; exit 2; }
tail -1 /tmp/bootstrap-s5.log

cd "$REPO"
export S5_BASE="http://127.0.0.1:$PORT_S"
export S5_SERVER="http://127.0.0.1:$PORT_W"
export S5_MAT="$MAT"
"$@"
