from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
import asyncio
import httpx
from pathlib import Path

from .core.embedding import embed_texts, embed_query
from .core.chunker import chunk_text
from .core.lifecycle import cleanup, schedule_daily_cleanup
from .storage.store import MemoryStorage
from .parsers.dispatch import parse_file, supported_extensions

app = FastAPI(title="Memory Service", version="0.1.0")
storage = MemoryStorage()


@app.on_event("startup")
async def startup():
    asyncio.create_task(schedule_daily_cleanup(storage))


class StoreRequest(BaseModel):
    namespace: str
    content: str
    tags: list[str] = []
    tier: str = "core"
    source: str = "text"
    metadata: dict = {}


class SearchRequest(BaseModel):
    namespace: str
    query: str
    tags: list[str] | None = None
    limit: int = 5
    include_shared: bool = True


class DeleteByQueryRequest(BaseModel):
    namespace: str
    tags: list[str] | None = None


class FetchRequest(BaseModel):
    namespace: str
    url: str
    tags: list[str] = []
    tier: str = "core"


class ScanRequest(BaseModel):
    namespace: str
    directory: str
    tags: list[str] = []
    tier: str = "core"
    incremental: bool = True


class ScopedStoreRequest(BaseModel):
    scope: str
    owner_id: str
    content: str
    tags: list[str] = []
    tier: str = "core"
    source_type: str = "text"
    source_kind: str = "memory"
    source_id: str | None = None
    metadata: dict = {}


class ScopedSearchRequest(BaseModel):
    query: str
    scopes: list[str]
    owner_ids: list[str]
    sources: list[str] | None = None
    tags: list[str] | None = None
    limit: int = 5


class ScopedFetchRequest(BaseModel):
    scope: str
    owner_id: str
    url: str
    tags: list[str] = []
    tier: str = "core"
    source_kind: str = "memory"
    source_id: str | None = None


class ScopedScanRequest(BaseModel):
    scope: str
    owner_id: str
    directory: str
    tags: list[str] = []
    tier: str = "core"
    incremental: bool = True
    source_kind: str = "memory"


@app.post("/api/v1/memories")
def store_memory(req: StoreRequest):
    chunks = chunk_text(req.content)
    if not chunks:
        raise HTTPException(400, "Content is empty after chunking")
    embeddings = embed_texts(chunks)
    memory_id = storage.store(
        namespace=req.namespace,
        chunks=chunks,
        embeddings=embeddings,
        tier=req.tier,
        tags=req.tags,
        source=req.source,
        metadata=req.metadata,
    )
    return {"id": memory_id, "chunks": len(chunks)}


@app.post("/internal/v1/memories")
def store_scoped_memory(req: ScopedStoreRequest):
    chunks = chunk_text(req.content)
    if not chunks:
        raise HTTPException(400, "Content is empty after chunking")
    embeddings = embed_texts(chunks)
    memory_id = storage.store_scoped(
        scope=req.scope,
        owner_id=req.owner_id,
        chunks=chunks,
        embeddings=embeddings,
        tier=req.tier,
        tags=req.tags,
        source=req.source_type,
        metadata={
            **req.metadata,
            "source_kind": req.source_kind,
            "source_id": req.source_id or "",
        },
    )
    return {"backend_memory_id": memory_id, "chunks": len(chunks)}


@app.post("/api/v1/memories/search")
def search_memories(req: SearchRequest):
    query_emb = embed_query(req.query)
    results = storage.search(
        namespace=req.namespace,
        query_embedding=query_emb,
        limit=req.limit,
        tags=req.tags,
        include_shared=req.include_shared,
    )
    return {"results": results}


@app.post("/internal/v1/memories/search")
def search_scoped_memories(req: ScopedSearchRequest):
    if len(req.scopes) != len(req.owner_ids):
        raise HTTPException(400, "scopes and owner_ids must have the same length")
    query_emb = embed_query(req.query)
    results = storage.search_scoped(
        scopes=req.scopes,
        owner_ids=req.owner_ids,
        query_embedding=query_emb,
        limit=req.limit,
        tags=req.tags,
        sources=req.sources,
    )
    return {"results": [format_scoped_result(result) for result in results]}


