import type { TraceEdge, TraceNode } from "@vibesim/spec";

export type KindGroup = "actor" | "edge" | "entry" | "code" | "database" | "cache" | "messaging" | "external" | "compute" | "unknown";

export interface KindInfo {
  title: string;
  group: KindGroup;
  /** What this kind of thing is, for someone new to backends. */
  blurb: string;
}

export const KINDS: Record<string, KindInfo> = {
  client: { title: "Client", group: "actor", blurb: "Whoever sends the request: a browser, a mobile app, or a script. The repo has no frontend code for this route, so it is shown as a generic client." },
  "ui-event": { title: "Browser event", group: "actor", blurb: "Something the user does or a page does on its own: a click, a form submit, a page load, or a component mounting." },
  timer: { title: "Timer", group: "entry", blurb: "Code that runs on a schedule (setInterval, a self-rescheduling setTimeout loop), not because a user asked." },
  proxy: { title: "Reverse proxy", group: "edge", blurb: "A server in front of your app that receives every request first and forwards it, often adding TLS, rate limits or load balancing." },
  route: { title: "HTTP route", group: "entry", blurb: "An address your server answers, like POST /payments. The framework matches the method and path and runs the chain registered for it." },
  "ws-endpoint": { title: "WebSocket endpoint", group: "entry", blurb: "A long-lived, two-way connection. Once open, the browser and the server can each send messages at any time." },
  "sse-endpoint": { title: "Server-Sent Events", group: "entry", blurb: "One HTTP response that stays open while the server keeps writing events into it." },
  middleware: { title: "Middleware", group: "code", blurb: "Code that runs before the handler on every matching request: parsing bodies, checking auth, logging, rate limiting. Each one decides whether to pass the request on." },
  handler: { title: "Handler", group: "code", blurb: "The function that does the work for this entry point and sends the response." },
  service: { title: "Function", group: "code", blurb: "Your own function, called in-process. No network hop, just a function call that eventually does I/O." },
  worker: { title: "Worker / job handler", group: "code", blurb: "Code that processes background jobs, outside any user request." },
  database: { title: "Database", group: "database", blurb: "Where data lives durably. Every query is a network round trip, usually over a pooled connection." },
  cache: { title: "Key-value store", group: "cache", blurb: "An in-memory store like Redis: very fast lookups, counters, sorted sets, sessions." },
  queue: { title: "Queue", group: "messaging", blurb: "A list of jobs waiting for a worker. The producer moves on immediately; the work happens later." },
  topic: { title: "Pub/sub channel", group: "messaging", blurb: "A named channel. Publishers send to it without knowing who listens; every subscriber gets a copy." },
  "external-api": { title: "External API", group: "external", blurb: "A service you don't run. Its speed and uptime become part of yours." },
  compute: { title: "CPU-heavy work", group: "compute", blurb: "Work that keeps a CPU busy (password hashing, image resizing). Where it runs decides whether it blocks other requests." },
  unknown: { title: "Unresolved", group: "unknown", blurb: "The parser could not tell what runs here (for example a function picked at runtime). It is shown dashed rather than guessed." },
};

export function kindInfo(kind: string): KindInfo {
  return KINDS[kind] ?? KINDS.unknown!;
}

export const PROTOCOLS: Record<string, { label: string; blurb: string }> = {
  "in-process": { label: "call", blurb: "A plain function call inside the same process. No network, effectively free." },
  http: { label: "HTTP", blurb: "A request/response over HTTP. Each one crosses the network and waits for an answer." },
  ws: { label: "WS", blurb: "A message over an open WebSocket. No new connection, no response to wait for." },
  sse: { label: "SSE", blurb: "An event written into an open Server-Sent Events stream." },
  grpc: { label: "gRPC", blurb: "A remote procedure call over HTTP/2." },
  sql: { label: "SQL", blurb: "A query sent to a SQL database over its wire protocol." },
  mongodb: { label: "Mongo", blurb: "A command sent to MongoDB over its wire protocol." },
  redis: { label: "Redis", blurb: "A command sent to Redis. Typically well under a millisecond on a local network." },
  amqp: { label: "AMQP", blurb: "A message sent to a broker like RabbitMQ." },
  kafka: { label: "Kafka", blurb: "A record written to or read from a Kafka topic." },
  smtp: { label: "SMTP", blurb: "Sending email to a mail server." },
  unknown: { label: "?", blurb: "Not known: this hop could not be resolved from the code." },
};

