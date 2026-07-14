#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENV_DIR="${SCRIPT_DIR}/.venv"
REQUIREMENTS_FILE="${SKILL_DIR}/requirements.txt"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required but was not found in PATH." >&2
  exit 1
fi

if [[ ! -d "${VENV_DIR}" ]]; then
  if ! python3 -m venv "${VENV_DIR}"; then
    echo "ERROR: failed to create local virtual environment at ${VENV_DIR}." >&2
    echo "Ensure python3 includes the venv module, then retry." >&2
    exit 1
  fi
fi

VENV_PYTHON="${VENV_DIR}/bin/python"

if [[ ! -x "${VENV_PYTHON}" ]]; then
  echo "ERROR: local virtual environment is incomplete: ${VENV_PYTHON} is missing." >&2
  echo "Remove ${VENV_DIR} and retry." >&2
  exit 1
fi

cd "${SCRIPT_DIR}"

if [[ -f "${REQUIREMENTS_FILE}" ]] && grep -Eq '^[[:space:]]*[^#[:space:]]' "${REQUIREMENTS_FILE}"; then
  "${VENV_PYTHON}" -m pip install -r "${REQUIREMENTS_FILE}" >/dev/null
fi

"${VENV_PYTHON}" jira_issue_network.py "$@"
