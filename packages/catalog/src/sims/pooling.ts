import { Histogram, Resource, Sim } from "@vibesim/sim";
import { num, type Params, type SimDef, type SimResult } from "./types.ts";

const DB_CORES = 8;
const MAX_CONNECTIONS = 100;
const QUERY_MS = 4;
const HANDSHAKE_MS = 8;
const POOL_TIMEOUT_MS = 1000;

interface Run {
  p50: number;
  p95: number;
  failedPct: number;
  poolWaitP95: number;
  dbUtil: number;
}

function simulate(mode: "pool" | "per-request", rate: number, poolSize: number, seed: number): Run {
  const sim = new Sim(seed);
  const dbCpu = new Resource(sim, DB_CORES);
  const pool = new Resource(sim, Math.min(poolSize, MAX_CONNECTIONS));
  const slots = new Resource(sim, MAX_CONNECTIONS, 0); // the database refuses connection #101
  const latency = new Histogram();
  const poolWaits = new Histogram();
  let failed = 0;
  const total = Math.min(6000, Math.max(800, Math.round(rate * 4)));
  let n = 0;
  function* query() {
    yield dbCpu.acquire();
    yield sim.timeout(sim.rng.lognormal(QUERY_MS, 0.6));
    dbCpu.release();
  }
  function* request() {
    const start = sim.now;
    if (mode === "pool") {
      yield pool.acquire();
      const waited = sim.now - start;
      poolWaits.add(waited);
      if (waited > POOL_TIMEOUT_MS) failed++;
      yield* query();
      pool.release();
    } else {
      const ok = (yield slots.acquire()) as boolean;
      if (!ok) {
        failed++;
        latency.add(sim.now - start);
        return;
      }
      yield sim.timeout(HANDSHAKE_MS); // TCP + auth handshake
      yield* query();
      slots.release();
    }
    latency.add(sim.now - start);
  }
  function* arrivals() {
    while (n < total) {
      yield sim.timeout(sim.rng.exp(1000 / rate));
      n++;
      sim.spawn(request());
    }
  }
  sim.spawn(arrivals());
  sim.run(Infinity, 800_000);
  return { p50: latency.percentile(50), p95: latency.percentile(95), failedPct: (failed / total) * 100, poolWaitP95: poolWaits.percentile(95), dbUtil: dbCpu.utilization() * 100 };
}

function run(p: Params, seed = 1): SimResult {
  const rate = num(p, "rate");
  const size = num(p, "pool");
  const pooled = simulate("pool", rate, size, seed);
  const fresh = simulate("per-request", rate, size, seed);
  return {
    metrics: [
      { label: "p95 latency with the pool", value: pooled.p95, format: "ms", tone: pooled.p95 > 100 ? "bad" : "good" },
      { label: "Time spent waiting for a free connection (p95)", value: pooled.poolWaitP95, format: "ms", tone: pooled.poolWaitP95 > 20 ? "bad" : "good" },
      { label: "p95 latency opening a connection per request", value: fresh.p95, format: "ms", tone: fresh.p95 > pooled.p95 * 1.5 ? "bad" : "neutral" },
      { label: "Requests refused (no connection slot)", value: fresh.failedPct, format: "pct", tone: fresh.failedPct > 0.5 ? "bad" : "good" },
      { label: "Database CPU busy", value: pooled.dbUtil, format: "pct" },
    ],
    charts: [
      { type: "bars", title: "p95 latency", unit: "ms", bars: [
        { label: `Pool of ${size}`, value: pooled.p95, highlight: true },
        { label: "New connection each request", value: fresh.p95 },
      ] },
      { type: "bars", title: "Requests that failed", unit: "%", bars: [
        { label: `Pool of ${size}`, value: pooled.failedPct, highlight: true, note: pooled.failedPct ? `waited > ${POOL_TIMEOUT_MS} ms` : undefined },
        { label: "New connection each request", value: fresh.failedPct, note: fresh.failedPct ? "too many connections" : undefined },
      ] },
    ],
    verdict:
      fresh.failedPct > 1
        ? `Opening a connection per request needs more than ${MAX_CONNECTIONS} at once at this rate, so the database starts refusing them (${fresh.failedPct.toFixed(1)}% failed). The pool reuses ${size} connections and never asks for more.`
        : pooled.poolWaitP95 > 20
          ? `The pool is the bottleneck: requests wait about ${Math.round(pooled.poolWaitP95)} ms for a free connection. A slightly bigger pool helps, up to what the database can actually run in parallel (${DB_CORES} cores here).`
          : `The pool skips the ${HANDSHAKE_MS} ms handshake on every request and keeps the database's connection count fixed at ${size}.`,
  };
}

export const poolingSim: SimDef = {
  id: "connection-pooling",
  title: "A pool of connections vs a new one per request",
  knobs: [
    { type: "slider", id: "rate", label: "Requests per second", min: 10, max: 4000, log: true },
    { type: "slider", id: "pool", label: "Pool size", min: 1, max: 100, step: 1 },
  ],
  defaults: { rate: 800, pool: 10 },
  run,
  predict(p, r) {
    const p95 = r.metrics[0]!.value;
    const chart = r.charts[1];
    const failed = chart?.type === "bars" ? chart.bars[0]!.value : 0;
    const answer = failed > 1 ? "d" : p95 < 10 ? "a" : p95 < 50 ? "b" : "c";
    return {
      question: `${num(p, "rate")} requests per second share a pool of ${num(p, "pool")} connections, each query takes about ${QUERY_MS} ms. What does p95 latency look like?`,
      options: [{ id: "a", label: "Under 10 ms" }, { id: "b", label: "10 to 50 ms" }, { id: "c", label: "Over 50 ms" }, { id: "d", label: "Requests start failing" }],
      answer,
    };
  },
  assumptions: [
    `Queries take about ${QUERY_MS} ms of database CPU (log-normal); the database runs ${DB_CORES} queries at once and accepts at most ${MAX_CONNECTIONS} connections, like Postgres's default.`,
    `Opening a connection costs a ${HANDSHAKE_MS} ms TCP + auth handshake inside the same data center (TLS adds more).`,
    `A request that waits more than ${POOL_TIMEOUT_MS} ms for a pooled connection counts as failed.`,
  ],
};
