from bs4 import BeautifulSoup


def parse_html(content: bytes, filename: str = "") -> str:
    """Extract text content from HTML."""
    soup = BeautifulSoup(content, "html.parser")
    for tag in soup(["script", "style", "nav", "footer", "header"]):
        tag.decompose()
    text = soup.get_text(separator="\n")
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    return "\n\n".join(lines)
