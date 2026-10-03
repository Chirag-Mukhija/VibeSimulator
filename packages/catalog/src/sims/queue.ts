import { Histogram, Resource, Sim } from "@vibesim/sim";
import { num, type Params, type SimDef, type SimResult } from "./types.ts";

/**
 * Work that talks to a slow dependency (an email provider that allows N
 * parallel sends). Done inline, each request waits for a slot. Done through a
 * queue, the request returns at once and workers drain the backlog.
 */

const SPIKE_START = 20_000;
const SPIKE_END = 30_000;
const DURATION = 70_000;
const ENQUEUE_MS = 3;
const REQUEST_TIMEOUT_MS = 30_000;

function run(p: Params, seed = 1): SimResult {
  const rate = num(p, "rate");
  const workers = num(p, "workers");
  const jobMs = num(p, "job");
  const rateAt = (t: number) => (t >= SPIKE_START && t < SPIKE_END ? rate * 4 : rate);

  // ---- inline: the request holds a slot of the slow dependency
  const inline = (() => {
    const sim = new Sim(seed);
    const slots = new Resource(sim, workers);
    const latency = new Histogram();
    let timeouts = 0;
    function* request() {
      const start = sim.now;
      yield slots.acquire();
      yield sim.timeout(sim.rng.lognormal(jobMs, 0.4));
      slots.release();
      const t = sim.now - start;
      if (t > REQUEST_TIMEOUT_MS) timeouts++;
      latency.add(Math.min(t, REQUEST_TIMEOUT_MS));
    }
    function* arrivals() {
      while (sim.now < DURATION) {
        yield sim.timeout(sim.rng.exp(1000 / rateAt(sim.now)));
        sim.spawn(request());
      }
    }
    sim.spawn(arrivals());
    sim.run(DURATION * 3, 1_500_000);
    return { p95: latency.percentile(95), timeoutsPct: (timeouts / Math.max(1, latency.count)) * 100 };
  })();

  // ---- queued: the request enqueues; workers process in the background
  const queued = (() => {
    const sim = new Sim(seed);
    const workerPool = new Resource(sim, workers);
    const response = new Histogram();
    const completion = new Histogram();
    const depth: [number, number][] = [];
    let maxDepth = 0;
    let lastBusy = 0;
    function* job(enqueuedAt: number) {
      yield workerPool.acquire();
      yield sim.timeout(sim.rng.lognormal(jobMs, 0.4));
      workerPool.release();
      completion.add(sim.now - enqueuedAt);
      lastBusy = sim.now;
    }
    function* request() {
      yield sim.timeout(ENQUEUE_MS);
      response.add(ENQUEUE_MS);
      sim.spawn(job(sim.now));
    }
    function* arrivals() {
      while (sim.now < DURATION) {
        yield sim.timeout(sim.rng.exp(1000 / rateAt(sim.now)));
        sim.spawn(request());
      }
    }
    sim.spawn(arrivals());
    sim.every(1000, () => {
      const d = workerPool.queue.length;
      maxDepth = Math.max(maxDepth, d);
      if (sim.now <= DURATION * 2) depth.push([sim.now / 1000, d]);
    });
    sim.run(DURATION * 2, 1_500_000);
    return { responseP95: response.percentile(95), completionP95: completion.percentile(95), maxDepth, depth, drainedAt: lastBusy };
  })();

  const capacity = (workers * 1000) / jobMs;
  return {
    metrics: [
      { label: "API response p95, work done inline", value: inline.p95, format: "ms", tone: inline.p95 > 2000 ? "bad" : "neutral" },
      { label: "API response p95, through a queue", value: queued.responseP95, format: "ms", tone: "good" },
      { label: "Longest backlog during the spike", value: queued.maxDepth, format: "count", tone: queued.maxDepth > 1000 ? "bad" : "neutral" },
      { label: "Job done within (p95, queued)", value: queued.completionP95, format: "ms" },
      { label: "Inline requests that hit the 30 s timeout", value: inline.timeoutsPct, format: "pct", tone: inline.timeoutsPct > 0 ? "bad" : "good" },
    ],
    charts: [
      { type: "lines", title: "Jobs waiting in the queue (spike from 20 s to 30 s)", xLabel: "seconds", yLabel: "jobs waiting", series: [{ label: "backlog", points: queued.depth }] },
      { type: "bars", title: "What the user waits for (p95)", unit: "ms", bars: [
        { label: "Inline", value: inline.p95 },
        { label: "Queued", value: queued.responseP95, highlight: true },
      ] },
    ],
    verdict:
      rate * 4 > capacity
        ? `During the spike jobs arrive ${(rate * 4).toFixed(0)}/s but ${workers} workers finish only ${capacity.toFixed(0)}/s. Inline, users wait for that backlog (or time out). With a queue the API still answers in ${ENQUEUE_MS} ms and the backlog of ${queued.maxDepth} jobs drains afterwards.`
        : `${workers} workers keep up even during the spike, so both approaches are fine here. Push the rate or the job time up until the spike exceeds ${capacity.toFixed(0)} jobs/s.`,
  };
}

export const queueSim: SimDef = {
  id: "message-queue",
  title: "Doing slow work inline vs through a queue",
  knobs: [
    { type: "slider", id: "rate", label: "Jobs per second (normal traffic)", min: 1, max: 200, log: true },
    { type: "slider", id: "workers", label: "Workers (parallel slots)", min: 1, max: 50, step: 1 },
    { type: "slider", id: "job", label: "Time per job", min: 20, max: 5000, log: true, unit: "ms" },
  ],
  defaults: { rate: 20, workers: 10, job: 400 },
  run,
  predict(p, r) {
    const queuedP95 = r.metrics[1]!.value;
    const inlineP95 = r.metrics[0]!.value;
    return {
      question: `Traffic quadruples for 10 seconds. With the queue in place, what happens to the API's response time during the spike?`,
      options: [{ id: "a", label: "Stays at a few ms" }, { id: "b", label: "Climbs to seconds" }, { id: "c", label: "Requests fail" }],
      answer: queuedP95 < 50 ? "a" : inlineP95 > 25_000 ? "c" : "b",
    };
  },
  assumptions: [
    "Each job calls a slow dependency that allows only as many parallel calls as there are workers (an email or payment provider's limit).",
    `Normal traffic for 20 s, 4× traffic from 20 s to 30 s, then normal again. Enqueueing costs ${ENQUEUE_MS} ms.`,
    "Inline requests give up after 30 s, as a typical proxy timeout would.",
  ],
};
