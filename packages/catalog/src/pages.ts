import type { SimDef } from "./sims/types.ts";
import { shortPollingSim, longPollingSim, sseSim, websocketSim } from "./sims/realtime.ts";
import { poolingSim } from "./sims/pooling.ts";
import { queueSim } from "./sims/queue.ts";
import { pubsubSim } from "./sims/pubsub.ts";
import { loadBalancerSim } from "./sims/loadbalancer.ts";
import { cacheSim } from "./sims/cache.ts";
import { nPlusOneSim } from "./sims/nplusone.ts";
import { concurrencySim } from "./sims/concurrency.ts";
import { lifecycleSim } from "./sims/lifecycle.ts";
import { trafficPages } from "./extra-pages/traffic.ts";
import { reliabilityPages } from "./extra-pages/reliability.ts";
import { dataPages } from "./extra-pages/data.ts";
import { asyncPages } from "./extra-pages/async.ts";
import { platformPages } from "./extra-pages/platform.ts";

/** A Learn page: kept under 600 words so it stays a page, not a chapter. */
export interface LearnPage {
  concept: string;
  problem: string;
  how: string[];
  code?: { caption: string; text: string };
  breaks: string[];
  /** The calibrated "Measure it" simulation; the twelve core concepts have one. */
  sim?: SimDef;
}

