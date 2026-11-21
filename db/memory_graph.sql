-- VibeCart memory graph: a small property graph inside Postgres.
-- Idempotent: safe to re-run (python scripts/migrate.py).
--
--   (user) -[PREFERS|AVOIDS]->  (colour|article_type|style|brand|budget|...)   explicit, never decays
--   (user) -[LIKES]->           (colour|article_type|price_band)               implicit, learned from cart/orders
--   (user) -[WEARS_SIZE]->      (size "apparel:M", "footwear:9")               per category
--   (user) -[CARTED|BOUGHT|REMOVED]-> (product)
--   (product) -> attributes come from the live `products` row via mem_product_attrs (no sync needed)
--
-- Implicit edges decay with a ~45 day time constant at read time; explicit ones don't.

CREATE TABLE IF NOT EXISTS mem_nodes (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    UNIQUE (kind, key)
);

CREATE TABLE IF NOT EXISTS mem_edges (
    src INT NOT NULL REFERENCES mem_nodes(id) ON DELETE CASCADE,
    rel TEXT NOT NULL,
    dst INT NOT NULL REFERENCES mem_nodes(id) ON DELETE CASCADE,
    weight REAL NOT NULL DEFAULT 0,
    hits INT NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'implicit' CHECK (source IN ('explicit', 'implicit')),
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (src, rel, dst)
);
CREATE INDEX IF NOT EXISTS mem_edges_dst_rel ON mem_edges (dst, rel);

-- Product -> attribute edges, derived from the catalogue
CREATE OR REPLACE VIEW mem_product_attrs AS
SELECT id AS product_id, 'colour' AS kind, lower(colour) AS key, colour AS label
FROM products WHERE colour IS NOT NULL AND colour <> 'Multi'
UNION ALL
SELECT id, 'article_type', lower(article_type), article_type
FROM products WHERE article_type IS NOT NULL
UNION ALL
SELECT id, 'price_band',
       CASE WHEN price_inr < 1000 THEN 'under-1000' WHEN price_inr < 2500 THEN '1000-2500' ELSE '2500-plus' END,
       CASE WHEN price_inr < 1000 THEN 'Under ₹1000' WHEN price_inr < 2500 THEN '₹1000–2500' ELSE '₹2500+' END
FROM products;

-- Get-or-create a node
CREATE OR REPLACE FUNCTION mem_node(p_kind TEXT, p_key TEXT, p_label TEXT) RETURNS INT
LANGUAGE sql AS $$
    INSERT INTO mem_nodes (kind, key, label)
    VALUES (p_kind, lower(trim(p_key)), p_label)
    ON CONFLICT (kind, key) DO UPDATE SET label = EXCLUDED.label
    RETURNING id
$$;

CREATE OR REPLACE FUNCTION mem_user_node(p_user INT) RETURNS INT
LANGUAGE sql AS $$
    SELECT mem_node('user', p_user::text, COALESCE((SELECT name FROM users WHERE id = p_user), p_user::text))
$$;

-- Reinforce (or create) an edge user -rel-> node
CREATE OR REPLACE FUNCTION mem_touch(
    p_user INT, p_rel TEXT, p_kind TEXT, p_key TEXT, p_label TEXT,
    p_delta REAL, p_source TEXT DEFAULT 'implicit'
) RETURNS VOID
LANGUAGE sql AS $$
    INSERT INTO mem_edges (src, rel, dst, weight, hits, source)
    VALUES (mem_user_node(p_user), p_rel, mem_node(p_kind, p_key, p_label), p_delta, 1, p_source)
    ON CONFLICT (src, rel, dst) DO UPDATE SET
        weight = mem_edges.weight + EXCLUDED.weight,
        hits = mem_edges.hits + 1,
        source = CASE WHEN mem_edges.source = 'explicit' THEN 'explicit' ELSE EXCLUDED.source END,
        last_seen = NOW()
$$;

-- Explicit memory: the shopper told Zara something. Sentiment 'like' | 'dislike'.
-- For kind='size', p_key must be "<category>:<SIZE>" and replaces any other size in that category.
CREATE OR REPLACE FUNCTION mem_remember(
    p_user INT, p_kind TEXT, p_key TEXT, p_label TEXT, p_sentiment TEXT DEFAULT 'like'
) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE
    v_user INT := mem_user_node(p_user);
    v_node INT := mem_node(p_kind, p_key, p_label);
