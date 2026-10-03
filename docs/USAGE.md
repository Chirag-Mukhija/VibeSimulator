# Using vibeSimulator

This guide covers running the viewer, analyzing your own backend, reading what it shows, and publishing the site. For how it works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. Install

You need Node 24 or newer (the code runs as TypeScript directly, without a build step) and pnpm 10.

```bash
git clone <this repo> vibesimulator
cd vibesimulator
pnpm install
```

## 2. Open the viewer

```bash
pnpm --filter @vibesim/web dev
```

Open http://localhost:5199. The home page lists four repos that are already analyzed: Job Scheduler, InstaBackend and Payment Gateway (Chirag Mukhija), and Hackathon Starter (Sahat Yalkabov, MIT). Pick one to look around before you analyze your own.

## 3. Analyze your own backend

```bash
pnpm vibesim analyze /absolute/path/to/your/repo -o my-repo.trace.json
```

`pnpm vibesim` runs from the vibeSimulator folder, so relative paths are resolved from there. Absolute paths avoid surprises.

| Option | What it does |
|---|---|
| `-o, --out <file>` | Where to write the trace (default `vibesim.trace.json`) |
| `--name <name>` | Repo name shown in the viewer (default: the folder name) |
| `--no-source` | Leave code excerpts out of the trace; the viewer then shows `file:line` only |
| `--compact` | Write minified JSON |
| `-h, --help` | Print usage |

The analyzer reads files and never runs them. Nothing leaves your machine. A run prints a summary:

```
Analyzed 43 files in 384 ms
  31 routes, 31 flows, 242 hops
  services: app (src/server.js), postgres (postgres:16-alpine), redis (redis:7-alpine), nginx
  talks to: Redis (ioredis), Postgres (pg, pool max 10), bcrypt (libuv thread pool), AWS S3
  unresolved: 0
Wrote instabackend.trace.json
```

(That is InstaBackend, one of the gallery repos.)

Then drop the `.trace.json` file onto the home page (or click the drop area to choose it). The file is read in your browser and kept only for that tab session.

### What it can read

JavaScript and TypeScript backends on Express or Next.js (App Router route handlers, server components, Server Actions, Pages Router API routes), with `pg`, Prisma, Drizzle, Mongoose, MySQL, Supabase, node-redis, ioredis, BullMQ/Bull, `ws`, socket.io, `fetch`, axios, S3, Stripe, OpenAI, Anthropic, Resend, Twilio and nodemailer. It also reads frontend code in the repo (inline `<script>` pages and React components), `docker-compose.yml`, Dockerfiles, Nginx configs and `.sql` migrations. The README has the full list.

If a repo uses something it can't follow (a dependency-injection container, a URL built at runtime, an unsupported framework), that hop is drawn dashed and listed as unresolved with the reason. It is never guessed.

## 4. Reading a repo

A repo opens on **Overview**. The tabs across the top are the five ways to look at it.

### Overview

A plain-language summary built from the trace: which processes there are, what they talk to, how work comes in (HTTP, browser timers, workers, pub/sub), patterns in use, and talking points you can use when explaining the project. **Start the guided tour** walks through the most important flows in order. Gallery repos have hand-written tours; for your own repo the tour is picked automatically (busiest request, riskiest path, background work).

### Flows

The left sidebar lists every flow: browser entries first, then routes grouped by prefix, then background work (workers, timers, subscribers). A colored dot marks flows with findings.

The main area is a sequence diagram. Each column (lifeline) is a participant: the client, a route, middleware, your functions, a database, Redis, an outside API. Each arrow is one hop.

- **Play / Pause / Step / Back / Restart** move through the hops; the speed menu changes playback speed. The caption under the diagram explains the current hop in one sentence.
- **Group library middleware** folds framework middleware (`express.json`, `cors`, and so on) into one step.
- **Click an arrow or a lifeline header** to open the inspector: what it is, protocol, connection type, the code that proves it, and any findings. Under **Go deeper**, a concept opens in a side drawer with a short explanation and its simulation. That is the deepest level; from there you can only jump out to the full Learn page.

How to read the lines:

| You see | It means |
|---|---|
| Solid arrow | The caller waits for the result |
| Dashed arrow | The caller doesn't wait (publish, enqueue, push), or the hop is unresolved |
| Dotted arrow back | The return |
| Dashed lifeline header | A participant the parser couldn't prove |
| Arrow color | The kind of thing being called: blue for routes, green for your own code, copper for databases, red for caches, mauve for queues and topics, ochre for outside APIs, brick for CPU-heavy work |

