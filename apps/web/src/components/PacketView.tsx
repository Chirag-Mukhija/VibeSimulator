import { useEffect, useMemo, useRef, useState } from "react";
import type { TraceNode } from "@vibesim/spec";
import type { Model } from "../lib/model.ts";
import { worstSeverity } from "../lib/model.ts";
import type { Device, Endpoint, Scene, SceneEvent } from "../lib/scene.ts";
import { eventTitle, typicalCost } from "../lib/describe.ts";
import { kindInfo, protocolInfo } from "../lib/explain.ts";
import { NodeIcon, nodeColor } from "./ui.tsx";

// ------------------------------------------------------------------ layout

const HEADER = 50;
const ROW = 25;
const PAD = 20;
const COL_GAP = 96;
const GAP = 22;
const WIDTH: Record<string, number> = { client: 160, browser: 236, proxy: 180, process: 272, database: 214, cache: 214, channel: 214, queue: 214, external: 214, unknown: 204 };

interface Box {
  device: Device;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SceneLayout {
  boxes: Map<string, Box>;
  width: number;
  height: number;
}

const hasStages = (d: Device) => d.kind === "process" || d.kind === "browser";

export function layoutScene(scene: Scene): SceneLayout {
  const boxes = new Map<string, Box>();
  const cols = [0, 1, 2, 3].map((c) => scene.devices.filter((d) => d.col === c));
  const heightOf = (d: Device) => (hasStages(d) ? HEADER + Math.max(1, d.stages.length) * ROW + 12 : d.kind === "client" ? 76 : 84);
  const colHeights = cols.map((list) => list.reduce((a, d) => a + heightOf(d), 0) + Math.max(0, list.length - 1) * GAP);
  const height = Math.max(...colHeights, 120) + PAD * 2;
  let x = PAD;
  cols.forEach((list, c) => {
    if (!list.length) return;
    const w = Math.max(...list.map((d) => WIDTH[d.kind] ?? 220));
    let y = PAD + (height - PAD * 2 - colHeights[c]!) / 2;
    for (const d of list) {
      const h = heightOf(d);
      boxes.set(d.id, { device: d, x: x + (w - (WIDTH[d.kind] ?? 220)) / 2, y, w: WIDTH[d.kind] ?? 220, h });
      y += h + GAP;
    }
    x += w + COL_GAP;
  });
  return { boxes, width: x - COL_GAP + PAD, height };
}

/** Where a link attaches: at the row of the function that makes the call, on the side facing the other box. */
function anchor(layout: SceneLayout, at: Endpoint, other: Endpoint): { x: number; y: number; side: 1 | -1 } {
  const b = layout.boxes.get(at.device)!;
  const o = layout.boxes.get(other.device)!;
  const idx = at.stage ? b.device.stages.findIndex((s) => s.id === at.stage) : -1;
  const y = hasStages(b.device) && idx >= 0 ? b.y + HEADER + idx * ROW + ROW / 2 : b.y + b.h / 2;
  const sameColumn = Math.abs(o.x - b.x) < 1;
  const right = sameColumn || o.x > b.x;
  return { x: right ? b.x + b.w : b.x, y, side: right ? 1 : -1 };
}

interface Curve {
  p0: [number, number];
  c1: [number, number];
  c2: [number, number];
  p3: [number, number];
}

function curveFor(layout: SceneLayout, a: Endpoint, b: Endpoint): Curve {
  const s = anchor(layout, a, b);
  const t = anchor(layout, b, a);
  const reach = Math.max(50, Math.abs(t.x - s.x) / 2);
  return { p0: [s.x, s.y], c1: [s.x + s.side * reach, s.y], c2: [t.x + t.side * reach, t.y], p3: [t.x, t.y] };
}

function pointAt(c: Curve, t: number): [number, number] {
  const u = 1 - t;
  const f = (i: 0 | 1) => u * u * u * c.p0[i] + 3 * u * u * t * c.c1[i] + 3 * u * t * t * c.c2[i] + t * t * t * c.p3[i];
  return [f(0), f(1)];
}

const pathOf = (c: Curve) => `M${c.p0[0]},${c.p0[1]} C${c.c1[0]},${c.c1[1]} ${c.c2[0]},${c.c2[1]} ${c.p3[0]},${c.p3[1]}`;

/** Packet colour by what it carries. */
export function protocolColor(protocol: string, scheme?: unknown): string {
  switch (protocol) {
    case "sql":
    case "mongodb":
      return "var(--k-database)";
    case "redis":
      return "var(--k-cache)";
    case "ws":
    case "sse":
      return "var(--k-messaging)";
    case "smtp":
      return "var(--k-external)";
    case "http":
      return scheme === "https" ? "var(--k-external)" : "var(--k-entry)";
    default:
      return "var(--text-faint)";
  }
}

const LIFECYCLE_SHORT: Record<string, string> = { pooled: "pooled", held: "held", "keep-alive": "keep-alive", persistent: "open conn.", "new-per-request": "new conn.", none: "", unknown: "" };

// ------------------------------------------------------------------ topology

interface TopologyProps {
  model: Model;
  scene: Scene;
  index: number;
  /** 0..1 along the current event's link (or between rows for a local call). */
  progress: number;
  selected?: string;
  onSelectNode(id: string): void;
}

export function PacketTopology({ model, scene, index, progress, selected, onSelectNode }: TopologyProps) {
  const layout = useMemo(() => layoutScene(scene), [scene]);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);
  // Fit the whole scene in the panel: nothing to scroll while it plays.
  const scale = size.w && size.h ? Math.min(1.25, (size.w - 8) / layout.width, (size.h - 8) / layout.height) : 1;

