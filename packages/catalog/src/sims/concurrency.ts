import { Histogram, Resource, Sim } from "@vibesim/sim";
import { bucket, num, str, type Params, type SimDef, type SimResult } from "./types.ts";

const RATE = 150;
const LIGHT_CPU_MS = 1;
const LIGHT_IO_MS = 10;
const THREAD_POOL = 4;
const PROCESSES = 4;

const MODELS = {
  "event-loop-blocking": "One event loop, CPU work on it",
  "thread-pool": "One event loop + thread pool (4)",
  cluster: "4 processes (cluster)",
} as const;
type Model = keyof typeof MODELS;

function simulate(model: Model, heavyPct: number, heavyMs: number, seed: number) {
  const sim = new Sim(seed);
  const loops = Array.from({ length: model === "cluster" ? PROCESSES : 1 }, () => new Resource(sim, 1));
  const pool = new Resource(sim, THREAD_POOL);
  const light = new Histogram();
  const heavy = new Histogram();
  const total = 6000;
  let n = 0;
  let rr = 0;
  function* request(isHeavy: boolean) {
    const start = sim.now;
    const loop = loops[rr++ % loops.length]!;
    yield loop.acquire();
    yield sim.timeout(isHeavy && model !== "thread-pool" ? heavyMs : LIGHT_CPU_MS * 0.5);
    loop.release();
    if (isHeavy && model === "thread-pool") {
      yield pool.acquire(); // runs off the main thread
      yield sim.timeout(heavyMs);
      pool.release();
    } else if (!isHeavy) {
      yield sim.timeout(LIGHT_IO_MS); // waiting on the database: no CPU held
    }
    yield loop.acquire();
    yield sim.timeout(LIGHT_CPU_MS * 0.5); // build and send the response
    loop.release();
    (isHeavy ? heavy : light).add(sim.now - start);
  }
  function* arrivals() {
    while (n < total) {
      yield sim.timeout(sim.rng.exp(1000 / RATE));
      n++;
      sim.spawn(request(sim.rng.chance(heavyPct / 100)));
    }
  }
  sim.spawn(arrivals());
  sim.run(Infinity, 1_500_000);
  return { lightP95: light.percentile(95), heavyP95: heavy.percentile(95), loopBusy: (loops.reduce((a, l) => a + l.utilization(), 0) / loops.length) * 100 };
}

function run(p: Params, seed = 1): SimResult {
  const heavyPct = num(p, "heavy");
  const heavyMs = num(p, "cost");
  const model = str(p, "model") as Model;
  const all = (Object.keys(MODELS) as Model[]).map((m) => ({ m, ...simulate(m, heavyPct, heavyMs, seed) }));
  const me = all.find((r) => r.m === model)!;
  const baseline = LIGHT_CPU_MS + LIGHT_IO_MS;
  return {
    metrics: [
      { label: "Simple request p95", value: me.lightP95, format: "ms", tone: me.lightP95 > baseline * 3 ? "bad" : "good", hint: `about ${baseline} ms when nothing gets in the way` },
      { label: "Heavy request p95", value: me.heavyP95, format: "ms" },
      { label: "Main thread busy", value: me.loopBusy, format: "pct", tone: me.loopBusy > 90 ? "bad" : "neutral" },
    ],
    charts: [
      { type: "bars", title: "p95 of a simple, fast request", unit: "ms", bars: all.map((r) => ({ label: MODELS[r.m], value: r.lightP95, highlight: r.m === model, note: r.loopBusy > 95 ? "overloaded" : undefined })) },
      { type: "bars", title: "p95 of the CPU-heavy request", unit: "ms", bars: all.map((r) => ({ label: MODELS[r.m], value: r.heavyP95, highlight: r.m === model })) },
    ],
    verdict: model === "event-loop-blocking"
      ? `While one request hashes for ${heavyMs} ms, the single main thread can do nothing else, so simple requests queue behind it. That is head-of-line blocking: ${heavyPct}% of slow requests make everyone slow.`
      : model === "thread-pool"
        ? `The heavy work runs on ${THREAD_POOL} background threads, so simple requests stay fast. Heavy requests now queue for those ${THREAD_POOL} threads instead.`
        : `${PROCESSES} processes each have their own event loop, so a blocked one only delays its own share of traffic. More capacity, same blocking inside each process.`,
  };
}

export const concurrencySim: SimDef = {
  id: "concurrency-models",
  title: "What one slow request does to everyone else",
  knobs: [
    { type: "slider", id: "heavy", label: "Requests that do heavy CPU work", min: 0, max: 30, step: 1, unit: "%" },
    { type: "slider", id: "cost", label: "CPU time per heavy request", min: 10, max: 500, log: true, unit: "ms" },
    { type: "select", id: "model", label: "Server model", options: (Object.keys(MODELS) as Model[]).map((m) => ({ value: m, label: MODELS[m] })) },
  ],
  defaults: { heavy: 5, cost: 100, model: "event-loop-blocking" },
  run,
  predict(p, r) {
    return {
      question: `${num(p, "heavy")}% of requests run a ${num(p, "cost")} ms password hash. With "${MODELS[str(p, "model") as Model].toLowerCase()}", what is the p95 of a simple request that normally takes ${LIGHT_CPU_MS + LIGHT_IO_MS} ms?`,
      options: [{ id: "a", label: `Still about ${LIGHT_CPU_MS + LIGHT_IO_MS} ms` }, { id: "b", label: "Around 100 ms" }, { id: "c", label: "Seconds" }],
      answer: bucket(r.metrics[0]!.value, [{ id: "a", at: LIGHT_CPU_MS + LIGHT_IO_MS }, { id: "b", at: 100 }, { id: "c", at: 2000 }]),
    };
  },
  assumptions: [
    `${RATE} requests per second. A simple request uses ${LIGHT_CPU_MS} ms of CPU and waits ${LIGHT_IO_MS} ms on the database without holding the CPU.`,
    `Node runs JavaScript on one main thread per process; libuv's thread pool has ${THREAD_POOL} threads by default.`,
  ],
};
