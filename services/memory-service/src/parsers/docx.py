import io
from docx import Document


def parse_docx(content: bytes, filename: str = "") -> str:
    """Extract text from .docx bytes."""
    doc = Document(io.BytesIO(content))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    return "\n\n".join(paragraphs)
