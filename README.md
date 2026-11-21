# VibeCart: Shop by Talking

Voice-first shopping assistant with **Zara** (your sassy Bengaluru shopping bestie).

## Stack
- **Voice / Orchestration**: Agora Conversational AI Engine v2
- **TTS**: Murf Falcon (`en-IN`)
- **ASR**: Deepgram
- **LLM**: Gemini (`gemini-2.5-flash`) via its OpenAI-compatible endpoint (`LLM_URL` / `LLM_API_KEY` / `LLM_MODEL`)
- **Tools**: FastMCP (`streamable-http` on port `8001` at `/mcp`)
- **Database**: Neon Postgres (`db/schema.sql`)
- **Catalogue & external cart API**: DummyJSON (`/products`, `POST /carts/add`)
- **Payments**: Razorpay Test Mode (orders created by the `checkout` tool)
- **Frontend**: Next.js + Agora RTC Web SDK (`web/`)

## How to Run Each Part

### 1. Environment & Database
```bash
cp .env.example .env
# Fill in your API keys in .env
python scripts/migrate.py   # applies db/schema.sql + db/memory_graph.sql (idempotent, no psql needed)
```

### Memory graph (`db/memory_graph.sql`)
Zara's long-term memory is a property graph stored in Postgres (`mem_nodes` and `mem_edges`):
- **Explicit memories**, saved when the shopper says something (`remember_preference`), never decay: `PREFERS`, `AVOIDS`, and `WEARS_SIZE` for each category (`apparel:M`, `footwear:9`).
- **Implicit memories**, learned from `add_to_cart`, `remove_from_cart` and `checkout`, fade over about 45 days: `LIKES` a colour, item type or price band, `CARTED`, `BOUGHT`, `REMOVED`.
- `mem_facts(user)` returns the strongest memories first. They go into Zara's system prompt before `/join` and feed the UI graph.
- `mem_recommend(user)` walks the graph: user → liked traits → matching products, minus things the user avoids, plus what similar shoppers bought. It returns reasons and whether each item is in stock in the user's size (MCP tool `recommend_for_me`).

### 2. Python Virtual Environment & Dependencies
```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r backend/requirements.txt
```

### 3. Seed Fashion Products from DummyJSON
```bash
python scripts/seed_products.py            # upsert ~100 products (ids = DummyJSON ids)
python scripts/seed_products.py --replace  # also delete any non-DummyJSON products
```

### 4. Start the MCP Server (Port 8001)
```bash
python mcp_server/server.py
```
Expose port `8001` so Agora Conversational AI can reach `/mcp`:
```bash
ngrok http 8001
# Copy https://<tunnel>.ngrok-free.app/mcp into MCP_PUBLIC_URL in .env
```

### 5. Start the FastAPI Backend (Port 8000)
```bash
uvicorn backend.main:app --reload --port 8000
```

### 6. Start the Next.js Web App (Port 3000)
```bash
cd web
npm install
npm run dev
```
Open `http://localhost:3000`, log in with your Name + 4-digit PIN, and click **Talk to Zara**.
