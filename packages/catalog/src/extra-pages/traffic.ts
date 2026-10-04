import type { LearnPage } from "../pages.ts";

/** Learn pages for the traffic concepts: rate limiting, reverse proxies, CDNs, API gateways and horizontal scaling. */
export const trafficPages: LearnPage[] = [
  {
    concept: "rate-limiting",
    problem: "Without a limit, one client can send as many requests as it likes: a script guessing passwords, a scraper, a buggy retry loop. It uses up capacity meant for everyone else, and on a login route it can try thousands of passwords an hour.",
    how: [
      "The server keeps a count per key: an IP address, a user id or an API key. Each request adds one. Once a key reaches its limit for the window (say 10 login attempts per 15 minutes), further requests get 429 Too Many Requests, usually with a Retry-After header saying how many seconds to wait. Other keys are not affected.",
      "A fixed window resets every count at set moments. It is cheap, but a client can use its whole allowance just before a reset and again just after: twice the limit in a short time. A sliding window counts the last N seconds instead, whenever they began. A token bucket refills a few tokens per second up to a cap, which allows a short burst but holds the average down.",
      "Where the counts live matters once you run more than one instance. Counts in each process's memory only see that instance's share of the traffic, so with two instances a client gets about twice the limit, and a restart forgets everything. A shared store such as Redis gives every instance the same count, for one quick round trip per request.",
    ],
    code: { caption: "express-rate-limit on the login route, with counts in Redis so every instance shares them:", text: "import { rateLimit } from 'express-rate-limit';\nimport { RedisStore } from 'rate-limit-redis';\n\napp.use('/login', rateLimit({\n  windowMs: 15 * 60 * 1000, limit: 10,      // 10 tries per 15 minutes per IP\n  standardHeaders: 'draft-7',\n  store: new RedisStore({ sendCommand: (...args) => redis.sendCommand(args) }),\n}));" },
    breaks: [
      "Counts kept in process memory with several instances: the real limit is the limit times the number of instances, and every deploy resets it.",
      "Keying by IP behind a proxy: unless Express trusts the proxy's X-Forwarded-For header (app.set('trust proxy', 1)), every request seems to come from the proxy and everyone shares one limit. Whole offices or mobile networks can also share one IP.",
      "Redis unreachable: decide in advance whether requests are let through (fail open) or refused (fail closed).",
      "Many machines, each under the limit: a per-key limit doesn't stop a distributed attack on its own.",
    ],
  },
  {
    concept: "reverse-proxy",
    problem: "If your Node process faces the internet directly, it has to deal with everything that arrives: TLS certificates and encryption, requests for every image and script, slow connections, junk traffic. None of that is your app's logic, and all of it lands on the process that runs your code.",
    how: [
      "A reverse proxy such as Nginx sits in front and is the only thing clients connect to. It terminates TLS (decrypts HTTPS, so the certificate lives in one place) and passes requests on as plain HTTP to the app, which listens on a private address like 127.0.0.1:3000 that the internet can't reach.",
      "It answers some requests itself. Static files come straight from disk without touching Node. Only requests that need your code are forwarded, and with keepalive set on the upstream, Nginx reuses a few open connections to the app instead of opening a new one per request (its default).",
      "It also buffers. Nginx reads the app's whole response quickly over the local connection, then feeds it to a slow client at that client's pace, so the app's part is over almost at once. This matters most for servers that tie up a worker per request (Rails, Django); a Node process doesn't block, but it would still hold the connection and the unsent bytes.",
    ],
    code: { caption: "Nginx in front of a Node app: TLS, static files, and kept-alive connections to the app:", text: "upstream app { server 127.0.0.1:3000; keepalive 16; }\nserver {\n  listen 443 ssl;\n  ssl_certificate     /etc/ssl/site.pem;\n  ssl_certificate_key /etc/ssl/site.key;\n  location /static/ { root /srv/site; }\n  location / {\n    proxy_pass http://app;\n    proxy_http_version 1.1;\n    proxy_set_header Connection \"\";\n  }\n}" },
    breaks: [
      "Every request now seems to come from Nginx: pass the client's address in X-Forwarded-For and set Express's trust proxy, or logs and rate limits treat everyone as one client.",
      "Streaming responses (server-sent events, long polling) sit in Nginx's buffer: turn buffering off for those routes (proxy_buffering off, or an X-Accel-Buffering: no header).",
      "WebSockets only work if the Upgrade and Connection headers are passed through explicitly.",
      "Nginx gives up on a slow app after proxy_read_timeout (60 s by default) and answers 504, whatever your app intended.",
    ],
  },
  {
    concept: "cdn",
    problem: "Your server sits in one region. A user on another continent pays a long round trip for every file, and every user's request for the same logo and JavaScript bundle lands on your server again, even though the answer never changes.",
    how: [
      "A CDN (content delivery network) runs edge locations in many cities, and requests for your files go to the nearest one. If that edge has a fresh copy, it answers from there. If not (a miss), it fetches the file from your server, the origin, keeps a copy, and answers.",
      "Each edge fills its own cache: the first request in Frankfurt and the first in Singapore are both misses. After that, users near each edge get the file from close by, and the origin only hears about misses.",
      "How long a copy lives comes from the response's caching headers (Cache-Control: max-age) or the CDN's settings. When a file changes, edges keep serving their old copy until it expires, unless you purge it. The usual fix is fingerprinted file names (app.3f9c2.js): a new build gets a new URL, so old copies can be cached for a year without harm.",
    ],
    code: { caption: "Long caching for fingerprinted files, a short one for the HTML that points to them:", text: "app.use('/assets', express.static('dist/assets', { immutable: true, maxAge: '1y' }));\n\napp.get('/', (req, res) => {\n  res.set('Cache-Control', 'public, max-age=60');\n  res.send(renderHome());\n});" },
    breaks: [
      "Caching a response that differs per user: the edge can show one person's page to the next visitor. Mark such responses Cache-Control: private or no-store.",
      "Long expiry on files whose names never change: users get the old version until it expires or you purge.",
      "A purge takes a moment to reach every edge, and right after it every edge misses at once, so the origin gets a burst of requests.",
      "Responses that can't be cached still travel to the origin, so a CDN helps them much less.",
    ],
  },
  {
    concept: "api-gateway",
    problem: "Once an app is split into several services, every client has to know every address, and every service needs its own copy of the same chores: checking tokens, rate limits, logging. Each copy is one more place to get it wrong.",
    how: [
      "An API gateway is one front door. Clients send everything to it, and it routes by path: /users to the user service, /orders to the order service. The services sit on a private network where clients can't reach them directly.",
      "Work every request needs happens once, at the gateway: it verifies the token, applies rate limits and logs the request, then forwards it, often with the verified user id in a header. A request with a bad token is refused with 401 before any service spends work on it, and a service that forgot its own check isn't exposed.",
      "It can be a product such as Kong or AWS API Gateway, or a small Express or Nginx layer you write yourself: a reverse proxy that knows about several services and the rules for each.",
    ],
    code: { caption: "A small gateway in Express: one token check and one rate limit, then routing by path:", text: "import { createProxyMiddleware } from 'http-proxy-middleware';\n\napp.use(verifyToken);                                    // once, for every service\napp.use(rateLimit({ windowMs: 60_000, limit: 100 }));\napp.use(createProxyMiddleware({ pathFilter: '/users', target: 'http://users:4001' }));\napp.use(createProxyMiddleware({ pathFilter: '/orders', target: 'http://orders:4002' }));" },
    breaks: [
      "It adds a hop to every request: small inside one data center, but always there.",
      "Everything goes through it, so when it is down every service is unreachable. Run several gateway instances behind a load balancer.",
      "A service that can still be reached directly, around the gateway, skips all of the gateway's checks.",
      "Business logic creeping into the gateway turns it into something every team has to change and redeploy.",
    ],
  },
  {
    concept: "horizontal-scaling",
    problem: "One server has a fixed amount of CPU and memory. A bigger machine helps for a while, but it has a ceiling, costs more as it grows, and when that one machine restarts or fails, everything is down.",
    how: [
      "Horizontal scaling runs several identical copies (instances) of the app behind a load balancer, which spreads requests between them. More traffic, add an instance; one fails, the others keep serving.",
      "Capacity grows with instances only while the instances are what's full. They usually share one database, and it can only run so many queries at once. Past that point, more instances just move the line from the app to the database; then you need fewer or cheaper queries, a cache or read replicas.",
      "Instances must not keep state of their own. Anything held in one process's memory (logins, caches, rate-limit counts, files on local disk) exists only there, and the next request may go to an instance that has never heard of it. Keep shared state in shared places: the database, Redis, object storage.",
    ],
    code: { caption: "Sessions in the shared database instead of express-session's default in-memory store:", text: "import session from 'express-session';\nimport connectPgSimple from 'connect-pg-simple';\n\nconst PgStore = connectPgSimple(session);\napp.use(session({\n  store: new PgStore({ pool }),          // every instance reads the same sessions\n  secret: process.env.SESSION_SECRET,\n  resave: false, saveUninitialized: false,\n}));" },
    breaks: [
      "Logins or caches in process memory: users get logged out, or see different data, depending on which instance answers.",
      "Each instance has its own connection pool: 10 instances with a pool of 20 means 200 database connections.",
      "Timers and scheduled jobs inside the app run on every instance, so the job runs once per instance.",
      "Sticky sessions (always sending a user to the same instance) hide in-memory state until that instance restarts.",
    ],
  },
];
