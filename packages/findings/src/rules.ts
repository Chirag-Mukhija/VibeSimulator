import type { Evidence, Finding, Flow, TraceEdge, TraceNode, TraceSpec } from "@vibesim/spec";

/**
 * Deterministic scale-risk rules over a Trace Spec. Pure functions of the
 * spec, so the viewer can re-run them after a what-if change.
 *
 * Every consequence and fix is written from facts in the trace (the statement, the
 * table, the limits found in the code); a rule says nothing it can't back up.
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
  /** Overrides the default id (rule + ref) when one ref can carry several findings. */
  key?: string;
}

export interface Rule {
  id: string;
  description: string;
  run(g: Graph): Draft[];
}

interface TableInfo {
  columns: string[];
  indexes: { name: string; columns: string[]; unique: boolean; source: string; file?: string; line?: number }[];
  redundant: { index: string; coveredBy: string; file: string; line: number }[];
  file?: string;
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
        const list = this.flowsByEdge.get(s.edge) ?? [];
        if (!list.includes(f)) list.push(f);
        this.flowsByEdge.set(s.edge, list);
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

  flowEdges(f: Flow): TraceEdge[] {
    return f.steps.map((s) => this.edges.get(s.edge)!);
  }

  /** Tables from the repo's .sql files, attached to the database node. */
  tables(dbId: string): Record<string, TableInfo> {
    return (this.node(dbId).props.tables as Record<string, TableInfo> | undefined) ?? {};
  }

  /** Rate limits that apply to a flow: express-rate-limit middleware or the proxy's limit_req. */
  limitsFor(f: Flow): string[] {
    const out: string[] = [];
    for (const e of this.flowEdges(f)) {
      for (const id of [e.from, e.to]) {
        const n = this.node(id);
        if (n.props.library === "express-rate-limit" && typeof n.props.max === "number" && typeof n.props.windowMs === "number") {
          out.push(`${n.props.max} per ${fmtMs(n.props.windowMs)} per client`);
        }
        if (n.kind === "proxy" && typeof n.props.rateLimit === "string") out.push(`${n.props.rateLimit} per client IP at the proxy`);
      }
    }
    return [...new Set(out)];
  }
}

const STORE_KINDS = new Set(["database", "cache"]);
const CODE_KINDS = new Set(["handler", "service", "middleware", "worker"]);

