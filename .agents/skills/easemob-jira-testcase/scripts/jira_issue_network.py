from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import Request
from urllib.error import HTTPError, URLError

from jira_login_probe import (
    JiraProbeConfig,
    create_authenticated_session,
    extract_issue_key_from_url,
    extract_title,
    fetch,
    load_config,
)


ISSUE_KEY_PATTERN = re.compile(r"\b([A-Z][A-Z0-9_]+-\d+)\b")
URL_PATTERN = re.compile(r"https?://[^\s<>'\"，。；、)）\]]+")
IMAGE_MIME_TYPES = {"image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"}
STATUS_META_PATTERN = re.compile(r'name="ajs-issue-status" content="([^"]*)"')
PARENT_BLOCK_PATTERN = re.compile(r'<div[^>]+id="parentmodule"[^>]*>(.*?)</div>', re.IGNORECASE | re.DOTALL)
SUBTASK_BLOCK_PATTERN = re.compile(r'<(?:table|div)[^>]+id="issuetable"[^>]*>(.*?)</(?:table|div)>', re.IGNORECASE | re.DOTALL)
COMMENT_BLOCK_PATTERN = re.compile(r'<div[^>]+class="[^"]*action-body[^"]*"[^>]*>(.*?)</div>', re.IGNORECASE | re.DOTALL)
DESCRIPTION_BLOCK_PATTERN = re.compile(r'<div[^>]+id="description-val"[^>]*>(.*?)</div>', re.IGNORECASE | re.DOTALL)


@dataclass
class IssueRecord:
    key: str
    url: str
    title: str
    status: str
    description_text: str
    comments: list[str]
    parent_key: str | None
    subtask_keys: set[str]
    comment_references: set[str]
    external_documents: list[dict] = field(default_factory=list)
    jira_references: set[str] = field(default_factory=set)
    attachments: list[dict] = field(default_factory=list)

    def to_node(self) -> dict:
        return {
            "key": self.key,
            "url": self.url,
            "title": self.title,
            "status": self.status,
            "description_text": self.description_text,
            "comments": self.comments,
            "external_documents": self.external_documents,
            "jira_references": sorted(self.jira_references),
            "attachments": self.attachments,
        }


def extract_issue_keys_from_text(text: str) -> set[str]:
    return {match.group(1).upper() for match in ISSUE_KEY_PATTERN.finditer(text)}


def extract_jira_references_from_text(text: str, current_key: str = "") -> set[str]:
    references = extract_issue_keys_from_text(text or "")
    if current_key:
        references.discard(current_key.upper())
    return references


def classify_external_document(url: str) -> str | None:
    if "feishu.cn/wiki/" in url:
        return "feishu-wiki"
    if "feishu.cn/docx/" in url or "feishu.cn/docs/" in url:
        return "feishu-doc"
    if "c1.private.easemob.com/" in url:
        return "easemob-confluence"
    return None


def external_document_initial_reason(doc_type: str) -> str:
    if doc_type == "easemob-confluence":
        return "Easemob Confluence page discovered. Will attempt to fetch via easemob-confluence-review."
    return "Feishu document has not been read yet."


def extract_external_documents_from_text(text: str) -> list[dict]:
    documents = []
    seen_urls = set()
    for match in URL_PATTERN.finditer(text or ""):
        url = match.group(0).rstrip(".,;")
        doc_type = classify_external_document(url)
        if not doc_type or url in seen_urls:
            continue
        seen_urls.add(url)
        documents.append(
            {
                "type": doc_type,
                "url": url,
                "read_status": "not_read",
                "reason": external_document_initial_reason(doc_type),
            }
        )
    return documents


_CONFLUENCE_CACHE: dict = {}


def _confluence_review_script() -> str:
    """Return path to easemob-confluence-review run.sh relative to this skill."""
    return str(Path(__file__).resolve().parents[2] / "easemob-confluence-review" / "scripts" / "run.sh")


def _read_confluence_document(document: dict, runner=subprocess.run) -> dict:
    updated = dict(document)
    script = _confluence_review_script()
    if not Path(script).exists():
        updated["read_status"] = "not_read"
        updated["reason"] = "easemob-confluence-review skill not found."
        return updated
    command = [script, "analyze-url", "--url", updated["url"]]
    try:
        result = runner(command, capture_output=True, text=True, timeout=120)
    except TypeError:
        result = runner(command)
    except Exception as exc:
        updated["read_status"] = "not_read"
        updated["reason"] = f"easemob-confluence-review failed: {exc}"
        return updated

    if getattr(result, "returncode", 1) != 0:
        updated["read_status"] = "not_read"
        updated["reason"] = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "easemob-confluence-review failed").strip()[:500]
        return updated

    stdout = getattr(result, "stdout", "") or ""
    try:
        payload = json.loads(stdout)
        if payload.get("status") != "ok":
            updated["read_status"] = "not_read"
            updated["reason"] = f"easemob-confluence-review returned status={payload.get('status')}: {stdout[:300]}"
            return updated
        updated["read_status"] = "read"
        updated["reason"] = "Read by easemob-confluence-review."
        updated["title"] = payload.get("title", "")
        content_parts = []
        doc_summary = payload.get("document_summary")
        if isinstance(doc_summary, dict):
            if doc_summary.get("summary"):
                content_parts.append(doc_summary["summary"])
            if doc_summary.get("key_conclusions"):
                content_parts.append("Key conclusions: " + "; ".join(doc_summary["key_conclusions"]))
        elif isinstance(doc_summary, str) and doc_summary:
            content_parts.append(doc_summary)
        elif payload.get("summary"):
            content_parts.append(payload["summary"])
        if payload.get("gaps"):
            gaps = payload["gaps"]
            if isinstance(gaps, list):
                content_parts.append("Gaps: " + "; ".join(gaps))
            elif isinstance(gaps, str):
                content_parts.append(f"Gaps: {gaps}")
        updated["content"] = "\n\n".join(content_parts)[:8000]
    except Exception as exc:
        updated["read_status"] = "not_read"
        updated["reason"] = f"Could not parse easemob-confluence-review output: {exc}"
    return updated


def read_external_documents(documents: list[dict], runner=subprocess.run, *, _cache: dict | None = None) -> list[dict]:
    if _cache is None:
        _cache = _CONFLUENCE_CACHE
    enriched = []
    for document in documents:
        updated = dict(document)
        if not updated.get("url"):
            enriched.append(updated)
            continue

        # Confluence documents use easemob-confluence-review skill
        if updated.get("type") == "easemob-confluence":
            url = updated["url"]
            if url in _cache:
                enriched.append(_cache[url])
            else:
                result = _read_confluence_document(updated, runner=runner)
                _cache[url] = result
                enriched.append(result)
            continue

        command = [
            "lark-cli",
            "docs",
            "+fetch",
            "--api-version",
            "v2",
            "--as",
            "user",
            "--doc",
            updated["url"],
            "--doc-format",
            "markdown",
            "--format",
            "json",
        ]
        try:
            result = runner(command, capture_output=True, text=True, timeout=30)
        except TypeError:
            result = runner(command)
        except Exception as exc:
            updated["read_status"] = "not_read"
            updated["reason"] = f"lark-cli docs +fetch failed: {exc}"
            enriched.append(updated)
            continue

        if getattr(result, "returncode", 1) != 0:
            updated["read_status"] = "not_read"
            updated["reason"] = (getattr(result, "stderr", "") or getattr(result, "stdout", "") or "lark-cli docs +fetch failed").strip()
            enriched.append(updated)
            continue

        try:
            payload = json.loads(getattr(result, "stdout", "") or "{}")
            if not payload.get("ok"):
                updated["read_status"] = "not_read"
                updated["reason"] = json.dumps(payload.get("error", payload), ensure_ascii=False)
                enriched.append(updated)
                continue
            remote_document = payload.get("data", {}).get("document", {})
            updated["read_status"] = "read"
            updated["reason"] = "Read by lark-cli docs +fetch."
            updated["document_id"] = remote_document.get("document_id", "")
            updated["revision_id"] = remote_document.get("revision_id")
            updated["content"] = remote_document.get("content", "")
        except Exception as exc:
            updated["read_status"] = "not_read"
            updated["reason"] = f"Could not parse lark-cli docs +fetch output: {exc}"
        enriched.append(updated)
    return enriched


