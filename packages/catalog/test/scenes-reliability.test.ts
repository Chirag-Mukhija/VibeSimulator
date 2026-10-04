import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { timeoutsScene } from "../src/scenes/timeouts.ts";
import { circuitBreakerScene } from "../src/scenes/circuit-breaker.ts";
import { retriesBackoffScene } from "../src/scenes/retries-backoff.ts";
import { idempotencyScene } from "../src/scenes/idempotency.ts";
import { backpressureScene } from "../src/scenes/backpressure.ts";
import { reliabilityPages } from "../src/extra-pages/reliability.ts";
import { wordCount } from "../src/pages.ts";
import { CONCEPTS } from "../src/concepts.ts";

const SCENES: ConceptScene[] = [timeoutsScene, circuitBreakerScene, retriesBackoffScene, idempotencyScene, backpressureScene];

/** Every frame of a run, one per 50 ms of scene time. Seed 1 is what the page uses. */
function frames(scene: ConceptScene, params: SceneParams, seconds = 40, seed = 1): Frame[] {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  const out = [r.tick(0)];
  for (let t = 0; t < seconds * 1000; t += 50) out.push(r.tick(50));
  return out;
}

/** The settings a tryThis applies, on top of the defaults (as the page does). */
const tryParams = (scene: ConceptScene, i: number): SceneParams => ({ ...scene.defaults, ...scene.tryThis[i]!.params });

const num = (f: Frame, label: RegExp) => {
  const c = f.counters.find((x) => label.test(x.label));
  if (!c) throw new Error(`no counter ${label}`);
  return Number.parseFloat(c.value);
};
const most = (fs: Frame[], label: RegExp) => Math.max(...fs.map((f) => num(f, label)));
const last = (fs: Frame[]) => fs.at(-1)!;
const logged = (fs: Frame[], text: RegExp) => fs.some((f) => f.log.some((l) => text.test(l)));
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Every combination of a scene's controls (counts at their ends and middle). */
function combos(scene: ConceptScene): SceneParams[] {
  let out: SceneParams[] = [{}];
  for (const c of scene.controls) {
    const values = c.type === "choice" ? c.options.map((o) => o.value) : c.type === "toggle" ? [false, true] : [...new Set([c.min, Math.round((c.min + c.max) / 2), c.max])];
    out = out.flatMap((p) => values.map((v) => ({ ...p, [c.id]: v })));
  }
  return out.map((p) => ({ ...scene.defaults, ...p }));
}

