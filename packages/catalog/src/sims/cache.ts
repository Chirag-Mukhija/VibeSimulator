import { Histogram, Resource, Sim } from "@vibesim/sim";
import { num, type Params, type SimDef, type SimResult } from "./types.ts";

const DB_CORES = 8;
const CACHE_MS = 0.5;

function simulate(rate: number, hitRatio: number, dbMs: number, seed: number) {
  const sim = new Sim(seed);
  const db = new Resource(sim, DB_CORES);
  const latency = new Histogram();
  const total = Math.min(20_000, Math.max(1000, Math.round(rate * 6)));
  let n = 0;
  let dbQueries = 0;
  function* request() {
    const start = sim.now;
    yield sim.timeout(CACHE_MS);
    if (!sim.rng.chance(hitRatio)) {
      dbQueries++;
      yield db.acquire();
      yield sim.timeout(sim.rng.lognormal(dbMs, 0.7));
      db.release();
      yield sim.timeout(CACHE_MS); // write the fresh value back to the cache
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
  sim.run(Infinity, 1_000_000);
  return { p50: latency.percentile(50), p95: latency.percentile(95), dbPerSec: (dbQueries / total) * rate, dbUtil: db.utilization() * 100 };
}

function run(p: Params, seed = 1): SimResult {
  const rate = num(p, "rate");
  const hit = num(p, "hit") / 100;
  const dbMs = num(p, "db");
  const cached = simulate(rate, hit, dbMs, seed);
  const none = simulate(rate, 0, dbMs, seed);
  const capacity = (DB_CORES * 1000) / dbMs;
  return {
    metrics: [
      { label: "Median latency with the cache", value: cached.p50, format: "ms", tone: "good" },
      { label: "p95 latency with the cache", value: cached.p95, format: "ms" },
      { label: "p95 latency without a cache", value: none.p95, format: "ms", tone: none.p95 > cached.p95 * 2 ? "bad" : "neutral" },
      { label: "Database queries per second", value: cached.dbPerSec, format: "rps" },
      { label: "Database busy (with / without cache)", value: cached.dbUtil, format: "pct", hint: `without the cache: ${none.dbUtil.toFixed(0)}%` },
    ],
    charts: [
      { type: "bars", title: "Database load", unit: "queries/s", bars: [
        { label: "No cache", value: rate, note: rate > capacity ? "over capacity" : undefined },
        { label: `${Math.round(hit * 100)}% hit ratio`, value: cached.dbPerSec, highlight: true },
      ] },
      { type: "bars", title: "Latency", unit: "ms", bars: [
        { label: "p50, no cache", value: none.p50 },
        { label: "p50, cache", value: cached.p50, highlight: true },
        { label: "p95, no cache", value: none.p95 },
        { label: "p95, cache", value: cached.p95, highlight: true },
      ] },
    ],
    verdict: rate > capacity && rate * (1 - hit) < capacity
      ? `Without the cache the database needs ${rate.toFixed(0)} queries/s but can do about ${capacity.toFixed(0)}, so requests queue without end. The cache absorbs ${Math.round(hit * 100)}% of reads and brings it back under capacity.`
      : `A ${Math.round(hit * 100)}% hit ratio cuts database queries ${(1 / Math.max(0.01, 1 - hit)).toFixed(0)}× and makes most requests sub-millisecond. The p95 barely moves while misses still go to the database: the cache helps typical requests far more than the slowest ones.`,
  };
}

export const cacheSim: SimDef = {
  id: "cache-aside",
  title: "Putting a cache in front of the database",
  knobs: [
    { type: "slider", id: "rate", label: "Reads per second", min: 50, max: 10_000, log: true },
    { type: "slider", id: "hit", label: "Cache hit ratio", min: 0, max: 99, step: 1, unit: "%" },
    { type: "slider", id: "db", label: "Database query time", min: 1, max: 200, log: true, unit: "ms" },
  ],
  defaults: { rate: 1500, hit: 90, db: 8 },
  run,
  predict(p) {
    const hit = num(p, "hit");
    const factor = 1 / Math.max(0.01, 1 - hit / 100);
    const answer = factor < 1.5 ? "a" : factor < 5 ? "b" : factor < 30 ? "c" : "d";
    return {
      question: `With a ${hit}% hit ratio, how much less work does the database do?`,
      options: [{ id: "a", label: "About the same" }, { id: "b", label: "2 to 5 times less" }, { id: "c", label: "About 10 times less" }, { id: "d", label: "About 100 times less" }],
      answer,
    };
  },
  assumptions: [
    `Redis lookup ${CACHE_MS} ms; the database runs ${DB_CORES} queries in parallel; query times vary (log-normal).`,
    "Hits are random. Real traffic is skewed toward popular keys, which usually helps hit ratios.",
  ],
};
