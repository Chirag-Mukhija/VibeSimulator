import { Histogram, Resource, Sim } from "@vibesim/sim";
import { num, str, type Params, type SimDef, type SimResult } from "./types.ts";

const SERVICE_MS = 10;
const LOAD = 0.75;
const ALGOS = { "round-robin": "Round robin", "least-connections": "Least connections", random: "Random" } as const;
type Algo = keyof typeof ALGOS;
const MIXES = { steady: 0.3, mixed: 1.5, "heavy-tail": 3 } as const;

function simulate(servers: number, algo: Algo, cv: number, seed: number) {
  const sim = new Sim(seed);
  const pool = Array.from({ length: servers }, () => new Resource(sim, 1));
  const latency = new Histogram();
  const rate = (LOAD * servers * 1000) / SERVICE_MS; // per second
  const total = Math.min(30_000, Math.round(rate * 30));
  let n = 0;
  let rr = 0;
  const pick = (): Resource => {
    if (algo === "round-robin") return pool[rr++ % servers]!;
    if (algo === "random") return pool[sim.rng.int(servers)]!;
    return pool.reduce((best, s) => (s.inUse + s.queue.length < best.inUse + best.queue.length ? s : best));
  };
  function* request() {
    const start = sim.now;
    const server = pick();
    yield server.acquire();
    yield sim.timeout(sim.rng.lognormal(SERVICE_MS, cv));
    server.release();
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
  return { p50: latency.percentile(50), p95: latency.percentile(95), p99: latency.percentile(99), util: pool.map((s) => s.utilization() * 100) };
}

function run(p: Params, seed = 1): SimResult {
  const servers = num(p, "servers");
  const algo = str(p, "algo") as Algo;
  const cv = MIXES[str(p, "mix") as keyof typeof MIXES] ?? 1.5;
  const all = (Object.keys(ALGOS) as Algo[]).map((a) => ({ algo: a, ...simulate(servers, a, cv, seed) }));
  const me = all.find((r) => r.algo === algo)!;
  const best = all.reduce((b, r) => (r.p99 < b.p99 ? r : b));
  return {
    metrics: [
      { label: "Median latency", value: me.p50, format: "ms" },
      { label: "p95 latency", value: me.p95, format: "ms" },
      { label: "p99 latency", value: me.p99, format: "ms", tone: me.algo === best.algo ? "good" : "bad" },
    ],
    charts: [
      { type: "bars", title: "p99 latency by algorithm (same traffic)", unit: "ms", bars: all.map((r) => ({ label: ALGOS[r.algo], value: r.p99, highlight: r.algo === algo })) },
      { type: "bars", title: `How busy each server was (${ALGOS[algo]})`, unit: "%", bars: me.util.map((u, i) => ({ label: `server ${i + 1}`, value: u, highlight: true })) },
    ],
    verdict: servers === 1
      ? "With one server there is nothing to balance: every request waits in the same queue. Add servers to see the algorithms differ."
      : `${ALGOS[best.algo]} gives the best tail here. Round robin and random hand the next request to a server even if it is stuck on a slow one; least connections sends it to whoever is free.${cv < 0.5 ? " With steady request costs the difference is small; try the heavy-tail mix." : ""}`,
  };
}

export const loadBalancerSim: SimDef = {
  id: "load-balancer",
  title: "Spreading requests across servers",
  knobs: [
    { type: "slider", id: "servers", label: "Servers", min: 1, max: 8, step: 1 },
    { type: "select", id: "algo", label: "Algorithm", options: (Object.keys(ALGOS) as Algo[]).map((a) => ({ value: a, label: ALGOS[a] })) },
    { type: "select", id: "mix", label: "Request costs", options: [
      { value: "steady", label: "Steady (similar requests)" },
      { value: "mixed", label: "Mixed (some slow ones)" },
      { value: "heavy-tail", label: "Heavy tail (a few very slow)" },
    ] },
  ],
  defaults: { servers: 4, algo: "round-robin", mix: "heavy-tail" },
  run,
  predict(_p, r) {
    const chart = r.charts[0]!;
    const bars = chart.type === "bars" ? chart.bars : [];
    const best = bars.reduce((b, x) => (x.value < b.value ? x : b), bars[0]!);
    const id = { "Round robin": "a", "Least connections": "b", Random: "c" }[best.label] ?? "b";
    return {
      question: "Some requests are much slower than others. Which algorithm keeps the slowest 1% of requests fastest?",
      options: [{ id: "a", label: "Round robin" }, { id: "b", label: "Least connections" }, { id: "c", label: "Random" }],
      answer: id,
    };
  },
  assumptions: [
    `Each server handles one request at a time; requests average ${SERVICE_MS} ms (log-normal, variability set by "request costs").`,
    `Traffic is ${Math.round(LOAD * 100)}% of total capacity, arriving at random.`,
  ],
};