BEGIN
    IF p_kind = 'size' THEN
        DELETE FROM mem_edges e USING mem_nodes n
        WHERE e.src = v_user AND e.rel = 'WEARS_SIZE' AND n.id = e.dst
          AND split_part(n.key, ':', 1) = split_part(lower(p_key), ':', 1) AND n.id <> v_node;
        PERFORM mem_touch(p_user, 'WEARS_SIZE', p_kind, p_key, p_label, 5, 'explicit');
        RETURN 'wears ' || p_label;
    ELSIF p_sentiment = 'dislike' THEN
        DELETE FROM mem_edges WHERE src = v_user AND dst = v_node AND rel IN ('PREFERS', 'LIKES');
        PERFORM mem_touch(p_user, 'AVOIDS', p_kind, p_key, p_label, 5, 'explicit');
        RETURN 'avoids ' || p_label;
    ELSE
        DELETE FROM mem_edges WHERE src = v_user AND dst = v_node AND rel = 'AVOIDS';
        PERFORM mem_touch(p_user, 'PREFERS', p_kind, p_key, p_label, 5, 'explicit');
        RETURN 'prefers ' || p_label;
    END IF;
END
$$;

-- Implicit memory: learn from a cart/order action on a product. Returns what was learned.
-- p_delta > 0 reinforces (CARTED 1, BOUGHT 3); p_delta < 0 weakens (REMOVED -1).
CREATE OR REPLACE FUNCTION mem_learn_product(
    p_user INT, p_product INT, p_rel TEXT, p_delta REAL, p_size TEXT DEFAULT NULL
) RETURNS TEXT[]
LANGUAGE plpgsql AS $$
DECLARE
    v_prod products%ROWTYPE;
    v_attr RECORD;
    v_learned TEXT[] := '{}';
BEGIN
    SELECT * INTO v_prod FROM products WHERE id = p_product;
    IF NOT FOUND THEN
        RETURN v_learned;
    END IF;

    PERFORM mem_touch(p_user, p_rel, 'product', v_prod.id::text, v_prod.name, abs(p_delta));

    FOR v_attr IN SELECT kind, key, label FROM mem_product_attrs WHERE product_id = v_prod.id LOOP
        PERFORM mem_touch(p_user, 'LIKES', v_attr.kind, v_attr.key, v_attr.label, (p_delta * 0.5)::real);
        v_learned := v_learned || ((CASE WHEN p_delta > 0 THEN '+' ELSE '−' END) || v_attr.label);
    END LOOP;

    IF p_delta > 0 AND p_size IS NOT NULL AND p_size <> 'One Size' THEN
        PERFORM mem_touch(
            p_user, 'WEARS_SIZE', 'size',
            lower(v_prod.category) || ':' || upper(p_size),
            upper(p_size) || ' (' || v_prod.category || ')',
            p_delta
        );
        v_learned := v_learned || ('size ' || upper(p_size));
    END IF;
    RETURN v_learned;
END
$$;

