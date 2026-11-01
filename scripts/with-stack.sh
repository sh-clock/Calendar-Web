#!/usr/bin/env bash
# with-stack.sh — bring up BOTH local stacks, bootstrap both universes, run
# the given command, then tear down.
#
#   E2E  stack: wrangler 8787 + static 8080, material /tmp/local-material.json
#   A6   stack: wrangler 8788 + static 8081, material /tmp/local-material-2.json
#
# The sandbox recycles processes between tool calls, so each test invocation
# must be self-contained: this wrapper guarantees the stacks live exactly as
# long as the command it wraps.
#
# Usage: bash scripts/with-stack.sh [--fresh] [--no-bootstrap] <command...>
#   --fresh         wipe persisted wrangler state before starting
#   --no-bootstrap  skip the api-suite universe bootstrap (tests that manage
#                   their own universe, e.g. rebootstrap() in stress/_lib)
set -u
REPO=/home/z/my-project/calendar-web
FRESH=0; BOOT=1
while :; do
  case "${1:-}" in
    --fresh) FRESH=1; shift ;;
    --no-bootstrap) BOOT=0; shift ;;
    *) break ;;
  esac
done

cleanup() {
  [ -n "${WP1:-}" ] && kill "$WP1" 2>/dev/null
  [ -n "${WP2:-}" ] && kill "$WP2" 2>/dev/null
  [ -n "${SP1:-}" ] && kill "$SP1" 2>/dev/null
  [ -n "${SP2:-}" ] && kill "$SP2" 2>/dev/null
  pkill -f 'workerd' 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

if [ "$FRESH" = "1" ]; then rm -rf /tmp/wrangler-e2e /tmp/wrangler-A6; fi

# --- stack 1 (E2E): wrangler 8787 ---
cd "$REPO/worker"
pkill -f workerd 2>/dev/null; pkill -f 'wrangler dev' 2>/dev/null; sleep 2
nohup ../node_modules/.bin/wrangler dev --port 8787 --persist-to /tmp/wrangler-e2e > /tmp/wrangler-8787.log 2>&1 &
WP1=$!
# wait for 8787 before starting 8788 (two concurrent wrangler dev instances
# race for workerd's "direct:1:default" control socket — stagger them)
for i in $(seq 1 60); do
  W=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/rows 2>/dev/null || true)
  if [ "$W" != "000" ]; then break; fi
  sleep 1
done
# --- stack 2 (A6 stress): wrangler 8788 ---
nohup ../node_modules/.bin/wrangler dev --port 8788 --persist-to /tmp/wrangler-A6 > /tmp/wrangler-8788.log 2>&1 &
WP2=$!

# --- static servers ---
cd "$REPO"
nohup node scripts/static-server.mjs 8080 > /tmp/static-8080.log 2>&1 & SP1=$!
nohup node scripts/static-server.mjs 8081 > /tmp/static-8081.log 2>&1 & SP2=$!

# --- wait for readiness (max 90s) ---
for i in $(seq 1 90); do
  W1=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/rows 2>/dev/null || true)
  W2=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8788/rows 2>/dev/null || true)
  S1=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/index.html 2>/dev/null || true)
  S2=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/index.html 2>/dev/null || true)
  if [ "$W1" != "000" ] && [ "$W2" != "000" ] && [ "$S1" = "200" ] && [ "$S2" = "200" ]; then break; fi
  sleep 1
done
for kv in "$W1:8787" "$W2:8788"; do
  if [ "${kv%%:*}" = "000" ]; then echo "FATAL: worker on ${kv#*:} never came up"; exit 2; fi
done
if [ "$S1" != "200" ] || [ "$S2" != "200" ]; then echo "FATAL: static server(s) never came up"; exit 2; fi

# --- bootstrap both universes (destructive; api-suite is the conformance run) ---
if [ "$BOOT" = "1" ]; then
  set -a
  eval "$(grep -E '^(ADMIN_SECRET|INTERNAL_TOKEN)=' "$REPO/worker/.dev.vars" | sed 's/^/export /')"
  set +a
  for pair in "8787:/tmp/local-material.json" "8788:/tmp/local-material-2.json"; do
    PORT="${pair%%:*}"; MAT="${pair#*:}"
    node "$REPO/test/api-suite.mjs" --url "http://127.0.0.1:$PORT" --material-out "$MAT" > /tmp/bootstrap-$PORT.log 2>&1 \
      || { echo "FATAL: api-suite bootstrap failed on $PORT"; tail -12 /tmp/bootstrap-$PORT.log; exit 2; }
    tail -1 /tmp/bootstrap-$PORT.log
  done
fi

# --- run the wrapped command from the repo root ---
cd "$REPO"
"$@"
