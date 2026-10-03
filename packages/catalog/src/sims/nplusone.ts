import { Histogram, Resource, Sim } from "@vibesim/sim";
import { bucket, num, str, type Params, type SimDef, type SimResult } from "./types.ts";

const RATE = 20; // requests per second
const DB_CORES = 8;
const RTT_MS = 0.6; // app server to database, same data center
const INDEXED_MS = 0.15;
const PER_ROW_MS = 0.01;
const SCAN_MS_PER_ROW = 0.00008; // ~80 ms to scan a million rows

const STRATS = {
  "n1-noindex": "One query per item, no index",
  "n1-index": "One query per item, indexed",
  "one-noindex": "One query for all items, no index",
  "one-index": "One query for all items, indexed",
} as const;
type Strat = keyof typeof STRATS;

function simulate(items: number, rows: number, strat: Strat, seed: number) {
  const sim = new Sim(seed);
  const db = new Resource(sim, DB_CORES);
  const latency = new Histogram();
  const indexed = strat.endsWith("-index");
  const perQuery = (returned: number) => (indexed ? INDEXED_MS : rows * SCAN_MS_PER_ROW) + returned * PER_ROW_MS;
  const total = 400;
  let n = 0;
  function* query(returned: number) {
    yield sim.timeout(RTT_MS / 2);
    yield db.acquire();
    yield sim.timeout(perQuery(returned));
    db.release();
    yield sim.timeout(RTT_MS / 2);
  }
  function* request() {
    const start = sim.now;
    yield* query(items); // the list itself
    if (strat.startsWith("n1")) for (let i = 0; i < items; i++) yield* query(1);
    else yield* query(items);
    latency.add(sim.now - start);
  }
  function* arrivals() {
    while (n < total) {
      yield sim.timeout(sim.rng.exp(1000 / RATE));
      n++;
      sim.spawn(request());
    }
  }
  sim.spawn(arrivals());
  sim.run(Infinity, 2_000_000);
  const roundTrips = strat.startsWith("n1") ? items + 1 : 2;
  return { p50: latency.percentile(50), p95: latency.percentile(95), roundTrips, dbUtil: db.utilization() * 100 };
}

function run(p: Params, seed = 1): SimResult {
  const items = num(p, "items");
  const rows = num(p, "rows");
  const strat = str(p, "strategy") as Strat;
  const all = (Object.keys(STRATS) as Strat[]).map((s) => ({ s, ...simulate(items, rows, s, seed) }));
  const me = all.find((r) => r.s === strat)!;
  return {
    metrics: [
      { label: "Request time (median)", value: me.p50, format: "ms", tone: me.p50 > 200 ? "bad" : me.p50 < 20 ? "good" : "neutral" },
      { label: "Request time (p95)", value: me.p95, format: "ms" },
      { label: "Database round trips per request", value: me.roundTrips, format: "int", tone: me.roundTrips > 10 ? "bad" : "good" },
      { label: "Database busy", value: me.dbUtil, format: "pct", tone: me.dbUtil > 90 ? "bad" : "neutral" },
    ],
    charts: [
      { type: "bars", title: `Request time with ${items} items and ${rows.toLocaleString("en-US")} rows`, unit: "ms", bars: all.map((r) => ({ label: STRATS[r.s], value: r.p50, highlight: r.s === strat, note: r.dbUtil > 95 ? "database overloaded" : undefined })) },
    ],
    verdict: strat === "n1-noindex"
      ? `Every one of ${items + 1} queries scans all ${rows.toLocaleString("en-US")} rows. Either fix alone helps a lot; both together turn seconds into milliseconds.`
      : strat === "n1-index"
        ? `The index makes each lookup fast, but ${items + 1} sequential round trips still add up to about ${(me.roundTrips * RTT_MS).toFixed(0)} ms of pure waiting. One query with WHERE id IN (...) needs 2.`
        : strat === "one-noindex"
          ? `Two round trips, but each scans the whole table. Fine at 10,000 rows, slow at 10 million: add an index on the column you filter by.`
          : `Two round trips, each answered from an index: this barely changes as the table grows.`,
  };
}

export const nPlusOneSim: SimDef = {
  id: "n-plus-one",
  title: "One query per item vs one query, with and without an index",
  knobs: [
    { type: "slider", id: "items", label: "Items on the page", min: 1, max: 200, step: 1 },
    { type: "slider", id: "rows", label: "Rows in the table", min: 1_000, max: 10_000_000, log: true },
    { type: "select", id: "strategy", label: "How the code queries", options: (Object.keys(STRATS) as Strat[]).map((s) => ({ value: s, label: STRATS[s] })) },
  ],
  defaults: { items: 50, rows: 1_000_000, strategy: "n1-index" },
  run,
  predict(p, r) {
    const ms = r.metrics[0]!.value;
    return {
      question: `A page shows ${num(p, "items")} items and the code uses "${STRATS[str(p, "strategy") as Strat].toLowerCase()}". About how long does the database part of one request take?`,
      options: [{ id: "a", label: "About 2 ms" }, { id: "b", label: "About 20 ms" }, { id: "c", label: "About 200 ms" }, { id: "d", label: "Several seconds" }],
      answer: bucket(ms, [{ id: "a", at: 2 }, { id: "b", at: 20 }, { id: "c", at: 200 }, { id: "d", at: 3000 }]),
    };
  },
  assumptions: [
    `${RTT_MS} ms network round trip to the database; ${RATE} requests per second; the database runs ${DB_CORES} queries at once.`,
    `Indexed lookups cost ${INDEXED_MS} ms; scanning costs about ${(SCAN_MS_PER_ROW * 1_000_000).toFixed(0)} ms per million rows. Real numbers depend on the database, row size and caching.`,
  ],
};
