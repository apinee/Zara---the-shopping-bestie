# 🛍️ VibeCart: Shop by Talking

> *"Arre, blue shirt again yaar? Fine fine, Option 1 is 899 rupees and it's too good macha."*
> — **Zara**, your sassy-but-kind Bengaluru shopping bestie

VibeCart replaces search bars, filters and twelve-step checkouts with **one conversation**. You talk, Zara listens. She pulls products onto your screen live, adds them to your cart, remembers that you hate yellow and wear a size 9 in shoes, teases you about your colour habits, and checks you out with a real (test-mode) Razorpay order. You never touch a dropdown.

## 🎬 Product Demo

[![Watch the VibeCart demo](https://cdn.loom.com/sessions/thumbnails/691b3e819ec94e71a4f10c46ab56bb63-with-play.gif)](https://www.loom.com/share/691b3e819ec94e71a4f10c46ab56bb63)

▶️ **[Watch the full demo on Loom](https://www.loom.com/share/691b3e819ec94e71a4f10c46ab56bb63)**  ·  🎞️ **[Download the demo video (MP4)](docs/vibecart-demo.mp4)**

---

## ✨ What makes it fun

| | |
|---|---|
| 🗣️ **Real-time voice, real interruptions** | Talk over Zara mid-sentence and she stops to listen. It's full duplex, with AI voice activity detection, not push-to-talk. |
| 🪄 **Products appear as she speaks** | Say "show me red shirts" and **Option 1, 2, 3** pop up on screen while Zara reads out the top picks. Say "the second one" and it's in your cart. |
| 💬 **She never goes quiet** | Every tool call returns a `speak` hint, so after each search, cart change, coupon or checkout, Zara says out loud what just happened. |
| 🧠 **She actually remembers you** | Her memory is a graph in Postgres. Things you *tell* her (sizes, colours you love or avoid, budget) stick for good. Things she *notices* (what you cart, buy or remove) fade over about 45 days. |
| 🎯 **Recommendations that explain themselves** | `recommend_for_me` walks the graph: you → traits you like → matching products, minus anything you avoid, plus what similar shoppers bought. Each pick comes with *reasons* and a note on whether it's in stock in your size. |
| 🕸️ **A memory graph you can watch** | The side panel draws Zara's brain about you in real time, as a live node graph of preferences, sizes and purchases. |
| 💸 **A checkout that really happens** | Zara confirms the item, size and total *verbally*, creates a Razorpay order, reads out your order and tracking ID, and you tap **Pay**. The backend verifies the signature with HMAC. |
| 🇮🇳 **Bengaluru flavour** | Hinglish sprinkled in ("scene kya hai", "pakka", "too good macha"), with prices always spoken as "rupees" so the TTS never trips on ₹. |

---

## 🧩 How it works

```
 🎙️ You ──► Agora RTC ──► Agora Conversational AI Engine
                              │  Deepgram (ASR) → LLM (Gemini, OpenAI-compatible) → Murf Falcon (TTS, en-IN)
                              │
                              └── MCP tools (FastMCP, streamable HTTP :8001/mcp)
                                     search_products · recommend_for_me · add_to_cart · remove_from_cart
                                     view_cart · apply_coupon · checkout · get_order_status
                                     remember_preference · recall_memory · get_purchase_history
                                            │
                                            ▼
                              Neon Postgres (catalogue, carts, orders, memory graph)
                                            │
 🖥️ Next.js storefront ◄── FastAPI :8000 ◄──┘   (live showcase, cart, memory graph, tool log)
```

1. **`/call/start`** loads your memory from Postgres (including the strongest graph facts), builds Zara's personality prompt, and starts an Agora agent in your channel.
2. When you speak, the LLM calls **MCP tools**. Each tool writes to Postgres, logs itself for the UI, and returns a short result that includes a `speak` hint telling Zara what to say next.
3. The storefront polls the tool log, so search results become **live option cards**, and the cart and memory graph update as you talk.
4. **`/call/stop`** summarises the call into one line of memory, so next time Zara picks up where you left off.

## 🛠️ Stack

- **Voice / orchestration:** Agora Conversational AI Engine v2 + Agora RTC Web SDK
- **ASR:** Deepgram  ·  **TTS:** Murf Falcon (`en-IN`)
- **LLM:** Gemini via its OpenAI-compatible endpoint (`LLM_URL` / `LLM_API_KEY` / `LLM_MODEL`). OpenAI and Neon AI Gateway also work as fallbacks.
- **Tools:** FastMCP (`streamable-http` on port `8001` at `/mcp`)
- **Database:** Neon Postgres (`db/schema.sql`, `db/memory_graph.sql`), with PINs hashed using pgcrypto bcrypt
- **Catalogue & external cart API:** DummyJSON (`/products`, `POST /carts/add`)
- **Payments:** Razorpay Test Mode
- **Frontend:** Next.js (`web/`)

---

## 🚀 Run it locally

### 1. Environment & database
```bash
cp .env.example .env        # fill in your keys
python scripts/migrate.py   # applies db/schema.sql + db/memory_graph.sql (idempotent, no psql needed)
```

<details>
<summary><b>Environment variables</b></summary>

`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `AGORA_APP_ID`, `AGORA_APP_CERTIFICATE`, `AGORA_CUSTOMER_ID`, `AGORA_CUSTOMER_SECRET`, `MURF_API_KEY`, `MURF_VOICE_ID`, `DEEPGRAM_API_KEY`, `LLM_URL`, `LLM_API_KEY`, `LLM_MODEL`, `MCP_PUBLIC_URL`, `MCP_INTERNAL_URL`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `NEXT_PUBLIC_BACKEND_URL`
</details>

### 2. Python environment
```bash
python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r backend/requirements.txt
```

### 3. Seed fashion products
```bash
python scripts/seed_products.py            # upsert ~100 products (ids = DummyJSON ids)
python scripts/seed_products.py --replace  # also delete any non-DummyJSON products
```

### 4. MCP server (port 8001)
```bash
python mcp_server/server.py
ngrok http 8001   # put https://<tunnel>.ngrok-free.app/mcp into MCP_PUBLIC_URL
```

### 5. Backend (port 8000)
```bash
uvicorn backend.main:app --reload --port 8000
```

### 6. Web app (port 3000)
```bash
cd web && npm install && npm run dev
```

Open **http://localhost:3000**, sign in with a name and a 4-digit PIN, hit **Talk to Zara**, and say:

> *"Hey Zara, show me something red under 1500."*

---

## 🧠 The memory graph (`db/memory_graph.sql`)

Zara's long-term memory is a property graph stored in plain Postgres (`mem_nodes` and `mem_edges`):

- **Explicit memories** (`remember_preference`) never decay: `PREFERS`, `AVOIDS`, and `WEARS_SIZE` for each category (`apparel:M`, `footwear:9`).
- **Implicit memories** come from `add_to_cart`, `remove_from_cart` and `checkout`, and fade over about 45 days: `LIKES` a colour, item type or price band, plus `CARTED`, `BOUGHT` and `REMOVED`.
- `mem_facts(user)` returns the strongest memories first. They go into Zara's system prompt before every call and feed the UI graph.
- `mem_recommend(user)` turns the graph into ranked picks, each with reasons and whether it's in stock in your size.

## 🧪 Try saying…

- "Show me blue shirts." → options appear, and Zara names the top two with prices
- "I'll take option two." → added to cart, and Zara confirms the size and price
- "I hate yellow, by the way." → saved as an AVOIDS memory, and yellow never shows up again
- "What would I like?" → graph-powered picks, with reasons
- "Apply ZARA20." → coupon applied, with celebration
- "Checkout." → Zara confirms verbally, creates the order, reads out the tracking ID, and you tap **Pay**

---

<p align="center"><i>Built with way too much chai in Bengaluru ☕ · Ask Zara anything, except to stop teasing your colour choices.</i></p>
