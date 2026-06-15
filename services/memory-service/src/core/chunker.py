import re


def chunk_text(text: str, max_tokens: int = 512, overlap: int = 128) -> list[str]:
    """Split text into chunks respecting paragraph boundaries."""
    paragraphs = re.split(r"\n{2,}", text.strip())
    chunks: list[str] = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        candidate = f"{current}\n\n{para}".strip() if current else para
        if _estimate_tokens(candidate) <= max_tokens:
            current = candidate
        else:
            if current:
                chunks.append(current)
            # If single paragraph exceeds max, split by sentences
            if _estimate_tokens(para) > max_tokens:
                chunks.extend(_split_long_paragraph(para, max_tokens, overlap))
                current = ""
            else:
                current = para

    if current:
        chunks.append(current)

    # Apply overlap: prepend tail of previous chunk to next
    if overlap > 0 and len(chunks) > 1:
        overlapped = [chunks[0]]
        for i in range(1, len(chunks)):
            prev_tail = _tail_tokens(chunks[i - 1], overlap)
            overlapped.append(f"{prev_tail}\n\n{chunks[i]}".strip())
        return overlapped

    return chunks


def _split_long_paragraph(text: str, max_tokens: int, overlap: int) -> list[str]:
    sentences = re.split(r"(?<=[。！？.!?\n])", text)
    chunks: list[str] = []
    current = ""
    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        candidate = current + sent
        if _estimate_tokens(candidate) <= max_tokens:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = sent
    if current:
        chunks.append(current)
    return chunks


def _tail_tokens(text: str, n_tokens: int) -> str:
    words = text.split()
    # Rough: 1 token ≈ 1.5 chars for Chinese, 1 word for English
    char_limit = n_tokens * 2
    return text[-char_limit:] if len(text) > char_limit else text


def _estimate_tokens(text: str) -> int:
    # Rough estimation: Chinese ~1.5 chars/token, English ~4 chars/token
    # Use a simple heuristic: len / 2 for mixed content
    return len(text) // 2
