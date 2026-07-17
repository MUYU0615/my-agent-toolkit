from __future__ import annotations

import re

from .checklist import build_review_checklist, extract_checklist_insights
from .doc_type import build_page_summary_markdown, classify_document_type
from .reply import build_reply_draft, has_meaningful_performance_insights
from .shared import parse_confluence_page_url


def _format_numbered_summary(items: list[str]) -> str:
    return "\n".join(f"{index + 1}. {item}" for index, item in enumerate(item for item in items if item))


def build_heuristic_analysis(title: str, markdown: str) -> dict:
    text = re.sub(r"```[\s\S]*?```", "", (markdown or "").strip()).replace("|", " ")
    gaps, suggestions = [], []
    checks = [
        (r"背景|目标|目的", "背景和目标描述不够明确。", "补充文档背景、目标和要解决的问题。"),
        (r"范围|边界|不包含|不支持", "范围和边界描述不足。", "明确包含范围、排除范围和边界条件。"),
        (r"接口|字段|参数|数据结构|异常|错误码|兼容", "接口、数据结构、异常处理或兼容性说明不足。", "补充接口定义、关键字段、异常处理和兼容性策略。"),
        (r"负责人|owner|时间|截止|待办|todo|下一步", "缺少责任人、时间点或后续动作信息。", "补充责任人、时间节点和后续执行动作。"),
    ]
    for pattern, issue, action in checks:
        if not re.search(pattern, text, re.I):
            gaps.append(issue)
            suggestions.append(action)
    return {"title": title, "gaps": gaps or ["信息不足，无法判断完整性。"], "suggestions": suggestions or ["继续补充背景、范围、细节和验收标准，便于后续执行。"]}


def _infer_topic(title: str, doc_type: dict | None) -> str:
    return {
        "pressure-design-review": f"文档主题是《{title}》对应的压测方案与执行准备。",
        "pressure-benchmark-review": f"文档主题是《{title}》对应的压测结果与现象记录。",
        "frontend-hld-review": f"文档主题是《{title}》对应的前端 HLD 设计说明。",
        "client-hld-review": f"文档主题是《{title}》对应的客户端 HLD 设计说明。",
        "backend-hld-review": f"文档主题是《{title}》对应的后端 HLD 设计说明。",
        "prd-review": f"文档主题是《{title}》对应的 PRD/需求评审页。",
    }.get((doc_type or {}).get("type"), f"文档主题是《{title}》对应的方案说明或能力评审。")


def _route_focus(doc_type: dict | None) -> str:
    return {
        "prd-review": "当前评审重点是需求产出物是否足够完整，是否能支撑后续 HLD、研发和测试。",
        "frontend-hld-review": "当前评审重点是 Web 前端架构、交互边界、对外 API 参数契约、失败重试策略，以及测试是否可以直接设计交互与兼容性用例。",
        "client-hld-review": "当前评审重点是客户端架构、端上 API/SDK 参数契约、离线与弱网恢复、推送通知、版本兼容，以及测试是否可以直接设计端上场景用例。",
        "backend-hld-review": "当前评审重点是后端架构、服务边界、数据流与稳定性设计，以及测试是否可以直接设计接口与集成验证。",
        "pressure-design-review": "当前评审重点不是性能瓶颈，而是目标、环境、指标、验收口径和输出物是否齐全。",
    }.get((doc_type or {}).get("type"), "当前更适合从文档完整性角度评审，重点检查目标、范围、细节说明和落地信息是否齐全。")


def _checklist_summary(title: str, doc_type: dict, review_checklist: dict | None) -> dict:
    insights = extract_checklist_insights(review_checklist)
    issues = [*insights["engineeringIssues"], *insights["qaIssues"]]
    actions = [*insights["engineeringActions"], *insights["qaActions"]]
    readiness = insights["readiness"]
    return {
        "summary": _format_numbered_summary([_infer_topic(title, doc_type), _route_focus(doc_type), f"目前最需要补齐的是：{'；'.join(issues[:2])}" if issues else "当前主要 checklist 项已基本齐全，但仍建议补充评审结论与落地约束。", f"优先补充：{'；'.join(actions[:2])}" if actions else "建议补充最终评审结论、责任人与后续动作，提升落地效率。"]),
        "key_conclusions": [f"当前文档已基本满足进入{readiness['next_stage']}的条件。" if readiness and readiness.get("overall") else f"当前文档尚不足以直接进入{readiness['next_stage']}，需要先补齐关键缺口。"] if readiness else [],
        "major_issues": issues,
        "recommended_actions": actions,
    }


