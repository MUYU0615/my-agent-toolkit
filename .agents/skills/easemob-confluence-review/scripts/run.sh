#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"
REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements.txt"

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "ERROR: ${PYTHON_BIN} is required but was not found in PATH." >&2
  echo "Install suggestion: brew install python" >&2
  echo "After installing Python, rerun: ./scripts/run.sh doctor" >&2
  exit 1
fi

if [ ! -d "${VENV_DIR}" ]; then
  if ! "${PYTHON_BIN}" -m venv "${VENV_DIR}"; then
    echo "ERROR: failed to create Python venv at ${VENV_DIR}." >&2
    echo "Install suggestion: ensure Python venv support is available, then rerun ./scripts/run.sh doctor" >&2
    exit 1
  fi
fi

# shellcheck disable=SC1091
source "${VENV_DIR}/bin/activate"

if ! python -m pip install --quiet --upgrade pip; then
  echo "ERROR: failed to upgrade pip in ${VENV_DIR}." >&2
  echo "Check local network/package-index access, then rerun ./scripts/run.sh doctor" >&2
  exit 1
fi

if ! python -m pip install --quiet -r "${REQUIREMENTS_FILE}"; then
  echo "ERROR: failed to install Python dependencies from ${REQUIREMENTS_FILE}." >&2
  echo "Check local network/package-index access, then rerun ./scripts/run.sh doctor" >&2
  exit 1
fi

cd "${SCRIPT_DIR}"

if [ "${1:-}" = "doctor" ]; then
  python -m confluence_review.env_check
elif [ "${1:-}" = "test" ]; then
  shift
  python -m pytest "$@" tests
else
  python -m confluence_review.cli "$@"
fi
