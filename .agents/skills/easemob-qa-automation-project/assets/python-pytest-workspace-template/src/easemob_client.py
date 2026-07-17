from __future__ import annotations

from typing import Any

import requests

from easemob_config import EasemobConfig
from easemob_request_logger import RequestLogger


class EasemobClient:
    def __init__(self, config: EasemobConfig, logger: RequestLogger | None = None) -> None:
        self.config = config
        self.logger = logger
        self.session = requests.Session()

    def request(
        self,
        method: str,
        path: str,
        *,
        token: str,
        headers: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> requests.Response:
        request_headers = {"Authorization": f"Bearer {token}", **(headers or {})}
        response = self.session.request(method, f"{self.config.base_url}{path}", headers=request_headers, timeout=30, **kwargs)
        if self.logger:
            self.logger.write({
                "request": {
                    "method": method,
                    "url": response.request.url,
                    "headers": dict(response.request.headers),
                    "body": response.request.body,
                },
                "response": {
                    "status_code": response.status_code,
                    "headers": dict(response.headers),
                    "body": _response_body(response),
                },
            })
        return response


def _response_body(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return response.text
