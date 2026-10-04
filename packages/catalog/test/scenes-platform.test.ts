import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { sessionsJwtScene } from "../src/scenes/sessions-jwt.ts";
import { presignedUploadsScene } from "../src/scenes/presigned-uploads.ts";
import { serverActionsScene } from "../src/scenes/server-actions.ts";
import { threadPoolScene } from "../src/scenes/thread-pool.ts";
import { platformPages } from "../src/extra-pages/platform.ts";
import { wordCount } from "../src/pages.ts";
import { CONCEPTS } from "../src/concepts.ts";

const SCENES: ConceptScene[] = [sessionsJwtScene, presignedUploadsScene, serverActionsScene, threadPoolScene];

/** Runs a scene with seed 1 (what the page uses) and returns every frame, one per 50 ms of scene time. */
function frames(scene: ConceptScene, params: SceneParams, seconds = 40, seed = 1): Frame[] {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  const out = [r.tick(0)];
  for (let t = 0; t < seconds * 1000; t += 50) out.push(r.tick(50));
  return out;
}
const timeOf = (i: number) => i * 50; // ms of scene time at frame i
const value = (f: Frame, label: RegExp) => f.counters.find((c) => label.test(c.label))?.value;
const num = (f: Frame, label: RegExp) => Number.parseFloat(value(f, label) ?? "NaN");
const note = (f: Frame, box: string) => f.boxes[box]?.note ?? "";
/** Every log line shown during a run, in order, without repeats. */
const logLines = (fs: Frame[]) => [...new Set(fs.flatMap((f) => f.log))];
/** The first frame whose log shows a line matching `re`. */
const firstLog = (fs: Frame[], re: RegExp) => fs.findIndex((f) => f.log.some((l) => re.test(l)));
const tryParams = (scene: ConceptScene, i: number) => scene.tryThis[i]!.params;
const tokensOn = (fs: Frame[], link: string) => fs.reduce((n, f) => n + f.tokens.filter((t) => t.link === link).length, 0);

/** Every combination of a scene's controls (counts at their ends and middle), plus every tryThis. */
function combos(scene: ConceptScene): SceneParams[] {
  let out: SceneParams[] = [{}];
  for (const c of scene.controls) {
    const values = c.type === "choice" ? c.options.map((o) => o.value) : c.type === "toggle" ? [false, true] : [...new Set([c.min, Math.round((c.min + c.max) / 2), c.max])];
    out = out.flatMap((p) => values.map((v) => ({ ...p, [c.id]: v })));
  }
  return [...out, ...scene.tryThis.map((t) => t.params)].map((p) => ({ ...scene.defaults, ...p }));
}

