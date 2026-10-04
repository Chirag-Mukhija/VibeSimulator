import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { deadLetterQueueScene } from "../src/scenes/dead-letter-queue.ts";
import { cronScene } from "../src/scenes/cron.ts";
import { webhooksScene } from "../src/scenes/webhooks.ts";
import { asyncPages } from "../src/extra-pages/async.ts";
import { wordCount } from "../src/pages.ts";
import { CONCEPTS } from "../src/concepts.ts";

const SCENES: ConceptScene[] = [deadLetterQueueScene, cronScene, webhooksScene];

/** Runs a scene with seed 1 (what the page uses) and returns every frame, one per 50 ms of scene time. */
function frames(scene: ConceptScene, params: SceneParams, seconds = 40, seed = 1): Frame[] {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  const out = [r.tick(0)];
  for (let t = 0; t < seconds * 1000; t += 50) out.push(r.tick(50));
  return out;
}
const at = (fs: Frame[], seconds: number) => fs[Math.round((seconds * 1000) / 50)]!;
const value = (f: Frame, label: RegExp) => f.counters.find((c) => label.test(c.label))?.value;
const num = (f: Frame, label: RegExp) => Number.parseFloat(value(f, label) ?? "NaN");
const note = (f: Frame, box: string) => f.boxes[box]?.note ?? "";
/** Every log line shown during a run, in order, without repeats. */
const logLines = (fs: Frame[]) => [...new Set(fs.flatMap((f) => f.log))];
const tryParams = (scene: ConceptScene, i: number) => ({ ...scene.defaults, ...scene.tryThis[i]!.params });

/** Every combination of a scene's controls (counts at their ends and middle), plus every tryThis. */
function combos(scene: ConceptScene): SceneParams[] {
  let out: SceneParams[] = [{}];
  for (const c of scene.controls) {
    const values = c.type === "choice" ? c.options.map((o) => o.value) : c.type === "toggle" ? [false, true] : [...new Set([c.min, Math.round((c.min + c.max) / 2), c.max])];
    out = out.flatMap((p) => values.map((v) => ({ ...p, [c.id]: v })));
  }
  return [...out, ...scene.tryThis.map((t) => t.params)].map((p) => ({ ...scene.defaults, ...p }));
}

describe.each(SCENES.map((s) => [s.id, s] as const))("async scenes: %s", (_id, scene) => {
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
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const ids = new Set(boxes.map((b) => b.id));
      expect(ids.size).toBe(boxes.length);
      for (const l of links) {
        expect(ids.has(l.from) && ids.has(l.to), l.id).toBe(true);
        if (l.label) expect(l.label.split(" ").length, l.id).toBeLessThanOrEqual(2);
      }
      for (const b of boxes) {
        expect(b.w >= 140 && b.w <= 240 && b.h >= 70 && b.h <= 130, `${b.id} size`).toBe(true);
        expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= scene.width && b.y + b.h <= scene.height, `${b.id} on canvas`).toBe(true);
        expect(b.label.split(" ").length, b.id).toBeLessThanOrEqual(3);
        expect((b.detail ?? "").length, `${b.id} detail "${b.detail}" fits`).toBeLessThan(b.w / 7);
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

  it("runs 60 s for every setting, drawing only laid-out links and boxes, with notes that fit and a modest number of envelopes", () => {
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const linkIds = new Set(links.map((l) => l.id));
      const width = new Map(boxes.map((b) => [b.id, b.w]));
      const r = scene.start(params, 3);
      let most = 0;
      let frame = r.tick(0);
      const lines = new Set<string>();
      for (let t = 0; t < 60_000; t += 50) {
        frame = r.tick(50);
        most = Math.max(most, frame.tokens.length);
        for (const tok of frame.tokens) expect(linkIds.has(tok.link), `${tok.link} in ${JSON.stringify(params)}`).toBe(true);
        for (const [id, st] of Object.entries(frame.boxes)) {
          expect(width.has(id), id).toBe(true);
          expect((st.note ?? "").length, `${id} note "${st.note}"`).toBeLessThan(width.get(id)! / 7);
        }
        for (const l of frame.log) lines.add(l);
      }
      expect(most, JSON.stringify(params)).toBeLessThanOrEqual(24);
      expect(frame.counters.length).toBeGreaterThanOrEqual(3);
      expect(frame.counters.length).toBeLessThanOrEqual(4);
      expect(lines.size).toBeGreaterThan(0);
      for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(140);
    }
  });

  it("replays the same way for the same seed", () => {
    expect(frames(scene, {}, 20, 5).at(-1)).toEqual(frames(scene, {}, 20, 5).at(-1));
  });
});

