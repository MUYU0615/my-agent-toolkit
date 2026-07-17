from __future__ import annotations

from http.cookies import SimpleCookie

import requests


class ConfluenceClient:
    def __init__(self, base_url: str, basic_user: str, basic_pass: str, app_user: str, app_pass: str):
        self.base_url = base_url.rstrip("/")
        self.basic_user = basic_user
        self.basic_pass = basic_pass
        self.app_user = app_user
        self.app_pass = app_pass
        self.session = requests.Session()
        self.session.auth = (basic_user, basic_pass)
        self.session.headers.update({"User-Agent": "confluence-review/1.0"})

    def request(self, url_path: str, method: str = "GET", headers: dict | None = None, params: dict | None = None, data=None, json=None):
        url = url_path if url_path.startswith("http") else f"{self.base_url}/{url_path.lstrip('/')}"
        return self.session.request(method, url, headers=headers or {}, params=params, data=data, json=json, allow_redirects=False)

    def login(self) -> None:
        response = self.request(
            "/dologin.action",
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={"os_username": self.app_user, "os_password": self.app_pass, "login": "Log in", "os_destination": "/index.action"},
        )
        reason = response.headers.get("x-seraph-loginreason")
        if response.status_code not in (302, 303):
            raise RuntimeError(f"Login failed with status {response.status_code}")
        if reason != "OK":
            raise RuntimeError(f"Login rejected: {reason or 'unknown'}")

    def get_json(self, url_path: str, params: dict | None = None) -> dict:
        response = self.request(url_path, params=params)
        if not response.ok:
            raise RuntimeError(f"GET {url_path} failed with status {response.status_code}")
        return response.json()

    def iter_attachments(self, page_id: str) -> list[dict]:
        start, limit, results = 0, 100, []
        while True:
            payload = self.get_json(f"/rest/api/content/{page_id}/child/attachment", {"limit": limit, "start": start})
            batch = payload.get("results") or []
            results.extend(batch)
            size = payload.get("size", len(batch))
            if not batch or size < limit:
                break
            start += len(batch)
        return results

    def fetch_page(self, page_id: str) -> dict:
        return self.get_json(f"/rest/api/content/{page_id}", {"expand": "body.storage,version,ancestors,space"})

    def download(self, url_path: str) -> bytes:
        last_error = None
        for _ in range(3):
            try:
                response = self.request(url_path)
                if not response.ok:
                    raise RuntimeError(f"Download failed with status {response.status_code}")
                return response.content
            except Exception as exc:
                last_error = exc
        raise last_error or RuntimeError(f"Download failed: {url_path}")
