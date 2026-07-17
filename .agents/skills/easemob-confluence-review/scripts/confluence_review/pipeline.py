from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
from pathlib import Path
from urllib.parse import urljoin

from .analyze import build_analyze_url_result, build_page_summary_artifact, validate_analyze_url_input
from .checklist import build_review_checklist, persist_review_checklist_artifact
from .doc_type import classify_document_type, persist_doc_type_artifact, persist_page_summary_artifact
from .fetch import ConfluenceClient
from .performance import build_performance_analysis_from_buffers
from .reply import build_reply_state, confirm_reply as confirm_single_reply, persist_performance_analysis_artifacts, persist_reply_artifacts
from .shared import (
    CONFLUENCE_BASE_URL,
    default_target_date_text,
    ensure_dir,
    missing_fetch_credentials,
    sanitize_segment,
    resolve_confluence_credentials,
    write_json,
)
from .visual import persist_visual_review_package


def failure_payload(message: str, **extra) -> dict:
    return {"status": "failed", "message": message, "exit_code": 1, **extra}


def missing_env_vars_for_action(action: str, env: dict[str, str] | None = None) -> dict | None:
    if action in {"analyze-url", "analyze-urls"}:
        missing = missing_fetch_credentials(env)
        return {"stage": "获取", "missing": missing} if missing else None
    if action == "reply-page":
        missing = missing_fetch_credentials(env)
        return {"stage": "回复", "missing": missing} if missing else None
    return None