def strip_html(html: str) -> str:
    text = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    text = re.sub(r"(?is)<style.*?>.*?</style>", " ", text)
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def extract_section_texts(html: str, pattern: re.Pattern[str]) -> list[str]:
    sections = pattern.findall(html)
    cleaned = []
    for section in sections:
        text = strip_html(section)
        if text:
            cleaned.append(text)
    return cleaned


def parse_issue_family(issue_key: str, html: str) -> dict[str, object]:
    parent_key = None
    parent_match = PARENT_BLOCK_PATTERN.search(html)
    if parent_match:
        candidates = extract_issue_keys_from_text(parent_match.group(1))
        candidates.discard(issue_key.upper())
        if candidates:
            parent_key = sorted(candidates)[0]

    subtasks = set()
    subtask_match = SUBTASK_BLOCK_PATTERN.search(html)
    if subtask_match:
        subtasks = extract_issue_keys_from_text(subtask_match.group(1))
        subtasks.discard(issue_key.upper())

    return {"parent": parent_key, "subtasks": subtasks}


def parse_comment_references(issue_key: str, html: str) -> set[str]:
    references = set()
    for comment_text in extract_section_texts(html, COMMENT_BLOCK_PATTERN):
        references |= extract_issue_keys_from_text(comment_text)
    references.discard(issue_key.upper())
    return references


def parse_issue_record(issue_key: str, issue_url: str, html: str) -> IssueRecord:
    title = extract_title(html)
    status_match = STATUS_META_PATTERN.search(html)
    status = status_match.group(1).strip() if status_match else ""
    description_blocks = extract_section_texts(html, DESCRIPTION_BLOCK_PATTERN)
    comment_blocks = extract_section_texts(html, COMMENT_BLOCK_PATTERN)
    description_text = "\n".join(description_blocks)
    full_page_text = "\n".join([description_text, *comment_blocks, html])
    external_documents = extract_external_documents_from_text(full_page_text)
    jira_references = extract_jira_references_from_text(full_page_text, current_key=issue_key)
    family = parse_issue_family(issue_key, html)
    return IssueRecord(
        key=issue_key,
        url=issue_url,
        title=title,
        status=status,
        description_text=description_text,
        comments=comment_blocks,
        parent_key=family["parent"],
        subtask_keys=family["subtasks"],
        comment_references=parse_comment_references(issue_key, html),
        external_documents=external_documents,
        jira_references=jira_references,
    )


def _rest_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False)


def normalize_rest_attachment(attachment: dict) -> dict:
    return {
        "id": str(attachment.get("id", "")),
        "filename": attachment.get("filename", ""),
        "mime_type": attachment.get("mimeType", "") or attachment.get("mime_type", ""),
        "content_url": attachment.get("content", ""),
        "thumbnail_url": attachment.get("thumbnail", ""),
        "size": attachment.get("size"),
    }


def parse_issue_record_from_rest(issue_key: str, issue_url: str, payload: dict) -> IssueRecord:
    fields = payload.get("fields", {}) or {}
    title = fields.get("summary") or payload.get("key") or issue_key
    status = (fields.get("status") or {}).get("name", "")
    description_text = _rest_text(fields.get("description"))
    comments = [
        _rest_text(comment.get("body"))
        for comment in ((fields.get("comment") or {}).get("comments") or [])
        if _rest_text(comment.get("body")).strip()
    ]
    parent_key = (fields.get("parent") or {}).get("key")
    subtask_keys = {
        subtask.get("key", "").upper()
        for subtask in fields.get("subtasks", []) or []
        if subtask.get("key")
    }
    attachments = [
        normalize_rest_attachment(attachment)
        for attachment in fields.get("attachment", []) or []
        if attachment.get("filename") or attachment.get("content")
    ]
    full_text = "\n".join([description_text, *comments])
    external_documents = extract_external_documents_from_text(full_text)
    jira_references = extract_jira_references_from_text(full_text, current_key=issue_key)
    comment_references = set()
    for comment in comments:
        comment_references |= extract_jira_references_from_text(comment, current_key=issue_key)
    if parent_key:
        jira_references.add(parent_key.upper())
    jira_references |= subtask_keys
    return IssueRecord(
        key=issue_key,
        url=issue_url,
        title=title,
        status=status,
        description_text=description_text,
        comments=comments,
        parent_key=parent_key.upper() if parent_key else None,
        subtask_keys=subtask_keys,
        comment_references=comment_references,
        external_documents=external_documents,
        jira_references=jira_references,
        attachments=attachments,
    )


def determine_family_keys(root_key: str, records: dict[str, IssueRecord]) -> set[str]:
    root = records[root_key]
    if root.parent_key:
        parent = records[root.parent_key]
        return {root_key, root.parent_key, *parent.subtask_keys}
    return {root_key, *root.subtask_keys}


def build_edges(record: IssueRecord) -> list[dict]:
    edges = []
    if record.parent_key:
        edges.append(
            {
                "from_key": record.key,
                "to_key": record.parent_key,
                "type": "parent",
                "source": "parentmodule",
            }
        )
    for subtask_key in sorted(record.subtask_keys):
        edges.append(
            {
                "from_key": record.key,
                "to_key": subtask_key,
                "type": "subtask",
                "source": "issuetable",
            }
        )
    for target in sorted(record.comment_references):
        edges.append(
            {
                "from_key": record.key,
                "to_key": target,
                "type": "comment_reference",
                "source": "comment",
            }
        )
    for target in sorted(record.jira_references):
        edges.append(
            {
                "from_key": record.key,
                "to_key": target,
                "type": "jira_reference",
                "source": "page_link",
            }
        )
    return edges