  const ev = scene.events[index];
  const curves = useMemo(() => new Map(scene.links.map((l) => [l.id, curveFor(layout, l.a, l.b)])), [scene, layout]);
  const visited = useMemo(() => {
    const devices = new Set<string>();
    const stages = new Set<string>();
    const links = new Set<string>();
    const lastOp = new Map<string, SceneEvent>();
    for (const e of scene.events.slice(0, index + 1)) {
      devices.add(e.from.device);
      devices.add(e.to.device);
      if (e.from.stage) stages.add(e.from.stage);
      if (e.to.stage) stages.add(e.to.stage);
      if (e.link) links.add(e.link);
      if ((e.kind === "request" || e.kind === "send") && !hasStages(scene.devices.find((d) => d.id === e.to.device)!)) lastOp.set(e.to.device, e);
    }
    return { devices, stages, links, lastOp };
  }, [scene, index]);

  const activeStages = new Set([ev?.from.stage, ev?.to.stage].filter(Boolean));
  const activeDevices = new Set([ev?.from.device, ev?.to.device].filter(Boolean));

  // The packet: along a link, or down the rows inside one box.
  let packet: { x: number; y: number; reply: boolean; color: string; label: string } | undefined;
  if (ev) {
    const reply = ev.kind === "reply" || ev.kind === "ack" || ev.kind === "response";
    const color = ev.kind === "local" ? "var(--accent)" : protocolColor(ev.edge.protocol, ev.edge.props.scheme);
    const label = eventTitle(model, scene, ev);
    if (ev.link) {
      const c = curves.get(ev.link)!;
      const [x, y] = pointAt(c, ev.reverse ? 1 - progress : progress);
      packet = { x, y, reply, color, label };
    } else {
      const b = layout.boxes.get(ev.from.device);
      if (b && hasStages(b.device)) {
        const row = (stage?: string) => Math.max(0, b.device.stages.findIndex((s) => s.id === stage));
        const y0 = b.y + HEADER + row(ev.from.stage) * ROW + ROW / 2;
        const y1 = b.y + HEADER + row(ev.to.stage) * ROW + ROW / 2;
        packet = { x: b.x + 12, y: y0 + (y1 - y0) * progress, reply: false, color, label };
      }
    }
  }

