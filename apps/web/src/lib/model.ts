import type { Finding, Flow, TraceEdge, TraceNode, TraceSpec } from "@vibesim/spec";

export type Severity = Finding["severity"];
export const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** Indexed view of a trace for the UI. */
export interface Model {
  spec: TraceSpec;
  nodes: Map<string, TraceNode>;
  edges: Map<string, TraceEdge>;
  flows: Map<string, Flow>;
  /** Findings by the node or edge ids they reference. */
  findingsByRef: Map<string, Finding[]>;
  /** Flows that contain an edge. */
  flowsByEdge: Map<string, Flow[]>;
  flowSeverity: Map<string, Severity | undefined>;
  groups: FlowGroup[];
}

export interface FlowGroup {
  id: string;
  label: string;
  hint: string;
  flows: Flow[];
}

export function buildModel(spec: TraceSpec): Model {
  const nodes = new Map(spec.nodes.map((n) => [n.id, n]));
  const edges = new Map(spec.edges.map((e) => [e.id, e]));
  const flows = new Map(spec.flows.map((f) => [f.id, f]));
  const findingsByRef = new Map<string, Finding[]>();
  for (const f of spec.findings) {
    for (const ref of f.refs) findingsByRef.set(ref, [...(findingsByRef.get(ref) ?? []), f]);
  }
  const flowsByEdge = new Map<string, Flow[]>();
  for (const f of spec.flows) for (const s of f.steps) flowsByEdge.set(s.edge, [...(flowsByEdge.get(s.edge) ?? []), f]);

  const flowSeverity = new Map<string, Severity | undefined>();
  for (const f of spec.flows) {
    let worst: Severity | undefined;
    const refs = new Set([f.entry, ...f.steps.flatMap((s) => {
      const e = edges.get(s.edge)!;
      return [s.edge, e.from, e.to];
    })]);
    for (const ref of refs) {
      for (const finding of findingsByRef.get(ref) ?? []) {
        if (!worst || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[worst]) worst = finding.severity;
      }
    }
    flowSeverity.set(f.id, worst);
  }
  return { spec, nodes, edges, flows, findingsByRef, flowsByEdge, flowSeverity, groups: groupFlows(spec, nodes) };
}

function groupFlows(spec: TraceSpec, nodes: Map<string, TraceNode>): FlowGroup[] {
  const browser: Flow[] = [];
  const realtime: Flow[] = [];
  const background: Flow[] = [];
  const routes = new Map<string, Flow[]>();
  for (const f of spec.flows) {
    const entry = nodes.get(f.entry)!;
    const first = spec.edges.find((e) => e.id === f.steps[0]?.edge);
    const firstTo = first ? nodes.get(first.to) : undefined;
    if (entry.kind === "ui-event" || (entry.kind === "timer" && entry.props.browser)) browser.push(f);
    else if (firstTo?.kind === "ws-endpoint" || entry.kind === "ws-endpoint") realtime.push(f);
    else if (entry.kind === "timer" || entry.kind === "topic" || entry.kind === "queue") background.push(f);
    else {
      const route = firstTo?.kind === "route" ? firstTo : spec.edges.filter((e) => f.steps.some((s) => s.edge === e.id)).map((e) => nodes.get(e.to)!).find((n) => n.kind === "route");
      const path = String(route?.props.path ?? "/");
      const segs = path.split("/").filter(Boolean);
      const prefix = segs[0] === "api" && segs[1] ? `/api/${segs[1]}` : segs[0] ? `/${segs[0]}` : "/";
      routes.set(prefix, [...(routes.get(prefix) ?? []), f]);
    }
  }
  const groups: FlowGroup[] = [];
  if (browser.length) groups.push({ id: "browser", label: "In the browser", hint: "Clicks, page loads and timers in frontend code", flows: browser });
  for (const [prefix, list] of [...routes].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({ id: `routes:${prefix}`, label: prefix, hint: "HTTP routes", flows: list });
  }
  if (realtime.length) groups.push({ id: "realtime", label: "Realtime", hint: "WebSocket connections", flows: realtime });
  if (background.length) groups.push({ id: "background", label: "Background", hint: "Timers, workers and subscribers", flows: background });
  return groups;
}

