import os
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

tmp_dir = tempfile.mkdtemp(prefix="memory-service-smoke-")
os.environ["DATA_DIR"] = tmp_dir

from fastapi.testclient import TestClient  # noqa: E402
import src.main as memory_app  # noqa: E402


def fake_embeddings(texts: list[str]) -> list[list[float]]:
    return [[1.0, 0.0, 0.0, 0.0] for _ in texts]


def fake_query(_: str) -> list[float]:
    return [1.0, 0.0, 0.0, 0.0]


memory_app.embed_texts = fake_embeddings
memory_app.embed_query = fake_query
client = TestClient(memory_app.app)


class PageHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write("<html><body><h1>Billing Policy</h1><p>计量计费规则</p></body></html>".encode())

    def log_message(self, *_):
        return


def assert_ok(response, label: str):
    if response.status_code >= 400:
        raise AssertionError(f"{label} failed: {response.status_code} {response.text}")
    return response.json()


try:
    stored = assert_ok(client.post("/internal/v1/memories", json={
        "scope": "bot",
        "owner_id": "prd-bot",
        "content": "语音转文字 API 需要确认 Console、计量计费和开关策略。",
        "tags": ["prd", "asr"],
        "tier": "core",
        "source_type": "text",
    }), "store memory")
    assert stored["backend_memory_id"].startswith("mem_")
    assert stored["chunks"] >= 1
    print("store scoped memory ok")

    search = assert_ok(client.post("/internal/v1/memories/search", json={
        "query": "计量计费",
        "scopes": ["bot"],
        "owner_ids": ["prd-bot"],
        "tags": ["prd"],
        "limit": 5,
    }), "search memory")
    assert search["results"]
    assert search["results"][0]["source"] == "memory"
    print("search scoped memory ok")

    uploaded = assert_ok(client.post(
        "/internal/v1/memories/ingest-file",
        data={
            "scope": "shared",
            "owner_id": "platform",
            "tags": "billing,reference",
            "tier": "core",
        },
        files={
            "file": ("billing.md", b"# Billing\n\nConsole and metering policy.", "text/markdown"),
        },
    ), "ingest file")
    assert uploaded["backend_memory_id"].startswith("mem_")
    print("ingest file ok")

    knowledge_dir = Path(tmp_dir) / "knowledge"
    knowledge_dir.mkdir()
    (knowledge_dir / "guide.md").write_text("# Guide\n\nPRD scope checklist.", encoding="utf-8")
    scanned = assert_ok(client.post("/internal/v1/memories/scan", json={
        "scope": "shared",
        "owner_id": "platform",
        "directory": str(knowledge_dir),
        "tags": ["guide"],
        "tier": "core",
        "incremental": True,
    }), "scan directory")
    assert scanned["scanned"] == 1
    print("scan directory ok")

    server = HTTPServer(("127.0.0.1", 0), PageHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        fetched = assert_ok(client.post("/internal/v1/memories/fetch-url", json={
            "scope": "shared",
            "owner_id": "platform",
            "url": f"http://127.0.0.1:{server.server_port}/policy",
            "tags": ["url"],
            "tier": "reference",
        }), "fetch url")
        assert fetched["backend_memory_id"].startswith("mem_")
        print("fetch url ok")
    finally:
        server.shutdown()

    stats = assert_ok(client.get("/internal/v1/memories/stats", params={
        "scope": "bot",
        "owner_id": "prd-bot",
    }), "stats")
    assert stats["total_memories"] >= 1
    print("stats ok")

    deleted = assert_ok(client.delete(f"/internal/v1/memories/{stored['backend_memory_id']}"), "delete")
    assert deleted["deleted"] == stored["backend_memory_id"]
    print("delete ok")
finally:
    shutil.rmtree(tmp_dir, ignore_errors=True)