-- Everything Zara knows about a user, strongest first (implicit edges decayed by age)
CREATE OR REPLACE FUNCTION mem_facts(p_user INT)
RETURNS TABLE (rel TEXT, kind TEXT, key TEXT, label TEXT, score REAL, hits INT, source TEXT, last_seen TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
    SELECT e.rel, n.kind, n.key, n.label,
           (e.weight * CASE WHEN e.source = 'explicit' THEN 1
                            ELSE exp(-extract(epoch FROM NOW() - e.last_seen) / 86400.0 / 45) END)::real AS score,
           e.hits, e.source, e.last_seen
    FROM mem_edges e
    JOIN mem_nodes n ON n.id = e.dst
    WHERE e.src = (SELECT id FROM mem_nodes WHERE kind = 'user' AND key = p_user::text)
    ORDER BY score DESC
$$;

-- Graph traversal recommendations:
--   user -> (liked/preferred/avoided attributes) <- product      (taste match)
--   user -BOUGHT-> product <-BOUGHT- other user -BOUGHT-> product (co-purchase)
CREATE OR REPLACE FUNCTION mem_recommend(p_user INT, p_limit INT DEFAULT 5, p_query TEXT DEFAULT NULL)
RETURNS TABLE (
    product_id INT, name TEXT, price_inr INT, colour TEXT, article_type TEXT,
    score REAL, reasons TEXT[], your_size TEXT, in_your_size BOOLEAN
)
LANGUAGE sql STABLE AS $$
    WITH facts AS (SELECT * FROM mem_facts(p_user)),
    taste AS (
        SELECT kind, key, label, CASE WHEN rel = 'AVOIDS' THEN -score ELSE score END AS s
        FROM facts WHERE rel IN ('PREFERS', 'LIKES', 'AVOIDS')
    ),
    me AS (SELECT id FROM mem_nodes WHERE kind = 'user' AND key = p_user::text),
    bought AS (SELECT key::int AS pid FROM facts WHERE rel = 'BOUGHT' AND kind = 'product'),
    signals AS (
        SELECT pa.product_id AS pid, t.s,
               CASE WHEN t.s > 0 THEN 'you like ' || t.label ELSE 'you avoid ' || t.label END AS reason
        FROM mem_product_attrs pa
        JOIN taste t ON t.kind = pa.kind AND position(t.key IN pa.key) > 0
        UNION ALL
        SELECT pn2.key::int, 2.0, 'shoppers like you bought this'
        FROM mem_edges mine
        JOIN mem_edges other ON other.dst = mine.dst AND other.rel = 'BOUGHT' AND other.src <> mine.src
        JOIN mem_edges other2 ON other2.src = other.src AND other2.rel = 'BOUGHT' AND other2.dst <> mine.dst
        JOIN mem_nodes pn2 ON pn2.id = other2.dst AND pn2.kind = 'product'
        WHERE mine.src = (SELECT id FROM me) AND mine.rel = 'BOUGHT'
    ),
    scored AS (
        SELECT pid, sum(s)::real AS score,
               array_agg(DISTINCT reason) FILTER (WHERE s > 0) AS reasons
        FROM signals GROUP BY pid
    )
    SELECT p.id, p.name, p.price_inr, p.colour, p.article_type, sc.score, sc.reasons,
           sz.size,
           CASE WHEN sz.size IS NULL OR p.sizes ? 'One Size' THEN p.stock > 0
                ELSE COALESCE((p.sizes ->> sz.size)::int, 0) > 0 END AS in_your_size
    FROM scored sc
    JOIN products p ON p.id = sc.pid
    LEFT JOIN LATERAL (
        SELECT upper(split_part(f.key, ':', 2)) AS size
        FROM facts f
        WHERE f.rel = 'WEARS_SIZE' AND split_part(f.key, ':', 1) = lower(p.category)
        ORDER BY f.score DESC LIMIT 1
    ) sz ON TRUE
    WHERE sc.score > 0
      AND p.stock > 0
      AND p.id NOT IN (SELECT pid FROM bought)
      AND p.id NOT IN (SELECT ci.product_id FROM cart_items ci WHERE ci.user_id = p_user)
      AND (p_query IS NULL OR p_query = ''
           OR p.name ILIKE '%' || p_query || '%' OR p.article_type ILIKE '%' || p_query || '%')
    ORDER BY in_your_size DESC, sc.score DESC, p.price_inr ASC
    LIMIT p_limit
$$;

-- Deleting a user also deletes their graph node (edges cascade)
CREATE OR REPLACE FUNCTION mem_forget_user() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM mem_nodes WHERE kind = 'user' AND key = OLD.id::text;
    RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS users_forget_memory ON users;
CREATE TRIGGER users_forget_memory AFTER DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION mem_forget_user();

-- Backfill past orders into the graph (only for users who don't have a graph yet, so re-runs are no-ops)
DO $$
DECLARE
    r RECORD;
    item JSONB;
BEGIN
    FOR r IN
        SELECT o.user_id, jsonb_agg(elem) AS items
        FROM orders o, jsonb_array_elements(o.items) AS elem
        WHERE NOT EXISTS (SELECT 1 FROM mem_nodes n WHERE n.kind = 'user' AND n.key = o.user_id::text)
        GROUP BY o.user_id
    LOOP
        FOR item IN SELECT * FROM jsonb_array_elements(r.items) LOOP
            PERFORM mem_learn_product(r.user_id, (item ->> 'product_id')::int, 'BOUGHT', 3, item ->> 'size');
        END LOOP;
    END LOOP;
END
$$;
