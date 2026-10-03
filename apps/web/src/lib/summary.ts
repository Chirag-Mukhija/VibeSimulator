import type { Flow, Service, TraceNode } from "@vibesim/spec";
import { concept } from "@vibesim/catalog";
import type { Model } from "./model.ts";
import { protocolInfo } from "./explain.ts";
import { buildScene } from "./scene.ts";

/**
 * A plain-language overview of a repo, templated from the trace (no AI).
 * Every sentence is backed by nodes, edges, flows or findings in the spec.
 */
export interface Overview {
  headline: string;
  madeOf: string[];
  entry: string[];
  patterns: { concept: string; text: string }[];
  busiest: { flow: Flow; text: string }[];
  talkingPoints: string[];
  tour: { title: string; body: string; flow: string }[];
}

const list = (items: string[]) => (items.length <= 1 ? items[0] ?? "" : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : /(s|sh|ch|x)$/.test(word) ? `${word}es` : `${word}s`}`;
/** Picks the verb form that agrees with the count. */
const agree = (n: number, one: string, many: string) => (n === 1 ? one : many);
const short = (label: string) => label.replace(/\s*\(.*\)$/, "");
const LIBRARY_NAMES: Record<string, string> = { mongoose: "Mongoose", prisma: "Prisma", drizzle: "Drizzle", mongodb: "the MongoDB driver", mysql2: "mysql2", supabase: "Supabase", pg: "pg", "connect-mongo": "connect-mongo" };
const fmtMs = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

/** How much a finding matters for a talking point: frequent, costly patterns first. */
const RULE_WEIGHT: Record<string, number> = {
  "connection-per-request": 9, "cpu-blocking-event-loop": 9, "dual-write": 8, "bulk-insert-params": 8, "db-call-in-loop": 7,
  "threadpool-saturation": 7, "full-table-aggregate": 7, "push-triggers-fetch": 7, "static-after-session": 6, "polling-via-timer": 6,
  "redis-check-then-act": 6, "missing-index": 6, "check-then-insert": 5, "external-call-in-request-path": 5, "rate-limit-in-memory": 4,
  "websocket-no-backplane": 4, "in-memory-state": 4, "unbounded-query": 3, "sort-without-index": 3, "db-per-request-middleware": 3,
  "worker-idle-polling": 2, "redundant-index": 1, "no-timeout": 2,
};
const SEVERITY_WEIGHT = { high: 30, medium: 20, low: 10, info: 0 } as const;

/** Round trips and one-way messages on a flow's main path (default branches, no error handling). */
export function pathCounts(model: Model, flow: Flow): { roundTrips: number; messages: number; byProtocol: [string, number][] } {
  const scene = buildScene(model, flow, { groupLibraryMiddleware: true });
  const counts = new Map<string, number>();
  let roundTrips = 0;
  let messages = 0;
  for (const ev of scene.events) {
    if (ev.kind !== "request" && ev.kind !== "send") continue;
    const label = ev.edge.props.scheme === "https" ? "HTTPS" : protocolInfo(ev.edge.protocol).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (ev.kind === "request") roundTrips++;
    else messages++;
  }
  return { roundTrips, messages, byProtocol: [...counts].sort((a, b) => b[1] - a[1]) };
}

export function buildOverview(model: Model): Overview {
  const { spec, nodes, edges } = model;
  const kinds = (k: string) => spec.nodes.filter((n) => n.kind === k);
  const routes = kinds("route");
  const dbs = kinds("database");
  const caches = kinds("cache");
  const topics = kinds("topic");
  const queues = kinds("queue");
  const ws = kinds("ws-endpoint");
  const proxies = kinds("proxy");
  const procs = spec.services.filter((s) => s.kind === "http-server" || s.kind === "worker");
  const servers = procs.filter((p) => p.kind === "http-server");
  const workers = procs.filter((p) => p.kind === "worker");
  const frontends = spec.services.filter((s) => s.kind === "frontend");
  const frameworks = spec.meta.frameworks;
  const framework = frameworks.includes("next") ? "Next.js" : frameworks.includes("express") ? "Express" : undefined;

  // Outside services the server actually calls over the network, counted by host.
  const calledExternals = kinds("external-api").filter((x) => spec.edges.some((e) => e.to === x.id && e.protocol !== "in-process"));
  const hosts = new Map<string, string>();
  for (const x of calledExternals) {
    const host = typeof x.props.host === "string" && x.props.host ? x.props.host : x.label;
    if (!hosts.has(host)) hosts.set(host, x.label);
  }
  const presign = spec.edges.some((e) => e.props.presign);

  // One engine reached through several clients (Mongoose, the native driver, a session store) is still one store.
  const engineName = (n: TraceNode) => (n.kind === "cache" ? "Redis" : ({ mongodb: "MongoDB", postgres: "Postgres", mysql: "MySQL", sqlite: "SQLite" } as Record<string, string>)[String(n.props.engine)] ?? short(n.label));
  const stores = [...new Set([...dbs, ...caches].map(engineName))];
  const routesIn = (svc: Service) => spec.flows.filter((f) => f.service === svc.id && nodes.get(f.entry)?.kind === "client").length;
  const headline = servers.length === 1 && workers.length
    ? `${plural(routes.length, "HTTP route")} in the ${short(servers[0]!.label)} process, plus ${list(workers.map((w) => `a separate ${short(w.label)} process`))}${stores.length ? `; backed by ${list(stores)}` : ""}.`
    : `${plural(routes.length, "HTTP route")}${servers.length > 1 ? ` across ${plural(servers.length, "server process")}` : ""}${stores.length ? `, backed by ${list(stores)}` : ""}.`;

  const madeOf: string[] = [];
  if (procs.length) {
    madeOf.push(`Processes: ${list(procs.map((p) => {
      const n = routesIn(p);
      return `${short(p.label)} (${p.kind === "worker" ? "background worker" : `${framework ?? "HTTP"} server${n ? `, ${plural(n, "route")}` : ""}`})`;
    }))}.`);
  }
  if (frontends.length) {
    const views = viewEngine(model);
    madeOf.push(views && !frameworks.includes("react") && !frameworks.includes("next")
      ? `Browser code: server-rendered ${views} pages, plus scripts that run in the browser.`
      : `Browser code: ${list(frontends.map((f) => short(f.label.replace(/^Browser \((.*)\)$/, "$1"))))}.`);
  }
  for (const p of proxies) {
    const limit = typeof p.props.rateLimit === "string" ? `, limits each client IP to ${p.props.rateLimit}${typeof p.props.burst === "number" ? ` (bursts of ${p.props.burst})` : ""}` : "";
    const upstreams = Array.isArray(p.props.upstreams) ? (p.props.upstreams as string[]).length : 1;
    madeOf.push(`${p.label} sits in front${limit} and forwards every request to ${upstreams > 1 ? `${upstreams} app servers (load balancing)` : "the app"}.`);
  }
  const sameEngine = (db: TraceNode) => dbs.filter((d) => d.props.engine === db.props.engine).length;
  for (const db of dbs) {
    if (sameEngine(db) > 1) {
      // Several clients of one database: say how each connects.
      const how = db.props.ownConnection ? `${short(db.label)}: connect-mongo opens its own connection pool for sessions, separate from the app's`
        : db.props.library === "mongodb" ? `${engineName(db)} again through the native driver${spec.edges.some((e) => e.to === db.id && e.lifecycle === "new-per-request") ? ", with a new client opened inside request handlers" : ""}`
          : `${engineName(db)} through ${LIBRARY_NAMES[String(db.props.library)] ?? String(db.props.library)}`;
      madeOf.push(`${how}.`);
      continue;
    }
    const usedBy = new Set(spec.flows.filter((f) => f.steps.some((s) => edges.get(s.edge)!.to === db.id)).map((f) => f.service).filter(Boolean));
    const perProcess = usedBy.size > 1 ? " per process" : "";
    const pool = typeof db.props.poolMax === "number" ? ` through a pool of up to ${db.props.poolMax} connections${perProcess}${db.props.poolMaxDefault ? " (the library default)" : ""}${usedBy.size > 1 ? ", and each process has its own pool" : ""}` : "";
    const tables = db.props.tables ? `; the repo's SQL defines ${plural(Object.keys(db.props.tables as object).length, "table")}` : "";
    const via = !pool && typeof db.props.library === "string" ? `, through ${LIBRARY_NAMES[db.props.library] ?? db.props.library}` : "";
    const own = db.props.ownConnection ? ", on its own connection pool, separate from the app's" : "";
    madeOf.push(`${short(db.label)}${via}${own}${pool}${tables}.`);
  }
  for (const c of caches) madeOf.push(`${short(c.label)}, used for ${list(usesOf(model, c))}.`);
  if (topics.length) madeOf.push(`Pub/sub channel${topics.length > 1 ? "s" : ""}: ${list(topics.map((t) => `"${String(t.props.channel)}"`))}${topics.some((t) => t.props.broker === "redis") ? " (on Redis)" : ""}.`);
  if (queues.length) madeOf.push(`Job queue${queues.length > 1 ? "s" : ""}: ${list(queues.map((q) => `"${String(q.props.name)}"`))}.`);
  if (ws.length) madeOf.push(`WebSocket endpoint${ws.length > 1 ? "s" : ""} for pushing updates to browsers.`);
  if (hosts.size) {
    const names = [...hosts.values()];
    const shown = names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : list(names);
    madeOf.push(`Calls ${plural(hosts.size, "outside service")}: ${shown}.`);
  }
  if (presign) madeOf.push("Signs S3 upload URLs locally; browsers upload straight to S3, so this server never contacts S3.");
  if (frameworks.length) madeOf.push(`Libraries recognized: ${list(frameworks)}.`);

  const entryKinds = new Map<string, number>();
  for (const f of spec.flows) {
    const e = nodes.get(f.entry)!;
    const key = e.kind === "client" ? "route" : e.kind === "timer" ? (e.props.browser ? "browser timer" : e.props.loop ? "worker loop" : "background timer") : e.kind;
    entryKinds.set(key, (entryKinds.get(key) ?? 0) + 1);
  }
  const entry: string[] = [];
  const say = (key: string, noun: string, one: string, many: string) => {
    const n = entryKinds.get(key);
    if (n) entry.push(`${plural(n, noun)} ${agree(n, one, many)}.`);
  };
  say("route", "HTTP route", `answers clients${proxies.length ? " behind the proxy" : ""}`, `answer clients${proxies.length ? " behind the proxy" : ""}`);
  say("ui-event", "browser event", "(a click, page load or component mount) calls the server", "(clicks, page loads, component mounts) call the server");
  say("browser timer", "browser timer", "polls the server on an interval", "poll the server on an interval");
  say("worker loop", "worker loop", "keeps checking for work in the background", "keep checking for work in the background");
  say("background timer", "background timer", "runs on a schedule outside any request", "run on a schedule outside any request");
  say("topic", "subscriber", "reacts to pub/sub messages", "react to pub/sub messages");
  say("queue", "worker", "processes queued jobs", "process queued jobs");

  const used = new Set([...spec.nodes.flatMap((n) => n.concepts), ...spec.edges.flatMap((e) => e.concepts)]);
  if (spec.edges.some((e) => /^(BEGIN|COMMIT)$/.test(String(e.props.statement)))) used.add("transactions");
  if (presign) used.add("presigned-uploads");
  if (spec.edges.some((e) => e.props.serverAction)) used.add("server-actions");
  const sessionStore = spec.edges.find((e) => e.props.sessionStore);
  if (sessionStore) used.add("sessions-jwt");
  const patterns = [...used].map((id) => concept(id)).filter((c) => c !== undefined).map((c) => ({
    concept: c.id,
    text: c.id === "sessions-jwt" && sessionStore
      ? `Server-side sessions: the session lives in ${short(nodes.get(sessionStore.to)!.label)}, and the browser holds only a cookie with its id.`
      : c.summary,
  }));

  const busiest = spec.flows
    .map((f) => ({ f, c: pathCounts(model, f) }))
    .filter((x) => x.c.roundTrips + x.c.messages > 0)
    .sort((a, b) => b.c.roundTrips - a.c.roundTrips || b.c.messages - a.c.messages)
    .slice(0, 3)
    .map(({ f, c }) => ({
      flow: f,
      text: `${f.label} makes ${plural(c.roundTrips, "network round trip")}${c.messages ? ` and sends ${plural(c.messages, "one-way message")}` : ""} on its main path (${c.byProtocol.map(([l, n]) => `${n} ${l}`).join(", ")}).`,
    }));

  const talkingPoints: string[] = [];
  const shape = servers.length === 1 && workers.length
    ? `It's ${framework ? `an ${framework}` : "an HTTP"} API (${short(servers[0]!.label)}) plus ${list(workers.map((w) => `a separate ${short(w.label)} process`))}`
    : procs.length > 1 ? `It's split into ${list(procs.map((p) => short(p.label)))}` : `It's a single ${framework ? `${framework} ` : ""}server process`;
  talkingPoints.push(`${shape}, with ${list(stores) || "no database detected"}${proxies.length ? `, behind ${proxies[0]!.label}` : ""}.`);
  if (topics.length && ws.length) {
    const publishers = new Set(spec.flows.filter((f) => f.steps.some((s) => nodes.get(edges.get(s.edge)!.to)!.kind === "topic")).map((f) => f.service).filter(Boolean));
    const subscriber = spec.flows.find((f) => nodes.get(f.entry)!.kind === "topic")?.service;
    const crossProcess = [...publishers].some((p) => p !== subscriber);
    talkingPoints.push(crossProcess
      ? "Realtime: events published in one process travel through Redis pub/sub to the API, which pushes them to browsers over WebSockets. Every API instance subscribes, so this also works with several of them. Pub/sub doesn't store messages, so anything sent while an API is disconnected is lost."
      : "Realtime: events go through Redis pub/sub so every API instance can push them to its own WebSocket clients, which is what lets it run more than one instance. Pub/sub doesn't store messages, so anything sent while an instance is disconnected is lost.");
  } else if (ws.length) talkingPoints.push("Realtime updates go over WebSockets from the process that holds the connection.");
  if (queues.length || entryKinds.get("worker loop")) talkingPoints.push("Slow work runs in the background instead of inside requests, so the API stays fast when traffic spikes.");
  if (used.has("connection-pooling")) talkingPoints.push("Database access goes through a connection pool, so while connections are warm a query skips the connection handshake, and each process's connection count stays bounded.");
  if (used.has("transactions")) talkingPoints.push("Writes that must happen together use a transaction on one checked-out connection (BEGIN, the writes, COMMIT, ROLLBACK on error), released back to the pool in finally.");
  const limiters = spec.nodes.filter((n) => n.props.library === "express-rate-limit");
  const proxyLimit = proxies.find((p) => typeof p.props.rateLimit === "string");
  if (limiters.length || proxyLimit) {
    const parts: string[] = [];
    if (proxyLimit) parts.push(`${proxyLimit.label} caps every route at ${String(proxyLimit.props.rateLimit)} per client IP, counted in its own memory`);
    if (limiters.length) {
      const shared = limiters.filter((n) => n.props.sharedStore === true || spec.edges.some((e) => e.from === n.id && ["cache", "database"].includes(nodes.get(e.to)!.kind)));
      const described = limiters.map((n) => `${short(n.label)}${typeof n.props.max === "number" && typeof n.props.windowMs === "number" ? ` (${n.props.max} per ${fmtMs(n.props.windowMs)})` : ""}`);
      parts.push(`the app adds ${list(described)}${shared.length === limiters.length ? ", counted in a shared store so the limits hold across instances" : shared.length ? "; some counters live in memory, so with several instances those limits multiply" : ", counted in memory, so with several instances each keeps its own count and the real limit multiplies"}`);
    }
    talkingPoints.push(`Rate limiting: ${parts.join("; ")}.`);
  }
  // The two weightiest risks, from two different rules.
  const top: typeof spec.findings = [];
  for (const f of [...spec.findings].filter((x) => x.severity !== "info").sort((a, b) => (SEVERITY_WEIGHT[b.severity] + (RULE_WEIGHT[b.rule] ?? 3)) - (SEVERITY_WEIGHT[a.severity] + (RULE_WEIGHT[a.rule] ?? 3)))) {
    if (top.length < 2 && !top.some((t) => t.rule === f.rule)) top.push(f);
  }
  for (const f of top) talkingPoints.push(`Known scaling risk: ${f.title}. ${f.fix ?? ""}`.trim());

  return { headline, madeOf, entry, patterns, busiest, talkingPoints, tour: autoTour(model) };
}

