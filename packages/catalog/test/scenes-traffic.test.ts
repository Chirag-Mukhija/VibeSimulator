import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { rateLimitingScene } from "../src/scenes/rate-limiting.ts";
import { reverseProxyScene } from "../src/scenes/reverse-proxy.ts";
import { cdnScene } from "../src/scenes/cdn.ts";
import { apiGatewayScene } from "../src/scenes/api-gateway.ts";
import { horizontalScalingScene } from "../src/scenes/horizontal-scaling.ts";
import { trafficPages } from "../src/extra-pages/traffic.ts";
import { wordCount } from "../src/pages.ts";
import { CONCEPTS } from "../src/concepts.ts";

const SCENES: ConceptScene[] = [rateLimitingScene, reverseProxyScene, cdnScene, apiGatewayScene, horizontalScalingScene];

/** Runs a scene in 50 ms ticks and returns every frame. Seed 1 is what the page uses. */
function frames(scene: ConceptScene, params: SceneParams, seconds = 40, seed = 1): Frame[] {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  const out = [r.tick(0)];
  for (let t = 0; t < seconds * 1000; t += 50) out.push(r.tick(50));
  return out;
}
const last = (scene: ConceptScene, params: SceneParams, seconds = 40) => frames(scene, params, seconds).at(-1)!;

const text = (f: Frame, label: RegExp): string => {
  const c = f.counters.find((x) => label.test(x.label));
  if (!c) throw new Error(`no counter matching ${label}`);
  return c.value;
};
const num = (f: Frame, label: RegExp) => Number.parseFloat(text(f, label));
const words = (s: string) => s.trim().split(/\s+/).length;

/** Every combination of a scene's controls, every value of each count. */
function combos(scene: ConceptScene): SceneParams[] {
  let out: SceneParams[] = [{}];
  for (const c of scene.controls) {
    const values = c.type === "choice" ? c.options.map((o) => o.value) : c.type === "toggle" ? [false, true] : Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i);
    out = out.flatMap((p) => values.map((v) => ({ ...p, [c.id]: v })));
  }
  return out.map((p) => ({ ...scene.defaults, ...p }));
}

