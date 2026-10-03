import type { Flow, Service, TraceEdge, TraceNode } from "@vibesim/spec";
import type { Model } from "./model.ts";

/**
 * The "devices" view of a flow, in the spirit of Cisco Packet Tracer: the boxes are things that
 * run or store something (the browser, Nginx, each of your processes, Postgres, Redis, an outside
 * API), the lines are network connections between them, and a flow is a list of events, each one
 * a packet crossing a line or a call moving between functions inside one box.
 */

export type DeviceKind = "client" | "browser" | "proxy" | "process" | "database" | "cache" | "channel" | "queue" | "external" | "unknown";

export interface Stage {
  /** Node id, or a synthetic id for grouped library middleware. */
  id: string;
  node: TraceNode;
  /** Set when several library middleware are shown as one row. */
  group?: TraceNode[];
}

export interface Device {
  id: string;
  kind: DeviceKind;
  label: string;
  /** Second line: what it is ("Express server · api/server.js", "Postgres · pool of 10"). */
  detail: string;
  node?: TraceNode;
  service?: Service;
  /** Code that runs inside this device during the flow, in the order it first runs. */
  stages: Stage[];
  /** Layout column: 0 callers, 1 proxies, 2 your processes, 3 data stores and outside services. */
  col: number;
}

export interface Endpoint {
  device: string;
  stage?: string;
}

export interface Link {
  id: string;
  a: Endpoint;
  b: Endpoint;
  protocol: string;
  lifecycle: string;
}

export type EventKind =
  | "request" // a packet leaves for another device, and the caller waits for the answer
  | "send" // a packet leaves for another device, and nobody waits (publish, push, enqueue without await)
  | "reply" // the answer comes back from a data store or outside service
  | "ack" // the broker confirms it took a message (the caller awaited the publish)
  | "response" // your server's handler answers an incoming request
  | "local"; // a function call inside one device

export interface SceneEvent {
  index: number;
  kind: EventKind;
  edge: TraceEdge;
  from: Endpoint;
  to: Endpoint;
  /** Network events travel this link; `reverse` when going from b to a. */
  link?: string;
  reverse?: boolean;
  /** Depth of the call stack inside the device, for indenting the event list. */
  depth: number;
}

export interface Scene {
  devices: Device[];
  links: Link[];
  events: SceneEvent[];
  /** Conditions in this flow; each can be played either way. */
  branches: Branch[];
  /** Steps left out: the other side of each branch, and catch blocks unless shown. */
  skipped: number;
  errorSteps: number;
}

export interface Branch {
  /** Stable id: the calling function plus the condition text. */
  key: string;
  condition: string;
  /** Where the condition lives, e.g. "queueService.listJobs". */
  owner: string;
  ownerId: string;
  /** Whether both sides do something (an if/else), or only the `then` side. */
  hasElse: boolean;
  /**
   * A guard clause: the `then` side answers or throws and leaves early (`if (!user) return 404`).
   * Its `else` side, the rest of the function, is the main path and plays by default.
   */
  guard: boolean;
  chosen: "then" | "else";
}

/** One enclosing condition of a call, as the extractor records it. */
export interface BranchStep {
  condition: string;
  branch: "then" | "else";
  guard?: boolean;
  exits?: boolean;
}

/** The conditions an edge runs under, outermost first. */
export function branchPath(edge: TraceEdge): BranchStep[] {
  if (Array.isArray(edge.props.branchPath)) return edge.props.branchPath as BranchStep[];
  if (typeof edge.props.condition === "string") return [{ condition: edge.props.condition, branch: edge.props.branch === "else" ? "else" : "then" }];
  return [];
}

export interface SceneOptions {
  groupLibraryMiddleware: boolean;
  /** Per branch key; unset branches play their `then` side. */
  choices?: Record<string, "then" | "else">;
  /** Include steps that only run when something failed (catch blocks). */
  showErrors?: boolean;
}

