#!/usr/bin/env bash
# Applies the Atlas control-plane pieces the driver cannot create (they live in the Atlas Admin / App Services APIs,
# not in the database). Needs the Atlas CLI and an Admin API key with Project Owner on the project:
#   export MONGODB_ATLAS_PUBLIC_API_KEY=... MONGODB_ATLAS_PRIVATE_API_KEY=... ATLAS_PROJECT_ID=... ATLAS_CLUSTER=Cluster0
#   infra/atlas/apply.sh            # dry run: prints what it would do
#   infra/atlas/apply.sh --apply    # does it
# Online Archive and Stream Processing are BILLED features. The scheduled trigger runs on App Services' free tier.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: "${ATLAS_PROJECT_ID:?set ATLAS_PROJECT_ID}"
: "${ATLAS_CLUSTER:=Cluster0}"
mode="${1:-}"
run() { if [[ "$mode" == "--apply" ]]; then echo "+ $*"; "$@"; else echo "(dry run) $*"; fi; }
if [[ "$mode" == "--apply" ]] && ! command -v atlas >/dev/null; then
  echo "Atlas CLI not installed: https://www.mongodb.com/docs/atlas/cli/current/install-atlas-cli/"; exit 1
fi

# 1. Online Archive for the measurements time series (M10+ only; billed).
run atlas clusters onlineArchives create --clusterName "$ATLAS_CLUSTER" --projectId "$ATLAS_PROJECT_ID" --file "$here/online-archive.json"

# 2. Stream Processing workspace + cluster connection + processor (billed per processor hour).
conn="$(mktemp)"
printf '{"name":"mongomation","type":"Cluster","clusterName":"%s","dbRoleToExecute":{"role":"readWriteAnyDatabase","type":"BUILT_IN"}}' "$ATLAS_CLUSTER" >"$conn"
run atlas streams instances create mongomation-sp --provider AWS --region VIRGINIA_USA --projectId "$ATLAS_PROJECT_ID"
run atlas streams connections create mongomation --instance mongomation-sp --projectId "$ATLAS_PROJECT_ID" --file "$conn"
run atlas streams processors create --instance mongomation-sp --projectId "$ATLAS_PROJECT_ID" --file "$here/stream-processor.json"

# 3. Scheduled trigger (App Services). Create an App Services app linked to the cluster (data source name
#    "mongodb-atlas"), then add triggers/requeueStaleJobs.js as function "requeueStaleJobs" and triggers/trigger.json
#    as a trigger — in the UI (App Services > Triggers) or with `appservices push` from an exported app directory.
echo "trigger: deploy $here/triggers/requeueStaleJobs.js + $here/triggers/trigger.json (see comment above)"
