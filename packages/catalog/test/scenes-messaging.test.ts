import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { pubSubScene } from "../src/scenes/pubsub.ts";
import { messageQueueScene } from "../src/scenes/queue.ts";
import { cacheAsideScene } from "../src/scenes/cache.ts";
import { CONCEPTS } from "../src/concepts.ts";

const SCENES: ConceptScene[] = [pubSubScene, messageQueueScene, cacheAsideScene];

/** Runs a scene for `seconds` of scene time in 50 ms ticks and returns the last frame. */
function run(scene: ConceptScene, params: SceneParams, seconds = 60, seed = 7): Frame {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  let frame = r.tick(0);
  for (let t = 0; t < seconds * 1000; t += 50) frame = r.tick(50);
  return frame;
}

const counter = (f: Frame, label: RegExp) => Number.parseFloat(f.counters.find((c) => label.test(c.label))?.value ?? "NaN");

/** Every combination of a scene's controls (counts at their ends and middle). */
function combos(scene: ConceptScene): SceneParams[] {
  let out: SceneParams[] = [{}];
  for (const c of scene.controls) {
    const values = c.type === "choice" ? c.options.map((o) => o.value) : c.type === "toggle" ? [false, true] : [...new Set([c.min, Math.round((c.min + c.max) / 2), c.max])];
    out = out.flatMap((p) => values.map((v) => ({ ...p, [c.id]: v })));
  }
  return out.map((p) => ({ ...scene.defaults, ...p }));
}

describe.each(SCENES.map((s) => [s.id, s] as const))("messaging scenes: %s", (_id, scene) => {
  it("illustrates a known concept and follows the readability rules", () => {
    expect(CONCEPTS.some((c) => c.id === scene.id)).toBe(true);
    expect(scene.width).toBeLessThanOrEqual(780);
    expect(scene.height).toBeLessThanOrEqual(420);
    expect(scene.controls.length).toBeGreaterThanOrEqual(2);
    expect(scene.controls.length).toBeLessThanOrEqual(4);
    expect(scene.tryThis.length).toBeGreaterThanOrEqual(2);
    expect(scene.tryThis.length).toBeLessThanOrEqual(4);
    for (const c of scene.controls) expect(scene.defaults[c.id], c.id).toBeDefined();
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const ids = new Set(boxes.map((b) => b.id));
      for (const l of links) expect(ids.has(l.from) && ids.has(l.to), l.id).toBe(true);
      for (const b of boxes) {
        expect(b.w >= 140 && b.w <= 240 && b.h >= 70 && b.h <= 130, `${b.id} size`).toBe(true);
        expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= scene.width && b.y + b.h <= scene.height, `${b.id} on canvas`).toBe(true);
      }
      for (const a of boxes) for (const b of boxes) {
        if (a === b) continue;
        const sideBySide = a.y < b.y + b.h && b.y < a.y + a.h;
        if (sideBySide) expect(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), `${a.id} / ${b.id} gap`).toBeGreaterThanOrEqual(70);
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
      }
    }
  });

  it("runs 60 s for every setting, drawing only laid-out links and boxes, with a modest number of envelopes", () => {
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const linkIds = new Set(links.map((l) => l.id));
      const boxIds = new Set(boxes.map((b) => b.id));
      const r = scene.start(params, 3);
      let most = 0;
      let frame = r.tick(0);
      for (let t = 0; t < 60_000; t += 50) {
        frame = r.tick(50);
        most = Math.max(most, frame.tokens.length);
        for (const tok of frame.tokens) expect(linkIds.has(tok.link), `${tok.link} in ${JSON.stringify(params)}`).toBe(true);
        for (const id of Object.keys(frame.boxes)) expect(boxIds.has(id), id).toBe(true);
      }
      expect(most, JSON.stringify(params)).toBeLessThanOrEqual(24);
      expect(frame.counters.length).toBeGreaterThanOrEqual(3);
      expect(frame.counters.length).toBeLessThanOrEqual(4);
      expect(frame.log.length).toBeGreaterThan(0);
    }
  });

  it("replays the same way for the same seed", () => {
    const a = run(scene, {}, 20, 5);
    const b = run(scene, {}, 20, 5);
    expect(b).toEqual(a);
  });
});

