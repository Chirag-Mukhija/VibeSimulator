import type { Evidence, Finding, Flow, TraceEdge, TraceNode, TraceSpec } from "@vibesim/spec";

/**
 * Deterministic scale-risk rules over a Trace Spec. Pure functions of the
 * spec, so the viewer can re-run them after a what-if change.
 */

type Severity = Finding["severity"];

interface Draft {
  rule: string;
  severity: Severity;
  title: string;
  consequence: string;
  fix: string;
  concept?: string;
  ref: string;
  extraRefs?: string[];
  evidence: Evidence[];
  data?: Record<string, unknown>;
}

export interface Rule {
  id: string;
  description: string;
  run(g: Graph): Draft[];
}

class Graph {
  readonly nodes: Map<string, TraceNode>;
  readonly edges: Map<string, TraceEdge>;
  readonly out = new Map<string, TraceEdge[]>();
  readonly flowsByEdge = new Map<string, Flow[]>();
  readonly requestEdges = new Set<string>();
  readonly spec: TraceSpec;

  constructor(spec: TraceSpec) {
    this.spec = spec;
    this.nodes = new Map(spec.nodes.map((n) => [n.id, n]));
    this.edges = new Map(spec.edges.map((e) => [e.id, e]));
    for (const e of spec.edges) this.out.set(e.from, [...(this.out.get(e.from) ?? []), e]);
    for (const f of spec.flows) {
      const entry = this.nodes.get(f.entry);
      const request = entry?.kind === "client" || entry?.kind === "ui-event" || entry?.kind === "proxy";
      for (const s of f.steps) {
        this.flowsByEdge.set(s.edge, [...(this.flowsByEdge.get(s.edge) ?? []), f]);
        if (request) this.requestEdges.add(s.edge);
      }
    }
  }

  node(id: string): TraceNode {
    return this.nodes.get(id)!;
  }

  /** Does anything downstream of `id` (through code, not across resources) touch a datastore? */
  reachesStore(id: string, seen = new Set<string>()): TraceEdge | undefined {
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const e of this.out.get(id) ?? []) {
      const to = this.node(e.to);
      if (STORE_KINDS.has(to.kind)) return e;
      if (CODE_KINDS.has(to.kind)) {
        const deeper = this.reachesStore(e.to, seen);
        if (deeper) return deeper;
      }
    }
    return undefined;
  }

  flowLabels(edgeId: string): string[] {
    return (this.flowsByEdge.get(edgeId) ?? []).map((f) => f.label);
  }
}

const STORE_KINDS = new Set(["database", "cache"]);
const CODE_KINDS = new Set(["handler", "service", "middleware", "worker"]);

const n = (x: number) => x.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${count === 1 ? word : /(s|sh|ch|x)$/.test(word) ? `${word}es` : `${word}s`}`;
const fmtMs = (ms: number) => (ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${n(ms)} ms`);

function storeLabel(node: TraceNode): string {
  return node.label.replace(/\s*\(.*\)$/, "");
}

/** Rough bcrypt cost: ~65 ms at work factor 10 on a modern core, doubling per step. */
export function bcryptMs(cost: number): number {
  return Math.round(65 * 2 ** (cost - 10));
}