describe.each(SCENES.map((s) => [s.id, s] as const))("traffic scene: %s", (_id, scene) => {
  it("illustrates a known concept and follows the readability rules", () => {
    expect(CONCEPTS.some((c) => c.id === scene.id)).toBe(true);
    expect(scene.width).toBeLessThanOrEqual(780);
    expect(scene.height).toBeLessThanOrEqual(420);
    expect(scene.intro.length).toBeGreaterThan(60);
    expect(scene.controls.length).toBeGreaterThanOrEqual(2);
    expect(scene.controls.length).toBeLessThanOrEqual(4);
    expect(scene.tryThis.length).toBeGreaterThanOrEqual(2);
    expect(scene.tryThis.length).toBeLessThanOrEqual(4);
    for (const c of scene.controls) expect(scene.defaults[c.id], c.id).toBeDefined();
    for (const t of scene.tryThis) for (const k of Object.keys(t.params)) expect(scene.controls.some((c) => c.id === k), k).toBe(true);
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const ids = new Set(boxes.map((b) => b.id));
      for (const l of links) {
        expect(ids.has(l.from) && ids.has(l.to), l.id).toBe(true);
        if (l.label) expect(words(l.label), l.label).toBeLessThanOrEqual(2);
      }
      for (const b of boxes) {
        expect(b.w >= 140 && b.w <= 240 && b.h >= 70 && b.h <= 130, `${b.id} size`).toBe(true);
        expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= scene.width && b.y + b.h <= scene.height, `${b.id} on canvas`).toBe(true);
        expect(words(b.label), b.label).toBeLessThanOrEqual(3);
        if (b.detail) expect(b.detail.length, `${b.id} detail "${b.detail}"`).toBeLessThan(b.w / 7);
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

  it("runs 60 s for every setting, drawing only laid-out links and boxes, with short notes, labels and log lines", () => {
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const linkIds = new Set(links.map((l) => l.id));
      const width = new Map(boxes.map((b) => [b.id, b.w]));
      const r = scene.start(params, 3);
      let most = 0;
      let frame = r.tick(0);
      for (let t = 0; t < 60_000; t += 50) {
        frame = r.tick(50);
        most = Math.max(most, frame.tokens.length);
        for (const tok of frame.tokens) {
          expect(linkIds.has(tok.link), `${tok.link} in ${JSON.stringify(params)}`).toBe(true);
          if (tok.label) expect(tok.label.length, tok.label).toBeLessThanOrEqual(22);
        }
        for (const [id, st] of Object.entries(frame.boxes)) {
          expect(width.has(id), id).toBe(true);
          if (st.note) expect(st.note.length, `${id} note "${st.note}"`).toBeLessThan(width.get(id)! / 7);
        }
        for (const line of frame.log) expect(line.length, line).toBeLessThanOrEqual(140);
      }
      expect(most, JSON.stringify(params)).toBeLessThanOrEqual(24);
      expect(frame.counters.length).toBeGreaterThanOrEqual(3);
      expect(frame.counters.length).toBeLessThanOrEqual(4);
      expect(frame.log.length).toBeGreaterThan(0);
    }
  });

  it("replays the same way for the same seed", () => {
    expect(frames(scene, {}, 20, 5)).toEqual(frames(scene, {}, 20, 5));
  });
});

describe("rate limiting", () => {
  const most = (f: Frame) => Number.parseInt(text(f, /Most bot requests/), 10);

  it("by default the bot gets 429s, never more than 5 per 10 s, while Alice and Bob are never refused", () => {
    const fs = frames(rateLimitingScene, {});
    const f = fs.at(-1)!;
    expect(num(f, /Refused with 429/)).toBeGreaterThan(5);
    expect(most(f)).toBe(5);
    expect(num(f, /Alice and Bob refused/)).toBe(0);
    expect(fs.some((x) => x.tokens.some((t) => t.kind === "error" && /^429/.test(t.label ?? "")))).toBe(true);
    expect(fs.some((x) => x.log.some((l) => /429 Too Many Requests.*Retry-After: \d+ s/.test(l)))).toBe(true);
    // The counts per client live in Redis, which every request asks.
    expect(fs.some((x) => x.boxes.redis?.slots?.busy === 5)).toBe(true);
  });

  it("try: fixed windows let a burst before and one after a reset both pass, 10 within 10 s", () => {
    const f = last(rateLimitingScene, rateLimitingScene.tryThis[0]!.params);
    expect(most(f)).toBe(10);
  });

  it("try: counts in each app's memory let about twice the limit through", () => {
    const f = last(rateLimitingScene, rateLimitingScene.tryThis[1]!.params);
    expect(most(f)).toBeGreaterThanOrEqual(9);
    expect(most(f)).toBeLessThanOrEqual(12);
    expect(num(f, /Refused with 429/)).toBeLessThan(num(last(rateLimitingScene, {}), /Refused with 429/));
  });

  it("try: with the bot off nobody gets a 429", () => {
    const f = last(rateLimitingScene, rateLimitingScene.tryThis[2]!.params);
    expect(num(f, /Let through/)).toBeGreaterThan(10);
    expect(num(f, /Refused with 429/)).toBe(0);
  });
});

describe("reverse proxy", () => {
  const ofTotal = (f: Frame) => text(f, /reached the app/).split(" of ").map(Number) as [number, number];

  it("try (defaults): Nginx does TLS and static files, reuses its connections, and frees the app before the slow phone is done", () => {
    const fs = frames(reverseProxyScene, reverseProxyScene.tryThis[0]!.params);
    const f = fs.at(-1)!;
    const [atApp, sent] = ofTotal(f);
    expect(sent).toBeGreaterThan(20);
    expect(atApp).toBeLessThanOrEqual(Math.ceil(sent / 3)); // only page requests; files never reach it
    expect(num(f, /TLS handshakes done by the app/)).toBe(0);
    expect(num(f, /New connections to the app/)).toBeLessThanOrEqual(3);
    expect(num(f, /Longest the app spent/)).toBeLessThan(0.5);
    // Meanwhile Nginx really is feeding the phone at its own pace.
    expect(fs.some((x) => x.boxes.nginx?.note === "feeding the slow phone" && x.boxes.app?.note?.startsWith("idle"))).toBe(true);
  });

  it("try: straight to the app, it does every handshake, serves every file, and is tied to the slow phone", () => {
    const f = last(reverseProxyScene, reverseProxyScene.tryThis[1]!.params);
    const [atApp, sent] = ofTotal(f);
    expect(atApp).toBe(sent);
    expect(num(f, /TLS handshakes done by the app/)).toBeGreaterThan(5);
    expect(num(f, /New connections to the app/)).toBeGreaterThanOrEqual(num(f, /TLS handshakes/));
    expect(num(f, /Longest the app spent/)).toBeGreaterThanOrEqual(1.8);
  });

  it("try: without keep-alive Nginx opens a connection for every page it forwards", () => {
    const fs = frames(reverseProxyScene, reverseProxyScene.tryThis[2]!.params);
    const f = fs.at(-1)!;
    const [atApp] = ofTotal(f);
    expect(atApp).toBeGreaterThan(5);
    // Each forwarded page opened one connection (a page may still be on its way to the app).
    expect(num(f, /New connections to the app/)).toBeGreaterThanOrEqual(atApp);
    expect(num(f, /New connections to the app/)).toBeLessThanOrEqual(atApp + 1);
    expect(fs.some((x) => x.tokens.some((t) => t.link === "nginx-app" && t.kind === "handshake"))).toBe(true);
  });
});

describe("cdn", () => {
  it("by default the first request at each edge misses, and later ones are answered by the edge", () => {
    const fs = frames(cdnScene, {});
    const f = fs.at(-1)!;
    expect(num(f, /Answered by an edge/)).toBeGreaterThan(70);
    // At least one miss per file per edge, plus a few that missed while the first copy was on its way.
    expect(num(f, /reached the origin/)).toBeGreaterThanOrEqual(6);
    expect(num(f, /reached the origin/)).toBeLessThanOrEqual(12);
    expect(fs.some((x) => x.tokens.some((t) => t.link === "edgeAS-origin"))).toBe(true);
    expect(f.boxes.edgeEU?.slots?.busy).toBe(3);
  });

  it("try: without a CDN every request goes to the origin and takes several times longer", () => {
    const off = last(cdnScene, cdnScene.tryThis[0]!.params);
    const on = last(cdnScene, {});
    expect(text(off, /Answered by an edge/)).toBe("no CDN");
    expect(num(off, /reached the origin/)).toBeGreaterThan(40);
    expect(num(off, /Average time/)).toBeGreaterThan(3 * num(on, /Average time/));
  });

  it("try: deploying without a purge leaves the edges serving old copies", () => {
    const f = last(cdnScene, cdnScene.tryThis[1]!.params);
    expect(num(f, /Old versions served/)).toBeGreaterThan(10);
    expect(f.boxes.edgeEU?.tone).toBe("bad");
  });

  it("try: a purge stops old copies almost at once, at the price of misses", () => {
    const purge = last(cdnScene, cdnScene.tryThis[2]!.params);
    const wait = last(cdnScene, cdnScene.tryThis[1]!.params);
    expect(num(purge, /Old versions served/)).toBeLessThan(num(wait, /Old versions served/) / 4);
    expect(num(purge, /reached the origin/)).toBeGreaterThan(num(wait, /reached the origin/) + 4);
  });

  it("try: a 10 s expiry sends each edge back to the origin far more often", () => {
    const short = last(cdnScene, cdnScene.tryThis[3]!.params);
    const long = last(cdnScene, {});
    expect(num(short, /reached the origin/)).toBeGreaterThan(2 * num(long, /reached the origin/));
  });
});

describe("api gateway", () => {
  it("by default the gateway routes by path to all three services and refuses expired tokens itself", () => {
    const f = last(apiGatewayScene, {});
    expect(num(f, /Answered/)).toBeGreaterThan(15);
    expect(num(f, /Expired tokens refused/)).toBeGreaterThan(3);
    expect(num(f, /let through/)).toBe(0);
    // Every refusal happened at the gateway.
    expect(f.boxes.gateway?.note).toMatch(new RegExp(`, ${num(f, /Expired tokens refused/)} refused$`));
    for (const s of ["users", "orders", "payments"]) {
      const served = Number.parseInt(f.boxes[s]?.note ?? "", 10);
      const working = /working|checking/.test(f.boxes[s]?.note ?? "");
      expect(working || served > 0, s).toBe(true);
    }
  });

  it("try: calling services directly saves the gateway's hop, and each service refuses expired tokens itself", () => {
    const direct = last(apiGatewayScene, apiGatewayScene.tryThis[0]!.params);
    const gateway = last(apiGatewayScene, {});
    expect(num(direct, /Expired tokens refused/)).toBeGreaterThan(3);
    expect(num(direct, /Average time/)).toBeLessThan(num(gateway, /Average time/) - 0.5);
  });

  it("try: directly, a service without its own check answers expired tokens", () => {
    const f = last(apiGatewayScene, apiGatewayScene.tryThis[1]!.params);
    expect(num(f, /let through/)).toBeGreaterThan(0);
  });

  it("try: behind the gateway, the missing check lets nothing through", () => {
    const f = last(apiGatewayScene, apiGatewayScene.tryThis[2]!.params);
    expect(num(f, /let through/)).toBe(0);
    expect(num(f, /Expired tokens refused/)).toBeGreaterThan(3);
  });

  it("try: with the gateway down every request fails while the services sit idle", () => {
    const fs = frames(apiGatewayScene, apiGatewayScene.tryThis[3]!.params);
    const f = fs.at(-1)!;
    expect(num(f, /Answered/)).toBe(0);
    expect(num(f, /gateway unreachable/)).toBeGreaterThan(20);
    for (const x of fs) for (const s of ["users", "orders", "payments"]) expect(x.boxes[s]?.tone).toBe("idle");
  });
});

describe("horizontal scaling", () => {
  const rate = (f: Frame) => num(f, /Answered per second/);
  const peak = (fs: Frame[], label: RegExp) => Math.max(...fs.map((f) => num(f, label)));

  it("by default two instances share normal traffic without lines, and logins live in the database", () => {
    const fs = frames(horizontalScalingScene, {});
    expect(peak(fs, /Waiting for an instance/)).toBeLessThanOrEqual(3);
    expect(peak(fs, /Waiting for the database/)).toBe(0);
    expect(rate(fs.at(-1)!)).toBeGreaterThan(0.5);
    // Both instances do work.
    expect(fs.some((f) => f.boxes.i1?.tone === "ok") && fs.some((f) => f.boxes.i2?.tone === "ok")).toBe(true);
  });

  it("try: rush hour with 1 instance builds a long line in front of it", () => {
    const fs = frames(horizontalScalingScene, horizontalScalingScene.tryThis[0]!.params);
    expect(peak(fs, /Waiting for an instance/)).toBeGreaterThanOrEqual(10);
    expect(rate(fs.at(-1)!)).toBeLessThanOrEqual(1.1);
  });

  it("try: 3 instances give about three times the answers per second, with shorter lines", () => {
    const one = frames(horizontalScalingScene, horizontalScalingScene.tryThis[0]!.params);
    const three = frames(horizontalScalingScene, horizontalScalingScene.tryThis[1]!.params);
    const ratio = rate(three.at(-1)!) / rate(one.at(-1)!);
    expect(ratio).toBeGreaterThan(2.5);
    expect(ratio).toBeLessThan(3.4);
    expect(num(three.at(-1)!, /Waiting for an instance/)).toBeLessThan(num(one.at(-1)!, /Waiting for an instance/));
  });

  it("try: 4 instances barely beat 3, because the line moves to the database", () => {
    const three = frames(horizontalScalingScene, horizontalScalingScene.tryThis[1]!.params);
    const four = frames(horizontalScalingScene, horizontalScalingScene.tryThis[2]!.params);
    expect(rate(four.at(-1)!)).toBeLessThan(rate(three.at(-1)!) * 1.2);
    expect(peak(four, /Waiting for the database/)).toBeGreaterThanOrEqual(4);
    expect(peak(four, /Waiting for the database/)).toBeGreaterThan(peak(three, /Waiting for the database/));
    expect(four.at(-1)!.boxes.db?.slots?.busy).toBe(4);
  });

  it("try: logins in instance memory log users out on the other instance, never with just one", () => {
    const two = last(horizontalScalingScene, horizontalScalingScene.tryThis[3]!.params);
    const one = last(horizontalScalingScene, { instances: 1, memory: true });
    expect(num(two, /Logged out by surprise/)).toBeGreaterThan(5);
    expect(num(one, /Logged out by surprise/)).toBe(0);
  });
});

describe("traffic pages", () => {
  it("cover each traffic concept once, with a short page that fits the format", () => {
    expect(trafficPages.map((p) => p.concept).sort()).toEqual(["api-gateway", "cdn", "horizontal-scaling", "rate-limiting", "reverse-proxy"]);
    for (const p of trafficPages) {
      expect(CONCEPTS.some((c) => c.id === p.concept), p.concept).toBe(true);
      expect(SCENES.some((s) => s.id === p.concept), p.concept).toBe(true);
      expect(wordCount(p), p.concept).toBeLessThan(600);
      expect(p.how.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.how.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.breaks.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.breaks.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.sim, p.concept).toBeUndefined();
      expect(p.problem.split(/(?<=\.)\s/).length, p.concept).toBeLessThanOrEqual(3);
    }
  });
});
