from __future__ import annotations

import secrets
import string
from typing import Any

from easemob_client import EasemobClient


def make_runtime_username(prefix: str = "qa") -> str:
    suffix = "".join(secrets.choice(string.ascii_lowercase + string.digits) for _ in range(12))
    return f"{prefix}_{suffix}"


def create_contact_account(
    client: EasemobClient,
    *,
    app_token: str,
    username: str,
    password: str,
) -> dict[str, Any]:
    """使用 App Token 注册单个测试用户，并由调用方断言实际响应。"""
    response = client.request(
        "POST",
        f"/{client.config.org}/{client.config.app}/users",
        token=app_token,
        json={"username": username, "password": password},
    )
    response.raise_for_status()
    return response.json()
