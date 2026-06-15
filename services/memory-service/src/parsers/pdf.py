import io
import pymupdf


def parse_pdf(content: bytes, filename: str = "") -> str:
    """Extract text from PDF bytes."""
    doc = pymupdf.open(stream=content, filetype="pdf")
    pages = []
    for page in doc:
        text = page.get_text()
        if text.strip():
            pages.append(text.strip())
    doc.close()
    return "\n\n".join(pages)
