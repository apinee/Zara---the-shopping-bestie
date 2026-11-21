import os
from pathlib import Path
from typing import Optional
import asyncpg
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env.local", override=True)
load_dotenv(ROOT_DIR / ".env")

_pool: Optional[asyncpg.Pool] = None


async def init_db() -> asyncpg.Pool:
    """Create or return the shared asyncpg connection pool using pooled DATABASE_URL."""
    global _pool
    if _pool is None:
        dsn = os.getenv("DATABASE_URL")
        if not dsn:
            raise RuntimeError("DATABASE_URL is not set in environment (.env.local or .env)")
        # statement_cache_size=0 ensures compatibility with Neon PgBouncer transaction pooling (-pooler)
        _pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=10, statement_cache_size=0)
    return _pool


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        return await init_db()
    return _pool


async def close_db() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
