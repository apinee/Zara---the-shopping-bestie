"""
Apply db/schema.sql and db/memory_graph.sql (both idempotent) without needing psql.

    python scripts/migrate.py
"""
import asyncio
import os
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env.local")
load_dotenv(ROOT_DIR / ".env")

FILES = ["db/schema.sql", "db/memory_graph.sql"]


async def main() -> None:
    dsn = os.getenv("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
    conn = await asyncpg.connect(dsn=dsn, statement_cache_size=0)
    try:
        for rel_path in FILES:
            sql = (ROOT_DIR / rel_path).read_text(encoding="utf-8")
            await conn.execute(sql)  # no params -> simple protocol, multiple statements allowed
            print(f"Applied {rel_path}")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(main())