const n = (x: number) => x.toLocaleString("en-US");
const plural = (count: number, word: string) => `${n(count)} ${count === 1 ? word : /(s|sh|ch|x)$/.test(word) ? `${word}es` : `${word}s`}`;
const fmtMs = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${n(ms)} ms`);
const list = (items: string[]) => (items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

function storeLabel(node: TraceNode): string {
  return node.label.replace(/\s*\(.*\)$/, "");
}

/** Rough bcrypt cost: ~65 ms at work factor 10 on a modern core, doubling per step. */
export function bcryptMs(cost: number): number {
  return Math.round(65 * 2 ** (cost - 10));
}

const statementOf = (e: TraceEdge) => String(e.props.statement ?? "");
const sqlOf = (e: TraceEdge) => String(e.props.sql ?? "");
/** Runs only after a guard inside its function passed (e.g. after `if (!jobId) break;`). */
const behindGuard = (e: TraceEdge) => Array.isArray(e.props.branchPath) && (e.props.branchPath as unknown[]).length > 0;

function whereColumns(sql: string): string[] {
  const where = /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bGROUP\s+BY\b|\bLIMIT\b|\bOFFSET\b|\bRETURNING\b|$)/i.exec(sql)?.[1] ?? "";
  return [...new Set([...where.matchAll(/(?:\b\w+\.)?(\w+)\s*(?:=|<|>|\bIN\b|\bLIKE\b|\bILIKE\b)/gi)].map((m) => m[1]!.toLowerCase()))];
}

function orderColumns(sql: string): string[] {
  const order = /\bORDER\s+BY\b([\s\S]*?)(?:\bLIMIT\b|\bOFFSET\b|\bFOR\b|$)/i.exec(sql)?.[1] ?? "";
  return order.split(",").map((part) => /(?:\b\w+\.)?(\w+)/.exec(part.trim())?.[1]?.toLowerCase()).filter((c): c is string => !!c);
}

/** What the request does, for choosing advice: renders/returns data, takes payment, sends a message... */
function callPurpose(g: Graph, e: TraceEdge, to: TraceNode): "payment" | "email" | "token" | "llm" | "data" {
  const text = `${to.label} ${e.label ?? ""} ${String(to.props.host ?? "")}`.toLowerCase();
  if (e.protocol === "smtp" || /smtp|sendgrid|resend|mail|twilio|messages\.create/.test(text)) return "email";
  if (/stripe|paypal|charges|payment|checkout/.test(text)) return "payment";
  if (/oauth2?\/token|access_token|refresh|token/.test(text) && !/x-api/.test(text)) return "token";
  if (/openai|anthropic|groq|gemini|huggingface|chat\/completions|langchain/.test(text)) return "llm";
  void g;
  return "data";
}

export const RULES: Rule[] = [
  {
    id: "db-call-in-loop",
    description: "A database or cache round trip inside a loop (the N+1 pattern).",
    run(g) {
      // One finding per function and store, listing every call it makes in loops.
      const groups = new Map<string, { from: TraceNode; store: TraceNode; edges: TraceEdge[]; direct: TraceEdge[]; exitsEarly: boolean }>();
      for (const e of g.spec.edges) {
        if (!e.props.inLoop) continue;
        // A loop that stops at the first match, where this call only runs once something was found,
        // costs one call per success, not one per item.
        if (e.props.loopExitsEarly === true && behindGuard(e)) continue;
        if (e.props.parallel === true) continue; // Promise.all over items: one wait, counted elsewhere
        const to = g.node(e.to);
        const direct = STORE_KINDS.has(to.kind) ? e : CODE_KINDS.has(to.kind) ? g.reachesStore(e.to) : undefined;
        if (!direct) continue;
        const store = g.node(direct.to);
        const key = `${e.from}>${store.id}`;
        const group = groups.get(key) ?? { from: g.node(e.from), store, edges: [], direct: [], exitsEarly: true };
        group.edges.push(e);
        group.direct.push(direct);
        group.exitsEarly &&= e.props.loopExitsEarly === true;
        groups.set(key, group);
      }
      const out: Draft[] = [];
      for (const { from, store, edges, direct, exitsEarly } of groups.values()) {
        const isCache = store.kind === "cache";
        const ops = [...new Set(direct.map((d) => d.label).filter((l): l is string => !!l))];
        const statements = new Set(direct.map(statementOf));
        const fix = isCache
          ? "Send the commands in one round trip: a pipeline (or MULTI), MGET for plain keys, or restructure so one command answers the question."
          : statements.has("INSERT")
            ? "Insert all the rows in one statement (a multi-row INSERT, or insertMany/createMany in an ORM)."
            : statements.has("UPDATE") || statements.has("DELETE")
              ? "Change all the rows in one statement: UPDATE/DELETE ... WHERE id = ANY($1) with the list of ids."
              : "Load all the rows in one query (WHERE id = ANY($1), or a JOIN) before the loop, then look them up in memory.";
        out.push({
          rule: "db-call-in-loop", severity: exitsEarly ? "low" : isCache ? "medium" : "high", concept: "n-plus-one", ref: edges[0]!.id, extraRefs: edges.slice(1).map((x) => x.id),
          title: `${storeLabel(store)} call${ops.length > 1 ? "s" : ""} inside a loop in ${from.label}`,
          consequence: exitsEarly
            ? `The loop sends ${ops.length ? list(ops.map((o) => `\`${o}\``)) : "a command"} on each pass and stops at the first hit. When something is found early that's one or two round trips; when nothing matches, it makes one per pass, every time.`
            : `Each pass through the loop makes its own round trip${ops.length ? ` (${list(ops.map((o) => `\`${o}\``))})` : ""}. With 50 items that is 50 trips one after another, and the request holds ${isCache ? "Redis's attention" : "a database connection"} the whole time.`,
          fix,
          evidence: edges[0]!.evidence, data: { store: store.id, calls: ops },
        });
      }
      return out;
    },
  },
  {
    id: "connection-per-request",
    description: "Opens a new connection for each request instead of reusing one.",
    run(g) {
      const seen = new Set<string>();
      const out: Draft[] = [];
      for (const e of g.spec.edges) {
        if (e.lifecycle !== "new-per-request") continue;
        const to = g.node(e.to);
        const key = `${e.from}>${e.to}`;
        if (seen.has(key)) continue;
        if (STORE_KINDS.has(to.kind)) {
          seen.add(key);
          const store = storeLabel(to);
          out.push({
            rule: "connection-per-request", severity: "high", concept: "connection-pooling", ref: e.id,
            title: `New ${store} connection on every call in ${g.node(e.from).label}`,
            consequence: `Every call opens a fresh connection (TCP, often TLS, then authentication) before any query runs, and closes it after. That adds milliseconds to every request, and under a traffic spike connections open faster than they close until ${store} refuses new ones.`,
            fix: to.props.engine === "mongodb"
              ? "Create one MongoClient when the app starts (or reuse the one your ODM already holds) and share it across requests."
              : "Create one connection pool at startup and borrow from it for each request.",
            evidence: e.evidence,
          });
        } else if (to.kind === "external-api" && e.protocol === "smtp") {
          seen.add(key);
          out.push({
            rule: "connection-per-request", severity: "low", concept: "connection-pooling", ref: e.id,
            title: "A new SMTP connection for every email",
            consequence: "Without `pool: true`, nodemailer connects to the mail server, negotiates TLS and logs in for each message, then disconnects. Each email costs those round trips, and a burst of emails opens a burst of connections the mail server may throttle.",
            fix: "Create one transporter when the app starts with `pool: true` and reuse it, or send emails from a background job.",
            evidence: e.evidence,
          });
        }
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
        const table = typeof e.props.table === "string" ? e.props.table : "the table";
        const by = whereColumns(sqlOf(e));
        out.push({
          rule: "unbounded-query", severity: scoped ? "low" : "medium", concept: "pagination", ref: e.id,
          title: `${e.label ?? "Query"} has no limit`,
          consequence: scoped
            ? `It returns every ${table} row matching ${by.length ? list(by) : "the filter"}. That's fine while each one has a handful, and slow and memory-hungry for one that has thousands.`
            : `It reads the whole ${table} table on every call. Fast with 100 rows; with 1,000,000 rows it takes seconds and loads everything into memory.`,
          fix: "If the caller only shows a page, add a LIMIT and paginate (keyset pagination stays fast on deep pages). If the code needs every row, keep the query but process the rows in batches.",
          evidence: e.evidence, data: { scoped, table },
        });
      }
      return out;
    },
  },
  {
    id: "external-call-in-request-path",
    description: "Requests that wait on a third-party service; also calls with no timeout.",
    run(g) {
      const out: Draft[] = [];
      // One finding per outside service: which requests wait on it, and how.
      const byService = new Map<string, TraceEdge[]>();
      for (const e of g.spec.edges) {
        const to = g.node(e.to);
        if (to.kind !== "external-api" || e.protocol === "in-process" || e.mode !== "sync") continue;
        if (e.props.oauth) continue; // OAuth code exchange is the login itself, not an avoidable wait
        byService.set(to.id, [...(byService.get(to.id) ?? []), e]);
      }
      for (const [id, edges] of byService) {
        const to = g.node(id);
        const inRequest = edges.filter((e) => g.requestEdges.has(e.id));
        const noTimeout = edges.filter((e) => e.props.timeout === false);
        if (inRequest.length) {
          const routes = [...new Set(inRequest.flatMap((e) => g.flowLabels(e.id)))];
          const parallel = inRequest.length > 1 && inRequest.every((e) => e.props.parallel);
          const purpose = callPurpose(g, inRequest[0]!, to);
          const fix = {
            payment: "Keep it in the request (the user has to know whether the payment worked), but set a timeout and send an idempotency key so a retry can't charge twice.",
            email: "Send the email from a background job so the response doesn't wait for the mail server, or at least reuse one pooled connection.",
            token: "Cache the token until it expires instead of fetching it on every request.",
            llm: "Stream the response, set a timeout, and show progress; for work the user doesn't watch, run it in a background job.",
            data: "Set a timeout, and cache the response for as long as the data stays valid (most read-only API data changes slowly).",
          }[purpose];
          out.push({
            rule: "external-call-in-request-path", severity: "medium", concept: purpose === "data" ? "cache-aside" : "message-queue", ref: inRequest[0]!.id, extraRefs: inRequest.slice(1).map((e) => e.id),
            title: routes.length === 1 ? `${routes[0]} waits on ${to.label}` : `${routes.length} routes wait on ${to.label}`,
            consequence: `${routes.length === 1 ? "This request" : `${list(routes.slice(0, 4))}${routes.length > 4 ? ` and ${routes.length - 4} more` : ""}`} can't answer until ${to.label} does${inRequest.length > 1 ? ` (${plural(inRequest.length, "call")}${parallel ? ", sent at the same time" : ", one after another"})` : ""}. If it slows to 2 s, so do these requests, and slow requests pile up holding memory and connections.${noTimeout.length ? " No timeout is set; Node's fetch then waits about 5 minutes for headers before giving up." : ""}`,
            fix: `${noTimeout.length && purpose !== "payment" ? "Set a timeout (AbortSignal.timeout(5000) for fetch). " : ""}${fix}`,
            evidence: inRequest[0]!.evidence, data: { routes, calls: inRequest.length, timeout: noTimeout.length ? false : null },
          });
        } else if (noTimeout.length) {
          out.push({
            rule: "no-timeout", severity: "low", concept: "timeouts", ref: noTimeout[0]!.id,
            title: `No timeout on the call to ${to.label}`,
            consequence: `If ${to.label} stops answering, this call waits for the platform default (minutes), tying up the worker.`,
            fix: "Pass a timeout (AbortSignal.timeout(ms) for fetch, `timeout` for axios).",
            evidence: noTimeout[0]!.evidence,
          });
        }
      }
      return out;
    },
  },
  {
    id: "polling-via-timer",
    description: "Browsers or workers asking for changes on a fixed interval.",
    run(g) {
      const out: Draft[] = [];
      const pushedFiles = new Set(g.spec.edges.filter((e) => e.props.role === "deliver" && g.node(e.from).kind === "ws-endpoint").map((e) => e.evidence[0]!.file));
      for (const f of g.spec.flows) {
        const timer = g.node(f.entry);
        if (timer.kind !== "timer") continue;
        const ms = typeof timer.props.intervalMs === "number" ? timer.props.intervalMs : undefined;
        const edges = g.flowEdges(f);
        if (timer.props.browser) {
          const hit = edges.find((e) => g.node(e.to).kind === "route");
          if (!hit) continue;
          const route = g.node(hit.to);
          const perSecond = ms ? 10_000 / (ms / 1000) : undefined;
          const hasSocket = pushedFiles.has(timer.evidence[0]!.file);
          out.push({
            rule: "polling-via-timer", severity: "medium", concept: "short-polling", ref: timer.id,
            title: `Every open tab polls ${route.label}${ms ? ` every ${fmtMs(ms)}` : ""}${hasSocket ? " on top of its live WebSocket" : ""}`,
            consequence: `The browser asks whether anything changed even when nothing did.${perSecond ? ` 10,000 open tabs make about ${n(Math.round(perSecond))} requests per second to ${route.label}, most returning the same data.` : ""} Cost grows with users, not with how often data changes.${hasSocket ? " This page already receives pushed updates, so the timer mostly repeats work." : ""}`,
            fix: hasSocket
              ? `Send what ${route.label} returns over the socket (or push a snapshot every few seconds from the server). If the timer also catches things the socket can't report, keep it but slow it down.`
              : "Push changes instead (Server-Sent Events or WebSocket), poll less often, or use long polling.",
            evidence: timer.evidence, data: { intervalMs: ms ?? null, route: route.id, alongsideSocket: hasSocket },
          });
        } else if (timer.props.loop && edges.some((e) => STORE_KINDS.has(g.node(e.to).kind))) {
          const store = edges.map((e) => g.node(e.to)).find((t) => STORE_KINDS.has(t.kind))!;
          out.push({
            rule: "worker-idle-polling", severity: "low", concept: "short-polling", ref: timer.id,
            title: `Worker checks ${storeLabel(store)} for work${ms ? ` every ${fmtMs(ms)}` : ""} even when there is none`,
            consequence: `An idle worker keeps asking ${storeLabel(store)} whether there's work, and a new job waits up to ${ms ? fmtMs(ms) : "one interval"} before a worker notices it. Each extra idle worker adds the same steady trickle of empty reads.`,
            fix: "Wake idle workers when work arrives (a pub/sub message, LISTEN/NOTIFY, or a blocking pop where the data structure allows it) and keep a slower timer as a fallback for delayed jobs.",
            evidence: timer.evidence, data: { intervalMs: ms ?? null, store: store.id },
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
      // compare() uses the cost stored in the hash, which is whatever this repo hashes with.
      const hashCosts = g.spec.edges.filter((e) => g.node(e.to).kind === "compute" && typeof e.props.cost === "number").map((e) => e.props.cost as number);
      const repoCost = hashCosts.length ? Math.max(...hashCosts) : undefined;
      for (const e of g.spec.edges) {
        const to = g.node(e.to);
        if (to.kind !== "compute" || !g.requestEdges.has(e.id)) continue;
        const own = typeof e.props.cost === "number" ? e.props.cost : undefined;
        const cost = own ?? repoCost ?? 10;
        const costNote = own !== undefined ? `At work factor ${cost}` : repoCost !== undefined ? `It uses the cost stored in the hash, ${cost} where this repo hashes, so` : "At bcrypt's default work factor of 10";
        const ms = bcryptMs(cost);
        const routes = [...new Set(g.flowLabels(e.id))];
        const limits = [...new Set((g.flowsByEdge.get(e.id) ?? []).flatMap((f) => g.limitsFor(f)))];
        if (to.props.pool === "event-loop") {
          out.push({
            rule: "cpu-blocking-event-loop", severity: "high", concept: "concurrency-models", ref: e.id,
            title: `${e.label ?? to.label} blocks the event loop`,
            consequence: `It runs on Node's single main thread. ${costNote} each call takes roughly ${n(ms)} ms, and during that time this process can't answer any other request, so one login slows everyone down.`,
            fix: "Use the async version (bcrypt.hash/compare run on the thread pool) or move the work to a worker thread.",
            evidence: e.evidence, data: { estimatedMs: ms, cost },
          });
        } else if (/bcrypt|argon2/.test(String(to.props.library))) {
          const perSecond = Math.max(1, Math.round((4 * 1000) / ms));
          const shared = g.spec.edges.filter((x) => x.to === e.to && g.requestEdges.has(x.id)).length > 1;
          out.push({
            rule: "threadpool-saturation", severity: "medium", concept: "concurrency-models", ref: e.id,
            title: `${e.label ?? to.label} competes for libuv's 4 threads`,
            consequence: `Hashing runs off the main thread, but on a pool of only 4 threads by default. ${costNote} each one takes roughly ${n(ms)} ms (an estimate; it depends on the CPU), so one process handles about ${plural(perSecond, "hash")} per second${shared ? ", shared by every route that hashes or checks passwords" : ""} before ${list(routes.slice(0, 2)) || "requests"} start queueing for a thread. File reads and DNS lookups (for example a new database connection) wait behind them too.`,
            fix: `${limits.length ? `It's already rate-limited (${list(limits)}), which stops one client from hammering it but not a real peak of many users. ` : ""}Raise UV_THREADPOOL_SIZE (to about the number of CPU cores), run more instances, or move hashing to a separate worker pool.`,
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
        const edges = g.flowEdges(f);
        const deliver = edges.findIndex((e) => e.props.role === "deliver" && g.node(e.from).kind === "ws-endpoint");
        if (deliver < 0) continue;
        const fetch = edges.slice(deliver + 1).find((e) => g.node(e.to).kind === "route");
        if (!fetch || seen.has(fetch.id)) continue;
        seen.add(fetch.id);
        const route = g.node(fetch.to);
        // Evidence: where the page reacts to the message, not the shared fetch helper.
        const trigger = edges[deliver + 1] ?? fetch;
        out.push({
          rule: "push-triggers-fetch", severity: "medium", concept: "websocket", ref: fetch.id, extraRefs: [edges[deliver]!.id],
          title: `Each pushed message makes every browser call ${route.label}`,
          consequence: `The server pushes an event and every connected page answers by requesting ${route.label}. 100 open dashboards and 20 events per second become 2,000 requests per second to ${route.label}, more load than polling would cause.`,
          fix: "Send the data the page needs inside the pushed message, refresh only for the message types that change it, or debounce the refresh.",
          evidence: trigger.evidence, data: { route: route.id },
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
        const shown = names.map((x) => `\`${x}\``).join(", ");
        out.push({
          rule: "in-memory-state", severity: "medium", concept: "load-balancer", ref: node.id,
          title: `${node.label} keeps state in this process's memory`,
          consequence: `${shown} lives inside one Node process. Run a second instance behind a load balancer and each has its own copy, so counts, sessions or caches disagree depending on which instance answers. A restart wipes it.`,
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
      const limiters = g.spec.nodes.filter((node) => node.props.library === "express-rate-limit" && node.props.sharedStore !== true
        && !(g.out.get(node.id) ?? []).some((e) => STORE_KINDS.has(g.node(e.to).kind)));
      if (!limiters.length) return [];
      const described = limiters.map((l) => `${l.label.replace(/\s*\(express-rate-limit\)$/, "")}${typeof l.props.max === "number" && typeof l.props.windowMs === "number" ? ` (${l.props.max} per ${fmtMs(l.props.windowMs)})` : ""}`);
      const engines = new Set(g.spec.nodes.filter((x) => STORE_KINDS.has(x.kind)).map((x) => String(x.props.engine ?? "")));
      const store = engines.has("redis") ? "rate-limit-redis, since Redis is already here" : engines.has("mongodb") ? "a MongoDB-backed store (rate-limit-mongo), since MongoDB is already here" : "a shared store such as Redis";
      return [{
        rule: "rate-limit-in-memory", severity: "medium", concept: "load-balancer", ref: limiters[0]!.id, extraRefs: limiters.slice(1).map((l) => l.id),
        title: limiters.length === 1 ? "Rate limits are counted per process" : `${limiters.length} rate limiters count per process`,
        consequence: `${list(described)} keep${limiters.length === 1 ? "s" : ""} counters in this process's memory. With 3 instances a client gets 3 times the limit, and every restart resets the counts. Each limiter also keeps one counter per client across every route that uses it, so those routes share one budget.`,
        fix: `Give the limiters a shared store: ${store}.`,
        evidence: limiters[0]!.evidence, data: { limiters: limiters.map((l) => l.id) },
      }];
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
        for (const e of g.flowEdges(f)) {
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
        if (e.props.aggregate !== true || /\bWHERE\b/i.test(sqlOf(e)) || !g.requestEdges.has(e.id)) continue;
        const table = String(e.props.table ?? "the table");
        const routes = [...new Set(g.flowLabels(e.id))];
        out.push({
          rule: "full-table-aggregate", severity: "medium", concept: "cache-aside", ref: e.id,
          title: `${e.label ?? "Aggregate"} scans all of ${table}${routes.length ? ` on every ${routes.length === 1 ? routes[0] : "call"}` : ""}`,
          consequence: `Counting or summing with no WHERE reads every row of ${table} each time. It's quick while the table is small and grows linearly with it, and every caller pays it.`,
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
        const shown = cols.join(", ");
        out.push({
          rule: "missing-index", severity: "medium", concept: "n-plus-one", ref: e.id,
          title: `No index for ${table}.${cols[0]} (${e.label ?? "query"})`,
          consequence: `Nothing in the schema indexes ${shown}, so the database reads every row of ${table} to find matches. Instant with 1,000 rows, seconds with 10 million, and slower every day the table grows.`,
          fix: `Add an index in a new migration: CREATE INDEX ON ${table} (${shown});`,
          evidence: e.evidence, data: { table, columns: cols },
        });
      }
      return out;
    },
  },
  {
    id: "sort-without-index",
    description: "A paginated query sorts on columns no index provides in order.",
    run(g) {
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const e of g.spec.edges) {
        if (statementOf(e) !== "SELECT" || !e.props.hasLimit || !/\bORDER\s+BY\b/i.test(sqlOf(e)) || /\bJOIN\b/i.test(sqlOf(e))) continue;
        const table = typeof e.props.table === "string" ? e.props.table : undefined;
        const info = table ? g.tables(e.to)[table] : undefined;
        if (!info) continue;
        const where = whereColumns(sqlOf(e)).filter((c) => info.columns.includes(c));
        const order = orderColumns(sqlOf(e)).filter((c) => info.columns.includes(c) && !where.includes(c));
        if (!order.length) continue;
        // An index serves it when it starts with the WHERE columns (any order) followed by the first sort column;
        // later sort columns are tie-breakers the database sorts cheaply within each group.
        const serves = info.indexes.some((ix) => {
          const head = ix.columns.slice(0, where.length);
          return where.every((c) => head.includes(c)) && ix.columns[where.length] === order[0];
        });
        if (serves || seen.has(`${table}:${where}:${order}`)) continue;
        seen.add(`${table}:${where}:${order}`);
        out.push({
          rule: "sort-without-index", severity: "low", concept: "pagination", ref: e.id,
          title: `${e.label ?? "Query"} sorts without a matching index`,
          consequence: `No index hands rows out in ${order[0]} order${where.length ? ` within ${list(where)}` : ""}, so to return the first page the database may have to collect every matching row of ${table} and sort them before the LIMIT applies. Then each page costs as much as reading all of them.`,
          fix: `Add an index on the filter columns followed by the sort columns, in a new migration: CREATE INDEX ON ${table} (${[...where, ...order].join(", ")});`,
          evidence: e.evidence, data: { table, where, order },
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
      // Columns each table is actually filtered or sorted on, across every query in the repo.
      const used = new Map<string, Set<string>>();
      for (const e of g.spec.edges) {
        if (typeof e.props.table !== "string") continue;
        const set = used.get(e.props.table) ?? new Set<string>();
        for (const c of [...whereColumns(sqlOf(e)), ...orderColumns(sqlOf(e))]) set.add(c);
        used.set(e.props.table, set);
      }
      for (const node of g.spec.nodes) {
        const tables = node.props.tables as Record<string, TableInfo> | undefined;
        if (!tables) continue;
        for (const [table, t] of Object.entries(tables)) {
          for (const r of t.redundant ?? []) {
            const short = t.indexes.find((i) => i.name === r.index);
            const long = t.indexes.find((i) => i.name === r.coveredBy);
            // If no query touches the longer index's extra columns, the longer one is the dead weight.
            const extra = long && short ? long.columns.slice(short.columns.length) : [];
            const extraUsed = extra.some((c) => used.get(table)?.has(c));
            const dropLonger = !!long && extra.length > 0 && !long.unique && long.source === "index" && !extraUsed;
            const drop = dropLonger ? r.coveredBy : r.index;
            const keep = dropLonger ? r.index : r.coveredBy;
            out.push({
              rule: "redundant-index", severity: "low", concept: "n-plus-one", ref: node.id, key: `finding:redundant-index:${node.id}:${r.index}`,
              title: `${r.index} duplicates ${r.coveredBy} on ${table}`,
              consequence: `${r.coveredBy} starts with the same columns, so one of the two never helps a read. Every insert and update still maintains both, which costs write time and disk.${dropLonger ? ` No query here filters or sorts on ${list(extra)}, so the longer index is the one doing no work.` : ""}`,
              fix: `Keep ${keep} and drop ${drop} in a new migration (DROP INDEX IF EXISTS ${drop};). If your migration runner re-applies every file, also remove the CREATE INDEX for it, or it comes back.`,
              evidence: [{ file: r.file, line: r.line }], data: { table, index: r.index, coveredBy: r.coveredBy, drop },
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: "db-per-request-middleware",
    description: "Middleware that reads a datastore before the handler runs.",
    run(g) {
      const out: Draft[] = [];
      for (const node of g.spec.nodes) {
        if (node.kind !== "middleware" || node.props.library === "express-rate-limit" || node.props.errorHandler) continue;
        // A read that runs on the main path (not a conditional write like a token refresh).
        const mainPath = (e: TraceEdge) => !Array.isArray(e.props.branchPath) || (e.props.branchPath as { guard?: boolean; branch: string }[]).every((b) => b.guard && b.branch === "else");
        const isRead = (e: TraceEdge) => typeof e.props.sessionStore === "string" || statementOf(e) === "SELECT" || /^(find|get|exists|hget|count)/i.test(e.label ?? "");
        const hit = (g.out.get(node.id) ?? []).find((e) => STORE_KINDS.has(g.node(e.to).kind) && !e.props.afterResponse && isRead(e) && (mainPath(e) || typeof e.props.sessionStore === "string"));
        if (!hit) continue;
        const store = g.node(hit.to);
        const session = typeof hit.props.sessionStore === "string";
        const apiKey = /api[_-]?key|x-api-key|token/i.test(`${sqlOf(hit)} ${hit.label ?? ""}`);
        const writesBack = session && g.spec.edges.some((e) => e.from === node.id && e.props.afterResponse);
        out.push(session
          ? {
            rule: "db-per-request-middleware", severity: "low", concept: "sessions-jwt", ref: node.id,
            title: `Sessions are read from ${storeLabel(store)} on every request with a cookie`,
            consequence: `Each request that carries a session cookie reads its session document first${writesBack ? ", and writes it back (or refreshes its expiry) as the response ends" : ""}. At 1,000 such requests per second that's ${writesBack ? "about 2,000" : "1,000"} session operations per second, before any real work.`,
            fix: "Serve static files before the session middleware so assets skip it, and avoid rewriting unchanged sessions (connect-mongo's touchAfter, or rolling: false).",
            evidence: hit.evidence, data: { store: store.id },
          }
          : {
            rule: "db-per-request-middleware", severity: "low", concept: "cache-aside", ref: node.id,
            title: `${node.label} reads ${storeLabel(store)} on every request`,
            consequence: `Every request through this middleware makes a round trip to ${storeLabel(store)} before the handler starts. At 1,000 requests per second that is 1,000 extra queries per second.`,
            fix: apiKey
              ? "Cache key → account for a short time (30-60 s) in memory or Redis. The tradeoff: a revoked key keeps working until its cache entry expires."
              : "Cache the lookup briefly (in memory or Redis, with a short TTL), or carry what you need in a signed token if this is a login session.",
            evidence: hit.evidence, data: { store: store.id },
          });
      }
      return out;
    },
  },
  {
    id: "static-after-session",
    description: "Static files are served after session or login middleware, so every asset pays for them.",
    run(g) {
      for (const f of g.spec.flows) {
        const order = g.flowEdges(f).map((e) => g.node(e.to)).filter((x) => x.kind === "middleware");
        const session = order.findIndex((x) => x.props.library === "express-session" || x.props.library === "passport.session");
        const statics = order.findIndex((x) => x.props.library === "express.static");
        if (session < 0 || statics < 0 || statics < session) continue;
        const st = order[statics]!;
        return [{
          rule: "static-after-session", severity: "medium", concept: "sessions-jwt", ref: st.id,
          title: "Static files go through the session middleware",
          consequence: `express.static is registered after ${order[session]!.label}, so every CSS file, script, font and image request loads the session first (and the logged-in user, and any rate limiter or CSRF middleware in between). One page view with a dozen assets costs a dozen session round trips.`,
          fix: "Register express.static (and other asset routes) before the session, Passport and rate-limit middleware.",
          evidence: st.evidence,
        }];
      }
      return [];
    },
  },
  {
    id: "check-then-insert",
    description: "Checks that a row doesn't exist, then inserts it in a separate statement (a race).",
    run(g) {
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const f of g.spec.flows) {
        const edges = g.flowEdges(f);
        edges.forEach((ins, i) => {
          if (statementOf(ins) !== "INSERT" || /\bON\s+CONFLICT\b/i.test(sqlOf(ins))) return;
          const table = ins.props.table;
          if (typeof table !== "string") return;
          const check = edges.slice(0, i).find((e) => statementOf(e) === "SELECT" && e.props.table === table && e.to === ins.to);
          if (!check) return;
          const cols = whereColumns(sqlOf(check));
          const info = g.tables(ins.to)[table];
          const unique = info?.indexes.find((ix) => ix.unique && ix.columns.length && ix.columns.every((c) => cols.includes(c)));
          if (!unique || seen.has(ins.id)) return;
          seen.add(ins.id);
          out.push({
            rule: "check-then-insert", severity: "low", concept: "transactions", ref: ins.id, extraRefs: [check.id],
            title: `Checks ${table} by ${list(unique.columns)}, then inserts in a separate step`,
            consequence: `Two requests arriving together can both pass the check. The unique constraint on ${list(unique.columns)} stops a duplicate row, so the data stays correct, but the second request's INSERT fails and its caller gets an error instead of the friendly answer the check was meant to give.`,
            fix: `Let the database decide: INSERT ... ON CONFLICT (${unique.columns.join(", ")}) DO NOTHING RETURNING *; if nothing comes back, load and return the existing row. Or catch the unique-violation error (23505 in Postgres) and handle it the same way.`,
            evidence: ins.evidence, data: { table, columns: unique.columns },
          });
        });
      }
      return out;
    },
  },
  {
    id: "redis-check-then-act",
    description: "Reads a Redis key, then changes it in a separate command (a race).",
    run(g) {
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const f of g.spec.flows) {
        const edges = g.flowEdges(f).filter((e) => e.protocol === "redis" && typeof e.label === "string");
        edges.forEach((act, i) => {
          const [cmd, key] = act.label!.split(" ");
          if (!key || !/^(DEL|GETDEL)$/i.test(cmd ?? "")) return;
          const check = edges.slice(0, i).find((e) => /^(EXISTS|GET)\s/i.test(e.label!) && e.label!.split(" ")[1] === key);
          if (!check || seen.has(act.id)) return;
          seen.add(act.id);
          out.push({
            rule: "redis-check-then-act", severity: "medium", concept: "cache-aside", ref: act.id, extraRefs: [check.id],
            title: `${check.label!.split(" ")[0]} then ${cmd} on ${key}: two steps, not one`,
            consequence: `Two requests with the same key can both pass the ${check.label!.split(" ")[0]} before either runs ${cmd}. If the key is a one-time token (a refresh token, a reset code), both requests succeed with it, which is exactly what one-time use is meant to prevent.`,
            fix: "Make the check and the change one command: use DEL's result as the check (it returns 1 only for the caller that actually deleted the key), or GETDEL, or a Lua script.",
            evidence: act.evidence, data: { key },
          });
        });
      }
      return out;
    },
  },
  {
    id: "dual-write",
    description: "Writes to the database and then to Redis with nothing keeping them in step.",
    run(g) {
      // Grouped by the Redis write: every database write that is followed by it.
      const groups = new Map<string, { redis: TraceEdge; writes: TraceEdge[] }>();
      for (const f of g.spec.flows) {
        const edges = g.flowEdges(f);
        edges.forEach((second, i) => {
          if (second.protocol !== "redis") return;
          const [cmd, key = ""] = (second.label ?? "").split(" ");
          const first = edges.slice(0, i).reverse().find((e) => (e.protocol === "sql" && /^(INSERT|UPDATE)$/.test(statementOf(e))) || (e.protocol === "mongodb" && /save|insert|update/i.test(e.label ?? "")));
          if (!first || first.lifecycle === "held") return;
          // Only Redis data that mirrors the rows: a queue or index of them, or a key named after the table.
          const table = String(first.props.table ?? "");
          const segments = key.toLowerCase().split(/[:._-]/);
          const mirrors = /^(ZADD|LPUSH|RPUSH|SADD)$/i.test(cmd ?? "") || (!!table && /^(SET|HSET)$/i.test(cmd ?? "") && (segments.includes(table) || segments.includes(table.replace(/s$/, ""))));
          if (!mirrors) return;
          const group = groups.get(second.id) ?? { redis: second, writes: [] };
          if (!group.writes.some((w) => w.id === first.id)) group.writes.push(first);
          groups.set(second.id, group);
        });
      }
      return [...groups.values()].map(({ redis, writes }) => ({
        rule: "dual-write", severity: "medium" as Severity, concept: "message-queue", ref: redis.id, extraRefs: writes.map((w) => w.id),
        title: `Database writes and ${redis.label} can get out of step`,
        consequence: `${writes.length === 1 ? `${writes[0]!.label} commits` : `${list(writes.map((w) => `\`${w.label}\``))} each commit`} first, then Redis is updated in a separate call. If Redis is down or the process dies in between, the two disagree: the row says one thing, Redis another, and nothing repairs it later. The caller may also get an error for work that was in fact saved.`,
        fix: "Make the database the source of truth and rebuild Redis from it: write an outbox row in the same transaction and let a worker update Redis, or run a periodic job that re-syncs Redis from the database.",
        evidence: redis.evidence, data: { redis: redis.id, writes: writes.map((w) => w.id) },
      }));
    },
  },
  {
    id: "bulk-insert-params",
    description: "A multi-row INSERT built from a list with no upper bound.",
    run(g) {
      const out: Draft[] = [];
      const seen = new Set<string>();
      for (const f of g.spec.flows) {
        const edges = g.flowEdges(f);
        edges.forEach((e, i) => {
        if (statementOf(e) !== "INSERT" || !/\bVALUES\s*</i.test(sqlOf(e)) || seen.has(e.id)) return;
        const source = edges.slice(0, i).find((x) => x.props.unbounded === true && x.to === e.to);
        if (!source) return;
        seen.add(e.id);
        out.push({
          rule: "bulk-insert-params", severity: "medium", concept: "pagination", ref: e.id, extraRefs: [source.id],
          title: `${e.label} builds one statement from every row of ${source.label}`,
          consequence: "The VALUES list grows with the result of an unbounded query. Postgres accepts at most 65,535 parameters per statement, so once the list is big enough (with 2 parameters per row, past 32,767 rows) the INSERT fails outright, and anything written before it in the same request stays written.",
          fix: "Let the database do it in one statement (INSERT ... SELECT ... FROM the source table), or insert in fixed-size batches, ideally in a transaction or a background job.",
          evidence: e.evidence, data: { source: source.id },
        });
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
      const id = d.key ?? `finding:${d.rule}:${d.ref}`;
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
