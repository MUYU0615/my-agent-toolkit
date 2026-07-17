from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

TESSERACT_INSTALL_URL = "https://tesseract-ocr.cn/tessdoc/Installation.html"
REQUIRED_KEYWORDS = ["压测"]
SUPPLEMENTAL_KEYWORDS = ["基准", "性能", "benchmark", "loadtest", "stress", "qps", "rps", "latency", "locust"]
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}
BODY_TRIGGER_PATTERNS = [
    r"压测结果",
    r"压测完成.{0,20}(?:qps|rps|tps|时延|latency|cpu|内存|掉线|丢包)",
    r"\b(?:QPS|RPS|TPS)\s*[:=]?\s*\d+(?:\.\d+)?\b",
    r"\b(?:p99|p95|p90|avg|max|min|latency|响应时间|端到端延时)\s*[:=]?\s*\d+(?:\.\d+)?\s*(?:ms|s)\b",
    r"cpu.{0,8}(?:打满|飙升|波动)",
    r"(?:内存|memory).{0,8}(?:打满|飙升|波动)",
    r"(?:掉线|丢包|packet loss|timeout|retrans)",
]
IMAGE_TRIGGER_PATTERNS = [r"\b(?:QPS|RPS|TPS|CPU|Memory|latency|benchmark)\b", r"packet loss", r"p99"]


def empty_metrics() -> dict[str, list[str]]:
    return {"throughput": [], "latency": [], "cpu": [], "memory": [], "storage": [], "network": []}


def _has_any_metric(metrics: dict | None) -> bool:
    return any(isinstance(items, list) and len(items) > 0 for items in (metrics or {}).values())


def _unique_matches(values) -> list[str]:
    seen = set()
    results = []
    for value in values:
        item = str(value or "").strip()
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            results.append(item)
    return results


def _collect_matches(text: str, pattern: str) -> list[str]:
    return _unique_matches(match.group(0) for match in re.finditer(pattern, text, re.I))


def _max_percent(matches: list[str]) -> float | None:
    current = None
    for item in matches:
        match = re.search(r"(\d+(?:\.\d+)?)%", item)
        if match:
            value = float(match.group(1))
            current = value if current is None else max(current, value)
    return current


def _max_latency_ms(matches: list[str]) -> float | None:
    current = None
    for item in matches:
        match = re.search(r"(\d+(?:\.\d+)?)\s*(ms|s)\b", item, re.I)
        if not match:
            continue
        value = float(match.group(1)) * (1000 if match.group(2).lower() == "s" else 1)
        current = value if current is None else max(current, value)
    return current


def _supplemental_category(text: str) -> str:
    lowered = text.lower()
    if "基准" in lowered or "benchmark" in lowered:
        return "benchmark"
    if "压测" in lowered:
        return "pressure"
    return "performance"


def get_performance_trigger(input_value) -> dict:
    if isinstance(input_value, str):
        title, body_text, image_texts = input_value, "", []
    else:
        title = str((input_value or {}).get("title") or "")
        body_text = str((input_value or {}).get("bodyText") or "")
        image_texts = [str(item or "") for item in (input_value or {}).get("imageTexts") or []]
    lowered_title = title.lower()
    if any(keyword in lowered_title for keyword in REQUIRED_KEYWORDS):
        return {"matched": True, "required": True, "reason": "mandatory-pressure-keyword", "source": "title", "category": "pressure"}
    if any(keyword in lowered_title for keyword in SUPPLEMENTAL_KEYWORDS):
        return {"matched": True, "required": False, "reason": "supplemental-performance-keyword", "source": "title", "category": _supplemental_category(title)}
    if any(re.search(pattern, body_text, re.I) for pattern in BODY_TRIGGER_PATTERNS):
        return {
            "matched": True,
            "required": False,
            "reason": "performance-result-body",
            "source": "body",
            "category": "benchmark" if "基准" in body_text or re.search("benchmark", body_text, re.I) else "pressure",
        }
    if any(any(re.search(pattern, text, re.I) for pattern in IMAGE_TRIGGER_PATTERNS) for text in image_texts):
        return {
            "matched": True,
            "required": False,
            "reason": "performance-result-image",
            "source": "image",
            "category": "benchmark" if any(re.search(r"benchmark|基准", text, re.I) for text in image_texts) else "performance",
        }
    return {"matched": False, "required": False, "reason": "no-match", "source": None, "category": None}


