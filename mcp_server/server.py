import json
import os
import secrets
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
import asyncpg
import httpx
import razorpay
import uvicorn
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse

ROOT_DIR = Path(__file__).resolve().parents[1]
load_dotenv(ROOT_DIR / ".env.local")
load_dotenv(ROOT_DIR / ".env")

mcp = FastMCP("vibecart", stateless_http=True, host="0.0.0.0", port=8001)

# In-memory tool log read by the backend via GET /tool-log/{user_id}
TOOL_LOG: List[Dict[str, Any]] = []
LAST_SHOWCASE: Dict[str, Any] = {"query": "", "items": [], "timestamp": 0}
_pool: Optional[asyncpg.Pool] = None


def set_showcase(query_label: str, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Number the options (1, 2, 3...) and save them for the real-time UI showcase & option picking."""
    numbered: List[Dict[str, Any]] = []
    for idx, item in enumerate(items[:6]):
        row = dict(item)
        if isinstance(row.get("sizes"), str):
            try:
                row["sizes"] = json.loads(row["sizes"])
            except Exception:
                pass
        row["option"] = idx + 1
        numbered.append(row)
    LAST_SHOWCASE["query"] = query_label
    LAST_SHOWCASE["items"] = numbered
    LAST_SHOWCASE["timestamp"] = int(time.time())
    return numbered


def _in_stock_sizes(sizes: Any) -> List[str]:
    if isinstance(sizes, str):
        try:
            sizes = json.loads(sizes)
        except Exception:
            return []
    if isinstance(sizes, dict):
        return [k for k, v in sizes.items() if int(v or 0) > 0]
    return []


def spoken_options(numbered: List[Dict[str, Any]], what: str) -> Dict[str, Any]:
    """
    Slim, voice-friendly tool result: the full rows (images, size maps) go to the on-screen showcase,
    the LLM only gets what it needs to talk, plus a `speak` hint so it never goes silent after the call.
    """
    options = [
        {
            "option": it["option"],
            "product_id": it.get("id"),
            "name": it.get("name"),
            "colour": it.get("colour"),
            "price_rupees": it.get("price_inr"),
            "sizes_in_stock": _in_stock_sizes(it.get("sizes")),
            **({"reasons": it["reasons"]} if it.get("reasons") else {}),
        }
        for it in numbered
    ]
    if not options:
        speak = (
            f"Tell the shopper you couldn't find any {what} right now, and suggest a different colour, "
            "item or budget to try."
        )
    else:
        top = "; ".join(f"Option {o['option']}, {o['name']}, {o['price_rupees']} rupees" for o in options[:2])
        speak = (
            f"Say that {len(options)} {what} options are now on their screen. Mention {top}. "
            "Then ask which option they want."
        )
    return {"shown_on_screen": True, "options": options, "speak": speak}


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(
            dsn=os.environ["DATABASE_URL"],
            min_size=1,
            max_size=5,
            statement_cache_size=0,
        )
    return _pool


def log_tool(
    tool: str,
    args: Dict[str, Any],
    summary: str,
    status: str = "ok",
    user_id: Optional[int] = None,
    external: Optional[List[Dict[str, Any]]] = None,
    memory: Optional[List[str]] = None,
) -> None:
    """
    Record a tool call. `external` lists outbound API calls ({service, call, ok, detail});
    `memory` lists what the memory graph learned (e.g. "+Blue", "size M").
    """
    TOOL_LOG.append(
        {
            "id": len(TOOL_LOG) + 1,
            "tool": tool,
            "args": args,
            "summary": summary,
            "status": status,
            "user_id": user_id,
            "external": external or [],
            "memory": memory or [],
            "timestamp": int(time.time()),
        }
    )


async def learn(conn: Any, user_id: int, product_id: int, rel: str, delta: float, size: Optional[str] = None) -> List[str]:
    """Feed a cart/order action into the memory graph. Never breaks the calling tool."""
    try:
        return list(
            await conn.fetchval("SELECT mem_learn_product($1, $2, $3, $4, $5)", user_id, product_id, rel, delta, size)
            or []
        )
    except Exception as exc:
        print(f"[warn] memory graph learn failed: {exc}")
        return []


# Spoken preference keys -> graph node kinds
PREF_KIND_ALIASES = {
    "color": "colour", "colour": "colour", "fav_colour": "colour", "fav_color": "colour",
    "favourite_colour": "colour", "favorite_color": "colour",
    "size": "size", "shirt_size": "size", "shoe_size": "size", "dress_size": "size",
    "style": "style", "vibe": "style", "fit": "style", "occasion": "style",
    "brand": "brand", "budget": "budget", "max_budget": "budget",
    "category": "article_type", "article_type": "article_type", "item": "article_type", "type": "article_type",
}
SIZE_CATEGORY_HINTS = {"shoe": "Footwear", "footwear": "Footwear", "sneaker": "Footwear"}


def graph_key_for(key: str, value: str, category: Optional[str]) -> tuple[str, str, str]:
    """Return (kind, node_key, label) for a remembered preference."""
    k = key.strip().lower()
    kind = PREF_KIND_ALIASES.get(k, k.replace(" ", "_"))
    value = value.strip()
    if kind == "size":
        cat = category or next((c for hint, c in SIZE_CATEGORY_HINTS.items() if hint in k), "Apparel")
        cat = cat.strip().capitalize()
        return kind, f"{cat.lower()}:{value.upper()}", f"{value.upper()} ({cat})"
    return kind, value.lower(), value.title() if kind == "colour" else value


DUMMYJSON_URL = "https://dummyjson.com"
DUMMYJSON_MAX_PRODUCT_ID = 194  # catalogue is seeded with DummyJSON's own product IDs


async def mirror_cart_to_dummyjson(user_id: int, product_id: int, qty: int) -> Dict[str, Any]:
    """POST /carts/add on DummyJSON (simulated write; returns a fake cart). Never raises."""
    call = "POST /carts/add"
    if product_id > DUMMYJSON_MAX_PRODUCT_ID:
        return {"service": "DummyJSON", "call": call, "ok": False, "detail": "skipped: not a DummyJSON product"}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{DUMMYJSON_URL}/carts/add",
                json={
                    # DummyJSON only has users 1..208, so map our user id into that range
                    "userId": (user_id - 1) % 208 + 1,
                    "products": [{"id": product_id, "quantity": qty}],
                },
            )
        if resp.is_error:
            return {"service": "DummyJSON", "call": call, "ok": False, "detail": f"HTTP {resp.status_code}"}
        cart = resp.json()
        return {
            "service": "DummyJSON",
            "call": call,
            "ok": True,
            "detail": f"HTTP {resp.status_code} · cart #{cart.get('id')} · ${cart.get('total')}",
        }
    except Exception as exc:
        return {"service": "DummyJSON", "call": call, "ok": False, "detail": type(exc).__name__}


SPOKEN_SIZE_MAP = {
    "SMALL": "S",
    "MEDIUM": "M",
    "LARGE": "L",
    "EXTRA LARGE": "XL",
    "X-LARGE": "XL",
    "ONE SIZE": "One Size",
    "ONESIZE": "One Size",
    "FREE SIZE": "One Size",
}


def resolve_size(prod: Any, size: Optional[str] = "M") -> tuple[str, int]:
    """Map a requested size onto the product's size keys and return (size, available qty)."""
    sizes = prod["sizes"]
    if isinstance(sizes, str):
        sizes = json.loads(sizes)
    if not isinstance(sizes, dict) or not sizes:
        return (size or "M").upper(), int(prod["stock"])
    if len(sizes) == 1:
        # Accessories are seeded as a single "One Size" bucket
        only = next(iter(sizes))
        return only, int(sizes[only])

    raw = (size or "M").strip().upper()
    for prefix in ("SIZE ", "UK ", "US ", "EU "):
        if raw.startswith(prefix):
            raw = raw[len(prefix):].strip()
    key = SPOKEN_SIZE_MAP.get(raw, raw)

    # Exact case-insensitive match in product's size map
    for k, v in sizes.items():
        if k.upper() == key.upper():
            return k, int(v)

    # If the requested/default size (e.g. "M" on a shoe) isn't valid for this product,
    # pick a sensible default size that has stock (prefer "M" or "8", else highest stock).
    for preferred in ("M", "8", "9", "L", "7", "S"):
        if preferred in sizes and int(sizes[preferred]) > 0:
            return preferred, int(sizes[preferred])
    best_key, best_qty = max(sizes.items(), key=lambda kv: int(kv[1]))
    return best_key, int(best_qty)


@mcp.custom_route("/tool-log/{user_id}", methods=["GET"])
async def http_get_tool_log(request: Request) -> JSONResponse:
    uid = int(request.path_params["user_id"])
    rows = [
        entry for entry in TOOL_LOG if entry["user_id"] in (None, uid)
    ][-25:]
    return JSONResponse({
        "user_id": uid,
        "logs": list(reversed(rows)),
        "showcase": LAST_SHOWCASE,
    })


@mcp.tool()
async def search_products(
    query: str = "",
    max_price: Optional[int] = None,
    category: Optional[str] = None,
    colour: Optional[str] = None,
    gender: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Search VibeCart products by keyword, max INR price, category, colour, and gender.
    Automatically displays the returned options in real time on the shopper's screen as Option 1, Option 2, etc.
    After it returns, ALWAYS speak to the shopper using the `speak` hint.
    """
    args = {
        "query": query,
        "max_price": max_price,
        "category": category,
        "colour": colour,
        "gender": gender,
    }
    # Every word must match somewhere ("blue shirt" -> "Blue & Black Check Shirt"); crude de-pluralise
    words = [w.rstrip("s") if len(w) > 3 else w for w in (query or "").lower().split()]
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, name, gender, category, article_type, colour, price_inr, stock, sizes, image_url
                FROM products
                WHERE NOT EXISTS (
                        SELECT 1 FROM unnest($1::text[]) AS w
                        WHERE NOT (name ILIKE '%' || w || '%' OR article_type ILIKE '%' || w || '%'
                                   OR colour ILIKE '%' || w || '%' OR category ILIKE '%' || w || '%')
                      )
                  AND ($2::int IS NULL OR price_inr <= $2)
                  AND ($3::text IS NULL OR category ILIKE '%' || $3 || '%' OR article_type ILIKE '%' || $3 || '%')
                  AND ($4::text IS NULL OR colour ILIKE '%' || $4 || '%')
                  AND ($5::text IS NULL OR gender ILIKE $5 || '%')
                ORDER BY stock DESC, price_inr ASC
                LIMIT 6
                """,
                words,
                max_price,
                category,
                colour,
                gender,
            )
            # If strict AND matching found nothing (e.g. "red shorts"), fall back to closest OR matches
            if not rows and (words or colour or category):
                search_terms = list(words)
                if colour:
                    search_terms.append(colour.strip().lower())
                if category:
                    search_terms.append(category.strip().lower().rstrip("s"))
                rows = await conn.fetch(
                    """
                    SELECT id, name, gender, category, article_type, colour, price_inr, stock, sizes, image_url,
                           (
                             SELECT COUNT(*) FROM unnest($1::text[]) AS w
                             WHERE name ILIKE '%' || w || '%' OR article_type ILIKE '%' || w || '%'
                                OR colour ILIKE '%' || w || '%' OR category ILIKE '%' || w || '%'
                           ) AS match_hits
                    FROM products
                    WHERE EXISTS (
                            SELECT 1 FROM unnest($1::text[]) AS w
                            WHERE name ILIKE '%' || w || '%' OR article_type ILIKE '%' || w || '%'
                               OR colour ILIKE '%' || w || '%' OR category ILIKE '%' || w || '%'
                          )
                      AND ($2::int IS NULL OR price_inr <= $2)
                    ORDER BY match_hits DESC, stock DESC, price_inr ASC
                    LIMIT 6
                    """,
                    search_terms,
                    max_price,
                )
        label_parts = [p for p in (colour, query or category, f"under ₹{max_price}" if max_price else None) if p]
        query_label = " ".join(label_parts) or "All picks"
        results = set_showcase(query_label, [dict(r) for r in rows])
        log_tool("search_products", args, f"Showing {len(results)} options for '{query_label}'", "ok")
        spoken_label = query_label.replace("under ₹", "under ") + (" rupees" if max_price else "")
        return spoken_options(results, spoken_label)
    except Exception as exc:
        log_tool("search_products", args, str(exc), "error")
        return {"error": str(exc), "speak": "Apologise that the search glitched and ask them to say it again."}


@mcp.tool()
async def get_product(id: int) -> Dict[str, Any]:
    """Fetch full details for a single product by product ID."""
    args = {"id": id}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow("SELECT * FROM products WHERE id = $1", id)
        if not row:
            log_tool("get_product", args, f"Product #{id} not found", "error")
            return {"error": "Product not found"}
        item = dict(row)
        log_tool("get_product", args, f"{item['name']} (₹{item['price_inr']})", "ok")
        item["speak"] = f"Describe {item['name']} in one line, say it's {item['price_inr']} rupees, and ask if they want it."
        return item
    except Exception as exc:
        log_tool("get_product", args, str(exc), "error")
        return {"error": str(exc)}


@mcp.tool()
async def check_stock(id: int, size: str = "M") -> Dict[str, Any]:
    """Check whether a product ID has stock available in the requested size."""
    args = {"id": id, "size": size}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, name, stock, sizes FROM products WHERE id = $1",
                id,
            )
        if not row:
            log_tool("check_stock", args, f"Product #{id} not found", "error")
            return {"error": "Product not found"}
        size_key, size_qty = resolve_size(row, size)
        in_stock = size_qty > 0
        log_tool(
            "check_stock",
            args,
            f"{row['name']} ({size_key}): {size_qty} left",
            "ok",
        )
        return {
            "product_id": id,
            "name": row["name"],
            "size": size_key,
            "available_qty": size_qty,
            "in_stock": in_stock,
            "speak": (
                f"Tell them {row['name']} is available in size {size_key} and ask if you should add it to the cart."
                if in_stock
                else f"Tell them {row['name']} is sold out in size {size_key} and offer another size or option."
            ),
        }
    except Exception as exc:
        log_tool("check_stock", args, str(exc), "error")
        return {"error": str(exc)}


