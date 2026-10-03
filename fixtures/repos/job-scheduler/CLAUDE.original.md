# Distributed Job Scheduler — Project Context for Claude

## What This Is
A distributed task queue and job scheduler built from scratch — the kind of system BullMQ/Sidekiq/
Celery implement under the hood. Built as a **learning project**: the goal is understanding
distributed systems concepts (at-least-once delivery, locking, backpressure, retries, graceful
shutdown), not shipping a production-ready queue. This shapes every decision in the codebase —
see "Working Style" below before changing anything.

Stack: Node.js + Express + PostgreSQL (durable job store) + Redis (hot claim path + Pub/Sub,
Phase 5+) + WebSockets (live dashboard, Phase 6) + Docker Compose (Phase 7).

All 7 planned phases are built, verified end-to-end, and documented. This is a complete system,
not a work in progress — treat any future work as **extending** a finished, working project.

## Full Theory Documentation
`docs/phase1-theory.pdf` through `docs/phase7-theory.pdf` — one PDF per phase, each ~9–13 pages,
written for the project owner to study six months from now with no memory of building it. Each
covers: what the phase builds, an architecture/data-flow diagram, core concepts (what/why/what-
breaks-without-it/how-implemented), the data model with real example rows, failure modes (with
honest, named limitations — not just happy paths), a decisions log (decision/alternatives/reason/
tradeoff), and 10 self-check questions. **Read the relevant phase's PDF before making non-trivial
changes to that phase's area** — the reasoning behind non-obvious choices lives there, not in code
comments (this codebase deliberately has almost none — see below).

## Phase-by-Phase Summary

**Phase 1 — Job submission API + Postgres queue.** `jobs` table (id, type, payload jsonb, status
enum, attempts, error, created_at, updated_at). `api/services/queueService.js` is the *only*
module allowed to touch the `jobs` table — API routes and the worker both go through it, never
raw SQL elsewhere. `POST/GET /jobs`, `GET /jobs/:id`.

