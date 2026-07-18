from __future__ import annotations

from confluence_review.doc_type import classify_document_type


def test_weekly_report_is_skipped_by_title():
    doc_type = classify_document_type("IM Week12 周报", "随便内容")

    assert doc_type["type"] == "skip-weekly-report"
    assert doc_type["selected_template"] == "skip-weekly-report"


def test_pressure_design_requires_title_and_structure():
    body = "目标 成功标准 场景 环境 并发 指标 风险 回滚 负责人 输出物"

    doc_type = classify_document_type("语音服务压测方案", body)

    assert doc_type["type"] == "pressure-design-review"
    assert doc_type["confidence"] == "high"


def test_hld_title_defaults_backend_when_not_clearly_frontend():
    body = "系统边界 服务边界 数据流 接口 数据库 鉴权 部署拓扑 SLO ADR"

    doc_type = classify_document_type("消息系统 HLD", body)

    assert doc_type["type"] == "backend-hld-review"


def test_client_hld_matches_mobile_client_design():
    body = "客户端 Android iOS SDK 端上缓存 离线消息 弱网重试 推送通知 兼容性"

    doc_type = classify_document_type("消息客户端 HLD", body)

    assert doc_type["type"] == "client-hld-review"


def test_prd_structure_without_title_matches_prd():
    body = "背景 目标 用户 场景 范围 需求 验收 依赖 风险 负责人 排期"

    doc_type = classify_document_type("语音转文字", body)

    assert doc_type["type"] == "prd-review"


def test_performance_body_matches_benchmark_review():
    body = "压测结果：QPS 1200，p99 1300ms，CPU 85%"

    doc_type = classify_document_type("消息投递结果", body)

    assert doc_type["type"] == "pressure-benchmark-review"
