import type { Flow, TraceNode } from "@vibesim/spec";
import { concept } from "@vibesim/catalog";
import type { Model } from "./model.ts";
import { protocolInfo } from "./explain.ts";

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
const LIBRARY_NAMES: Record<string, string> = { mongoose: "Mongoose", prisma: "Prisma", drizzle: "Drizzle", mongodb: "the MongoDB driver", mysql2: "mysql2", supabase: "Supabase", pg: "pg" };

export function buildOverview(model: Model): Overview {
  const { spec, nodes, edges } = model;
  const kinds = (k: string) => spec.nodes.filter((n) => n.kind === k);
  const routes = kinds("route");
  const dbs = kinds("database");
  const caches = kinds("cache");
  const topics = kinds("topic");
  const queues = kinds("queue");
  const externals = kinds("external-api");
  const ws = kinds("ws-endpoint");
  const proxies = kinds("proxy");
  const procs = spec.services.filter((s) => s.kind === "http-server" || s.kind === "worker");
  const frontends = spec.services.filter((s) => s.kind === "frontend");
  const frameworks = spec.meta.frameworks;

  const stores = [...dbs, ...caches].map((n) => short(n.label));
  const headline = `${plural(routes.length, "HTTP route")}${procs.length > 1 ? ` across ${plural(procs.length, "process")}` : ""}${stores.length ? `, backed by ${list(stores)}` : ""}.`;

  const madeOf: string[] = [];
  if (procs.length) madeOf.push(`Processes: ${list(procs.map((p) => `${short(p.label)} (${p.kind === "worker" ? "background worker" : "HTTP server"})`))}.`);
  // "Browser (client components)" reads as "client components", "dashboard.html (browser)" as "dashboard.html".
  if (frontends.length) madeOf.push(`Browser code: ${list(frontends.map((f) => short(f.label.replace(/^Browser \((.*)\)$/, "$1"))))}.`);
  if (proxies.length) madeOf.push(`${list(proxies.map((p) => p.label))} sits in front and forwards every request.`);
  for (const db of dbs) {
    const pool = typeof db.props.poolMax === "number" ? ` through a pool of ${db.props.poolMax} connections${db.props.poolMaxDefault ? " (library default)" : ""}` : "";
    const tables = db.props.tables ? `; the repo's SQL defines ${plural(Object.keys(db.props.tables as object).length, "table")}` : "";
    const via = !pool && typeof db.props.library === "string" ? `, through ${LIBRARY_NAMES[db.props.library] ?? db.props.library}` : "";
    madeOf.push(`${short(db.label)}${via}${pool}${tables}.`);
  }
  for (const c of caches) madeOf.push(`${short(c.label)}, used for ${list(usesOf(model, c))}.`);
  if (topics.length) madeOf.push(`Pub/sub channel${topics.length > 1 ? "s" : ""}: ${list(topics.map((t) => `"${String(t.props.channel)}"`))}.`);
  if (queues.length) madeOf.push(`Job queue${queues.length > 1 ? "s" : ""}: ${list(queues.map((q) => `"${String(q.props.name)}"`))}.`);
  if (ws.length) madeOf.push(`WebSocket endpoint${ws.length > 1 ? "s" : ""} for pushing updates to browsers.`);
  if (externals.length) {
    const names = externals.map((e) => e.label);
    const shown = names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : list(names);
    madeOf.push(`Calls ${plural(externals.length, "outside service")}: ${shown}.`);
  }
  if (frameworks.length) madeOf.push(`Libraries recognized: ${list(frameworks)}.`);

  const entryKinds = new Map<string, number>();
  for (const f of spec.flows) {
    const e = nodes.get(f.entry)!;
    const key = e.kind === "client" ? "route" : e.kind === "timer" ? (e.props.browser ? "browser timer" : e.props.loop ? "worker loop" : "server timer") : e.kind;
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
  say("server timer", "server timer", "runs on a schedule", "run on a schedule");
  say("topic", "subscriber", "reacts to pub/sub messages", "react to pub/sub messages");
  say("queue", "worker", "processes queued jobs", "process queued jobs");

  const used = new Set([...spec.nodes.flatMap((n) => n.concepts), ...spec.edges.flatMap((e) => e.concepts)]);
  if (spec.edges.some((e) => /^(BEGIN|COMMIT)$/.test(String(e.props.statement)))) used.add("transactions");
  if (spec.edges.some((e) => e.props.presign)) used.add("presigned-uploads");
  if (spec.edges.some((e) => e.props.serverAction)) used.add("server-actions");
  if (spec.edges.some((e) => e.props.sessionStore)) used.add("sessions-jwt");
  const patterns = [...used].map((id) => concept(id)).filter((c) => c !== undefined).map((c) => ({ concept: c.id, text: c.summary }));

  const busiest = [...spec.flows]
    .map((f) => ({ f, net: f.steps.map((s) => edges.get(s.edge)!).filter((e) => e.protocol !== "in-process") }))
    .filter((x) => x.net.length > 0)
    .sort((a, b) => b.net.length - a.net.length)
    .slice(0, 3)
    .map(({ f, net }) => {
      const counts = new Map<string, number>();
      for (const e of net) counts.set(protocolInfo(e.protocol).label, (counts.get(protocolInfo(e.protocol).label) ?? 0) + 1);
      return { flow: f, text: `${f.label} makes ${plural(net.length, "network round trip")} (${[...counts].map(([l, n]) => `${n} ${l}`).join(", ")}).` };
    });

  const talkingPoints: string[] = [];
  const lead = procs.length > 1 ? `split into ${list(procs.map((p) => short(p.label)))}` : "a single server process";
  talkingPoints.push(`It's ${lead}${frameworks.includes("express") ? " on Express" : frameworks.includes("next") ? " on Next.js" : ""}, with ${list(stores) || "no database detected"}${proxies.length ? `, behind ${proxies[0]!.label}` : ""}.`);
  if (topics.length && ws.length) talkingPoints.push(`Realtime: events go through Redis pub/sub so every API instance can push them to its own WebSocket clients, which is what lets it scale past one instance.`);
  else if (ws.length) talkingPoints.push(`Realtime updates go over WebSockets from the process that holds the connection.`);
  if (queues.length || entryKinds.get("worker loop")) talkingPoints.push(`Slow work runs in the background instead of inside requests, so the API stays fast when traffic spikes.`);
  if (used.has("connection-pooling")) talkingPoints.push(`Database access goes through a connection pool, so requests don't pay a new handshake and the database's connection count stays bounded.`);
  if (used.has("transactions")) talkingPoints.push(`Writes that must happen together use a transaction on one checked-out connection (BEGIN, the inserts, COMMIT, ROLLBACK on error).`);
  if (used.has("rate-limiting")) {
    const shared = spec.nodes.some((n) => n.props.library === "express-rate-limit" && spec.edges.some((e) => e.from === n.id && (nodes.get(e.to)!.kind === "cache" || nodes.get(e.to)!.kind === "database")));
    talkingPoints.push(`Rate limiting ${shared ? "keeps its counters in a shared store, so limits hold across instances" : "runs in memory, which works on one instance; with several, each keeps its own count and the real limit multiplies"}.`);
  }
  const top = spec.findings.filter((f) => f.severity === "high" || f.severity === "medium").slice(0, 2);
  for (const f of top) talkingPoints.push(`Known scaling risk: ${f.title}. ${f.fix ?? ""}`.trim());

  return { headline, madeOf, entry, patterns, busiest, talkingPoints, tour: autoTour(model) };
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
  return out.size ? [...out] : ["commands"];
}

/** Representative stops when no curated tour exists. */
function autoTour(model: Model): Overview["tour"] {
  const { spec, nodes, edges } = model;
  const net = (f: Flow) => f.steps.filter((s) => edges.get(s.edge)!.protocol !== "in-process").length;
  const stops: Overview["tour"] = [];
  const add = (f: Flow | undefined, title: string, body: string) => {
    if (f && !stops.some((s) => s.flow === f.id)) stops.push({ title, body, flow: f.id });
  };
  const routes = spec.flows.filter((f) => nodes.get(f.entry)!.kind === "client");
  const busiest = [...routes].sort((a, b) => net(b) - net(a))[0];
  add(busiest, "The busiest request", busiest ? `${busiest.label} makes ${net(busiest)} network round trips. Watch where they go.` : "");
  const risky = spec.findings.find((f) => f.severity === "high") ?? spec.findings.find((f) => f.severity === "medium");
  if (risky) {
    const flow = risky.refs.map((r) => model.flowsByEdge.get(r)?.[0] ?? spec.flows.find((f) => f.entry === r || f.steps.some((s) => edges.get(s.edge)!.to === r))).find(Boolean);
    add(flow, "Where it breaks first", risky.title);
  }
  add(spec.flows.find((f) => nodes.get(f.entry)!.kind === "ui-event"), "Starting from the browser", "Follow a click or page load all the way to the database.");
  add(spec.flows.find((f) => ["timer", "topic", "queue"].includes(nodes.get(f.entry)!.kind) && !nodes.get(f.entry)!.props.browser), "Work nobody asked for", "Background timers, workers and subscribers run outside any request.");
  return stops;
}