@mcp.tool()
async def add_to_cart(
    user_id: int,
    product_id: Optional[int] = None,
    product_name: Optional[str] = None,
    option_number: Optional[int] = None,
    size: str = "M",
    qty: int = 1,
) -> Dict[str, Any]:
    """
    Add a product to the shopper's cart. Call this whenever the shopper says "add to cart",
    "I'll take option 1", "give me the second one", "put this in my cart", or asks to buy/cart a product.
    You can pass:
    - `option_number` (1, 2, 3... matching the Option # currently shown on screen from the last search), OR
    - `product_id` (exact integer ID), OR
    - `product_name` (e.g. "Man Plaid Shirt", "Red Shoes").
    If they didn't mention a size, omit `size` and an available size will be chosen automatically.
    """
    args = {
        "user_id": user_id,
        "product_id": product_id,
        "product_name": product_name,
        "option_number": option_number,
        "size": size,
        "qty": qty,
    }
    try:
        if product_id is None and option_number is not None:
            shown = LAST_SHOWCASE.get("items") or []
            idx = int(option_number) - 1
            if 0 <= idx < len(shown):
                product_id = int(shown[idx]["id"])
        # Also handle if the LLM passed a small option index (1..6) as product_id when those aren't real product IDs
        if product_id is not None and 1 <= int(product_id) <= len(LAST_SHOWCASE.get("items") or []):
            shown_ids = {int(it["id"]) for it in (LAST_SHOWCASE.get("items") or [])}
            if int(product_id) not in shown_ids:
                product_id = int(LAST_SHOWCASE["items"][int(product_id) - 1]["id"])
        pool = await get_pool()
        async with pool.acquire() as conn:
            prod = None
            if product_id is not None:
                prod = await conn.fetchrow(
                    "SELECT id, name, price_inr, stock, sizes FROM products WHERE id = $1",
                    int(product_id),
                )
            if not prod and product_name:
                words = [w.rstrip("s") if len(w) > 3 else w for w in product_name.lower().split()]
                prod = await conn.fetchrow(
                    """
                    SELECT id, name, price_inr, stock, sizes
                    FROM products
                    WHERE name ILIKE '%' || $1 || '%'
                       OR NOT EXISTS (
                            SELECT 1 FROM unnest($2::text[]) AS w
                            WHERE NOT (name ILIKE '%' || w || '%' OR article_type ILIKE '%' || w || '%'
                                       OR colour ILIKE '%' || w || '%' OR category ILIKE '%' || w || '%')
                          )
                    ORDER BY (CASE WHEN name ILIKE '%' || $1 || '%' THEN 0 ELSE 1 END), stock DESC
                    LIMIT 1
                    """,
                    product_name.strip(),
                    words,
                )
            if not prod:
                target = f"#{product_id}" if product_id is not None else f"'{product_name}'"
                log_tool("add_to_cart", args, f"Product {target} not found", "error", user_id)
                return {
                    "error": f"Product {target} not found",
                    "speak": "Say you couldn't find that one and ask which option number they meant.",
                }

            real_id = int(prod["id"])
            resolved_size, available = resolve_size(prod, size)
            if available < qty:
                msg = f"{prod['name']} ({resolved_size}) has only {available} left"
                log_tool("add_to_cart", args, msg, "error", user_id)
                return {
                    "error": msg,
                    "available_qty": available,
                    "speak": f"Tell them {msg}, and offer another size or a similar option.",
                }

            await conn.execute(
                """
                INSERT INTO cart_items (user_id, product_id, size, qty)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, product_id, size)
                DO UPDATE SET qty = cart_items.qty + EXCLUDED.qty
                """,
                user_id,
                real_id,
                resolved_size,
                qty,
            )
            learned = await learn(conn, user_id, real_id, "CARTED", 1.0, resolved_size)
        # Postgres is the source of truth; the DummyJSON mirror is best-effort and never blocks the cart
        external = await mirror_cart_to_dummyjson(user_id, real_id, qty)
        summary = f"Added {qty}x {prod['name']} ({resolved_size}) — {prod['price_inr']} rupees"
        log_tool("add_to_cart", args, summary, "ok", user_id, [external], learned)
        return {
            "ok": True,
            "product_id": real_id,
            "name": prod["name"],
            "size": resolved_size,
            "qty": qty,
            "price_inr": prod["price_inr"],
            "message": summary,
            "speak": (
                f"Confirm {prod['name']} in size {resolved_size} for {prod['price_inr']} rupees is in their cart, "
                "hype the pick, and ask if they want anything else or want to check out."
            ),
        }
    except Exception as exc:
        log_tool("add_to_cart", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def remove_from_cart(
    user_id: int,
    product_id: int,
    size: Optional[str] = None,
    qty: Optional[int] = None,
) -> Dict[str, Any]:
    """Remove a product from the user's cart. Pass qty to remove only that many; omit it to remove the item entirely."""
    args = {"user_id": user_id, "product_id": product_id, "size": size, "qty": qty}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            if qty:
                await conn.execute(
                    """
                    UPDATE cart_items SET qty = qty - $4
                    WHERE user_id = $1 AND product_id = $2 AND ($3::text IS NULL OR size = UPPER($3))
                    """,
                    user_id,
                    product_id,
                    size,
                    qty,
                )
            await conn.execute(
                """
                DELETE FROM cart_items
                WHERE user_id = $1 AND product_id = $2 AND ($3::text IS NULL OR size = UPPER($3))
                  AND ($4::int IS NULL OR qty <= 0)
                """,
                user_id,
                product_id,
                size,
                qty,
            )
            # Changing your mind is a (weak) negative signal
            learned = await learn(conn, user_id, product_id, "REMOVED", -1.0)
        summary = f"Removed {qty or 'all'} of product #{product_id}" + (f" ({size.upper()})" if size else "")
        log_tool("remove_from_cart", args, summary, "ok", user_id, None, learned)
        return {
            "ok": True,
            "message": summary,
            "speak": "Confirm it's out of their cart and ask what they'd like instead.",
        }
    except Exception as exc:
        log_tool("remove_from_cart", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def view_cart(user_id: int) -> Dict[str, Any]:
    """View items and ₹ totals in the user's shopping cart."""
    args = {"user_id": user_id}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT c.product_id, c.size, c.qty, p.name, p.price_inr
                FROM cart_items c
                JOIN products p ON p.id = c.product_id
                WHERE c.user_id = $1
                """,
                user_id,
            )
            coupon = await conn.fetchrow(
                """
                SELECT uc.coupon_code, cp.discount_pct
                FROM user_coupons uc
                JOIN coupons cp ON cp.code = uc.coupon_code
                WHERE uc.user_id = $1 AND cp.active = TRUE
                """,
                user_id,
            )
        items = [dict(r) for r in rows]
        subtotal = sum(i["price_inr"] * i["qty"] for i in items)
        discount_pct = coupon["discount_pct"] if coupon else 0
        discount = int(round(subtotal * discount_pct / 100.0))
        total = max(0, subtotal - discount)
        log_tool("view_cart", args, f"{len(items)} items, Total ₹{total}", "ok", user_id)
        return {
            "items": items,
            "coupon": coupon["coupon_code"] if coupon else None,
            "subtotal_inr": subtotal,
            "discount_inr": discount,
            "total_inr": total,
            "speak": (
                f"Tell them they have {len(items)} item{'s' if len(items) != 1 else ''} in the cart, "
                f"total {total} rupees, and ask if they want to check out."
                if items
                else "Tell them the cart is empty and ask what they want to shop for."
            ),
        }
    except Exception as exc:
        log_tool("view_cart", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def apply_coupon(user_id: int, code: str) -> Dict[str, Any]:
    """Apply a promo coupon code (e.g., VIBE10, ZARA20, BLR15) to the user's cart."""
    args = {"user_id": user_id, "code": code}
    clean_code = code.strip().upper()
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            coupon = await conn.fetchrow(
                "SELECT code, discount_pct FROM coupons WHERE code = $1 AND active = TRUE",
                clean_code,
            )
            if not coupon:
                log_tool("apply_coupon", args, f"Invalid coupon {clean_code}", "error", user_id)
                return {
                    "error": f"Coupon {clean_code} is invalid or expired",
                    "speak": f"Tell them {clean_code} didn't work, sweetly.",
                }

            await conn.execute(
                """
                INSERT INTO user_coupons (user_id, coupon_code)
                VALUES ($1, $2)
                ON CONFLICT (user_id) DO UPDATE SET coupon_code = EXCLUDED.coupon_code
                """,
                user_id,
                clean_code,
            )
        summary = f"Applied {clean_code} ({coupon['discount_pct']}% off)"
        log_tool("apply_coupon", args, summary, "ok", user_id)
        return {
            "ok": True,
            "coupon": clean_code,
            "discount_pct": coupon["discount_pct"],
            "speak": f"Celebrate that {clean_code} gave them {coupon['discount_pct']} percent off.",
        }
    except Exception as exc:
        log_tool("apply_coupon", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def checkout(user_id: int) -> Dict[str, Any]:
    """
    Create a Razorpay test order for the user's current cart and insert a row in `orders`.
    Call ONLY after explicit confirmation from the user.
    """
    args = {"user_id": user_id}
    try:
        cart = await view_cart(user_id)
        items = cart.get("items") or []
        if not items:
            log_tool("checkout", args, "Cart is empty", "error", user_id)
            return {"error": "Cart is empty", "speak": "Tell them the cart is empty, so nothing to check out yet."}

        total_inr = int(cart["total_inr"])
        discount_inr = int(cart["discount_inr"])

        key_id = os.getenv("RAZORPAY_KEY_ID", "")
        key_secret = os.getenv("RAZORPAY_KEY_SECRET", "")
        rzp_order_id = f"order_test_{int(time.time())}"
        tracking_id = f"VBC{secrets.token_hex(4).upper()}IN"
        external: List[Dict[str, Any]] = []

        if key_id and key_secret and not key_id.startswith("your_"):
            client = razorpay.Client(auth=(key_id, key_secret))
            rzp_order = client.order.create(
                {
                    "amount": total_inr * 100,  # paise
                    "currency": "INR",
                    "receipt": f"vibecart_u{user_id}_{int(time.time())}",
                    "payment_capture": 1,
                    "notes": {"tracking_id": tracking_id},
                }
            )
            rzp_order_id = rzp_order["id"]
            external.append(
                {"service": "Razorpay", "call": "POST /v1/orders", "ok": True, "detail": rzp_order_id}
            )
        else:
            external.append(
                {"service": "Razorpay", "call": "POST /v1/orders", "ok": False, "detail": "skipped: keys not set"}
            )

        pool = await get_pool()
        async with pool.acquire() as conn, conn.transaction():
            # Decrement per-size stock; abort the whole order if anything sold out meanwhile
            for item in items:
                prod = await conn.fetchrow(
                    "SELECT id, name, stock, sizes FROM products WHERE id = $1 FOR UPDATE",
                    item["product_id"],
                )
                size_key, available = resolve_size(prod, item["size"])
                if available < item["qty"]:
                    raise ValueError(f"{prod['name']} ({size_key}) has only {available} left")
                await conn.execute(
                    """
                    UPDATE products
                    SET stock = GREATEST(stock - $2, 0),
                        sizes = CASE WHEN sizes ? $3
                                     THEN jsonb_set(sizes, ARRAY[$3], to_jsonb(GREATEST((sizes->>$3)::int - $2, 0)))
                                     ELSE sizes END
                    WHERE id = $1
                    """,
                    item["product_id"],
                    item["qty"],
                    size_key,
                )
            order_row = await conn.fetchrow(
                """
                INSERT INTO orders (user_id, razorpay_order_id, tracking_id, amount_inr, discount_inr, status, items)
                VALUES ($1, $2, $3, $4, $5, 'created', $6::jsonb)
                RETURNING id, razorpay_order_id, tracking_id, amount_inr, status
                """,
                user_id,
                rzp_order_id,
                tracking_id,
                total_inr,
                discount_inr,
                json.dumps(items),
            )
            await conn.execute("DELETE FROM cart_items WHERE user_id = $1", user_id)
            await conn.execute("DELETE FROM user_coupons WHERE user_id = $1", user_id)

        # Purchases are the strongest implicit signal (outside the order transaction on purpose)
        learned: List[str] = []
        async with pool.acquire() as conn:
            for item in items:
                learned += await learn(conn, user_id, item["product_id"], "BOUGHT", 3.0 * item["qty"], item["size"])

        summary = f"Order #{order_row['id']} created (₹{total_inr}) · tracking {tracking_id}"
        log_tool("checkout", args, summary, "ok", user_id, external, sorted(set(learned)))
        return {
            "order_id": order_row["id"],
            "tracking_id": order_row["tracking_id"],
            "razorpay_order_id": order_row["razorpay_order_id"],
            "amount_inr": order_row["amount_inr"],
            "currency": "INR",
            "razorpay_key_id": key_id,
            "status": order_row["status"],
            "speak": (
                f"Read out order number {order_row['id']} and tracking ID {order_row['tracking_id']}, "
                f"total {order_row['amount_inr']} rupees, then tell them to tap the Pay button on screen."
            ),
        }
    except Exception as exc:
        log_tool("checkout", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def get_order_status(order_id: int) -> Dict[str, Any]:
    """Check the status and payment info of an order by order_id."""
    args = {"order_id": order_id}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT id, user_id, razorpay_order_id, tracking_id, amount_inr, status, created_at FROM orders WHERE id = $1",
                order_id,
            )
        if not row:
            log_tool("get_order_status", args, f"Order #{order_id} not found", "error")
            return {"error": "Order not found"}
        data = dict(row)
        data["created_at"] = str(data["created_at"])
        data["speak"] = f"Tell them order {order_id} is {data['status']}, tracking ID {data['tracking_id']}."
        log_tool("get_order_status", args, f"Order #{order_id}: {data['status']}", "ok", data["user_id"])
        return data
    except Exception as exc:
        log_tool("get_order_status", args, str(exc), "error")
        return {"error": str(exc)}


@mcp.tool()
async def get_purchase_history(user_id: int) -> Dict[str, Any]:
    """Retrieve the user's past orders and purchased items."""
    args = {"user_id": user_id}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, razorpay_order_id, tracking_id, amount_inr, status, items, created_at
                FROM orders
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 10
                """,
                user_id,
            )
        history = []
        for r in rows:
            d = dict(r)
            d["created_at"] = str(d["created_at"])
            if isinstance(d.get("items"), str):
                d["items"] = json.loads(d["items"])
            history.append(d)
        log_tool("get_purchase_history", args, f"Fetched {len(history)} past orders", "ok", user_id)
        return {
            "orders": history,
            "speak": (
                "Summarise their last couple of buys in one line and playfully tease any repeat habit."
                if history
                else "Tell them this is their first order with you and you're excited."
            ),
        }
    except Exception as exc:
        log_tool("get_purchase_history", args, str(exc), "error", user_id)
        return {"error": str(exc), "speak": "Say you couldn't pull up their orders right now."}


@mcp.tool()
async def remember_preference(
    user_id: int,
    key: str,
    value: str,
    sentiment: str = "like",
    category: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Save something the shopper TOLD you into their memory graph. Call it whenever they state a
    size, colour, style/vibe, brand, budget or item type they like or dislike.
    - key: 'size' | 'colour' | 'style' | 'brand' | 'budget' | 'article_type' (e.g. Shirts, Dresses)
    - value: e.g. 'M', '9', 'Blue', 'oversized', '2000'
    - sentiment: 'like' (default) or 'dislike' (e.g. "I hate yellow" -> key='colour', value='Yellow', sentiment='dislike')
    - category: for sizes only, 'Apparel' (default) or 'Footwear' (e.g. shoe size 9 -> category='Footwear')
    """
    args = {"user_id": user_id, "key": key, "value": value, "sentiment": sentiment, "category": category}
    sentiment = "dislike" if sentiment.strip().lower() in ("dislike", "hate", "avoid", "no") else "like"
    try:
        kind, node_key, label = graph_key_for(key, value, category)
        pool = await get_pool()
        async with pool.acquire() as conn:
            # Flat key/value copy kept for the UI chips and backwards compatibility
            pref_key = kind if kind != "size" else f"size_{node_key.split(':')[0]}"
            await conn.execute(
                """
                INSERT INTO user_preferences (user_id, key, value, updated_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (user_id, key)
                DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
                """,
                user_id,
                pref_key if sentiment == "like" else f"avoid_{kind}",
                label,
            )
            fact = await conn.fetchval(
                "SELECT mem_remember($1, $2, $3, $4, $5)", user_id, kind, node_key, label, sentiment
            )
        summary = f"Remembered: {fact}"
        log_tool("remember_preference", args, summary, "ok", user_id, None, [fact])
        return {
            "ok": True,
            "remembered": fact,
            "speak": f"Casually acknowledge you'll remember that ({value}) and carry on helping them shop.",
        }
    except Exception as exc:
        log_tool("remember_preference", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def recall_memory(user_id: int) -> Dict[str, Any]:
    """
    Read the shopper's memory graph: sizes per category, colours/styles/items they prefer or avoid,
    and products they carted or bought. Use when they ask "what's my size?" / "what did I buy?" /
    "you know my taste" — or before suggesting things.
    """
    args = {"user_id": user_id}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT * FROM mem_facts($1) WHERE score > 0.05 LIMIT 40", user_id)
        grouped: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            grouped.setdefault(r["rel"], []).append(
                {"kind": r["kind"], "value": r["label"], "strength": round(r["score"], 2),
                 "times": r["hits"], "told_by_user": r["source"] == "explicit"}
            )
        log_tool("recall_memory", args, f"Recalled {len(rows)} memories", "ok", user_id)
        if not grouped:
            return {
                "note": "No memories yet — first time shopper.",
                "speak": "Say you're still learning their taste and ask what they like.",
            }
        return {**grouped, "speak": "Answer their question from these memories in one or two lines."}
    except Exception as exc:
        log_tool("recall_memory", args, str(exc), "error", user_id)
        return {"error": str(exc)}


@mcp.tool()
async def recommend_for_me(user_id: int, query: str = "", limit: int = 5) -> Dict[str, Any]:
    """
    Personalised picks from the memory graph (their liked colours/items/price band, minus things they
    avoid, plus what similar shoppers bought). Each result has `reasons` and `in_your_size`.
    Use for "suggest something", "what would I like?", or to pick between search results.
    Optional query narrows the item type (e.g. 'shirt', 'shoes').
    Results pop up on the shopper's screen; ALWAYS speak to them afterwards using the `speak` hint.
    """
    args = {"user_id": user_id, "query": query, "limit": limit}
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM mem_recommend($1, $2, $3)", user_id, max(1, min(limit, 10)), query or None
            )
        picks = [dict(r) for r in rows]
        for p in picks:
            # mem_recommend names the column product_id; the showcase, UI and option picking expect `id`
            p["id"] = p["product_id"]
            p["score"] = round(p["score"], 2)
        if not picks:
            return await search_products(query=query)
        async with pool.acquire() as conn:
            ids = [int(p["id"]) for p in picks]
            extra_rows = await conn.fetch(
                "SELECT id, sizes, image_url, stock FROM products WHERE id = ANY($1::int[])",
                ids,
            )
            extra_map = {int(r["id"]): dict(r) for r in extra_rows}
        for p in picks:
            ext = extra_map.get(int(p["id"]), {})
            p["sizes"] = ext.get("sizes")
            p["image_url"] = ext.get("image_url")
            p["stock"] = ext.get("stock", 10)
        picks = set_showcase(query or "Recommended for you", picks)
        top = f" — top: {picks[0]['name']}" if picks else ""
        log_tool("recommend_for_me", args, f"{len(picks)} picks from memory graph{top}", "ok", user_id)
        result = spoken_options(picks, f"{query} picks for you" if query else "personalised picks")
        result["speak"] += " Use one of the reasons to say why it suits them."
        return result
    except Exception as exc:
        log_tool("recommend_for_me", args, str(exc), "error", user_id)
        return {"error": str(exc), "speak": "Apologise that recommendations glitched and offer to search instead."}


if __name__ == "__main__":
    # Streamable HTTP MCP server on port 8001 at /mcp
    app = mcp.streamable_http_app()
    uvicorn.run(app, host="0.0.0.0", port=8001)
