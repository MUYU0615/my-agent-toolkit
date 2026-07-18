from __future__ import annotations

from confluence_review.checklist import build_review_checklist, extract_checklist_insights


def test_prd_checklist_reports_missing_items():
    doc_type = {"type": "prd-review", "selected_template": "prd-review"}

    checklist = build_review_checklist("PRD", "背景 目标 用户 场景 需求", doc_type)
    insights = extract_checklist_insights(checklist)

    assert checklist["doc_type"] == "prd-review"
    assert checklist["coverage_summary"]["engineering"]["missing"] > 0
    assert "缺少范围、边界或不做项说明。" in insights["engineeringIssues"]


def test_skip_weekly_report_has_no_checklist():
    checklist = build_review_checklist("周报", "背景", {"type": "skip-weekly-report"})

    assert checklist is None


def test_frontend_hld_checklist_requires_api_contract_and_retry_strategy():
    doc_type = {"type": "frontend-hld-review", "selected_template": "frontend-hld-review"}

    checklist = build_review_checklist("Web HLD", "页面 路由 组件 状态管理 交互 点击", doc_type)
    insights = extract_checklist_insights(checklist)

    assert "缺少对外 API、接口参数或字段契约说明。" in insights["engineeringIssues"]
    assert "缺少 API 调用失败、超时、重试或幂等策略说明。" in insights["qaIssues"]


def test_client_hld_checklist_reports_client_specific_gaps():
    doc_type = {"type": "client-hld-review", "selected_template": "client-hld-review"}

    checklist = build_review_checklist("客户端 HLD", "Android iOS SDK 离线消息 推送通知", doc_type)
    insights = extract_checklist_insights(checklist)

    assert checklist["doc_type"] == "client-hld-review"
    assert "缺少端上 API、SDK 接口、参数或回调契约说明。" in insights["engineeringIssues"]
    assert "缺少弱网、离线、重试、恢复或冲突处理的可测说明。" in insights["qaIssues"]
