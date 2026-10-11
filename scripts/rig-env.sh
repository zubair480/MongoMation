#!/usr/bin/env bash
# Fetch the OpenPLC API password from AWS SSM Parameter Store WITHOUT printing it.
#
# Usage (from ~/mongomation, in WSL):
#   source scripts/rig-env.sh              # exports OPENPLC_PASSWORD (+ rig defaults if unset) into this shell
#   bash scripts/rig-env.sh --write-env    # writes the value into the OPENPLC_PASSWORD= line of ./.env
#                                          #   (adds the line if missing; other lines untouched; value never echoed)
#
# Exports (source mode): OPENPLC_PASSWORD, and if not already set: OPENPLC_URL=https://localhost:8443,
#   OPENPLC_USER=autominus, OPENPLC_INSECURE_TLS=true, FACTORYIO_URL=http://localhost:7410
# Env overrides: AWS_PROFILE (respected by aws cli), RIG_REGION (default us-west-2),
#   OPENPLC_PASSWORD_SSM_PARAM (default /autominus/openplc-api-password), RIG_ENV_FILE (default ./.env)
# Note: npm scripts use `tsx --env-file-if-exists=.env`; real env vars already exported in the shell win over .env.

_rig_env_main() {
  local region="${RIG_REGION:-us-west-2}"
  local param="${OPENPLC_PASSWORD_SSM_PARAM:-/autominus/openplc-api-password}"
  local envfile="${RIG_ENV_FILE:-.env}"
  local mode="${1:-export}"
  PATH="$HOME/.local/bin:$PATH"

  command -v aws >/dev/null || { echo "rig-env: aws cli not found" >&2; return 1; }
  local pw
  if ! pw="$(aws ssm get-parameter --region "$region" --name "$param" --with-decryption \
              --query Parameter.Value --output text 2>/dev/null)" || [ -z "$pw" ] || [ "$pw" = "None" ]; then
    echo "rig-env: could not read $param (not logged in? run: aws sts get-caller-identity)" >&2
    return 1
  fi

  if [ "$mode" = "--write-env" ]; then
    [ -f "$envfile" ] || { echo "rig-env: $envfile not found (run from ~/mongomation or set RIG_ENV_FILE)" >&2; return 1; }
    local tmp; tmp="$(mktemp "${envfile}.XXXXXX")" || return 1
    chmod --reference="$envfile" "$tmp" 2>/dev/null || chmod 600 "$tmp"
    RIG_PW="$pw" awk '
      BEGIN { v = ENVIRON["RIG_PW"]; done = 0 }
      /^OPENPLC_PASSWORD=/ { if (!done) { print "OPENPLC_PASSWORD=" v; done = 1 }; next }
      { print }
      END { if (!done) print "OPENPLC_PASSWORD=" v }
    ' "$envfile" >"$tmp" && mv -f -- "$tmp" "$envfile"
    echo "rig-env: OPENPLC_PASSWORD written to $envfile (${#pw} chars, value not shown)"
  else
    export OPENPLC_PASSWORD="$pw"
    export OPENPLC_URL="${OPENPLC_URL:-https://localhost:8443}"
    export OPENPLC_USER="${OPENPLC_USER:-autominus}"
    export OPENPLC_INSECURE_TLS="${OPENPLC_INSECURE_TLS:-true}"
    export FACTORYIO_URL="${FACTORYIO_URL:-http://localhost:7410}"
    echo "rig-env: exported OPENPLC_PASSWORD (${#pw} chars, value not shown), OPENPLC_URL, OPENPLC_USER, OPENPLC_INSECURE_TLS, FACTORYIO_URL"
  fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # executed, not sourced
  if [ "${1:-}" != "--write-env" ]; then
    echo "rig-env: executing only affects a subshell. Use: source scripts/rig-env.sh   or: bash scripts/rig-env.sh --write-env" >&2
    exit 1
  fi
  _rig_env_main "$@"; exit $?
else
  _rig_env_main "$@"
fi
unset -f _rig_env_main
