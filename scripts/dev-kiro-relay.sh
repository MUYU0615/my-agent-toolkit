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
LOG_FILE="${KIRO_HOST_RELAY_LOG_FILE:-$ROOT_DIR/runtime/kiro-host-relay.log}"
COMMAND="${KIRO_COMMAND:-$HOME/.local/bin/kiro-cli}"
WORKSPACE_ROOT="${KIRO_WORKSPACE_ROOT:-$HOME/Documents/KiroBotWorkspaces}"

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "Kiro host relay is already running at http://127.0.0.1:$PORT"
  exit 0
fi

if [[ -f "$PID_FILE" ]]; then
  old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
    echo "Removing stale relay pid file for pid $old_pid"
  fi
  rm -f "$PID_FILE"
fi

if [[ "$COMMAND" == */* && ! -x "$COMMAND" ]]; then
  echo "Kiro command is not executable: $COMMAND" >&2
  echo "Set KIRO_COMMAND to the installed kiro-cli path and retry." >&2
  exit 1
fi

(
  cd "$ROOT_DIR"
  nohup env \
    KIRO_HOST_RELAY_PORT="$PORT" \
    KIRO_HOST_RELAY_HOST="$HOST" \
    KIRO_COMMAND="$COMMAND" \
    KIRO_WORKSPACE_ROOT="$WORKSPACE_ROOT" \
    node services/llm-runner/scripts/kiro-host-relay.mjs \
    >>"$LOG_FILE" 2>&1 </dev/null &
  relay_pid="$!"
  echo "$relay_pid" >"$PID_FILE"
  disown "$relay_pid" 2>/dev/null || true
)

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "Kiro host relay started at http://$HOST:$PORT"
    echo "pid: $(cat "$PID_FILE")"
    echo "log: $LOG_FILE"
    echo "workspace root: $WORKSPACE_ROOT"
    exit 0
  fi
  sleep 0.5
done

echo "Kiro host relay failed to start. Last log lines:" >&2
tail -n 40 "$LOG_FILE" >&2 || true
exit 1
