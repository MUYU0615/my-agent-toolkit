from __future__ import annotations

import json
import os
import re
import ssl
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from http.cookiejar import Cookie, CookieJar
from pathlib import Path
from typing import Dict
from urllib.parse import urlencode, urljoin
from urllib.error import URLError
from urllib.request import (
    HTTPBasicAuthHandler,
    HTTPCookieProcessor,
    HTTPSHandler,
    HTTPPasswordMgrWithDefaultRealm,
    Request,
    build_opener,
)


class LoginError(RuntimeError):
    pass


@dataclass
class JiraProbeConfig:
    base_url: str = "https://j1.private.easemob.com"
    probe_path: str = "/secure/Dashboard.jspa"
    check_issue_url: str = ""
    jira_username: str = ""
    jira_password: str = ""
    redirect_username: str = ""
    redirect_password: str = ""
    cookie_file: Path | None = None
    timeout: int = 20
    insecure_ssl: bool = False

    @property
    def probe_url(self) -> str:
        return urljoin(self.base_url, self.probe_path)

    @property
    def login_url(self) -> str:
        return urljoin(self.base_url, "/login.jsp")

    def __post_init__(self) -> None:
        if self.cookie_file is None:
            self.cookie_file = default_cookie_file()


@dataclass
class LoginForm:
    action_url: str
    hidden_fields: Dict[str, str]


@dataclass
class LoginFetchResult:
    html: str
    final_url: str
    status_code: int
    headers: Dict[str, str]


class LoginFormParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._in_form = False
        self._form_action = ""
        self._hidden_fields: Dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs) -> None:
        attr_map = dict(attrs)
        if tag == "form" and not self._in_form:
            self._in_form = True
            self._form_action = attr_map.get("action", "")
            return
        if tag != "input" or not self._in_form:
            return
        if attr_map.get("type", "").lower() != "hidden":
            return
        name = attr_map.get("name")
        if name:
            self._hidden_fields[name] = attr_map.get("value", "")

    @property
    def form_action(self) -> str:
        return self._form_action

    @property
    def hidden_fields(self) -> Dict[str, str]:
        return dict(self._hidden_fields)


def load_config() -> JiraProbeConfig:
    prefix = "EASEMOB_JIRA_"
    insecure_ssl_value = os.getenv(f"{prefix}INSECURE_SSL", "").strip().lower()
    cookie_file_value = os.getenv(f"{prefix}COOKIE_FILE", "").strip()
    config = JiraProbeConfig(
        base_url=os.getenv(f"{prefix}BASE_URL", "https://j1.private.easemob.com").rstrip("/"),
        probe_path=os.getenv(f"{prefix}PROBE_PATH", "/secure/Dashboard.jspa"),
        check_issue_url=os.getenv(f"{prefix}CHECK_ISSUE_URL", "").strip(),
        jira_username=os.getenv(f"{prefix}USERNAME", ""),
        jira_password=os.getenv(f"{prefix}PASSWORD", ""),
        redirect_username=os.getenv(f"{prefix}REDIRECT_USERNAME", ""),
        redirect_password=os.getenv(f"{prefix}REDIRECT_PASSWORD", ""),
        cookie_file=Path(cookie_file_value).expanduser() if cookie_file_value else None,
        timeout=int(os.getenv(f"{prefix}TIMEOUT", "20")),
        insecure_ssl=insecure_ssl_value in {"1", "true", "yes", "on"},
    )
    if not config.jira_username or not config.jira_password:
        if os.getenv("MY_AGENT_RUNTIME", "").strip().lower() == "wecom":
            raise LoginError(
                "Jira credentials are not bound for the current WeCom user and Bot. "
                "Send /jira bind in Enterprise WeChat; do not export credentials in chat."
            )
        raise LoginError("Missing EASEMOB_JIRA_USERNAME or EASEMOB_JIRA_PASSWORD.")
    return config


