from __future__ import annotations

import importlib.util
import json
import os
import shutil
import sys

from .shared import CONFLUENCE_ENV_VARS, JIRA_ENV_VARS, resolve_confluence_credentials


PYTHON_PACKAGES = {
    "requests": "requests",
    "bs4": "beautifulsoup4",
    "pytest": "pytest",
}


def _package_status() -> list[dict]:
    results = []
    for module_name, package_name in PYTHON_PACKAGES.items():
        results.append(
            {
                "name": package_name,
                "module": module_name,
                "available": importlib.util.find_spec(module_name) is not None,
                "install": "scripts/run.sh installs this from scripts/requirements.txt",
            }
        )
    return results


def _env_status() -> dict:
    credentials = resolve_confluence_credentials()
    return {
        "credential_source": credentials["source"] if credentials else None,
        "jira_binding": [{"name": name, "available": bool(os.environ.get(name, "").strip())} for name in JIRA_ENV_VARS],
        "legacy_confluence_env": [{"name": name, "available": bool(os.environ.get(name, "").strip())} for name in CONFLUENCE_ENV_VARS],
    }


def _tool_status() -> list[dict]:
    tesseract = shutil.which("tesseract")
    return [
        {
            "name": "tesseract",
            "available": bool(tesseract),
            "path": tesseract,
            "required": False,
            "purpose": "optional OCR for performance review screenshots",
            "install": "macOS: brew install tesseract",
        }
    ]


def build_doctor_payload() -> dict:
    packages = _package_status()
    env_vars = _env_status()
    tools = _tool_status()
    missing_required = [] if env_vars["credential_source"] else JIRA_ENV_VARS
    missing_packages = [item["name"] for item in packages if not item["available"]]
    return {
        "status": "ok" if not missing_required and not missing_packages else "needs_attention",
        "python": {
            "executable": sys.executable,
            "version": sys.version.split()[0],
        },
        "venv": {
            "active": bool(os.environ.get("VIRTUAL_ENV")),
            "path": os.environ.get("VIRTUAL_ENV"),
        },
        "credential_source": env_vars["credential_source"],
        "system_env": [*env_vars["jira_binding"], *env_vars["legacy_confluence_env"]],
        "python_packages": packages,
        "optional_tools": tools,
        "guidance": [
            "Run ./scripts/run.sh test to create the venv and install Python dependencies.",
            "Managed Bot sessions reuse the current user's Jira binding. For standalone usage, set all four CONFLUENCE_* variables.",
            "Install tesseract only if OCR for screenshot-heavy performance pages is needed.",
        ],
    }


def main() -> int:
    print(json.dumps(build_doctor_payload(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