/** The twelve core pages, each with a calibrated simulation. */
const CORE_PAGES: LearnPage[] = [
  {
    concept: "http-request-lifecycle",
    problem: "A request feels instant on localhost and slow in production, and most of the difference isn't your code. Before your handler runs, the browser may need a DNS lookup, a TCP handshake and a TLS handshake, each costing a full round trip to your server.",
    how: [
      "A new HTTPS connection costs DNS, then TCP (one round trip), then TLS (one more with TLS 1.3). Only then does the request travel, your middleware run in order, your handler and database do their work, and the response come back.",
      "Keep-alive reuses the open connection, so later requests skip the handshakes and pay just the request and response trip. That is why the second click is faster than the first.",
      "On your own machine the round trip is under a millisecond, so this all disappears. For a user on another continent it can be 150 ms or more per trip.",
    ],
    code: { caption: "Every app.use runs before every route registered after it, on every request:", text: "app.use(helmet());\napp.use(express.json());\napp.use(authGuard);      // runs a DB query? that is per request\napp.get('/feed', handler);" },
    breaks: [
      "Far-away users: three round trips of setup before any work. A CDN, edge region or keep-alive helps more than a faster handler.",
      "Middleware that does I/O (auth lookups, sessions) adds a database trip to every request it guards.",
      "Proxies and load balancers that close idle connections force the full handshake again.",
    ],
    sim: lifecycleSim,
  },
  {
    concept: "connection-pooling",
    problem: "Opening a database connection is expensive: a TCP handshake, authentication and often TLS, then memory on the database for each one. Postgres allows only 100 connections by default. Opening one per request is slow and runs out under load.",
    how: [
      "A pool opens a few connections when the app starts and lends one to each query. When the query finishes, the connection goes back for the next request. No handshake per request, and the database never sees more connections than the pool size.",
      "When every connection is lent out, new queries wait in line for the next free one. A pool that is too small turns into a queue; one that is too large just moves the queue into the database, which can only run as many queries at once as it has CPU cores.",
      "Each copy of your app has its own pool. Five instances with a pool of 20 means 100 connections: the whole Postgres default.",
    ],
    code: { caption: "Create the pool once and reuse it:", text: "// once, at startup\nconst pool = new Pool({ max: 20 });\n\n// per request: borrows and returns a connection\nconst { rows } = await pool.query('SELECT ...', [id]);" },
    breaks: [
      "`new Client()` inside a handler: a fresh handshake per request, and a traffic spike exhausts max_connections.",
      "Long transactions or slow queries hold connections, so other requests wait for the pool.",
      "Scaling out instances multiplies pool sizes; add a pooler like PgBouncer when that total gets near the database limit.",
    ],
    sim: poolingSim,
  },
  {
    concept: "short-polling",
    problem: "The browser wants to know when something changes: a new notification, a finished job. The simplest answer is to ask the server again and again on a timer.",
    how: [
      "A setInterval fires every few seconds and sends a normal HTTP request. The server answers right away with whatever it has, usually nothing new.",
      "It is easy to build, works through every proxy and needs nothing special on the server. On localhost with one tab open, it costs nothing you can notice.",
      "The cost is set by the number of users and the interval, not by how often data changes. 10,000 tabs polling every 5 seconds is 2,000 requests per second even when nothing happens.",
    ],
    code: { caption: "The pattern to look for:", text: "setInterval(async () => {\n  const res = await fetch('/api/notifications');\n  render(await res.json());\n}, 5000);" },
    breaks: [
      "User count grows: requests grow with it while most responses are empty.",
      "Each poll runs your full request path: middleware, auth lookups, database queries.",
      "Shorter intervals for 'more real-time' multiply the load; longer ones make users wait.",
    ],
    sim: shortPollingSim,
  },
  {
    concept: "long-polling",
    problem: "Short polling wastes requests and still makes users wait. Long polling keeps the same plain HTTP but stops asking repeatedly.",
    how: [
      "The browser sends a request and the server doesn't answer until there is news or a timeout passes (often 30 seconds). When the answer arrives, the browser immediately sends the next request.",
      "Updates arrive within about one round trip, and an idle user makes roughly one request every 30 seconds instead of one every few seconds.",
      "The trade: every waiting user holds an open request on your server, and every update needs a whole new HTTP request with headers and middleware.",
    ],
    code: { caption: "Server side, the request is parked until something happens:", text: "app.get('/updates', (req, res) => {\n  waiting.add(res);                       // answer later\n  req.on('close', () => waiting.delete(res));\n});\nfunction publish(msg) { for (const res of waiting) res.json(msg); waiting.clear(); }" },
    breaks: [
      "Parked requests live in one process's memory, so a second instance can't answer them without a shared channel.",
      "Proxies and load balancers with short idle timeouts cut long requests off.",
      "Frequent updates turn it back into one full HTTP request per update.",
    ],
    sim: longPollingSim,
  },
  {
    concept: "server-sent-events",
    problem: "Many features only need the server to push updates to the browser: notifications, progress, live scores. A two-way socket is more than they need.",
    how: [
      "The browser opens one HTTP request with EventSource and the server never finishes the response. Instead it writes events into it whenever something happens: `data: {...}\\n\\n`.",
      "It is plain HTTP, so cookies, auth middleware and most proxies work as usual, and the browser reconnects on its own if the stream drops.",
      "It is one-way. The browser still sends anything back with normal requests.",
    ],
    code: { caption: "A minimal stream:", text: "res.writeHead(200, { 'content-type': 'text/event-stream' });\nclients.add(res);\n// later\nfor (const c of clients) c.write(`data: ${JSON.stringify(msg)}\\n\\n`);" },
    breaks: [
      "Every open stream is a connection and some memory on one specific instance.",
      "Without HTTP/2, browsers allow only about six connections per domain, so many tabs can starve other requests.",
      "Buffering proxies hold events back unless buffering is turned off for the stream.",
    ],
    sim: sseSim,
  },
  {
    concept: "websocket",
    problem: "Chat, multiplayer, collaborative editing and live dashboards need messages flowing both ways with as little delay as possible.",
    how: [
      "The browser upgrades an HTTP request into a WebSocket, a persistent connection where either side can send a message at any time. No request per message and no headers repeated each time.",
      "The server keeps every open socket in memory. Sending to a user means finding their socket on the instance that holds it.",
      "Once you run more than one instance, a user connected to instance A can't be reached directly from instance B. That is what pub/sub backplanes (Redis, the socket.io adapter) are for.",
    ],
    code: { caption: "Broadcast reaches only sockets on this process:", text: "wss.on('connection', (ws) => clients.add(ws));\nfunction broadcast(msg) {\n  for (const ws of clients) ws.send(JSON.stringify(msg));\n}" },
    breaks: [
      "More than one instance without a backplane: pushes silently miss users on other instances.",
      "Load balancers need sticky routing or WebSocket support, and idle timeouts drop quiet connections unless you send heartbeats.",
      "A deploy or crash disconnects everyone at once; without random reconnect delays they all come back in the same second.",
    ],
    sim: websocketSim,
  },
  {
    concept: "pub-sub",
    problem: "Your app runs as several instances and users connect to whichever one the load balancer picks. When something happens on instance A, users connected to B and C need to hear about it too.",
    how: [
      "Publishers send a message to a named channel without knowing who is listening. Every subscriber to that channel gets its own copy.",
      "With Redis pub/sub, each instance subscribes to the channel on startup. Any instance publishes, every instance receives the message and pushes it to its own sockets.",
      "Plain pub/sub is fire-and-forget: a subscriber that is down at that moment misses the message. If every message must be processed, you want a queue or a stream instead.",
    ],
    code: { caption: "Every instance runs both halves:", text: "// on startup, every instance\nawait sub.subscribe('job:events', (raw) => broadcastToMySockets(JSON.parse(raw)));\n// wherever something happens\nawait redis.publish('job:events', JSON.stringify(event));" },
    breaks: [
      "Using a local broadcast after scaling out: messages reach only one instance's users.",
      "Treating pub/sub as durable: messages published while a subscriber restarts are gone.",
      "Very high fan-out: every instance receives every message, even if few of its users care.",
    ],
    sim: pubsubSim,
  },
  {
    concept: "message-queue",
    problem: "Some work is slow or depends on someone else's speed: sending email, charging cards, resizing images, calling AI APIs. Doing it inside the request makes users wait and fails when the other side is slow.",
    how: [
      "The request puts a job on a queue and returns immediately. Separate worker processes take jobs off the queue and do them at their own pace.",
      "Spikes become a longer queue instead of slow or failing requests, and you add workers to drain it faster. Failed jobs can be retried with backoff and, after too many failures, parked in a dead-letter queue for a human to look at.",
      "The user no longer sees the result in the same response, so the UI needs a way to learn about completion: polling a status, a push, or an email.",
    ],
    code: { caption: "The request enqueues; a worker does the work:", text: "// API\nawait emailQueue.add('receipt', { orderId });\nres.status(202).json({ queued: true });\n\n// worker process\nnew Worker('email', async (job) => sendReceipt(job.data.orderId));" },
    breaks: [
      "Workers that can't keep up: the queue grows without limit. Watch its depth.",
      "Jobs that aren't safe to run twice: retries charge or email again. Make them idempotent.",
      "Polling the queue table in a tight loop instead of blocking on it wastes database work.",
    ],
    sim: queueSim,
  },
  {
    concept: "load-balancer",
    problem: "One server has one CPU budget. To handle more traffic you run several copies, and something has to decide which copy gets each request.",
    how: [
      "A load balancer (Nginx, a cloud LB) receives every request and forwards it to one of the instances. Round robin takes turns, random picks any, least connections picks whichever is busy with the fewest requests.",
      "When requests cost about the same, they all work. When some are much slower, round robin and random keep sending new requests to an instance stuck on a slow one, and least connections avoids it.",
      "Anything an instance keeps in memory (sessions, rate-limit counters, open sockets) is now invisible to the others.",
    ],
    code: { caption: "Nginx in front of two app instances:", text: "upstream app {\n  least_conn;\n  server app1:4000;\n  server app2:4000;\n}\nlocation / { proxy_pass http://app; }" },
    breaks: [
      "State kept in process memory: counts, caches and sessions differ per instance.",
      "WebSockets need sticky routing and a pub/sub backplane.",
      "Health checks that are too slow keep sending traffic to a dead instance.",
    ],
    sim: loadBalancerSim,
  },
  {
    concept: "cache-aside",
    problem: "The same data gets read far more often than it changes: profiles, settings, product pages. Every read going to the database wastes its limited CPU and adds latency.",
    how: [
      "Before querying, check a fast store like Redis. On a hit, return it. On a miss, query the database, store the result in the cache with an expiry, then return it. That is cache-aside: the application manages the cache next to the database.",
      "The hit ratio decides everything. At 90% the database sees a tenth of the reads; at 99%, a hundredth.",
      "The hard part is staleness: after a write, the cached copy is wrong until it expires or you delete it.",
    ],
    code: { caption: "The read path:", text: "const cached = await redis.get(`user:${id}`);\nif (cached) return JSON.parse(cached);\nconst user = await db.findUser(id);\nawait redis.set(`user:${id}`, JSON.stringify(user), 'EX', 60);\nreturn user;" },
    breaks: [
      "A popular key expires and hundreds of requests miss at once and stampede the database.",
      "Forgetting to invalidate on writes: users see old data.",
      "Caching per instance in memory: each instance has its own stale copy.",
    ],
    sim: cacheSim,
  },
  {
    concept: "n-plus-one",
    problem: "Code that reads naturally can talk to the database in the worst possible way: one query to get a list, then one more query for each item in it. With an ORM it often hides inside a loop or a helper.",
    how: [
      "Each query is a network round trip plus the database's work. 50 items means 51 trips one after another, so a page that should take 5 ms takes 50 ms or more, and holds a pooled connection the whole time.",
      "The fix is to ask once: WHERE id IN (...), a JOIN, or the ORM's include and batch helpers.",
      "Indexes are the other half. Without an index on the column you filter by, the database reads every row to find the matches: instant at a thousand rows, seconds at ten million.",
    ],
    code: { caption: "The loop to look for, and the fix:", text: "for (const name of tagNames) {\n  await prisma.tag.upsert({ where: { name }, ... }); // one trip each\n}\n// instead: one trip\nawait prisma.tag.createMany({ data: tagNames.map((name) => ({ name })), skipDuplicates: true });" },
    breaks: [
      "Pages that grow: more items, more queries, slower pages.",
      "Tables that grow: unindexed filters get slower every day.",
      "Background jobs that loop over every row, one query each.",
    ],
    sim: nPlusOneSim,
  },
  {
    concept: "concurrency-models",
    problem: "A server handles many requests at once, but how it does so decides what happens when one request needs a lot of CPU. In Node, the answer is surprising if you have only used threads before.",
    how: [
      "Node runs your JavaScript on one main thread, the event loop. While a request waits on the database it isn't using that thread, so thousands of waiting requests are cheap.",
      "CPU-heavy work (password hashing, image resizing, big JSON) holds the thread. While it runs, no other request can make progress. Sync APIs like bcrypt.hashSync or bcryptjs run right there.",
      "Async native APIs (bcrypt.hash, crypto.scrypt, sharp) hand the work to libuv's thread pool, 4 threads by default. Running several processes (cluster, or more instances) gives you several event loops.",
    ],
    code: { caption: "Same hash, very different effect on everyone else:", text: "bcrypt.hashSync(password, 12);     // blocks the event loop\nawait bcrypt.hash(password, 12);   // runs on the thread pool" },
    breaks: [
      "Any sync CPU work on a request path: every other request waits for it.",
      "Lots of async CPU work: the 4-thread pool queues, and file and DNS work queue behind it too.",
      "One process on a many-core machine: it uses one core for JavaScript. Run more processes.",
    ],
    sim: concurrencySim,
  },
];

export const PAGES: LearnPage[] = [...CORE_PAGES, ...trafficPages, ...reliabilityPages, ...dataPages, ...asyncPages, ...platformPages];

const byConcept = new Map(PAGES.map((p) => [p.concept, p]));

export function page(concept: string): LearnPage | undefined {
  return byConcept.get(concept);
}

export function wordCount(p: LearnPage): number {
  const text = [p.problem, ...p.how, ...p.breaks, p.code?.caption ?? ""].join(" ");
  return text.split(/\s+/).filter(Boolean).length;
}