def build_unavailable_reason(has_images: bool, extracted_text_count: int = 0, has_metrics: bool = False) -> str:
    if not has_images:
        return "页面目录下没有可分析截图，当前无法进行图片侧压测/基准分析。"
    if has_metrics:
        return "已提取到部分 OCR 指标，但证据不足以形成稳定结论，建议结合正文和原图继续复核。"
    if extracted_text_count <= 0:
        return "当前 CLI 运行环境未直接暴露模型视觉能力，已退回 OCR，但 OCR 未提取到稳定文本。可能原因是截图压缩严重、清晰度不足，或图中主要是趋势线而非可识别数字。"
    return "当前 CLI 运行环境未直接暴露模型视觉能力，已退回 OCR，但 OCR 只提取到少量文本，仍不足以稳定判断。图片可能主要是趋势线、峰值走势或监控面板，建议让支持看图的当前会话 agent 直接读取本地图片继续分析。"


def analyze_performance_image_texts(title: str, image_texts: list[str]) -> dict:
    trigger = get_performance_trigger({"title": title, "imageTexts": image_texts})
    if not trigger["matched"]:
        return {"status": "skipped", "image_count": 0, "metrics": empty_metrics(), "bottlenecks": [], "visual_trend_guidance": None, "message": "标题未命中压测/性能文档规则，跳过图片数据分析。"}
    texts = [str(item or "").strip() for item in image_texts or [] if str(item or "").strip()]
    if not texts:
        return {"status": "insufficient", "image_count": 0, "metrics": empty_metrics(), "bottlenecks": [], "visual_trend_guidance": None, "message": "未从图片中提取到可分析文本。"}
    joined = "\n".join(texts)
    metrics = {
        "throughput": _collect_matches(joined, r"\b(?:QPS|RPS|TPS)\s*[:=]?\s*\d+(?:\.\d+)?\b"),
        "latency": _collect_matches(joined, r"\b(?:p99|p95|p90|avg|max|min|latency|响应时间)\s*[:=]?\s*\d+(?:\.\d+)?\s*(?:ms|s)\b"),
        "cpu": _collect_matches(joined, r"\bCPU\s*[:=]?\s*\d+(?:\.\d+)?%"),
        "memory": _collect_matches(joined, r"\b(?:Memory|Mem|内存)\s*[:=]?\s*\d+(?:\.\d+)?%"),
        "storage": _collect_matches(joined, r"\b(?:iowait|io wait|disk usage|disk util|磁盘使用率|磁盘IO等待|存储使用率)\s*[:=]?\s*\d+(?:\.\d+)?%"),
        "network": _collect_matches(joined, r"\b(?:packet loss|loss|丢包率|timeout|retrans(?:mit)?|网络重传|带宽利用率)\s*[:=]?\s*[\d.]+%?\b"),
    }
    bottlenecks = []
    max_latency = _max_latency_ms(metrics["latency"])
    max_cpu = _max_percent(metrics["cpu"])
    max_memory = _max_percent(metrics["memory"])
    max_storage = _max_percent(metrics["storage"])
    max_network_loss = _max_percent(metrics["network"])
    if (max_latency is not None and max_latency >= 1000) or (max_cpu is not None and max_cpu >= 80):
        parts = []
        if max_latency is not None:
            parts.append(f"p99/时延最高约 {round(max_latency)}ms")
        if max_cpu is not None:
            parts.append(f"CPU 约 {max_cpu:g}%")
        bottlenecks.append(f"性能瓶颈：{'，'.join(parts)}，需要优先排查热点路径和并发处理能力。")
    if max_memory is not None and max_memory >= 85:
        bottlenecks.append(f"内存瓶颈：内存占用约 {max_memory:g}% ，需要检查对象堆积、缓存策略和泄漏风险。")
    if max_storage is not None and max_storage >= 20:
        bottlenecks.append(f"存储瓶颈：IO 等待或磁盘利用率约 {max_storage:g}% ，需要排查磁盘吞吐、落盘频率和日志写入压力。")
    if (max_network_loss is not None and max_network_loss > 0) or re.search(r"timeout|retrans|丢包|packet loss", joined, re.I):
        text = f"丢包/网络异常约 {max_network_loss:g}%" if max_network_loss is not None else "存在超时、重传或丢包迹象"
        bottlenecks.append(f"网络瓶颈：{text}，需要检查链路质量、带宽上限和跨区访问抖动。")
    return {"status": "ok", "image_count": len(texts), "metrics": metrics, "bottlenecks": bottlenecks, "visual_trend_guidance": None, "message": "已完成图片数据分析。" if bottlenecks else "已提取图片文本，但未发现明确瓶颈。"}


