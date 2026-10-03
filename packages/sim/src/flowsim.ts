import type { Flow, TraceEdge, TraceNode, TraceSpec } from "@vibesim/spec";
import { Histogram, Resource, Signal, Sim, type Process } from "./engine.ts";
import { CALIBRATION } from "./params.ts";

/**
 * Runs one of a repo's real flows under load. Every hop in the trace becomes
 * simulated work: CPU on the event loop, a pooled database query on a
 * database with limited cores, a Redis command on a single-threaded server,
 * a third-party call with realistic latency, bcrypt on the thread pool.
 * The costs are modeling assumptions (listed in FLOW_ASSUMPTIONS), except
 * realtime push costs, which come from the calibration.
 */

export interface WhatIf {
  /** App instances behind a load balancer. */
  instances: number;
  /** Serve SELECTs from Redis with this hit ratio (0 = off). */
  cacheHitRatio: number;
  /** Enqueue third-party calls instead of waiting for them in the request. */
  queueExternal: boolean;
  /** Browser polling flows: push updates over SSE instead. */
  pushInsteadOfPoll: boolean;
  /** Send SELECTs to a read replica. */
  readReplica: boolean;
  /** Batch database calls made inside loops into one query. */
  batchLoops: boolean;
}

export interface Load {
  /** Requests per second for request flows. */
  requestsPerSec: number;
  /** For browser polling flows: users with the page open. */
  users: number;
  /** For push: how many times per second the data changes (global). */
  updatesPerSec: number;
  /** Rows in the large tables (drives scans without an index). */
  tableRows: number;
  /** Iterations of loops that call the database. */
  loopItems: number;
  /** Sockets a server push goes to. */
  connectedClients: number;
}

export const NO_CHANGES: WhatIf = { instances: 1, cacheHitRatio: 0, queueExternal: false, pushInsteadOfPoll: false, readReplica: false, batchLoops: false };
export const DEFAULT_LOAD: Load = { requestsPerSec: 200, users: 5000, updatesPerSec: 1, tableRows: 1_000_000, loopItems: 20, connectedClients: 1000 };

export interface ResourceUse {
  id: string;
  label: string;
  utilization: number;
  /** Average time a request waited for this resource. */
  waitMs: number;
}

export interface FlowSimResult {
  requestsPerSec: number;
  completed: number;
  p50: number;
  p95: number;
  p99: number;
  failedPct: number;
  resources: ResourceUse[];
  bottleneck?: ResourceUse;
  /** Average milliseconds per request spent on each kind of hop. */
  timeBy: { label: string; ms: number }[];
  notes: string[];
  poolPerInstance?: number;
}

export const FLOW_ASSUMPTIONS = [
  "CPU per hop on the event loop: about 0.3 ms for a handler, 0.05 ms for middleware, 0.02 ms for your own functions.",
  "The database runs 8 queries at once. Indexed lookups take about 0.5 ms, writes 1.5 ms, unbounded reads 3 ms; scans without an index cost about 80 ms per million rows. Postgres accepts 100 connections.",
  "Redis is single-threaded: about 0.05 ms of work and a 0.3 ms round trip per command.",
  "Third-party APIs answer in about 200 ms on average (Stripe 350 ms, LLM APIs 2 s, email 300 ms), with wide variation.",
  "bcrypt at work factor 10 takes about 65 ms, doubling per step; the thread pool has 4 threads per instance.",
  "Each if/else takes one side, half the time each; code after a guard clause (like `if (!user) return 404`) always runs; catch blocks never run; a handler picked at runtime is one of its candidates at random.",
  `Pushing a message costs ${CALIBRATION.cpuPerWsMessageUs} µs per socket and an open SSE stream ${CALIBRATION.memoryPerConnectionKB.sse} KB, as measured in calibration.`,
  "Browsers are 40 ms away; requests slower than 30 s count as failed.",
];

const RTT_BROWSER = 40;
const REDIS_OP = 0.05;
const REDIS_RTT = 0.3;
const DB_RTT = 0.5;
const DB_CORES = 8;
const MAX_CONNECTIONS = 100;
const TIMEOUT_MS = 30_000;