export const RULES: Rule[] = [
  {
    id: "db-call-in-loop",
    description: "A database or cache round trip inside a loop (the N+1 pattern).",
    run(g) {
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        if (!e.props.inLoop) continue;
        const to = g.node(e.to);
        const direct = STORE_KINDS.has(to.kind) ? e : CODE_KINDS.has(to.kind) ? g.reachesStore(e.to) : undefined;
        if (!direct) continue;
        const store = g.node(direct.to);
        const isCache = store.kind === "cache";
        const from = g.node(e.from);
        const exitsEarly = e.props.loopExitsEarly === true;
        const severity: Severity = exitsEarly ? (isCache ? "low" : "medium") : isCache ? "medium" : "high";
        out.push({
          rule: "db-call-in-loop", severity, concept: "n-plus-one", ref: e.id,
          title: `${storeLabel(store)} call inside a loop in ${from.label}`,
          consequence: exitsEarly
            ? `The loop makes a round trip${direct.label ? ` (${direct.label})` : ""} on every pass until it finds what it wants and returns. Usually that is one or two trips, but when nothing matches it makes one trip per item, every time.`
            : `Each pass through the loop makes its own round trip${direct.label ? ` (${direct.label})` : ""}. With 50 items that is 50 sequential trips to ${storeLabel(store)}, and the request holds a connection the whole time, so under load the pool drains and requests queue.`,
          fix: isCache
            ? "Fetch everything in one command (MGET, a pipeline, or one sorted-set query) instead of one per item."
            : "Do it in one query: WHERE id IN (...), a bulk insert/upsert (createMany, insertMany), or load the rows once before the loop.",
          evidence: e.evidence, data: { store: store.id, via: direct.id },
        });
      }
      return out;
    },
  },
  {
    id: "connection-per-request",
    description: "Opens a new database connection instead of borrowing one from a pool.",
    run(g) {
      const seen = new Set<string>();
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        if (e.lifecycle !== "new-per-request" || !STORE_KINDS.has(g.node(e.to).kind)) continue;
        const key = `${e.from}>${e.to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const store = g.node(e.to);
        out.push({
          rule: "connection-per-request", severity: "high", concept: "connection-pooling", ref: e.id,
          title: `New ${storeLabel(store)} connection on every call in ${g.node(e.from).label}`,
          consequence: `Every call pays a fresh TCP + auth handshake (often 5-30 ms) before the query even starts, and the database caps total connections (Postgres defaults to 100). A traffic spike opens connections faster than they close and the database starts refusing them.`,
          fix: "Create one connection pool at startup and borrow from it for each request.",
          evidence: e.evidence,
        });
      }
      return out;
    },
  },
  {
    id: "unbounded-query",
    description: "A read with no LIMIT returns every matching row.",
    run(g) {
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        if (e.props.unbounded !== true) continue;
        const scoped = e.props.scoped === true;
        out.push({
          rule: "unbounded-query", severity: scoped ? "low" : "medium", concept: "pagination", ref: e.id,
          title: `${e.label ?? "Query"} has no limit`,
          consequence: scoped
            ? `It returns every row that matches. That is fine while the result is small and slow once it grows (a user with 100,000 followers, an order with thousands of events).`
            : `It reads the whole table on every call. Fast with 100 rows; with 1,000,000 rows it takes seconds and loads everything into memory.`,
          fix: "Add a LIMIT (or take/limit in the ORM) and paginate, ideally with a cursor.",
          evidence: e.evidence, data: { scoped },
        });
      }
      return out;
    },
  },
  {
    id: "external-call-in-request-path",
    description: "A request waits on a third-party API; also flags calls with no timeout.",
    run(g) {
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        const to = g.node(e.to);
        if (to.kind !== "external-api" || e.protocol === "in-process" || e.mode !== "sync") continue;
        const noTimeout = e.props.timeout === false;
        const inRequest = g.requestEdges.has(e.id);
        if (!inRequest && !noTimeout) continue;
        out.push(inRequest
          ? {
            rule: "external-call-in-request-path", severity: "medium", concept: "message-queue", ref: e.id,
            title: `Request waits on ${to.label}`,
            consequence: `Every ${g.flowLabels(e.id)[0] ?? "request"} waits for ${to.label} to answer. If it slows to 2 s, so does your endpoint, and in-flight requests pile up holding memory and connections.${noTimeout ? " No timeout is set, so a hung connection can hold the request for minutes." : ""}`,
            fix: `${noTimeout ? "Set a timeout (AbortSignal.timeout(5000) or the client's timeout option). " : ""}If the user doesn't need the result right away, enqueue a job and let a worker call ${to.label}.`,
            evidence: e.evidence, data: { timeout: e.props.timeout ?? null },
          }
          : {
            rule: "no-timeout", severity: "low", concept: "timeouts", ref: e.id,
            title: `No timeout on the call to ${to.label}`,
            consequence: `If ${to.label} stops answering, this call waits for the platform default (minutes), tying up the worker.`,
            fix: "Pass a timeout (AbortSignal.timeout(ms) for fetch, `timeout` for axios).",
            evidence: e.evidence,
          });
      }
      return out;
    },
  },
  {
    id: "polling-via-timer",
    description: "Browsers or workers asking for changes on a fixed interval.",
    run(g) {
      const out: Draft[] = [];
      for (const f of g.spec.flows) {
        const timer = g.node(f.entry);
        if (timer.kind !== "timer") continue;
        const ms = typeof timer.props.intervalMs === "number" ? timer.props.intervalMs : undefined;
        const edges = f.steps.map((s) => g.edges.get(s.edge)!);
        if (timer.props.browser) {
          const hit = edges.find((e) => g.node(e.to).kind === "route");
          if (!hit) continue;
          const route = g.node(hit.to);
          const perSecond = ms ? 10_000 / (ms / 1000) : undefined;
          out.push({
            rule: "polling-via-timer", severity: "medium", concept: "short-polling", ref: timer.id,
            title: `Every open tab polls ${route.label}${ms ? ` every ${fmtMs(ms)}` : ""}`,
            consequence: `The browser asks whether anything changed even when nothing did.${perSecond ? ` 10,000 open tabs make about ${n(Math.round(perSecond))} requests per second to ${route.label}, almost all returning the same data.` : ""} Cost grows with users, not with how often data changes.`,
            fix: "Push changes instead (Server-Sent Events or WebSocket), poll less often, or use long polling.",
            evidence: timer.evidence, data: { intervalMs: ms ?? null, route: route.id },
          });
        } else if (timer.props.loop && edges.some((e) => STORE_KINDS.has(g.node(e.to).kind))) {
          out.push({
            rule: "worker-idle-polling", severity: "low", concept: "short-polling", ref: timer.id,
            title: `Worker checks for work${ms ? ` every ${fmtMs(ms)}` : ""} even when there is none`,
            consequence: `Each idle worker keeps querying the store. With 20 workers that is a steady stream of empty reads, and new jobs wait up to ${ms ? fmtMs(ms) : "one interval"} before anyone notices them.`,
            fix: "Block on the queue instead of polling (BRPOP / BLMOVE, BullMQ, or LISTEN/NOTIFY in Postgres).",
            evidence: timer.evidence, data: { intervalMs: ms ?? null },
          });
        }
      }
      return out;
    },
  },
  {
    id: "cpu-on-request-path",
    description: "CPU-heavy work that blocks the event loop or saturates the thread pool.",
    run(g) {
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        const to = g.node(e.to);
        if (to.kind !== "compute" || !g.requestEdges.has(e.id)) continue;
        const cost = typeof e.props.cost === "number" ? e.props.cost : 10;
        const ms = bcryptMs(cost);
        if (to.props.pool === "event-loop") {
          out.push({
            rule: "cpu-blocking-event-loop", severity: "high", concept: "concurrency-models", ref: e.id,
            title: `${e.label ?? to.label} blocks the event loop`,
            consequence: `It runs on Node's single main thread. While it works (roughly ${n(ms)} ms per call for password hashing), this process cannot answer any other request, so one login slows everyone down.`,
            fix: "Use the async native version (bcrypt or @node-rs/bcrypt runs on the thread pool) or move the work to a worker thread.",
            evidence: e.evidence, data: { estimatedMs: ms },
          });
        } else if (/bcrypt|argon2/.test(String(to.props.library))) {
          const perSecond = Math.round((4 * 1000) / ms);
          out.push({
            rule: "threadpool-saturation", severity: "medium", concept: "concurrency-models", ref: e.id,
            title: `${e.label ?? to.label} competes for libuv's 4 threads`,
            consequence: `Hashing runs off the main thread, but on a pool of only 4 threads by default. At work factor ${cost} each hash takes roughly ${n(ms)} ms (estimate), so one process handles about ${plural(perSecond, "hash")} per second before requests start queueing for a thread, and file and DNS work waits behind them too.`,
            fix: "Raise UV_THREADPOOL_SIZE, run more instances, or rate-limit the endpoint.",
            evidence: e.evidence, data: { estimatedMs: ms, cost, perSecondPerProcess: perSecond },
          });
        }
      }
      return out;
    },
  },
  {
    id: "push-triggers-fetch",
    description: "A pushed message makes every browser re-fetch from the server.",
    run(g) {
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const f of g.spec.flows) {
        const edges = f.steps.map((s) => g.edges.get(s.edge)!);
        const deliver = edges.findIndex((e) => e.props.role === "deliver" && g.node(e.from).kind === "ws-endpoint");
        if (deliver < 0) continue;
        const fetch = edges.slice(deliver + 1).find((e) => g.node(e.to).kind === "route");
        if (!fetch || seen.has(fetch.id)) continue;
        seen.add(fetch.id);
        const route = g.node(fetch.to);
        out.push({
          rule: "push-triggers-fetch", severity: "medium", concept: "websocket", ref: fetch.id, extraRefs: [edges[deliver]!.id],
          title: `Each pushed message makes every browser call ${route.label}`,
          consequence: `The server pushes an event and every connected page answers by requesting ${route.label}. 100 open dashboards and 20 events per second become 2,000 requests per second to ${route.label}, which is more load than polling would cause.`,
          fix: "Send the data the page needs inside the pushed message, or debounce the refresh.",
          evidence: fetch.evidence, data: { route: route.id },
        });
      }
      return out;
    },
  },
  {
    id: "polling-with-push",
    description: "A page polls even though it already receives live updates.",
    run(g) {
      const out: Draft[] = [];
      const pushedFiles = new Set(g.spec.edges.filter((e) => e.props.role === "deliver" && g.node(e.from).kind === "ws-endpoint").map((e) => e.evidence[0]!.file));
      for (const f of g.spec.flows) {
        const timer = g.node(f.entry);
        if (timer.kind !== "timer" || !timer.props.browser) continue;
        if (!pushedFiles.has(timer.evidence[0]!.file)) continue;
        out.push({
          rule: "polling-with-push", severity: "low", concept: "websocket", ref: timer.id,
          title: "Page polls even though it already has a live WebSocket",
          consequence: "Updates already arrive over the socket, so the timer mostly repeats work and adds steady load.",
          fix: "Poll only while the socket is disconnected, or drop the timer.",
          evidence: timer.evidence,
        });
      }
      return out;
    },
  },
  {
    id: "in-memory-state",
    description: "Request handlers keep state in process memory.",
    run(g) {
      const out: Draft[] = [];
      const inRequest = new Set([...g.requestEdges].flatMap((id) => [g.edges.get(id)!.from, g.edges.get(id)!.to]));
      for (const node of g.spec.nodes) {
        const names = node.props.mutatesModuleState;
        if (!Array.isArray(names) || !names.length || !inRequest.has(node.id) || node.props.browser) continue;
        const list = names.map((x) => `\`${x}\``).join(", ");
        out.push({
          rule: "in-memory-state", severity: "medium", concept: "load-balancer", ref: node.id,
          title: `${node.label} keeps state in this process's memory`,
          consequence: `${list} lives inside one Node process. Run a second instance behind a load balancer and each has its own copy, so counts, sessions or caches disagree depending on which instance answers. A restart wipes it.`,
          fix: "Keep shared state in Redis or the database.",
          evidence: node.evidence, data: { names },
        });
      }
      return out;
    },
  },
  {
    id: "rate-limit-in-memory",
    description: "express-rate-limit with its default per-process store.",
    run(g) {
      const out: Draft[] = [];
      for (const node of g.spec.nodes) {
        if (node.props.library !== "express-rate-limit") continue;
        if ((g.out.get(node.id) ?? []).some((e) => STORE_KINDS.has(g.node(e.to).kind))) continue;
        out.push({
          rule: "rate-limit-in-memory", severity: "medium", concept: "load-balancer", ref: node.id,
          title: "Rate limits are counted per process",
          consequence: "The limiter uses its default in-memory store. With 3 instances a client gets 3 times the limit, and every deploy resets the counters.",
          fix: "Give it a shared store such as rate-limit-redis.",
          evidence: node.evidence,
        });
      }
      return out;
    },
  },
  {
    id: "websocket-no-backplane",
    description: "Server pushes reach only sockets connected to the same instance.",
    run(g) {
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const f of g.spec.flows) {
        const entry = g.node(f.entry);
        if (entry.kind === "topic" || entry.kind === "queue") continue;
        for (const s of f.steps) {
          const e = g.edges.get(s.edge)!;
          if (e.props.role !== "push" || seen.has(e.id)) continue;
          const ws = g.node(e.to);
          if (ws.props.backplane) continue;
          seen.add(e.id);
          out.push({
            rule: "websocket-no-backplane", severity: "medium", concept: "pub-sub", ref: e.id,
            title: `Pushes from ${g.node(e.from).label} only reach this instance`,
            consequence: "The message goes to sockets connected to the process that handled the request. Add a second instance and users connected to the other one never receive it.",
            fix: "Publish through a backplane: the socket.io Redis adapter, or Redis pub/sub with every instance subscribed.",
            evidence: e.evidence,
          });
        }
      }
      return out;
    },
  },
  {
    id: "full-table-aggregate",
    description: "COUNT/SUM over a whole table on a request path.",
    run(g) {
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        if (e.props.aggregate !== true || /\bWHERE\b/i.test(String(e.props.sql ?? "")) || !g.requestEdges.has(e.id)) continue;
        const table = String(e.props.table ?? "the table");
        out.push({
          rule: "full-table-aggregate", severity: "medium", concept: "cache-aside", ref: e.id,
          title: `${e.label ?? "Aggregate"} scans all of ${table} on every request`,
          consequence: `Counting or summing with no WHERE reads every row of ${table} each time. It is quick today and grows linearly with the table, and every caller pays it.`,
          fix: "Keep running counters (update them when rows change), cache the result for a few seconds, or restrict the query with a WHERE on an indexed column.",
          evidence: e.evidence, data: { table },
        });
      }
      return out;
    },
  },
  {
    id: "missing-index",
    description: "A WHERE clause filters on columns no index covers (per the repo's own SQL schema).",
    run(g) {
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        const cols = e.props.missingIndex;
        if (!Array.isArray(cols) || !cols.length) continue;
        const table = String(e.props.table ?? "the table");
        const list = cols.join(", ");
        out.push({
          rule: "missing-index", severity: "medium", concept: "n-plus-one", ref: e.id,
          title: `No index for ${table}.${cols[0]} (${e.label ?? "query"})`,
          consequence: `Nothing in the schema indexes ${list}, so the database reads every row of ${table} to find matches. Instant with 1,000 rows, seconds with 10 million, and it gets slower every day the table grows.`,
          fix: `Add an index: CREATE INDEX ON ${table} (${list});`,
          evidence: e.evidence, data: { table, columns: cols },
        });
      }
      return out;
    },
  },
  {
    id: "redundant-index",
    description: "An index that duplicates a primary key, unique constraint or longer index.",
    run(g) {
      const out: Draft[] = [];
      for (const node of g.spec.nodes) {
        const tables = node.props.tables as Record<string, { redundant?: { index: string; coveredBy: string; file: string; line: number }[] }> | undefined;
        if (!tables) continue;
        for (const [table, t] of Object.entries(tables)) {
          for (const r of t.redundant ?? []) {
            out.push({
              rule: "redundant-index", severity: "low", concept: "n-plus-one", ref: node.id,
              title: `${r.index} duplicates ${r.coveredBy} on ${table}`,
              consequence: `${r.coveredBy} already gives the database an index starting with the same columns, so ${r.index} is never needed for reads. Every insert and update still has to maintain both, which costs write time and disk.`,
              fix: `Drop it: DROP INDEX ${r.index};`,
              evidence: [{ file: r.file, line: r.line }], data: { table, index: r.index, coveredBy: r.coveredBy },
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: "db-per-request-middleware",
    description: "Middleware that queries a datastore on every request it guards.",
    run(g) {
      const out: Draft[] = [];
      for (const node of g.spec.nodes) {
        if (node.kind !== "middleware" || node.props.library === "express-rate-limit") continue;
        const hit = (g.out.get(node.id) ?? []).find((e) => STORE_KINDS.has(g.node(e.to).kind));
        if (!hit) continue;
        const store = g.node(hit.to);
        out.push({
          rule: "db-per-request-middleware", severity: "low", concept: "cache-aside", ref: node.id,
          title: `${node.label} reads ${storeLabel(store)} on every request`,
          consequence: `Every request through this middleware pays a round trip to ${storeLabel(store)} before any real work starts. At 1,000 requests per second that is 1,000 extra queries per second.`,
          fix: "Cache the lookup briefly (Redis or an in-process LRU with a short TTL), or carry the needed claims in a signed token.",
          evidence: hit.evidence, data: { store: store.id },
        });
      }
      return out;
    },
  },
];

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function runFindings(spec: TraceSpec): Finding[] {
  const g = new Graph(spec);
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const rule of RULES) {
    for (const d of rule.run(g)) {
      const id = `finding:${d.rule}:${d.ref}${d.rule === "redundant-index" ? `:${String(d.data?.index)}` : ""}`;
      if (seen.has(id)) continue;
      seen.add(id);
      findings.push({
        id, rule: d.rule, severity: d.severity, title: d.title, consequence: d.consequence, fix: d.fix,
        ...(d.concept ? { concept: d.concept } : {}),
        refs: [d.ref, ...(d.extraRefs ?? [])], evidence: d.evidence, data: d.data ?? {},
      });
    }
  }
  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.rule.localeCompare(b.rule));
}
