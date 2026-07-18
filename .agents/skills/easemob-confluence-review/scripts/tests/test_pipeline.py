from __future__ import annotations

import os
import json
import tempfile

from confluence_review import pipeline
from confluence_review.visual import persist_visual_review_package
from confluence_review.pipeline import analyze_urls, dispatch, missing_env_vars_for_action, resolve_output_root
from confluence_review.shared import resolve_confluence_credentials
from confluence_review.shared import parse_confluence_page_url


def test_parse_confluence_page_url_accepts_only_private_page_id():
    result = parse_confluence_page_url("https://c1.private.easemob.com/pages/viewpage.action?pageId=12345")

    assert result["pageId"] == "12345"


def test_parse_confluence_page_url_rejects_other_hosts():
    try:
        parse_confluence_page_url("https://example.com/pages/viewpage.action?pageId=12345")
    except ValueError as exc:
        assert "Only https://c1.private.easemob.com URLs are supported" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_missing_env_vars_for_analyze_url_lists_jira_binding_names():
    missing = missing_env_vars_for_action("analyze-url", {})

    assert missing == {
        "stage": "获取",
        "missing": [
            "EASEMOB_JIRA_USERNAME",
            "EASEMOB_JIRA_PASSWORD",
        ],
    }


def test_missing_env_vars_for_reply_page_lists_jira_binding_names():
    missing = missing_env_vars_for_action("reply-page", {})

    assert missing == {
        "stage": "回复",
        "missing": [
            "EASEMOB_JIRA_USERNAME",
            "EASEMOB_JIRA_PASSWORD",
        ],
    }


def test_jira_binding_is_reused_for_both_confluence_login_stages():
    credentials = resolve_confluence_credentials({
        "EASEMOB_JIRA_USERNAME": "jira-user",
        "EASEMOB_JIRA_PASSWORD": "jira-password",
    })

    assert credentials == {
        "basic_user": "jira-user",
        "basic_pass": "jira-password",
        "app_user": "jira-user",
        "app_pass": "jira-password",
        "source": "jira-bound-user",
    }


def test_resolve_output_root_defaults_to_system_tmp():
    assert resolve_output_root(env={}) == os.path.join(tempfile.gettempdir(), "qa-ai-tool", "easemob-confluence-review")


def test_dispatch_requires_url_before_network():
    payload = dispatch(["analyze-url"], env={})

    assert payload["status"] == "failed"
    assert payload["message"] == "--url is required"


def test_dispatch_reply_page_requires_page_dir_before_network():
    payload = dispatch(["reply-page"], env={})

    assert payload["status"] == "failed"
    assert payload["message"] == "--page-dir is required"


def test_dispatch_reply_page_uses_existing_page_dir_without_reanalysis(tmp_path, monkeypatch):
    page_dir = tmp_path / "review"
    page_dir.mkdir()
    (page_dir / "reply.md").write_text("人工修正草稿", encoding="utf-8")
    (page_dir / "reply-state.json").write_text(
        '{"status":"drafted","page_id":"123","source_url":"https://c1.private.easemob.com/pages/viewpage.action?pageId=123","reply_hash":"old"}',
        encoding="utf-8",
    )
    calls = []

    class FakeClient:
        def __init__(self, *args):
            self.args = args

        def login(self):
            calls.append(("login", self.args))

    def fake_confirm_reply(confirm_page_dir, client):
        calls.append(("confirm", str(confirm_page_dir), isinstance(client, FakeClient)))
        return {"status": "replied", "comment_id": "456"}

    monkeypatch.setattr(pipeline, "ConfluenceClient", FakeClient)
    monkeypatch.setattr(pipeline, "confirm_single_reply", fake_confirm_reply)

    payload = dispatch(
        ["reply-page", "--page-dir", str(page_dir)],
        env={
            "CONFLUENCE_BASIC_USER": "basic-user",
            "CONFLUENCE_BASIC_PASS": "basic-pass",
            "CONFLUENCE_APP_USER": "app-user",
            "CONFLUENCE_APP_PASS": "app-pass",
        },
    )

    assert payload["status"] == "ok"
    assert payload["reply"] == {"page_dir": str(page_dir), "status": "replied", "comment_id": "456"}
    assert calls == [
        ("login", ("https://c1.private.easemob.com", "basic-user", "basic-pass", "app-user", "app-pass")),
        ("confirm", str(page_dir), True),
    ]


def test_analyze_urls_writes_aggregate_context_and_keeps_unread_page_reason(tmp_path, monkeypatch):
    def fake_analyze_url(url, output=None, confirm_reply=False, env=None):
        if url.endswith("pageId=1"):
            return {
                "status": "ok",
                "qa_context": {"file": "/tmp/page-1/qa-context.json", "read_status": "read"},
            }
        return {"status": "failed", "message": "GET page failed with status 403", "blocked_stage": "analyze-url"}

    monkeypatch.setattr(pipeline, "analyze_url", fake_analyze_url)
    first = "https://c1.private.easemob.com/pages/viewpage.action?pageId=1"
    second = "https://c1.private.easemob.com/pages/viewpage.action?pageId=2"

    payload = analyze_urls([first, second, first], output=str(tmp_path), env={})

    assert payload["status"] == "partial"
    assert payload["exit_code"] == 0
    assert payload["summary"] == {"total": 2, "read": 1, "not_read": 1}
    assert payload["pages"][0]["read_status"] == "read"
    assert payload["pages"][1] == {
        "url": second,
        "read_status": "not_read",
        "reason": "GET page failed with status 403",
        "blocked_stage": "analyze-url",
        "missing_env": None,
    }
    saved = json.loads(open(payload["jira_context_file"], encoding="utf-8").read())
    assert saved["summary"] == payload["summary"]


def test_persist_visual_review_package_writes_multimodal_prompt(tmp_path):
    image_path = tmp_path / "assets" / "checkout.png"
    image_path.parent.mkdir()
    image_path.write_bytes(b"png")

    result = persist_visual_review_package(
        tmp_path,
        "购买流程",
        "https://c1.private.easemob.com/pages/viewpage.action?pageId=123",
        [
            {
                "title": "checkout.png",
                "url": "https://c1.private.easemob.com/download/checkout.png",
                "local_path": str(image_path),
            }
        ],
    )

    prompt = (tmp_path / "visual-review.md").read_text(encoding="utf-8")
    assert result["visual_review_file"] == str(tmp_path / "visual-review.md")
    assert result["visual_attachment_count"] == 1
    assert "购买流程" in prompt
    assert "checkout.png" in prompt
    assert "页面模块" in prompt
    assert "可见提示文案" in prompt