describe("dead-letter queue: behaviour", () => {
  const dlq = deadLetterQueueScene;
  const DLQ = /dead-letter queue/;
  const waitAt = (fs: Frame[], s: number) => num(at(fs, s), /Wait for a worker/);
  const retrying = (fs: Frame[], s: number) => num(at(fs, s), /still being retried/);

  it("defaults: jobs that fail 3 tries move to the DLQ and the line keeps moving", () => {
    const fs = frames(dlq, {});
    const end = fs.at(-1)!;
    expect(num(end, DLQ)).toBeGreaterThanOrEqual(3);
    expect(end.boxes.dlq!.queue).toBe(num(end, DLQ));
    // A job reaches the DLQ only after its third failed try.
    expect(logLines(fs).some((l) => /crashes on try 1 of 3/.test(l))).toBe(true);
    expect(logLines(fs).some((l) => /failed 3 tries, so it moves to the dead-letter queue/.test(l))).toBe(true);
    expect(Math.max(...fs.map((f) => num(f, /still being retried/)))).toBeLessThanOrEqual(3);
    expect(Math.max(...fs.slice(1).map((f) => Number.parseFloat(value(f, /Wait for a worker/)!) || 0))).toBeLessThan(1);
  });

  it("try 1: retried forever, broken jobs pile up and healthy jobs wait longer and longer", () => {
    const forever = frames(dlq, tryParams(dlq, 0));
    const healthy = frames(dlq, {});
    expect(retrying(forever, 40)).toBeGreaterThan(retrying(forever, 20));
    expect(retrying(forever, 20)).toBeGreaterThan(retrying(forever, 10));
    expect(waitAt(forever, 40)).toBeGreaterThan(waitAt(forever, 30));
    expect(waitAt(forever, 30)).toBeGreaterThan(waitAt(forever, 20));
    expect(waitAt(forever, 40)).toBeGreaterThan(2);
    expect(waitAt(forever, 40)).toBeGreaterThan(waitAt(healthy, 40) * 5);
    expect(forever.at(-1)!.boxes.queue!.queue).toBeGreaterThanOrEqual(4);
    expect(num(forever.at(-1)!, /Jobs done/)).toBeLessThan(num(healthy.at(-1)!, /Jobs done/));
    expect(forever.some((f) => (f.boxes.dlq?.queue ?? 0) > 0)).toBe(false);
  });

  it("try 2: deleted after 3 tries, workers stay free but the jobs leave no record", () => {
    const fs = frames(dlq, tryParams(dlq, 1));
    const end = fs.at(-1)!;
    expect(num(end, /Jobs deleted/)).toBeGreaterThanOrEqual(3);
    expect(waitAt(fs, 40)).toBeLessThan(1);
    expect(value(end, DLQ)).toBeUndefined();
    expect(fs.some((f) => f.tokens.some((t) => t.link === "w-dlq"))).toBe(false);
    expect(note(end, "dlq")).toBe("not used");
  });

  it("try 3: with the fix, the developer replays the DLQ and every replayed job completes", () => {
    const fs = frames(dlq, tryParams(dlq, 2));
    expect(num(at(fs, 19.9), DLQ)).toBeGreaterThanOrEqual(2);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "dlq-dev"))).toBe(true);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "dev-q"))).toBe(true);
    const end = fs.at(-1)!;
    expect(num(end, DLQ)).toBe(0);
    const m = /^(\d+) of (\d+) replays done$/.exec(note(end, "dlq"));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(Number(m![2]));
    expect(Number(m![2])).toBeGreaterThanOrEqual(2);
    expect(num(end, /still being retried/)).toBe(0);
  });

  it("try 4: with the fix but deleting, later orders succeed and nothing can be replayed", () => {
    const fs = frames(dlq, tryParams(dlq, 3));
    const dropped = num(fs.at(-1)!, /Jobs deleted/);
    expect(dropped).toBeGreaterThan(0);
    expect(num(at(fs, 24), /Jobs deleted/)).toBe(dropped); // no more deletions once the fix is live
    expect(num(fs.at(-1)!, /still being retried/)).toBe(0);
    expect(note(fs.at(-1)!, "dev")).toBe("fix live, nothing to replay");
    expect(fs.some((f) => f.tokens.some((t) => t.link === "dev-q"))).toBe(false);
  });
});

