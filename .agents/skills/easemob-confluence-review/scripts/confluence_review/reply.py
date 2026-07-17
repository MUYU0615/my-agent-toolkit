from __future__ import annotations

import hashlib
import html
import re
from datetime import datetime, timezone
from pathlib import Path

from .checklist import extract_checklist_insights
from .shared import decode_html_entities, read_json_if_exists, write_json


def _list_lines(items: list[str]) -> list[str]:
    return [f"- {item}" for item in items if item]


def _unique_items(items: list[str]) -> list[str]:
    seen, result = set(), []
    for item in items:
        value = str(item or "").strip()
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def has_meaningful_performance_insights(performance_analysis: dict | None) -> bool:
    if not performance_analysis:
        return False
    metrics = performance_analysis.get("metrics") or {}
    has_metrics = any(isinstance(items, list) and len(items) > 0 for items in metrics.values())
    return bool(has_metrics or performance_analysis.get("bottlenecks") or performance_analysis.get("trend_findings") or performance_analysis.get("findings") or performance_analysis.get("risks") or performance_analysis.get("recommendations"))


def sanitize_reply_summary(summary: str | None, title: str = "", image_links: list[dict] | None = None, suppress_image_placeholders: bool = False) -> str:
    raw = str(summary or "").strip()
    if not raw:
        return f"文档《{title}》当前以截图内容为主，建议结合关键结论查看详细分析。" if title else "当前文档以截图内容为主，建议结合关键结论查看详细分析。"
    image_map = {str(item.get("title", "")).strip(): str(item.get("url", "")).strip() for item in image_links or [] if item.get("title") and item.get("url")}

    def image_repl(match):
        filename = re.search(r'ri:filename="([^"]+)"', match.group(0), re.I)
        if filename and filename.group(1) in image_map:
            title_text = filename.group(1)
            return f" ![{title_text}]({image_map[title_text]}) "
        return " " if suppress_image_placeholders else " [截图] "

    normalized = decode_html_entities(raw)
    normalized = re.sub(r"<ac:image[\s\S]*?</ac:image>", image_repl, normalized, flags=re.I)
    normalized = re.sub(r"<ri:attachment[^>]*/>", "", normalized, flags=re.I)
    normalized = re.sub(r"<br\s*/?>", "\n", normalized, flags=re.I)
    normalized = re.sub(r"</p>", "\n", normalized, flags=re.I)
    normalized = re.sub(r"<p[^>]*>", "", normalized, flags=re.I)
    normalized = re.sub(r"<[^>]+>", " ", normalized)
    if suppress_image_placeholders:
        normalized = re.sub(r"!\[[^\]]*]\([^)]+\)", " ", normalized)
        normalized = normalized.replace("[截图]", "")
    normalized = re.sub(r"\n{3,}", "\n\n", normalized)
    normalized = re.sub(r"[ \t]{2,}", " ", normalized).strip()
    return normalized or (f"文档《{title}》当前以截图内容为主，建议结合关键结论查看详细分析。" if title else "当前文档以截图内容为主，建议结合关键结论查看详细分析。")


def _evidence_message(performance_analysis: dict | None) -> str:
    breakdown = (performance_analysis or {}).get("source_breakdown") or {}
    text_useful = bool(breakdown.get("text_useful", True))
    image_useful = bool(breakdown.get("image_useful", False))
    if text_useful and image_useful:
        return "文字和图片均提供了有效信息，以下分析综合正文和图片结果。"
    if text_useful and not image_useful:
        return "图片无法识别，未得到有效信息，以下分析基于正文文字描述。"
    if not text_useful and image_useful:
        return "文字信息不足，以下分析基于图片分析结果。"
    return "图片无法识别，文字中没有有效内容，无法进行分析。"


def build_reply_draft(title: str, source_url: str, document_summary: dict, performance_analysis: dict | None = None, image_links: list[dict] | None = None, doc_type: dict | None = None, review_checklist: dict | None = None) -> str:
    if (doc_type or {}).get("type") == "skip-weekly-report":
        return ""
    is_performance = (doc_type or {}).get("type") == "pressure-benchmark-review" or bool((performance_analysis or {}).get("trigger", {}).get("matched"))
    has_perf = has_meaningful_performance_insights(performance_analysis)
    lines = ["AI分析：", f"文档《{title}》已完成自动分析。"]
    if (doc_type or {}).get("type") == "pressure-design-review":
        lines.extend(["", "文档定位：", "当前页面更像压测方案/准备文档，本次回复重点检查执行前是否已把目标、环境、指标和验收口径定义完整。"])
    if is_performance:
        lines.extend(["", "分析来源：", _evidence_message(performance_analysis)])
    if document_summary.get("summary"):
        lines.extend(["", "简要总结：", sanitize_reply_summary(document_summary.get("summary"), title, image_links or [], suppress_image_placeholders=is_performance and not has_perf)])
    if document_summary.get("key_conclusions"):
        lines.extend(["", "关键结论：", *_list_lines(document_summary["key_conclusions"])])
    issues = _unique_items([*(document_summary.get("major_issues") or []), *((performance_analysis or {}).get("bottlenecks") or [] if has_perf else []), *((performance_analysis or {}).get("risks") or [] if has_perf else [])])
    if issues:
        lines.extend(["", "主要问题或风险：", *_list_lines(issues)])
    actions = _unique_items([*(document_summary.get("recommended_actions") or []), *((performance_analysis or {}).get("recommendations") or [] if has_perf else [])])
    if actions:
        lines.extend(["", "建议动作：", *_list_lines(actions)])
    insights = extract_checklist_insights(review_checklist)
    if insights["engineeringIssues"]:
        lines.extend(["", "研发视角主要缺口：", *_list_lines(_unique_items(insights["engineeringIssues"])[:4])])
    if insights["qaIssues"]:
        lines.extend(["", "测试视角主要缺口：", *_list_lines(_unique_items(insights["qaIssues"])[:4])])
    if insights["readiness"]:
        readiness = insights["readiness"]
        text = f"当前文档已基本满足进入{readiness['next_stage']}的条件。" if readiness.get("overall") else f"当前文档尚不足以直接进入{readiness['next_stage']}，需要先补齐关键缺口。"
        lines.extend(["", "阶段判断：", f"- {text}"])
    if has_perf and image_links:
        lines.extend(["", "相关截图：", *[f"![{item.get('title') or f'截图{index + 1}'}]({item.get('url')})" for index, item in enumerate(image_links)]])
    lines.extend(["", f"原文链接：{source_url}"])
    return "\n".join(lines).strip() + "\n"