  return (
    <div className="topology" ref={wrap} data-testid="topology">
      {/* The sizer takes the scaled size, so the scaled canvas never overflows its panel. */}
      <div className="topology-sizer" style={{ width: layout.width * scale, height: layout.height * scale }}>
      <div className="topology-canvas" style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}>
        <svg width={layout.width} height={layout.height} className="topology-links" aria-hidden="true">
          {scene.links.map((l) => {
            const c = curves.get(l.id)!;
            const active = ev?.link === l.id;
            const seen = visited.links.has(l.id);
            const color = protocolColor(l.protocol);
            return (
              <path key={l.id} d={pathOf(c)} fill="none" stroke={active ? color : "var(--border-strong)"} strokeWidth={active ? 2.6 : seen ? 1.8 : 1.4}
                strokeDasharray={l.lifecycle === "new-per-request" ? "6 5" : undefined} opacity={active || seen ? 1 : 0.55} />
            );
          })}
          {packet && (
            <g transform={`translate(${packet.x - 12},${packet.y - 8})`} data-testid="packet">
              <rect width={24} height={16} rx={2.5} fill={packet.reply ? "var(--bg-elev)" : packet.color} stroke={packet.color} strokeWidth={2} />
              <path d={packet.reply ? "M5 8.5l4.5 4L19 4" : "M1.5 2l10.5 7 10.5-7"} fill="none" stroke={packet.reply ? packet.color : "var(--bg-elev)"} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}
        </svg>
        {scene.links.map((l) => {
          const c = curves.get(l.id)!;
          const [x, y] = pointAt(c, 0.5);
          const life = LIFECYCLE_SHORT[l.lifecycle];
          return (
            <span key={l.id} className={`link-label${ev?.link === l.id ? " active" : ""}`} style={{ left: x, top: y }}>
              {protocolInfo(l.protocol).label}{life ? ` · ${life}` : ""}
            </span>
          );
        })}
        {[...layout.boxes.values()].map((b) => (
          <DeviceBox key={b.device.id} model={model} box={b} active={activeDevices.has(b.device.id)} seen={visited.devices.has(b.device.id)}
            activeStages={activeStages} visitedStages={visited.stages} lastOp={visited.lastOp.get(b.device.id)} selected={selected} onSelectNode={onSelectNode} scene={scene} />
        ))}
        {packet && packet.label && (
          <span className="packet-tag" style={{ left: packet.x + 16, top: packet.y - 26, borderColor: packet.color }}>{packet.label}</span>
        )}
      </div>
      </div>
    </div>
  );
}

function deviceIcon(d: Device): string {
  switch (d.kind) {
    case "client": return "laptop";
    case "browser": return "ui-event";
    case "proxy": return "proxy";
    case "process": return "server";
    case "channel": return "topic";
    case "external": return "external-api";
    default: return d.node?.kind ?? "unknown";
  }
}

const DEVICE_COLOR: Record<string, string> = { client: "var(--k-actor)", browser: "var(--k-actor)", proxy: "var(--k-edge)", process: "var(--k-code)" };