describe("cron: behaviour", () => {
  const cron = cronScene;
  const ticks = (f: Frame) => num(f, /Times the schedule fired/);
  const runs = (f: Frame) => num(f, /Job runs started/);
  const dups = (f: Frame) => num(f, /Duplicate runs/);
  const most = (f: Frame) => num(f, /Most runs at the same time/);

  it("defaults: every instance's timer fires, one takes the Redis lock and the job runs once per hour", () => {
    const fs = frames(cron, {});
    const end = fs.at(-1)!;
    expect(ticks(end)).toBeGreaterThanOrEqual(4);
    expect(runs(end)).toBe(ticks(end));
    expect(dups(end)).toBe(0);
    expect(most(end)).toBe(1);
    // All three instances ask Redis each hour; two are told the lock is taken.
    expect(fs.some((f) => f.tokens.filter((t) => /-redis$/.test(t.link) && t.kind === "request").length === 3)).toBe(true);
    expect(fs.some((f) => [1, 2, 3].filter((i) => /^skipped .*: lock taken$/.test(note(f, `i${i}`))).length === 2)).toBe(true);
    expect(note(end, "email")).not.toMatch(/duplicates/);
  });

  it("try 1: without the lock, all 3 instances run the job every hour", () => {
    const end = frames(cron, tryParams(cron, 0)).at(-1)!;
    expect(runs(end)).toBe(3 * ticks(end));
    expect(dups(end)).toBe(2 * ticks(end));
    const m = /^(\d+) batches, (\d+) duplicates$/.exec(note(end, "email"));
    expect(m).not.toBeNull();
    expect(Number(m![2]) * 3).toBe(Number(m![1]) * 2); // two of every three batches were already sent
  });

  it("try 2: one instance, no lock, a job longer than an hour: runs overlap", () => {
    const fs = frames(cron, tryParams(cron, 1));
    const end = fs.at(-1)!;
    expect(most(end)).toBe(2);
    expect(dups(end)).toBe(0);
    expect(runs(end)).toBe(ticks(end));
    expect(fs.some((f) => note(f, "i1") === "2 runs at once")).toBe(true);
  });

  it("try 3: with the lock, the long job makes the next hour skip; never two runs at once", () => {
    const fs = frames(cron, tryParams(cron, 2));
    const end = fs.at(-1)!;
    expect(most(end)).toBe(1);
    expect(dups(end)).toBe(0);
    expect(runs(end)).toBeLessThan(ticks(end));
    expect(runs(end)).toBeGreaterThanOrEqual(2);
    expect(logLines(fs).some((l) => /lock is still held by the .* run/.test(l))).toBe(true);
    // One instance is still on an hour's run while the other two have skipped the next hour.
    const nextHourSkipped = (f: Frame) => {
      const notes = [1, 2, 3].map((i) => note(f, `i${i}`));
      const run = notes.map((n) => /^(\d+):00 run: batch/.exec(n)).find(Boolean);
      const skips = notes.map((n) => /^skipped (\d+):00: lock taken$/.exec(n)).filter(Boolean);
      return !!run && skips.length === 2 && skips.every((s) => Number(s![1]) === Number(run[1]) + 1);
    };
    expect(fs.some(nextHourSkipped)).toBe(true);
  });
});

