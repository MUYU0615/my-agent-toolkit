import json
import os
import ssl
import sys
import tempfile
import unittest
from http.cookiejar import Cookie, CookieJar
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import URLError
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jira_login_probe import (
    JiraProbeConfig,
    LoginFetchResult,
    LoginError,
    build_login_payload,
    build_url_opener,
    default_cookie_file,
    extract_login_form,
    is_anonymous_response,
    is_login_page,
    load_config,
    load_persisted_cookies,
    persist_cookies,
    create_authenticated_session,
    fetch,
)


class ExtractLoginFormTests(unittest.TestCase):
    def test_extracts_form_action_and_hidden_inputs(self) -> None:
        html = """
        <html>
          <body>
            <form id="login-form" action="/login.jsp">
              <input type="hidden" name="atl_token" value="abc123" />
              <input type="hidden" name="os_destination" value="/browse/HIM-21204" />
              <input type="text" name="os_username" />
              <input type="password" name="os_password" />
            </form>
          </body>
        </html>
        """

        form = extract_login_form(html, "https://j1.private.easemob.com/login.jsp")

        self.assertEqual(form.action_url, "https://j1.private.easemob.com/login.jsp")
        self.assertEqual(
            form.hidden_fields,
            {"atl_token": "abc123", "os_destination": "/browse/HIM-21204"},
        )

    def test_raises_when_no_form_found(self) -> None:
        with self.assertRaises(LoginError):
            extract_login_form("<html></html>", "https://j1.private.easemob.com/login.jsp")


class BuildLoginPayloadTests(unittest.TestCase):
    def test_merges_hidden_fields_and_credentials(self) -> None:
        config = JiraProbeConfig(
            jira_username="alice",
            jira_password="secret",
            redirect_username="proxy-user",
            redirect_password="proxy-pass",
        )

        payload = build_login_payload(
            {"atl_token": "abc123", "os_destination": "/browse/HIM-21204"},
            config,
        )

        self.assertEqual(payload["atl_token"], "abc123")
        self.assertEqual(payload["os_destination"], "/browse/HIM-21204")
        self.assertEqual(payload["os_username"], "alice")
        self.assertEqual(payload["os_password"], "secret")
        self.assertEqual(payload["os_cookie"], "true")
        self.assertEqual(payload["JIRA_REDIRECT_USERNAME"], "proxy-user")
        self.assertEqual(payload["JIRA_REDIRECT_PASSWORD"], "proxy-pass")


class LoginPageDetectionTests(unittest.TestCase):
    def test_detects_login_markers_in_url_and_html(self) -> None:
        self.assertTrue(
            is_login_page(
                "https://j1.private.easemob.com/login.jsp?permissionViolation=true",
                "<html><title>Log in - Jira</title></html>",
            )
        )
        self.assertFalse(
            is_login_page(
                "https://j1.private.easemob.com/browse/HIM-21204",
                "<html><title>HIM-21204</title></html>",
            )
        )


class AnonymousDetectionTests(unittest.TestCase):
    def test_detects_anonymous_response_from_header(self) -> None:
        response = LoginFetchResult(
            html="<html><title>System Dashboard - Easemob JIRA</title></html>",
            final_url="https://j1.private.easemob.com/secure/Dashboard.jspa",
            status_code=200,
            headers={"X-AUSERNAME": "anonymous"},
        )

        self.assertTrue(is_anonymous_response(response))

    def test_detects_authenticated_response(self) -> None:
        response = LoginFetchResult(
            html='<meta name="ajs-remote-user" content="dujiepeng">',
            final_url="https://j1.private.easemob.com/secure/Dashboard.jspa",
            status_code=200,
            headers={"X-AUSERNAME": "dujiepeng"},
        )

        self.assertFalse(is_anonymous_response(response))


class IssueAccessDetectionTests(unittest.TestCase):
    def test_detects_issue_key_in_page(self) -> None:
        response = LoginFetchResult(
            html="<html><title>HIM-21204 - title</title><body>HIM-21204</body></html>",
            final_url="https://j1.private.easemob.com/browse/HIM-21204",
            status_code=200,
            headers={"X-AUSERNAME": "dujiepeng"},
        )

        self.assertIn("HIM-21204", response.html)


