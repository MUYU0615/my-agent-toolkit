import sqlite3
import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path

from ..storage.store import MemoryStorage

logger = logging.getLogger(__name__)

TEMP_TTL_DAYS = 7
REFERENCE_ARCHIVE_DAYS = 90


def cleanup(storage: MemoryStorage) -> dict:
    """Run lifecycle cleanup: delete expired temp, archive stale reference."""
    now = datetime.utcnow()
    temp_cutoff = (now - timedelta(days=TEMP_TTL_DAYS)).isoformat()
    ref_cutoff = (now - timedelta(days=REFERENCE_ARCHIVE_DAYS)).isoformat()

    # Delete expired temp memories
    rows = storage.db.execute(
        "SELECT id FROM memories WHERE tier = 'temp' AND created_at < ?", (temp_cutoff,)
    ).fetchall()
    temp_deleted = 0
    for row in rows:
        if storage.delete(row["id"]):
            temp_deleted += 1

    # Archive stale reference memories (not accessed in 90 days)
    archived = storage.db.execute(
        "UPDATE memories SET tier = 'archived' WHERE tier = 'reference' AND (last_accessed_at IS NULL AND created_at < ? OR last_accessed_at < ?)",
        (ref_cutoff, ref_cutoff)
    ).rowcount
    storage.db.commit()

    logger.info(f"Lifecycle: deleted {temp_deleted} temp, archived {archived} reference")
    return {"temp_deleted": temp_deleted, "reference_archived": archived}


async def schedule_daily_cleanup(storage: MemoryStorage):
    """Background task: run cleanup once per day."""
    while True:
        await asyncio.sleep(86400)  # 24 hours
        try:
            cleanup(storage)
        except Exception as e:
            logger.error(f"Lifecycle cleanup error: {e}")
