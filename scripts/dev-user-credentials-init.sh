#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${USER_CREDENTIALS_ENV_FILE:-$ROOT_DIR/deploy/compose/.env.credentials}"

if [[ ! -f "$ENV_FILE" ]]; then
  umask 077
  master_key="$(openssl rand -base64 32 | tr -d '\n')"
  internal_token="$(openssl rand -hex 32)"
  relay_token="$(openssl rand -hex 32)"
  {
    printf 'USER_CREDENTIALS_MASTER_KEY=%s\n' "$master_key"
    printf 'USER_CREDENTIALS_INTERNAL_TOKEN=%s\n' "$internal_token"
    printf 'DATA_SERVICE_INTERNAL_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'KIRO_RELAY_AUTH_TOKEN=%s\n' "$relay_token"
    printf 'MCP_RUNNER_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'JIRA_AUTOMATION_INTERNAL_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'CREDENTIAL_BIND_PUBLIC_URL=http://localhost:8600\n'
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Created local credential runtime config: $ENV_FILE" >&2
fi

if ! grep -Eq '^DATA_SERVICE_INTERNAL_TOKEN=.+$' "$ENV_FILE"; then
  umask 077
  printf 'DATA_SERVICE_INTERNAL_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Added missing data service internal token to local credential runtime config." >&2
fi

if ! grep -Eq '^MCP_RUNNER_SECRET=.+$' "$ENV_FILE"; then
  umask 077
  printf 'MCP_RUNNER_SECRET=%s\n' "$(openssl rand -hex 32)" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Added missing MCP runner secret to local credential runtime config." >&2
fi

if ! grep -Eq '^JIRA_AUTOMATION_INTERNAL_TOKEN=.+$' "$ENV_FILE"; then
  umask 077
  printf 'JIRA_AUTOMATION_INTERNAL_TOKEN=%s\n' "$(openssl rand -hex 32)" >>"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Added a Jira Automation internal service token to local credential runtime config." >&2
fi

printf '%s\n' "$ENV_FILE"