@app.delete("/api/v1/memories/{memory_id}")
def delete_memory(memory_id: str):
    ok = storage.delete(memory_id)
    if not ok:
        raise HTTPException(404, "Memory not found")
    return {"deleted": memory_id}


@app.delete("/internal/v1/memories/{memory_id}")
def delete_scoped_memory(memory_id: str):
    ok = storage.delete(memory_id)
    if not ok:
        raise HTTPException(404, "Memory not found")
    return {"deleted": memory_id}


@app.post("/api/v1/memories/delete")
def delete_memories_by_query(req: DeleteByQueryRequest):
    count = storage.delete_by_query(namespace=req.namespace, tags=req.tags)
    return {"deleted_count": count}


@app.get("/api/v1/memories/stats")
def get_stats(namespace: str | None = None):
    return storage.stats(namespace)


@app.get("/internal/v1/memories/stats")
def get_scoped_stats(scope: str | None = None, owner_id: str | None = None):
    return storage.stats_scoped(scope, owner_id)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/api/v1/lifecycle/cleanup")
def run_cleanup():
    return cleanup(storage)


@app.post("/api/v1/memories/ingest")
async def ingest_file(
    file: UploadFile = File(...),
    namespace: str = Form(...),
    tags: str = Form(""),
    tier: str = Form("core"),
):
    content = await file.read()
    filename = file.filename or "unknown"
    text = parse_file(content, filename)
    if text is None:
        raise HTTPException(400, f"Unsupported format. Supported: {supported_extensions()}")
    if not text.strip():
        raise HTTPException(400, "No text content extracted from file")
    chunks = chunk_text(text)
    embeddings = embed_texts(chunks)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    memory_id = storage.store(
        namespace=namespace, chunks=chunks, embeddings=embeddings,
        tier=tier, tags=tag_list, source="file",
        metadata={"filename": filename},
    )
    return {"id": memory_id, "chunks": len(chunks), "filename": filename}


@app.post("/internal/v1/memories/ingest-file")
async def ingest_scoped_file(
    file: UploadFile = File(...),
    scope: str = Form(...),
    owner_id: str = Form(...),
    tags: str = Form(""),
    tier: str = Form("core"),
    source_kind: str = Form("memory"),
    source_id: str = Form(""),
):
    content = await file.read()
    filename = file.filename or "unknown"
    text = parse_file(content, filename)
    if text is None:
        raise HTTPException(400, f"Unsupported format. Supported: {supported_extensions()}")
    if not text.strip():
        raise HTTPException(400, "No text content extracted from file")
    chunks = chunk_text(text)
    embeddings = embed_texts(chunks)
    tag_list = [t.strip() for t in tags.split(",") if t.strip()]
    memory_id = storage.store_scoped(
        scope=scope,
        owner_id=owner_id,
        chunks=chunks,
        embeddings=embeddings,
        tier=tier,
        tags=tag_list,
        source="file",
        metadata={
            "filename": filename,
            "source_kind": source_kind,
            "source_id": source_id,
        },
    )
    return {"backend_memory_id": memory_id, "chunks": len(chunks), "filename": filename}


@app.post("/api/v1/memories/fetch")
async def fetch_url(req: FetchRequest):
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch URL: {e}")
    content = resp.content
    # Try HTML parse first, fallback to plain text
    text = parse_file(content, "page.html")
    if not text or not text.strip():
        text = content.decode("utf-8", errors="ignore")
    if not text.strip():
        raise HTTPException(400, "No content extracted from URL")
    chunks = chunk_text(text)
    embeddings = embed_texts(chunks)
    memory_id = storage.store(
        namespace=req.namespace, chunks=chunks, embeddings=embeddings,
        tier=req.tier, tags=req.tags, source="url",
        metadata={"url": req.url},
    )
    return {"id": memory_id, "chunks": len(chunks)}