// ---------------------------------------------------------------- timeline

export interface Participant {
  id: string;
  node: TraceNode;
  /** Set for the synthetic "library middleware" lifeline. */
  collapsed?: TraceNode[];
}

export type TimelineItem =
  | { kind: "call"; edge: TraceEdge; from: string; to: string; depth: number; stepIndex: number }
  | { kind: "return"; edge: TraceEdge; from: string; to: string; depth: number; stepIndex: number };

export interface Timeline {
  participants: Participant[];
  items: TimelineItem[];
  /** Edge ids hidden by collapsing library middleware (still listed in the inspector). */
  hidden: string[];
}

const RESOURCE_KINDS = new Set(["database", "cache", "external-api", "compute", "queue", "topic"]);
const LIB_MW = "__library_middleware";

/**
 * Turns a flow's ordered steps into a sequence diagram: calls in order, and a
 * return arrow when a synchronous call finishes (after everything it called).
 */
export function buildTimeline(model: Model, flow: Flow, opts: { collapseLibraryMiddleware: boolean }): Timeline {
  const isLib = (id: string) => {
    const n = model.nodes.get(id)!;
    return opts.collapseLibraryMiddleware && n.kind === "middleware" && n.props.builtin === true;
  };
  const libNodes: TraceNode[] = [];
  const map = (id: string) => (isLib(id) ? LIB_MW : id);
  const hidden: string[] = [];

  const participants: Participant[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const pid = map(id);
    if (isLib(id) && !libNodes.some((n) => n.id === id)) libNodes.push(model.nodes.get(id)!);
    if (seen.has(pid)) return;
    seen.add(pid);
    participants.push({ id: pid, node: model.nodes.get(id)! });
  };
  add(flow.entry);

  const items: TimelineItem[] = [];
  // Open synchronous calls; each entry is waiting for its callee to finish.
  const stack: { edge: TraceEdge; from: string; to: string; stepIndex: number }[] = [];
  const closeUntil = (caller: string) => {
    while (stack.length && stack[stack.length - 1]!.to !== caller) {
      const open = stack.pop()!;
      items.push({ kind: "return", edge: open.edge, from: open.to, to: open.from, depth: stack.length, stepIndex: open.stepIndex });
    }
  };

  flow.steps.forEach((s, stepIndex) => {
    const edge = model.edges.get(s.edge)!;
    const from = map(edge.from);
    const to = map(edge.to);
    add(edge.from);
    add(edge.to);
    if (from === to && from === LIB_MW) {
      hidden.push(edge.id);
      return;
    }
    closeUntil(from);
    items.push({ kind: "call", edge, from, to, depth: stack.length, stepIndex });
    const toNode = model.nodes.get(edge.to)!;
    if (edge.mode === "sync" && edge.props.role !== "deliver") {
      if (RESOURCE_KINDS.has(toNode.kind)) {
        items.push({ kind: "return", edge, from: to, to: from, depth: stack.length, stepIndex });
      } else {
        stack.push({ edge, from, to, stepIndex });
      }
    }
  });
  closeUntil("__end__");

  if (libNodes.length) {
    const p = participants.find((x) => x.id === LIB_MW);
    if (p) {
      p.collapsed = libNodes;
      p.node = { ...libNodes[0]!, id: LIB_MW, label: libNodes.length === 1 ? libNodes[0]!.label : `${libNodes.length} library middleware` };
    }
  }
  return { participants, items, hidden };
}

/** Flows that touch a node or edge, for "show in flow". */
export function flowsTouching(model: Model, ref: string): Flow[] {
  const edgeFlows = model.flowsByEdge.get(ref);
  if (edgeFlows) return edgeFlows;
  return model.spec.flows.filter((f) => f.entry === ref || f.steps.some((s) => {
    const e = model.edges.get(s.edge)!;
    return e.from === ref || e.to === ref;
  }));
}

export function worstSeverity(findings: Finding[]): Severity | undefined {
  let worst: Severity | undefined;
  for (const f of findings) if (!worst || SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst]) worst = f.severity;
  return worst;
}
