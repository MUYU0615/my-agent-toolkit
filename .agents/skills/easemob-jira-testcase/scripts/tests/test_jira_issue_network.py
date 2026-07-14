import json
import os
import shutil
import tempfile as tempfile_module
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jira_issue_network import (
    IssueRecord,
    assess_case_readiness,
    build_case_design_markdown,
    build_reply_draft,
    build_reply_state,
    build_summary_markdown,
    build_test_impact_markdown,
    confirm_issue_reply,
    crawl_issue_network_with_opener,
    build_edges,
    download_visual_attachment_artifacts,
    generate_testcase_markdown,
    determine_family_keys,
    extend_with_ghost_nodes,
    extract_external_documents_from_text,
    extract_jira_references_from_text,
    extract_issue_keys_from_text,
    format_api_endpoint_for_jira_comment,
    normalize_api_endpoint_wrapping,
    prepare_jira_reply_content,
    run_pipeline,
    render_graphviz,
    render_mermaid,
    parse_comment_references,
    parse_issue_record_from_rest,
    parse_issue_record,
    parse_issue_family,
    read_external_documents,
    resolve_output_root,
    resolve_case_output_root,
    write_graph_outputs,
    write_reply_artifacts,
)


class IssueKeyExtractionTests(unittest.TestCase):
    def test_extracts_issue_keys_from_free_text(self) -> None:
        text = "Depends on HIM-100 and relinks to ABC_2-3 and HIM-100 again"
        self.assertEqual(
            extract_issue_keys_from_text(text),
            {"HIM-100", "ABC_2-3"},
        )

    def test_extracts_jira_references_from_urls_and_keys(self) -> None:
        text = "测试任务指向 https://j1.private.easemob.com/browse/HIM-21413 和普通文本 HIM-22130"

        self.assertEqual(extract_jira_references_from_text(text, current_key="HIM-22130"), {"HIM-21413"})


class ExternalDocumentExtractionTests(unittest.TestCase):
    def test_extracts_feishu_wiki_links_from_text(self) -> None:
        text = "设计见 https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd ，补充说明在评论里。"

        documents = extract_external_documents_from_text(text)

        self.assertEqual(
            documents,
            [
                {
                    "type": "feishu-wiki",
                    "url": "https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd",
                    "read_status": "not_read",
                    "reason": "Feishu document has not been read yet.",
                }
            ],
        )

    def test_extracts_confluence_links_with_skill_guidance(self) -> None:
        text = "评审材料见 https://c1.private.easemob.com/pages/viewpage.action?pageId=123456"

        documents = extract_external_documents_from_text(text)

        self.assertEqual(documents[0]["type"], "easemob-confluence")
        self.assertEqual(documents[0]["read_status"], "not_read")
        self.assertIn("easemob-confluence-review", documents[0]["reason"])

    def test_reads_feishu_document_content_with_lark_cli_runner(self) -> None:
        documents = extract_external_documents_from_text("设计见 https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd")

        def runner(command: list[str]) -> object:
            self.assertEqual(command[0:4], ["lark-cli", "docs", "+fetch", "--api-version"])
            return type(
                "Result",
                (),
                {
                    "returncode": 0,
                    "stdout": json.dumps(
                        {
                            "ok": True,
                            "data": {
                                "document": {
                                    "document_id": "doc-1",
                                    "revision_id": 7,
                                    "content": "# 设计\n支持订阅和取消订阅",
                                }
                            },
                        },
                        ensure_ascii=False,
                    ),
                    "stderr": "",
                },
            )()

        enriched = read_external_documents(documents, runner=runner)

        self.assertEqual(enriched[0]["read_status"], "read")
        self.assertEqual(enriched[0]["document_id"], "doc-1")
        self.assertIn("支持订阅和取消订阅", enriched[0]["content"])

    def test_keeps_feishu_document_not_read_when_lark_cli_fails(self) -> None:
        documents = extract_external_documents_from_text("设计见 https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd")

        def runner(command: list[str]) -> object:
            return type("Result", (), {"returncode": 1, "stdout": "", "stderr": "permission denied"})()

        enriched = read_external_documents(documents, runner=runner)

        self.assertEqual(enriched[0]["read_status"], "not_read")
        self.assertIn("permission denied", enriched[0]["reason"])


