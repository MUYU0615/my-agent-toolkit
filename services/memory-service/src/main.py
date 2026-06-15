from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .core.embedding import embed_texts, embed_query
from .core.chunker import chunk_text
from .storage.store import MemoryStorage

app = FastAPI(title="Memory Service", version="0.1.0")
storage = MemoryStorage()


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


@app.delete("/api/v1/memories/{memory_id}")
def delete_memory(memory_id: str):
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


@app.get("/health")
def health():
    return {"status": "ok"}