def build_document_summary(title: str, markdown: str, performance_analysis: dict | None = None, doc_type: dict | None = None, review_checklist: dict | None = None) -> dict:
    if (doc_type or {}).get("type") == "skip-weekly-report":
        return {"summary": "周报类文档默认跳过分析。", "key_conclusions": [], "major_issues": [], "recommended_actions": []}
    if (doc_type or {}).get("type") in {"pressure-design-review", "frontend-hld-review", "client-hld-review", "backend-hld-review", "prd-review"}:
        return _checklist_summary(title, doc_type or {}, review_checklist)
    analysis = build_heuristic_analysis(title, markdown)
    is_perf = (doc_type or {}).get("type") == "pressure-benchmark-review" or bool((performance_analysis or {}).get("trigger", {}).get("matched"))
    if is_perf and not has_meaningful_performance_insights(performance_analysis):
        return {
            "summary": _format_numbered_summary([f"文档主题是《{title}》对应的压测结果记录，但当前证据不足以支撑可靠结论。", "信息不足，无法分析性能。", "目前主要缺少可直接用于判断瓶颈的目标说明、环境信息、关键指标和结果对比。", "建议优先补充测试目标、环境配置、核心指标和最终结论，再继续分析。"]),
            "key_conclusions": ["信息不足，无法分析性能。", "当前内容不足以形成可靠的压测结论，也无法给出可信的性能瓶颈判断。"],
            "major_issues": ["缺少压测目标、场景、并发规模、持续时长、环境配置说明。", "缺少可直接引用的压测结果结论，无法判断瓶颈是在性能、存储、网络还是资源配置层面。", *analysis["gaps"]],
            "recommended_actions": ["补充压测目标、测试场景、并发规模、持续时长、机器规格、版本和关键配置。", "补充 QPS/TPS、P95/P99、平均时延、错误率、CPU/内存/网络/磁盘 等核心指标，并说明采样时间范围。", *analysis["suggestions"]],
        }
    key_conclusions = [*((performance_analysis or {}).get("bottlenecks") or []), *((performance_analysis or {}).get("trend_findings") or [])]
    major_issues = [*analysis["gaps"], *((performance_analysis or {}).get("risks") or [])]
    recommended_actions = [*analysis["suggestions"], *((performance_analysis or {}).get("recommendations") or [])]
    return {"summary": _format_numbered_summary([_infer_topic(title, doc_type), _route_focus(doc_type), f"目前最需要补齐的是：{'；'.join(major_issues[:2])}", f"优先补充：{'；'.join(recommended_actions[:2])}"]), "key_conclusions": key_conclusions, "major_issues": major_issues, "recommended_actions": recommended_actions}


def build_reply_suggestion(performance_analysis: dict | None, document_summary: dict) -> dict:
    reasons = []
    if has_meaningful_performance_insights(performance_analysis):
        reasons.append("已识别出可回复的压测/性能结论")
    if document_summary.get("major_issues"):
        reasons.append("文档存在明确缺失项和改进建议")
    return {"should_ask_for_confirmation": True, "suggested": bool(reasons), "reasons": reasons, "message": "分析已完成。如需将分析结果回复到原页面，请确认后再执行回复动作。"}


def build_analyze_url_result(url: str, title: str, updated_at: str, markdown: str, performance_analysis: dict | None = None, image_links: list[dict] | None = None, doc_type: dict | None = None, image_texts: list[str] | None = None, review_checklist: dict | None = None) -> dict:
    analysis = build_heuristic_analysis(title, markdown)
    resolved_doc_type = doc_type or classify_document_type(title, markdown, markdown, image_texts or [])
    resolved_checklist = review_checklist if review_checklist is not None else build_review_checklist(title, markdown, resolved_doc_type)
    document_summary = build_document_summary(title, markdown, performance_analysis, resolved_doc_type, resolved_checklist)
    if resolved_doc_type["type"] == "skip-weekly-report":
        return {"url": url, "title": title, "updated_at": updated_at, "doc_type": resolved_doc_type, "summary": "周报类文档默认跳过分析。", "positives": [], "gaps": [], "suggestions": [], "document_summary": document_summary, "review_checklist": None, "performance_analysis": None, "reply_draft": "", "reply_suggestion": {"should_ask_for_confirmation": False, "suggested": False, "reasons": [], "message": "周报类文档默认跳过分析与回复。"}}
    reply_draft = build_reply_draft(title, url, document_summary, performance_analysis, image_links or [], resolved_doc_type, resolved_checklist)
    return {"url": url, "title": title, "updated_at": updated_at, "doc_type": resolved_doc_type, "summary": document_summary["summary"], "positives": [], "gaps": analysis["gaps"], "suggestions": analysis["suggestions"], "document_summary": document_summary, "review_checklist": resolved_checklist, "performance_analysis": performance_analysis, "reply_draft": reply_draft, "reply_suggestion": build_reply_suggestion(performance_analysis, document_summary)}


def build_page_summary_artifact(title: str, source_url: str, doc_type: dict, document_summary: dict) -> str:
    return build_page_summary_markdown(title, source_url, doc_type, document_summary)


def validate_analyze_url_input(url_text: str) -> dict:
    return parse_confluence_page_url(url_text)