interface TreeNode {
  edge: TraceEdge;
  children: TreeNode[];
}

/** Rebuilds the call tree from a flow's ordered steps. */
function callTree(spec: TraceSpec, flow: Flow): TreeNode[] {
  const edges = new Map(spec.edges.map((e) => [e.id, e]));
  const roots: TreeNode[] = [];
  const stack: TreeNode[] = [];
  for (const s of flow.steps) {
    const edge = edges.get(s.edge)!;
    const node: TreeNode = { edge, children: [] };
    while (stack.length && stack[stack.length - 1]!.edge.to !== edge.from) stack.pop();
    if (stack.length) stack[stack.length - 1]!.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function externalLatency(node: TraceNode): number {
  const label = `${node.label} ${String(node.props.host ?? "")}`.toLowerCase();
  if (/openai|anthropic|gemini|groq|llm/.test(label)) return 2000;
  if (/stripe|paypal/.test(label)) return 350;
  if (/smtp|sendgrid|resend|mail/.test(label)) return 300;
  if (/s3|amazonaws/.test(label)) return 80;
  return 200;
}

function bcryptMs(cost: number): number {
  return 65 * 2 ** (cost - 10);
}

/** Simulates a flow at one load level. */
export function simulateFlow(spec: TraceSpec, flowId: string, load: Load, changes: WhatIf, seed = 1): FlowSimResult {
  const flow = spec.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`no flow ${flowId}`);
  const nodes = new Map(spec.nodes.map((n) => [n.id, n]));
  const entry = nodes.get(flow.entry)!;
  const roots = callTree(spec, flow);
  const notes: string[] = [];
  const sim = new Sim(seed);

  const polling = entry.kind === "timer" && entry.props.browser === true;
  const interval = typeof entry.props.intervalMs === "number" ? entry.props.intervalMs : 5000;
  const push = polling && changes.pushInsteadOfPoll;
  let rate = polling ? (push ? load.updatesPerSec : load.users / (interval / 1000)) : load.requestsPerSec;
  rate = Math.max(0.1, rate);

  const n = Math.max(1, Math.round(changes.instances));
  const loops = Array.from({ length: n }, () => new Resource(sim, 1));
  const threads = Array.from({ length: n }, () => new Resource(sim, 4));
  const redis = new Resource(sim, 1);
  const dbCores = new Map<string, Resource>();
  const replicaCores = new Map<string, Resource>();
  const pools = new Map<string, Resource[]>();
  const time = new Map<string, number>();
  const addTime = (label: string, ms: number) => time.set(label, (time.get(label) ?? 0) + ms);
  let poolPerInstance: number | undefined;

  const dbFor = (id: string) => {
    if (!dbCores.has(id)) {
      const node = nodes.get(id)!;
      const configured = typeof node.props.poolMax === "number" ? node.props.poolMax : 10;
      const perInstance = Math.max(1, Math.min(configured, Math.floor(MAX_CONNECTIONS / n)));
      if (configured * n > MAX_CONNECTIONS && !notes.some((x) => x.includes("max_connections"))) {
        notes.push(`${n} instances × a pool of ${configured} would need ${configured * n} connections, more than Postgres's max_connections (${MAX_CONNECTIONS}). Each instance is capped at ${perInstance}; a pooler like PgBouncer fixes this.`);
      }
      poolPerInstance = perInstance;
      dbCores.set(id, new Resource(sim, DB_CORES));
      replicaCores.set(id, new Resource(sim, DB_CORES));
      pools.set(id, Array.from({ length: n }, () => new Resource(sim, perInstance)));
    }
    return { cores: dbCores.get(id)!, replica: replicaCores.get(id)!, pools: pools.get(id)! };
  };

  interface Ctx {
    instance: number;
    held: Map<string, boolean>;
    /** Which way each condition went for this request, so an if/else takes exactly one side. */
    branches: Map<string, "then" | "else">;
  }

  /** Does this edge run on this request? Guards pass, alternatives are a coin flip per condition, catch blocks never run. */
  function takes(ctx: Ctx, e: TraceEdge): boolean {
    const p = e.props;
    if (p.errorPath) return false;
    const path = Array.isArray(p.branchPath) ? (p.branchPath as { condition: string; branch: "then" | "else"; guard?: boolean; exits?: boolean }[]) : [];
    for (const step of path) {
      // The early-exit side of a guard clause (an error answer) is rare; its continuation is the main path.
      if (step.guard) {
        if (step.branch === "then") return false;
        continue;
      }
      const key = `${e.from}::${step.condition}`;
      let way = ctx.branches.get(key);
      if (!way) {
        way = sim.rng.chance(0.5) ? "then" : "else";
        ctx.branches.set(key, way);
      }
      if (way !== step.branch) return false;
    }
    if (!path.length && p.conditional && !sim.rng.chance(0.5)) return false;
    return true;
  }

  function* cpu(ctx: Ctx, ms: number, label = "Your code (CPU)"): Process {
    const start = sim.now;
    yield loops[ctx.instance]!.acquire();
    yield sim.timeout(ms);
    loops[ctx.instance]!.release();
    addTime(label, sim.now - start);
  }

  function* redisOp(label = "Redis"): Process {
    const start = sim.now;
    yield sim.timeout(REDIS_RTT / 2);
    yield redis.acquire();
    yield sim.timeout(REDIS_OP);
    redis.release();
    yield sim.timeout(REDIS_RTT / 2);
    addTime(label, sim.now - start);
  }

  function queryCost(e: TraceEdge): number {
    const p = e.props;
    if (Array.isArray(p.missingIndex)) return load.tableRows * 0.00008;
    if (p.aggregate === true && !/\bWHERE\b/i.test(String(p.sql ?? ""))) return load.tableRows * 0.00005;
    if (p.statement === "SELECT") return p.unbounded === true ? 3 : 0.5;
    if (p.checkout || p.release || /^(BEGIN|COMMIT|ROLLBACK)$/.test(String(p.statement))) return 0.1;
    return 1.5;
  }

  function* dbOp(ctx: Ctx, e: TraceEdge, times: number): Process {
    const db = dbFor(e.to);
    const isRead = e.props.statement === "SELECT" || /^(find|select|count|aggregate)/i.test(String(e.label ?? ""));
    const start = sim.now;
    for (let i = 0; i < times; i++) {
      if (changes.cacheHitRatio > 0 && isRead && !ctx.held.get(e.to)) {
        yield* redisOp("Cache");
        if (sim.rng.chance(changes.cacheHitRatio)) continue;
      }
      if (e.props.checkout) {
        yield db.pools[ctx.instance]!.acquire();
        ctx.held.set(e.to, true);
        continue;
      }
      if (e.props.release) {
        if (ctx.held.get(e.to)) {
          db.pools[ctx.instance]!.release();
          ctx.held.set(e.to, false);
        }
        continue;
      }
      const ownsConnection = !ctx.held.get(e.to);
      if (ownsConnection) yield db.pools[ctx.instance]!.acquire();
      yield sim.timeout(DB_RTT / 2);
      const cores = changes.readReplica && isRead ? db.replica : db.cores;
      yield cores.acquire();
      yield sim.timeout(sim.rng.lognormal(queryCost(e), 0.5));
      cores.release();
      yield sim.timeout(DB_RTT / 2);
      if (ownsConnection) db.pools[ctx.instance]!.release();
    }
    addTime("Database", sim.now - start);
  }

  function hopCpu(node: TraceNode): number {
    if (node.kind === "handler") return 0.3;
    if (node.kind === "middleware") return node.props.builtin ? 0.03 : 0.05;
    if (node.kind === "service" || node.kind === "worker") return 0.02;
    return 0;
  }

  function* visit(ctx: Ctx, t: TreeNode): Process {
    const e = t.edge;
    const p = e.props;
    if (!takes(ctx, e)) return;
    if (p.dispatch && typeof p.candidates === "number" && !sim.rng.chance(1 / p.candidates)) return;
    const to = nodes.get(e.to)!;
    const from = nodes.get(e.from)!;
    const loopTimes = p.inLoop ? (changes.batchLoops ? 1 : p.loopExitsEarly ? 2 : Math.max(1, load.loopItems)) : 1;

    // Browser-side work costs the server nothing; reaching the server costs a round trip.
    if (to.kind === "route" && (from.kind === "client" || from.kind === "ui-event" || from.kind === "timer" || from.props.browser || from.kind === "proxy")) {
      const start = sim.now;
      yield sim.timeout(from.kind === "proxy" ? 0.3 : RTT_BROWSER);
      addTime("Network", sim.now - start);
      yield* children(ctx, t);
      return;
    }
    if (to.kind === "proxy") {
      yield* children(ctx, t);
      return;
    }
    if (e.props.role === "deliver" && from.kind === "ws-endpoint") return; // runs in browsers

    switch (to.kind) {
      case "database":
        yield* dbOp(ctx, e, loopTimes);
        break;
      case "cache":
        for (let i = 0; i < loopTimes; i++) yield* redisOp();
        break;
      case "topic":
      case "queue":
        yield* redisOp(to.kind === "topic" ? "Publish" : "Enqueue");
        break;
      case "external-api": {
        if (e.protocol === "in-process") {
          yield* cpu(ctx, 0.2);
          break;
        }
        if (changes.queueExternal && e.mode === "sync") {
          yield* redisOp("Enqueue");
          break;
        }
        const start = sim.now;
        for (let i = 0; i < loopTimes; i++) yield sim.timeout(sim.rng.lognormal(externalLatency(to), 0.6));
        addTime("Third-party APIs", sim.now - start);
        break;
      }
      case "compute": {
        const ms = bcryptMs(typeof p.cost === "number" ? p.cost : 10);
        if (to.props.pool === "event-loop") yield* cpu(ctx, ms, "CPU-heavy work");
        else {
          const start = sim.now;
          yield threads[ctx.instance]!.acquire();
          yield sim.timeout(ms);
          threads[ctx.instance]!.release();
          addTime("CPU-heavy work", sim.now - start);
        }
        break;
      }
      case "ws-endpoint":
        if (p.role === "push") yield* cpu(ctx, (load.connectedClients * CALIBRATION.cpuPerWsMessageUs) / 1000, "Pushing to sockets");
        break;
      default: {
        const c = hopCpu(to);
        for (let i = 0; i < loopTimes; i++) {
          if (c) yield* cpu(ctx, c);
          yield* children(ctx, t);
        }
        return;
      }
    }
    yield* children(ctx, t);
  }

  function* children(ctx: Ctx, t: TreeNode): Process {
    yield* sequence(ctx, t.children);
  }

  /** Runs siblings in order; consecutive `parallel` siblings run at the same time. */
  function* sequence(ctx: Ctx, list: TreeNode[]): Process {
    for (let i = 0; i < list.length; ) {
      if (!list[i]!.edge.props.parallel) {
        yield* visit(ctx, list[i]!);
        i++;
        continue;
      }
      const group: TreeNode[] = [];
      while (i < list.length && list[i]!.edge.props.parallel) group.push(list[i++]!);
      let left = group.length;
      const done = new Signal(sim);
      for (const g of group) {
        sim.spawn((function* () {
          yield* visit(ctx, g);
          if (--left === 0) done.fire();
        })());
      }
      if (left > 0) yield done.wait();
    }
  }

  const latency = new Histogram();
  let failed = 0;
  let started = 0;
  let rr = 0;
  const target = Math.min(1500, Math.max(300, Math.round(rate * 6)));

  function* request(): Process {
    const ctx: Ctx = { instance: rr++ % n, held: new Map(), branches: new Map() };
    const start = sim.now;
    yield* sequence(ctx, roots);
    if (push) yield* cpu(ctx, (load.users * CALIBRATION.cpuPerWsMessageUs) / 1000, "Pushing to sockets");
    const t = sim.now - start;
    if (t > TIMEOUT_MS) failed++;
    latency.add(Math.min(t, TIMEOUT_MS));
  }
  // Utilization is read while traffic is arriving; the drain afterwards would dilute a saturated resource.
  const busy = new Map<Resource, number>();
  const allResources = () => [...loops, ...threads, ...dbCores.values(), ...replicaCores.values(), ...[...pools.values()].flat(), redis];
  function* arrivals(): Process {
    while (started < target) {
      yield sim.timeout(sim.rng.exp(1000 / rate));
      started++;
      sim.spawn(request());
    }
    for (const r of allResources()) busy.set(r, r.utilization());
  }
  sim.spawn(arrivals());
  sim.run(target / rate * 1000 + TIMEOUT_MS * 2, 3_000_000);
  const incomplete = started - latency.count;
  failed += incomplete;

  const resources: ResourceUse[] = [];
  const use = (r: Resource) => busy.get(r) ?? r.utilization();
  const avg = (rs: Resource[]) => rs.reduce((a, r) => a + use(r), 0) / rs.length;
  const waitOf = (rs: Resource[]) => rs.reduce((a, r) => a + r.waits.mean(), 0) / rs.length;
  resources.push({ id: "event-loop", label: n > 1 ? `Event loop (${n} instances)` : "Event loop (one core)", utilization: avg(loops), waitMs: waitOf(loops) });
  if (threads.some((t) => t.waits.count)) resources.push({ id: "thread-pool", label: "libuv thread pool (4 threads)", utilization: avg(threads), waitMs: waitOf(threads) });
  for (const [id, cores] of dbCores) {
    const label = nodes.get(id)!.label.replace(/\s*\(.*\)$/, "");
    resources.push({ id: `${id}:pool`, label: `${label} connection pool`, utilization: avg(pools.get(id)!), waitMs: waitOf(pools.get(id)!) });
    resources.push({ id: `${id}:cpu`, label: `${label} CPU`, utilization: use(cores), waitMs: cores.waits.mean() });
    if (changes.readReplica) resources.push({ id: `${id}:replica`, label: `${label} read replica CPU`, utilization: use(replicaCores.get(id)!), waitMs: replicaCores.get(id)!.waits.mean() });
  }
  if (redis.waits.count) resources.push({ id: "redis", label: "Redis", utilization: use(redis), waitMs: redis.waits.mean() });
  const bottleneck = [...resources].sort((a, b) => b.utilization - a.utilization)[0];
  if (bottleneck && bottleneck.utilization > 0.95) {
    notes.push(`${bottleneck.label.replace(/ \(.*\)$/, "")} is the limit: more traffic arrives than it can serve, so its queue grows for as long as the traffic lasts. These numbers cover a ${Math.round(target / rate)}-second burst; sustained, nearly every request would time out.`);
  }
  const count = Math.max(1, latency.count);
  if (push) {
    const mb = (load.users * CALIBRATION.memoryPerConnectionKB.sse) / 1024;
    notes.push(`Pushing replaces ${Math.round(load.users / (interval / 1000)).toLocaleString("en-US")} polls per second with ${load.updatesPerSec} update${load.updatesPerSec === 1 ? "" : "s"} per second, at the cost of ${mb.toFixed(0)} MB of open SSE streams.`);
  }
  return {
    requestsPerSec: rate,
    completed: latency.count,
    p50: latency.percentile(50),
    p95: latency.percentile(95),
    p99: latency.percentile(99),
    failedPct: (failed / Math.max(1, started)) * 100,
    resources,
    bottleneck: bottleneck && bottleneck.utilization > 0.01 ? bottleneck : undefined,
    timeBy: [...time].map(([label, ms]) => ({ label, ms: ms / count })).sort((a, b) => b.ms - a.ms),
    notes,
    poolPerInstance,
  };
}

/** p95 at several load levels, to show where latency bends. */
export function loadCurve(spec: TraceSpec, flowId: string, load: Load, changes: WhatIf, points: number[]): [number, number][] {
  return points.map((rps, i) => {
    const r = simulateFlow(spec, flowId, { ...load, requestsPerSec: rps, users: rps * 5 }, changes, 11 + i);
    return [rps, r.p95];
  });
}
