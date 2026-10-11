#!/usr/bin/env bash
# Starts the MongoMation live bridge inside WSL on :5190 (reachable from Windows as http://localhost:5190).
# Reads Atlas credentials from the repo's .env without printing them.
set -euo pipefail
REPO="${MONGOMATION_REPO:-/home/zubair/mongomation}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
exec node --env-file="$REPO/.env" "$HERE/server.mjs"
