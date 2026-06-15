def parse_markdown(content: bytes, filename: str = "") -> str:
    """Parse markdown or plain text file, return text content."""
    return content.decode("utf-8", errors="ignore")


def parse_txt(content: bytes, filename: str = "") -> str:
    return content.decode("utf-8", errors="ignore")
