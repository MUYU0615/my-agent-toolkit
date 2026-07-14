#!/usr/bin/env python3
"""Validate an im-test-hub checkout without reading secret configuration values."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


REQUIRED_PATHS = (
    "AGENTS.md",
    "requirements.txt",
    "src/sdk",
    "src/server",
    "tests/e2e",
    "tests/live",
    "e2e_scripts/run_e2e.sh",
    "script/run_github_actions_live_cases.py",
)


def git_value(repo: Path, *args: str) -> str | None:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate an im-test-hub repository and print safe metadata as JSON.",
    )
    parser.add_argument("--repo", default=".", help="Path to the im-test-hub checkout")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve()
    missing = [relative for relative in REQUIRED_PATHS if not (repo / relative).exists()]
    if missing:
        print(
            json.dumps(
                {
                    "ok": False,
                    "repo": str(repo),
                    "error": "not_an_im_test_hub_checkout",
                    "missing": missing,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 2

    project_skills_root = repo / ".agents" / "skills"
    project_skills = sorted(
        path.parent.name
        for path in project_skills_root.glob("*/SKILL.md")
        if path.is_file()
    )
    config_presence = {
        "e2e_yaml": sorted(path.name for path in (repo / "e2e_scripts").glob("*.yaml")),
        "vscode_env_names": sorted(path.name for path in (repo / ".vscode" / "envs").glob("*.env")),
        "vscode_default_env_present": (repo / ".vscode" / ".env").is_file(),
    }

    status = git_value(repo, "status", "--short")
    payload = {
        "ok": True,
        "repo": str(repo),
        "branch": git_value(repo, "branch", "--show-current"),
        "head": git_value(repo, "rev-parse", "--short", "HEAD"),
        "dirty": bool(status),
        "changed_path_count": len(status.splitlines()) if status else 0,
        "python": str(repo / ".venv" / "bin" / "python")
        if (repo / ".venv" / "bin" / "python").is_file()
        else None,
        "project_skills": project_skills,
        "config_presence": config_presence,
        "secret_values_read": False,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
