#!/usr/bin/env bash
# Start Raindrop Workshop (local trace debugger + eval surface, github.com/raindrop-ai/workshop) on :5899 in the
# background. Install once: curl -fsSL https://raindrop.sh/install | bash -s -- --no-setup   (sha256-verified binary)
# Logs: ~/mongomation-logs/workshop.log. The daemon gets RAINDROP_QUERY_API_KEY (for import_cloud_trace) and
# nothing else from .env. Idempotent: does nothing if :5899 already answers.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${RAINDROP_BIN:-$HOME/.raindrop/bin/raindrop}"
PORT="${RAINDROP_WORKSHOP_PORT:-5899}"
mkdir -p "$HOME/mongomation-logs"
if curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1; then echo "workshop already running on :$PORT"; exit 0; fi
KEY="$(grep -E '^RAINDROP_QUERY_API_KEY=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)"
env -i HOME="$HOME" PATH="$PATH" RAINDROP_WORKSHOP_PORT="$PORT" ${KEY:+RAINDROP_QUERY_API_KEY="$KEY"} \
  setsid nohup "$BIN" workshop serve >> "$HOME/mongomation-logs/workshop.log" 2>&1 < /dev/null &
for _ in $(seq 1 20); do curl -fsS "http://127.0.0.1:$PORT/api/status" >/dev/null 2>&1 && { echo "workshop up: http://localhost:$PORT"; exit 0; }; sleep 0.5; done
echo "workshop failed to start; see ~/mongomation-logs/workshop.log" >&2; exit 1