describe.each(SCENES.map((s) => [s.id, s] as const))("platform scenes: %s", (_id, scene) => {
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

  it("runs 60 s for every setting, drawing only laid-out links and boxes, with notes and labels that fit and a modest number of envelopes", () => {
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
        for (const tok of frame.tokens) {
          expect(linkIds.has(tok.link), `${tok.link} in ${JSON.stringify(params)}`).toBe(true);
          expect((tok.label ?? "").length, `token label "${tok.label}"`).toBeLessThanOrEqual(22);
        }
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

describe("sessions and JWTs: behaviour", () => {
  const s = sessionsJwtScene;
  const TRIPS = /Redis trips per request/;
  const AFTER = /accepted after logout/;
  const REJECTED = /Rejected with 401/;
  const logoutFrame = (fs: Frame[]) => firstLog(fs, /^Ann logs out/);

  it("defaults: a session costs a Redis trip per request, and logout stops a copied cookie at once", () => {
    const fs = frames(s, {});
    const end = fs.at(-1)!;
    expect(num(end, TRIPS)).toBeGreaterThanOrEqual(1);
    expect(tokensOn(fs, "app-redis")).toBeGreaterThan(200);
    // Before logout the copied cookie works; Ann logs out after about 10 s.
    const out = logoutFrame(fs);
    expect(timeOf(out)).toBeGreaterThanOrEqual(10_000);
    expect(timeOf(out)).toBeLessThan(13_500);
    expect(fs.slice(0, out).some((f) => note(f, "attacker").startsWith("copy accepted"))).toBe(true);
    // The attacker's next request after the logout is refused.
    const refused = fs.findIndex((f, i) => i > out && note(f, "attacker").startsWith("copy rejected"));
    expect(refused).toBeGreaterThan(0);
    expect(timeOf(refused) - timeOf(out)).toBeLessThan(5000);
    expect(num(end, AFTER)).toBe(0);
    expect(num(end, REJECTED)).toBeGreaterThan(0);
  });

  it("tryThis 1: JWTs skip Redis, but a copied token keeps working after logout until it expires, more than 10 s later", () => {
    const fs = frames(s, tryParams(s, 0));
    const end = fs.at(-1)!;
    expect(num(end, TRIPS)).toBeLessThan(0.3);
    expect(tokensOn(fs, "app-redis")).toBeLessThan(tokensOn(frames(s, {}), "app-redis") / 4);
    const out = logoutFrame(fs);
    expect(out).toBeGreaterThan(0);
    // The last stolen-copy request accepted after logout came more than 10 s after it.
    const counts = fs.map((f) => num(f, AFTER));
    const lastAccept = counts.findIndex((c) => c === counts.at(-1));
    expect(counts.at(-1)!).toBeGreaterThanOrEqual(3);
    expect(timeOf(lastAccept) - timeOf(out)).toBeGreaterThan(10_000);
    // Then it expires, and only then is it refused.
    expect(logLines(fs).some((l) => /finally gets 401, \d+ s after Ann logged out: the token has expired/.test(l))).toBe(true);
    expect(num(end, REJECTED)).toBeGreaterThan(0);
  });

  it("tryThis 2: a denylist refuses the copy at once, but every request is back to a Redis trip", () => {
    const fs = frames(s, tryParams(s, 1));
    const end = fs.at(-1)!;
    expect(num(end, TRIPS)).toBeGreaterThanOrEqual(1);
    expect(num(end, AFTER)).toBe(0);
    expect(num(end, REJECTED)).toBeGreaterThan(0);
    expect(logLines(fs).some((l) => /on the denylist, so the logout took effect at once/.test(l))).toBe(true);
    const out = logoutFrame(fs);
    const refused = fs.findIndex((f, i) => i > out && note(f, "attacker").startsWith("copy rejected"));
    expect(timeOf(refused) - timeOf(out)).toBeLessThan(5000);
  });

  it("tryThis 3: with a 10 s lifetime the copy dies within 10 s of being signed, and refreshes add Redis trips", () => {
    const fs = frames(s, tryParams(s, 2));
    const end = fs.at(-1)!;
    expect(num(end, AFTER)).toBe(0);
    // The copy was signed 2 s before the start, so from 8 s on it is refused, whatever Ann does.
    const refused = fs.findIndex((f) => note(f, "attacker").startsWith("copy rejected"));
    expect(timeOf(refused)).toBeGreaterThanOrEqual(8000);
    expect(fs.slice(refused).every((f) => !note(f, "attacker").startsWith("copy accepted"))).toBe(true);
    expect(logLines(fs).some((l) => /A short lifetime limits how long a copy is any use/.test(l))).toBe(true);
    expect(logLines(fs).some((l) => /refresh token: one Redis trip/.test(l))).toBe(true);
    // More Redis traffic than with 30 s tokens: refreshes come three times as often.
    expect(tokensOn(fs, "app-redis")).toBeGreaterThan(2 * tokensOn(frames(s, tryParams(s, 0)), "app-redis"));
    expect(num(end, TRIPS)).toBeGreaterThan(num(frames(s, tryParams(s, 0)).at(-1)!, TRIPS));
  });
});

describe("presigned uploads: behaviour", () => {
  const s = presignedUploadsScene;
  const DATA = /File data through your server/;
  const HELD = /Server time per upload/;
  const FAILED = /Failed uploads/;
  const memory = (f: Frame) => f.boxes.app?.slots?.busy ?? 0;
  /** MB of files the API holds, read from its note ("holding 2 uploads, 140 MB"). */
  const filesMb = (f: Frame) => Number(/, (\d+) MB/.exec(note(f, "app"))?.[1] ?? 0);
  const avgFilesMb = (fs: Frame[]) => fs.reduce((a, f) => a + filesMb(f), 0) / fs.length;

  it("defaults: files go straight to storage, and the API's part is two small requests", () => {
    const fs = frames(s, {});
    const end = fs.at(-1)!;
    expect(value(end, DATA)).toBe("0 MB");
    expect(num(end, HELD)).toBeLessThan(1);
    expect(num(end, /Uploads finished/)).toBeGreaterThan(5);
    expect(num(end, FAILED)).toBe(0);
    expect(fs.every((f) => memory(f) === 1)).toBe(true);
    expect(tokensOn(fs, "users-storage")).toBeGreaterThan(0);
    expect(tokensOn(fs, "app-storage")).toBe(0);
  });

  it("tryThis 1: through the API, each file sits in memory and each request is held for seconds", () => {
    const fs = frames(s, tryParams(s, 0));
    const end = fs.at(-1)!;
    expect(num(end, DATA)).toBeGreaterThan(0);
    expect(num(end, HELD)).toBeGreaterThanOrEqual(5);
    expect(num(end, FAILED)).toBe(0);
    expect(Math.max(...fs.map(memory))).toBeGreaterThanOrEqual(3);
    expect(tokensOn(fs, "users-storage")).toBe(0);
  });

  it("tryThis 2: busy uploads through the API exceed 512 MB, the process is killed and uploads in progress fail", () => {
    const fs = frames(s, tryParams(s, 1));
    expect(num(fs.at(-1)!, FAILED)).toBeGreaterThan(0);
    expect(logLines(fs).some((l) => /more than the server's 512 MB, so the process is killed/.test(l))).toBe(true);
    expect(fs.some((f) => note(f, "app").startsWith("killed"))).toBe(true);
  });

  it("tryThis 3: slow connections keep each file in memory longer, so more is held at once on light traffic", () => {
    const slow = frames(s, tryParams(s, 2));
    const fast = frames(s, tryParams(s, 0));
    expect(num(slow.at(-1)!, HELD)).toBeGreaterThan(num(fast.at(-1)!, HELD) + 2);
    expect(avgFilesMb(slow)).toBeGreaterThan(avgFilesMb(fast) * 1.25);
  });

  it("tryThis 4: straight to storage under busy, slow traffic, the server's memory never moves and nothing fails", () => {
    const fs = frames(s, tryParams(s, 3));
    const end = fs.at(-1)!;
    expect(fs.every((f) => memory(f) === 1)).toBe(true);
    expect(num(end, FAILED)).toBe(0);
    expect(value(end, DATA)).toBe("0 MB");
    expect(num(end, HELD)).toBeLessThan(1);
  });
});

describe("Server Actions: behaviour", () => {
  const s = serverActionsScene;
  const SAVE = /Average time to save/;
  const POSTS = /POSTs per save/;

  it("defaults: a call is sent as a POST naming the action, and the result comes back in its response", () => {
    const fs = frames(s, {});
    expect(logLines(fs).some((l) => /POST \/todos with the action's id in a Next-Action header/.test(l))).toBe(true);
    expect(num(fs.at(-1)!, POSTS)).toBe(1);
    expect(tokensOn(fs, "browser-server")).toBeGreaterThan(0);
  });

  it("tryThis 1: the script's POSTs reach the server, and only the check inside deleteTodo turns them away", () => {
    const fs = frames(s, tryParams(s, 0));
    const end = fs.at(-1)!;
    expect(tokensOn(fs, "script-server")).toBeGreaterThan(0);
    expect(num(end, /turned away/)).toBeGreaterThan(2);
    expect(num(end, /deleted by the script/)).toBe(0);
    expect(fs.every((f) => f.tokens.every((t) => !(t.link === "server-db" && (t.label ?? "").startsWith("DELETE"))))).toBe(true);
    expect(logLines(fs).some((l) => /No session cookie, so the action stops before the database/.test(l))).toBe(true);
  });

  it("tryThis 2: without the check, the script deletes other people's todos", () => {
    const fs = frames(s, tryParams(s, 1));
    const end = fs.at(-1)!;
    expect(num(end, /deleted by the script/)).toBeGreaterThan(2);
    expect(num(end, /turned away/)).toBe(0);
    expect(note(end, "db")).toMatch(/deleted/);
  });

  it("tryThis 3: one call per todo makes 5 POSTs one after another, about five times as slow", () => {
    const each = frames(s, tryParams(s, 2)).at(-1)!;
    const one = frames(s, { ...tryParams(s, 2), calls: "one" }).at(-1)!;
    expect(num(each, POSTS)).toBe(5);
    expect(num(one, POSTS)).toBe(1);
    const ratio = num(each, SAVE) / num(one, SAVE);
    expect(ratio).toBeGreaterThan(4);
    expect(ratio).toBeLessThan(6);
  });
});

describe("thread pool: behaviour", () => {
  const s = threadPoolScene;
  const READ_WAIT = /File reads: average wait/;
  const LOGIN = /Logins: average time/;
  const DB = /Database requests: average time/;

  it("tryThis 1: many hashes fill the 4 threads, file reads wait behind them, database requests don't", () => {
    const fs = frames(s, tryParams(s, 0));
    const few = frames(s, { size: "4", logins: "few" }).at(-1)!;
    const end = fs.at(-1)!;
    expect(num(end, READ_WAIT)).toBeGreaterThanOrEqual(0.6);
    expect(fs.some((f) => (f.boxes.pool?.queue ?? 0) > 0 && /read/.test(note(f, "pool")))).toBe(true);
    // While the pool has a line, queries still travel to the database.
    expect(fs.some((f) => (f.boxes.pool?.queue ?? 0) > 0 && f.tokens.some((t) => t.link === "node-db"))).toBe(true);
    expect(Math.abs(num(end, DB) - num(few, DB))).toBeLessThanOrEqual(0.2);
    expect(logLines(fs).some((l) => /file read waits: all 4 threads are hashing passwords/.test(l))).toBe(true);
  });

  it("tryThis 2: 8 threads make the waits for file reads and logins go away", () => {
    const four = frames(s, tryParams(s, 0)).at(-1)!;
    const eightFs = frames(s, tryParams(s, 1));
    const eight = eightFs.at(-1)!;
    expect(num(eight, READ_WAIT)).toBeLessThan(num(four, READ_WAIT) / 3);
    expect(num(eight, LOGIN)).toBeLessThan(num(four, LOGIN));
    expect(Math.max(...eightFs.map((f) => f.boxes.pool?.queue ?? 0))).toBeLessThanOrEqual(1);
  });

  it("tryThis 3 and defaults: with few logins a thread is nearly always free, so nothing waits", () => {
    for (const params of [{}, tryParams(s, 2)]) {
      const fs = frames(s, params);
      expect(num(fs.at(-1)!, READ_WAIT)).toBeLessThan(0.2);
      expect(fs.filter((f) => (f.boxes.pool?.queue ?? 0) > 0).length).toBeLessThan(fs.length / 20);
    }
  });
});

describe("platform pages", () => {
  it("one short page per scene, agreeing with the catalog", () => {
    expect(platformPages.map((p) => p.concept).sort()).toEqual(SCENES.map((s) => s.id).sort());
    for (const p of platformPages) {
      expect(CONCEPTS.some((c) => c.id === p.concept), p.concept).toBe(true);
      expect(wordCount(p), p.concept).toBeLessThan(600);
      expect(p.how.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.how.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.breaks.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.breaks.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.sim, p.concept).toBeUndefined();
    }
  });
});
