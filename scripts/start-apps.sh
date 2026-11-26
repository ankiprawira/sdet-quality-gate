#!/usr/bin/env bash
# Start the Go API (:8080) and Next.js checkout (:3000) and wait until both answer.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
app="$root/application_code"
cd "$app"

go run main.go > /tmp/api.log 2>&1 &
echo $! > /tmp/api.pid

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi
# Production server. `next dev` on the runner never finishes hydrating:
# the browser's HMR websocket fails and React never attaches to the inputs.
npm run build
npm run start > /tmp/web.log 2>&1 &
echo $! > /tmp/web.pid

wait_for() {
  local url="$1"
  local i
  for i in $(seq 1 90); do
    if curl -sf "$url" >/dev/null; then
      echo "ready: $url"
      return 0
    fi
    sleep 2
  done
  echo "timed out waiting for $url" >&2
  return 1
}

if ! wait_for "http://127.0.0.1:8080/api/health"; then
  echo "----- api log -----" >&2
  cat /tmp/api.log >&2 || true
  exit 1
fi

if ! wait_for "http://127.0.0.1:3000"; then
  echo "----- web log -----" >&2
  cat /tmp/web.log >&2 || true
  exit 1
fi
