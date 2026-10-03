# vibeSimulator: Plan

Copied from the approved plan (2026-10-03). This file is the source of truth for every build session; update it when a decision changes.

## Context

Most people ship backends they did not write (AI-generated, inherited, or open source) and cannot explain how a request actually moves through them or what breaks when traffic grows. Existing tools each cover one slice. Blank-canvas simulators (PaperDraw, systemdesignsim, systemdesignsimulator.in) never look at your code. Repo-to-diagram tools (GitDiagram, DeepWiki) draw LLM-guessed boxes with no flows and no proof. BARA is the nearest competitor: regex-parsed, HTTP-only, no scale analysis. AppMap and Jaeger trace real runs but need traffic and have no what-if.

**What we build:** point it at a repo and it shows, per request path, how a click travels to the response. Every hop is labeled with its protocol and connection lifecycle and linked to the exact code line that proves it. Scale risks are detected from the code and explained by linked Learn pages with premade simulations. It is a tool for understanding a codebase, not a course. The Learn pages exist because the tool needs them.

## What makes us different

| Pillar | Competitors | Us |
|---|---|---|
| Starts from real code | Blank canvas, or LLM-drawn diagram | Parser-based extraction (TypeScript compiler API, also reads plain JS/CommonJS) |
| Trust | Unverified boxes and edges | Every edge carries `file:line` evidence and a status: **verified** (parser), **inferred** (LLM), or **unresolved** (shown dashed, never guessed) |
| Depth per hop | "HTTP" at best | Protocol + connection lifecycle (new per request, pooled, persistent) + sync/async + architectural decision |
| Code to concept link | None | Detected `long polling` at `src/x.ts:42` links to its Learn page and simulation |
| Simulation truth | Generic capacities | Parameters calibrated against real servers measured on this machine, with published measured vs simulated error |
| Works offline, no key | Often need an API key | Deterministic core. The LLM is optional and only used for gaps |

## Product scope and limits

- **Journey:** `vibesim analyze <repo>` produces `vibesim.trace.json`, which is dropped onto the static site. The overview lists entry points (UI events, routes, background jobs, subscriptions). Pick a path, then the Flow Player steps through every hop with the code evidence visible. Click a node for its mechanism, and click again for its internals. The Findings tab lists scale risks with Learn links.
- **Drill-down cap (the usability limit):** 3 levels only. L0 = flow. L1 = node mechanism (what it is, protocol, config found in code, finding badges). L2 = internals with **exactly one** mini-simulation. Beyond L2, link out to the Learn page. Each panel shows at most about 7 items.
- **Learn page template (≤600 words):** problem it solves, mini-sim (≤3 knobs, predict-then-run), when it breaks, where it appears in your repo, related concepts. "Explain why" is an optional toggle, never default.
- **Concept catalog (fixed, 100–200 long term):** categories are communication models, traffic and edge, concurrency models, data, async and messaging, and reliability. A concept ships only with page + sim + detection test. **v1: 12 full concepts**: HTTP lifecycle, connection pooling, short polling, long polling, SSE, WebSocket, pub/sub, message queue + worker, load balancer, cache-aside, N+1 / index, event loop vs threads vs processes. The rest are title-and-summary stubs.

## LLM policy

- **Catalog explainers:** written once at dev time, reviewed, committed. Zero runtime cost.
- **Tier 0 (default, always works):** the deterministic extractor builds the full graph and findings. Anything it cannot resolve becomes an `unresolved` hop plus a gap record.
- **Tier 1 (optional):** resolves **only the gaps needed to continue the flow**, using the user's own key or a local model, or a no-key copy/paste path (`gaps.md`). LLM-filled edges are flagged "inferred".
- **Tier 2 (optional):** repo-specific prose is templated from the spec by default.

## Architecture

TypeScript pnpm monorepo, static web app. No server in v1, and code never leaves the user's machine.

```
packages/spec/        zod schemas + JSON Schema ("Trace Spec v1")
packages/extractor/   ts-morph analyzers (JS + TS): handles -> routes -> call graph -> resources
packages/findings/    deterministic rule engine
packages/catalog/     concept registry + explainers + mini-sim scenarios
packages/sim/         pure deterministic discrete-event engine (seeded RNG)
apps/cli/             `vibesim analyze`
apps/web/             Vite + React static site
calibration/          real servers + load generators -> sim params
fixtures/repos/       tiny sample apps + hand-labeled ground truth
gallery/              pre-analyzed traces + curated notes
```

## Phases

| # | Deliverable | Acceptance / go-no-go | Status |
|---|---|---|---|
| P0 | Monorepo, `spec` package, 2 hand-written spec fixtures, vitest | Fixtures validate, tests green | Done |
| P1 | Extractor v1 (Express on JS/TS; pg, Prisma, redis, ioredis, ws, fetch/axios, S3, timers, frontend fetch/WebSocket incl. inline HTML scripts) + `eval` vs hand-labeled truth | **GO/NO-GO:** edge precision ≥90%, recall ≥85%; 100% of edges carry evidence; unknowns `unresolved`, never guessed | Done: 100%/100% on 6 fixtures; blind first runs 100%/81.3% (proshop-v2) and 100%/93.2% (hackathon-starter) |
| P2 | Web Flow Player: load JSON, overview, path picker, step-through animation, L0/L1 inspector, code evidence | Browser smoke test passes; review on gallery repos | Done |
| P3 | Findings engine + concept registry wiring | Each rule has positive and negative fixtures | Done: 18 finding types |
| P4 | Sim engine + calibration harness + 12 concept mini-sims + Learn pages | Engine matches queueing theory (M/M/1, Little's law); polling vs WebSocket sim within ±25% of measured | Done: calibration PASS (`calibration/REPORT.md`) |
| P5 | Gallery + curated walkthroughs; static build; CLI usable locally | First shareable release (public deploy only with owner's approval) | Done: private preview published; public deploy awaiting approval |
| P6 | Scale mode on real flows + fixed what-if menu (add LB, add cache, add queue, polling to SSE, add replica, batch loops) | Each transform moves metrics in the direction theory and calibration predict | Done: `packages/sim/test/flowsim.test.ts` |
| Later | Hosted GitHub-URL analyzer, Python/Java/Go extractors, OpenTelemetry import, free-form editing, accounts | Not scheduled | |

## Gallery

- [Chirag-Mukhija/PaytmentGateway](https://github.com/Chirag-Mukhija/PaytmentGateway): idempotent payments, Postgres transactions
- [Chirag-Mukhija/InstaBackend](https://github.com/Chirag-Mukhija/InstaBackend): auth, fan-out feeds, keyset pagination, Nginx, Redis rate limiting
- [Chirag-Mukhija/Job-Scheduler](https://github.com/Chirag-Mukhija/Job-Scheduler): worker queue, retries/DLQ, Redis pub/sub to WebSocket dashboard
- One respected open-source backend (chosen during P5)

## Risks

- Extraction accuracy is the make-or-break (P1 gate). Dynamic code stays `unresolved`.
- Static analysis cannot know endpoint latency, so scale numbers come from detected patterns times calibrated costs, and are labeled as models.
- The viewer is copyable, so the moat is verified extraction, concept linking, and calibrated sims.
- Catalog authoring is the long tail; the "page + sim + detection test" gate keeps it sustainable.
