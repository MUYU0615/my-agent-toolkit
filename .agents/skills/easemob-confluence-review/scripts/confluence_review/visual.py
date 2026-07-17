from __future__ import annotations

from pathlib import Path


def build_visual_review_prompt(title: str, source_url: str, images: list[dict]) -> str:
    image_lines = [
        f"- 文件：{item.get('title', '')}；本地路径：`{item.get('local_path', '')}`；来源：{item.get('url', '')}"
        for item in images
    ] or ["- 无"]
    return "\n".join(
        [
            f"# {title} 视觉附件分析任务包",
            "",
            f"Source: {source_url}",
            "",
            "以下图片来自 Confluence 页面附件。请使用当前多模态 LLM 能力直接查看图片，不使用 OCR，提取可用于 QA 审查的信息。",
            "",
            "## 图片附件",
            *image_lines,
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
            "- 不要把图片识别结果当作最终验收标准；若 Confluence 正文没有写明，标记为“基于截图推断”。",
            "- 对 UI 文案保持原文，不要自行改写。",
        ]
    )


def persist_visual_review_package(page_dir: str | Path, title: str, source_url: str, images: list[dict]) -> dict:
    path = Path(page_dir) / "visual-review.md"
    path.write_text(build_visual_review_prompt(title, source_url, images), encoding="utf-8")
    return {"visual_review_file": str(path), "visual_attachment_count": len(images)}