def extract_login_form(html: str, response_url: str) -> LoginForm:
    parser = LoginFormParser()
    parser.feed(html)
    if not parser.form_action:
        raise LoginError("No login form action found in response HTML.")
    return LoginForm(
        action_url=urljoin(response_url, parser.form_action),
        hidden_fields=parser.hidden_fields,
    )


def build_login_payload(hidden_fields: Dict[str, str], config: JiraProbeConfig) -> Dict[str, str]:
    payload = dict(hidden_fields)
    payload["os_username"] = config.jira_username
    payload["os_password"] = config.jira_password
    payload["os_cookie"] = "true"
    if config.redirect_username:
        payload["JIRA_REDIRECT_USERNAME"] = config.redirect_username
    if config.redirect_password:
        payload["JIRA_REDIRECT_PASSWORD"] = config.redirect_password
    return payload


def is_login_page(url: str, html: str) -> bool:
    lowered_url = url.lower()
    lowered_html = html.lower()
    markers = ["login.jsp", "log in - jira", "permissionviolation=true", 'name="os_username"']
    return any(marker in lowered_url or marker in lowered_html for marker in markers)


def is_anonymous_response(result: LoginFetchResult) -> bool:
    header_username = result.headers.get("X-AUSERNAME", "").strip().lower()
    if header_username == "anonymous":
        return True
    if header_username:
        return False
    remote_user_match = re.search(
        r'<meta\s+name="ajs-remote-user"\s+content="([^"]*)"',
        result.html,
        re.IGNORECASE,
    )
    if remote_user_match is not None:
        return remote_user_match.group(1).strip() == ""
    return "log in - easemob jira" in result.html.lower()


def extract_title(html: str) -> str:
    match = re.search(r"<title>(.*?)</title>", html, re.IGNORECASE | re.DOTALL)
    if not match:
        return ""
    return re.sub(r"\s+", " ", match.group(1)).strip()


def extract_issue_key_from_url(url: str) -> str:
    match = re.search(r"/browse/([A-Z][A-Z0-9_]+-\d+)", url)
    return match.group(1) if match else ""


