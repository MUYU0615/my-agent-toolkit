#!/usr/bin/env sh
set -eu

if [ -z "${TEST_ENV:-}" ]; then
  echo "TEST_ENV is required: ebs, tke, ngi, or qa" >&2
  exit 2
fi

case "$TEST_ENV" in
  ebs|tke|ngi|qa) ;;
  *) echo "unsupported TEST_ENV: $TEST_ENV" >&2; exit 2 ;;
esac

if [ ! -x .venv/bin/python ]; then
  echo "virtual environment is missing; run ./scripts/bootstrap_venv.sh" >&2
  exit 2
fi

exec .venv/bin/python -m pytest "$@"
