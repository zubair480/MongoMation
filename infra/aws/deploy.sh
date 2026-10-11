#!/usr/bin/env bash
# Deploy the MongoMation AWS stack (cheap resources only; the rig instance is referenced, never modified).
#
#   bash infra/aws/deploy.sh                 # render + validate + deploy stack "mongomation"
#   bash infra/aws/deploy.sh --render-only   # just write infra/aws/mongomation.template.json
#   ALARM_EMAIL=me@example.com HEALTH_PROBE=ENABLED bash infra/aws/deploy.sh
#
# Env: STACK (default mongomation), RIG_REGION/AWS_REGION (default us-west-2), RIG_ID, RIG_INSTANCE, RIG_FIO_INSTANCE,
#      ARTIFACTS_BUCKET (optional fixed name), ALARM_EMAIL, HEALTH_PROBE (ENABLED|DISABLED, default DISABLED),
#      RIG_POWER_SCHEDULE (ENABLED|DISABLED, default DISABLED - the nightly stop/morning start of the rig),
#      CREATE_WORKER_SECRET (true|false, default false). RIG_* fall back to the gitignored ./.env.
# After deploy, put the printed outputs into .env:
#   MM_AWS_ARTIFACTS_BUCKET=<ArtifactsBucket>  MM_AWS_LOG_GROUP=/mongomation/worker  MM_AWS_METRICS=1  MM_AWS_RIG_HEALTH=1
# and attach the WorkerPolicyArn output to the IAM principal the worker runs as.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null

_from_env() { [ -f .env ] && grep -E "^$1=" .env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//' | tr -d '\r"'"'" || true; }
REGION="${AWS_REGION:-${RIG_REGION:-$(_from_env RIG_REGION)}}"; REGION="${REGION:-us-west-2}"
RIG_INSTANCE="${RIG_INSTANCE:-$(_from_env RIG_INSTANCE)}"
RIG_ID="${RIG_ID:-$(_from_env RIG_ID)}"; RIG_ID="${RIG_ID:-rig-1}"
OUT=infra/aws/mongomation.template.json

npx tsx infra/aws/template.ts >"$OUT"
echo "rendered $OUT ($(wc -c <"$OUT") bytes)"
[ "${1:-}" = "--render-only" ] && exit 0

aws sts get-caller-identity --region "$REGION" >/dev/null || { echo "AWS not logged in (aws login / aws sso login)"; exit 2; }
aws cloudformation validate-template --region "$REGION" --template-body "file://$OUT" >/dev/null && echo "template valid"
aws cloudformation deploy --region "$REGION" --stack-name "${STACK:-mongomation}" --template-file "$OUT" \
  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset --tags project=mongomation \
  --parameter-overrides \
    RigId="$RIG_ID" RigInstanceId="$RIG_INSTANCE" FioInstanceId="${RIG_FIO_INSTANCE:-}" \
    ArtifactsBucketName="${ARTIFACTS_BUCKET:-}" AlarmEmail="${ALARM_EMAIL:-}" \
    HealthProbeState="${HEALTH_PROBE:-DISABLED}" RigPowerScheduleState="${RIG_POWER_SCHEDULE:-DISABLED}" \
    CreateWorkerSecret="${CREATE_WORKER_SECRET:-false}"
aws cloudformation describe-stacks --region "$REGION" --stack-name "${STACK:-mongomation}" --query "Stacks[0].Outputs" --output table
