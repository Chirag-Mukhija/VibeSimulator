import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { lifecycleScene } from "../src/scenes/lifecycle.ts";
import { nPlusOneScene } from "../src/scenes/nplusone.ts";
import { concurrencyScene } from "../src/scenes/concurrency.ts";
import { cacheAsideScene } from "../src/scenes/cache.ts";

/** Runs a scene and returns every frame, sampled each 50 ms of scene time. */
function frames(scene: ConceptScene, params: SceneParams, seconds = 60, seed = 7): Frame[] {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  const out = [r.tick(0)];
  for (let t = 0; t < seconds * 1000; t += 50) out.push(r.tick(50));
  return out;
}

const value = (f: Frame, label: RegExp) => f.counters.find((c) => label.test(c.label))?.value ?? "";
const seconds = (v: string) => Number.parseFloat(v);

describe("server concept scenes: behaviour", () => {
  it("lifecycle: keep-alive skips the handshakes after the first request; without it every request pays them", () => {
    const on = frames(lifecycleScene, { keepAlive: true }).at(-1)!;
    const off = frames(lifecycleScene, { keepAlive: false }).at(-1)!;
    expect(value(on, /Round trips before/)).toBe("0");
    expect(value(off, /Round trips before/)).toBe("2: TCP, TLS");
    // Real-world times: 20 ms round trips, so 40 ms of handshakes saved per request.
    expect(Number.parseInt(value(off, /Each later/)) - Number.parseInt(value(on, /Each later/))).toBe(40);
    const far = frames(lifecycleScene, { keepAlive: false, far: true }).at(-1)!;
    expect(Number.parseInt(value(far, /Each later/)) - Number.parseInt(value(off, /Each later/))).toBe(3 * (150 - 20));
  });

  it("n+1: one query per item makes N+1 queries; batching makes 2; a JOIN makes 1", () => {
    const most = (mode: string, items: number) => Math.max(...frames(nPlusOneScene, { mode, items }).map((f) => Number(value(f, /Queries for this page/)) || 0));
    expect(most("naive", 10)).toBe(11);
    expect(most("naive", 20)).toBe(21);
    expect(most("batched", 20)).toBe(2);
    expect(most("join", 20)).toBe(1);
    // The naive page takes longer, and grows with the list.
    const took = (mode: string, items: number) => seconds(value(frames(nPlusOneScene, { mode, items }).at(-1)!, /Page took/));
    expect(took("naive", 20)).toBeGreaterThan(took("naive", 5));
    expect(took("batched", 20)).toBeLessThan(took("naive", 20) / 3);
  });

  it("concurrency: a synchronous hash makes quick requests wait; the thread pool or more processes fix most of it", () => {
    const wait = (model: string, heavy: boolean, traffic = "busy") => seconds(value(frames(concurrencyScene, { model, heavy, traffic }, 90).at(-1)!, /Average wait, quick/));
    const ioOnly = wait("event-loop", false);
    const blocked = wait("event-loop", true);
    expect(ioOnly).toBeLessThan(0.3); // I/O waits don't hold the loop
    expect(blocked).toBeGreaterThan(ioOnly * 4);
    expect(wait("thread-pool", true)).toBeLessThan(blocked / 3);
    expect(wait("cluster", true)).toBeLessThan(blocked);
  });

  it("cache-aside: with the cache off, the 3 database slots sometimes make reads wait in line", () => {
    const fs = frames(cacheAsideScene, { cache: false }, 90);
    expect(fs.some((f) => (f.boxes.db?.queue ?? 0) > 0)).toBe(true);
    const on = seconds(value(frames(cacheAsideScene, { cache: true }, 90).at(-1)!, /Average time per read/));
    const off = seconds(value(fs.at(-1)!, /Average time per read/));
    expect(off).toBeGreaterThan(on);
  });
});
