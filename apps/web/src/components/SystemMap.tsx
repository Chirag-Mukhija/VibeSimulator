import { useMemo } from "react";
import type { TraceNode } from "@vibesim/spec";
import type { Model } from "../lib/model.ts";
import { worstSeverity } from "../lib/model.ts";
import { kindInfo, protocolInfo } from "../lib/explain.ts";
import { NodeIcon, nodeColor } from "./ui.tsx";

const CARD_W = 200;
const RES_W = 230;
const COL_GAP = 96;
const GAP = 14;

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
  // Empty columns (no proxy in front) take no space.
  const used = [0, 1, 2, 3].filter((col) => cards.some((c) => c.col === col));
  const COL_X: number[] = [];
  let cursor = 24;
  for (const col of [0, 1, 2, 3]) {
    COL_X[col] = cursor;
    if (used.includes(col)) cursor += (col === 3 ? RES_W : CARD_W) + COL_GAP;
  }
  const width = cursor - COL_GAP + 24;
  return (
    <div className="map-wrap" data-testid="system-map">
      <div style={{ padding: "16px 24px 0" }}>
        <h2 style={{ fontSize: 18 }}>Architecture at a glance</h2>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>Built from the flows: each line is real traffic between a process and what it talks to. Click a box for details.</p>
      </div>
      <div style={{ position: "relative", width, height: height + 40, margin: "20px 0 40px" }}>
        {["Who calls", "In front", "Your processes", "What they talk to"].map((t, i) => used.includes(i) && (
          <div key={t} className="insp-label" style={{ position: "absolute", left: COL_X[i], top: 0 }}>{t}</div>
        ))}
        <svg width={width} height={height + 40} style={{ position: "absolute", inset: 0 }}>
          {links.map((l, i) => {
            const a = byId.get(l.from);
            const b = byId.get(l.to);
            if (!a || !b) return null;
            const ltr = a.col < b.col;
            const x1 = ltr ? COL_X[a.col]! + (a.col === 3 ? RES_W : CARD_W) : COL_X[a.col]!;
            const x2 = ltr ? COL_X[b.col]! : COL_X[b.col]! + CARD_W;
            const y1 = a.y + a.height / 2 + 24;
            const y2 = b.y + b.height / 2 + 24;
            const mx = (x1 + x2) / 2;
            return (
              <g key={i}>
                <path d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none" stroke={l.color} strokeWidth={1.4 + Math.min(3, l.count / 4)} opacity={0.55} />
                <text x={mx} y={(y1 + y2) / 2 - 4} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)" fontFamily="var(--mono)">{l.label}</text>
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
                position: "absolute", left: COL_X[c.col], top: c.y + 24, width: c.col === 3 ? RES_W : CARD_W, height: c.height,
                textAlign: "left", padding: "9px 11px", borderRadius: 10, cursor: c.node ? "pointer" : "default",
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
    const offset = Math.max(0, (height - used) / 2);
    for (const c of colCards) c.y += offset;
  }
  return { cards, links: [...links.values()], height };
}
