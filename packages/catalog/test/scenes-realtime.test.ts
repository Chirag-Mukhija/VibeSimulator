import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { shortPollingScene } from "../src/scenes/shortpolling.ts";
import { longPollingScene } from "../src/scenes/longpolling.ts";
import { sseScene } from "../src/scenes/sse.ts";
import { websocketScene } from "../src/scenes/websocket.ts";
import { CONCEPTS } from "../src/index.ts";

const SCENES: ConceptScene[] = [shortPollingScene, longPollingScene, sseScene, websocketScene];

/** Runs a scene for `seconds` of scene time in 50 ms ticks; `each` sees every frame. */
function run(scene: ConceptScene, params: SceneParams, seconds = 60, each?: (f: Frame) => void, seed = 1): Frame {
  const r = scene.start(params, seed);
  let f = r.tick(0);
  for (let t = 0; t < seconds * 1000; t += 50) {
    f = r.tick(50);
    each?.(f);
  }
  return f;
}

const counter = (f: Frame, label: string): string => {
  const c = f.counters.find((x) => x.label === label);
  if (!c) throw new Error(`no counter "${label}"`);
  return c.value;
};
const requests = (f: Frame) => Number(counter(f, "Requests sent"));
const empties = (f: Frame) => parseInt(counter(f, "Empty answers"), 10);
const answers = (f: Frame) => Number(counter(f, "Empty answers").split(" of ")[1] ?? 0);
const avgWait = (f: Frame) => parseFloat(counter(f, "Average wait until a tab sees news"));
const held = (f: Frame) => Number(counter(f, "Held open by the server"));
const newsCount = (f: Frame) => parseInt(f.boxes.news!.note!, 10);

describe.each(SCENES.map((s) => [s.id, s] as const))("%s scene", (_id, scene) => {
  const variants: SceneParams[] = [scene.defaults, ...scene.tryThis.map((t) => ({ ...scene.defaults, ...t.params })), { ...scene.defaults, tabs: 2 }, { ...scene.defaults, tabs: 4, news: "often" }];

  it("matches a full concept and fits the page", () => {
    expect(CONCEPTS.some((c) => c.id === scene.id)).toBe(true);
    expect(scene.width).toBeLessThanOrEqual(780);
    expect(scene.height).toBeLessThanOrEqual(420);
    expect(scene.controls.length).toBeGreaterThanOrEqual(2);
    expect(scene.controls.length).toBeLessThanOrEqual(4);
    expect(scene.tryThis.length).toBeGreaterThanOrEqual(2);
    expect(scene.tryThis.length).toBeLessThanOrEqual(4);
    for (const c of scene.controls) expect(scene.defaults[c.id], c.id).toBeDefined();
  });

  it.each(variants.map((v) => [JSON.stringify(v), v] as const))("lays out readable boxes for %s", (_k, params) => {
    const { boxes, links } = scene.layout(params);
    for (const b of boxes) {
      expect(b.w, b.id).toBeGreaterThanOrEqual(140);
      expect(b.w, b.id).toBeLessThanOrEqual(240);
      expect(b.h, b.id).toBeGreaterThanOrEqual(70);
      expect(b.h, b.id).toBeLessThanOrEqual(130);
      expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= scene.width && b.y + b.h <= scene.height, b.id).toBe(true);
    }
    for (const a of boxes) for (const b of boxes) {
      if (a === b) continue;
      const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
      expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
    }
    const byId = new Map(boxes.map((b) => [b.id, b]));
    for (const l of links) {
      const a = byId.get(l.from)!;
      const b = byId.get(l.to)!;
      expect(a && b, l.id).toBeTruthy();
      expect(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), `${l.id} is too short`).toBeGreaterThanOrEqual(70);
    }
  });

  it.each(variants.map((v) => [JSON.stringify(v), v] as const))("runs 60 s cleanly with %s", (_k, params) => {
    const { boxes, links } = scene.layout(params);
    const linkIds = new Set(links.map((l) => l.id));
    const boxIds = new Set(boxes.map((b) => b.id));
    let most = 0;
    const last = run(scene, params, 60, (f) => {
      for (const t of f.tokens) expect(linkIds.has(t.link), t.link).toBe(true);
      for (const k of Object.keys(f.boxes)) expect(boxIds.has(k), k).toBe(true);
      most = Math.max(most, f.tokens.length);
    });
    expect(most, "tokens on screen").toBeLessThanOrEqual(16);
    expect(last.counters.length).toBe(4);
    expect(last.log.length).toBeGreaterThan(0);
    expect(newsCount(last)).toBeGreaterThan(0);
  });

  it("is deterministic for a seed", () => {
    const a: Frame[] = [];
    const b: Frame[] = [];
    run(scene, scene.defaults, 20, (f) => a.push(f), 7);
    run(scene, scene.defaults, 20, (f) => b.push(f), 7);
    expect(b).toEqual(a);
  });
});