class FamilyParsingTests(unittest.TestCase):
    def test_parses_parent_and_subtasks_from_html_sections(self) -> None:
        html = """
        <div id="parentmodule"><a href="/browse/HIM-2">HIM-2</a></div>
        <div id="issuetable"><a href="/browse/HIM-3">HIM-3</a><a href="/browse/HIM-4">HIM-4</a></div>
        """

        parsed = parse_issue_family("HIM-1", html)

        self.assertEqual(parsed["parent"], "HIM-2")
        self.assertEqual(parsed["subtasks"], {"HIM-3", "HIM-4"})


class CommentReferenceParsingTests(unittest.TestCase):
    def test_parses_comment_references_only(self) -> None:
        html = """
        <div id="description-val">Description mentions HIM-6</div>
        <div class="action-body flooded">Comment mentions HIM-5 and HIM-1</div>
        """

        parsed = parse_comment_references("HIM-1", html)

        self.assertEqual(parsed, {"HIM-5"})


class IssueRecordParsingTests(unittest.TestCase):
    def test_parse_issue_record_includes_external_documents_from_description_and_comments(self) -> None:
        html = """
        <title>HIM-1 需求</title>
        <div id="description-val">设计见 https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd</div>
        <div class="action-body flooded">评审补充 https://example.feishu.cn/docx/AbCdEf123</div>
        """

        record = parse_issue_record("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", html)

        self.assertEqual(len(record.external_documents), 2)
        self.assertEqual(record.external_documents[0]["type"], "feishu-wiki")
        self.assertEqual(record.external_documents[1]["type"], "feishu-doc")
        self.assertEqual(record.to_node()["external_documents"], record.external_documents)

    def test_parse_issue_record_includes_external_documents_from_full_page_links(self) -> None:
        html = """
        <title>HIM-1 需求</title>
        <div id="description-val">Click to add description</div>
        <a href="https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd">设计文档</a>
        """

        record = parse_issue_record("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", html)

        self.assertEqual(len(record.external_documents), 1)
        self.assertEqual(record.external_documents[0]["type"], "feishu-wiki")

    def test_parse_issue_record_from_rest_includes_links_family_comments_and_attachments(self) -> None:
        payload = {
            "key": "HIM-22312",
            "fields": {
                "summary": "提示优化",
                "status": {"name": "To Do"},
                "description": "https://j1.private.easemob.com/browse/HIM-22256",
                "comment": {"comments": [{"body": "补充见 HIM-22257"}]},
                "parent": {"key": "HIM-22000"},
                "subtasks": [{"key": "HIM-22313"}],
                "attachment": [
                    {
                        "id": "72761",
                        "filename": "截图0612-1.png",
                        "mimeType": "image/png",
                        "content": "http://j1.private.easemob.com/secure/attachment/72761/file.png",
                    }
                ],
            },
        }

        record = parse_issue_record_from_rest("HIM-22312", "https://j1.private.easemob.com/browse/HIM-22312", payload)

        self.assertEqual(record.title, "提示优化")
        self.assertEqual(record.status, "To Do")
        self.assertEqual(record.parent_key, "HIM-22000")
        self.assertEqual(record.subtask_keys, {"HIM-22313"})
        self.assertEqual(record.comment_references, {"HIM-22257"})
        self.assertEqual(record.jira_references, {"HIM-22256", "HIM-22257", "HIM-22000", "HIM-22313"})
        self.assertEqual(record.attachments[0]["filename"], "截图0612-1.png")
        self.assertEqual(record.to_node()["attachments"][0]["mime_type"], "image/png")


class FamilyTraversalTests(unittest.TestCase):
    def test_builds_parent_and_sibling_scope(self) -> None:
        records = {
            "HIM-1": IssueRecord(
                key="HIM-1",
                url="",
                title="",
                status="",
                description_text="",
                comments=[],
                parent_key="HIM-9",
                subtask_keys=set(),
                comment_references={"HIM-20"},
            ),
            "HIM-9": IssueRecord(
                key="HIM-9",
                url="",
                title="",
                status="",
                description_text="",
                comments=[],
                parent_key=None,
                subtask_keys={"HIM-1", "HIM-2", "HIM-3"},
                comment_references=set(),
            ),
        }

        keys = determine_family_keys("HIM-1", records)

        self.assertEqual(keys, {"HIM-9", "HIM-1", "HIM-2", "HIM-3"})


