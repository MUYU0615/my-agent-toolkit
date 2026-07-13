#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"
docker compose \
  --profile wecom \
  -f deploy/compose/docker-compose.yml \
  -f deploy/compose/docker-compose.dev.yml \
  ps "$@"

echo
if curl -fsS "http://127.0.0.1:${KIRO_HOST_RELAY_PORT:-8210}/health" >/dev/null 2>&1; then
  echo "Kiro host relay: reachable"
else
  echo "Kiro host relay: not reachable"
fi
