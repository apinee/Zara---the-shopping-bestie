"""Read the Postgres memory graph (db/memory_graph.sql) for Zara's system prompt and the UI."""
from typing import Any, Dict, List


async def get_facts(conn: Any, user_id: int, limit: int = 40) -> List[Dict[str, Any]]:
    rows = await conn.fetch("SELECT * FROM mem_facts($1) WHERE score > 0.05 LIMIT $2", user_id, limit)
    return [dict(r) for r in rows]


def _why(f: Dict[str, Any]) -> str:
    if f["source"] == "explicit":
        return "told you"
    return f"{f['hits']}x from cart/orders"


def facts_to_prompt(facts: List[Dict[str, Any]]) -> str:
    """Compact, voice-friendly summary of the graph for the system prompt."""
    if not facts:
        return "- (empty — first time shopper; learn their size and taste as you go)"

    by_rel: Dict[str, List[Dict[str, Any]]] = {}
    for f in facts:
        by_rel.setdefault(f["rel"], []).append(f)

    lines = []
    if by_rel.get("WEARS_SIZE"):
        # Strongest size per category only
        seen, sizes = set(), []
        for f in by_rel["WEARS_SIZE"]:
            cat = f["key"].split(":")[0]
            if cat not in seen:
                seen.add(cat)
                sizes.append(f"{f['label']} [{_why(f)}]")
        lines.append("- Sizes: " + "; ".join(sizes))
    if by_rel.get("PREFERS"):
        lines.append("- Prefers: " + ", ".join(f"{f['kind']} {f['label']}" for f in by_rel["PREFERS"][:8]) + " [told you]")
    if by_rel.get("AVOIDS"):
        lines.append("- AVOIDS (never push these): " + ", ".join(f"{f['kind']} {f['label']}" for f in by_rel["AVOIDS"][:8]))
    likes = [f for f in by_rel.get("LIKES", []) if f["kind"] != "price_band"]
    if likes:
        lines.append("- Habitually picks: " + ", ".join(f"{f['label']} ({f['hits']}x)" for f in likes[:6]))
    bands = [f for f in by_rel.get("LIKES", []) if f["kind"] == "price_band"]
    if bands:
        lines.append(f"- Usual price band: {bands[0]['label']}")
    if by_rel.get("BOUGHT"):
        lines.append("- Bought before: " + ", ".join(f"{f['label']} ({f['hits']}x)" for f in by_rel["BOUGHT"][:6]))
    bought = {f["label"] for f in by_rel.get("BOUGHT", [])}
    abandoned = [f["label"] for f in by_rel.get("CARTED", []) if f["label"] not in bought]
    if abandoned:
        lines.append("- Carted but never bought (tease gently): " + ", ".join(abandoned[:4]))
    if by_rel.get("REMOVED"):
        lines.append("- Changed mind about: " + ", ".join(f["label"] for f in by_rel["REMOVED"][:4]))
    return "\n".join(lines)


EDGE_GROUP = {
    "PREFERS": "prefers", "LIKES": "likes", "AVOIDS": "avoids", "WEARS_SIZE": "size",
    "BOUGHT": "bought", "CARTED": "carted", "REMOVED": "removed",
}


def facts_to_graph(facts: List[Dict[str, Any]], name: str, max_nodes: int = 14) -> Dict[str, Any]:
    """Nodes/edges for the radial 'What Zara knows' graph (user at the centre)."""
    bought = {f["label"] for f in facts if f["rel"] == "BOUGHT"}
    edges = []
    for f in facts:
        if f["rel"] == "CARTED" and f["label"] in bought:
            continue  # BOUGHT already says it
        edges.append(
            {
                "rel": f["rel"],
                "group": EDGE_GROUP.get(f["rel"], "likes"),
                "kind": f["kind"],
                "label": f["label"],
                "score": round(float(f["score"]), 2),
                "explicit": f["source"] == "explicit",
            }
        )
        if len(edges) >= max_nodes:
            break
    return {"center": name, "edges": edges}