def resolve_output_root(output: str | None = None, env: dict[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    explicit = str(output or source.get("OUTPUT_DIR", "")).strip()
    if explicit:
        return str(Path(explicit).resolve())
    return str(Path(tempfile.gettempdir()) / "qa-ai-tool" / "easemob-confluence-review")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="easemob-confluence-review")
    subparsers = parser.add_subparsers(dest="action")
    analyze = subparsers.add_parser("analyze-url")
    analyze.add_argument("--url")
    analyze.add_argument("--output")
    analyze.add_argument("--confirm-reply", action="store_true", dest="confirm_reply")
    analyze_many = subparsers.add_parser("analyze-urls")
    analyze_many.add_argument("--url", action="append", dest="urls", default=[])
    reply_page = subparsers.add_parser("reply-page")
    reply_page.add_argument("--page-dir")
    subparsers.add_parser("test")
    return parser.parse_args(argv)


def _resolve_page_dir(output_root: str, updated_at: str, title: str, page_id: str) -> Path:
    date_text = updated_at[:10] if updated_at else default_target_date_text()
    return Path(output_root) / date_text / f"{sanitize_segment(title)}__{page_id}"


def _client_from_env(source_env: dict[str, str]) -> ConfluenceClient:
    credentials = resolve_confluence_credentials(source_env)
    if credentials is None:
        raise RuntimeError("Confluence 凭证不可用")
    return ConfluenceClient(
        CONFLUENCE_BASE_URL,
        credentials["basic_user"],
        credentials["basic_pass"],
        credentials["app_user"],
        credentials["app_pass"],
    )


def _qa_context(page_dir: Path, payload: dict) -> dict:
    checklist = payload.get("review_checklist") or {}
    readiness = checklist.get("ready_for_next_stage") if isinstance(checklist, dict) else None
    return {
        "schema_version": 1,
        "read_status": "read",
        "source": {
            "url": payload.get("url"),
            "title": payload.get("title"),
            "updated_at": payload.get("updated_at"),
            "doc_type": payload.get("doc_type"),
        },
        "artifacts": {
            "page_dir": str(page_dir),
            "content_file": str(page_dir / "index.md"),
            "summary_file": str(page_dir / "summary.md"),
            "checklist_file": str(page_dir / "review-checklist.json"),
        },
        "document_summary": payload.get("document_summary"),
        "qa_readiness": readiness,
        "gaps": payload.get("gaps") or [],
        "suggestions": payload.get("suggestions") or [],
        "usage": "Jira testcase generation must read content_file as source evidence. Do not infer API paths, fields, permissions, or assertions that are absent from the source.",
    }


def _persist_qa_context(page_dir: Path, payload: dict) -> dict:
    context = _qa_context(page_dir, payload)
    context_path = page_dir / "qa-context.json"
    write_json(context_path, context)
    return {"file": str(context_path), **context}


def analyze_url(url: str | None, output: str | None = None, confirm_reply: bool = False, env: dict[str, str] | None = None) -> dict:
    source_env = os.environ if env is None else env
    if not url:
        return failure_payload("--url is required")
    try:
        missing = missing_env_vars_for_action("analyze-url", source_env)
        if missing:
            return failure_payload(f"{missing['stage']}阶段缺少系统环境变量", blocked_stage="fetch", missing_env=missing)
        parsed = validate_analyze_url_input(url)
        page_id, normalized_url = parsed["pageId"], parsed["normalizedUrl"]
        output_root = resolve_output_root(output, source_env)
        client = _client_from_env(source_env)
        client.login()
        page = client.fetch_page(page_id)
        attachments = client.iter_attachments(page_id)
        image_attachments = [item for item in attachments if str((item.get("metadata") or {}).get("mediaType") or "").startswith("image/")]
        images, image_links = [], []
        for attachment in image_attachments:
            download_url = (attachment.get("_links") or {}).get("download")
            if not download_url:
                continue
            title = attachment.get("title") or f"截图{len(image_links) + 1}"
            image_links.append({"title": title, "url": urljoin(CONFLUENCE_BASE_URL, download_url)})
            try:
                images.append({"name": title, "buffer": client.download(download_url)})
            except Exception:
                pass
        body = ((page.get("body") or {}).get("storage") or {}).get("value") or ""
        markdown = "\n".join([f"# {page.get('title')}", "", f"- Source: [{normalized_url}]({normalized_url})", "", body])
        doc_type = classify_document_type(page.get("title") or "", body, markdown, [item.get("title", "") for item in image_attachments])
        performance_analysis = build_performance_analysis_from_buffers(page.get("title") or "", images, body) if doc_type["type"] == "pressure-benchmark-review" else None
        review_checklist = build_review_checklist(page.get("title") or "", markdown, doc_type)
        payload = build_analyze_url_result(normalized_url, page.get("title") or "", (page.get("version") or {}).get("when") or "", markdown, performance_analysis, image_links, doc_type, [item.get("title", "") for item in image_attachments], review_checklist)
        page_dir = _resolve_page_dir(output_root, (page.get("version") or {}).get("when") or "", page.get("title") or "", page_id)
        ensure_dir(page_dir)
        (page_dir / "index.md").write_text(markdown.strip() + "\n", encoding="utf-8")
        visual_images = []
        if images:
            assets_dir = page_dir / "assets"
            ensure_dir(assets_dir)
            for image in images:
                local_path = assets_dir / sanitize_segment(image["name"])
                local_path.write_bytes(image["buffer"])
                source = next((item for item in image_links if item.get("title") == image["name"]), {})
                visual_images.append({"title": image["name"], "url": source.get("url", ""), "local_path": str(local_path)})
        visual_review = persist_visual_review_package(page_dir, page.get("title") or "", normalized_url, visual_images)
        persist_doc_type_artifact(page_dir, payload["doc_type"])
        if payload["doc_type"]["type"] != "skip-weekly-report":
            persist_review_checklist_artifact(page_dir, payload["review_checklist"])
            persist_page_summary_artifact(page_dir, build_page_summary_artifact(page.get("title") or "", normalized_url, payload["doc_type"], payload["document_summary"]))
            if payload["doc_type"]["type"] == "pressure-benchmark-review" and payload.get("performance_analysis"):
                persist_performance_analysis_artifacts(page_dir, payload["performance_analysis"], payload["document_summary"], page.get("title") or "", normalized_url)
            persist_reply_artifacts(page_dir, payload["reply_draft"], build_reply_state(page_id, normalized_url, payload["reply_draft"]))
        qa_context = _persist_qa_context(page_dir, payload)
        reply = {"status": "skipped" if payload["doc_type"]["type"] == "skip-weekly-report" else "drafted", "page_dir": str(page_dir), "message": payload["reply_suggestion"]["message"]}
        if confirm_reply:
            reply = {"page_dir": str(page_dir), "status": "skipped", "reason": "weekly report does not require reply"} if payload["doc_type"]["type"] == "skip-weekly-report" else {"page_dir": str(page_dir), **confirm_single_reply(page_dir, client)}
        return {"status": "ok", "exit_code": 0, **payload, **visual_review, "qa_context": qa_context, "reply": reply}
    except Exception as exc:
        return failure_payload(str(exc), blocked_stage="analyze-url")


def analyze_urls(urls: list[str], output: str | None = None, env: dict[str, str] | None = None) -> dict:
    normalized_urls = list(dict.fromkeys(url.strip() for url in urls if url and url.strip()))
    if not normalized_urls:
        return failure_payload("至少提供一个 --url")
    source_env = os.environ if env is None else env
    results = [analyze_url(url, output=output, env=source_env) for url in normalized_urls]
    pages = []
    for url, result in zip(normalized_urls, results):
        if result.get("status") == "ok":
            pages.append({"url": url, "read_status": "read", "qa_context": result.get("qa_context")})
        else:
            pages.append({
                "url": url,
                "read_status": "not_read",
                "reason": result.get("message", "Confluence 读取失败"),
                "blocked_stage": result.get("blocked_stage"),
                "missing_env": result.get("missing_env"),
            })
    read_count = sum(page["read_status"] == "read" for page in pages)
    status = "ok" if read_count == len(pages) else "partial" if read_count else "failed"
    payload = {
        "status": status,
        "exit_code": 0 if read_count else 1,
        "pages": pages,
        "summary": {"total": len(pages), "read": read_count, "not_read": len(pages) - read_count},
    }
    output_root = Path(resolve_output_root(output, source_env))
    batch_id = hashlib.sha256("\n".join(normalized_urls).encode("utf-8")).hexdigest()[:16]
    context_path = output_root / "batches" / batch_id / "jira-context.json"
    write_json(context_path, payload)
    return {**payload, "jira_context_file": str(context_path)}


def reply_page(page_dir: str | None, env: dict[str, str] | None = None) -> dict:
    source_env = os.environ if env is None else env
    if not page_dir:
        return failure_payload("--page-dir is required")
    try:
        missing = missing_env_vars_for_action("reply-page", source_env)
        if missing:
            return failure_payload(f"{missing['stage']}阶段缺少系统环境变量", blocked_stage="reply", missing_env=missing)
        path = Path(page_dir)
        if not path.exists():
            return failure_payload(f"--page-dir does not exist: {path}", blocked_stage="reply")
        client = _client_from_env(source_env)
        client.login()
        return {"status": "ok", "exit_code": 0, "reply": {"page_dir": str(path), **confirm_single_reply(path, client)}}
    except Exception as exc:
        return failure_payload(str(exc), blocked_stage="reply-page")


def dispatch(argv: list[str], env: dict[str, str] | None = None) -> dict:
    args = parse_args(argv)
    if args.action == "analyze-url":
        return analyze_url(args.url, args.output, args.confirm_reply, env)
    if args.action == "analyze-urls":
        return analyze_urls(args.urls, env=env)
    if args.action == "reply-page":
        return reply_page(args.page_dir, env)
    if args.action == "test":
        return {"status": "failed", "message": "Use scripts/run.sh test to run pytest.", "exit_code": 1}
    return failure_payload("Supported actions: analyze-url, analyze-urls, reply-page")


def main(argv: list[str] | None = None) -> int:
    import sys

    payload = dispatch(sys.argv[1:] if argv is None else argv)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return int(payload.get("exit_code", 0))
