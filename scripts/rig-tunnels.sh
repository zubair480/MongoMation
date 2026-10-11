#!/usr/bin/env bash
# Open/close the AWS SSM port-forward tunnels to the AUTOMINUS rig, from INSIDE WSL
# (WSL is NAT mode: tunnels opened on Windows are not reachable from WSL).
#
# Usage:
#   bash scripts/rig-tunnels.sh start [--modbus]   # background tunnels: 8443 (OpenPLC REST), 7410 (Factory I/O)
#                                                  #   --modbus also opens localhost:5020 -> OpenPLC Modbus :502
#   bash scripts/rig-tunnels.sh status             # pids + port check
#   bash scripts/rig-tunnels.sh stop               # kill all tunnels started by this script
#   bash scripts/rig-tunnels.sh logs               # tail the tunnel logs
#
# Env: RIG_INSTANCE (required, EC2 instance id), RIG_FIO_HOST (required, Factory I/O private IP) - from the
#      private ENDPOINTS.md handoff; read from env, else from ./.env. RIG_REGION (default us-west-2), AWS_PROFILE.
# Logs: /tmp/rig-tunnel-<port>.log   PIDs: /tmp/rig-tunnel-<port>.pid
# Requires: aws cli v2 + session-manager-plugin on PATH, and a valid AWS login (aws sts get-caller-identity).
set -u

export PATH="$HOME/.local/bin:$PATH"
# No rig identifiers in the repo: take RIG_INSTANCE / RIG_FIO_HOST / RIG_REGION from the environment,
# falling back to those keys (only) in the gitignored ./.env (or $RIG_ENV_FILE).
_envfile="${RIG_ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env}"
_from_env() { [ -f "$_envfile" ] && grep -E "^$1=" "$_envfile" | tail -1 | cut -d= -f2- | tr -d '\r"'"'" ; }
REGION="${RIG_REGION:-$(_from_env RIG_REGION)}"; REGION="${REGION:-us-west-2}"
INSTANCE="${RIG_INSTANCE:-$(_from_env RIG_INSTANCE)}"
FIO_HOST="${RIG_FIO_HOST:-$(_from_env RIG_FIO_HOST)}"
TMP="/tmp"
need_ids() {
  [ -n "$INSTANCE" ] && [ -n "$FIO_HOST" ] && return 0
  echo "Set RIG_INSTANCE (EC2 instance id) and RIG_FIO_HOST (Factory I/O private IP) - values are in the private"
  echo "ENDPOINTS.md handoff (section 2). Export them, or add RIG_INSTANCE=/RIG_FIO_HOST= lines to the gitignored .env."
  exit 3
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pid_alive() {
  local f="$TMP/rig-tunnel-$1.pid"
  [ -f "$f" ] && kill -0 "$(cat "$f")" 2>/dev/null
}

start_one() { # <localPort> <document> <parameters>
  local lport="$1" doc="$2" params="$3"
  local log="$TMP/rig-tunnel-$lport.log" pidf="$TMP/rig-tunnel-$lport.pid"
  if pid_alive "$lport"; then echo "[$lport] already running (pid $(cat "$pidf"))"; return 0; fi
  if port_open "$lport"; then echo "[$lport] port already in use by another process - skipping"; return 1; fi
  setsid nohup aws ssm start-session --region "$REGION" --target "$INSTANCE" \
    --document-name "$doc" --parameters "$params" >"$log" 2>&1 < /dev/null &
  echo $! >"$pidf"
  echo "[$lport] starting (pid $!, log $log)"
}

wait_ready() { # <localPort>
  local lport="$1" i
  for i in $(seq 1 30); do
    if grep -q "Waiting for connections" "$TMP/rig-tunnel-$lport.log" 2>/dev/null; then echo "[$lport] ready"; return 0; fi
    if ! pid_alive "$lport"; then echo "[$lport] FAILED - see $TMP/rig-tunnel-$lport.log:"; tail -5 "$TMP/rig-tunnel-$lport.log"; return 1; fi
    sleep 1
  done
  echo "[$lport] not ready after 30s - see $TMP/rig-tunnel-$lport.log"; return 1
}

cmd_start() {
  need_ids
  command -v aws >/dev/null || { echo "aws cli not found (expected ~/.local/bin/aws)"; exit 1; }
  command -v session-manager-plugin >/dev/null || { echo "session-manager-plugin not found"; exit 1; }
  if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
    echo "AWS not logged in (aws sts get-caller-identity failed). Log in first, e.g.: aws login --remote   (or: aws sso login --profile <p>)"
    exit 2
  fi
  local rc=0 ports="8443 7410"
  start_one 8443 AWS-StartPortForwardingSession "portNumber=8443,localPortNumber=8443" || rc=1
  start_one 7410 AWS-StartPortForwardingSessionToRemoteHost "host=$FIO_HOST,portNumber=7410,localPortNumber=7410" || rc=1
  if [ "${1:-}" = "--modbus" ]; then
    start_one 5020 AWS-StartPortForwardingSession "portNumber=502,localPortNumber=5020" || rc=1
    ports="$ports 5020"
  fi
  for p in $ports; do pid_alive "$p" && { wait_ready "$p" || rc=1; }; done
  exit $rc
}

cmd_stop() {
  local f p pid
  for f in "$TMP"/rig-tunnel-*.pid; do
    [ -e "$f" ] || continue
    p="${f##*/rig-tunnel-}"; p="${p%.pid}"; pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      echo "[$p] stopped (pid $pid)"
    else
      echo "[$p] not running"
    fi
    rm -f -- "$f"
  done
}

cmd_status() {
  local p
  for p in 8443 7410 5020; do
    local st="down"; pid_alive "$p" && st="pid $(cat "$TMP/rig-tunnel-$p.pid")"
    local po="closed"; port_open "$p" && po="listening"
    echo "[$p] tunnel: $st, port: $po"
  done
}

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) tail -n 20 "$TMP"/rig-tunnel-*.log 2>/dev/null ;;
  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
