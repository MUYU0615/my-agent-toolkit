from __future__ import annotations

import html
import json
import os
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

CONFLUENCE_BASE_URL = "https://c1.private.easemob.com"
LOCAL_TIME_ZONE = timezone(timedelta(hours=8))
CONFLUENCE_ENV_VARS = [
    "CONFLUENCE_BASIC_USER",
    "CONFLUENCE_BASIC_PASS",
    "CONFLUENCE_APP_USER",
    "CONFLUENCE_APP_PASS",
]
JIRA_ENV_VARS = ["EASEMOB_JIRA_USERNAME", "EASEMOB_JIRA_PASSWORD"]


def default_target_date_text(now: datetime | None = None) -> str:
    current = now.astimezone(LOCAL_TIME_ZONE) if now else datetime.now(LOCAL_TIME_ZONE)
    return (current.date() - timedelta(days=1)).isoformat()


def ensure_dir(path: str | Path) -> None:
    Path(path).mkdir(parents=True, exist_ok=True)


def read_json_if_exists(file_path: str | Path, fallback):
    path = Path(file_path)
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def write_json(file_path: str | Path, payload) -> None:
    path = Path(file_path)
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def missing_env(names: list[str], env: dict[str, str] | None = None) -> list[str]:
    source = os.environ if env is None else env
    return [name for name in names if not str(source.get(name, "")).strip()]


def resolve_confluence_credentials(env: dict[str, str] | None = None) -> dict[str, str] | None:
    """Resolve credentials without copying values into output artifacts.

    Managed Test-Jira Bot sessions receive Jira credentials scoped to the active
    Bot and WeCom user. The internal Jira and Confluence accounts are the same,
    so reuse those two variables for both Confluence authentication stages.
    The four CONFLUENCE_* variables remain supported for standalone use.
    """
    source = os.environ if env is None else env
    if not missing_env(JIRA_ENV_VARS, source):
        username = str(source["EASEMOB_JIRA_USERNAME"]).strip()
        password = str(source["EASEMOB_JIRA_PASSWORD"]).strip()
        return {
            "basic_user": username,
            "basic_pass": password,
            "app_user": username,
            "app_pass": password,
            "source": "jira-bound-user",
        }
    if not missing_env(CONFLUENCE_ENV_VARS, source):
        return {
            "basic_user": str(source["CONFLUENCE_BASIC_USER"]).strip(),
            "basic_pass": str(source["CONFLUENCE_BASIC_PASS"]).strip(),
            "app_user": str(source["CONFLUENCE_APP_USER"]).strip(),
            "app_pass": str(source["CONFLUENCE_APP_PASS"]).strip(),
            "source": "confluence-env",
        }
    return None


def missing_fetch_credentials(env: dict[str, str] | None = None) -> list[str]:
    if resolve_confluence_credentials(env) is not None:
        return []
    return JIRA_ENV_VARS


def sanitize_segment(value: str | None) -> str:
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", str(value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"[. ]+$", "", text)
    return text or "untitled"


def decode_html_entities(value: str | None) -> str:
    return html.unescape(str(value or "").replace("&nbsp;", " "))


def strip_tags(value: str | None) -> str:
    return re.sub(r"\s+", " ", decode_html_entities(re.sub(r"<[^>]+>", "", str(value or "")))).strip()


def is_allowed_confluence_url(url_text: str) -> bool:
    try:
        url = urlparse(url_text)
    except Exception:
        return False
    return f"{url.scheme}://{url.netloc}" == CONFLUENCE_BASE_URL


def parse_confluence_page_url(url_text: str) -> dict[str, str]:
    if not is_allowed_confluence_url(url_text):
        raise ValueError("Only https://c1.private.easemob.com URLs are supported")
    parsed = urlparse(url_text)
    page_id = parse_qs(parsed.query).get("pageId", [""])[0]
    if not re.fullmatch(r"\d+", page_id or ""):
        raise ValueError("URL must contain a numeric pageId query parameter")
    return {"pageId": page_id, "normalizedUrl": url_text}


def summarize_text_blocks(markdown: str, max_lines: int = 3) -> str:
    lines = []
    for raw in str(markdown or "").splitlines():
        line = strip_tags(raw).strip()
        if not line or line.startswith("#"):
            continue
        if any(line.startswith(prefix) for prefix in ["- Page ID:", "- Space:", "- Updated At:", "- Source:"]):
            continue
        lines.append(line)
    compact = re.sub(r"\s+", " ", " ".join(lines[:max_lines])).strip()
    return f"{compact[:157].strip()}..." if len(compact) > 160 else compact