def build_reply_state(page_id: str, source_url: str, reply_content: str, status: str = "drafted", now: str | None = None) -> dict:
    current = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "status": status,
        "page_id": page_id,
        "source_url": source_url,
        "reply_generated_at": current,
        "reply_confirmed_at": None,
        "reply_sent_at": None,
        "reply_hash": hashlib.sha256(reply_content.encode("utf-8")).hexdigest(),
        "last_reply_preview": reply_content[:280],
    }


def persist_reply_artifacts(page_dir: str | Path, reply_content: str, reply_state: dict) -> None:
    path = Path(page_dir)
    path.mkdir(parents=True, exist_ok=True)
    (path / "reply.md").write_text(reply_content, encoding="utf-8")
    write_json(path / "reply-state.json", reply_state)


def reply_markdown_to_storage_html(markdown: str) -> str:
    paragraphs = re.split(r"\r?\n\r?\n", str(markdown or "").strip())
    rendered = []
    for paragraph in paragraphs:
        tokens = []

        def image(match):
            token = f"@@TOKEN_{len(tokens)}@@"
            tokens.append(f'<img src="{html.escape(match.group(2), quote=True)}" alt="{html.escape(match.group(1) or "image", quote=True)}" />')
            return token

        def link(match):
            token = f"@@TOKEN_{len(tokens)}@@"
            tokens.append(f'<a href="{html.escape(match.group(2), quote=True)}">{html.escape(match.group(1))}</a>')
            return token

        tokenized = re.sub(r"!\[([^\]]*)]\(([^)]+)\)", image, paragraph)
        tokenized = re.sub(r"\[([^\]]+)]\(([^)]+)\)", link, tokenized)
        escaped = html.escape(tokenized).replace("\n", "<br />")
        for index, replacement in enumerate(tokens):
            escaped = escaped.replace(f"@@TOKEN_{index}@@", replacement)
        rendered.append(f"<p>{escaped}</p>")
    return "".join(rendered)


def persist_performance_analysis_artifacts(page_dir: str | Path, performance_analysis: dict, document_summary: dict, title: str, source_url: str) -> None:
    path = Path(page_dir)
    path.mkdir(parents=True, exist_ok=True)
    write_json(path / "performance-analysis.json", {"title": title, "source_url": source_url, "document_summary": document_summary, "performance_analysis": performance_analysis})
    lines = [f"# {title} 压测/基准分析", "", f"- Source: {source_url}", f"- Analysis Mode: {performance_analysis.get('analysis_mode', 'unavailable')}", "", "## 文档总结", "", document_summary.get("summary", "信息不足，暂无总结。"), ""]
    (path / "performance-analysis.md").write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def confirm_reply(page_dir: str | Path, client, now: str | None = None) -> dict:
    path = Path(page_dir)
    reply_content = (path / "reply.md").read_text(encoding="utf-8")
    state = read_json_if_exists(path / "reply-state.json", None)
    if not state:
        raise RuntimeError(f"reply-state.json not found: {path / 'reply-state.json'}")
    reply_hash = hashlib.sha256(reply_content.encode("utf-8")).hexdigest()
    if state.get("status") == "replied" and state.get("reply_hash") == reply_hash:
        return {"status": "skipped", "reason": "reply already posted"}
    payload = {
        "type": "comment",
        "container": {"id": state["page_id"], "type": "page"},
        "body": {"storage": {"value": reply_markdown_to_storage_html(reply_content), "representation": "storage"}},
    }
    response = client.request("/rest/api/content", method="POST", headers={"Content-Type": "application/json", "X-Atlassian-Token": "no-check"}, json=payload)
    if not response.ok:
        raise RuntimeError(f"Reply comment failed with status {response.status_code}: {response.text[:400]}")
    data = response.json()
    current = now or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    next_state = {**state, "status": "replied", "reply_confirmed_at": state.get("reply_confirmed_at") or current, "reply_sent_at": current, "comment_id": data.get("id")}
    write_json(path / "reply-state.json", next_state)
    return {"status": "replied", "comment_id": data.get("id")}
