import { useEffect, useMemo, useRef } from "react";
import type { Finding } from "@vibesim/spec";
import type { Timeline } from "../lib/model.ts";
import { worstSeverity } from "../lib/model.ts";
import { edgeFlags, kindInfo, protocolInfo } from "../lib/explain.ts";
import { NodeIcon, nodeColor } from "./ui.tsx";

const MARKER_COLORS = ["actor", "edge", "entry", "code", "database", "cache", "messaging", "external", "compute", "unknown", "faint"] as const;
const markerColor = (c: (typeof MARKER_COLORS)[number]) => (c === "faint" ? "var(--text-faint)" : `var(--k-${c})`);

const COL_W = 172;
const HEAD_H = 70;
const ROW_H = 46;
const PAD_X = 24;
const PAD_Y = 18;

interface Props {
  timeline: Timeline;
  /** Index of the timeline item being played; items after it are dimmed. */
  active: number;
  /** 0..1 position of the packet along the active arrow. */
  progress: number;
  selected?: string;
  findingsByRef: Map<string, Finding[]>;
  onSelectItem(index: number): void;
  onSelectNode(id: string): void;
}

export function SequenceDiagram({ timeline, active, progress, selected, findingsByRef, onSelectItem, onSelectNode }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { participants, items } = timeline;
  const col = useMemo(() => new Map(participants.map((p, i) => [p.id, i])), [participants]);
  const x = (id: string) => PAD_X + (col.get(id) ?? 0) * COL_W + COL_W / 2;
  const y = (i: number) => PAD_Y + i * ROW_H + ROW_H / 2;
  const width = PAD_X * 2 + participants.length * COL_W;
  const height = PAD_Y * 2 + Math.max(items.length, 1) * ROW_H;

  // Activation bars: a synchronous call is "open" on the callee until it returns.
  const bars = useMemo(() => {
    const out: { id: string; start: number; end: number; color: string }[] = [];
    items.forEach((it, i) => {
      if (it.kind !== "call") return;
      const ret = items.findIndex((r, j) => j > i && r.kind === "return" && r.stepIndex === it.stepIndex);
      if (ret > i + 1) out.push({ id: it.to, start: i, end: ret, color: "var(--text-faint)" });
    });
    return out;
  }, [items]);

  // Keep the active row in view while playing.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const rowTop = HEAD_H + y(active) - ROW_H;
    const rowBottom = HEAD_H + y(active) + ROW_H;
    if (rowTop < el.scrollTop + HEAD_H) el.scrollTo({ top: Math.max(0, rowTop - HEAD_H), behavior: "smooth" });
    else if (rowBottom > el.scrollTop + el.clientHeight) el.scrollTo({ top: rowBottom - el.clientHeight + 24, behavior: "smooth" });
    const current = items[active];
    if (current) {
      const left = Math.min(x(current.from), x(current.to)) - COL_W;
      const right = Math.max(x(current.from), x(current.to)) + COL_W;
      if (left < el.scrollLeft) el.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
      else if (right > el.scrollLeft + el.clientWidth) el.scrollTo({ left: right - el.clientWidth, behavior: "smooth" });
    }
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="diagram-scroll" ref={scrollRef} data-testid="diagram">
      <div style={{ width, minWidth: "100%", position: "relative" }}>
        <div style={{ position: "sticky", top: 0, height: HEAD_H, zIndex: 2, background: "linear-gradient(var(--bg) 82%, transparent)" }}>
          {participants.map((p, i) => {
            const color = nodeColor(p.node);
            const sel = selected === p.node.id || (p.collapsed?.some((c) => c.id === selected) ?? false);
            const sev = worstSeverity(findingsByRef.get(p.node.id) ?? []);
            return (
              <button
                key={p.id}
                className="lifeline-head"
                onClick={() => onSelectNode(p.collapsed ? p.collapsed[0]!.id : p.node.id)}
                title={`${kindInfo(p.node.kind).title}: ${p.node.label}`}
                style={{
                  position: "absolute", left: PAD_X + i * COL_W + 8, top: 10, width: COL_W - 16, height: HEAD_H - 20,
                  borderRadius: 9, border: `1px solid ${sel ? "var(--accent)" : "var(--border-strong)"}`,
                  background: sel ? "var(--accent-soft)" : "var(--bg-elev)", cursor: "pointer", padding: "6px 9px",
                  textAlign: "left", display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 7px", alignContent: "center",
                  boxShadow: `inset 3px 0 0 ${color}`, borderStyle: p.node.confidence === "unresolved" ? "dashed" : "solid",
                }}
              >
                <span style={{ gridRow: "span 2", display: "grid", placeItems: "center" }}><NodeIcon kind={p.node.kind} size={17} color={color} /></span>
                <span className="ellipsis" style={{ fontSize: 12.5, fontWeight: 600 }}>{p.node.label}</span>
                <span className="ellipsis" style={{ fontSize: 11, color: "var(--text-faint)", display: "flex", gap: 5, alignItems: "center" }}>
                  {sev && <span className={`sev ${sev}`} />}
                  {p.collapsed && p.collapsed.length > 1 ? p.collapsed.map((c) => c.label).join(", ") : kindInfo(p.node.kind).title}
                </span>
              </button>
            );
          })}
        </div>
        <svg className="diagram-svg" width={width} height={height} role="img" aria-label="Sequence diagram of this flow">
          <defs>
            {MARKER_COLORS.flatMap((c) => ["solid", "open"].map((style) => (
              <marker key={`${c}-${style}`} id={`arrow-${style}-${c}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d={style === "solid" ? "M0,0 L10,5 L0,10 z" : "M1,1 L9,5 L1,9"} fill={style === "solid" ? markerColor(c) : "none"} stroke={markerColor(c)} strokeWidth="1.5" strokeLinejoin="round" />
              </marker>
            )))}
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {participants.map((p) => (
            <line key={p.id} x1={x(p.id)} x2={x(p.id)} y1={0} y2={height} stroke="var(--border-strong)" strokeDasharray="3 5" />
          ))}
          {bars.map((b, i) => (
            <rect key={i} x={x(b.id) - 4} y={y(b.start)} width={8} height={y(b.end) - y(b.start)} rx={2}
              fill="var(--bg-elev-2)" stroke="var(--border-strong)" opacity={b.start <= active ? 1 : 0.4} />
          ))}
          {items.map((it, i) => {
            const x1 = x(it.from);
            const x2 = x(it.to);
            const yy = y(i);
            const isCall = it.kind === "call";
            const toNode = participants[col.get(it.to) ?? 0]?.node;
            const group = isCall && toNode ? kindInfo(toNode.kind).group : "faint";
            const color = isCall && toNode ? nodeColor(toNode) : "var(--text-faint)";
            const dim = i > active;
            const isActive = i === active;
            const sel = isCall && selected === it.edge.id;
            const self = x1 === x2;
            const dir = x2 >= x1 ? 1 : -1;
            const sev = isCall ? worstSeverity(findingsByRef.get(it.edge.id) ?? []) : undefined;
            const flags = isCall ? edgeFlags(it.edge) : [];
            const proto = isCall ? protocolInfo(it.edge.protocol).label : "";
            const protoText = proto === "call" ? "" : proto;
            const text = isCall ? it.edge.label ?? "" : "";
            const maxChars = Math.max(10, Math.floor((Math.abs(x2 - x1) || COL_W) / 6.6));
            const unresolved = it.edge.confidence === "unresolved";
            const path = self
              ? `M${x1},${yy - 9} h34 v18 h-30`
              : `M${x1 + 6 * dir},${yy} L${x2 - 6 * dir},${yy}`;
            return (
              <g key={i} className="arrow-hit" opacity={dim ? 0.32 : 1} onClick={() => onSelectItem(i)} data-testid={isCall ? "step" : "return"} data-active={isActive || undefined}>
                {(isActive || sel) && <rect x={0} y={yy - ROW_H / 2 + 2} width={width} height={ROW_H - 4} fill="var(--accent-soft)" rx={6} />}
                <rect x={Math.min(x1, x2) - 8} y={yy - 20} width={Math.abs(x2 - x1) + (self ? 60 : 16)} height={34} fill="transparent" />
                <path className="arrow-line" d={path} fill="none" stroke={color} strokeWidth={isCall ? 1.8 : 1.2}
                  strokeDasharray={!isCall ? "4 4" : it.edge.mode === "async" || unresolved ? "6 4" : undefined}
                  markerEnd={`url(#arrow-${isCall && it.edge.mode === "sync" ? "solid" : "open"}-${group})`} />
                {isCall && (
                  <text x={self ? x1 + 40 : (x1 + x2) / 2} y={yy - 8} textAnchor={self ? "start" : "middle"} fontSize="11.5" fill="var(--text)">
                    {protoText && <tspan fontWeight="600" fill={color} fontFamily="var(--mono)" fontSize="10.5">{protoText}</tspan>}
                    <tspan dx={protoText ? 6 : 0}>{truncate(text, maxChars)}</tspan>
                  </text>
                )}
                {isCall && (flags.length > 0 || sev) && (
                  <text x={self ? x1 + 40 : (x1 + x2) / 2} y={yy + 15} textAnchor={self ? "start" : "middle"} fontSize="10" fill="var(--text-faint)">
                    {sev && <tspan fill={`var(--sev-${sev})`}>● </tspan>}
                    {flags.map((f) => f.label).join(" · ")}
                  </text>
                )}
                {isActive && (
                  <circle cx={x1 + (x2 - x1) * progress + (self ? 30 * Math.sin(progress * Math.PI) : 0)} cy={yy} r={5.5}
                    fill={isCall ? color : "var(--text-dim)"} filter="url(#glow)" data-testid="packet" />
                )}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
