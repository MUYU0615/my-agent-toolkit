from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SENSITIVE_KEY = re.compile(r"authorization|token|secret|password", re.IGNORECASE)


class RequestLogger:
    def __init__(self, jira_key: str) -> None:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        self.root = Path(__file__).resolve().parents[1] / "log" / timestamp
        self.root.mkdir(parents=True, exist_ok=True)
        self._sequence = 0

    def write(self, payload: dict[str, Any]) -> None:
        self._sequence += 1
        destination = self.root / f"{self._sequence:03d}-request-response.json"
        destination.write_text(
            json.dumps(redact(payload), ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: "***REDACTED***" if SENSITIVE_KEY.search(key) else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value
