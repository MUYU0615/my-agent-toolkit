#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_COMPOSE="$ROOT_DIR/deploy/compose/docker-compose.yml"
DEV_COMPOSE="$ROOT_DIR/deploy/compose/docker-compose.dev.yml"
DEV_WECOM="${DEV_WECOM:-1}"

compose_args=(-f "$BASE_COMPOSE" -f "$DEV_COMPOSE")
if [[ "$DEV_WECOM" == "1" ]]; then
  compose_args=(--profile wecom "${compose_args[@]}")
fi

if ! curl -fsS "http://127.0.0.1:${KIRO_HOST_RELAY_PORT:-8210}/health" >/dev/null 2>&1; then
  echo "Warning: Kiro host relay is not running." >&2
  echo "Start it in another terminal with: npm run dev:relay" >&2
fi

cd "$ROOT_DIR"
docker compose "${compose_args[@]}" up -d --build "$@"

echo
echo "Development containers are running with source hot reload."
if [[ "$DEV_WECOM" == "1" ]]; then
  echo "Enterprise WeChat worker: enabled"
else
  echo "Enterprise WeChat worker: disabled (set DEV_WECOM=1 to enable it)"
fi
echo "Follow logs with: npm run dev:logs"