function DeviceBox({ model, box, active, seen, activeStages, visitedStages, lastOp, selected, onSelectNode, scene }: {
  model: Model; box: Box; active: boolean; seen: boolean; activeStages: Set<string | undefined>; visitedStages: Set<string>;
  lastOp?: SceneEvent; selected?: string; onSelectNode(id: string): void; scene: Scene;
}) {
  const d = box.device;
  const color = d.node ? nodeColor(d.node) : DEVICE_COLOR[d.kind] ?? "var(--k-code)";
  const sev = d.node ? worstSeverity(model.findingsByRef.get(d.node.id) ?? []) : undefined;
  const dashed = d.kind === "unknown" || d.node?.confidence === "unresolved";
  const facts = d.node ? deviceFact(d.node) : undefined;
  return (
    <div className={`dev dev-${d.kind}${active ? " active" : ""}${seen ? " seen" : ""}${d.node && selected === d.node.id ? " selected" : ""}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h, borderStyle: dashed ? "dashed" : undefined, ["--dev-color" as string]: color }}
      data-testid="device">
      <button className="dev-head" onClick={() => d.node && onSelectNode(d.node.id)} disabled={!d.node} title={d.node ? `${kindInfo(d.node.kind).title}: ${d.node.label}` : d.label}>
        <span className="dev-icon"><NodeIcon kind={deviceIcon(d)} size={18} color={color} /></span>
        <span className="dev-name">
          <b className="ellipsis">{d.label}</b>
          <span className="ellipsis">{sev && <span className={`sev ${sev}`} style={{ marginRight: 5 }} />}{d.detail}</span>
        </span>
      </button>
      {hasStages(d) ? (
        <ol className="dev-stages">
          {d.stages.map((s) => {
            const current = activeStages.has(s.id);
            const label = s.group ? `${s.group.length} library middleware: ${s.group.map((g) => g.label.replace(/\s*\(express-rate-limit\)$/, "")).join(", ")}` : stageLabel(s.node);
            return (
              <li key={s.id} className={`${current ? "current" : ""}${visitedStages.has(s.id) ? " visited" : ""}`}>
                <button onClick={() => onSelectNode(s.group ? s.group[0]!.id : s.node.id)} title={s.node.label}>
                  <NodeIcon kind={s.node.kind} size={13} color={current ? "var(--accent)" : nodeColor(s.node)} />
                  <span className="ellipsis">{label}</span>
                  <span className="stage-kind">{stageKind(s.node, scene)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="dev-op">
          {lastOp ? <span className="mono ellipsis" title={lastOp.edge.label}>{lastOp.edge.label ?? ""}</span> : facts ? <span className="faint ellipsis">{facts}</span> : null}
        </div>
      )}
    </div>
  );
}

function stageLabel(n: TraceNode): string {
  if (n.kind === "route") return n.label;
  return n.label.replace(/\s*\(.*\)$/, "").replace(/ handler$/, " handler").replace(/^(GET|POST|PUT|PATCH|DELETE) \S+ handler$/, "handler");
}

function stageKind(n: TraceNode, scene: Scene): string {
  void scene;
  if (n.kind === "compute") return "CPU";
  if (n.kind === "external-api") return "local";
  if (n.kind === "ws-endpoint") return "sockets";
  if (n.kind === "route") return "route";
  return kindInfo(n.kind).title.replace("Worker / job handler", "job").replace("Function", "fn").replace("Browser event", "event").toLowerCase();
}

function deviceFact(n: TraceNode): string | undefined {
  const p = n.props;
  if (typeof p.rateLimit === "string") return `limit ${p.rateLimit} per IP${typeof p.burst === "number" ? `, burst ${p.burst}` : ""}`;
  if (typeof p.host === "string" && p.host) return String(p.host);
  if (typeof p.channel === "string") return "pub/sub, not stored";
  return undefined;
}

// ------------------------------------------------------------------ event list

const KIND_LABEL: Record<string, string> = { request: "Request", send: "Message", reply: "Reply", ack: "Ack", response: "Response", local: "Call" };

export function EventList({ model, scene, index, onJump }: { model: Model; scene: Scene; index: number; onJump(i: number): void }) {
  const list = useRef<HTMLDivElement>(null);
  // Keep the current row visible by scrolling the list itself, never the page.
  useEffect(() => {
    const el = list.current;
    const row = el?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (!el || !row) return;
    const top = row.offsetTop - el.offsetTop;
    if (top < el.scrollTop + 28) el.scrollTop = Math.max(0, top - 28);
    else if (top + row.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + row.offsetHeight - el.clientHeight + 4;
  }, [index]);
  const name = (ep: Endpoint) => {
    const d = scene.devices.find((x) => x.id === ep.device);
    if (!d) return "?";
    if (ep.stage && hasStages(d)) {
      const st = d.stages.find((s) => s.id === ep.stage);
      return st?.group ? "library middleware" : st ? stageLabel(st.node) : d.label;
    }
    return d.label;
  };
  return (
    <div className="event-list" ref={list} data-testid="event-list">
      <table>
        <thead>
          <tr><th>#</th><th>Event</th><th>From → to</th><th>What</th><th className="num">Typical</th></tr>
        </thead>
        <tbody>
          {scene.events.map((ev) => {
            const color = ev.kind === "local" ? "var(--text-faint)" : protocolColor(ev.edge.protocol, ev.edge.props.scheme);
            return (
              <tr key={ev.index} data-index={ev.index} className={`${ev.index === index ? "current" : ""}${ev.index < index ? " done" : ""}`} onClick={() => onJump(ev.index)}>
                <td className="mono faint">{ev.index + 1}</td>
                <td><span className={`ev-kind ev-${ev.kind}`} style={{ ["--ev-color" as string]: color }}>{KIND_LABEL[ev.kind]}</span></td>
                <td className="ellipsis">{name(ev.from)} <span className="faint">→</span> {name(ev.to)}</td>
                <td className="ellipsis mono">{eventTitle(model, scene, ev)}</td>
                <td className="num faint">{typicalCost(model, scene, ev) ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
