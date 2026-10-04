import { describe, expect, it } from "vitest";
import { CALIBRATION } from "@vibesim/sim";
import { CONCEPTS, PAGES, deliver, wordCount } from "../src/index.ts";
import type { SimDef } from "../src/sims/types.ts";

/** The pages that carry a calibrated simulation (the twelve core concepts). */
const WITH_SIM = PAGES.flatMap((p) => (p.sim ? [{ concept: p.concept, sim: p.sim }] : []));
const simOf = (concept: string): SimDef => WITH_SIM.find((p) => p.concept === concept)!.sim;

describe("Learn pages", () => {
  it("every full concept has a page with a simulation, and every page stays under 600 words with at most 3 knobs", () => {
    for (const c of CONCEPTS.filter((x) => x.full)) expect(WITH_SIM.some((p) => p.concept === c.id), c.id).toBe(true);
    for (const p of PAGES) expect(wordCount(p), p.concept).toBeLessThanOrEqual(600);
    for (const p of WITH_SIM) {
      expect(p.sim.knobs.length, p.concept).toBeLessThanOrEqual(3);
      expect(p.sim.assumptions.length, p.concept).toBeGreaterThan(0);
    }
  });

  it.each(WITH_SIM.map((p) => [p.concept, p] as const))("%s simulation runs, is deterministic and answers its prediction", (_c, p) => {
    const t0 = performance.now();
    const a = p.sim.run(p.sim.defaults, 3);
    const ms = performance.now() - t0;
    expect(ms, "should run fast enough for a browser").toBeLessThan(2500);
    expect(p.sim.run(p.sim.defaults, 3)).toEqual(a);
    expect(a.metrics.length).toBeGreaterThan(1);
    for (const m of a.metrics) expect(Number.isFinite(m.value), m.label).toBe(true);
    expect(a.verdict.length).toBeGreaterThan(30);
    const pred = p.sim.predict?.(p.sim.defaults, a);
    if (pred) expect(pred.options.map((o) => o.id)).toContain(pred.answer);
  });
});

describe("simulations behave the way the theory says", () => {
  it("realtime: polling load grows with users; WebSocket memory follows the calibration", () => {
    const small = deliver("short-poll", 1_000, 5, 1);
    const big = deliver("short-poll", 10_000, 5, 1);
    expect(big.requestsPerSec).toBeCloseTo(2000, 0);
    expect(big.requestsPerSec / small.requestsPerSec).toBeCloseTo(10, 5);
    const ws = deliver("websocket", 3_000, 5, 1);
    expect(ws.memoryMB).toBeCloseTo((3_000 * CALIBRATION.memoryPerConnectionKB.ws) / 1024, 5);
    expect(ws.requestsPerSec).toBe(0);
    // Short polling at 1,500 req/s matches the held-out CPU measurement within the calibration gate.
    const poll = deliver("short-poll", 7_500, 5, 1);
    const measured = CALIBRATION.validation.find((v) => v.what.includes("1,500"))!.measured;
    expect(Math.abs(poll.cpuPct - measured) / measured).toBeLessThan(0.25);
    // WebSocket memory at 3,000 connections matches the held-out measurement within the gate.
    const wsMeasured = CALIBRATION.validation.find((v) => v.what.startsWith("ws memory"))!.measured;
    expect(Math.abs(ws.memoryMB - wsMeasured) / wsMeasured).toBeLessThan(0.25);
    // Enough polling overloads one Node process.
    expect(deliver("short-poll", 200_000, 1, 1).overloaded).toBe(true);
  }, 20_000); // thousands of simulated connections: slow when the machine is busy

  it("pooling: a tiny pool queues; a connection per request fails past max_connections", () => {
    const pool = simOf("connection-pooling");
    const tiny = pool.run({ rate: 1500, pool: 2 });
    const roomy = pool.run({ rate: 1500, pool: 20 });
    expect(tiny.metrics[0]!.value).toBeGreaterThan(roomy.metrics[0]!.value * 3);
    const hot = pool.run({ rate: 4000, pool: 20 });
    expect(hot.metrics[3]!.value).toBeGreaterThan(1); // refused connections
  });

  it("cache: database load drops by the hit ratio", () => {
    const cache = simOf("cache-aside");
    const r = cache.run({ rate: 1000, hit: 90, db: 5 });
    expect(r.metrics[3]!.value).toBeGreaterThan(70);
    expect(r.metrics[3]!.value).toBeLessThan(130);
  });

  it("concurrency: sync CPU work hurts simple requests more than the thread pool does", () => {
    const c = simOf("concurrency-models");
    const blocking = c.run({ heavy: 5, cost: 100, model: "event-loop-blocking" });
    const pool = c.run({ heavy: 5, cost: 100, model: "thread-pool" });
    expect(blocking.metrics[0]!.value).toBeGreaterThan(pool.metrics[0]!.value * 3);
  });

  it("n+1: batching beats a query per item; an index beats a scan", () => {
    const n = simOf("n-plus-one");
    const loop = n.run({ items: 50, rows: 1_000_000, strategy: "n1-index" }).metrics[0]!.value;
    const batch = n.run({ items: 50, rows: 1_000_000, strategy: "one-index" }).metrics[0]!.value;
    const scan = n.run({ items: 50, rows: 1_000_000, strategy: "one-noindex" }).metrics[0]!.value;
    expect(loop).toBeGreaterThan(batch * 5);
    expect(scan).toBeGreaterThan(batch * 5);
  });

  it("load balancing: least connections has the best tail with heavy-tailed costs", () => {
    const lb = simOf("load-balancer");
    const r = lb.run({ servers: 4, algo: "least-connections", mix: "heavy-tail" });
    const chart = r.charts[0]!;
    if (chart.type !== "bars") throw new Error("expected bars");
    const least = chart.bars.find((b) => b.label === "Least connections")!.value;
    const rr = chart.bars.find((b) => b.label === "Round robin")!.value;
    expect(least).toBeLessThan(rr);
  });
});
