from __future__ import annotations

import re
from pathlib import Path

from .performance import get_performance_trigger
from .shared import summarize_text_blocks, write_json

DOC_TYPE_ORDER = [
    "pressure-design-review",
    "pressure-benchmark-review",
    "client-hld-review",
    "frontend-hld-review",
    "backend-hld-review",
    "prd-review",
    "generic-review",
]


def _count_matches(text: str, patterns: list[str]) -> int:
    return sum(1 for pattern in patterns if re.search(pattern, text, re.I))


def _unique(values) -> list[str]:
    result = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def _is_weekly_report_title(title: str) -> bool:
    return bool(re.search(r"周报|week\d+|week\s*\d+", str(title or ""), re.I))


def _detect_pressure_design(title: str, body_text: str) -> dict | None:
    title_matched = bool(re.search(r"(?:(?:压测|基准|benchmark|性能测试).{0,8}(?:方案|计划|设计|准备|预案)|(?:方案|计划|设计|准备|预案).{0,8}(?:压测|基准|benchmark|性能测试))", title or "", re.I))
    signal_count = _count_matches(body_text, [r"目标|验收标准|成功标准", r"场景|用户路径|流量模型|压测路径", r"环境|拓扑|部署|版本|配置项", r"并发|持续时长|压测时长|爬坡", r"指标|QPS|TPS|P99|P95|CPU|内存|网络|磁盘", r"风险|回滚|应急预案", r"负责人|执行时间|排期|时间窗口", r"输出物|结果判定|结论模板"])
    if not title_matched or signal_count < 3:
        return None
    return {"matched": True, "confidence": "high" if signal_count >= 5 else "medium", "reason": "pressure-design-title-and-structure", "evidence_sources": ["title", "body"], "selected_template": "pressure-design-review"}


def _detect_hld_review(title: str, body_text: str) -> dict | None:
    title_matched = bool(re.search(r"\bHLD\b|高层设计|高阶设计|系统架构|架构设计|总体设计", title or "", re.I))
    architecture_count = _count_matches(body_text, [r"系统边界|边界|上下文|信任域|trust zone", r"组件|服务边界|模块职责|责任|component|service", r"数据流|调用链|消息流|交互流程|集成关系"])
    client_count = _count_matches(body_text, [r"客户端|移动端|mobile|ios|android|sdk|端上", r"离线|弱网|推送|通知|缓存|本地存储|兼容性", r"回调|端侧|前后台|后台保活|设备|机型"])
    frontend_count = _count_matches(body_text, [r"\bweb\b|浏览器|前端", r"页面|路由|组件|状态管理|viewmodel", r"交互流程|页面跳转|埋点"])
    backend_count = _count_matches(body_text, [r"服务|接口|数据库|存储|缓存|mq|消息队列|redis", r"鉴权|认证|授权|RBAC|OAuth|加密|安全", r"部署拓扑|机房|可用区|故障域|deployment|topology", r"扩缩容|高可用|容灾|failover|限流|降级|负载均衡", r"SLO|SLA|时延|可观测性|监控|链路追踪|日志|metrics", r"ADR|架构决策|trade-off|权衡|选型"])
    signal_count = architecture_count + client_count + frontend_count + backend_count
    if not title_matched and signal_count < 3:
        return None
    if client_count >= 2 and backend_count <= 1:
        doc_type = "client-hld-review"
    elif frontend_count >= 2 and backend_count == 0:
        doc_type = "frontend-hld-review"
    else:
        doc_type = "backend-hld-review"
    return {"type": doc_type, "matched": True, "confidence": "high" if title_matched and signal_count >= 2 else "medium", "reason": "hld-title-or-architecture-structure" if title_matched else "architecture-structure-only", "evidence_sources": _unique(["title" if title_matched else "", "body" if signal_count > 0 else ""]), "selected_template": doc_type}


def _detect_prd_review(title: str, body_text: str) -> dict | None:
    title_matched = bool(re.search(r"\bPRD\b|需求|产品需求|需求文档|方案需求|业务需求", title or "", re.I))
    signal_count = _count_matches(body_text, [r"背景|目标|价值|目的", r"用户|角色|persona|对象", r"场景|用例|流程|业务流程", r"范围|边界|不包含|不支持", r"需求|规则|约束|功能点", r"验收|成功标准|验收标准", r"依赖|风险|前置条件", r"负责人|时间节点|排期|里程碑|下一步"])
    if not title_matched and signal_count < 3:
        return None
    return {"matched": True, "confidence": "high" if title_matched and signal_count >= 2 else "medium", "reason": "prd-title-or-structure" if title_matched else "prd-structure-only", "evidence_sources": _unique(["title" if title_matched else "", "body" if signal_count > 0 else ""]), "selected_template": "prd-review"}


def classify_document_type(title: str, body_text: str = "", markdown: str = "", image_texts: list[str] | None = None) -> dict:
    combined_body = "\n".join(item for item in [body_text, markdown] if item)
    if _is_weekly_report_title(title):
        return {"type": "skip-weekly-report", "confidence": "high", "reason": "weekly-report-skip", "evidence_sources": ["title"], "selected_template": "skip-weekly-report"}
    pressure_design = _detect_pressure_design(title, combined_body)
    if pressure_design:
        return {"type": "pressure-design-review", **pressure_design}
    hld_review = _detect_hld_review(title, combined_body)
    if hld_review and "title" in hld_review.get("evidence_sources", []):
        return hld_review
    performance_trigger = get_performance_trigger({"title": title, "bodyText": combined_body, "imageTexts": image_texts or []})
    if performance_trigger["matched"]:
        return {"type": "pressure-benchmark-review", "confidence": "high" if performance_trigger["required"] else "medium", "reason": performance_trigger["reason"], "evidence_sources": _unique([performance_trigger["source"]]), "selected_template": "pressure-benchmark-review"}
    prd_review = _detect_prd_review(title, combined_body)
    if prd_review:
        return {"type": "prd-review", **prd_review}
    if hld_review:
        return hld_review
    return {"type": "generic-review", "confidence": "low", "reason": "fallback-generic-review", "evidence_sources": [], "selected_template": "generic-review"}


def build_page_summary_markdown(title: str, source_url: str, doc_type: dict, document_summary: dict) -> str:
    lines = [
        f"# {title}",
        "",
        f"- Doc Type: `{(doc_type or {}).get('type', 'generic-review')}`",
        f"- Template: `{(doc_type or {}).get('selected_template', 'generic-review')}`",
        f"- Source: [{source_url}]({source_url})",
        "",
        "## 简要总结",
        "",
        (document_summary or {}).get("summary") or summarize_text_blocks(title) or "信息不足，暂无总结。",
        "",
    ]
    for heading, key in [("关键结论", "key_conclusions"), ("主要问题", "major_issues"), ("建议动作", "recommended_actions")]:
        items = (document_summary or {}).get(key) or []
        if items:
            lines.extend([f"## {heading}", "", *[f"- {item}" for item in items], ""])
    return "\n".join(lines).strip() + "\n"


def persist_doc_type_artifact(page_dir: str | Path, doc_type: dict) -> None:
    write_json(Path(page_dir) / "doc-type.json", doc_type)


def persist_page_summary_artifact(page_dir: str | Path, summary_content: str) -> None:
    Path(page_dir).mkdir(parents=True, exist_ok=True)
    (Path(page_dir) / "summary.md").write_text(summary_content, encoding="utf-8")
