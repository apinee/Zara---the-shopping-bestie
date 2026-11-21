"""
Seed VibeCart's catalogue from DummyJSON (https://dummyjson.com) fashion categories.

- Product IDs are kept identical to DummyJSON IDs so `add_to_cart` can mirror
  the cart to DummyJSON `POST /carts/add` (the external API shown in the demo).
- USD prices are converted to INR and rounded to a "...99" price point.
- Colour is inferred from the title/description (DummyJSON has no colour field).
- Images use DummyJSON's CDN thumbnails directly (no local download).

Usage:
    python scripts/seed_products.py            # upsert DummyJSON products
    python scripts/seed_products.py --replace  # also DELETE every non-DummyJSON product
                                               # (cascades to cart_items referencing them)
"""
import asyncio
import json
import os
import re
import sys
from pathlib import Path

import asyncpg
import httpx
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env.local")
load_dotenv(ROOT_DIR / ".env")

DUMMYJSON = "https://dummyjson.com"
USD_TO_INR = 85

# DummyJSON category slug -> (gender, category, article_type, size labels)
APPAREL = ["S", "M", "L", "XL"]
SHOES = ["6", "7", "8", "9", "10"]
ONE = ["One Size"]
CATEGORIES = {
    "mens-shirts": ("Men", "Apparel", "Shirts", APPAREL),
    "mens-shoes": ("Men", "Footwear", "Shoes", SHOES),
    "mens-watches": ("Men", "Accessories", "Watches", ONE),
    "womens-dresses": ("Women", "Apparel", "Dresses", APPAREL),
    "tops": ("Women", "Apparel", "Tops", APPAREL),
    "womens-shoes": ("Women", "Footwear", "Shoes", SHOES),
    "womens-bags": ("Women", "Accessories", "Bags", ONE),
    "womens-jewellery": ("Women", "Accessories", "Jewellery", ONE),
    "womens-watches": ("Women", "Accessories", "Watches", ONE),
    "sunglasses": ("Unisex", "Accessories", "Sunglasses", ONE),
}

COLOURS = [
    "black", "white", "blue", "navy", "red", "green", "yellow", "pink", "purple",
    "orange", "brown", "grey", "gray", "beige", "gold", "silver", "maroon", "olive",
]


def infer_colour(title: str, description: str) -> str:
    """Return the colour mentioned earliest in the title (then description), e.g. 'Blue & Black' -> Blue."""
    pattern = re.compile(rf"\b({'|'.join(COLOURS)})\b")
    for text in (title, description):
        match = pattern.search(text.lower())
        if match:
            colour = match.group(1)
            return "Grey" if colour == "gray" else colour.capitalize()
    return "Multi"


def to_inr(usd: float) -> int:
    raw = int(round(usd * USD_TO_INR))
    return max(199, (raw // 100) * 100 + 99)


def split_stock(stock: int, labels: list[str]) -> dict[str, int]:
    """Spread DummyJSON's single stock number across sizes (deterministic, uneven on purpose)."""
    if len(labels) == 1:
        return {labels[0]: stock}
    # Middle sizes get most stock; XL gets ~10%, so "only 1 left in XL" happens naturally
    weights = [2, 4, 3, 1] if len(labels) == 4 else [1, 2, 3, 2, 1]
    sizes = {label: stock * w // sum(weights) for label, w in zip(labels, weights)}
    sizes[labels[1]] += stock - sum(sizes.values())  # remainder to the 2nd size
    return sizes


async def fetch_products() -> list[tuple]:
    rows = []
    async with httpx.AsyncClient(timeout=20.0) as client:
        for slug, (gender, category, article_type, labels) in CATEGORIES.items():
            resp = await client.get(f"{DUMMYJSON}/products/category/{slug}", params={"limit": 0})
            resp.raise_for_status()
            for p in resp.json()["products"]:
                stock = int(p.get("stock") or 0)
                rows.append(
                    (
                        int(p["id"]),
                        p["title"],
                        gender,
                        category,
                        article_type,
                        infer_colour(p["title"], p.get("description", "")),
                        to_inr(float(p["price"])),
                        stock,
                        json.dumps(split_stock(stock, labels)),
                        p.get("thumbnail") or (p.get("images") or [None])[0],
                    )
                )
            print(f"  {slug}: {len(resp.json()['products'])} products")
    return rows


async def main(replace: bool) -> None:
    print("Fetching fashion products from DummyJSON...")
    rows = await fetch_products()

    # Direct (unpooled) connection for bulk writes
    dsn = os.getenv("DATABASE_URL_UNPOOLED") or os.environ["DATABASE_URL"]
    conn = await asyncpg.connect(dsn=dsn, statement_cache_size=0)
    try:
        async with conn.transaction():
            await conn.executemany(
                """
                INSERT INTO products (id, name, gender, category, article_type, colour, price_inr, stock, sizes, image_url)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
                ON CONFLICT (id) DO UPDATE SET
                    name = EXCLUDED.name,
                    gender = EXCLUDED.gender,
                    category = EXCLUDED.category,
                    article_type = EXCLUDED.article_type,
                    colour = EXCLUDED.colour,
                    price_inr = EXCLUDED.price_inr,
                    stock = EXCLUDED.stock,
                    sizes = EXCLUDED.sizes,
                    image_url = EXCLUDED.image_url
                """,
                rows,
            )
            if replace:
                deleted = await conn.execute(
                    "DELETE FROM products WHERE NOT (id = ANY($1::int[]))",
                    [r[0] for r in rows],
                )
                print(f"Removed old non-DummyJSON products: {deleted}")
    finally:
        await conn.close()
    print(f"Done! Upserted {len(rows)} DummyJSON products.")


if __name__ == "__main__":
    asyncio.run(main(replace="--replace" in sys.argv))