**Phase 2 — Worker process.** Separate process (`worker/`) polling for pending jobs.
`claimNextJob` originally used `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent claiming
(later replaced in Phase 5 — see below). Handler registry (`worker/handlers/index.js`) maps
`job.type` → an async function. Known gap named honestly in the Phase 2 doc: a hard-killed worker
mid-job leaves that row stuck at `processing` forever — **this is exactly what Phase 7's graceful
shutdown fixes**, don't reintroduce it.

**Phase 3 — Retry + exponential backoff + dead letter queue.** Added `run_at` (generic "not
eligible until" timestamp — reused unchanged by Phase 4) and `max_attempts` columns. On failure,
`queueService.recordFailure` either reschedules the job (`status='pending'`, `run_at` pushed out
via `backoffSeconds()` in `api/services/backoff.js`, no jitter, no cap — deliberate simplification)
or dead-letters it (`status='failed'` — **no separate `dead_letter` enum value was added**,
`failed` *is* the DLQ). `POST /jobs/:id/retry` is the manual recovery path, guarded by
`WHERE status = 'failed'`.

**Phase 4 — Priority + delayed jobs.** Added `priority` column — **lower number = more urgent**
(0 default/highest, like `nice`). Claim ordering: `ORDER BY priority ASC, run_at ASC, id ASC`.
Delayed jobs reuse `run_at` via an optional `delaySeconds` on submission — no new column.

**Phase 5 — Redis hot claim path.** This is the biggest mechanical shift — read it carefully
before touching `claimNextJob` or anything in `api/services/redisQueue.js`. Postgres remains the
sole source of truth for job data; Redis holds only a disposable index: **one sorted set per
priority tier**, keys `queue:priority:0`..`9` (out-of-range priorities are clamped, not rejected),
member = job id, score = `run_at` as epoch ms (so `ZRANGEBYSCORE ... 0 now` naturally excludes
not-yet-due jobs — no separate "promote due jobs" process needed). Claiming is now two steps: ask
Redis for a candidate id, then a **guarded single-row Postgres `UPDATE ... WHERE status='pending'`**
(no more `FOR UPDATE SKIP LOCKED` — that pattern solved a full-table-scan contention problem that
no longer exists once Redis has already picked one candidate). A zero-row `UPDATE` means a stale
Redis entry — the code `ZREM`s it and retries the same tier. **Every place a job becomes newly
eligible must write to both Postgres and Redis**: `enqueueJob`, `recordFailure`'s retry branch,
`retryJob`. Forgetting the Redis write for a new eligibility path is the single easiest bug to
introduce in this codebase. Known, accepted limitation: no fallback to table-scanning if Redis is
down — the claim path has a hard Redis dependency by design (documented, not an oversight).

**Phase 6 — Live dashboard.** `ws` (not socket.io — deliberately minimal) attached to the same
`http.Server` Express uses. Cross-process events (worker → API) go through **Redis Pub/Sub**
(channel `job:events`, published via `api/services/events.js`, called from inside
`queueService.js` at every transition — not from the worker directly, so all state-mutation and
event-emission stays colocated). Pub/Sub needs its own dedicated Redis connection
(`getRedisSubscriber()` in `api/db/redisClient.js`) — a subscribed connection can't run normal
commands. Worker presence (`api/ws/broadcast.js`) is **in-memory only** on the API process,
intentionally not persisted — a worker is "online" if a heartbeat arrived in the last 15s.
Dashboard at `GET /dashboard` is one static HTML file, vanilla JS, no build step, no framework —
deliberately, per this project's "no fancy things" rule.

**Phase 7 — Docker + multi-worker + graceful shutdown.** Both processes handle `SIGTERM`/`SIGINT`:
the worker tracks its current job as a module-level `inFlight` promise and awaits it before
exiting (never abandons a job mid-execution — this is the direct fix for Phase 2's named gap); the
API explicitly closes every tracked WebSocket (`broadcast.closeAllClients()`) *before*
`server.close()`, because an open WebSocket otherwise blocks `close()`'s callback forever (Node's
`http.Server.close()` only stops new connections, it doesn't terminate existing ones — a real gap
found during this phase's own testing, not a hypothetical). Two separate Dockerfiles
(`Dockerfile.api`, `Dockerfile.worker`) rather than one parameterized one, matching the project's
process-separation philosophy. `docker-compose.yml` wires `postgres` (named volume — durable),
`redis` (no volume — deliberately disposable, consistent with Phase 5's design), `api`, `worker`
(no hardcoded replica count — `docker-compose up --scale worker=N` works with zero code changes,
because every earlier phase's concurrency-safety work was built exactly so scaling needs no
coordination). **Migrations are never auto-run on container start** — always run
`docker-compose run --rm api npm run migrate` manually after a fresh `up`, deliberately, to avoid
implicit startup magic and concurrent-migration races across replicas.

## Working Style — Read Before Changing Anything

- **This is a learning project.** Don't add production-hardening, abstractions, or "fancy things"
  that aren't already here, unless explicitly asked. Every simplification in this codebase
  (no jitter on backoff, no priority-aging/starvation prevention, no Redis-down fallback, fixed
  0–9 priority tiers, no auto-migrations) is a *deliberate, documented* choice — see that phase's
  theory PDF's Decisions Log before "fixing" one.
- **`queueService.js` owns all SQL.** Never write raw SQL in routes or the worker.
- **API and worker are separate processes, always.** The API never executes job logic; the worker
  never serves HTTP. They only ever communicate through Postgres and Redis, never directly.
- **No inline explanatory comments.** One-line file-purpose comment at the top of each file.
  Comments only for genuinely non-obvious architectural decisions (the codebase has some — that's
  intentional, not accidental restraint).
- **Async/await throughout**, no callbacks.
- When you build a new phase or feature, generate a matching theory PDF the same way the existing
  ones were built: a styled HTML file (same visual system as `docs/phase*-theory.pdf` — cover,
  architecture ASCII diagram, per-concept what/why/what-breaks/how-implemented, data model,
  failure modes with honest limits, decisions log, 10 self-check questions) rendered via headless
  Chrome (`--headless --disable-gpu --print-to-pdf=...`) to a new `docs/phase<N>-theory.pdf`.
- **Verify end-to-end before calling anything done** — real Postgres, real Redis, real HTTP calls,
  real worker processes (and, for deployment changes, real `docker-compose up`). This project's
  own history includes catching real bugs this way (e.g. a migration runner with no tracking of
  what had already applied, found only by actually re-running it) — static review alone has missed
  things here before.

## Local Dev

```
npm install
cp .env.example .env      # then edit DATABASE_URL / REDIS_URL for your local setup
npm run migrate           # tracked via schema_migrations table — safe to re-run
npm start                 # API on :3000
npm run worker            # separate terminal — worker process
```

Dashboard: `http://localhost:3000/dashboard`. Full stack via Docker:
`docker-compose up --build`, then `docker-compose run --rm api npm run migrate`.