class PersistCookiesTests(unittest.TestCase):
    def test_writes_cookie_jar_as_json(self) -> None:
        jar = CookieJar()
        jar.set_cookie(
            Cookie(
                version=0,
                name="JSESSIONID",
                value="cookie-value",
                port=None,
                port_specified=False,
                domain="j1.private.easemob.com",
                domain_specified=True,
                domain_initial_dot=False,
                path="/",
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

        with tempfile.TemporaryDirectory() as tmpdir:
            output_path = Path(tmpdir) / "cookies.json"
            persist_cookies(jar, output_path)
            content = json.loads(output_path.read_text(encoding="utf-8"))

        self.assertEqual(content[0]["name"], "JSESSIONID")
        self.assertEqual(content[0]["value"], "cookie-value")

    def test_loads_persisted_cookie_jar(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            input_path = Path(tmpdir) / "cookies.json"
            input_path.write_text(json.dumps([{
                "name": "JSESSIONID",
                "value": "cookie-value",
                "domain": "j1.private.easemob.com",
                "path": "/",
            }]), encoding="utf-8")
            jar = CookieJar()
            self.assertTrue(load_persisted_cookies(jar, input_path))
            cookies = list(jar)

        self.assertEqual(len(cookies), 1)
        self.assertEqual(cookies[0].name, "JSESSIONID")
        self.assertEqual(cookies[0].value, "cookie-value")

    def test_authenticated_session_reuses_valid_cookie_without_login(self) -> None:
        authenticated = LoginFetchResult(
            html='<meta name="ajs-remote-user" content="alice">',
            final_url="https://j1.private.easemob.com/secure/Dashboard.jspa",
            status_code=200,
            headers={"X-AUSERNAME": "alice"},
        )
        with tempfile.TemporaryDirectory() as tmpdir:
            cookie_path = Path(tmpdir) / "cookies.json"
            cookie_path.write_text(json.dumps([{
                "name": "JSESSIONID",
                "value": "cookie-value",
                "domain": "j1.private.easemob.com",
                "path": "/",
            }]), encoding="utf-8")
            config = JiraProbeConfig(
                jira_username="alice",
                jira_password="secret",
                cookie_file=cookie_path,
            )
            with patch("jira_login_probe.fetch", return_value=authenticated) as fetch_mock:
                _, jar, result = create_authenticated_session(config)

        self.assertEqual(result, authenticated)
        self.assertEqual(len(list(jar)), 1)
        fetch_mock.assert_called_once_with(
            unittest.mock.ANY,
            config.probe_url,
            config.timeout,
        )


class ConfigTests(unittest.TestCase):
    def test_managed_wecom_runtime_points_missing_credentials_to_bind_command(self) -> None:
        with patch.dict(os.environ, {"MY_AGENT_RUNTIME": "wecom"}, clear=True):
            with self.assertRaisesRegex(LoginError, r"/jira bind"):
                load_config()

    def test_default_cookie_file_uses_user_cache_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {"XDG_CACHE_HOME": tmpdir}, clear=False):
                cookie_file = default_cookie_file()

        expected_root = Path.home() / "Library" / "Caches" if sys.platform == "darwin" else Path(tmpdir)
        self.assertEqual(
            cookie_file,
            expected_root / "qa-ai-tool" / "easemob-jira-testcase" / ".jira-cookies.json",
        )

    def test_load_config_defaults_cookie_file_to_user_cache(self) -> None:
        env = {
            "EASEMOB_JIRA_USERNAME": "alice",
            "EASEMOB_JIRA_PASSWORD": "secret",
        }
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, env | {"XDG_CACHE_HOME": tmpdir}, clear=False):
                config = load_config()

        expected_root = Path.home() / "Library" / "Caches" if sys.platform == "darwin" else Path(tmpdir)
        self.assertEqual(
            config.cookie_file,
            expected_root / "qa-ai-tool" / "easemob-jira-testcase" / ".jira-cookies.json",
        )

    def test_load_config_allows_explicit_cookie_file_override(self) -> None:
        env = {
            "EASEMOB_JIRA_USERNAME": "alice",
            "EASEMOB_JIRA_PASSWORD": "secret",
            "EASEMOB_JIRA_COOKIE_FILE": "/tmp/easemob-jira-cookies.json",
        }
        with patch.dict(os.environ, env, clear=False):
            config = load_config()

        self.assertEqual(config.cookie_file, Path("/tmp/easemob-jira-cookies.json"))

    def test_load_config_enables_insecure_ssl_from_env(self) -> None:
        env = {
            "EASEMOB_JIRA_USERNAME": "alice",
            "EASEMOB_JIRA_PASSWORD": "secret",
            "EASEMOB_JIRA_INSECURE_SSL": "true",
        }
        with patch.dict(os.environ, env, clear=False):
            config = load_config()

        self.assertTrue(config.insecure_ssl)

    def test_load_config_defaults_insecure_ssl_to_false(self) -> None:
        env = {
            "EASEMOB_JIRA_USERNAME": "alice",
            "EASEMOB_JIRA_PASSWORD": "secret",
        }
        with patch.dict(os.environ, env, clear=False):
            config = load_config()

        self.assertFalse(config.insecure_ssl)


class UrlOpenerTests(unittest.TestCase):
    def test_build_url_opener_supports_default_and_insecure_ssl_modes(self) -> None:
        secure_opener, secure_jar = build_url_opener(JiraProbeConfig())
        insecure_opener, insecure_jar = build_url_opener(JiraProbeConfig(insecure_ssl=True))

        self.assertIsInstance(secure_jar, CookieJar)
        self.assertIsInstance(insecure_jar, CookieJar)
        self.assertIsNotNone(secure_opener)
        self.assertIsNotNone(insecure_opener)


class FetchErrorTests(unittest.TestCase):
    def test_fetch_raises_actionable_login_error_for_ssl_verification_failures(self) -> None:
        opener = Mock()
        opener.open.side_effect = URLError(
            ssl.SSLCertVerificationError("certificate verify failed")
        )

        with self.assertRaises(LoginError) as ctx:
            fetch(opener, "https://j1.private.easemob.com/login.jsp", timeout=20)

        self.assertIn("EASEMOB_JIRA_INSECURE_SSL=1", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
