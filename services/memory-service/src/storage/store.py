import os
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

import chromadb

DATA_DIR = Path(os.getenv("DATA_DIR", "/app/data"))
CHROMA_DIR = DATA_DIR / "chroma"
SQLITE_PATH = DATA_DIR / "meta.db"


def _get_chroma() -> chromadb.ClientAPI:
    CHROMA_DIR.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(CHROMA_DIR))


def _get_db() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(SQLITE_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("""
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            namespace TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'core',
            tags TEXT DEFAULT '',
            source TEXT DEFAULT 'text',
            title TEXT DEFAULT '',
            filename TEXT DEFAULT '',
            user_id TEXT DEFAULT '',
            chunks INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            last_accessed_at TEXT
        )
    """)
    conn.commit()
    return conn


class MemoryStorage:
    def __init__(self):
        self.chroma = _get_chroma()
        self.db = _get_db()

    def _collection(self, namespace: str):
        return self.chroma.get_or_create_collection(
            name=namespace,
            metadata={"hnsw:space": "cosine"}
        )

    def store(
        self,
        namespace: str,
        chunks: list[str],
        embeddings: list[list[float]],
        tier: str = "core",
        tags: list[str] | None = None,
        source: str = "text",
        metadata: dict | None = None,
    ) -> str:
        memory_id = f"mem_{uuid.uuid4().hex[:12]}"
        now = datetime.utcnow().isoformat()
        meta = metadata or {}

        # Store vectors in ChromaDB
        col = self._collection(namespace)
        ids = [f"{memory_id}_chk{i}" for i in range(len(chunks))]
        chunk_meta = [{"memory_id": memory_id, "chunk_index": i, "tier": tier} for i in range(len(chunks))]
        col.add(ids=ids, embeddings=embeddings, documents=chunks, metadatas=chunk_meta)

        # Store metadata in SQLite
        self.db.execute(
            "INSERT INTO memories (id, namespace, tier, tags, source, title, filename, user_id, chunks, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (memory_id, namespace, tier, ",".join(tags or []), source,
             meta.get("title", ""), meta.get("filename", ""), meta.get("user_id", ""),
             len(chunks), now)
        )
        self.db.commit()
        return memory_id

    def search(
        self,
        namespace: str,
        query_embedding: list[float],
        limit: int = 5,
        tags: list[str] | None = None,
        include_shared: bool = True,
    ) -> list[dict]:
        namespaces = [namespace]
        if include_shared and namespace != "shared":
            namespaces.append("shared")

        results = []
        for ns in namespaces:
            try:
                col = self._collection(ns)
            except Exception:
                continue
            where = {"tier": {"$ne": "archived"}}
            res = col.query(query_embeddings=[query_embedding], n_results=limit, where=where)
            if res["documents"]:
                for i, doc in enumerate(res["documents"][0]):
                    results.append({
                        "chunk_id": res["ids"][0][i],
                        "content": doc,
                        "score": 1 - (res["distances"][0][i] if res["distances"] else 0),
                        "metadata": res["metadatas"][0][i] if res["metadatas"] else {},
                        "namespace": ns,
                    })

        # Sort by score descending, limit
        results.sort(key=lambda x: x["score"], reverse=True)
        # Enrich with SQLite metadata
        for r in results[:limit]:
            memory_id = r["metadata"].get("memory_id", "")
            row = self.db.execute("SELECT * FROM memories WHERE id = ?", (memory_id,)).fetchone()
            if row:
                r["tags"] = row["tags"].split(",") if row["tags"] else []
                r["tier"] = row["tier"]
                r["title"] = row["title"]
                r["filename"] = row["filename"]
                r["created_at"] = row["created_at"]
                # Update last_accessed_at
                self.db.execute("UPDATE memories SET last_accessed_at = ? WHERE id = ?",
                                (datetime.utcnow().isoformat(), memory_id))
            self.db.commit()

        return results[:limit]

    def delete(self, memory_id: str) -> bool:
        row = self.db.execute("SELECT namespace, chunks FROM memories WHERE id = ?", (memory_id,)).fetchone()
        if not row:
            return False
        ns = row["namespace"]
        n_chunks = row["chunks"]
        col = self._collection(ns)
        ids = [f"{memory_id}_chk{i}" for i in range(n_chunks)]
        col.delete(ids=ids)
        self.db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        self.db.commit()
        return True

    def delete_by_query(self, namespace: str, tags: list[str] | None = None) -> int:
        query = "SELECT id FROM memories WHERE namespace = ?"
        params: list = [namespace]
        if tags:
            for tag in tags:
                query += " AND tags LIKE ?"
                params.append(f"%{tag}%")
        rows = self.db.execute(query, params).fetchall()
        count = 0
        for row in rows:
            if self.delete(row["id"]):
                count += 1
        return count

    def stats(self, namespace: str | None = None) -> dict:
        if namespace:
            rows = self.db.execute(
                "SELECT tier, COUNT(*) as cnt, SUM(chunks) as total_chunks FROM memories WHERE namespace = ? GROUP BY tier",
                (namespace,)
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT tier, COUNT(*) as cnt, SUM(chunks) as total_chunks FROM memories GROUP BY tier"
            ).fetchall()
        by_tier = {r["tier"]: {"memories": r["cnt"], "chunks": r["total_chunks"] or 0} for r in rows}
        total = sum(v["memories"] for v in by_tier.values())
        total_chunks = sum(v["chunks"] for v in by_tier.values())
        return {"total_memories": total, "total_chunks": total_chunks, "by_tier": by_tier}