describe.each(SCENES.map((s) => [s.id, s] as const))("reliability scenes: %s", (_id, scene) => {
  it("illustrates a known concept and follows the readability rules", () => {
    expect(CONCEPTS.some((c) => c.id === scene.id)).toBe(true);
    expect(scene.intro.length).toBeGreaterThan(60);
    expect(scene.width).toBeLessThanOrEqual(780);
    expect(scene.height).toBeLessThanOrEqual(420);
    expect(scene.controls.length).toBeGreaterThanOrEqual(2);
    expect(scene.controls.length).toBeLessThanOrEqual(4);
    expect(scene.tryThis.length).toBeGreaterThanOrEqual(2);
    expect(scene.tryThis.length).toBeLessThanOrEqual(4);
    for (const c of scene.controls) expect(scene.defaults[c.id], c.id).toBeDefined();
    const settings = [...combos(scene), ...scene.tryThis.map((_, i) => tryParams(scene, i))];
    for (const params of settings) {
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

  it("runs 60 s for every setting, drawing only laid-out links and boxes, with short notes and labels and a modest number of envelopes", () => {
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const linkIds = new Set(links.map((l) => l.id));
      const width = new Map(boxes.map((b) => [b.id, b.w]));
      const r = scene.start(params, 3);
      let busiest = 0;
      let frame = r.tick(0);
      for (let t = 0; t < 60_000; t += 50) {
        frame = r.tick(50);
        busiest = Math.max(busiest, frame.tokens.length);
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
      expect(busiest, JSON.stringify(params)).toBeLessThanOrEqual(24);
      expect(frame.counters.length).toBeGreaterThanOrEqual(3);
      expect(frame.counters.length).toBeLessThanOrEqual(4);
      expect(frame.log.length).toBeGreaterThan(0);
    }
  });

  it("replays the same way for the same seed", () => {
    expect(last(frames(scene, {}, 20, 5))).toEqual(last(frames(scene, {}, 20, 5)));
  });
});

describe("timeouts", () => {
  const s = timeoutsScene;
  const hungAll = /^4 of 4 held by hung calls/;

  it("by default a generous timeout cuts off calls that never answer, frees the connection, and the app keeps serving", () => {
    const fs = frames(s, {});
    expect(num(last(fs), /Timed out, got a 504/)).toBeGreaterThan(2);
    expect(num(last(fs), /Healthy calls cut off/)).toBe(0);
    expect(num(last(fs), /Answered with API data/)).toBeGreaterThan(25);
    expect(most(fs, /Longest wait right now/)).toBeLessThan(6);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "u-app" && t.reverse && t.kind === "error"))).toBe(true);
  });

  it("tryThis 1: with no timeout, hung calls hold all 4 connections and everything else waits, though the API answers most calls", () => {
    const fs = frames(s, tryParams(s, 0));
    expect(fs.some((f) => hungAll.test(f.boxes.app?.note ?? "") && (f.boxes.app?.queue ?? 0) >= 5)).toBe(true);
    expect(num(last(fs), /Longest wait right now/)).toBeGreaterThan(15);
    // Nothing moves once they are all held.
    expect(num(last(fs), /Answered/)).toBe(num(fs[30 * 20]!, /Answered/));
    const answered = num(last(fs), /Answered/);
    const stuck = num(last(fs), /Calls stuck/);
    expect(answered / (answered + stuck)).toBeGreaterThan(0.6);
  });

  it("tryThis 2: a tight timeout cuts hung calls sooner but also fails healthy slow calls", () => {
    const tight = frames(s, tryParams(s, 1));
    const generous = frames(s, {});
    expect(num(last(tight), /Healthy calls cut off/)).toBeGreaterThan(2);
    expect(num(last(generous), /Healthy calls cut off/)).toBe(0);
    expect(most(tight, /Longest wait right now/)).toBeLessThan(most(generous, /Longest wait right now/));
  });

  it("tryThis 3: with a fallback, timed-out users get an answer instead of a 504", () => {
    const fs = frames(s, tryParams(s, 2));
    expect(num(last(fs), /Timed out, got the fallback/)).toBeGreaterThan(2);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "u-app" && t.kind === "error"))).toBe(false);
  });

  it("tryThis 4: with an API that always answers, no timeout is needed and everything flows", () => {
    const fs = frames(s, tryParams(s, 3));
    expect(num(last(fs), /Calls stuck/)).toBe(0);
    expect(num(last(fs), /Answered/)).toBeGreaterThan(35);
    expect(Math.max(...fs.map((f) => f.boxes.app?.queue ?? 0))).toBeLessThanOrEqual(3);
    expect(most(fs, /Longest wait right now/)).toBeLessThan(4);
  });
});

describe("circuit breaker", () => {
  const s = circuitBreakerScene;
  /** The breaker's states in order, read from its box. */
  const states = (fs: Frame[]) => {
    const seq: string[] = [];
    for (const f of fs) {
      const st = f.boxes.breaker?.note?.split(":")[0];
      if (st && seq.at(-1) !== st) seq.push(st);
    }
    return seq;
  };
  const failedTrials = (fs: Frame[]) => states(fs).filter((st, i, all) => st === "Half-open" && all[i + 1] === "Open").length;

  it("tryThis 1: closed, open after 3 failures, half-open with one trial, open again on a failed trial, closed on a successful one", () => {
    const fs = frames(s, tryParams(s, 0));
    expect(states(fs.slice(0, 20 * 20)).join(" > ")).toBe("Closed > Open > Half-open > Closed");
    expect(failedTrials(fs)).toBeGreaterThanOrEqual(1);
    expect(num(last(fs), /Errors at once/)).toBeGreaterThan(5);
    // While open, nothing new is sent to the service.
    for (const f of fs) {
      if (!f.boxes.breaker?.note?.startsWith("Open")) continue;
      expect(f.tokens.some((t) => t.link === "br-svc" && !t.reverse && t.t < 0.1)).toBe(false);
    }
    // Half-open lets exactly one trial out at a time.
    for (const f of fs) {
      if (!f.boxes.breaker?.note?.startsWith("Half-open")) continue;
      expect(f.tokens.filter((t) => t.link === "br-svc" && !t.reverse && t.label?.endsWith("trial")).length).toBeLessThanOrEqual(1);
    }
  });

  it("tryThis 2: without a breaker, every request during the outage waits for the timeout", () => {
    const off = last(frames(s, tryParams(s, 1)));
    const on = last(frames(s, {}));
    expect(num(off, /Errors after waiting/)).toBeGreaterThan(num(on, /Errors after waiting/) * 1.5);
    expect(num(off, /Errors at once/)).toBe(0);
  });

  it("tryThis 3: a 10 s wait sends fewer trials into the long outage but turns away more requests after the short one", () => {
    const ten = frames(s, tryParams(s, 2));
    const five = frames(s, {});
    expect(failedTrials(ten)).toBeLessThan(failedTrials(five));
    expect(num(last(ten), /Turned away/)).toBeGreaterThan(num(last(five), /Turned away/));
    // The turning away happens after the short outage (over at 12 s), before the long one (24 s).
    expect(num(ten[24 * 20]!, /Turned away/)).toBeGreaterThanOrEqual(5);
  });

  it("tryThis 4: a 2 s wait closes soon after the short outage, but more trials land in the long one and wait out the timeout", () => {
    const two = frames(s, tryParams(s, 3));
    const five = frames(s, {});
    const closedAt = two.findIndex((f, i) => i > 12 * 20 && f.boxes.breaker?.note?.startsWith("Closed"));
    expect((closedAt - 12 * 20) * 50).toBeLessThanOrEqual(3000);
    expect(failedTrials(two)).toBeGreaterThan(failedTrials(five));
    expect(num(last(two), /Errors after waiting/)).toBeGreaterThan(num(last(five), /Errors after waiting/));
    expect(num(last(two), /Turned away/)).toBeLessThan(num(last(five), /Turned away/));
  });
});