def _derive_body_findings(body_text: str) -> dict:
    trend_findings, bottlenecks, risks, recommendations = [], [], [], []
    if re.search(r"cpu.{0,8}(打满|飙升|波动)", body_text, re.I):
        trend_findings.append("正文记录显示 CPU 存在突增、打满或明显波动。")
        bottlenecks.append("性能瓶颈：正文已明确提到 CPU 打满或显著波动，需要优先排查热点路径。")
    latency = re.search(r"端到端延时.{0,4}?(\d+(?:\.\d+)?)s", body_text, re.I)
    if latency:
        trend_findings.append(f"正文记录显示端到端延时约 {latency.group(1)}s。")
        bottlenecks.append(f"性能瓶颈：正文记录的端到端延时约 {latency.group(1)}s，响应时间偏高。")
    if "掉线" in body_text:
        risks.append("存在掉线风险，需进一步确认连接稳定性与重连策略。")
    if "数据库压力" in body_text:
        risks.append("正文提到数据库压力较大，需单独排查数据库瓶颈。")
    if re.search(r"参数调整|修改参数", body_text):
        recommendations.append("建议将参数调整前后的关键指标做成对照表，明确优化收益和副作用。")
    return {"trendFindings": trend_findings, "bottlenecks": bottlenecks, "risks": risks, "recommendations": recommendations}


def _ensure_tesseract_available() -> dict:
    if shutil.which("tesseract"):
        return {"available": True, "command": "tesseract"}
    return {"available": False, "command": "tesseract", "message": "未检测到 tesseract，本地脚本图片 OCR 无法执行。请先安装后再重试。", "install_guide_url": TESSERACT_INSTALL_URL}


def build_performance_analysis_from_buffers(title: str, images: list[dict], body_text: str = "") -> dict | None:
    trigger = get_performance_trigger({"title": title, "bodyText": body_text, "imageTexts": [item.get("name", "") for item in images or []]})
    if not trigger["matched"]:
        return None
    image_items = [item for item in images or [] if item.get("buffer") and item.get("name")]
    if not image_items:
        return {"status": "no-images", "image_count": 0, "trigger": trigger, "analysis_mode": "unavailable", "chart_types": [], "metrics": empty_metrics(), "trend_findings": [], "findings": [], "bottlenecks": [], "risks": [], "recommendations": [], "evidence": [], "confidence": "low", "visual_trend_guidance": None, "message": "标题命中压测强制规则，但页面附件中未找到可分析图片。" if trigger["required"] else "标题命中补充性能规则，但页面附件中未找到可分析图片。"}
    availability = _ensure_tesseract_available()
    if not availability["available"]:
        return {"status": "unavailable", "image_count": len(image_items), "metrics": empty_metrics(), "bottlenecks": [], "visual_trend_guidance": None, "message": f"{availability['message']} 安装文档：{availability['install_guide_url']}", "install_guide_url": TESSERACT_INSTALL_URL, "trigger": trigger, "analysis_mode": "unavailable", "chart_types": [], "trend_findings": [], "findings": [], "risks": [], "recommendations": [], "evidence": [], "confidence": "low"}
    temp_root = Path(tempfile.mkdtemp(prefix="confluence-review-ocr-"))
    try:
        image_texts = []
        for index, item in enumerate(image_items, start=1):
            ext = Path(item["name"]).suffix.lower()
            target = temp_root / f"image-{index}{ext if ext in IMAGE_EXTENSIONS else '.png'}"
            target.write_bytes(item["buffer"])
            result = subprocess.run(["tesseract", str(target), "stdout", "--psm", "6"], text=True, capture_output=True, check=False)
            if result.returncode == 0 and result.stdout.strip():
                image_texts.append(result.stdout.strip())
        analysis = analyze_performance_image_texts(title, image_texts)
        body_findings = _derive_body_findings(body_text)
        has_metrics = _has_any_metric(analysis["metrics"])
        return {
            **analysis,
            "trigger": trigger,
            "image_count": len(image_items),
            "analysis_mode": "ocr-only",
            "chart_types": ["unknown"] if image_items else [],
            "trend_findings": body_findings["trendFindings"],
            "findings": [],
            "bottlenecks": [*analysis["bottlenecks"], *body_findings["bottlenecks"]],
            "risks": body_findings["risks"],
            "recommendations": body_findings["recommendations"],
            "source_breakdown": {"text_useful": any(body_findings.values()), "image_useful": has_metrics or bool(analysis["bottlenecks"])},
            "evidence": image_texts,
            "confidence": "medium" if image_texts else "low",
            "visual_trend_guidance": None,
            "message": analysis["message"] if has_metrics else build_unavailable_reason(True, len(image_texts), has_metrics),
        }
    finally:
        shutil.rmtree(temp_root, ignore_errors=True)
