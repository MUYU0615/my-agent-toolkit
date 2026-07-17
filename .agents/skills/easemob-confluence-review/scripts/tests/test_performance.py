from __future__ import annotations

from confluence_review.performance import analyze_performance_image_texts, build_unavailable_reason, get_performance_trigger


def test_performance_trigger_matches_body_metrics():
    trigger = get_performance_trigger({"title": "结果", "bodyText": "压测结果 QPS 1000 p99 1200ms", "imageTexts": []})

    assert trigger["matched"] is True
    assert trigger["source"] == "body"


def test_analyze_performance_image_texts_extracts_bottleneck():
    result = analyze_performance_image_texts("压测结果", ["QPS 1200\np99 1300ms\nCPU 90%\nMemory 88%"])

    assert result["status"] == "ok"
    assert result["metrics"]["throughput"] == ["QPS 1200"]
    assert any("性能瓶颈" in item for item in result["bottlenecks"])
    assert any("内存瓶颈" in item for item in result["bottlenecks"])


def test_unavailable_reason_for_no_ocr_text():
    assert "OCR 未提取到稳定文本" in build_unavailable_reason(True, 0, False)
