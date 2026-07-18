from __future__ import annotations

import json
from pathlib import Path
from typing import Any


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]


class RuntimeState:
    def __init__(self, jira_key: str) -> None:
        self.path = REPOSITORY_ROOT / ".runtime" / jira_key / "state.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def get(self, key: str, default: Any = None) -> Any:
        return self._read().get(key, default)

    def set(self, key: str, value: Any) -> None:
        state = self._read()
        state[key] = value
        self.path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def _read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text(encoding="utf-8"))
