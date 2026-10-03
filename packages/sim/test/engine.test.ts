import { describe, expect, it } from "vitest";
import { Histogram, Resource, Sim } from "../src/index.ts";

/** Single queue, `servers` identical servers. Returns measured statistics. */
function queue(opts: { lambda: number; serviceMean: number; servers: number; deterministic?: boolean; customers: number; seed?: number }) {
  const sim = new Sim(opts.seed ?? 7);
  const res = new Resource(sim, opts.servers);
  const inSystem = new Histogram();
  const waits = new Histogram();
  let arrived = 0;
  let present = 0;
  let presentArea = 0;
  let last = 0;
  const track = (delta: number) => {
    presentArea += (sim.now - last) * present;
    last = sim.now;
    present += delta;
  };
  function* customer() {
    const start = sim.now;
    track(+1);
    yield res.acquire();
    waits.add(sim.now - start);
    yield sim.timeout(opts.deterministic ? opts.serviceMean : sim.rng.exp(opts.serviceMean));
    res.release();
    inSystem.add(sim.now - start);
    track(-1);
  }
  function* arrivals() {
    while (arrived < opts.customers) {
      yield sim.timeout(sim.rng.exp(1 / opts.lambda));
      arrived++;
      sim.spawn(customer());
    }
  }
  sim.spawn(arrivals());
  sim.run();
  track(0);
  return { W: inSystem.mean(), Wq: waits.mean(), L: presentArea / sim.now, utilization: res.utilization(), lambdaObserved: opts.customers / sim.now };
}

const close = (actual: number, expected: number, tolerance: number) =>
  expect(Math.abs(actual - expected) / expected, `${actual} vs ${expected}`).toBeLessThan(tolerance);

describe("engine vs queueing theory", () => {
  it("M/M/1 matches W = 1/(mu - lambda) and Little's law", () => {
    const r = queue({ lambda: 0.8, serviceMean: 1, servers: 1, customers: 300_000 });
    close(r.W, 5, 0.05); // 1 / (1 - 0.8)
    close(r.Wq, 4, 0.06); // rho / (mu - lambda)
    close(r.utilization, 0.8, 0.02);
    close(r.L, r.lambdaObserved * r.W, 0.02); // L = lambda * W
  });

  it("M/M/3 matches the Erlang C waiting time", () => {
    const lambda = 2.4;
    const c = 3;
    const a = lambda; // offered load with mu = 1
    let sum = 0;
    let term = 1;
    for (let k = 0; k < c; k++) {
      if (k > 0) term *= a / k;
      sum += term;
    }
    const last = (term * a) / c; // a^c / c!
    const rho = a / c;
    const erlangC = last / (1 - rho) / (sum + last / (1 - rho));
    const expectedWq = erlangC / (c - lambda);
    const r = queue({ lambda, serviceMean: 1, servers: c, customers: 300_000 });
    close(r.Wq, expectedWq, 0.08);
    close(r.utilization, rho, 0.02);
  });

  it("M/D/1 matches Pollaczek-Khinchine", () => {
    const r = queue({ lambda: 0.8, serviceMean: 1, servers: 1, deterministic: true, customers: 300_000 });
    close(r.Wq, 0.8 / (2 * 0.2), 0.06); // rho / (2 mu (1 - rho))
  });

  it("is deterministic for a seed", () => {
    const a = queue({ lambda: 0.5, serviceMean: 1, servers: 1, customers: 5_000, seed: 3 });
    const b = queue({ lambda: 0.5, serviceMean: 1, servers: 1, customers: 5_000, seed: 3 });
    expect(a).toEqual(b);
  });

  it("rejects work beyond a bounded queue", () => {
    const sim = new Sim(1);
    const res = new Resource(sim, 1, 2);
    const outcomes: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      sim.spawn((function* () {
        const ok = (yield res.acquire()) as boolean;
        outcomes.push(ok);
        if (ok) {
          yield sim.timeout(10);
          res.release();
        }
      })());
    }
    sim.run();
    expect(outcomes.filter((x) => !x)).toHaveLength(2);
    expect(res.rejected).toBe(2);
  });
});
