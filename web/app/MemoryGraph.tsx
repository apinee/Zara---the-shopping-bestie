"use client";

import React from "react";

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

const W = 320;
const H = 250;
const CX = W / 2;
const CY = H / 2;
const R = 92;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export default function MemoryGraph({ center, edges }: { center: string; edges: GraphEdge[] }) {
  if (!edges.length) {
    return (
      <p style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "8px" }}>
        Memory graph is empty — tell Zara your size or a colour you love.
      </p>
    );
  }

  const groupsPresent = Array.from(new Set(edges.map((e) => e.group)));

  return (
    <div style={{ marginBottom: "10px" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Memory graph for ${center}`}>
        {edges.map((e, i) => {
          const angle = (2 * Math.PI * i) / edges.length - Math.PI / 2;
          const x = CX + R * Math.cos(angle);
          const y = CY + R * Math.sin(angle);
          const style = GROUP_STYLE[e.group] || GROUP_STYLE.likes;
          const right = Math.cos(angle) > 0.2;
          const left = Math.cos(angle) < -0.2;
          const nodeR = 4 + Math.min(Math.abs(e.score), 6);
          return (
            <g key={`${e.rel}-${e.label}`}>
              <line
                x1={CX}
                y1={CY}
                x2={x}
                y2={y}
                stroke={style.color}
                strokeOpacity={0.55}
                strokeWidth={1 + Math.min(Math.abs(e.score), 6) * 0.45}
                strokeDasharray={style.dashed ? "4 3" : undefined}
              />
              <circle
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
                fill="#d1d5db"
              >
                {truncate(e.label, 16)}
              </text>
            </g>
          );
        })}
        <circle cx={CX} cy={CY} r={20} fill="#7c3aed" />
        <text x={CX} y={CY + 4} textAnchor="middle" fontSize="11" fontWeight={700} fill="#fff">
          {truncate(center, 8)}
        </text>
      </svg>
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