export const branchKey = (ownerId: string, condition: string) => `${ownerId}::${condition}`;

const RESOURCE_KIND: Record<string, DeviceKind> = { database: "database", cache: "cache", topic: "channel", queue: "queue", "external-api": "external", unknown: "unknown" };
const CODE_KINDS = new Set(["route", "middleware", "handler", "service", "worker", "timer", "ui-event", "ws-endpoint", "sse-endpoint"]);
export const LIB_GROUP = "__library_middleware";

export function buildScene(model: Model, flow: Flow, opts: SceneOptions): Scene {
  const devices = new Map<string, Device>();
  const links = new Map<string, Link>();
  const events: SceneEvent[] = [];
  const deviceOfNode = new Map<string, string>();
  const services = new Map(model.spec.services.map((s) => [s.id, s]));

  const isLibMiddleware = (n: TraceNode) => opts.groupLibraryMiddleware && n.kind === "middleware" && n.props.builtin === true;

  const ensureDevice = (id: string, make: () => Omit<Device, "id" | "stages">): string => {
    if (!devices.has(id)) devices.set(id, { id, stages: [], ...make() });
    return id;
  };

  /** The device for a process (or the browser) by service id. */
  const processDevice = (serviceId: string | undefined, node: TraceNode): string => {
    const svc = serviceId ? services.get(serviceId) : undefined;
    if (svc?.kind === "frontend" || node.props.browser === true) {
      const id = `dev:${svc?.id ?? "browser"}`;
      return ensureDevice(id, () => ({ kind: "browser", label: "Browser", detail: svc ? svc.label.replace(/\s*\(browser\)$/, "").replace(/^Browser \((.*)\)$/, "$1") : "frontend code", service: svc, col: 0 }));
    }
    const id = `dev:${svc?.id ?? "app"}`;
    return ensureDevice(id, () => ({
      kind: "process",
      label: svc ? svc.label.replace(/\s*\(.*\)$/, "") : "Your app",
      detail: processDetail(svc, model),
      service: svc,
      col: 2,
    }));
  };

  /** Which device a node runs on in this flow. Code reached by a function call runs where its caller runs. */
  const resolve = (node: TraceNode, via?: TraceEdge, callerDevice?: string): string => {
    const known = deviceOfNode.get(node.id);
    if (known) return known;
    let id: string;
    if (node.kind === "client") {
      id = ensureDevice("dev:client", () => ({ kind: "client", label: "Client", detail: "a browser, mobile app or script", node, col: 0 }));
    } else if (node.kind === "proxy") {
      id = ensureDevice(`dev:${node.id}`, () => ({ kind: "proxy", label: node.label.replace(/\s*reverse proxy$/i, ""), detail: "reverse proxy", node, col: 1 }));
    } else if ((node.kind === "compute" || (node.kind === "external-api" && via?.protocol === "in-process")) && callerDevice) {
      id = callerDevice; // bcrypt, presigning: work done inside the calling process
    } else if (RESOURCE_KIND[node.kind]) {
      id = ensureDevice(`dev:${node.id}`, () => ({ kind: RESOURCE_KIND[node.kind]!, label: resourceLabel(node), detail: resourceDetail(node), node, col: 3 }));
    } else if (via?.protocol === "in-process" && callerDevice && devices.get(callerDevice)?.stages !== undefined && (devices.get(callerDevice)!.kind === "process" || devices.get(callerDevice)!.kind === "browser")) {
      id = callerDevice;
    } else if (CODE_KINDS.has(node.kind)) {
      id = processDevice(typeof node.props.service === "string" ? node.props.service : flow.service, node);
    } else {
      id = processDevice(flow.service, node);
    }
    deviceOfNode.set(node.id, id);
    return id;
  };

  /** Registers the node as a stage of its device (code, CPU work, local SDK work) and returns the stage id. */
  const stageOf = (node: TraceNode, deviceId: string): string | undefined => {
    const d = devices.get(deviceId)!;
    if (d.kind !== "process" && d.kind !== "browser") return undefined;
    if (isLibMiddleware(node)) {
      const gid = `${LIB_GROUP}@${deviceId}`;
      let g = d.stages.find((s) => s.id === gid);
      if (!g) {
        g = { id: gid, node, group: [] };
        d.stages.push(g);
      }
      if (!g.group!.some((n) => n.id === node.id)) g.group!.push(node);
      return gid;
    }
    if (!d.stages.some((s) => s.id === node.id)) d.stages.push({ id: node.id, node });
    return node.id;
  };

  const linkFor = (a: Endpoint, b: Endpoint, edge: TraceEdge): { id: string; reverse: boolean } => {
    const key = (e: Endpoint) => `${e.device}${e.stage ? `#${e.stage}` : ""}`;
    const forward = `${key(a)}->${key(b)}`;
    const backward = `${key(b)}->${key(a)}`;
    if (links.has(forward)) return { id: forward, reverse: false };
    if (links.has(backward)) return { id: backward, reverse: true };
    links.set(forward, { id: forward, a, b, protocol: edge.protocol, lifecycle: edge.lifecycle });
    return { id: forward, reverse: false };
  };

  const push = (e: Omit<SceneEvent, "index">) => events.push({ index: events.length, ...e });

  // Conditions met along this flow, in order. Guard clauses default to their continuing (main) path.
  const branches = new Map<string, Branch>();
  for (const step of flow.steps) {
    const e = model.edges.get(step.edge)!;
    if (e.props.errorPath) continue;
    for (const b of branchPath(e)) {
      const key = branchKey(e.from, b.condition);
      const known = branches.get(key);
      const guard = known?.guard || b.guard === true;
      const entry = known ?? { key, condition: b.condition, owner: model.nodes.get(e.from)!.label, ownerId: e.from, hasElse: false, guard, chosen: "then" as const };
      entry.guard = guard;
      if (b.branch === "else") entry.hasElse = true;
      entry.chosen = opts.choices?.[key] ?? (entry.guard ? "else" : "then");
      branches.set(key, entry);
    }
  }
  const plays = (e: TraceEdge) => {
    if (e.props.errorPath) return opts.showErrors === true;
    return branchPath(e).every((b) => branches.get(branchKey(e.from, b.condition))?.chosen === b.branch);
  };
  let skipped = 0;
  let errorSteps = 0;

  // The entry node.
  const entry = model.nodes.get(flow.entry)!;
  const entryDevice = resolve(entry);
  stageOf(entry, entryDevice);

  /** Calls still running; a cross-device request is answered when its frame closes. */
  interface Frame {
    edge: TraceEdge;
    from: Endpoint;
    to: Endpoint;
    answers: boolean;
    /** Not played: this call and everything it makes. */
    off?: boolean;
    /** The handler that ends up sending the response. */
    responder?: Endpoint;
  }
  const stack: Frame[] = [];
  const closeFrame = (f: Frame) => {
    if (!f.answers || f.off) return;
    const source = f.responder ?? f.to;
    const l = linkFor(f.from, f.to, f.edge);
    push({ kind: "response", edge: f.edge, from: source, to: f.from, link: l.id, reverse: !l.reverse, depth: stack.length });
  };
  const closeUntil = (nodeId: string) => {
    while (stack.length && stack[stack.length - 1]!.edge.to !== nodeId) closeFrame(stack.pop()!);
  };

  for (const step of flow.steps) {
    const edge = model.edges.get(step.edge)!;
    const fromNode = model.nodes.get(edge.from)!;
    const toNode = model.nodes.get(edge.to)!;
    closeUntil(edge.from);
    if (edge.props.errorPath) errorSteps++;
    if (stack.some((f) => f.off) || !plays(edge)) {
      // The other side of a branch (or a catch block): left out with everything it calls.
      skipped++;
      stack.push({ edge, from: { device: "" }, to: { device: "" }, answers: false, off: true });
      continue;
    }
    const fromDevice = deviceOfNode.get(fromNode.id) ?? resolve(fromNode);
    const from: Endpoint = { device: fromDevice, stage: stageOf(fromNode, fromDevice) };
    // Borrowing or returning a pooled connection happens inside the process; no packet leaves it.
    if (edge.props.checkout || edge.props.release) {
      resolve(toNode);
      push({ kind: "local", edge, from, to: from, depth: stack.length });
      continue;
    }
    const toDevice = resolve(toNode, edge, fromDevice);
    const to: Endpoint = { device: toDevice, stage: stageOf(toNode, toDevice) };
    const depth = stack.length;

    // Remember which handler answers the innermost incoming request.
    if (toNode.kind === "handler") {
      for (let i = stack.length - 1; i >= 0; i--) {
        const f = stack[i]!;
        if (f.answers) {
          if (!f.responder && f.to.device === toDevice) f.responder = to;
          break;
        }
      }
    }

    if (fromDevice === toDevice) {
      // A function call (or CPU work, or local SDK work) inside one device.
      if (from.stage !== to.stage) push({ kind: "local", edge, from, to, depth });
      stack.push({ edge, from, to, answers: false });
      continue;
    }

    const l = linkFor(from, to, edge);
    const toResource = RESOURCE_KIND[toNode.kind] !== undefined;
    const waits = edge.mode === "sync" && edge.props.notAwaited !== true && edge.props.role !== "deliver";
    push({ kind: waits ? "request" : "send", edge, from, to, link: l.id, reverse: l.reverse, depth });
    if (toResource) {
      // `await redis.publish(...)`: the broker confirms it took the message, though no subscriber has run yet.
      if (waits && (toNode.kind === "topic" || toNode.kind === "queue")) push({ kind: "ack", edge, from: to, to: from, link: l.id, reverse: !l.reverse, depth });
      else if (waits) push({ kind: "reply", edge, from: to, to: from, link: l.id, reverse: !l.reverse, depth });
      stack.push({ edge, from, to, answers: false });
    } else {
      stack.push({ edge, from, to, answers: waits });
    }
  }
  closeUntil("__end__");

  return { devices: [...devices.values()], links: [...links.values()], events, branches: [...branches.values()], skipped, errorSteps };
}