describe("realtime scenes show the mechanism", () => {
  const base = { news: "rare", tabs: 3 };

  it("all four pages get the same news at the same moments", () => {
    for (const news of ["rare", "often"]) {
      const counts = SCENES.map((s) => newsCount(run(s, { ...s.defaults, news })));
      expect(new Set(counts).size, news).toBe(1);
    }
  });

  it("short polling: the timer, not the news, decides how many requests are sent, and most answers are empty", () => {
    const rare = run(shortPollingScene, { ...base, interval: "1" });
    const often = run(shortPollingScene, { ...base, interval: "1" , news: "often" });
    expect(requests(often)).toBe(requests(rare));
    expect(requests(rare)).toBeGreaterThan(150); // 3 tabs, once a second, for 60 s
    expect(empties(rare) / answers(rare)).toBeGreaterThan(0.8);
    expect(held(rare)).toBe(0);
    // A longer interval: fewer requests, longer wait for news.
    const slow = run(shortPollingScene, { ...base, interval: "6" });
    expect(requests(slow)).toBeLessThan(requests(rare) / 4);
    expect(avgWait(slow)).toBeGreaterThan(avgWait(rare) + 1);
  });

  it("long polling sends far fewer requests than short polling for the same news, and the tab sees it sooner", () => {
    const short = run(shortPollingScene, { ...base, interval: "1" });
    const shortDefault = run(shortPollingScene, shortPollingScene.defaults);
    const long = run(longPollingScene, longPollingScene.defaults);
    expect(newsCount(long)).toBe(newsCount(short));
    expect(requests(long) * 4).toBeLessThan(requests(short));
    expect(requests(long)).toBeLessThan(requests(shortDefault));
    expect(empties(long) / answers(long)).toBeLessThan(0.5);
    expect(avgWait(long)).toBeLessThan(avgWait(shortDefault));
    expect(avgWait(long)).toBeLessThan(1);
  });

  it("long polling holds requests until news or the timeout, then asks again", () => {
    let mostHeld = 0;
    const short = run(longPollingScene, { ...base, timeout: "4" }, 60, (f) => (mostHeld = Math.max(mostHeld, held(f))));
    expect(mostHeld).toBe(3); // every tab's request parked at once
    expect(empties(short)).toBeGreaterThan(3); // timeouts with nothing new
    // Frequent news: requests follow the news instead of a timer.
    const rare = run(longPollingScene, longPollingScene.defaults);
    const often = run(longPollingScene, { ...longPollingScene.defaults, news: "often" });
    expect(requests(often)).toBeGreaterThan(requests(rare) * 2);
    expect(empties(often)).toBe(0);
  });

  it("SSE: one request per tab, then events flow down the open streams with no answers to wait for", () => {
    const f = run(sseScene, sseScene.defaults);
    expect(requests(f)).toBe(3);
    expect(empties(f)).toBe(0);
    expect(held(f)).toBe(3);
    expect(avgWait(f)).toBeCloseTo(0.4, 1); // one hop from server to tab
    // Every token on a tab's stream after it opens goes server -> tab.
    run(sseScene, { ...sseScene.defaults, news: "often" }, 30, (fr) => {
      for (const t of fr.tokens) if (t.link !== "news-srv" && t.kind === "push") expect(t.reverse).toBe(true);
    });
  });

  it("SSE: a dropped stream reconnects by itself and catches up with Last-Event-ID", () => {
    const logs = new Set<string>();
    let allOpen = false;
    let droppedAfterOpen = false;
    const f = run(sseScene, { ...sseScene.defaults, drops: true }, 60, (fr) => {
      fr.log.forEach((l) => logs.add(l));
      if (held(fr) === 3) allOpen = true;
      else if (allOpen) droppedAfterOpen = true;
    });
    expect(droppedAfterOpen).toBe(true);
    expect(requests(f)).toBeGreaterThan(3); // reconnects are new requests
    expect([...logs].some((l) => l.includes("Last-Event-ID") && l.includes("missed"))).toBe(true);
  });

  it("WebSocket: one upgrade per tab, and tabs send messages up the same connection without a request", () => {
    let up = 0;
    const f = run(websocketScene, websocketScene.defaults, 60, (fr) => {
      up += fr.tokens.filter((t) => t.link !== "news-srv" && t.kind === "push" && !t.reverse).length;
    });
    expect(requests(f)).toBe(3);
    expect(held(f)).toBe(3);
    expect(empties(f)).toBe(0);
    expect(up).toBeGreaterThan(0);
    expect(avgWait(f)).toBeCloseTo(0.4, 1);
    let upOff = 0;
    run(websocketScene, { ...websocketScene.defaults, typing: false }, 60, (fr) => {
      upOff += fr.tokens.filter((t) => t.link !== "news-srv" && t.kind === "push" && !t.reverse).length;
    });
    expect(upOff).toBe(0);
  });
});