describe("retries with backoff", () => {
  const s = retriesBackoffScene;
  const failed = /Failed|Gave up/;

  it("by default backoff with jitter lets requests outlast a short outage: retries happen and none give up", () => {
    const fs = frames(s, {});
    expect(num(last(fs), /Retries sent/)).toBeGreaterThan(10);
    expect(num(last(fs), failed)).toBe(0);
    expect(logged(fs, /succeeds on try \d/)).toBe(true);
    expect(most(fs, /Requests per second/)).toBeLessThan(4 * 3);
  });

  it("the intro's rate holds: about 3 new requests per second in all", () => {
    const off = last(frames(s, { retries: "off" }));
    const started = num(off, /Succeeded/) + num(off, /Failed/);
    expect(started / 40).toBeGreaterThan(2.5);
    expect(started / 40).toBeLessThan(3.5);
  });

  it("tryThis 1: with retries off, requests that hit the outage fail", () => {
    const off = last(frames(s, tryParams(s, 0)));
    expect(num(off, /Failed \(not retried\)/)).toBeGreaterThan(8);
    expect(num(off, /Retries sent/)).toBe(0);
    expect(num(off, failed)).toBeGreaterThan(num(last(frames(s, {})), failed) + 8);
  });

  it("tryThis 2: immediate retries multiply the load and burn their tries inside the outage", () => {
    const now = frames(s, tryParams(s, 1));
    const backoff = frames(s, {});
    expect(most(now, /Requests per second/)).toBeGreaterThanOrEqual(3 * 3);
    expect(most(now, /Requests per second/)).toBeGreaterThan(most(backoff, /Requests per second/));
    expect(num(last(now), failed)).toBeGreaterThanOrEqual(5);
    expect(num(last(now), failed)).toBeGreaterThan(num(last(backoff), failed) + 4);
    expect(logged(now, /every try landed inside the outage/)).toBe(true);
  });

  it("tryThis 3: only 2 tries with backoff makes many more requests give up", () => {
    expect(num(last(frames(s, tryParams(s, 2))), failed)).toBeGreaterThanOrEqual(num(last(frames(s, {})), failed) + 5);
  });

  it("tryThis 4: a 20 s outage outlasts the tries even with backoff", () => {
    const long = last(frames(s, tryParams(s, 3)));
    expect(num(long, failed)).toBeGreaterThan(10);
    expect(num(long, failed)).toBeGreaterThan(num(last(frames(s, {})), failed));
  });
});

