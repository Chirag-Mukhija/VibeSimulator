/**
 * The fixed concept catalog. Every concept the extractor, findings or viewer
 * mention lives here, so names and one-line summaries stay consistent.
 * `full` concepts get a Learn page with a simulation; stubs show the summary.
 */

export type Category = "communication" | "traffic" | "concurrency" | "data" | "messaging" | "reliability" | "security";

export interface Concept {
  id: string;
  title: string;
  category: Category;
  /** One sentence a beginner can follow. */
  summary: string;
  full: boolean;
  related: string[];
}

export const CATEGORY_LABELS: Record<Category, string> = {
  communication: "Communication models",
  traffic: "Traffic and edge",
  concurrency: "Concurrency models",
  data: "Data",
  messaging: "Async and messaging",
  reliability: "Reliability",
  security: "Security and sessions",
};

export const CONCEPTS: Concept[] = [
  // ---- full (v1)
  { id: "http-request-lifecycle", title: "HTTP request lifecycle", category: "communication", full: true,
    summary: "What happens between a click and a response: connection, request, middleware, handler, database, response.",
    related: ["connection-pooling", "load-balancer", "timeouts"] },
  { id: "connection-pooling", title: "Connection pooling", category: "data", full: true,
    summary: "Keep a few database connections open and lend them out, instead of paying a handshake on every request.",
    related: ["http-request-lifecycle", "n-plus-one", "concurrency-models"] },
  { id: "short-polling", title: "Short polling", category: "communication", full: true,
    summary: "The client asks 'anything new?' on a timer, even when the answer is no.",
    related: ["long-polling", "server-sent-events", "websocket"] },
  { id: "long-polling", title: "Long polling", category: "communication", full: true,
    summary: "The client asks once and the server holds the request open until there is news or a timeout.",
    related: ["short-polling", "server-sent-events", "websocket"] },
  { id: "server-sent-events", title: "Server-Sent Events", category: "communication", full: true,
    summary: "One long-lived HTTP response the server keeps writing events into; one-way, server to browser.",
    related: ["websocket", "long-polling", "pub-sub"] },
  { id: "websocket", title: "WebSocket", category: "communication", full: true,
    summary: "A persistent two-way connection: either side can send a message at any time.",
    related: ["server-sent-events", "pub-sub", "load-balancer"] },
  { id: "pub-sub", title: "Publish/subscribe", category: "messaging", full: true,
    summary: "Publishers send to a channel without knowing who listens; every subscriber gets a copy.",
    related: ["message-queue", "websocket", "horizontal-scaling"] },
  { id: "message-queue", title: "Message queues and workers", category: "messaging", full: true,
    summary: "Put slow work in a queue and let workers do it later, so requests return fast and spikes are absorbed.",
    related: ["pub-sub", "retries-backoff", "dead-letter-queue", "backpressure"] },
  { id: "load-balancer", title: "Load balancing", category: "traffic", full: true,
    summary: "Spread requests across several copies of your server so no single one is the bottleneck.",
    related: ["horizontal-scaling", "reverse-proxy", "websocket"] },
  { id: "cache-aside", title: "Caching (cache-aside)", category: "data", full: true,
    summary: "Check a fast store first; on a miss, read the database and keep a copy for next time.",
    related: ["n-plus-one", "connection-pooling", "read-replica"] },
  { id: "n-plus-one", title: "N+1 queries and indexes", category: "data", full: true,
    summary: "One query per item in a loop, or a query with no index, turns into thousands of slow reads as data grows.",
    related: ["pagination", "cache-aside", "database-index"] },
  { id: "concurrency-models", title: "Event loop, threads and processes", category: "concurrency", full: true,
    summary: "How one server handles many requests at once, and what happens when one request hogs the CPU.",
    related: ["thread-pool", "horizontal-scaling", "load-balancer"] },
  // ---- stubs
  { id: "rate-limiting", title: "Rate limiting", category: "traffic", full: false, summary: "Cap how many requests a client may make in a window, to protect the server and stop brute force.", related: ["load-balancer"] },
  { id: "timeouts", title: "Timeouts", category: "reliability", full: false, summary: "Give up on a slow dependency after a limit so one stuck call cannot hold your request forever.", related: ["circuit-breaker", "retries-backoff"] },
  { id: "pagination", title: "Pagination", category: "data", full: false, summary: "Return results a page at a time (ideally with a cursor) instead of every row at once.", related: ["n-plus-one"] },
  { id: "reverse-proxy", title: "Reverse proxy", category: "traffic", full: false, summary: "A server in front of your app (like Nginx) that receives requests and forwards them, adding TLS, limits or caching.", related: ["load-balancer", "cdn"] },
  { id: "cdn", title: "CDN", category: "traffic", full: false, summary: "Copies of static files served from locations near your users.", related: ["reverse-proxy", "cache-aside"] },
  { id: "api-gateway", title: "API gateway", category: "traffic", full: false, summary: "One front door that routes, authenticates and rate-limits requests to many services.", related: ["reverse-proxy", "rate-limiting"] },
  { id: "circuit-breaker", title: "Circuit breaker", category: "reliability", full: false, summary: "Stop calling a failing dependency for a while so it can recover and you fail fast.", related: ["timeouts", "retries-backoff"] },
  { id: "retries-backoff", title: "Retries with backoff", category: "reliability", full: false, summary: "Try failed work again, waiting longer each time so retries don't pile onto a struggling system.", related: ["message-queue", "dead-letter-queue"] },
  { id: "idempotency", title: "Idempotency", category: "reliability", full: false, summary: "Make repeating the same request safe, so a retry never charges or creates twice.", related: ["retries-backoff", "transactions"] },
  { id: "dead-letter-queue", title: "Dead-letter queue", category: "messaging", full: false, summary: "Where jobs go after failing too many times, so they can be inspected instead of blocking the queue.", related: ["message-queue", "retries-backoff"] },
  { id: "backpressure", title: "Backpressure", category: "reliability", full: false, summary: "Slow producers down when consumers can't keep up, instead of letting queues grow without limit.", related: ["message-queue"] },
  { id: "database-index", title: "Database indexes", category: "data", full: false, summary: "A sorted lookup structure that lets the database find rows without reading the whole table.", related: ["n-plus-one"] },
  { id: "read-replica", title: "Read replicas", category: "data", full: false, summary: "Copies of the database that serve reads, so the primary can focus on writes.", related: ["cache-aside", "sharding"] },
  { id: "sharding", title: "Sharding", category: "data", full: false, summary: "Split one big dataset across several databases by key.", related: ["read-replica"] },
  { id: "transactions", title: "Transactions", category: "data", full: false, summary: "Several writes that succeed or fail together.", related: ["idempotency", "connection-pooling"] },
  { id: "sessions-jwt", title: "Sessions and JWTs", category: "security", full: false, summary: "Two ways to remember who a user is between requests: a server-side session or a signed token.", related: ["cache-aside"] },
  { id: "presigned-uploads", title: "Presigned uploads", category: "security", full: false, summary: "The server signs a short-lived URL so the browser uploads files straight to storage, not through your API.", related: ["cdn"] },
  { id: "server-actions", title: "Server Actions", category: "communication", full: false, summary: "A Next.js function you call from the browser as if it were local; under the hood it is an HTTP POST.", related: ["http-request-lifecycle"] },
  { id: "horizontal-scaling", title: "Horizontal scaling", category: "traffic", full: false, summary: "Handle more traffic by running more copies of the server rather than a bigger machine.", related: ["load-balancer", "pub-sub"] },
  { id: "thread-pool", title: "Thread pool (libuv)", category: "concurrency", full: false, summary: "Node's small pool of background threads (4 by default) for file, DNS, crypto and compression work.", related: ["concurrency-models"] },
  { id: "webhooks", title: "Webhooks", category: "communication", full: false, summary: "Another service calls your URL when something happens, instead of you polling it.", related: ["short-polling", "idempotency"] },
  { id: "cron", title: "Scheduled jobs", category: "messaging", full: false, summary: "Work that runs on a timer rather than in response to a request.", related: ["message-queue"] },
];

const byId = new Map(CONCEPTS.map((c) => [c.id, c]));

export function concept(id: string): Concept | undefined {
  return byId.get(id);
}
