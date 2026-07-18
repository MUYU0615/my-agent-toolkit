from __future__ import annotations

from confluence_review.reply import build_reply_draft, build_reply_state, reply_markdown_to_storage_html


def test_reply_state_hashes_reply_content():
    state = build_reply_state("123", "https://c1.private.easemob.com/pages/viewpage.action?pageId=123", "hello", now="2026-05-11T00:00:00Z")

    assert state["status"] == "drafted"
    assert state["page_id"] == "123"
    assert state["reply_hash"] == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"


def test_reply_draft_includes_readiness_gaps():
    draft = build_reply_draft(
        "测试 PRD",
        "https://c1.private.easemob.com/pages/viewpage.action?pageId=1",
        {"summary": "1. 文档主题", "key_conclusions": [], "major_issues": ["缺少范围"], "recommended_actions": ["补充范围"]},
        doc_type={"type": "prd-review"},
        review_checklist={
            "engineering_checklist": [{"matched": False, "issue": "缺少范围", "action": "补充范围"}],
            "qa_checklist": [],
            "ready_for_next_stage": {"overall": False, "next_stage": "HLD / 研发 / 测试"},
        },
    )

    assert "AI分析：" in draft
    assert "研发视角主要缺口：" in draft
    assert "当前文档尚不足以直接进入HLD / 研发 / 测试" in draft


def test_reply_markdown_to_storage_html_converts_links_and_images():
    html = reply_markdown_to_storage_html("看 [链接](https://example.com)\n\n![图](https://example.com/a.png)")

    assert '<a href="https://example.com">链接</a>' in html
    assert '<img src="https://example.com/a.png" alt="图" />' in html