def write_graph_outputs(output_root: Path, root_key: str, nodes: list[dict], edges: list[dict]) -> None:
    graph_dir = output_root / "graph"
    graph_dir.mkdir(parents=True, exist_ok=True)
    (graph_dir / "nodes.json").write_text(json.dumps(nodes, ensure_ascii=False, indent=2), encoding="utf-8")
    (graph_dir / "edges.json").write_text(json.dumps(edges, ensure_ascii=False, indent=2), encoding="utf-8")
    (graph_dir / "graph.json").write_text(
        json.dumps({"root": root_key, "nodes": nodes, "edges": edges}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def write_raw_issue(output_root: Path, record: IssueRecord) -> None:
    raw_dir = output_root / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    payload = record.to_node() | {
        "parent_key": record.parent_key,
        "subtask_keys": sorted(record.subtask_keys),
        "comment_references": sorted(record.comment_references),
    }
    (raw_dir / f"{record.key}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def extend_with_ghost_nodes(nodes: list[dict], edges: list[dict]) -> list[dict]:
    extended = [dict(node) for node in nodes]
    existing_keys = {node["key"] for node in extended}
    for edge in edges:
        target = edge["to_key"]
        if target in existing_keys:
            continue
        existing_keys.add(target)
        extended.append(
            {
                "key": target,
                "url": "",
                "title": "",
                "status": "",
                "description_text": "",
                "comments": [],
                "external_documents": [],
                "jira_references": [],
                "is_ghost": True,
            }
        )
    return sorted(extended, key=lambda node: node["key"])


def graph_node_id(issue_key: str) -> str:
    return issue_key.replace("-", "_")


def build_summary_markdown(root_node: dict, nodes: list[dict], edges: list[dict]) -> str:
    edge_types = {}
    for edge in edges:
        edge_types[edge["type"]] = edge_types.get(edge["type"], 0) + 1
    type_lines = [f"- {edge_type}: {count}" for edge_type, count in sorted(edge_types.items())]
    return "\n".join(
        [
            f"# {root_node['key']} Issue Network",
            "",
            f"- Title: {root_node.get('title', '')}",
            f"- Status: {root_node.get('status', '')}",
            f"- Total issues: {len(nodes)}",
            f"- Total relationships: {len(edges)}",
            "",
            "## Relationship Types",
            *type_lines,
        ]
    )


def build_test_impact_markdown(root_node: dict, nodes: list[dict], edges: list[dict]) -> str:
    real_nodes = [node for node in nodes if not node.get("is_ghost")]
    ghost_nodes = [node for node in nodes if node.get("is_ghost")]
    subtask_targets = sorted(edge["to_key"] for edge in edges if edge["type"] == "subtask")
    comment_targets = sorted(edge["to_key"] for edge in edges if edge["type"] == "comment_reference")
    return "\n".join(
        [
            f"# {root_node['key']} Test Impact",
            "",
            f"- Root issue: {root_node['key']} {root_node.get('title', '')}".strip(),
            f"- Real scope nodes: {len(real_nodes)}",
            f"- Ghost reference nodes: {len(ghost_nodes)}",
            "",
            "## Parent Child Scope",
            *([f"- {key}" for key in subtask_targets] or ["- None"]),
            "",
            "## Comment References",
            *([f"- {key}" for key in comment_targets] or ["- None"]),
            "",
            "## Test Focus",
            "- Validate the root issue behavior and its direct child tasks as one bounded feature set.",
            "- Review comment-referenced Jira keys for upstream or downstream behavior dependencies.",
            "- Prioritize regression coverage where comment references connect the root task to adjacent capabilities.",
        ]
    )


def generate_testcase_markdown(root_node: dict, nodes: list[dict], edges: list[dict]) -> str:
    real_nodes = [node for node in nodes if not node.get("is_ghost")]
    ghost_nodes = [node for node in nodes if node.get("is_ghost")]
    subtask_targets = sorted(edge["to_key"] for edge in edges if edge["type"] == "subtask")
    comment_targets = sorted(edge["to_key"] for edge in edges if edge["type"] == "comment_reference")
    subtask_lines = [f"- `{key}`" for key in subtask_targets] or ["- 无"]
    comment_lines = [f"- `{key}`" for key in comment_targets] or ["- 无"]
    return "\n".join(
        [
            f"# {root_node['key']} 测试用例草案",
            "",
            f"**根 Jira：** `{root_node['key']}`",
            f"**需求主题：** {root_node.get('title', '')}",
            f"**实际抓取节点数：** {len(real_nodes)}",
            f"**引用补全节点数：** {len(ghost_nodes)}",
            "",
            "## 直接子任务",
            *subtask_lines,
            "",
            "## 评论引用影响面",
            *comment_lines,
            "",
            "## 建议测试关注点",
            "- 优先验证根需求与直接子任务的主链路闭环。",
            "- 结合评论引用 Jira 梳理联动功能与回归影响面。",
            "- 对状态切换、查询结果、ACK 一致性设计专项验证。",
            "",
            "## 测试用例编写颗粒度要求",
            "- 每条测试用例必须写清楚前置资源：用户、群组、聊天室、文件、配置、灰度、权限或历史数据。",
            "- 每条测试用例必须写清楚使用的入口/API/页面操作、请求方法、关键路径、鉴权方式和关键入参。",
            "- 如果前一步返回值会传给后一步，必须写清楚来源字段和传递目标，例如 `entities[0].uuid` -> `fileId`。",
            "- 预期结果必须包含 HTTP 状态码、业务错误码、响应字段、数据库/消息/回调/事件变化或页面可见结果。",
            "- 不能只写“执行接口并验证成功”；必须写到可由测试工程师直接照着执行的步骤。",
            "",
            "## 用例步骤模板",
            "| 用例 | 前置资源/测试数据 | 操作步骤 | 预期结果/断言点 | 备注 |",
            "| --- | --- | --- | --- | --- |",
            "| 主链路成功 | 说明创建哪个用户、使用什么 token、准备什么文件/配置 | 1. 调用/打开哪个入口；2. 传入哪些关键字段；3. 从哪个响应字段取值传给下一步 | 断言状态码、业务码、响应字段、数据落库/消息/回调 | 标注关联 Jira/文档 |",
            "| 异常路径 | 说明异常输入、权限或环境条件 | 写清触发异常的具体请求或操作 | 断言错误码、错误消息和状态不变 | 标注是否依赖环境 |",
        ]
    )


def generate_partial_testcase_markdown(root_node: dict, nodes: list[dict], edges: list[dict], readiness: dict) -> str:
    base_cases = generate_testcase_markdown(root_node, nodes, edges)
    missing_lines = [f"- {item}" for item in readiness.get("missing", [])] or ["- 暂无"]
    suggestion_lines = [f"- {item}" for item in readiness.get("suggestions", [])] or ["- 暂无"]
    return "\n".join(
        [
            f"# {root_node['key']} 假设版测试用例草案",
            "",
            "## 信息完整度",
            "状态：partial",
            f"原因：{readiness.get('message', '当前 Jira 信息不足，缺少明确验收标准或改动边界。')}",
            "",
            "## 基于当前信息的测试范围",
            f"- 需求主题：{root_node.get('title', '') or root_node['key']}",
            "- 优先覆盖标题可推断的主功能路径。",
            "- 覆盖直接子任务、评论引用和相邻能力的基础回归影响面。",
            "",
            "## 默认假设",
            "- 假设本次改动只影响 Jira 标题或关联任务指向的功能域。",
            "- 假设无额外权限、套餐、灰度、计费或兼容性差异，除非 Jira 后续补充说明。",
            "- 假设未明确提到的接口字段、错误码和事件不发生契约变更。",
            "",
            "## 测试用例草案",
            base_cases,
            "",
            "## 待确认问题",
            *suggestion_lines,
            "",
            "## 当前缺口",
            *missing_lines,
            "",
            "## 风险说明",
            "- 当前用例基于有限 Jira 信息生成，可能漏掉隐藏业务分支。",
            "- 需求方或开发补充验收标准后，应补齐异常路径、边界条件和明确不测范围。",
        ]
    )


def build_case_design_markdown(root_node: dict, nodes: list[dict], edges: list[dict], readiness: dict) -> str:
    real_nodes = [node for node in nodes if not node.get("is_ghost")]
    ghost_nodes = [node for node in nodes if node.get("is_ghost")]
    subtask_targets = sorted(edge["to_key"] for edge in edges if edge["type"] == "subtask")
    comment_targets = sorted(edge["to_key"] for edge in edges if edge["type"] == "comment_reference")
    missing_lines = [f"- {item}" for item in readiness.get("missing", [])] or ["- 无"]
    suggestion_lines = [f"- {item}" for item in readiness.get("suggestions", [])] or ["- 无"]
    subtask_lines = [f"- `{key}`" for key in subtask_targets] or ["- 无"]
    comment_lines = [f"- `{key}`" for key in comment_targets] or ["- 无"]
    external_documents = []
    seen_document_urls = set()
    for node in nodes:
        for document in node.get("external_documents", []) or []:
            url = document.get("url", "")
            if not url or url in seen_document_urls:
                continue
            seen_document_urls.add(url)
            external_documents.append(document)
    external_document_lines = [
        "\n".join(
            [
                f"- 类型：{document.get('type', '')}；读取状态：{document.get('read_status', '')}；URL：{document.get('url', '')}；说明：{document.get('reason', '')}",
                *(["  - 摘要内容："] if document.get("content") else []),
                *([f"    {line}" for line in document.get("content", "").splitlines()[:12] if line.strip()] if document.get("content") else []),
            ]
        )
        for document in external_documents
    ] or ["- 无"]
    attachments = []
    seen_attachment_urls = set()
    for node in nodes:
        for attachment in node.get("attachments", []) or []:
            attachment_key = attachment.get("content_url") or f"{node.get('key')}:{attachment.get('filename')}"
            if not attachment_key or attachment_key in seen_attachment_urls:
                continue
            seen_attachment_urls.add(attachment_key)
            attachments.append((node.get("key", ""), attachment))
    attachment_lines = [
        f"- `{node_key}` 附件：{attachment.get('filename', '')}；类型：{attachment.get('mime_type', '')}；URL：{attachment.get('content_url', '')}"
        for node_key, attachment in attachments
    ] or ["- 无"]
    return "\n".join(
        [
            f"# {root_node['key']} Case 覆盖设计",
            "",
            "## 任务完整性总结",
            f"- 信息完整度：状态：{readiness['status']}",
            f"- 根 Jira：`{root_node['key']}`",
            f"- 需求主题：{root_node.get('title', '')}",
            f"- 实际抓取节点数：{len(real_nodes)}",
            f"- 引用补全节点数：{len(ghost_nodes)}",
            f"- 判断原因：{readiness.get('message') or readiness.get('reason', '')}",
            "",
            "## 当前缺口",
            *missing_lines,
            "",
            "## 外部设计文档",
            *external_document_lines,
            "",
            "## 附件证据",
            *attachment_lines,
            "",
            "## Case 覆盖设计",
            "- 主流程：覆盖根 Jira 标题和可见描述能推断出的核心行为。",
            "- 关联范围：覆盖直接子任务、父子任务关系和评论引用带来的联动影响。",
            "- 回归范围：覆盖相邻能力、状态切换、查询结果、通知或 ACK 一致性等高风险路径。",
            "- 异常范围：在需求补充后补齐权限、配置、灰度、兼容性、历史数据和错误码分支。",
            "",
            "## 直接子任务",
            *subtask_lines,
            "",
            "## 评论引用影响面",
            *comment_lines,
            "",
            "## 待确认问题",
            *suggestion_lines,
            "",
            "## 对话式测试用例草稿",
            "在企微托管对话中，请基于以上证据直接输出完整 Markdown 测试用例草稿供人工审核，无需用户提供任何本地目录。",
            "草稿应明确标注尚未写入项目或提交 GitHub；用户提出修改时，应返回修改后的完整 Markdown。",
        ]
    )


def assess_case_readiness(nodes: list[dict], edges: list[dict], root_key: str) -> dict:
    root_node = next(node for node in nodes if node["key"] == root_key)
    title = root_node.get("title", "").strip()
    description = root_node.get("description_text", "").strip()
    comments = root_node.get("comments", [])
    has_subtask = any(edge["type"] == "subtask" and edge["from_key"] == root_key for edge in edges)
    has_structured_comment = any(("阶段" in comment or "任务" in comment or "HIM-" in comment) for comment in comments)
    has_flow_description = not _is_empty_description(description) and not _is_link_only_description(description) and len(description) >= 20
    has_any_body_context = any(_node_has_context(node) for node in nodes if not node.get("is_ghost"))
    has_linked_context = len([node for node in nodes if not node.get("is_ghost")]) > 1 or bool(edges)

    missing = []
    suggestions = []
    if not title:
        missing.append("缺少明确标题")
        suggestions.append("补充明确的需求标题或目标。")
    if not has_subtask:
        missing.append("缺少明确子任务结构")
        suggestions.append("补充父子任务拆解、模块边界或功能分工。")
    if not has_structured_comment and not has_flow_description:
        missing.append("缺少足够业务上下文")
        suggestions.append("补充业务流程、状态流转、接口说明或结构化评论拆解。")
    if has_linked_context and not has_any_body_context:
        missing.append("根 Jira 和关联 Jira 均缺少需求描述、评论补充或外部设计文档")
        suggestions.append("补充可执行验收标准、支持范围、入口/API、配置项和不支持场景的预期表现。")

    ready = bool(title) and has_any_body_context and (has_subtask or has_structured_comment or has_flow_description)
    if ready:
        return {
            "status": "ready",
            "reason": "sufficient structured Jira context",
            "missing": [],
            "suggestions": [],
        }
    if title and has_linked_context and not has_any_body_context:
        return {
            "status": "not_ready",
            "reason": "insufficient Jira body context for testcase generation",
            "missing": missing,
            "suggestions": suggestions,
            "message": "当前 Jira 及关联 Jira 缺少需求描述、评论补充或外部设计文档，暂无法形成可执行测试范围。",
        }
    if title:
        return {
            "status": "partial",
            "reason": "limited Jira context with identifiable topic",
            "missing": missing,
            "suggestions": suggestions
            + [
                "确认本次具体改动点、验收标准和明确不测范围。",
                "确认是否影响接口字段、权限、配置、灰度、历史数据或兼容性。",
            ],
            "message": "当前 Jira 信息不足，但标题可识别功能方向；先生成假设版测试用例草案，并保留待确认问题。",
        }
    return {
        "status": "not_ready",
        "reason": "insufficient Jira context for testcase generation",
        "missing": missing,
        "suggestions": suggestions,
        "message": "当前暂不满足生成测试 case 条件，请先补充以下信息后再确认是否继续生成。",
    }


def render_mermaid(nodes: list[dict], edges: list[dict]) -> str:
    lines = ["flowchart TD"]
    for node in nodes:
        node_id = graph_node_id(node["key"])
        title = node.get("title") or node["key"]
        label = f"{node['key']} {title}".strip().replace('"', "'")
        bracket = "{{" if node.get("is_ghost") else "["
        end_bracket = "}}" if node.get("is_ghost") else "]"
        lines.append(f'    {node_id}{bracket}"{label}"{end_bracket}')
    for edge in edges:
        source = graph_node_id(edge["from_key"])
        target = graph_node_id(edge["to_key"])
        edge_label = edge["type"]
        lines.append(f"    {source} -->|{edge_label}| {target}")
    return "\n".join(lines)


def render_graphviz(nodes: list[dict], edges: list[dict]) -> str:
    lines = ['digraph JiraIssueNetwork {', '  rankdir=LR;']
    for node in nodes:
        node_id = graph_node_id(node["key"])
        title = node.get("title") or node["key"]
        label = f"{node['key']}\\n{title}".replace('"', "'")
        shape = "ellipse" if node.get("is_ghost") else "box"
        style = ' style="dashed"' if node.get("is_ghost") else ""
        lines.append(f'  {node_id} [label="{label}" shape={shape}{style}];')
    for edge in edges:
        source = graph_node_id(edge["from_key"])
        target = graph_node_id(edge["to_key"])
        lines.append(f'  {source} -> {target} [label="{edge["type"]}"];')
    lines.append("}")
    return "\n".join(lines)


def write_summary(output_root: Path, root_key: str, summary: str) -> None:
    summary_dir = output_root / "summary"
    summary_dir.mkdir(parents=True, exist_ok=True)
    (summary_dir / f"{root_key}.md").write_text(summary, encoding="utf-8")


def write_visualizations(output_root: Path, root_key: str, nodes: list[dict], edges: list[dict]) -> None:
    graph_dir = output_root / "graph"
    graph_dir.mkdir(parents=True, exist_ok=True)
    (graph_dir / f"{root_key}.mmd").write_text(render_mermaid(nodes, edges), encoding="utf-8")
    (graph_dir / f"{root_key}.dot").write_text(render_graphviz(nodes, edges), encoding="utf-8")


def write_test_impact(output_root: Path, root_key: str, content: str) -> None:
    summary_dir = output_root / "summary"
    summary_dir.mkdir(parents=True, exist_ok=True)
    (summary_dir / f"{root_key}-test-impact.md").write_text(content, encoding="utf-8")


def write_testcases(output_root: Path, root_key: str, content: str) -> None:
    summary_dir = output_root / "summary"
    summary_dir.mkdir(parents=True, exist_ok=True)
    (summary_dir / f"{root_key}-test-cases.md").write_text(content, encoding="utf-8")


def write_case_design(output_root: Path, root_key: str, content: str) -> None:
    summary_dir = output_root / "summary"
    summary_dir.mkdir(parents=True, exist_ok=True)
    (summary_dir / f"{root_key}-case-design.md").write_text(content, encoding="utf-8")


def _safe_attachment_filename(issue_key: str, filename: str) -> str:
    cleaned = re.sub(r"[\\/:\0]+", "_", filename or "attachment")
    return f"{issue_key}-{cleaned}"


def _is_visual_attachment(attachment: dict) -> bool:
    mime_type = (attachment.get("mime_type") or "").lower()
    filename = (attachment.get("filename") or "").lower()
    return mime_type in IMAGE_MIME_TYPES or filename.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp"))


def build_visual_review_prompt(root_key: str, downloaded: list[dict]) -> str:
    attachment_lines = [
        f"- Jira：`{item['issue_key']}`；文件：{item['filename']}；本地路径：`{item['local_path']}`；来源：{item.get('content_url', '')}"
        for item in downloaded
    ] or ["- 无"]
    return "\n".join(
        [
            f"# {root_key} 视觉附件分析任务包",
            "",
            "以下图片附件来自 Jira 分析结果。请使用当前多模态 LLM 能力直接查看图片，不使用 OCR，提取可用于 QA 审查的信息。",
            "",
            "## 图片附件",
            *attachment_lines,
            "",
            "## 请输出",
            "1. 页面模块：截图属于哪个产品、页面、弹窗或流程状态。",
            "2. 可见提示文案：逐条列出错误、成功、警告、说明、按钮和链接文案。",
            "3. 交互入口：按钮、关闭入口、倒计时、跳转目标或可操作控件。",
            "4. 可推断测试场景：每条文案或状态对应的触发条件和验证点。",
            "5. 仍需确认的问题：截图无法确定的接口、权限、配置、灰度、兼容性或不测范围。",
            "",
            "## 输出要求",
            "- 明确标注结论来自哪张截图。",
            "- 不要把图片识别结果当作最终验收标准；若 Jira 正文没有写明，标记为“基于截图推断”。",
            "- 对 UI 文案保持原文，不要自行改写。",
        ]
    )


def download_visual_attachment_artifacts(output_root: Path, root_key: str, nodes: list[dict], opener, timeout: int = 20) -> dict:
    attachment_dir = output_root / "attachments" / "visual"
    summary_dir = output_root / "summary"
    downloaded = []
    seen_urls = set()
    for node in nodes:
        issue_key = node.get("key", root_key)
        for attachment in node.get("attachments", []) or []:
            if not _is_visual_attachment(attachment):
                continue
            content_url = attachment.get("content_url", "")
            if not content_url or content_url in seen_urls:
                continue
            seen_urls.add(content_url)
            attachment_dir.mkdir(parents=True, exist_ok=True)
            local_path = attachment_dir / _safe_attachment_filename(issue_key, attachment.get("filename", "attachment"))
            request = Request(content_url)
            with opener.open(request, timeout=timeout) as response:
                local_path.write_bytes(response.read())
            downloaded.append(
                {
                    "issue_key": issue_key,
                    "filename": attachment.get("filename", ""),
                    "mime_type": attachment.get("mime_type", ""),
                    "content_url": content_url,
                    "local_path": str(local_path),
                }
            )
    summary_dir.mkdir(parents=True, exist_ok=True)
    prompt_file = summary_dir / f"{root_key}-visual-review.md"
    prompt_file.write_text(build_visual_review_prompt(root_key, downloaded), encoding="utf-8")
    return {"downloaded": downloaded, "prompt_file": prompt_file}


def _is_empty_description(value: str) -> bool:
    normalized = re.sub(r"\s+", " ", value or "").strip().lower()
    return normalized in {"", "click to add description", "no description"}


def _is_link_only_description(value: str) -> bool:
    normalized = re.sub(r"\s+", " ", value or "").strip()
    if not normalized:
        return False
    without_urls = URL_PATTERN.sub("", normalized)
    without_issue_keys = ISSUE_KEY_PATTERN.sub("", without_urls)
    return not re.sub(r"[\s,.;:，。；、()（）\[\]【】_-]+", "", without_issue_keys)


def _node_has_context(node: dict) -> bool:
    return (
        (not _is_empty_description(node.get("description_text", "")) and not _is_link_only_description(node.get("description_text", "")))
        or bool(node.get("comments"))
        or bool(node.get("external_documents"))
        or bool(node.get("attachments"))
    )


def build_reply_draft(root_node: dict, nodes: list[dict], edges: list[dict], readiness: dict) -> str:
    missing_lines = [f"{index}. {item}" for index, item in enumerate(readiness.get("missing", []), start=1)]
    if not missing_lines:
        empty_context_nodes = [node for node in nodes if not node.get("is_ghost") and not _node_has_context(node)]
        missing_lines = [
            f"{index}. `{node['key']}` 缺少需求描述、评论补充和外部设计文档。"
            for index, node in enumerate(empty_context_nodes, start=1)
        ] or ["1. 当前 Jira 缺少足够验收标准或改动边界。"]

    suggestion_lines = [f"- {item}" for item in readiness.get("suggestions", [])]
    if not suggestion_lines:
        suggestion_lines = [
            "- 补充具体改动点、验收标准和明确不测范围。",
            "- 补充涉及的入口、接口字段、配置项、权限、灰度、兼容性和异常表现。",
        ]

    linked_keys = sorted(
        {
            edge["to_key"]
            for edge in edges
            if edge.get("from_key") == root_node["key"] and edge.get("to_key") != root_node["key"]
        }
    )
    linked_line = f"关联 Jira：{', '.join(f'`{key}`' for key in linked_keys)}" if linked_keys else "关联 Jira：无"

    if readiness.get("status") == "ready" and all(not _node_has_context(node) for node in nodes if not node.get("is_ghost")):
        conclusion = "测试结论：信息不足，暂无法开展有效测试。"
    elif readiness.get("status") == "ready":
        conclusion = "测试结论：当前信息可支持测试设计，建议按已生成 Case 覆盖设计继续确认。"
    else:
        conclusion = "测试结论：信息不足，暂无法开展有效测试。"

    return "\n".join(
        [
            conclusion,
            "",
            f"根 Jira：`{root_node['key']}`",
            f"需求主题：{root_node.get('title', '')}",
            linked_line,
            "",
            "原因如下：",
            *missing_lines,
            "",
            "请补充以下信息后再进入测试：",
            *suggestion_lines,
        ]
    )


def build_reply_state(issue_key: str, issue_url: str, reply_content: str, status: str = "drafted", now: str | None = None) -> dict:
    current = now or datetime.now(timezone.utc).isoformat()
    return {
        "issue_key": issue_key,
        "issue_url": issue_url,
        "status": status,
        "reply_generated_at": current,
        "reply_confirmed_at": None,
        "reply_sent_at": None,
        "reply_hash": hashlib.sha256(reply_content.encode("utf-8")).hexdigest(),
        "comment_id": None,
        "last_reply_preview": reply_content[:280],
    }


HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


def normalize_api_endpoint_wrapping(content: str) -> str:
    content = normalize_inline_api_endpoint_wrapping(content)
    lines = content.splitlines()
    normalized_lines = []
    index = 0
    while index < len(lines):
        line = lines[index]
        match = re.match(r"^(\s*(?:(?:[-*]\s*)|\d+\.\s*)?)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(/.*)$", line)
        if not match:
            normalized_lines.append(line)
            index += 1
            continue

        prefix, method, path = match.groups()
        fragments = [path.strip()]
        cursor = index + 1
        while cursor < len(lines):
            candidate = lines[cursor].strip()
            if not candidate:
                lookahead = cursor + 1
                while lookahead < len(lines) and not lines[lookahead].strip():
                    lookahead += 1
                if lookahead >= len(lines):
                    break
                if not _is_api_path_continuation(lines[lookahead].strip()):
                    break
                cursor = lookahead
                candidate = lines[cursor].strip()

            if not _is_api_path_continuation(candidate):
                break
            fragments.append(candidate)
            cursor += 1

        if len(fragments) > 1:
            normalized_lines.append(f"{prefix}{method} {_join_api_path_fragments(fragments)}")
            index = cursor
            continue

        normalized_lines.append(line)
        index += 1
    return "\n".join(normalized_lines)


def format_api_endpoint_for_jira_comment(content: str) -> str:
    def replace(match: re.Match[str]) -> str:
        code = match.group(1)
        if not re.match(rf"^({'|'.join(sorted(HTTP_METHODS))})\s+/", code.strip(), re.DOTALL):
            return match.group(0)
        return "{noformat}" + code.strip() + "{noformat}"

    return re.sub(r"`([^`]+)`", replace, content, flags=re.DOTALL)


def format_json_code_for_jira_comment(content: str) -> str:
    def replace(match: re.Match[str]) -> str:
        code = match.group(1).strip()
        if not (code.startswith("{") or code.startswith("[")):
            return match.group(0)
        try:
            parsed = json.loads(code)
        except json.JSONDecodeError:
            return match.group(0)
        pretty = json.dumps(parsed, ensure_ascii=False, indent=2)
        return "{code}\n" + pretty + "\n{code}"

    return re.sub(r"`([^`]+)`", replace, content, flags=re.DOTALL)


def format_inline_code_for_jira_comment(content: str) -> str:
    def replace(match: re.Match[str]) -> str:
        code = match.group(1).strip()
        if not code:
            return match.group(0)
        if code.startswith("{noformat}") or code.startswith("{code"):
            return match.group(0)
        return "{{" + code + "}}"

    return re.sub(r"`([^`]+)`", replace, content, flags=re.DOTALL)


def prepare_jira_reply_content(content: str) -> str:
    content = normalize_api_endpoint_wrapping(content)
    content = format_api_endpoint_for_jira_comment(content)
    content = format_json_code_for_jira_comment(content)
    return format_inline_code_for_jira_comment(content)


def unescape_jira_code_placeholders(content: str) -> str:
    content = content.replace("{{noformat}", "{noformat}")
    content = content.replace("{noformat}}", "{noformat}")
    return content.replace("{code}}", "{code}")


def normalize_inline_api_endpoint_wrapping(content: str) -> str:
    def replace(match: re.Match[str]) -> str:
        code = match.group(1)
        code_match = re.match(rf"^({'|'.join(sorted(HTTP_METHODS))})\s+(.+)$", code.strip(), re.DOTALL)
        if not code_match:
            return match.group(0)
        method, path = code_match.groups()
        if "\n" not in path and "\r" not in path:
            return match.group(0)
        fragments = [fragment.strip() for fragment in re.split(r"\s+", path) if fragment.strip()]
        if not fragments or not all(_is_api_path_continuation(fragment) for fragment in fragments):
            return match.group(0)
        return f"`{method} {_join_api_path_fragments(fragments)}`"

    return re.sub(r"`([^`]+)`", replace, content, flags=re.DOTALL)


def _is_api_path_continuation(value: str) -> bool:
    if not value:
        return False
    if re.match(r"^(?:[-*]|\d+\.)\s+", value):
        return False
    if re.match(rf"^({'|'.join(sorted(HTTP_METHODS))})\s+/", value):
        return False
    return value == "/" or value.startswith("/") or value.startswith("{") or bool(re.match(r"^[A-Za-z0-9_.~%-]+/", value))


def _join_api_path_fragments(fragments: list[str]) -> str:
    endpoint = ""
    for fragment in fragments:
        cleaned = fragment.strip()
        if not cleaned:
            continue
        if not endpoint:
            endpoint = cleaned
        elif endpoint.endswith("/") and cleaned.startswith("/"):
            endpoint += cleaned.lstrip("/")
        elif endpoint.endswith("/") or cleaned.startswith("/"):
            endpoint += cleaned
        else:
            endpoint += "/" + cleaned
    return re.sub(r"/{2,}", "/", endpoint)


def write_reply_artifacts(output_root: Path, root_key: str, reply_content: str, reply_state: dict) -> None:
    summary_dir = output_root / "summary"
    summary_dir.mkdir(parents=True, exist_ok=True)
    reply_content = prepare_jira_reply_content(reply_content)
    reply_state = {
        **reply_state,
        "reply_hash": hashlib.sha256(reply_content.encode("utf-8")).hexdigest(),
        "last_reply_preview": reply_content[:280],
    }
    (summary_dir / f"{root_key}-reply.md").write_text(reply_content, encoding="utf-8")
    (summary_dir / f"{root_key}-reply-state.json").write_text(
        json.dumps(reply_state, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def read_json_file(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def confirm_issue_reply(output_root: Path, issue_key: str, opener, base_url: str, timeout: int = 20, now: str | None = None) -> dict:
    summary_dir = output_root / "summary"
    reply_path = summary_dir / f"{issue_key}-reply.md"
    state_path = summary_dir / f"{issue_key}-reply-state.json"
    if not reply_path.exists():
        raise FileNotFoundError(f"reply draft not found: {reply_path}")
    if not state_path.exists():
        raise FileNotFoundError(f"reply state not found: {state_path}")

    reply_content = prepare_jira_reply_content(reply_path.read_text(encoding="utf-8"))
    state = read_json_file(state_path)
    reply_hash = hashlib.sha256(reply_content.encode("utf-8")).hexdigest()
    if state.get("status") == "replied" and state.get("reply_hash") == reply_hash:
        return {"status": "skipped", "reason": "reply already posted", "comment_id": state.get("comment_id")}

    comment_url = urljoin(base_url.rstrip("/") + "/", f"rest/api/2/issue/{issue_key}/comment")
    payload = json.dumps({"body": reply_content}, ensure_ascii=False).encode("utf-8")
    request = Request(comment_url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    with opener.open(request, timeout=timeout) as response:
        status_code = getattr(response, "status", response.getcode())
        body = response.read().decode("utf-8", errors="replace")
    if status_code not in {200, 201}:
        raise RuntimeError(f"Jira reply comment failed with status {status_code}: {body[:400]}")

    data = json.loads(body or "{}")
    current = now or datetime.now(timezone.utc).isoformat()
    next_state = {
        **state,
        "status": "replied",
        "reply_confirmed_at": state.get("reply_confirmed_at") or current,
        "reply_sent_at": current,
        "reply_hash": reply_hash,
        "comment_id": data.get("id"),
        "last_reply_preview": reply_content[:280],
    }
    state_path.write_text(json.dumps(next_state, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"status": "replied", "comment_id": data.get("id")}


def resolve_issue_key(root_input: str) -> str:
    if root_input.startswith("http://") or root_input.startswith("https://"):
        return extract_issue_key_from_url(root_input)
    return root_input.strip().upper()


def resolve_issue_url(base_url: str, issue_key: str) -> str:
    return urljoin(base_url, f"/browse/{issue_key}")


def resolve_issue_api_url(base_url: str, issue_key: str) -> str:
    fields = "summary,description,status,issuetype,comment,issuelinks,parent,subtasks,attachment,created,updated,assignee,reporter,labels,components,fixVersions"
    return urljoin(base_url.rstrip("/") + "/", f"rest/api/2/issue/{issue_key}?fields={fields}")


def fetch_issue_record_from_rest(opener, config: JiraProbeConfig, issue_key: str) -> IssueRecord:
    issue_url = resolve_issue_url(config.base_url, issue_key)
    api_url = resolve_issue_api_url(config.base_url, issue_key)
    request = Request(api_url, headers={"Accept": "application/json"})
    with opener.open(request, timeout=config.timeout) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace") or "{}")
    return parse_issue_record_from_rest(issue_key, issue_url, payload)


def fetch_issue_record(opener, config: JiraProbeConfig, issue_key: str) -> IssueRecord:
    try:
        return fetch_issue_record_from_rest(opener, config, issue_key)
    except (HTTPError, URLError, json.JSONDecodeError, OSError):
        pass
    issue_url = resolve_issue_url(config.base_url, issue_key)
    result = fetch(opener, issue_url, config.timeout)
    return parse_issue_record(issue_key, issue_url, result.html)


def build_crawl_outputs(output_root: Path, root_key: str, records: dict[str, IssueRecord]) -> dict:
    for record in records.values():
        write_raw_issue(output_root, record)

    nodes = [records[key].to_node() for key in sorted(records)]
    for node in nodes:
        if node.get("external_documents"):
            node["external_documents"] = read_external_documents(node["external_documents"])
            records[node["key"]].external_documents = node["external_documents"]
            write_raw_issue(output_root, records[node["key"]])
    edges = []
    seen_edges = set()
    for record in records.values():
        for edge in build_edges(record):
            edge_key = (edge["from_key"], edge["to_key"], edge["type"], edge["source"])
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            edges.append(edge)

    graph_nodes = extend_with_ghost_nodes(nodes, edges)
    write_graph_outputs(output_root, root_key, graph_nodes, edges)
    write_visualizations(output_root, root_key, graph_nodes, edges)
    summary = build_summary_markdown(records[root_key].to_node(), graph_nodes, edges)
    write_summary(output_root, root_key, summary)
    test_impact = build_test_impact_markdown(records[root_key].to_node(), graph_nodes, edges)
    write_test_impact(output_root, root_key, test_impact)
    return {"root": root_key, "nodes": graph_nodes, "edges": edges}


def crawl_issue_network_with_opener(
    root_input: str,
    output_root: Path,
    fetch_record,
    reference_depth: int = 2,
) -> dict:
    root_key = resolve_issue_key(root_input)
    if not root_key:
        raise ValueError("Could not resolve root issue key.")

    records: dict[str, IssueRecord] = {}
    depth_by_key = {root_key: 0}
    queue = [root_key]

    while queue:
        issue_key = queue.pop(0)
        if issue_key in records:
            continue

        record = fetch_record(issue_key)
        records[issue_key] = record

        current_depth = depth_by_key[issue_key]
        next_keys = set(record.subtask_keys) | set(record.jira_references)
        if record.parent_key:
            next_keys.add(record.parent_key)
        if current_depth >= reference_depth:
            continue
        for next_key in sorted(next_keys):
            if next_key in records or next_key in depth_by_key:
                continue
            depth_by_key[next_key] = current_depth + 1
            queue.append(next_key)

    return build_crawl_outputs(output_root, root_key, records)


def crawl_issue_network(root_input: str, output_root: Path, config: JiraProbeConfig) -> dict:
    opener, _, _ = create_authenticated_session(config)

    def live_fetch_record(issue_key: str) -> IssueRecord:
        return fetch_issue_record(opener, config, issue_key)

    return crawl_issue_network_with_opener(root_input, output_root, live_fetch_record, reference_depth=2)


def run_pipeline(
    output_root: Path,
    root_key: str,
    nodes: list[dict],
    edges: list[dict],
    write_cases: bool = False,
    case_output_root: Path | None = None,
    draft_reply: bool = False,
    base_url: str = "https://j1.private.easemob.com",
) -> dict:
    readiness = assess_case_readiness(nodes, edges, root_key)
    root_node = next(node for node in nodes if node["key"] == root_key)
    case_design_markdown = build_case_design_markdown(root_node, nodes, edges, readiness)
    write_case_design(output_root, root_key, case_design_markdown)
    reply_file = None
    if draft_reply:
        reply_markdown = build_reply_draft(root_node, nodes, edges, readiness)
        reply_state = build_reply_state(root_key, resolve_issue_url(base_url, root_key), reply_markdown)
        write_reply_artifacts(output_root, root_key, reply_markdown, reply_state)
        reply_file = output_root / "summary" / f"{root_key}-reply.md"

    if readiness["status"] == "not_ready":
        result = {
            "root": root_key,
            "status": "not_ready",
            "case_design_file": output_root / "summary" / f"{root_key}-case-design.md",
            "message": readiness["message"],
            "missing": readiness["missing"],
            "suggestions": readiness["suggestions"],
        }
        if reply_file:
            result["reply_file"] = reply_file
        return result

    result = {
        "root": root_key,
        "status": readiness["status"],
        "case_design_file": output_root / "summary" / f"{root_key}-case-design.md",
        "missing": readiness["missing"],
        "suggestions": readiness["suggestions"],
    }
    if reply_file:
        result["reply_file"] = reply_file

    if not write_cases:
        result["message"] = "已生成任务完整性总结和 Case 覆盖设计；请基于分析证据直接输出完整 Markdown 测试用例草稿供人工审核，无需用户提供任何本地目录。"
        return result

    if case_output_root is None:
        raise ValueError("--case-output-root is required when --write-cases is used.")

    if readiness["status"] == "partial":
        testcase_markdown = generate_partial_testcase_markdown(root_node, nodes, edges, readiness)
    else:
        testcase_markdown = generate_testcase_markdown(root_node, nodes, edges)
    write_testcases(case_output_root, root_key, testcase_markdown)
    result["testcase_file"] = case_output_root / "summary" / f"{root_key}-test-cases.md"
    return result


def run_live_pipeline(root_input: str, output_root: Path, config: JiraProbeConfig) -> dict:
    crawl_result = crawl_issue_network(root_input, output_root, config)
    pipeline_result = run_pipeline(output_root, crawl_result["root"], crawl_result["nodes"], crawl_result["edges"])
    return crawl_result | pipeline_result


def resolve_output_root(output_root_input: str = "", root_key: str = "") -> Path:
    explicit_output_root = output_root_input.strip() or os.getenv("EASEMOB_JIRA_OUTPUT_ROOT", "").strip()
    if explicit_output_root:
        return Path(explicit_output_root).expanduser()

    output_root = Path(tempfile.gettempdir()) / "qa-ai-tool" / "easemob-jira-testcase"
    if root_key:
        output_root = output_root / root_key
    return output_root


def resolve_case_output_root(case_output_root_input: str = "") -> Path:
    if not case_output_root_input.strip():
        raise ValueError("--case-output-root is required to write testcase files.")
    return Path(case_output_root_input).expanduser()


def add_analysis_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--root", dest="root_input", default="", help="Root Jira URL or key")
    parser.add_argument(
        "--mode",
        default="family-with-ghosts",
        choices=["family-only", "family-with-ghosts", "full-recursive"],
        help="Pipeline mode. Current implementation defaults to the family scoped workflow.",
    )
    parser.add_argument("--lang", default="zh-CN", help="Output language for testcase markdown.")
    parser.add_argument(
        "--dry-readiness",
        action="store_true",
        help="Only assess whether the Jira has enough information for testcase generation.",
    )
    parser.add_argument(
        "--output-root",
        default="",
        help="Temporary analysis directory for raw, graph, summary, reply, and case design files.",
    )
    parser.add_argument(
        "--write-cases",
        action="store_true",
        help="Write testcase files after the user confirms case output is needed.",
    )
    parser.add_argument(
        "--case-output-root",
        default="",
        help="Required with --write-cases. Directory for generated testcase files.",
    )
    parser.add_argument(
        "--draft-reply",
        action="store_true",
        help="Write a Jira reply draft and state file into the analysis summary directory.",
    )
    parser.add_argument(
        "--download-attachments",
        action="store_true",
        help="Download visual Jira attachments and write a multimodal LLM review prompt into the analysis summary directory.",
    )


def run_analysis_command(args: argparse.Namespace, config: JiraProbeConfig) -> int:
    root_input = args.root_input or config.check_issue_url or config.probe_url
    root_key_hint = extract_issue_key_from_url(root_input) or root_input.strip().upper()
    output_root = resolve_output_root(args.output_root, root_key_hint)
    crawl_result = crawl_issue_network(root_input, output_root, config)
    readiness = assess_case_readiness(crawl_result["nodes"], crawl_result["edges"], crawl_result["root"])
    if args.dry_readiness:
        print(f"Root issue: {crawl_result['root']}")
        print(f"Nodes: {len(crawl_result['nodes'])}")
        print(f"Edges: {len(crawl_result['edges'])}")
        print(f"Mode: {args.mode}")
        print(f"Language: {args.lang}")
        print(f"Readiness: {readiness['status']}")
        if readiness["status"] != "ready":
            print(readiness["message"])
            for item in readiness.get("missing", []):
                print(f"Missing: {item}")
            for item in readiness.get("suggestions", []):
                print(f"Suggestion: {item}")
        print(f"Output: {output_root}")
        return 0

    case_output_root = resolve_case_output_root(args.case_output_root) if args.write_cases else None
    result = crawl_result | run_pipeline(
        output_root,
        crawl_result["root"],
        crawl_result["nodes"],
        crawl_result["edges"],
        write_cases=args.write_cases,
        case_output_root=case_output_root,
        draft_reply=args.draft_reply,
        base_url=config.base_url,
    )
    visual_result = None
    if args.download_attachments:
        opener, _, _ = create_authenticated_session(config)
        visual_result = download_visual_attachment_artifacts(output_root, crawl_result["root"], crawl_result["nodes"], opener, timeout=config.timeout)
        result["visual_review_file"] = visual_result["prompt_file"]
        result["visual_attachment_count"] = len(visual_result["downloaded"])
    print(f"Root issue: {result['root']}")
    print(f"Nodes: {len(result['nodes'])}")
    print(f"Edges: {len(result['edges'])}")
    print(f"Mode: {args.mode}")
    print(f"Language: {args.lang}")
    print(f"Readiness: {result['status']}")
    print(f"Case design: {result['case_design_file']}")
    if result.get("reply_file"):
        print(f"Reply draft: {result['reply_file']}")
    if result.get("visual_review_file"):
        print(f"Visual review: {result['visual_review_file']}")
        print(f"Visual attachments: {result['visual_attachment_count']}")
    if result.get("testcase_file"):
        print(f"Testcases: {result['testcase_file']}")
    elif result["status"] in {"ready", "partial"}:
        print(result["message"])
    else:
        print(result["message"])
        for item in result.get("missing", []):
            print(f"Missing: {item}")
        for item in result.get("suggestions", []):
            print(f"Suggestion: {item}")
    print(f"Output: {output_root}")
    return 0


def run_reply_issue_command(args: argparse.Namespace, config: JiraProbeConfig) -> int:
    issue_key = args.issue.strip().upper()
    if not issue_key:
        raise ValueError("--issue is required for reply-issue.")
    page_dir = Path(args.page_dir).expanduser()
    if not page_dir.exists():
        raise FileNotFoundError(f"--page-dir does not exist: {page_dir}")
    opener, _, _ = create_authenticated_session(config)
    result = confirm_issue_reply(page_dir, issue_key, opener, config.base_url, timeout=config.timeout)
    print(f"Reply status: {result['status']}")
    if result.get("comment_id"):
        print(f"Comment id: {result['comment_id']}")
    if result.get("reason"):
        print(f"Reason: {result['reason']}")
    print(f"Output: {page_dir}")
    return 0


def run_attach_file_command(args: argparse.Namespace, config: JiraProbeConfig) -> int:
    issue_key = args.issue.strip().upper()
    if not issue_key:
        raise ValueError("--issue is required for attach-file.")
    file_path = Path(args.file).expanduser()
    if not file_path.exists():
        raise FileNotFoundError(f"--file does not exist: {file_path}")
    opener, _, _ = create_authenticated_session(config)

    boundary = "----FormBoundary7MA4YWxkTrZu0gW"
    file_data = file_path.read_bytes()
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{file_path.name}"\r\n'
        f"Content-Type: application/octet-stream\r\n\r\n"
    ).encode() + file_data + f"\r\n--{boundary}--\r\n".encode()

    import urllib.request
    url = f"{config.base_url}/rest/api/2/issue/{issue_key}/attachments"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "X-Atlassian-Token": "no-check",
        },
    )
    resp = opener.open(req, timeout=config.timeout)
    result = json.loads(resp.read().decode())
    attachment_id = result[0]["id"] if result else "unknown"
    filename = result[0].get("filename", file_path.name) if result else file_path.name
    content_url = result[0].get("content", "") if result else ""
    if not content_url:
        content_url = f"{config.base_url}/secure/attachment/{attachment_id}/{filename}"
    print(f"Attached: {filename}")
    print(f"ID: {attachment_id}")
    print(f"URL: {content_url}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Jira crawl and testcase pipeline.")
    subparsers = parser.add_subparsers(dest="command")
    reply_parser = subparsers.add_parser("reply-issue", help="Post a reviewed Jira reply draft as an issue comment.")
    reply_parser.add_argument("--issue", required=True, help="Jira issue key to comment on.")
    reply_parser.add_argument("--page-dir", required=True, help="Analysis output directory containing summary/<ISSUE>-reply.md.")
    attach_parser = subparsers.add_parser("attach-file", help="Upload a file as attachment to a Jira issue.")
    attach_parser.add_argument("--issue", required=True, help="Jira issue key.")
    attach_parser.add_argument("--file", required=True, help="Local file path to upload.")
    add_analysis_arguments(parser)
    args = parser.parse_args()

    config = load_config()
    if args.command == "reply-issue":
        return run_reply_issue_command(args, config)
    if args.command == "attach-file":
        return run_attach_file_command(args, config)
    return run_analysis_command(args, config)


if __name__ == "__main__":
    raise SystemExit(main())