class CrawlTraversalTests(unittest.TestCase):
    def test_crawls_jira_references_two_levels_deep(self) -> None:
        html_by_key = {
            "HIM-22130": """
            <title>HIM-22130 测试任务</title>
            <div id="description-val">https://j1.private.easemob.com/browse/HIM-21413</div>
            """,
            "HIM-21413": """
            <title>HIM-21413 开发任务</title>
            <div id="description-val">设计见 https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd</div>
            """,
        }

        def fetch_record(issue_key: str) -> IssueRecord:
            return parse_issue_record(
                issue_key,
                f"https://j1.private.easemob.com/browse/{issue_key}",
                html_by_key[issue_key],
            )

        with tempfile.TemporaryDirectory() as tmpdir:
            result = crawl_issue_network_with_opener("HIM-22130", Path(tmpdir), fetch_record, reference_depth=2)

        self.assertEqual({node["key"] for node in result["nodes"] if not node.get("is_ghost")}, {"HIM-22130", "HIM-21413"})
        self.assertIn(
            ("HIM-22130", "HIM-21413", "jira_reference"),
            {(edge["from_key"], edge["to_key"], edge["type"]) for edge in result["edges"]},
        )
        referenced = next(node for node in result["nodes"] if node["key"] == "HIM-21413")
        self.assertEqual(referenced["external_documents"][0]["type"], "feishu-wiki")


class ReadinessAttachmentTests(unittest.TestCase):
    def test_image_attachment_counts_as_context_for_partial_readiness(self) -> None:
        nodes = [
            {
                "key": "HIM-22312",
                "title": "提示优化",
                "description_text": "https://j1.private.easemob.com/browse/HIM-22256",
                "comments": [],
                "external_documents": [],
                "attachments": [],
            },
            {
                "key": "HIM-22256",
                "title": "[前端]提醒优化",
                "description_text": "",
                "comments": [],
                "external_documents": [],
                "attachments": [{"filename": "截图0612-1.png", "mime_type": "image/png"}],
            },
        ]
        edges = [{"from_key": "HIM-22312", "to_key": "HIM-22256", "type": "jira_reference", "source": "page_link"}]

        readiness = assess_case_readiness(nodes, edges, "HIM-22312")

        self.assertEqual(readiness["status"], "partial")
        self.assertNotIn("根 Jira 和关联 Jira 均缺少需求描述、评论补充或外部设计文档", readiness["missing"])