describe("messaging scenes: behaviour", () => {
  const groups = (f: Frame) =>
    [1, 2, 3].map((i) => {
      const m = /got (\d+)(?:, missed (\d+))?/.exec(f.boxes[`u${i}`]?.note ?? "");
      return { got: Number(m?.[1] ?? NaN), missed: Number(m?.[2] ?? 0) };
    });

  it("pub/sub: every subscriber gets every message; without it only one instance's users do", () => {
    const shared = run(pubSubScene, { delivery: "redis", flaky: false, traffic: "many" });
    const sent = counter(shared, /Messages sent/);
    expect(sent).toBeGreaterThan(30);
    expect(counter(shared, /Missed/)).toBe(0);
    // One publish, three copies: one per subscribed instance.
    expect(counter(shared, /Copies Redis sent/)).toBeGreaterThanOrEqual(3 * (sent - 1));
    expect(counter(shared, /Copies Redis sent/)).toBeLessThanOrEqual(3 * sent);
    const g = groups(shared);
    for (const x of g) expect(Math.abs(x.got - g[0]!.got)).toBeLessThanOrEqual(1);

    const alone = run(pubSubScene, { delivery: "local", traffic: "many" });
    expect(counter(alone, /Copies Redis sent/)).toBe(0);
    expect(counter(alone, /Users reached/)).toBeLessThan(40); // about one in three
    expect(counter(alone, /Missed/)).toBeGreaterThan(0);
  });

  it("pub/sub: a disconnected subscriber misses messages, and they are not delivered later", () => {
    const f = run(pubSubScene, { delivery: "redis", flaky: true, traffic: "many" });
    const [api1, api2, api3] = groups(f);
    expect(api2!.missed).toBeGreaterThan(3);
    expect(api1!.missed).toBe(0);
    expect(api3!.missed).toBe(0);
    // API 2's users got fewer messages, short by what they missed: nothing is re-sent on reconnect.
    expect(api1!.got - api2!.got).toBeGreaterThanOrEqual(api2!.missed - 2);
  });

  it("message queue: with fewer workers than the job rate the queue grows; more workers keep it short", () => {
    const one = run(messageQueueScene, { queue: true, workers: 1, traffic: "busy" });
    const four = run(messageQueueScene, { queue: true, workers: 4, traffic: "busy" });
    expect(counter(one, /Jobs waiting/)).toBeGreaterThanOrEqual(20);
    expect(counter(four, /Jobs waiting/)).toBeLessThanOrEqual(5);
    expect(counter(four, /Emails sent/)).toBeGreaterThan(counter(one, /Emails sent/) * 2);
    // Users are answered just as fast either way: they never wait for the email.
    expect(counter(one, /Average response time/)).toBeLessThan(1.2);
    expect(counter(four, /Average response time/)).toBeLessThan(1.2);
  });

  it("message queue: without a queue the user waits for the slow work and sees its failures; with one, failures are retried", () => {
    const inline = run(messageQueueScene, { queue: false, traffic: "light" });
    const queued = run(messageQueueScene, { queue: true, workers: 2, traffic: "light" });
    expect(counter(inline, /Average response time/)).toBeGreaterThan(2);
    expect(counter(queued, /Average response time/)).toBeLessThan(counter(inline, /Average response time/) / 2);
    expect(counter(inline, /Errors shown to users/)).toBeGreaterThan(0);
    expect(counter(queued, /Retried after a failure/)).toBeGreaterThan(0);
    expect(queued.counters.some((c) => /Errors/.test(c.label))).toBe(false);
  });

  it("cache-aside: hits spare the database and make reads faster; reuse drives the hit ratio", () => {
    const on = run(cacheAsideScene, { cache: true, reuse: "often", expiry: "long" });
    const off = run(cacheAsideScene, { cache: false });
    expect(counter(on, /Hit ratio/)).toBeGreaterThan(60);
    expect(counter(on, /Database reads/)).toBeLessThan(counter(off, /Database reads/) / 2);
    expect(counter(on, /Average time/)).toBeLessThan(counter(off, /Average time/));
    const rarely = run(cacheAsideScene, { cache: true, reuse: "rarely", expiry: "long" });
    const short = run(cacheAsideScene, { cache: true, reuse: "often", expiry: "short" });
    expect(counter(rarely, /Hit ratio/)).toBeLessThan(counter(on, /Hit ratio/) - 25);
    expect(counter(short, /Hit ratio/)).toBeLessThan(counter(on, /Hit ratio/));
  });

  it("cache-aside: an edit to the database leaves the cached copy stale until it expires or is deleted", () => {
    const dbOnly = run(cacheAsideScene, { cache: true, reuse: "often", expiry: "long", edits: "db" }, 90);
    const cleared = run(cacheAsideScene, { cache: true, reuse: "often", expiry: "long", edits: "invalidate" }, 90);
    const none = run(cacheAsideScene, { cache: true, edits: "none" });
    expect(counter(dbOnly, /Stale answers/)).toBeGreaterThan(5);
    expect(counter(cleared, /Stale answers/)).toBeLessThan(counter(dbOnly, /Stale answers/) / 4);
    expect(none.counters.some((c) => /Stale/.test(c.label))).toBe(false);
  });
});
