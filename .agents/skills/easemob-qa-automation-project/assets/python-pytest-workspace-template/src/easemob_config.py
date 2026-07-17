from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SUPPORTED_ENVIRONMENTS = {"ebs", "tke", "ngi", "qa"}


@dataclass(frozen=True)
class EasemobConfig:
    environment: str
    base_url: str
    appkey: str
    client_id: str
    client_secret: str

    @property
    def org(self) -> str:
        return self.appkey.split("#", 1)[0]

    @property
    def app(self) -> str:
        return self.appkey.split("#", 1)[1]


def load_config() -> EasemobConfig:
    environment = os.environ.get("TEST_ENV", "").strip().lower()
    if environment not in SUPPORTED_ENVIRONMENTS:
        raise RuntimeError("TEST_ENV 必须为 ebs、tke、ngi 或 qa")

    load_dotenv(REPOSITORY_ROOT / "env" / f".env.{environment}", override=False)
    prefix = environment.upper()
    values = {
        "base_url": os.environ.get(f"{prefix}_BASE_URL", "").rstrip("/"),
        "appkey": os.environ.get(f"{prefix}_APPKEY", ""),
        "client_id": os.environ.get(f"{prefix}_CLIENT_ID", ""),
        "client_secret": os.environ.get(f"{prefix}_CLIENT_SECRET", ""),
    }
    missing = [name for name, value in values.items() if not value or "replace-with-" in value]
    if missing:
        raise RuntimeError(f"环境 {environment} 缺少有效配置: {', '.join(missing)}")
    if "#" not in values["appkey"]:
        raise RuntimeError(f"{prefix}_APPKEY 必须使用 org#app 格式")
    return EasemobConfig(environment=environment, **values)
