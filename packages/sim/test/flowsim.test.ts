import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeRepo } from "../../extractor/src/index.ts";
import { DEFAULT_LOAD, NO_CHANGES, simulateFlow } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = (name: string) => analyzeRepo(path.resolve(here, "../../../fixtures/repos", name), { now: new Date(0), includeSource: false });

describe("scale mode: each what-if moves metrics the way theory predicts", () => {
  const insta = repo("instabackend");
  const jobs = repo("job-scheduler");
  const next = repo("next-prisma-app");
  const pay = repo("paytmentgateway");

  it("more instances relieve a saturated thread pool (bcrypt at work factor 12)", () => {
    const load = { ...DEFAULT_LOAD, requestsPerSec: 25 };
    const one = simulateFlow(insta, "flow:route:POST:/api/auth/register", load, NO_CHANGES);
    const four = simulateFlow(insta, "flow:route:POST:/api/auth/register", load, { ...NO_CHANGES, instances: 4 });
    expect(one.bottleneck?.id).toBe("thread-pool");
    expect(four.p95).toBeLessThan(one.p95 / 3);
  });

  it("a cache takes load off the database", () => {
    const load = { ...DEFAULT_LOAD, requestsPerSec: 60, tableRows: 2_000_000 };
    const base = simulateFlow(jobs, "flow:route:GET:/stats", load, NO_CHANGES);
    const cached = simulateFlow(jobs, "flow:route:GET:/stats", load, { ...NO_CHANGES, cacheHitRatio: 0.95 });
    const cpu = (r: typeof base) => r.resources.find((x) => x.id.endsWith(":cpu"))!.utilization;
    expect(cpu(cached)).toBeLessThan(cpu(base) / 4);
    expect(cached.p95).toBeLessThan(base.p95);
  });

  it("a read replica takes reads off the primary", () => {
    const load = { ...DEFAULT_LOAD, requestsPerSec: 60, tableRows: 2_000_000 };
    const base = simulateFlow(jobs, "flow:route:GET:/stats", load, NO_CHANGES);
    const replica = simulateFlow(jobs, "flow:route:GET:/stats", load, { ...NO_CHANGES, readReplica: true });
    const primary = (r: typeof base) => r.resources.find((x) => x.id.endsWith(":cpu"))!.utilization;
    expect(primary(replica)).toBeLessThan(primary(base) / 4);
  });

  it("queueing a slow third-party call makes the request fast", () => {
    const load = { ...DEFAULT_LOAD, requestsPerSec: 20 };
    const base = simulateFlow(next, "flow:route:POST:/api/summarize", load, NO_CHANGES);
    const queued = simulateFlow(next, "flow:route:POST:/api/summarize", load, { ...NO_CHANGES, queueExternal: true });
    expect(base.p50).toBeGreaterThan(1000);
    expect(queued.p50).toBeLessThan(base.p50 / 10);
  });

  it("pushing instead of polling cuts requests per second", () => {
    const load = { ...DEFAULT_LOAD, users: 20_000, updatesPerSec: 2 };
    const flow = "flow:timer:api/public/dashboard.html:146";
    const poll = simulateFlow(jobs, flow, load, NO_CHANGES);
    const pushed = simulateFlow(jobs, flow, load, { ...NO_CHANGES, pushInsteadOfPoll: true });
    expect(poll.requestsPerSec).toBeCloseTo(4000, -1);
    expect(pushed.requestsPerSec).toBe(2);
    expect(pushed.notes.join(" ")).toContain("SSE");
  });

  it("batching the N+1 loop shortens the request", () => {
    const load = { ...DEFAULT_LOAD, requestsPerSec: 50, loopItems: 30 };
    const base = simulateFlow(next, "flow:route:POST:/api/posts", load, NO_CHANGES);
    const batched = simulateFlow(next, "flow:route:POST:/api/posts", load, { ...NO_CHANGES, batchLoops: true });
    expect(batched.p50).toBeLessThan(base.p50 / 2);
  });

  it("warns when instances times pool size exceeds max_connections", () => {
    const r = simulateFlow(pay, "flow:route:POST:/payments", { ...DEFAULT_LOAD, requestsPerSec: 100 }, { ...NO_CHANGES, instances: 8 });
    expect(r.notes.join(" ")).toContain("max_connections");
    expect(r.poolPerInstance).toBe(12);
  });

  it("past capacity, requests fail instead of finishing", () => {
    const r = simulateFlow(insta, "flow:route:POST:/api/auth/register", { ...DEFAULT_LOAD, requestsPerSec: 200 }, NO_CHANGES);
    expect(r.failedPct).toBeGreaterThan(10);
  });
});
