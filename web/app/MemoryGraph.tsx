"use client";

import React, { useEffect, useRef, useState } from "react";

export interface GraphEdge {
  rel: string;
  group: "prefers" | "likes" | "avoids" | "size" | "bought" | "carted" | "removed";
  kind: string;
  label: string;
  score: number;
  explicit: boolean;
}

const GROUP_STYLE: Record<GraphEdge["group"], { color: string; dashed?: boolean; legend: string }> = {
  prefers: { color: "#a78bfa", legend: "prefers" },
  likes: { color: "#60a5fa", legend: "picks often" },
  size: { color: "#fbbf24", legend: "size" },
  bought: { color: "#34d399", legend: "bought" },
  carted: { color: "#9ca3af", legend: "carted" },
  avoids: { color: "#f87171", dashed: true, legend: "avoids" },
  removed: { color: "#6b7280", dashed: true, legend: "removed" },
};
// Layout order: related memories sit next to each other on the ring
const GROUP_ORDER: GraphEdge["group"][] = ["size", "prefers", "likes", "avoids", "bought", "carted", "removed"];

const GROUP_VERB: Record<GraphEdge["group"], string> = {
  prefers: "prefers",
  likes: "likes",
  size: "wears",
  bought: "bought",
  carted: "carted",
  avoids: "avoids",
  removed: "removed",
};

// Wide viewBox + short radius leaves room for side labels so they aren't clipped at the panel edge
const W = 400;
const H = 260;
const CX = W / 2;
const CY = H / 2;
const R = 88;
const LABEL_CHARS = 14;
const FRESH_MS = 4000;

const edgeKey = (e: GraphEdge) => `${e.rel}:${e.kind}:${e.label}`;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Radial memory graph. Positions are stable (sorted by group then label, not by score), so the
 * graph doesn't reshuffle on every poll; memories that are new or just got stronger pulse for a few
 * seconds, which is what makes it feel live during a call.
 */
export default function MemoryGraph({
  center,
  edges,
  live = false,
}: {
  center: string;
  /** undefined = not loaded yet (so the first real load becomes the baseline instead of "all new") */
  edges: GraphEdge[] | undefined;
  live?: boolean;
}) {
  const previousScores = useRef<Map<string, number> | null>(null);
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const [lastLearned, setLastLearned] = useState<string | null>(null);

  // Diff against the previous poll to find new / strengthened memories
  useEffect(() => {
    if (!edges) return;
    const prev = previousScores.current;
    const next = new Map(edges.map((e) => [edgeKey(e), e.score]));
    previousScores.current = next;
    if (!prev) return; // first render: everything is "existing", nothing pulses

    const now = Date.now();
    const changed = edges.filter((e) => {
      const before = prev.get(edgeKey(e));
      return before === undefined || e.score > before + 0.01;
    });
    if (changed.length === 0) return;

    setFresh((f) => {
      const out = { ...f };
      changed.forEach((e) => (out[edgeKey(e)] = now));
      return out;
    });
    const top = changed[0];
    setLastLearned(`${GROUP_VERB[top.group] || top.rel.toLowerCase()} ${top.label}`);

    const timer = setTimeout(() => {
      const cutoff = Date.now() - FRESH_MS;
      setFresh((f) => Object.fromEntries(Object.entries(f).filter(([, t]) => t > cutoff)));
    }, FRESH_MS + 50);
    return () => clearTimeout(timer);
  }, [edges]);

  if (!edges || !edges.length) {
    return (
      <p style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "8px" }}>
        Memory graph is empty. Tell Zara your size or a colour you love and watch it grow.
      </p>
    );
  }

  const ordered = [...edges].sort(
    (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.label.localeCompare(b.label)
  );
  const groupsPresent = GROUP_ORDER.filter((g) => edges.some((e) => e.group === g));
  const anyFresh = Object.keys(fresh).length > 0;

  return (
    <div className={`memory-graph ${live ? "is-live" : ""}`} style={{ marginBottom: "10px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Memory graph for ${center}`}>
        {ordered.map((e, i) => {
          const angle = (2 * Math.PI * i) / ordered.length - Math.PI / 2;
          const x = CX + R * Math.cos(angle);
          const y = CY + R * Math.sin(angle);
          const style = GROUP_STYLE[e.group] || GROUP_STYLE.likes;
          const isFresh = Boolean(fresh[edgeKey(e)]);
          const right = Math.cos(angle) > 0.2;
          const left = Math.cos(angle) < -0.2;
          const nodeR = 4 + Math.min(Math.abs(e.score), 6);
          return (
            <g key={edgeKey(e)} className={isFresh ? "mg-fresh" : undefined}>
              <line
                className="mg-edge"
                x1={CX}
                y1={CY}
                x2={x}
                y2={y}
                stroke={style.color}
                strokeOpacity={isFresh ? 1 : 0.5}
                strokeWidth={1 + Math.min(Math.abs(e.score), 6) * 0.45}
                strokeDasharray={style.dashed ? "4 3" : isFresh ? "6 4" : undefined}
              />
              {isFresh && <circle className="mg-ripple" cx={x} cy={y} r={nodeR + 2} fill="none" stroke={style.color} />}
              <circle
                className="mg-node"
                cx={x}
                cy={y}
                r={nodeR}
                fill={e.explicit ? style.color : "#141720"}
                stroke={style.color}
                strokeWidth={2}
              >
                <title>
                  {e.rel} {e.kind}: {e.label} · strength {e.score}
                  {e.explicit ? " · told Zara" : " · learned"}
                </title>
              </circle>
              <text
                x={x + (right ? nodeR + 4 : left ? -nodeR - 4 : 0)}
                y={y + (right || left ? 3.5 : Math.sin(angle) > 0 ? nodeR + 11 : -nodeR - 5)}
                textAnchor={right ? "start" : left ? "end" : "middle"}
                fontSize="10"
                fontWeight={isFresh ? 700 : 400}
                fill={isFresh ? "#ffffff" : "#d1d5db"}
              >
                {truncate(e.label, LABEL_CHARS)}
              </text>
            </g>
          );
        })}
        <circle className="mg-center" cx={CX} cy={CY} r={20} fill="#7c3aed" />
        <text x={CX} y={CY + 4} textAnchor="middle" fontSize="11" fontWeight={700} fill="#fff">
          {truncate(center, 8)}
        </text>
      </svg>

      <p className={`mg-learned ${anyFresh ? "is-visible" : ""}`} aria-live="polite">
        {lastLearned ? <>🧠 Just learned: <strong>{lastLearned}</strong></> : " "}
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", fontSize: "10px", color: "#9ca3af" }}>
        {groupsPresent.map((g) => (
          <span key={g} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            <span
              style={{
                width: "12px",
                height: 0,
                borderTop: `2px ${GROUP_STYLE[g].dashed ? "dashed" : "solid"} ${GROUP_STYLE[g].color}`,
              }}
            />
            {GROUP_STYLE[g].legend}
          </span>
        ))}
        <span>● filled = you told Zara</span>
      </div>
    </div>
  );
}
