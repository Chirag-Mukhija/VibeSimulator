import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceNode } from "@vibesim/spec";
import type { Model } from "../lib/model.ts";
import { worstSeverity } from "../lib/model.ts";
import { kindInfo, protocolInfo } from "../lib/explain.ts";
import { NodeIcon, nodeColor } from "./ui.tsx";

const CARD_W = 200;
const RES_W = 230;
const COL_GAP = 96;
const GAP = 14;
/** Below these the map stops shrinking and scrolls sideways instead (phones). */
const MIN_CARD_W = 150;
const MIN_RES_W = 170;
const MIN_COL_GAP = 44;
/** Short columns sit at most this far down, so they stay on screen next to a long list. */
const MAX_CENTER_OFFSET = 150;
/** Narrower than this (phones), columns become stacked sections. */
const STACK_BELOW = 620;
const COLUMN_TITLES = ["Who calls", "In front", "Your processes", "What they talk to"];

interface Card {
  id: string;
  col: number;
  title: string;
  subtitle: string;
  kind: string;
  node?: TraceNode;
  height: number;
  y: number;
}

interface Link {
  from: string;
  to: string;
  label: string;
  count: number;
  color: string;
}

/** Architecture at a glance: who calls, which processes run, what they talk to. */
export function SystemMap({ model, selected, onSelect }: { model: Model; selected?: string; onSelect(id: string): void }) {
  const { cards, links, height } = useMemo(() => layout(model), [model]);
  const byId = new Map(cards.map((c) => [c.id, c]));
  const wrap = useRef<HTMLDivElement>(null);
  const available = useWidth(wrap);
  // Empty columns (no proxy in front) take no space.
  const used = [0, 1, 2, 3].filter((col) => cards.some((c) => c.col === col));
  // Shrink gaps first, then cards, to fit the space; past the minimums the map scrolls.
  const natural = (cw: number, rw: number, gap: number) => 48 + used.reduce((a, col) => a + (col === 3 ? rw : cw), 0) + gap * (used.length - 1);
  let cardW = CARD_W;
  let resW = RES_W;
  let colGap = COL_GAP;
  if (available && natural(cardW, resW, colGap) > available) {
    colGap = Math.max(MIN_COL_GAP, colGap - (natural(cardW, resW, colGap) - available) / Math.max(1, used.length - 1));
    const over = natural(cardW, resW, colGap) - available;
    if (over > 0) {
      const scale = Math.max(MIN_CARD_W / CARD_W, 1 - over / (natural(cardW, resW, 0) - 48));
      cardW = Math.max(MIN_CARD_W, Math.floor(CARD_W * scale));
      resW = Math.max(MIN_RES_W, Math.floor(RES_W * scale));
    }
  }
  if (available !== undefined && available < STACK_BELOW) {
    return <StackedMap model={model} cards={cards} links={links} used={used} selected={selected} onSelect={onSelect} wrap={wrap} />;
  }
  const COL_X: number[] = [];
  let cursor = 24;
  for (const col of [0, 1, 2, 3]) {
    COL_X[col] = cursor;
    if (used.includes(col)) cursor += (col === 3 ? resW : cardW) + colGap;
  }
  const width = cursor - colGap + 24;
  const widthOf = (col: number) => (col === 3 ? resW : cardW);
  return (
    <div className="map-wrap" data-testid="system-map" ref={wrap}>
      <div style={{ padding: "16px 24px 0" }}>
        <h2 style={{ fontSize: 18 }}>Architecture at a glance</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Built from the flows: each line is real traffic between a process and what it talks to. Click a box for details.</p>
      </div>
      <div style={{ position: "relative", width, height: height + 40, margin: "20px 0 40px" }}>
        {COLUMN_TITLES.map((t, i) => used.includes(i) && (
          <div key={t} className="insp-label" style={{ position: "absolute", left: COL_X[i], top: 0 }}>{t}</div>
        ))}
        <svg width={width} height={height + 40} style={{ position: "absolute", inset: 0 }}>
          {links.map((l, i, all) => {
            const a = byId.get(l.from);
            const b = byId.get(l.to);
            if (!a || !b) return null;
            const ltr = a.col < b.col;
            const x1 = ltr ? COL_X[a.col]! + widthOf(a.col) : COL_X[a.col]!;
            const x2 = ltr ? COL_X[b.col]! : COL_X[b.col]! + widthOf(b.col);
            const y1 = a.y + a.height / 2 + 24;
            const y2 = b.y + b.height / 2 + 24;
            const mx = (x1 + x2) / 2;
            // Label next to the box it points at, so a fan of many lines stays readable.
            const lx = ltr ? x2 - 6 : x2 + 6;
            const firstLabel = all.findIndex((o) => o.to === l.to && o.label === l.label && (byId.get(o.from)!.col < b.col) === ltr) === i;
            return (
              <g key={i}>
                <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={l.color} strokeWidth={1.4 + Math.min(3, l.count / 4)} opacity={0.55} />
                {firstLabel && <text x={lx} y={y2 - 6} textAnchor={ltr ? "end" : "start"} fontSize="10.5" fill="var(--text-faint)" fontFamily="var(--mono)">{l.label}</text>}
              </g>
            );
          })}
        </svg>
        {cards.map((c) => {
          const color = c.node ? nodeColor(c.node) : c.kind === "frontend" ? "var(--k-actor)" : "var(--k-code)";
          const sev = c.node ? worstSeverity(model.findingsByRef.get(c.node.id) ?? []) : undefined;
          const sel = c.node && selected === c.node.id;
          return (
            <button
              key={c.id}
              onClick={() => c.node && onSelect(c.node.id)}
              style={{
                position: "absolute", left: COL_X[c.col], top: c.y + 24, width: widthOf(c.col), height: c.height,
                textAlign: "left", padding: "9px 11px", borderRadius: 6, cursor: c.node ? "pointer" : "default",
                border: `1px solid ${sel ? "var(--accent)" : "var(--border-strong)"}`, background: sel ? "var(--accent-soft)" : "var(--bg-elev)",
                boxShadow: `inset 3px 0 0 ${color}`, display: "grid", gridTemplateColumns: "auto 1fr", gap: "1px 8px", alignContent: "center",
              }}
            >
              <span style={{ gridRow: "span 2", display: "grid", placeItems: "center" }}><NodeIcon kind={c.kind === "frontend" ? "ui-event" : c.kind} size={17} color={color} /></span>
              <span className="ellipsis" style={{ fontWeight: 600, fontSize: 13 }}>{c.title}</span>
              <span className="ellipsis faint" style={{ fontSize: 11.5, display: "flex", gap: 5, alignItems: "center" }}>{sev && <span className={`sev ${sev}`} />}{c.subtitle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Phone layout: one section per column, top to bottom; each box says what reaches it and how. */
function StackedMap({ model, cards, links, used, selected, onSelect, wrap }: {
  model: Model; cards: Card[]; links: Link[]; used: number[]; selected?: string; onSelect(id: string): void; wrap: React.RefObject<HTMLDivElement | null>;
}) {
  const titleOf = new Map(cards.map((c) => [c.id, c.title]));
  const into = (c: Card) => {
    const incoming = links.filter((l) => l.to === c.id && titleOf.has(l.from));
    const byLabel = new Map<string, string[]>();
    for (const l of incoming) byLabel.set(l.label, [...(byLabel.get(l.label) ?? []), titleOf.get(l.from)!]);
    return [...byLabel].map(([label, from]) => `${label} from ${from.join(", ")}`).join(" · ");
  };
  return (
    <div className="map-wrap" data-testid="system-map" ref={wrap}>
      <div style={{ padding: "16px 16px 0" }}>
        <h2 style={{ fontSize: 18 }}>Architecture at a glance</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Built from the flows, top to bottom: who calls, what sits in front, your processes and what they talk to. Tap a box for details.</p>
      </div>
      <div className="map-stack">
        {used.map((col, i) => (
          <section key={col} className="map-stack-col">
            {i > 0 && <span className="map-stack-arrow" aria-hidden="true">↓</span>}
            <span className="insp-label">{COLUMN_TITLES[col]}</span>
            {cards.filter((c) => c.col === col).map((c) => {
              const color = c.node ? nodeColor(c.node) : c.kind === "frontend" ? "var(--k-actor)" : "var(--k-code)";
              const sev = c.node ? worstSeverity(model.findingsByRef.get(c.node.id) ?? []) : undefined;
              const via = into(c);
              return (
                <button key={c.id} className={`map-stack-card${c.node && selected === c.node.id ? " sel" : ""}`} onClick={() => c.node && onSelect(c.node.id)}
                  style={{ boxShadow: `inset 3px 0 0 ${color}`, cursor: c.node ? "pointer" : "default" }}>
                  <NodeIcon kind={c.kind === "frontend" ? "ui-event" : c.kind} size={17} color={color} />
                  <span style={{ display: "grid", minWidth: 0 }}>
                    <b className="ellipsis">{c.title}</b>
                    <span className="faint row" style={{ gap: 5, fontSize: 12 }}>{sev && <span className={`sev ${sev}`} />}{c.subtitle}</span>
                    {via && <span className="mono faint" style={{ fontSize: 11 }}>{via}</span>}
                  </span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

function layout(model: Model): { cards: Card[]; links: Link[]; height: number } {
  const { spec, nodes, edges } = model;
  const cards: Card[] = [];
  const links = new Map<string, Link>();
  const addLink = (from: string, to: string, protocol: string, color: string) => {
    const key = `${from}>${to}>${protocol}`;
    const l = links.get(key) ?? { from, to, label: protocolInfo(protocol).label, count: 0, color };
    l.count++;
    links.set(key, l);
  };

  // Processes: services from infra, or one synthetic app when none were found.
  const procs = spec.services.filter((s) => s.kind === "http-server" || s.kind === "worker");
  const frontends = spec.services.filter((s) => s.kind === "frontend");
  const serviceOf = (flowService?: string) => (flowService && procs.some((p) => p.id === flowService) ? flowService : procs[0]?.id ?? "svc:app");
  if (!procs.length) cards.push({ id: "svc:app", col: 2, title: "Your app", subtitle: "server code", kind: "handler", height: 52, y: 0 });
  for (const p of procs) {
    const flows = spec.flows.filter((f) => f.service === p.id);
    const routes = flows.filter((f) => nodes.get(f.entry)?.kind === "client").length;
    const bg = flows.length - routes;
    cards.push({ id: p.id, col: 2, title: p.label.replace(/\s*\(.*\)$/, ""), subtitle: [routes && `${routes} routes`, bg && `${bg} background`].filter(Boolean).join(" · ") || p.kind, kind: p.kind === "worker" ? "worker" : "handler", height: 52, y: 0 });
  }
  const client = nodes.get("client:http");
  if (client) cards.push({ id: client.id, col: 0, title: "HTTP clients", subtitle: "browser, app, curl", kind: "client", node: client, height: 52, y: 0 });
  for (const f of frontends) cards.push({ id: f.id, col: 0, title: f.label.replace(/\s*\(browser\)$/, ""), subtitle: "runs in the browser", kind: "frontend", height: 52, y: 0 });
  for (const n of spec.nodes.filter((x) => x.kind === "proxy")) cards.push({ id: n.id, col: 1, title: n.label, subtitle: kindInfo(n.kind).title, kind: n.kind, node: n, height: 52, y: 0 });

  const RESOURCES = new Set(["database", "cache", "topic", "queue", "external-api", "compute", "ws-endpoint"]);
  const resources = spec.nodes.filter((n) => RESOURCES.has(n.kind));
  const order = ["database", "cache", "queue", "topic", "ws-endpoint", "external-api", "compute"];
  resources.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const r of resources) cards.push({ id: r.id, col: 3, title: r.label, subtitle: kindInfo(r.kind).title, kind: r.kind, node: r, height: 52, y: 0 });

  const proxy = spec.nodes.find((n) => n.kind === "proxy");
  for (const f of spec.flows) {
    const entry = nodes.get(f.entry)!;
    const isFrontend = frontends.some((s) => s.id === f.service);
    const svc = serviceOf(f.service);
    for (const s of f.steps) {
      const e = edges.get(s.edge)!;
      const to = nodes.get(e.to)!;
      const from = nodes.get(e.from)!;
      if (isFrontend) {
        if (from.kind !== "route" && to.kind === "route" && e.protocol !== "in-process") addLink(f.service!, serviceOf(spec.flows.find((rf) => rf.steps.some((st) => edges.get(st.edge)!.to === to.id) && rf.entry === "client:http")?.service), e.protocol, "var(--k-entry)");
        if (to.kind === "ws-endpoint" && e.props.role === "connect") addLink(f.service!, to.id, "ws", "var(--k-entry)");
        continue;
      }
      if (RESOURCES.has(to.kind) && e.props.role !== "deliver") addLink(svc, to.id, e.protocol, `var(--k-${kindInfo(to.kind).group})`);
      if ((entry.kind === "topic" || entry.kind === "queue") && from.id === entry.id) addLink(entry.id, svc, e.protocol, "var(--k-messaging)");
    }
    if (entry.kind === "client") {
      if (proxy) {
        addLink("client:http", proxy.id, "http", "var(--k-entry)");
        addLink(proxy.id, svc, "http", "var(--k-entry)");
      } else addLink("client:http", svc, "http", "var(--k-entry)");
    }
  }

  // Stack each column; cards get a little taller to read better when columns are short.
  let height = 0;
  for (let col = 0; col < 4; col++) {
    let y = 0;
    for (const c of cards.filter((x) => x.col === col)) {
      c.y = y;
      y += c.height + GAP;
    }
    height = Math.max(height, y);
  }
  // Center short columns against the tallest one.
  for (let col = 0; col < 3; col++) {
    const colCards = cards.filter((x) => x.col === col);
    const used = colCards.reduce((a, c) => a + c.height + GAP, 0);
    const offset = Math.min(MAX_CENTER_OFFSET, Math.max(0, (height - used) / 2));
    for (const c of colCards) c.y += offset;
  }
  return { cards, links: [...links.values()], height };
}

/** Content width of an element, kept up to date as it resizes. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number | undefined>();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}