function resourceLabel(n: TraceNode): string {
  if (n.kind === "topic") return `Channel "${String(n.props.channel ?? n.label)}"`;
  return n.label.replace(/\s*\(.*\)$/, "");
}

function resourceDetail(n: TraceNode): string {
  const lib = typeof n.props.library === "string" ? n.props.library : undefined;
  switch (n.kind) {
    case "database": {
      const pool = typeof n.props.poolMax === "number" ? `pool of ${n.props.poolMax}${n.props.poolMaxDefault ? " (default)" : ""}` : undefined;
      return [lib, pool].filter(Boolean).join(" · ") || "database";
    }
    case "cache":
      return lib ? `${lib} client` : "key-value store";
    case "topic":
      return "Redis pub/sub";
    case "queue":
      return lib ? `${lib} queue` : "job queue";
    case "external-api":
      return "outside service";
    default:
      return "could not be resolved";
  }
}

function processDetail(svc: Service | undefined, model: Model): string {
  if (!svc) return model.spec.meta.frameworks.includes("next") ? "Next.js server" : "server code";
  const what = svc.kind === "worker" ? "background worker" : model.spec.meta.frameworks.includes("next") ? "Next.js server" : model.spec.meta.frameworks.includes("express") ? "Express server" : "HTTP server";
  const entry = typeof svc.props.entry === "string" ? svc.props.entry : undefined;
  return entry ? `${what} · ${entry}` : what;
}