class VisualAttachmentArtifactTests(unittest.TestCase):
    def test_downloads_image_attachments_and_writes_visual_review_prompt(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

            def read(self) -> bytes:
                return b"png-bytes"

        class FakeOpener:
            def __init__(self) -> None:
                self.urls = []

            def open(self, request, timeout=20):
                self.urls.append(request.full_url)
                return FakeResponse()

        nodes = [
            {
                "key": "HIM-22256",
                "attachments": [
                    {
                        "filename": "截图0612-1.png",
                        "mime_type": "image/png",
                        "content_url": "http://j1.private.easemob.com/secure/attachment/72761/file.png",
                    },
                    {
                        "filename": "notes.txt",
                        "mime_type": "text/plain",
                        "content_url": "http://j1.private.easemob.com/secure/attachment/72762/notes.txt",
                    },
                ],
            }
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            result = download_visual_attachment_artifacts(Path(tmpdir), "HIM-22312", nodes, FakeOpener())

            self.assertEqual(len(result["downloaded"]), 1)
            image_path = Path(result["downloaded"][0]["local_path"])
            self.assertEqual(image_path.read_bytes(), b"png-bytes")
            prompt = Path(result["prompt_file"]).read_text(encoding="utf-8")

        self.assertIn("HIM-22256", prompt)
        self.assertIn("截图0612-1.png", prompt)
        self.assertIn("页面模块", prompt)
        self.assertIn("可见提示文案", prompt)


class EdgeBuilderTests(unittest.TestCase):
    def test_builds_parent_subtask_and_comment_edges_without_expansion(self) -> None:
        record = IssueRecord(
            key="HIM-1",
            url="",
            title="",
            status="",
            description_text="",
            comments=[],
            parent_key="HIM-9",
            subtask_keys={"HIM-2", "HIM-3"},
            comment_references={"HIM-20"},
        )

        edges = build_edges(record)

        self.assertEqual(
            {(edge["to_key"], edge["type"]) for edge in edges},
            {
                ("HIM-9", "parent"),
                ("HIM-2", "subtask"),
                ("HIM-3", "subtask"),
                ("HIM-20", "comment_reference"),
            },
        )


class GhostNodeTests(unittest.TestCase):
    def test_adds_ghost_nodes_for_unfetched_comment_targets(self) -> None:
        nodes = [
            {"key": "HIM-1", "title": "Root", "status": "Open"},
            {"key": "HIM-2", "title": "Child", "status": "Open"},
        ]
        edges = [
            {"from_key": "HIM-1", "to_key": "HIM-2", "type": "subtask", "source": "issuetable"},
            {"from_key": "HIM-1", "to_key": "HIM-20", "type": "comment_reference", "source": "comment"},
        ]

        extended = extend_with_ghost_nodes(nodes, edges)

        self.assertEqual({node["key"] for node in extended}, {"HIM-1", "HIM-2", "HIM-20"})
        ghost = next(node for node in extended if node["key"] == "HIM-20")
        self.assertTrue(ghost["is_ghost"])


class OutputWriterTests(unittest.TestCase):
    def test_writes_graph_outputs(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            write_graph_outputs(
                output_root,
                root_key="HIM-1",
                nodes=[{"key": "HIM-1"}],
                edges=[{"from_key": "HIM-1", "to_key": "HIM-2", "type": "issue_link"}],
            )

            self.assertTrue((output_root / "graph" / "nodes.json").exists())
            self.assertTrue((output_root / "graph" / "edges.json").exists())
            self.assertTrue((output_root / "graph" / "graph.json").exists())

            graph = json.loads((output_root / "graph" / "graph.json").read_text(encoding="utf-8"))
            self.assertEqual(graph["root"], "HIM-1")


class SummaryTests(unittest.TestCase):
    def test_builds_summary_markdown(self) -> None:
        summary = build_summary_markdown(
            root_node={"key": "HIM-1", "title": "Root title", "status": "Open"},
            nodes=[{"key": "HIM-1"}, {"key": "HIM-2"}],
            edges=[{"from_key": "HIM-1", "to_key": "HIM-2", "type": "issue_link"}],
        )

        self.assertIn("Root title", summary)
        self.assertIn("Total issues: 2", summary)

    def test_builds_test_impact_markdown(self) -> None:
        impact = build_test_impact_markdown(
            root_node={"key": "HIM-1", "title": "Root title"},
            nodes=[
                {"key": "HIM-1", "title": "Root title"},
                {"key": "HIM-2", "title": "Child", "is_ghost": False},
                {"key": "HIM-20", "title": "", "is_ghost": True},
            ],
            edges=[
                {"from_key": "HIM-1", "to_key": "HIM-2", "type": "subtask", "source": "issuetable"},
                {"from_key": "HIM-1", "to_key": "HIM-20", "type": "comment_reference", "source": "comment"},
            ],
        )

        self.assertIn("Root title", impact)
        self.assertIn("Comment References", impact)
        self.assertIn("HIM-20", impact)


class GraphRenderTests(unittest.TestCase):
    def test_renders_mermaid_and_graphviz(self) -> None:
        nodes = [
            {"key": "HIM-1", "title": "Root", "is_ghost": False},
            {"key": "HIM-20", "title": "", "is_ghost": True},
        ]
        edges = [
            {"from_key": "HIM-1", "to_key": "HIM-20", "type": "comment_reference", "source": "comment"},
        ]

        mermaid = render_mermaid(nodes, edges)
        dot = render_graphviz(nodes, edges)

        self.assertIn("flowchart TD", mermaid)
        self.assertIn("HIM_1", mermaid)
        self.assertIn("digraph JiraIssueNetwork", dot)
        self.assertIn('HIM_20', dot)


class TestcaseGenerationTests(unittest.TestCase):
    def test_generates_chinese_testcase_markdown(self) -> None:
        content = generate_testcase_markdown(
            root_node={"key": "HIM-1", "title": "根需求"},
            nodes=[
                {"key": "HIM-1", "title": "根需求"},
                {"key": "HIM-2", "title": "子任务", "is_ghost": False},
                {"key": "HIM-20", "title": "", "is_ghost": True},
            ],
            edges=[
                {"from_key": "HIM-1", "to_key": "HIM-2", "type": "subtask", "source": "issuetable"},
                {"from_key": "HIM-1", "to_key": "HIM-20", "type": "comment_reference", "source": "comment"},
            ],
        )

        self.assertIn("测试用例草案", content)
        self.assertIn("根需求", content)
        self.assertIn("HIM-20", content)
        self.assertIn("测试用例编写颗粒度要求", content)
        self.assertIn("前置资源/测试数据", content)
        self.assertIn("entities[0].uuid", content)
        self.assertIn("预期结果/断言点", content)
        self.assertIn("不能只写", content)

    def test_builds_case_design_markdown_before_case_output(self) -> None:
        readiness = {
            "status": "partial",
            "reason": "limited Jira context with identifiable topic",
            "missing": ["缺少足够业务上下文"],
            "suggestions": ["确认本次具体改动点、验收标准和明确不测范围。"],
            "message": "当前 Jira 信息不足，但标题可识别功能方向。",
        }

        content = build_case_design_markdown(
            root_node={
                "key": "HIM-1",
                "title": "优化会话列表未读数展示",
                "external_documents": [
                    {
                        "type": "feishu-wiki",
                        "url": "https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd",
                        "read_status": "read",
                        "reason": "Read by lark-cli docs +fetch.",
                        "content": "# 设计\n支持订阅套餐和取消订阅套餐",
                    }
                ],
            },
            nodes=[
                {
                    "key": "HIM-1",
                    "title": "优化会话列表未读数展示",
                    "external_documents": [
                        {
                            "type": "feishu-wiki",
                            "url": "https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd",
                            "read_status": "read",
                            "reason": "Read by lark-cli docs +fetch.",
                            "content": "# 设计\n支持订阅套餐和取消订阅套餐",
                        }
                    ],
                }
            ],
            edges=[],
            readiness=readiness,
        )

        self.assertIn("任务完整性总结", content)
        self.assertIn("Case 覆盖设计", content)
        self.assertIn("外部设计文档", content)
        self.assertIn("读取状态：read", content)
        self.assertIn("https://my.feishu.cn/wiki/RKsbwgOyLiExs1kiadec889xnGd", content)
        self.assertIn("支持订阅套餐和取消订阅套餐", content)
        self.assertIn("对话式测试用例草稿", content)
        self.assertIn("直接输出完整 Markdown", content)
        self.assertNotIn("请提供输出路径", content)


class PipelineTests(unittest.TestCase):
    def test_run_pipeline_writes_case_design_without_testcase_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            graph_dir = output_root / "graph"
            summary_dir = output_root / "summary"
            graph_dir.mkdir(parents=True, exist_ok=True)
            summary_dir.mkdir(parents=True, exist_ok=True)

            nodes = [
                {"key": "HIM-1", "title": "根需求", "description_text": "包含明确业务流程和状态处理"},
                {"key": "HIM-2", "title": "子任务", "description_text": "", "is_ghost": False},
            ]
            edges = [
                {"from_key": "HIM-1", "to_key": "HIM-2", "type": "subtask", "source": "issuetable"},
            ]
            (graph_dir / "nodes.json").write_text(json.dumps(nodes, ensure_ascii=False), encoding="utf-8")
            (graph_dir / "edges.json").write_text(json.dumps(edges, ensure_ascii=False), encoding="utf-8")
            (summary_dir / "HIM-1-test-impact.md").write_text("impact", encoding="utf-8")

            result = run_pipeline(output_root=output_root, root_key="HIM-1", nodes=nodes, edges=edges)

            self.assertEqual(result["root"], "HIM-1")
            self.assertEqual(result["status"], "ready")
            self.assertTrue((summary_dir / "HIM-1-case-design.md").exists())
            self.assertFalse((summary_dir / "HIM-1-test-cases.md").exists())
            self.assertIn("直接输出完整 Markdown", result["message"])
            self.assertNotIn("输出路径", result["message"])

    def test_run_pipeline_writes_testcases_only_when_case_output_root_is_provided(self) -> None:
        with tempfile.TemporaryDirectory() as analysis_tmpdir, tempfile.TemporaryDirectory() as case_tmpdir:
            output_root = Path(analysis_tmpdir)
            case_output_root = Path(case_tmpdir)
            nodes = [
                {"key": "HIM-1", "title": "根需求", "description_text": "包含明确业务流程和状态处理"},
                {"key": "HIM-2", "title": "子任务", "description_text": "", "is_ghost": False},
            ]
            edges = [
                {"from_key": "HIM-1", "to_key": "HIM-2", "type": "subtask", "source": "issuetable"},
            ]

            result = run_pipeline(
                output_root=output_root,
                root_key="HIM-1",
                nodes=nodes,
                edges=edges,
                write_cases=True,
                case_output_root=case_output_root,
            )

            self.assertEqual(result["status"], "ready")
            self.assertTrue((output_root / "summary" / "HIM-1-case-design.md").exists())
            self.assertTrue((case_output_root / "summary" / "HIM-1-test-cases.md").exists())
            self.assertFalse((output_root / "summary" / "HIM-1-test-cases.md").exists())

    def test_run_pipeline_returns_not_ready_without_writing_cases(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            nodes = [
                {"key": "HIM-1", "title": "", "description_text": "", "comments": []},
            ]
            edges = []

            result = run_pipeline(output_root=output_root, root_key="HIM-1", nodes=nodes, edges=edges)

            self.assertEqual(result["status"], "not_ready")
            self.assertFalse((output_root / "summary" / "HIM-1-test-cases.md").exists())

    def test_run_pipeline_writes_partial_case_design_for_title_only_issue(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            nodes = [
                {"key": "HIM-1", "title": "优化会话列表未读数展示", "description_text": "", "comments": []},
            ]
            edges = []

            result = run_pipeline(output_root=output_root, root_key="HIM-1", nodes=nodes, edges=edges)

            case_design_file = output_root / "summary" / "HIM-1-case-design.md"
            self.assertEqual(result["status"], "partial")
            self.assertTrue(case_design_file.exists())
            self.assertFalse((output_root / "summary" / "HIM-1-test-cases.md").exists())
            content = case_design_file.read_text(encoding="utf-8")
            self.assertIn("信息完整度", content)
            self.assertIn("状态：partial", content)
            self.assertIn("Case 覆盖设计", content)
            self.assertIn("对话式测试用例草稿", content)
            self.assertIn("直接输出完整 Markdown", content)
            self.assertNotIn("请提供输出路径", content)


class ReplyDraftTests(unittest.TestCase):
    def test_normalizes_wrapped_api_endpoint_in_reply_text(self) -> None:
        reply = "\n".join(
            [
                "请补充以下接口验收标准：",
                "POST /api/sdk/v1/{org}",
                "  /",
                "",
                "  {app}/speech/transcriptions",
                "- 其他字段说明",
            ]
        )

        normalized = normalize_api_endpoint_wrapping(reply)

        self.assertIn("POST /api/sdk/v1/{org}/{app}/speech/transcriptions", normalized)
        self.assertNotIn("POST /api/sdk/v1/{org}\n  /", normalized)

    def test_normalizes_wrapped_api_endpoint_inside_inline_code(self) -> None:
        reply = "\n".join(
            [
                "5. 被禁言成员返回 `mute_expiration`",
                "- 前置：member 加入群后，调用 `POST /{org}",
                "/",
                "",
                "{app}/chatgroups/{group_id}/mute` 禁言该 member。",
            ]
        )

        normalized = normalize_api_endpoint_wrapping(reply)

        self.assertIn("`POST /{org}/{app}/chatgroups/{group_id}/mute`", normalized)
        self.assertNotIn("POST /{org}\n/\n\n{app}", normalized)

    def test_formats_inline_api_endpoint_as_noformat_for_jira_comment(self) -> None:
        reply = "- 前置：member 加入群后，调用 `POST /{org}/{app}/chatgroups/{group_id}/mute` 禁言该 member。"

        formatted = format_api_endpoint_for_jira_comment(reply)

        self.assertIn("{noformat}POST /{org}/{app}/chatgroups/{group_id}/mute{noformat}", formatted)
        self.assertNotIn("`POST /{org}/{app}/chatgroups/{group_id}/mute`", formatted)

    def test_prepare_jira_reply_formats_json_and_inline_code(self) -> None:
        reply = "\n".join(
            [
                "- 实际：HTTP 400，响应为：",
                '  `{"duration":0,"error":"illegal_param","error_code":5,"error_description":"不得为空白"}`',
                "- 差异：实际返回 `error_code=5`，不是预期的 `1601`。",
            ]
        )

        formatted = prepare_jira_reply_content(reply)

        self.assertIn("{code}", formatted)
        self.assertNotIn("{code:json}", formatted)
        self.assertIn('"error_code": 5', formatted)
        self.assertIn('"error_description": "不得为空白"', formatted)
        self.assertIn("{{error_code=5}}", formatted)
        self.assertIn("{{1601}}", formatted)
        self.assertNotIn("`error_code=5`", formatted)
        self.assertNotIn('`{"duration"', formatted)

    def test_write_reply_artifacts_normalizes_wrapped_api_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            reply = "POST /api/sdk/v1/{org}\n  /\n\n  {app}/speech/transcriptions"
            state = build_reply_state("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", reply)

            write_reply_artifacts(output_root, "HIM-1", reply, state)

            content = (output_root / "summary" / "HIM-1-reply.md").read_text(encoding="utf-8")
            self.assertEqual(content, "POST /api/sdk/v1/{org}/{app}/speech/transcriptions")

    def test_builds_not_testable_reply_for_empty_root_and_linked_issue_context(self) -> None:
        root_node = {
            "key": "HIM-22206",
            "title": "[HIM-22206] 测试：新建应用初始化配置，只有ngi支持，其他集群不支持 - Easemob JIRA",
            "description_text": "Click to add description",
            "comments": [],
            "external_documents": [],
        }
        linked_node = {
            "key": "HIM-22196",
            "title": "[HIM-22196] OS添加应用初始化默认配置集群过滤 - Easemob JIRA",
            "description_text": "Click to add description",
            "comments": [],
            "external_documents": [],
        }
        readiness = {
            "status": "not_ready",
            "message": "当前 Jira 信息不足，无法形成可执行测试范围。",
            "missing": [
                "根 Jira 缺少需求描述",
                "关联 Jira HIM-22196 缺少需求描述、评论和外部设计文档",
            ],
            "suggestions": [
                "补充初始化配置项、支持集群判断逻辑和不支持集群的预期表现。",
            ],
        }

        reply = build_reply_draft(root_node, [root_node, linked_node], [], readiness)

        self.assertIn("信息不足，暂无法开展有效测试", reply)
        self.assertIn("HIM-22206", reply)
        self.assertIn("HIM-22196", reply)
        self.assertIn("初始化配置项", reply)

    def test_write_reply_artifacts_persists_draft_and_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            reply = "测试结论：信息不足，暂无法开展有效测试。"
            state = build_reply_state("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", reply)

            write_reply_artifacts(output_root, "HIM-1", reply, state)

            self.assertEqual((output_root / "summary" / "HIM-1-reply.md").read_text(encoding="utf-8"), reply)
            persisted = json.loads((output_root / "summary" / "HIM-1-reply-state.json").read_text(encoding="utf-8"))
            self.assertEqual(persisted["issue_key"], "HIM-1")
            self.assertEqual(persisted["status"], "drafted")
            self.assertTrue(persisted["reply_hash"])


class ReplyPublishTests(unittest.TestCase):
    def test_confirm_issue_reply_normalizes_wrapped_api_endpoint_before_posting(self) -> None:
        class FakeResponse:
            status = 201

            def getcode(self):
                return 201

            def read(self):
                return b'{"id":"456"}'

            def info(self):
                return {}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        class FakeOpener:
            def __init__(self):
                self.requests = []

            def open(self, request, timeout=20):
                self.requests.append(request)
                return FakeResponse()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            reply = "POST /api/sdk/v1/{org}\n  /\n\n  {app}/speech/transcriptions"
            state = build_reply_state("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", reply)
            write_reply_artifacts(output_root, "HIM-1", reply, state)
            reply_path = output_root / "summary" / "HIM-1-reply.md"
            reply_path.write_text(reply, encoding="utf-8")
            opener = FakeOpener()

            confirm_issue_reply(output_root, "HIM-1", opener, "https://j1.private.easemob.com", timeout=20)

            body = json.loads(opener.requests[0].data.decode("utf-8"))
            self.assertEqual(body["body"], "POST /api/sdk/v1/{org}/{app}/speech/transcriptions")

    def test_confirm_issue_reply_posts_markdown_body_and_updates_state(self) -> None:
        class FakeResponse:
            status = 201

            def getcode(self):
                return 201

            def read(self):
                return b'{"id":"456"}'

            def info(self):
                return {}

            def __enter__(self):
                return self

            def __exit__(self, exc_type, exc, tb):
                return False

        class FakeOpener:
            def __init__(self):
                self.requests = []

            def open(self, request, timeout=20):
                self.requests.append(request)
                return FakeResponse()

        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            reply = "测试结论：信息不足，暂无法开展有效测试。"
            state = build_reply_state("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", reply)
            write_reply_artifacts(output_root, "HIM-1", reply, state)
            opener = FakeOpener()

            result = confirm_issue_reply(output_root, "HIM-1", opener, "https://j1.private.easemob.com", timeout=20)

            self.assertEqual(result["status"], "replied")
            self.assertEqual(result["comment_id"], "456")
            self.assertEqual(opener.requests[0].full_url, "https://j1.private.easemob.com/rest/api/2/issue/HIM-1/comment")
            self.assertEqual(opener.requests[0].headers["Content-type"], "application/json")
            body = json.loads(opener.requests[0].data.decode("utf-8"))
            self.assertEqual(body["body"], reply)
            updated = json.loads((output_root / "summary" / "HIM-1-reply-state.json").read_text(encoding="utf-8"))
            self.assertEqual(updated["status"], "replied")
            self.assertEqual(updated["comment_id"], "456")

    def test_confirm_issue_reply_skips_when_same_reply_already_posted(self) -> None:
        class FakeOpener:
            def open(self, request, timeout=20):
                raise AssertionError("should not post duplicate reply")

        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = Path(tmpdir)
            reply = "已发布内容"
            state = build_reply_state("HIM-1", "https://j1.private.easemob.com/browse/HIM-1", reply)
            state["status"] = "replied"
            state["comment_id"] = "456"
            write_reply_artifacts(output_root, "HIM-1", reply, state)

            result = confirm_issue_reply(output_root, "HIM-1", FakeOpener(), "https://j1.private.easemob.com", timeout=20)

            self.assertEqual(result["status"], "skipped")
            self.assertEqual(result["reason"], "reply already posted")


class ReadinessTests(unittest.TestCase):
    def test_marks_ready_when_structured_scope_and_context_exist(self) -> None:
        nodes = [
            {
                "key": "HIM-1",
                "title": "根需求",
                "description_text": "包含明确业务流程和状态处理",
                "comments": ["阶段一任务拆分 HIM-2"],
            },
            {"key": "HIM-2", "title": "子任务", "description_text": "", "comments": []},
        ]
        edges = [
            {"from_key": "HIM-1", "to_key": "HIM-2", "type": "subtask", "source": "issuetable"},
        ]

        result = assess_case_readiness(nodes, edges, "HIM-1")

        self.assertEqual(result["status"], "ready")

    def test_marks_not_ready_when_root_and_linked_issue_have_no_body_context(self) -> None:
        nodes = [
            {
                "key": "HIM-22206",
                "title": "测试：新建应用初始化配置，只有ngi支持，其他集群不支持",
                "description_text": "Click to add description",
                "comments": [],
                "external_documents": [],
            },
            {
                "key": "HIM-22196",
                "title": "OS添加应用初始化默认配置集群过滤",
                "description_text": "Click to add description",
                "comments": [],
                "external_documents": [],
            },
        ]
        edges = [
            {"from_key": "HIM-22206", "to_key": "HIM-22196", "type": "jira_reference", "source": "page_link"},
            {"from_key": "HIM-22196", "to_key": "HIM-22206", "type": "subtask", "source": "issuetable"},
        ]

        result = assess_case_readiness(nodes, edges, "HIM-22206")

        self.assertEqual(result["status"], "not_ready")
        self.assertIn("缺少足够业务上下文", result["missing"])

    def test_marks_partial_when_only_title_exists(self) -> None:
        nodes = [
            {
                "key": "HIM-1",
                "title": "优化会话列表未读数展示",
                "description_text": "",
                "comments": [],
            },
        ]
        edges = []

        result = assess_case_readiness(nodes, edges, "HIM-1")

        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["missing"])

    def test_marks_not_ready_when_no_title_or_context_exists(self) -> None:
        nodes = [
            {
                "key": "HIM-1",
                "title": "",
                "description_text": "",
                "comments": [],
            },
        ]
        edges = []

        result = assess_case_readiness(nodes, edges, "HIM-1")

        self.assertEqual(result["status"], "not_ready")
        self.assertTrue(result["missing"])


class OutputRootTests(unittest.TestCase):
    def test_resolves_default_output_root_outside_skill_directory(self) -> None:
        output_root = resolve_output_root(root_key="HIM-1")

        self.assertEqual(
            output_root,
            Path(tempfile_module.gettempdir()) / "qa-ai-tool" / "easemob-jira-testcase" / "HIM-1",
        )

    def test_resolves_output_root_from_argument(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = resolve_output_root(output_root_input=tmpdir, root_key="HIM-1")

        self.assertEqual(output_root, Path(tmpdir))

    def test_resolves_output_root_from_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.dict(os.environ, {"EASEMOB_JIRA_OUTPUT_ROOT": tmpdir}, clear=False):
                output_root = resolve_output_root(root_key="HIM-1")

        self.assertEqual(output_root, Path(tmpdir))

    def test_resolves_case_output_root_from_argument(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_root = resolve_case_output_root(case_output_root_input=tmpdir)

        self.assertEqual(output_root, Path(tmpdir))

    def test_rejects_missing_case_output_root(self) -> None:
        with self.assertRaises(ValueError):
            resolve_case_output_root(case_output_root_input="")


if __name__ == "__main__":
    unittest.main()
