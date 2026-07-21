#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CREDENTIAL_ENV_FILE="$($ROOT_DIR/scripts/dev-user-credentials-init.sh)"
set -a
source "$CREDENTIAL_ENV_FILE"
set +a
COMPOSE_FILE="$ROOT_DIR/deploy/compose/docker-compose.yml"
BUILD_SHA="${BUILD_SHA:-$(git -C "$ROOT_DIR" rev-parse HEAD)}"
BUILD_TIME="${BUILD_TIME:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}"
BUILD_TIMEOUT_SECONDS="${BUILD_TIMEOUT_SECONDS:-600}"

SERVICES=(
  data-service
  log-service
  llm-runner
  capability-runner
  mcp-service
  bot-api
  control-api
  jira-webhook-ingress
  jira-automation-runner
)

WECOM_SERVICE="wecom-worker"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-compose}"
COMPOSE_ARGS=(-f "$COMPOSE_FILE")
HEALTH_URLS=(
  "data-service|http://localhost:8300/health"
  "log-service|http://localhost:8500/health"
  "llm-runner|http://localhost:8200/health"
  "capability-runner|http://localhost:8700/health"
  "mcp-service|http://localhost:8800/health"
  "bot-host|http://localhost:8400/health"
  "control-api|http://localhost:8600/health"
)

if docker compose --profile wecom "${COMPOSE_ARGS[@]}" config --services | grep -qx "$WECOM_SERVICE"; then
  if docker ps -a --format '{{.Names}}' | grep -qx "${COMPOSE_PROJECT_NAME}-${WECOM_SERVICE}-1"; then
    SERVICES+=("$WECOM_SERVICE")
    HEALTH_URLS+=("wecom-worker|http://localhost:8401/health")
    COMPOSE_ARGS=(--profile wecom "${COMPOSE_ARGS[@]}")
  fi
fi

echo "BUILD_SHA=$BUILD_SHA"
echo "BUILD_TIME=$BUILD_TIME"
echo "BUILD_TIMEOUT_SECONDS=$BUILD_TIMEOUT_SECONDS"
echo "Services: ${SERVICES[*]}"

if [[ "${START_KIRO_RELAY:-1}" == "1" ]]; then
  "$ROOT_DIR/scripts/dev-kiro-relay.sh"
fi

(
  cd "$ROOT_DIR"
  export BUILD_SHA BUILD_TIME
  python3 - "$BUILD_TIMEOUT_SECONDS" "${COMPOSE_ARGS[@]}" -- "${SERVICES[@]}" <<'PY'
import subprocess
import sys

timeout_seconds = int(sys.argv[1])
args = sys.argv[2:]
separator = args.index("--")
compose_args = args[:separator]
services = args[separator + 1:]

try:
    subprocess.run(
        ["docker", "compose", *compose_args, "build", *services],
        check=True,
        timeout=timeout_seconds,
    )
except subprocess.TimeoutExpired:
    print(
        f"docker compose build timed out after {timeout_seconds} seconds",
        file=sys.stderr,
    )
    sys.exit(124)
PY
  docker compose "${COMPOSE_ARGS[@]}" up -d --force-recreate "${SERVICES[@]}"
)

for entry in "${HEALTH_URLS[@]}"; do
  service_name="${entry%%|*}"
  health_url="${entry#*|}"
  echo "Checking $service_name -> $health_url"
  success=0
  for _ in $(seq 1 30); do
    if payload="$(curl -fsS "$health_url" 2>/dev/null)"; then
      git_sha="$(printf '%s' "$payload" | node -e 'let data="";process.stdin.on("data",c=>data+=c);process.stdin.on("end",()=>{const body=JSON.parse(data);process.stdout.write(String(body.git_sha ?? ""));});')"
      if [[ "$git_sha" == "$BUILD_SHA" ]]; then
        success=1
        break
      fi
    fi
    sleep 2
  done
  if [[ "$success" -ne 1 ]]; then
    echo "Version check failed for $service_name"
    echo "Expected git_sha=$BUILD_SHA"
    if [[ -n "${payload:-}" ]]; then
      echo "Last payload: $payload"
    fi
    exit 1
  fi
done

echo "Redeploy complete. All services report git_sha=$BUILD_SHA"

if ! curl -fsS "http://127.0.0.1:${KIRO_HOST_RELAY_PORT:-8210}/health" >/dev/null 2>&1; then
  echo "Warning: Kiro host relay is not reachable on localhost:${KIRO_HOST_RELAY_PORT:-8210}."
  echo "Run ./scripts/dev-kiro-relay.sh before testing real kiro runtime messages."
fi
