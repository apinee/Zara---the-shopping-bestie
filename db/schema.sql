-- VibeCart Postgres Schema (Neon)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Users (Name + 4-digit PIN hashed with bcrypt via pgcrypto)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    pin_hash TEXT NOT NULL,
    last_call_summary TEXT DEFAULT 'First time shopping with Zara!',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Products (Seeded from DummyJSON fashion categories; id = DummyJSON product id)
CREATE TABLE IF NOT EXISTS products (
    id INT PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT,
    category TEXT,
    article_type TEXT,
    colour TEXT,
    price_inr INT NOT NULL,
    stock INT NOT NULL DEFAULT 0,
    sizes JSONB NOT NULL DEFAULT '{}'::jsonb,
    image_url TEXT
);

-- 3. User Preferences (Key-value memory saved by Zara)
CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, key)
);

-- 4. Shopping Cart Items
CREATE TABLE IF NOT EXISTS cart_items (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    size TEXT NOT NULL DEFAULT 'M',
    qty INT NOT NULL DEFAULT 1,
    UNIQUE (user_id, product_id, size)
);

-- 5. Coupons & Applied User Coupons
CREATE TABLE IF NOT EXISTS coupons (
    code TEXT PRIMARY KEY,
    discount_pct INT NOT NULL CHECK (discount_pct > 0 AND discount_pct <= 90),
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS user_coupons (
    user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    coupon_code TEXT NOT NULL REFERENCES coupons(code)
);

INSERT INTO coupons (code, discount_pct, active) VALUES
    ('VIBE10', 10, TRUE),
    ('ZARA20', 20, TRUE),
    ('BLR15', 15, TRUE)
ON CONFLICT (code) DO NOTHING;

-- 6. Orders (Razorpay test orders + purchase history)
CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    razorpay_order_id TEXT UNIQUE,
    amount_inr INT NOT NULL,
    discount_inr INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'created',
    items JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
-- Added for the order confirmation card (safe to re-run on an existing database)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_id TEXT;

-- 7. User Memory View (Injected into Zara's system prompt & right-side UI panel)
CREATE OR REPLACE VIEW user_memory AS
SELECT
    u.id AS user_id,
    u.name,
    COALESCE(
        (
            SELECT jsonb_object_agg(up.key, up.value)
            FROM user_preferences up
            WHERE up.user_id = u.id
        ),
        '{}'::jsonb
    ) AS preferences,
    COALESCE(
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'order_id', o.id,
                    'razorpay_order_id', o.razorpay_order_id,
                    'tracking_id', o.tracking_id,
                    'amount_inr', o.amount_inr,
                    'status', o.status,
                    'items', o.items,
                    'created_at', o.created_at
                )
            )
            FROM (
                SELECT id, razorpay_order_id, tracking_id, amount_inr, status, items, created_at
                FROM orders
                WHERE user_id = u.id
                ORDER BY created_at DESC
                LIMIT 5
            ) o
        ),
        '[]'::jsonb
    ) AS recent_purchases,
    u.last_call_summary
FROM users u;