Every hop is labeled with its protocol (HTTP, SQL, Redis, WebSocket, SSE, SMTP...) and its connection lifecycle: **pooled** (borrowed from a pool), **persistent** (one long-lived connection), **new per request** (opened and closed each time), or none for in-process calls.

### Map

The architecture at a glance, built only from the flows: who calls in, what sits in front (Nginx), your processes, and what each one talks to, with the protocol on each line. Click a box for details.

### Findings

Scale risks found by fixed rules, not AI. Each card says what happens, why it matters at scale, and where in the code it is. **How to fix** shows the fix, **Learn** opens the concept page, and **Show in flow** jumps to the hop. Filter by severity at the top.

What it looks for: database calls in loops (N+1), a new connection per request, unbounded queries, full-table aggregates, missing and redundant indexes (from your migrations), slow outside calls in the request path and calls with no timeout, polling (browser timers and idle worker loops), CPU-heavy work blocking the event loop or filling the libuv thread pool, pushes that make every client fetch again, in-memory state and in-memory rate limits that break with more than one instance, WebSockets without a shared backplane, and per-request database work in middleware.

### Scale

Pick a flow in the sidebar, then turn up the traffic until something gives.

- **Traffic:** requests per second, or users with the page open for browser polling flows. Extra knobs appear when they matter: rows in the big tables (for scans and aggregates), items per loop, sockets per push.
- **What if…:** only the fixes that apply to this flow are offered: more app instances behind a load balancer, cache reads in Redis (with a hit ratio), move third-party calls to a background queue, push updates over SSE instead of polling, send reads to a replica, batch the queries made inside loops.
- **Results:** median and p95 latency, failed requests (over 30 s), and the bottleneck, side by side for today and with your changes. Below that: p95 as traffic grows, how busy each part is (event loop, thread pool, connection pool, database CPU, Redis), and where a request spends its time.

The numbers are a model, not a benchmark. Each hop's cost comes from the code (bcrypt cost factor, whether a query has an index, loop sizes, which outside API) and from assumptions listed under **What this simulation assumes**. Use it to find which part gives out first and whether a fix helps, not to quote exact milliseconds.

### Learn

Short concept pages (connection pooling, polling vs WebSockets vs SSE, pub/sub, queues and workers, load balancing, caching, N+1 and indexes, the event loop vs threads vs processes, and more). Each full page has a simulation: you predict what will happen, run it, and see if you were right. The realtime and pub/sub numbers come from measurements on a real Node server (see `calibration/REPORT.md`). If you opened a repo first, the page ends with **In <repo>**: where that concept appears in its code.

## 5. Publish the site

```bash
pnpm --filter @vibesim/web build
```

`apps/web/dist` is a static site with hash routing and relative asset paths, so it works on any static host or in a subfolder (GitHub Pages, Netlify, an S3 bucket). The gallery traces are plain files under `dist/gallery/`.

## 6. Add a repo to the gallery

1. Add an entry to `apps/web/scripts/gallery.config.ts`: either `path` (a folder in this repo) or `clone` (a git URL with a pinned commit), plus title, tagline, stack, author, license, and optionally a hand-written `walkthrough` of flow ids.
2. Rebuild the gallery traces:

   ```bash
   pnpm --filter @vibesim/web gallery
   ```

3. Check the new entry in the dev server, then build.

Only add third-party repos whose license allows showing code excerpts, or analyze them with `--no-source`.

## 7. Checks

```bash
pnpm check                                       # typecheck + unit tests (all packages)
pnpm --filter @vibesim/web test:e2e              # browser tests on your installed Chrome
pnpm --filter @vibesim/extractor eval            # extraction accuracy against hand-labeled truth
pnpm --filter @vibesim/extractor eval:blind      # same, on repos labeled before the first run
pnpm --filter @vibesim/calibration calibrate     # re-measure the real-server numbers (takes a few minutes)
```

For the browser tests without downloading Playwright's own browser, set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`; they run on the installed Chrome.

## 8. Troubleshooting

| Problem | Likely cause |
|---|---|
| `0 routes` in the summary | The framework isn't supported yet (Fastify, NestJS, Koa, Hono), or routes are registered in a way the parser can't follow. Check the unresolved list in the trace. |
| A hop you expected is missing | The call goes through something dynamic (a string-built URL, a DI container, a plugin loader). It shows up as an unresolved hop if the parser saw the call site. |
| `SyntaxError` or `ERR_UNKNOWN_FILE_EXTENSION` when running the CLI | Node is older than 24. Check with `node -v`. |
| "This file is not a valid vibeSimulator trace" when dropping a file | The file isn't a trace, or it was made by a different version of the analyzer. Re-run `analyze`; the message lists the first problems found. |
| The trace is large | Use `--compact`, or `--no-source` to leave code excerpts out. |
