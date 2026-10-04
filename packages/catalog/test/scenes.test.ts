import { describe, expect, it } from "vitest";
import { SCENES, sceneFor, type ConceptScene, type Frame, type SceneParams } from "../src/index.ts";
import { CONCEPTS } from "../src/concepts.ts";

/** Runs a scene for `seconds` of scene time and returns every frame's last state. */
function run(scene: ConceptScene, params: SceneParams, seconds = 60): Frame {
  const r = scene.start({ ...scene.defaults, ...params }, 7);
  let frame = r.tick(0);
  for (let t = 0; t < seconds * 1000; t += 50) frame = r.tick(50);
  return frame;
}

const counter = (f: Frame, label: RegExp) => Number(f.counters.find((c) => label.test(c.label))?.value ?? NaN);

describe("concept scenes: structure", () => {
  it.each(SCENES.map((s) => [s.id, s] as const))("%s draws only what it lays out", (_id, scene) => {
    expect(CONCEPTS.some((c) => c.id === scene.id)).toBe(true);
    for (const params of [scene.defaults, ...scene.tryThis.map((t) => ({ ...scene.defaults, ...t.params }))]) {
      const { boxes, links } = scene.layout(params);
      const linkIds = new Set(links.map((l) => l.id));
      const boxIds = new Set(boxes.map((b) => b.id));
      for (const l of links) expect(boxIds.has(l.from) && boxIds.has(l.to), l.id).toBe(true);
      // Boxes stay on the canvas and never overlap.
      for (const b of boxes) expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= scene.width && b.y + b.h <= scene.height, b.id).toBe(true);
      for (const a of boxes) for (const b of boxes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
      const r = scene.start(params, 3);
      for (let t = 0; t < 30_000; t += 50) {
        const f = r.tick(50);
        for (const tok of f.tokens) expect(linkIds.has(tok.link), tok.link).toBe(true);
        for (const id of Object.keys(f.boxes)) expect(boxIds.has(id), id).toBe(true);
      }
    }
  });

  it("every scene explains itself and offers experiments", () => {
    for (const s of SCENES) {
      expect(s.intro.length, s.id).toBeGreaterThan(60);
      expect(s.controls.length, s.id).toBeGreaterThanOrEqual(2);
      expect(s.controls.length, s.id).toBeLessThanOrEqual(4);
      expect(s.tryThis.length, s.id).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("concept scenes: behaviour", () => {
  it("load balancer: round robin keeps feeding a slow server; least connections routes around it", () => {
    const lb = sceneFor("load-balancer")!;
    const rr = run(lb, { algorithm: "round-robin", slow: true, traffic: "busy", servers: 3 });
    const lc = run(lb, { algorithm: "least-connections", slow: true, traffic: "busy", servers: 3 });
    const rrQueue = rr.boxes.s2!.queue ?? 0;
    const lcQueue = lc.boxes.s2!.queue ?? 0;
    expect(rrQueue).toBeGreaterThanOrEqual(4);
    expect(lcQueue).toBeLessThan(rrQueue);
    expect(counter(lc, /Answered/)).toBeGreaterThan(counter(rr, /Answered/));
  });

  it("pooling: without a pool busy traffic gets refused; a pool queues instead", () => {
    const pool = sceneFor("connection-pooling")!;
    const perRequest = run(pool, { mode: "per-request", traffic: "busy" });
    const pooled = run(pool, { mode: "pool", pool: 2, traffic: "busy" });
    expect(counter(perRequest, /Refused/)).toBeGreaterThan(0);
    expect(counter(pooled, /Refused/)).toBe(0);
    expect(counter(pooled, /Waiting for a connection/)).toBeGreaterThan(0);
    // Each request without a pool pays the handshake.
    expect(counter(run(pool, { mode: "per-request", traffic: "light" }), /Handshakes/)).toBeGreaterThan(10);
  });
});
