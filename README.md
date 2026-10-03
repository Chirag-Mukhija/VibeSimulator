# vibeSimulator

See how every request really moves through your backend, verified from the code, and what will break when traffic grows.

Point it at a JavaScript or TypeScript backend. It reads the code (nothing is uploaded, nothing is executed) and builds every path from a click, timer or message to the database and back: each function, query, Redis command, publish, WebSocket push and outside API call, with the line of code that proves it. A web viewer plays each path as an animated sequence diagram, explains every hop in plain words, flags what breaks at scale, and links each pattern to a Learn page with a simulation calibrated against a real Node server. The Scale tab runs any path under load (its real queries, Redis commands, API calls and password hashes) and lets you try fixes: more instances, a read cache, a background queue, push instead of polling, a read replica, batched queries.

**Docs:** [Usage guide](docs/USAGE.md) · [Architecture](docs/ARCHITECTURE.md)

## Quick start

Requires Node 24+ and pnpm.

```bash
pnpm install
pnpm --filter @vibesim/web dev        # http://localhost:5199 with the gallery
```

Analyze your own repo, then drop the file onto the home page:

```bash
pnpm vibesim analyze path/to/your/repo -o vibesim.trace.json
```

The trace includes a few lines of code around each hop so the viewer can show them; add `--no-source` to leave code out. The viewer reads the file in your browser.

Build the static site (any static host works, routing is hash-based):

```bash
pnpm --filter @vibesim/web build      # apps/web/dist
```

## What it understands

- **Frameworks:** Express (app/router chains, mounts, `route()` chains, routers mounted in loops, middleware factories, wrapped controllers), Next.js App Router route handlers, async server-component pages, Server Actions (shown as the HTTP calls they are), Pages Router API routes.
- **Data:** `pg` (pools, checked-out clients and transactions, per-request clients), Prisma (including the `globalThis` singleton), Drizzle, Mongoose (models, documents, schema methods), MySQL, Supabase. Your `.sql` migrations are read for keys and indexes.
- **Messaging and realtime:** node-redis and ioredis (commands, pub/sub), BullMQ and Bull queues and workers, `ws` and socket.io (connections, pushes, rooms, adapters), session stores, Passport `deserializeUser`.
- **Outside calls:** `fetch`, axios (instances, base URLs, timeouts), AWS S3 (including presigning, which makes no network call), Stripe, OpenAI, Anthropic, Resend, Twilio, nodemailer.
- **Frontend:** inline `<script>` pages, React components (`onClick`, `onSubmit`, `useEffect`), `setInterval` polling, `new WebSocket`, matched to your own routes.
- **Infrastructure:** `package.json` scripts, Dockerfiles, `docker-compose.yml` services, Nginx `proxy_pass` and rate limits.

Anything it can't prove is shown as a dashed, unresolved hop with the reason. It never guesses.

## Scale mode

Pick a path and turn up the traffic. A discrete-event simulation replays that path's hops with each instance's event loop, libuv thread pool, connection pool and the database's cores as queues, and reports median and p95 latency, failures, which part saturates first, and where a request's time goes. Costs come from the code (bcrypt cost factor, missing indexes from your migrations, loops, parallel calls, which third-party API) and from the calibration below. The numbers are a model, not a benchmark: use them to see which part gives out first and whether a fix helps, not to quote exact milliseconds. The assumptions are listed on the page.

## Accuracy

The extractor is scored against hand-labeled ground truth (`packages/extractor/eval`): every expected edge as `from -> to @ file:line`.

```bash
pnpm --filter @vibesim/extractor eval         # fixtures, per-repo gate: precision >= 90%, recall >= 85%
pnpm --filter @vibesim/extractor eval:blind   # third-party repos labeled before the first run
```

Current fixture results are 100% precision and recall on all six fixture repos. The honest measure is the blind samples' first run, before anything was fixed for them:

| Repo | First run (precision / recall) |
|---|---|
| bradtraversy/proshop-v2 | 100% / 81.3% |
| sahat/hackathon-starter | 100% / 93.2% |

Details in `packages/extractor/eval/blind/README.md`.

## Calibration

The Learn-page simulations use memory and CPU numbers measured on a real Node server on this machine, then checked at scales the fit never saw:

```bash
pnpm --filter @vibesim/calibration calibrate   # rewrites packages/sim/src/params.json and calibration/REPORT.md
```

Every held-out check landed within ±25%; see `calibration/REPORT.md`. The engine itself is tested against M/M/1, Erlang C and M/D/1 queueing formulas.

## Layout

```
packages/spec        Trace Spec v1: the JSON format, validated with zod
packages/extractor   ts-morph analyzer, eval harness and blind samples
packages/findings    deterministic scale-risk rules
packages/sim         discrete-event engine, calibrated parameters, flow simulation for Scale mode
packages/catalog     concept catalog, Learn pages and their simulations
apps/cli             `vibesim analyze`
apps/web             the static viewer (Vite + React), Playwright tests in e2e/
calibration          real-server measurements
fixtures/repos       ground-truth repos (the three gallery repos are source-only copies)
docs/USAGE.md        how to run it, analyze a repo and read the views
docs/ARCHITECTURE.md how it works inside
docs/PLAN.md         the plan
```

## Checks

```bash
pnpm check                                       # typecheck + unit tests
pnpm --filter @vibesim/web test:e2e              # browser tests on your installed Chrome
```
