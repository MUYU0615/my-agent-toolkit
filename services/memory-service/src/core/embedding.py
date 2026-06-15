import os
from fastembed import TextEmbedding

_model: TextEmbedding | None = None


def get_model() -> TextEmbedding:
    global _model
    if _model is None:
        model_name = os.getenv("EMBEDDING_MODEL", "BAAI/bge-small-zh-v1.5")
        _model = TextEmbedding(model_name=model_name)
    return _model


def embed_texts(texts: list[str]) -> list[list[float]]:
    model = get_model()
    return [e.tolist() for e in model.embed(texts)]


def embed_query(query: str) -> list[float]:
    model = get_model()
    return list(model.query_embed(query))[0].tolist()