@app.post("/internal/v1/memories/fetch-url")
async def fetch_scoped_url(req: ScopedFetchRequest):
    try:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            resp = await client.get(req.url)
            resp.raise_for_status()
    except Exception as e:
        raise HTTPException(400, f"Failed to fetch URL: {e}")
    content = resp.content
    text = parse_file(content, "page.html")
    if not text or not text.strip():
        text = content.decode("utf-8", errors="ignore")
    if not text.strip():
        raise HTTPException(400, "No content extracted from URL")
    chunks = chunk_text(text)
    embeddings = embed_texts(chunks)
    memory_id = storage.store_scoped(
        scope=req.scope,
        owner_id=req.owner_id,
        chunks=chunks,
        embeddings=embeddings,
        tier=req.tier,
        tags=req.tags,
        source="url",
        metadata={
            "url": req.url,
            "source_kind": req.source_kind,
            "source_id": req.source_id or "",
        },
    )
    return {"backend_memory_id": memory_id, "chunks": len(chunks)}


@app.post("/api/v1/memories/scan")
def scan_directory(req: ScanRequest):
    dir_path = Path(req.directory)
    if not dir_path.is_dir():
        raise HTTPException(400, f"Directory not found: {req.directory}")
    results = []
    for ext in supported_extensions():
        for file_path in dir_path.rglob(f"*{ext}"):
            if not file_path.is_file():
                continue
            content = file_path.read_bytes()
            text = parse_file(content, file_path.name)
            if not text or not text.strip():
                continue
            chunks = chunk_text(text)
            embeddings = embed_texts(chunks)
            memory_id = storage.store(
                namespace=req.namespace, chunks=chunks, embeddings=embeddings,
                tier=req.tier, tags=req.tags, source="file",
                metadata={"filename": file_path.name, "path": str(file_path)},
            )
            results.append({"id": memory_id, "filename": file_path.name, "chunks": len(chunks)})
    return {"scanned": len(results), "files": results}


@app.post("/internal/v1/memories/scan")
def scan_scoped_directory(req: ScopedScanRequest):
    dir_path = Path(req.directory)
    if not dir_path.is_dir():
        raise HTTPException(400, f"Directory not found: {req.directory}")
    results = []
    for ext in supported_extensions():
        for file_path in dir_path.rglob(f"*{ext}"):
            if not file_path.is_file():
                continue
            content = file_path.read_bytes()
            text = parse_file(content, file_path.name)
            if not text or not text.strip():
                continue
            chunks = chunk_text(text)
            embeddings = embed_texts(chunks)
            memory_id = storage.store_scoped(
                scope=req.scope,
                owner_id=req.owner_id,
                chunks=chunks,
                embeddings=embeddings,
                tier=req.tier,
                tags=req.tags,
                source="file",
                metadata={
                    "filename": file_path.name,
                    "path": str(file_path),
                    "source_kind": req.source_kind,
                    "source_id": "",
                },
            )
            results.append({"backend_memory_id": memory_id, "filename": file_path.name, "chunks": len(chunks)})
    return {"scanned": len(results), "files": results}


def format_scoped_result(result: dict) -> dict:
    metadata = result.get("metadata", {}) or {}
    source_kind = metadata.get("source_kind") or result.get("source") or "memory"
    return {
        "source": source_kind,
        "id": result.get("id") or metadata.get("source_id") or metadata.get("memory_id") or result.get("chunk_id"),
        "title": result.get("title", ""),
        "snippet": result.get("snippet") or result.get("content", ""),
        "score": result.get("score", 0),
        "metadata": {
            **metadata,
            "scope": result.get("scope"),
            "owner_id": result.get("owner_id"),
            "tier": result.get("tier") or metadata.get("tier"),
            "tags": result.get("tags", []),
        },
    }