describe("webhooks: behaviour", () => {
  const wh = webhooksScene;
  const events = (f: Frame) => num(f, /^Events$/);
  const deliveries = (f: Frame) => num(f, /Deliveries/);
  const twice = (f: Frame) => num(f, /fulfilled more than once/);
  const letIn = (f: Frame) => num(f, /Forged events let in/);
  const fulfilments = (f: Frame) => Number(/^(\d+) (fulfilments|orders fulfilled)/.exec(note(f, "db"))?.[1] ?? NaN);

  it("defaults: a quick 200, retries when an answer is lost, and the worker skips the copies", () => {
    const fs = frames(wh, {});
    const end = fs.at(-1)!;
    expect(events(end)).toBeGreaterThanOrEqual(10);
    expect(deliveries(end)).toBeGreaterThan(events(end));
    expect(twice(end)).toBe(0);
    expect(fs.some((f) => /^skipped evt_\d+: seen$/.test(note(f, "workers")))).toBe(true);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "p-ep" && t.kind === "error"))).toBe(true);
    // Answers are quick: no try ever times out with the fast handler.
    expect(logLines(fs).some((l) => /No answer to/.test(l))).toBe(false);
    // The forged requests are rejected by the signature check.
    expect(letIn(end)).toBe(0);
    expect(note(end, "attacker")).toMatch(/^\d+ forger(y|ies) rejected$/);
    expect(fs.some((f) => f.tokens.some((t) => t.link === "a-ep" && t.kind === "error"))).toBe(true);
  });

  it("try 1: without the id check, a lost 200 makes the worker fulfil an order twice", () => {
    const end = frames(wh, tryParams(wh, 0)).at(-1)!;
    expect(twice(end)).toBeGreaterThanOrEqual(1);
    expect(deliveries(end)).toBeLessThan(events(end) * 1.5); // most events go through once
  });

  it("try 2: a slow handler times out on every event; the id check stops the copies", () => {
    const fs = frames(wh, tryParams(wh, 1));
    const end = fs.at(-1)!;
    expect(logLines(fs).some((l) => /No answer to evt_\d+ after/.test(l))).toBe(true);
    // Every event but the last one or two (whose retry isn't due yet) was delivered at least twice.
    expect(deliveries(end)).toBeGreaterThanOrEqual(2 * (events(end) - 2));
    expect(twice(end)).toBe(0);
    expect(logLines(fs).some((l) => /already recorded, so the handler skips the work/.test(l))).toBe(true);
  });

  it("try 3: slow and no id check, most orders are fulfilled more than once, some three or four times", () => {
    const end = frames(wh, tryParams(wh, 2)).at(-1)!;
    expect(twice(end)).toBeGreaterThanOrEqual(events(end) / 2);
    // An average above 2 per order, with at most 4 tries per event, means some got 3 or 4.
    expect(fulfilments(end)).toBeGreaterThan(2 * events(end));
  });

  it("try 4: without the signature check, forged events are fulfilled", () => {
    const fs = frames(wh, tryParams(wh, 3));
    expect(letIn(fs.at(-1)!)).toBeGreaterThanOrEqual(2);
    expect(logLines(fs).some((l) => /The forged fake_\d+ is fulfilled/.test(l))).toBe(true);
  });
});

describe("async pages", () => {
  it("covers exactly the three concepts, briefly", () => {
    expect(asyncPages.map((p) => p.concept).sort()).toEqual(["cron", "dead-letter-queue", "webhooks"]);
    for (const p of asyncPages) {
      expect(CONCEPTS.some((c) => c.id === p.concept), p.concept).toBe(true);
      expect(wordCount(p), p.concept).toBeLessThan(600);
      expect(p.how.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.how.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.breaks.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.breaks.length, p.concept).toBeLessThanOrEqual(4);
      const sentences = p.problem.split(/(?<=[.!?])\s+/).length;
      expect(sentences, p.concept).toBeGreaterThanOrEqual(2);
      expect(sentences, p.concept).toBeLessThanOrEqual(3);
      expect(p.sim).toBeUndefined();
    }
  });
});
