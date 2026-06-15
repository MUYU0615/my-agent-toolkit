from pathlib import Path

from .markdown import parse_markdown, parse_txt
from .pdf import parse_pdf
from .docx import parse_docx
from .html import parse_html

PARSERS = {
    ".md": parse_markdown,
    ".markdown": parse_markdown,
    ".txt": parse_txt,
    ".pdf": parse_pdf,
    ".docx": parse_docx,
    ".html": parse_html,
    ".htm": parse_html,
}


def parse_file(content: bytes, filename: str) -> str | None:
    """Parse file content based on extension. Returns None if unsupported."""
    ext = Path(filename).suffix.lower()
    parser = PARSERS.get(ext)
    if parser is None:
        return None
    return parser(content, filename)


def supported_extensions() -> list[str]:
    return list(PARSERS.keys())