def default_cookie_file() -> Path:
    if sys.platform == "darwin":
        cache_root = Path.home() / "Library" / "Caches"
    elif os.name == "nt":
        cache_root = Path(os.getenv("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        cache_root = Path(os.getenv("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    return cache_root / "qa-ai-tool" / "easemob-jira-testcase" / ".jira-cookies.json"


def persist_cookies(cookie_jar: CookieJar, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = []
    for cookie in cookie_jar:
        payload.append(
            {
                "name": cookie.name,
                "value": cookie.value,
                "domain": cookie.domain,
                "path": cookie.path,
            }
        )
    output_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
    try:
        output_path.chmod(0o600)
    except OSError:
        pass


def load_persisted_cookies(cookie_jar: CookieJar, input_path: Path) -> bool:
    if not input_path.is_file():
        return False
    try:
        payload = json.loads(input_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return False
    if not isinstance(payload, list):
        return False
    loaded = False
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        value = item.get("value")
        domain = item.get("domain")
        path = item.get("path") or "/"
        if not all(isinstance(field, str) and field for field in (name, value, domain, path)):
            continue
        cookie_jar.set_cookie(
            Cookie(
                version=0,
                name=name,
                value=value,
                port=None,
                port_specified=False,
                domain=domain,
                domain_specified=True,
                domain_initial_dot=domain.startswith("."),
                path=path,
                path_specified=True,
                secure=False,
                expires=None,
                discard=True,
                comment=None,
                comment_url=None,
                rest={},
                rfc2109=False,
            )
        )
        loaded = True
    return loaded


def fetch(opener, url: str, timeout: int, data: bytes | None = None) -> LoginFetchResult:
    request = Request(url=url, data=data)
    try:
        with opener.open(request, timeout=timeout) as response:
            html = response.read().decode("utf-8", errors="replace")
            final_url = response.geturl()
            status_code = getattr(response, "status", response.getcode())
            headers = dict(response.info().items())
    except URLError as exc:
        reason = getattr(exc, "reason", None)
        if isinstance(reason, ssl.SSLCertVerificationError):
            raise LoginError(
                "TLS certificate verification failed for Easemob Jira. "
                "If this Jira uses an internal or self-signed certificate, set "
                "EASEMOB_JIRA_INSECURE_SSL=1 and retry."
            ) from exc
        raise
    return LoginFetchResult(
        html=html,
        final_url=final_url,
        status_code=status_code,
        headers=headers,
    )


def build_url_opener(config: JiraProbeConfig):
    cookie_jar = CookieJar()
    handlers = [HTTPCookieProcessor(cookie_jar)]
    if config.redirect_username and config.redirect_password:
        password_mgr = HTTPPasswordMgrWithDefaultRealm()
        password_mgr.add_password(
            None,
            config.base_url,
            config.redirect_username,
            config.redirect_password,
        )
        handlers.append(HTTPBasicAuthHandler(password_mgr))
    if config.insecure_ssl:
        ssl_context = ssl._create_unverified_context()
        handlers.append(HTTPSHandler(context=ssl_context))
    opener = build_opener(*handlers)
    return opener, cookie_jar


def probe_login(config: JiraProbeConfig) -> int:
    opener, cookie_jar, verify_result = create_authenticated_session(config)
    persist_cookies(cookie_jar, config.cookie_file)
    saved_cookie_names = ", ".join(cookie.name for cookie in cookie_jar) or "(none)"
    print(f"Verification URL: {verify_result.final_url}")
    print(f"HTTP status: {verify_result.status_code}")
    print(f"Page title: {extract_title(verify_result.html) or '(no title)'}")
    print(f"Current user: {verify_result.headers.get('X-AUSERNAME', '(unknown)')}")
    print(f"Saved cookies: {saved_cookie_names}")
    print(f"Cookie file: {config.cookie_file}")
    if config.check_issue_url:
        issue_result = fetch(opener, config.check_issue_url, config.timeout)
        issue_key = extract_issue_key_from_url(config.check_issue_url)
        issue_visible = (
            not is_login_page(issue_result.final_url, issue_result.html)
            and not is_anonymous_response(issue_result)
            and (issue_key in issue_result.html if issue_key else True)
        )
        print(f"Issue URL: {issue_result.final_url}")
        print(f"Issue status: {issue_result.status_code}")
        print(f"Issue title: {extract_title(issue_result.html) or '(no title)'}")
        print(f"Issue visible: {'yes' if issue_visible else 'no'}")
    return 0


def create_authenticated_session(config: JiraProbeConfig):
    opener, cookie_jar = build_url_opener(config)

    if load_persisted_cookies(cookie_jar, config.cookie_file):
        verify_result = fetch(opener, config.probe_url, config.timeout)
        if not is_login_page(verify_result.final_url, verify_result.html) and not is_anonymous_response(
            verify_result
        ):
            return opener, cookie_jar, verify_result
        cookie_jar.clear()

    login_page = fetch(opener, config.login_url, config.timeout)
    if not is_login_page(login_page.final_url, login_page.html):
        raise LoginError(f"Unexpected login entry page: {login_page.final_url}")

    form = extract_login_form(login_page.html, login_page.final_url)
    payload = build_login_payload(form.hidden_fields, config)
    if "os_destination" not in payload or not payload["os_destination"]:
        payload["os_destination"] = config.probe_path
    encoded_payload = urlencode(payload).encode("utf-8")

    fetch(opener, form.action_url, config.timeout, data=encoded_payload)
    verify_result = fetch(opener, config.probe_url, config.timeout)

    if is_login_page(verify_result.final_url, verify_result.html) or is_anonymous_response(verify_result):
        raise LoginError(
            f"Login verification failed; current user is anonymous at {verify_result.final_url}"
        )
    persist_cookies(cookie_jar, config.cookie_file)
    return opener, cookie_jar, verify_result


def main() -> int:
    try:
        config = load_config()
        return probe_login(config)
    except LoginError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
