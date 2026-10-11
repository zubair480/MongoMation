#!/usr/bin/env bash
# Local dev with ALL Modelence features on: auth, Stores, cron jobs and rate limits need Modelence's own
# database. Uses the dashboard Atlas URI from the repo .env and points Modelence's own database at a
# separate database on the same cluster (mongomation_web_auth). Never prints the URI.
#   PORT=3100 apps/web/scripts/dev-local.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${ENV_FILE:-../../.env}"
web_uri="$(grep -E '^MONGODB_URI_WEB=' "$ENV_FILE" | head -1 | cut -d= -f2- | sed -E 's/^"|"$//g')"
[ -n "$web_uri" ] || { echo "MONGODB_URI_WEB missing in $ENV_FILE" >&2; exit 1; }
export MONGODB_URI_WEB="$web_uri"
if [ -z "${MONGODB_URI:-}" ]; then
  # mongodb+srv://user:pass@host/<db>?opts  ->  mongodb+srv://user:pass@host/mongomation_web_auth?opts
  MONGODB_URI="$(printf '%s' "$web_uri" | sed -E "s#^(mongodb(\+srv)?://[^/?]+)(/[^?]*)?#\1/${MODELENCE_DB:-mongomation_web_auth}#")"
  export MONGODB_URI
fi
export MODELENCE_TRACKING_ENABLED=false
export PORT="${PORT:-3100}"
export MODELENCE_PORT="$PORT"
exec npx modelence dev