describe("idempotency", () => {
  const s = idempotencyScene;
  const resent = (f: Frame) => Number(/(\d+) resent/.exec(f.boxes.page?.note ?? "")?.[1] ?? NaN);

  it("by default lost responses are resent with the same key and caught: one charge per customer", () => {
    const fs = frames(s, {});
    const f = last(fs);
    expect(resent(f)).toBeGreaterThan(0);
    expect(num(f, /Repeats caught by the key/)).toBeGreaterThan(0);
    expect(num(f, /charged more than once/)).toBe(0);
    expect(num(f, /Charges made/)).toBeLessThanOrEqual(num(f, /Checkouts/));
    // A lost response is drawn only up to the middle of the link.
    for (const fr of fs) for (const t of fr.tokens) if (t.label?.endsWith("(lost)")) expect(t.t).toBeLessThanOrEqual(0.5);
    expect(fs.some((fr) => fr.tokens.some((t) => t.label?.endsWith("(lost)")))).toBe(true);
  });

  it("tryThis 1: without a key, a resend after a lost response charges the customer again", () => {
    const f = last(frames(s, tryParams(s, 0)));
    expect(num(f, /charged more than once/)).toBeGreaterThan(0);
    expect(num(f, /Charges made/)).toBeGreaterThan(num(f, /Checkouts/));
  });

  it("tryThis 2: a key checked in code lets two copies at the same moment both charge", () => {
    const fs = frames(s, tryParams(s, 1));
    expect(num(last(fs), /charged more than once/)).toBeGreaterThan(0);
    expect(logged(fs, /Both copies of #\d+ looked up key/)).toBe(true);
  });

  it("tryThis 3: a UNIQUE key column stops the second copy with 409 Conflict, one charge each", () => {
    const fs = frames(s, tryParams(s, 2));
    expect(num(last(fs), /charged more than once/)).toBe(0);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "page-api" && t.reverse && t.label === "409"))).toBe(true);
    expect(logged(fs, /409 Conflict/)).toBe(true);
  });

  it("tryThis 4: with no key and no lost responses nothing is resent and nobody is charged twice", () => {
    const f = last(frames(s, tryParams(s, 3)));
    expect(num(f, /Payments sent again/)).toBe(0);
    expect(num(f, /charged more than once/)).toBe(0);
  });
});

describe("backpressure", () => {
  const s = backpressureScene;
  const held = (fs: Frame[]) => fs.filter((f) => /waiting for room/.test(f.boxes.users?.note ?? "")).length / fs.length;
  const longestQueue = (fs: Frame[]) => most(fs, /Jobs in the queue/);

  it("by default a full queue makes the API wait: the queue never passes 8 and users wait for room", () => {
    const fs = frames(s, {});
    expect(longestQueue(fs)).toBe(8);
    expect(held(fs)).toBeGreaterThan(0.2);
    expect(most(fs, /Oldest job has waited/)).toBeLessThan(10);
  });

  it("tryThis 1: with no limit the queue, its memory and the oldest job's wait keep growing, but no more jobs get done", () => {
    const fs = frames(s, tryParams(s, 0));
    const f = last(fs);
    expect(num(f, /Jobs in the queue/)).toBeGreaterThan(20);
    expect(num(f, /Memory held/)).toBeGreaterThan(40);
    expect(num(f, /Oldest job has waited/)).toBeGreaterThan(15);
    expect(num(f, /Oldest job has waited/)).toBeGreaterThan(num(fs[20 * 20]!, /Oldest job has waited/));
    const bounded = num(last(frames(s, {})), /Jobs done/);
    expect(Math.abs(num(f, /Jobs done/) - bounded)).toBeLessThanOrEqual(bounded * 0.15);
  });

  it("tryThis 2: refusing with 503 keeps the queue at 8 or fewer, and refused users retry", () => {
    const fs = frames(s, tryParams(s, 1));
    expect(longestQueue(fs)).toBeLessThanOrEqual(8);
    expect(Number(/(\d+) refused/.exec(last(fs).boxes.api?.note ?? "")?.[1])).toBeGreaterThan(5);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "u-api" && t.kind === "error" && t.label === "503"))).toBe(true);
    expect(fs.some((f) => /retrying in 2 s/.test(f.boxes.users?.note ?? ""))).toBe(true);
  });

  it("tryThis 3: with 4 workers the queue rarely fills and users rarely wait for room", () => {
    expect(held(frames(s, tryParams(s, 2)))).toBeLessThan(held(frames(s, {})) / 4);
  });

  it("tryThis 4: one worker with the limit: the queue stays capped, users wait much of the time, and fewer jobs get done", () => {
    const one = frames(s, tryParams(s, 3));
    expect(longestQueue(one)).toBeLessThanOrEqual(8);
    expect(held(one)).toBeGreaterThan(0.5);
    expect(num(last(one), /Jobs done/)).toBeLessThan(num(last(frames(s, {})), /Jobs done/) * 0.7);
  });
});

describe("reliability pages", () => {
  it("covers the five concepts with short, complete pages", () => {
    expect(reliabilityPages.map((p) => p.concept).sort()).toEqual(SCENES.map((s) => s.id).sort());
    for (const p of reliabilityPages) {
      expect(CONCEPTS.some((c) => c.id === p.concept), p.concept).toBe(true);
      expect(wordCount(p), p.concept).toBeLessThan(600);
      expect(p.how.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.how.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.breaks.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.breaks.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.sim, p.concept).toBeUndefined();
      expect(words(p.problem), p.concept).toBeGreaterThan(20);
    }
  });
});
