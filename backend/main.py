import hashlib
import hmac
import json
import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import agora, db, memory_graph, persona


@asynccontextmanager
async def lifespan(_: FastAPI):
    # TODO: Ensure DATABASE_URL is reachable before starting in production
    try:
        await db.init_db()
    except Exception as exc:
        print(f"[warn] Database pool not initialized at startup: {exc}")
    yield
    await db.close_db()


app = FastAPI(title="VibeCart Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class LoginRequest(BaseModel):
    name: str = Field(..., min_length=1)
    pin: str = Field(..., pattern=r"^\d{4}$")


class CallStartRequest(BaseModel):
    user_id: int
    channel: Optional[str] = None


class CallStopRequest(BaseModel):
    agent_id: str
    user_id: Optional[int] = None


class PaymentVerifyRequest(BaseModel):
    razorpay_order_id: str
    razorpay_payment_id: str
    razorpay_signature: str


@app.post("/login")
async def login(req: LoginRequest):
    """
    Sign in or register a user with name + 4-digit PIN using Postgres pgcrypto bcrypt (`bf`).
    """
    pool = await db.get_pool()
    clean_name = req.name.strip()

    async with pool.acquire() as conn:
        existing = await conn.fetchrow(
            """
            SELECT id, name, (pin_hash = crypt($2, pin_hash)) AS pin_ok
            FROM users
            WHERE LOWER(name) = LOWER($1)
            """,
            clean_name,
            req.pin,
        )
        if existing:
            if not existing["pin_ok"]:
                raise HTTPException(status_code=401, detail="Invalid 4-digit PIN")
            return {"user_id": existing["id"], "name": existing["name"], "is_new": False}

        created = await conn.fetchrow(
            """
            INSERT INTO users (name, pin_hash)
            VALUES ($1, crypt($2, gen_salt('bf')))
            RETURNING id, name
            """,
            clean_name,
            req.pin,
        )
        return {"user_id": created["id"], "name": created["name"], "is_new": True}


@app.post("/call/start")
async def call_start(req: CallStartRequest):
    """
    Load user memory, build Zara's system prompt, mint Agora RTC tokens, and join Zara to the channel.
    """
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM user_memory WHERE user_id = $1",
            req.user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        memory = dict(row)
        try:
            memory["graph_facts"] = memory_graph.facts_to_prompt(await memory_graph.get_facts(conn, req.user_id))
        except Exception as exc:
            # Graph not migrated yet -> Zara still works with the flat memory
            print(f"[warn] memory graph unavailable: {exc}")

    channel = req.channel or f"vibecart-{req.user_id}-{uuid.uuid4().hex[:6]}"
    user_uid = 1000 + int(req.user_id)
    user_token = agora.generate_rtc_token(channel, user_uid)

    system_prompt = persona.build_system_prompt(memory)
    greeting = f"Hey {memory['name']}! Scene kya hai yaar, what are we shopping for today?"

    try:
        agent_resp = await agora.start_agent(
            channel=channel,
            user_uid=user_uid,
            system_prompt=system_prompt,
            greeting_message=greeting,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return {
        "agent_id": agent_resp.get("agent_id"),
        "channel": channel,
        "token": user_token,
        "uid": user_uid,
        "app_id": os.environ["AGORA_APP_ID"],
    }


@app.post("/call/stop")
async def call_stop(req: CallStopRequest):
    """Summarize the call into users.last_call_summary, then stop the Agora agent."""
    summary = None
    if req.user_id is not None:
        # History is only available while the agent is still running, so read it before leaving
        try:
            summary = await agora.summarize_call(await agora.get_history(req.agent_id))
        except Exception as exc:
            print(f"[warn] Could not summarize call {req.agent_id}: {exc}")
        if summary:
            pool = await db.get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE users SET last_call_summary = $2 WHERE id = $1",
                    req.user_id,
                    summary,
                )

    try:
        result = await agora.leave(req.agent_id)
    except httpx.HTTPStatusError as exc:
        # Agent may have already left on idle_timeout
        result = {"ok": False, "status": exc.response.status_code}
    return {"stopped": True, "summary": summary, "agora": result}


@app.get("/config")
async def get_config():
    """Public client config (Razorpay key id is safe to expose; the secret is not)."""
    return {"razorpay_key_id": os.getenv("RAZORPAY_KEY_ID", "")}


@app.post("/payment/verify")
async def verify_payment(req: PaymentVerifyRequest):
    """Verify a Razorpay Checkout signature and mark the order as paid."""
    key_secret = os.getenv("RAZORPAY_KEY_SECRET", "")
    if not key_secret:
        raise HTTPException(status_code=500, detail="RAZORPAY_KEY_SECRET is not set")

    expected = hmac.new(
        key_secret.encode(),
        f"{req.razorpay_order_id}|{req.razorpay_payment_id}".encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, req.razorpay_signature):
        raise HTTPException(status_code=400, detail="Invalid payment signature")

    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE orders SET status = 'paid'
            WHERE razorpay_order_id = $1
            RETURNING id, amount_inr, status
            """,
            req.razorpay_order_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Order not found")
    return dict(row)


@app.get("/cart/{user_id}")
async def get_cart(user_id: int):
    """Return user's active cart items, applied coupon, and ₹ totals."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.id, c.product_id, c.size, c.qty,
                   p.name, p.price_inr, p.colour, p.image_url
            FROM cart_items c
            JOIN products p ON p.id = c.product_id
            WHERE c.user_id = $1
            ORDER BY c.id ASC
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
    discount_inr = int(round(subtotal * discount_pct / 100.0))
    return {
        "user_id": user_id,
        "items": items,
        "coupon_code": coupon["coupon_code"] if coupon else None,
        "discount_pct": discount_pct,
        "subtotal_inr": subtotal,
        "discount_inr": discount_inr,
        "total_inr": max(0, subtotal - discount_inr),
    }


@app.get("/memory/{user_id}")
async def get_memory(user_id: int):
    """Return the user_memory view row for the right-side panel."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM user_memory WHERE user_id = $1",
            user_id,
        )
        if not row:
            raise HTTPException(status_code=404, detail="User not found")
        data = dict(row)
        try:
            data["graph"] = memory_graph.facts_to_graph(await memory_graph.get_facts(conn, user_id), data["name"])
        except Exception:
            data["graph"] = {"center": data["name"], "edges": []}

    for field in ("preferences", "recent_purchases"):
        if isinstance(data.get(field), str):
            data[field] = json.loads(data[field])
    return data


@app.get("/tool-log/{user_id}")
async def get_tool_log(user_id: int):
    """Fetch recent MCP tool invocations for this user from the MCP server's in-memory log."""
    mcp_base = os.getenv("MCP_INTERNAL_URL", "http://localhost:8001")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{mcp_base}/tool-log/{user_id}")
            resp.raise_for_status()
            return resp.json()
    except Exception:
        return {"user_id": user_id, "logs": []}


@app.get("/products")
async def list_products(limit: int = 48):
    """Return products for the storefront grid."""
    pool = await db.get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, name, gender, category, article_type, colour, price_inr, stock, sizes, image_url
            FROM products
            ORDER BY id ASC
            LIMIT $1
            """,
            limit,
        )
    return {"products": [dict(r) for r in rows]}