/** Pug, EJS, Handlebars: server-rendered pages. */
function viewEngine(model: Model): string | undefined {
  const files = model.spec.nodes.map((n) => n.evidence[0]?.snippet ?? "").join("\n");
  const m = /view engine['"]?\s*,\s*['"](\w+)/.exec(files);
  const name = m?.[1] ?? (model.spec.meta.frameworks.find((f) => ["pug", "ejs", "hbs", "handlebars"].includes(f)));
  return name ? ({ pug: "Pug", ejs: "EJS", hbs: "Handlebars", handlebars: "Handlebars" } as Record<string, string>)[name] ?? name : undefined;
}

function usesOf(model: Model, cache: TraceNode): string[] {
  const out = new Set<string>();
  for (const e of model.spec.edges) {
    if (e.to !== cache.id) continue;
    const cmd = String(e.props.command ?? e.label ?? "");
    if (/zadd|zrange|zrem/i.test(cmd)) out.add("a sorted-set job index");
    else if (/incr|expire/i.test(cmd) || model.nodes.get(e.from)?.props.library === "express-rate-limit") out.add("rate-limit counters");
    else if (/set|get|exists|del/i.test(cmd) && /refresh|session/i.test(String(e.label))) out.add("sessions");
    else if (/set|get|del|exists/i.test(cmd)) out.add("key-value lookups");
  }
  // A Redis channel on the same server: pub/sub is one of its jobs too.
  if (model.spec.nodes.some((n) => n.kind === "topic" && n.props.broker === "redis")) out.add("pub/sub");
  return out.size ? [...out] : ["commands"];
}

/** Representative stops when no curated tour exists. */
function autoTour(model: Model): Overview["tour"] {
  const { spec, nodes, edges } = model;
  const stops: Overview["tour"] = [];
  const add = (f: Flow | undefined, title: string, body: string) => {
    if (f && !stops.some((s) => s.flow === f.id)) stops.push({ title, body, flow: f.id });
  };
  const routes = spec.flows.filter((f) => nodes.get(f.entry)!.kind === "client");
  const counted = routes.map((f) => ({ f, n: pathCounts(model, f).roundTrips })).sort((a, b) => b.n - a.n);
  const busiest = counted[0];
  if (busiest) add(busiest.f, "The busiest request", `${busiest.f.label} makes ${plural(busiest.n, "network round trip")} on its main path. Watch where they go.`);
  const risky = spec.findings.find((f) => f.severity === "high") ?? spec.findings.find((f) => f.severity === "medium");
  if (risky) {
    const flow = risky.refs.map((r) => model.flowsByEdge.get(r)?.[0] ?? spec.flows.find((f) => f.entry === r || f.steps.some((s) => edges.get(s.edge)!.to === r))).find(Boolean);
    add(flow, "Where it breaks first", risky.title);
  }
  add(spec.flows.find((f) => nodes.get(f.entry)!.kind === "ui-event"), "Starting from the browser", "Follow a click or page load all the way to the database.");
  add(spec.flows.find((f) => ["timer", "topic", "queue"].includes(nodes.get(f.entry)!.kind) && !nodes.get(f.entry)!.props.browser), "Work nobody asked for", "Background timers, workers and subscribers run outside any request.");
  return stops;
}
