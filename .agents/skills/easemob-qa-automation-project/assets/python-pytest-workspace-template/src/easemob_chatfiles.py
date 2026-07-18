from __future__ import annotations

from pathlib import Path
from typing import Any

from easemob_client import EasemobClient


def upload_chatfile(client: EasemobClient, *, user_token: str, fixture: Path) -> tuple[str, dict[str, Any]]:
    """每次测试运行上传当前 fixture，返回本次响应中的 fileId。"""
    with fixture.open("rb") as source:
        response = client.request(
            "POST",
            f"/{client.config.org}/{client.config.app}/chatfiles",
            token=user_token,
            files={"file": (fixture.name, source)},
        )
    response.raise_for_status()
    body = response.json()
    return extract_file_id(body), body


def extract_file_id(body: dict[str, Any]) -> str:
    entities = body.get("entities")
    if isinstance(entities, list) and entities and isinstance(entities[0], dict):
        value = entities[0].get("uuid")
        if isinstance(value, str) and value:
            return value
    value = body.get("fileId")
    if isinstance(value, str) and value:
        return value
    raise ValueError("chatfiles 响应中未找到 entities[0].uuid 或 fileId")
