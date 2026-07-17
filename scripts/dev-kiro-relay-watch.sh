#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREDENTIAL_ENV_FILE="$($ROOT_DIR/scripts/dev-user-credentials-init.sh)"
set -a
source "$CREDENTIAL_ENV_FILE"
set +a
unset USER_CREDENTIALS_MASTER_KEY USER_CREDENTIALS_INTERNAL_TOKEN
PORT="${KIRO_HOST_RELAY_PORT:-8210}"
HOST="${KIRO_HOST_RELAY_HOST:-0.0.0.0}"
PID_FILE="${KIRO_HOST_RELAY_PID_FILE:-$ROOT_DIR/runtime/kiro-host-relay.pid}"
COMMAND="${KIRO_COMMAND:-$HOME/.local/bin/kiro-cli}"
WORKSPACE_ROOT="${KIRO_WORKSPACE_ROOT:-$HOME/Documents/KiroBotWorkspaces}"
TIMEOUT_MS="${KIRO_TIMEOUT_MS:-900000}"
RELAY_SCRIPT="$ROOT_DIR/services/llm-runner/scripts/kiro-host-relay.mjs"

if [[ "$COMMAND" == */* && ! -x "$COMMAND" ]]; then
  echo "Kiro command is not executable: $COMMAND" >&2
  echo "Set KIRO_COMMAND to the installed kiro-cli path and retry." >&2
  exit 1
fi

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  managed_pid=""
  if [[ -f "$PID_FILE" ]]; then
    managed_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi

  if [[ -n "$managed_pid" ]] \
    && kill -0 "$managed_pid" >/dev/null 2>&1 \
    && ps -p "$managed_pid" -o command= | grep -q "kiro-host-relay.mjs"; then
    echo "Stopping background Kiro relay (pid $managed_pid) before watch mode..."
    kill "$managed_pid"
    for _ in $(seq 1 20); do
      if ! kill -0 "$managed_pid" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    rm -f "$PID_FILE"
  else
    echo "Port $PORT already has a Kiro relay that was not started by this project." >&2
    echo "Stop it or choose another KIRO_HOST_RELAY_PORT before starting watch mode." >&2
    exit 1
  fi
fi

echo "Kiro relay watch mode: http://$HOST:$PORT"
echo "Kiro command: $COMMAND"
echo "Kiro workspace root: $WORKSPACE_ROOT"
echo "Kiro timeout: ${TIMEOUT_MS}ms"

cd "$ROOT_DIR"
exec env \
  KIRO_HOST_RELAY_PORT="$PORT" \
  KIRO_HOST_RELAY_HOST="$HOST" \
  KIRO_COMMAND="$COMMAND" \
  KIRO_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
  KIRO_TIMEOUT_MS="$TIMEOUT_MS" \
  node --watch "$RELAY_SCRIPT"