export const LIFECYCLES: Record<string, { label: string; blurb: string }> = {
  none: { label: "no connection", blurb: "Nothing to open: it's a function call." },
  pooled: { label: "pooled", blurb: "Borrows an already-open connection from a pool and returns it after. No handshake per request, but the pool has a limit." },
  persistent: { label: "persistent", blurb: "Uses one long-lived connection that stays open across many messages." },
  "new-per-request": { label: "new each time", blurb: "Opens a brand-new connection for this call and closes it after, paying the handshake every time." },
  unknown: { label: "unknown", blurb: "Could not be determined from the code." },
};

export function protocolInfo(p: string) {
  return PROTOCOLS[p] ?? PROTOCOLS.unknown!;
}

export function lifecycleInfo(l: string) {
  return LIFECYCLES[l] ?? LIFECYCLES.unknown!;
}

/** One readable sentence for a hop. */
export function edgeSentence(edge: TraceEdge, from: TraceNode, to: TraceNode): string {
  const role = edge.props.role;
  if (edge.props.serverAction) return `${from.label} calls ${to.label}. It looks like a local function call, but Next.js turns it into an HTTP POST from the browser to the server.`;
  if (role === "push") return `${from.label} pushes a message to everyone connected to ${to.label}, over sockets that are already open.`;
  if (role === "deliver" && from.kind === "ws-endpoint") return `The message arrives in the browser and ${to.label} runs.`;
  if (role === "deliver") return `${from.label} hands the message to ${to.label}, which runs separately from whoever sent it.`;
  if (role === "accept") return `The server accepts the WebSocket connection and runs ${to.label}.`;
  if (role === "connect") return `${from.label} opens a long-lived connection to ${to.label}.`;
  const what = edge.label ? ` (${edge.label})` : "";
  if (edge.protocol === "in-process") {
    if (from.kind === "route" || from.kind === "middleware") return `Express passes the request on to ${to.label}.`;
    if (from.kind === "timer") return `${from.label}: ${to.label} runs.`;
    if (from.kind === "ui-event") return `${to.label} runs in the browser.`;
    if (to.kind === "compute") return `${from.label} runs ${edge.label ?? to.label}${to.props.pool === "event-loop" ? " on the main thread, blocking everything else until it finishes" : " on Node's background thread pool"}.`;
    if (to.kind === "external-api") return `${from.label} prepares a request for ${to.label} locally${what}. No network call happens here.`;
    return `${from.label} calls ${to.label}${edge.props.dispatch ? ", one of several handlers picked at runtime" : ""}.`;
  }
  const waits = edge.mode === "sync" ? "and waits for the result" : "and moves on without waiting";
  if (to.kind === "route") return `${from.label} sends ${edge.label ?? "a request"} over HTTP to your own server ${waits}.`;
  if (to.kind === "database") return `${from.label} queries ${to.label}${what} over a ${lifecycleInfo(edge.lifecycle).label} connection ${waits}.`;
  if (to.kind === "cache") return `${from.label} sends ${edge.label ?? "a command"} to ${to.label} ${waits}.`;
  if (to.kind === "topic") return `${from.label} publishes to ${to.label} and moves on. Every subscriber gets a copy.`;
  if (to.kind === "queue") return `${from.label} puts a job on ${to.label} and moves on. A worker picks it up later.`;
  if (to.kind === "external-api") return `${from.label} calls ${to.label}${what} over ${protocolInfo(edge.protocol).label} ${waits}.`;
  if (to.kind === "proxy") return `The request reaches ${to.label} first.`;
  return `${from.label} talks to ${to.label}${what} over ${protocolInfo(edge.protocol).label} ${waits}.`;
}

/** Short tags shown on an arrow. */
export function edgeFlags(edge: TraceEdge): { key: string; label: string; title: string }[] {
  const out: { key: string; label: string; title: string }[] = [];
  if (edge.props.inLoop) out.push({ key: "loop", label: "loop", title: edge.props.loopExitsEarly ? "Inside a loop that usually exits after the first match" : "Runs once per loop iteration" });
  if (edge.props.parallel) out.push({ key: "parallel", label: "parallel", title: "Runs at the same time as its siblings (Promise.all)" });
  if (edge.props.errorPath) out.push({ key: "error", label: "on error", title: "Only runs when something failed (catch block)" });
  if (edge.props.conditional) out.push({ key: "if", label: "if", title: "Only runs when a condition holds" });
  if (edge.mode === "async") out.push({ key: "async", label: "async", title: "Fire-and-forget: the caller does not wait" });
  return out;
}
