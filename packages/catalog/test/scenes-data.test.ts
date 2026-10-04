import { describe, expect, it } from "vitest";
import type { ConceptScene, Frame, SceneParams } from "../src/scenes/types.ts";
import { paginationScene } from "../src/scenes/pagination.ts";
import { databaseIndexScene } from "../src/scenes/database-index.ts";
import { readReplicaScene } from "../src/scenes/read-replica.ts";
import { hashId, shardingScene, usersMoved } from "../src/scenes/sharding.ts";
import { transactionsScene } from "../src/scenes/transactions.ts";
import { dataPages } from "../src/extra-pages/data.ts";
import { wordCount } from "../src/pages.ts";
import { CONCEPTS } from "../src/concepts.ts";

const SCENES: ConceptScene[] = [paginationScene, databaseIndexScene, readReplicaScene, shardingScene, transactionsScene];

/** Every frame of a run, one per 50 ms of scene time. Seed 1 is what the page uses. */
function frames(scene: ConceptScene, params: SceneParams, seconds = 40, seed = 1): Frame[] {
  const r = scene.start({ ...scene.defaults, ...params }, seed);
  const out = [r.tick(0)];
  for (let t = 0; t < seconds * 1000; t += 50) out.push(r.tick(50));
  return out;
}

const value = (f: Frame, label: string): string => {
  const c = f.counters.find((x) => x.label === label);
  if (!c) throw new Error(`no counter "${label}"`);
  return c.value;
};
/** "1,000,000" → 1000000, "$900" → 900, "41%" → 41, "1.8 s" → 1.8, "–" → NaN. */
const num = (s: string) => Number.parseFloat(s.replace(/[$,%]/g, ""));
const series = (fs: Frame[], label: string) => fs.map((f) => num(value(f, label))).filter((v) => !Number.isNaN(v));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Every distinct log line a run printed. */
const logs = (fs: Frame[]) => [...new Set(fs.flatMap((f) => f.log))];

/** Every combination of a scene's controls (counts at both ends and the middle). */
function combos(scene: ConceptScene): SceneParams[] {
  let out: SceneParams[] = [{}];
  for (const c of scene.controls) {
    const values = c.type === "choice" ? c.options.map((o) => o.value) : c.type === "toggle" ? [false, true] : [...new Set([c.min, Math.round((c.min + c.max) / 2), c.max])];
    out = out.flatMap((p) => values.map((v) => ({ ...p, [c.id]: v })));
  }
  return out.map((p) => ({ ...scene.defaults, ...p }));
}

describe.each(SCENES.map((s) => [s.id, s] as const))("data scene: %s", (_id, scene) => {
  it("illustrates a known concept with 2-4 controls, 2-4 experiments and a page", () => {
    expect(CONCEPTS.some((c) => c.id === scene.id)).toBe(true);
    expect(dataPages.some((p) => p.concept === scene.id)).toBe(true);
    expect(scene.width).toBeLessThanOrEqual(780);
    expect(scene.height).toBeLessThanOrEqual(420);
    expect(scene.intro.length).toBeGreaterThan(60);
    expect(scene.controls.length).toBeGreaterThanOrEqual(2);
    expect(scene.controls.length).toBeLessThanOrEqual(4);
    expect(scene.tryThis.length).toBeGreaterThanOrEqual(2);
    expect(scene.tryThis.length).toBeLessThanOrEqual(4);
    for (const c of scene.controls) expect(scene.defaults[c.id], c.id).toBeDefined();
    // Experiments only set controls that exist.
    for (const t of scene.tryThis) for (const k of Object.keys(t.params)) expect(scene.controls.some((c) => c.id === k), k).toBe(true);
  });

  it("lays out readable, non-overlapping boxes for every setting", () => {
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const ids = new Set(boxes.map((b) => b.id));
      for (const l of links) {
        expect(ids.has(l.from) && ids.has(l.to), l.id).toBe(true);
        if (l.label) expect(l.label.split(" ").length, l.label).toBeLessThanOrEqual(2);
      }
      for (const b of boxes) {
        expect(b.w >= 140 && b.w <= 240 && b.h >= 70 && b.h <= 130, `${b.id} size`).toBe(true);
        expect(b.x >= 0 && b.y >= 0 && b.x + b.w <= scene.width && b.y + b.h <= scene.height, `${b.id} on canvas`).toBe(true);
        expect(b.label.split(" ").length, b.label).toBeLessThanOrEqual(3);
        expect((b.detail ?? "").length, `${b.id} detail "${b.detail}"`).toBeLessThan(b.w / 7);
      }
      for (const a of boxes) for (const b of boxes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
        const sideBySide = a.y < b.y + b.h && b.y < a.y + a.h;
        if (sideBySide) expect(Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)), `${a.id} / ${b.id} gap`).toBeGreaterThanOrEqual(70);
      }
    }
  });

  it("runs 60 s for every setting, drawing only laid-out links and boxes, with short notes, labels and log lines", () => {
    for (const params of combos(scene)) {
      const { boxes, links } = scene.layout(params);
      const linkIds = new Set(links.map((l) => l.id));
      const width = new Map(boxes.map((b) => [b.id, b.w]));
      const fs = frames(scene, params, 60);
      const tag = JSON.stringify(params);
      for (const f of fs) {
        expect(f.tokens.length, tag).toBeLessThanOrEqual(24);
        for (const tok of f.tokens) {
          expect(linkIds.has(tok.link), `${tok.link} in ${tag}`).toBe(true);
          expect((tok.label ?? "").length, `token label "${tok.label}"`).toBeLessThanOrEqual(22);
        }
        for (const [id, st] of Object.entries(f.boxes)) {
          expect(width.has(id), `${id} in ${tag}`).toBe(true);
          expect((st.note ?? "").length, `${id} note "${st.note}"`).toBeLessThan(width.get(id)! / 7);
        }
        expect(f.counters.length).toBeGreaterThanOrEqual(3);
        expect(f.counters.length).toBeLessThanOrEqual(4);
      }
      const lines = logs(fs);
      expect(lines.length, tag).toBeGreaterThan(0);
      for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(140);
    }
  });

  it("replays the same way for the same seed", () => {
    expect(frames(scene, {}, 20, 5).at(-1)).toEqual(frames(scene, {}, 20, 5).at(-1));
  });
});

describe("pagination", () => {
  const rows = "Rows read, last request";
  const took = "Last request took (slowed down)";

  it("by default (a cursor, others posting) every page reads 10 rows, costs the same, and nothing repeats", () => {
    const fs = frames(paginationScene, {}, 60);
    expect(Math.max(...series(fs, rows))).toBeLessThanOrEqual(10);
    // Every full page costs the same (the empty page past the oldest post is the only cheaper one).
    expect(new Set(fs.filter((f) => value(f, "Posts in the last response") === "10").map((f) => value(f, took))).size).toBe(1);
    expect(num(value(fs.at(-1)!, "Posts shown twice"))).toBe(0);
    expect(num(fs.at(-1)!.boxes.others!.note!)).toBeGreaterThan(5); // others really did post meanwhile
    expect(logs(fs).some((l) => /Page \d+ asks for posts older than/.test(l))).toBe(true);
  });

  it("each square in Postgres stands for 10 rows read", () => {
    for (const mode of ["offset", "all"]) {
      for (const f of frames(paginationScene, { mode }, 30)) {
        const db = f.boxes.db!;
        if (!db.slots) continue;
        const read = Number(/of (\d+)$/.exec(db.note!)?.[1] ?? /to (\d+)$/.exec(db.note!)?.[1] ?? NaN);
        if (!Number.isNaN(read)) expect(db.slots.total).toBe(Math.ceil(read / 10));
      }
    }
  });

  it("experiment 1: with OFFSET, page 8 walks past 70 posts and reads 80 rows; rows and time grow with depth", () => {
    const fs = frames(paginationScene, paginationScene.tryThis[0]!.params);
    expect(logs(fs)).toContain("Page 8: OFFSET 70 makes the database walk past 70 posts before it keeps 10, so it reads 80 rows.");
    const at = (n: number) => fs.find((f) => value(f, rows) === String(n))!;
    expect(num(value(at(80), took))).toBeGreaterThan(num(value(at(10), took)) + 0.5);
    const seen = series(fs, rows);
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // never shrinks while paging deeper
    expect(num(value(fs.at(-1)!, "Posts shown twice"))).toBe(0); // nobody posts, so nothing moves
  });

  it("experiment 2: OFFSET while others post shows a post from the previous page again", () => {
    const fs = frames(paginationScene, paginationScene.tryThis[1]!.params);
    expect(num(value(fs.at(-1)!, "Posts shown twice"))).toBeGreaterThan(0);
    expect(logs(fs).some((l) => /shown again on page \d+: 1 new post since page \d+ pushed every post down one place/.test(l))).toBe(true);
  });

  it("experiment 3: all at once reads and sends the whole table, and it grows as others post", () => {
    const fs = frames(paginationScene, paginationScene.tryThis[2]!.params);
    const sent = series(fs, "Posts in the last response");
    expect(sent[0]).toBeGreaterThanOrEqual(150);
    expect(Math.max(...sent)).toBeGreaterThan(sent[0]!);
    for (const f of fs) if (value(f, rows) !== "–") expect(value(f, rows)).toBe(value(f, "Posts in the last response"));
  });

  it("experiment 4: back to the cursor, deep pages still read 10 rows and new posts repeat nothing", () => {
    const fs = frames(paginationScene, paginationScene.tryThis[3]!.params, 40);
    expect(fs.some((f) => /page (1[0-9])/.test(f.boxes.reader!.note ?? ""))).toBe(true); // it gets deep
    expect(Math.max(...series(fs, rows))).toBeLessThanOrEqual(10);
    expect(num(value(fs.at(-1)!, "Posts shown twice"))).toBe(0);
  });
});

describe("database index", () => {
  const rows = "Rows read, last lookup";
  const took = "Last lookup took (slowed down)";
  const avgTook = (params: SceneParams) => mean(series(frames(databaseIndexScene, params), took));

  it("by default the index walks 3 levels and the table fetches only the matching rows", () => {
    const fs = frames(databaseIndexScene, {});
    expect(Math.max(...series(fs, rows))).toBeLessThanOrEqual(8);
    expect(fs.some((f) => f.boxes.index!.slots?.busy === 3 && f.boxes.index!.slots.total === 3)).toBe(true);
    expect(fs.every((f) => (f.boxes.table!.slots?.busy ?? 0) === 0)).toBe(true); // never scans the table
    expect(logs(fs).some((l) => l.includes("the index walks 3 levels (root, branch, leaf)"))).toBe(true);
  });

  it("experiment 1: without the index every lookup reads the whole million-row table and takes longer", () => {
    const params = databaseIndexScene.tryThis[0]!.params;
    const fs = frames(databaseIndexScene, params);
    for (const r of series(fs, rows)) expect(r).toBeGreaterThanOrEqual(1_000_000);
    expect(fs.some((f) => (f.boxes.table!.slots?.busy ?? 0) >= 19)).toBe(true); // the scan reaches the end of the table
    expect(avgTook(params)).toBeGreaterThan(avgTook({ index: true, size: "big" }) + 0.8);
  });

  it("experiment 2: a smaller table still gets read in full, just faster", () => {
    const params = databaseIndexScene.tryThis[1]!.params;
    for (const r of series(frames(databaseIndexScene, params), rows)) expect(r >= 10_000 && r < 10_100).toBe(true);
    expect(avgTook(params)).toBeLessThan(avgTook({ index: false, size: "big" }) - 0.5);
  });

  it("experiment 3: with the index, 10 thousand rows means 2 levels and about the same lookup time as a million", () => {
    const params = databaseIndexScene.tryThis[2]!.params;
    const fs = frames(databaseIndexScene, params);
    expect(fs.every((f) => f.boxes.index!.slots?.total === 2)).toBe(true);
    const indexGap = Math.abs(avgTook(params) - avgTook({ index: true, size: "big" }));
    const scanGap = avgTook({ index: false, size: "big" }) - avgTook({ index: false, size: "small" });
    expect(indexGap).toBeLessThan(0.25);
    expect(scanGap).toBeGreaterThan(3 * indexGap);
  });

  it("experiment 4: with the index on, saving each new order takes an extra write and longer", () => {
    const save = "Saving a new order took (slowed down)";
    const on = frames(databaseIndexScene, databaseIndexScene.tryThis[3]!.params);
    const off = frames(databaseIndexScene, { ...databaseIndexScene.tryThis[3]!.params, index: false });
    expect(value(on.at(-1)!, "Writes per new order")).toBe("2: row + index");
    expect(value(off.at(-1)!, "Writes per new order")).toBe("1: the row");
    expect(Math.min(...series(on, save))).toBeGreaterThan(Math.max(...series(off, save)));
    expect(on.some((f) => /adding user \d+'s entry/.test(f.boxes.index!.note ?? ""))).toBe(true);
  });
});

describe("read replicas", () => {
  const missing = "Reloads missing the user's own post";
  const avgRead = "Average read time (slowed down)";

  it("by default writes go to the primary, reads to the replicas, and with low lag every reload finds its post", () => {
    const fs = frames(readReplicaScene, {}, 60);
    const last = fs.at(-1)!;
    expect(num(value(last, missing))).toBe(0);
    expect(num(value(last, "Reads sent to the primary"))).toBe(0);
    expect(num(value(last, "Writes, all on the primary"))).toBeGreaterThan(10);
    // Each replica replays every write: at some point each holds exactly as many posts as the primary saved.
    for (const r of ["r1", "r2"]) {
      expect(fs.some((f) => f.boxes[r]!.note === `up to date, ${value(f, "Writes, all on the primary")} posts`), r).toBe(true);
    }
    expect(logs(fs).some((l) => l.includes("has already applied post"))).toBe(true);
  });

  it("experiment 1: with high lag, a reload right after posting often misses the post", () => {
    const fs = frames(readReplicaScene, readReplicaScene.tryThis[0]!.params);
    expect(num(value(fs.at(-1)!, missing))).toBeGreaterThanOrEqual(3);
    expect(fs.some((f) => f.tokens.some((t) => t.kind === "empty"))).toBe(true);
    expect(logs(fs).some((l) => /hasn't applied post #\d+ yet/.test(l))).toBe(true);
  });

  it("experiment 2: reading your own posts from the primary fixes it, at the cost of some reads on the primary", () => {
    const fs = frames(readReplicaScene, readReplicaScene.tryThis[1]!.params, 60);
    expect(num(value(fs.at(-1)!, missing))).toBe(0);
    expect(num(value(fs.at(-1)!, "Reads sent to the primary"))).toBeGreaterThan(5);
  });

  it("experiment 3: one replica makes reads wait; three spread them; the primary takes every write either way", () => {
    const one = frames(readReplicaScene, readReplicaScene.tryThis[2]!.params);
    const three = frames(readReplicaScene, { ...readReplicaScene.tryThis[2]!.params, replicas: 3 });
    expect(Math.max(...one.map((f) => f.boxes.r1!.queue ?? 0))).toBeGreaterThanOrEqual(2);
    expect(num(value(one.at(-1)!, avgRead))).toBeGreaterThan(num(value(three.at(-1)!, avgRead)) + 0.5);
    for (const fs of [one, three]) {
      const last = fs.at(-1)!;
      expect(num(value(last, "Writes, all on the primary"))).toBe(num(last.boxes.primary!.note!));
    }
  });
});

describe("sharding", () => {
  const share = "Busiest shard's share of queries";
  const perRequest = "Shard queries per request";
  const longest = "Longest line at a shard";
  const hot3 = hashId(4242) % 3;
  const hot4 = hashId(4242) % 4;

  it("by default each request goes to exactly the shard hash(user_id) % N names, and load is spread", () => {
    const fs = frames(shardingScene, {}, 60);
    expect(value(fs.at(-1)!, perRequest)).toBe("1.0");
    expect(num(value(fs.at(-1)!, share))).toBeLessThan(45);
    for (const line of logs(fs)) {
      const m = /^User (\d+): hash\(\d+\) % 3 = (\d), so/.exec(line);
      if (m) expect(hashId(Number(m[1])) % 3).toBe(Number(m[2]));
    }
    // The opening line's count of users who would move is real.
    expect(logs(fs)[0]).toContain(`${usersMoved(3, 2).toLocaleString("en-US")} of the 10,000 users`);
    expect(usersMoved(4, 3)).toBeGreaterThan(7000); // about three in four move from 3 shards to 4, as the page says
    expect(usersMoved(4, 3)).toBeLessThan(8000);
  });

  it("experiment 1: a hot key overloads its shard while the others have room", () => {
    const fs = frames(shardingScene, shardingScene.tryThis[0]!.params);
    expect(num(value(fs.at(-1)!, share))).toBeGreaterThan(60);
    expect(Math.max(...fs.map((f) => f.boxes[`s${hot3}`]!.queue ?? 0))).toBeGreaterThanOrEqual(4);
    for (const i of [0, 1, 2].filter((i) => i !== hot3)) expect(Math.max(...fs.map((f) => f.boxes[`s${i}`]!.queue ?? 0))).toBeLessThanOrEqual(2);
  });

  it("experiment 2: with 4 shards the others get quieter, but the hot shard is still overloaded", () => {
    const done = (f: Frame, i: number) => Number(/(\d+) done/.exec(f.boxes[`s${i}`]!.note!)?.[1] ?? NaN);
    const three = frames(shardingScene, shardingScene.tryThis[0]!.params).at(-1)!;
    const fs = frames(shardingScene, shardingScene.tryThis[1]!.params);
    expect(Math.max(...fs.map((f) => f.boxes[`s${hot4}`]!.queue ?? 0))).toBeGreaterThanOrEqual(4);
    const others = (f: Frame, n: number, hot: number) => mean([...Array(n).keys()].filter((i) => i !== hot).map((i) => done(f, i)));
    expect(others(fs.at(-1)!, 4, hot4)).toBeLessThan(others(three, 3, hot3));
  });

  it("experiment 3: a search without the key asks every shard and waits for the slowest", () => {
    const fs = frames(shardingScene, shardingScene.tryThis[2]!.params);
    expect(num(value(fs.at(-1)!, perRequest))).toBeGreaterThan(1.2);
    expect(logs(fs).some((l) => l.includes("router asks all 3 shards"))).toBe(true);
    expect(logs(fs).some((l) => l.includes("only as fast as its slowest shard"))).toBe(true);
    expect(num(value(fs.at(-1)!, "Average answer time (slowed down)"))).toBeGreaterThan(num(value(frames(shardingScene, {}).at(-1)!, "Average answer time (slowed down)")));
  });

  it("experiment 4: with 4 shards each search costs 4 shard queries", () => {
    const three = frames(shardingScene, shardingScene.tryThis[2]!.params).at(-1)!;
    const four = frames(shardingScene, shardingScene.tryThis[3]!.params).at(-1)!;
    expect(num(value(four, perRequest))).toBeGreaterThan(num(value(three, perRequest)));
    expect(logs(frames(shardingScene, shardingScene.tryThis[3]!.params)).some((l) => l.includes("router asks all 4 shards"))).toBe(true);
  });
});

describe("transactions", () => {
  const total = "Total, should stay $1,000";

  it("by default crashes happen and are rolled back, so the total is $1,000 in every frame", () => {
    const fs = frames(transactionsScene, {});
    expect(num(value(fs.at(-1)!, "Crashes mid-transfer"))).toBeGreaterThanOrEqual(1);
    for (const f of fs) expect(value(f, total)).toBe("$1,000");
    expect(logs(fs).some((l) => l.includes("rolled back"))).toBe(true);
    // The whole transaction holds one checked-out connection: it is held whenever a change is uncommitted.
    // (Right after a crash the app is down while Postgres still holds the change, until it sees the connection close.)
    for (const f of fs) if (/not committed/.test(f.boxes.db!.note ?? "") && f.boxes.app!.tone !== "bad") expect(f.boxes.app!.slots?.busy ?? 0).toBe(1);
    expect(fs.some((f) => /not committed/.test(f.boxes.db!.note ?? ""))).toBe(true);
  });

  it("experiment 1: without a transaction, a crash between the UPDATEs makes $100 disappear", () => {
    const fs = frames(transactionsScene, transactionsScene.tryThis[0]!.params);
    expect(num(value(fs.at(-1)!, total))).toBeLessThanOrEqual(900);
    expect(logs(fs).some((l) => l.includes("arrived nowhere"))).toBe(true);
  });

  it("experiment 2: without a transaction or crashes, the total reads $900 between the two UPDATEs and comes back", () => {
    const fs = frames(transactionsScene, transactionsScene.tryThis[1]!.params);
    const totals = series(fs, total);
    expect(totals).toContain(900);
    expect(totals.every((t) => t === 900 || t === 1000)).toBe(true);
    expect(totals.filter((t) => t === 1000).length).toBeGreaterThan(totals.length / 2);
    expect(num(value(fs.at(-1)!, "Crashes mid-transfer"))).toBe(0);
  });

  it("experiment 3: with BEGIN … COMMIT and crashes, the total never moves", () => {
    const fs = frames(transactionsScene, transactionsScene.tryThis[2]!.params, 60);
    expect(num(value(fs.at(-1)!, "Crashes mid-transfer"))).toBeGreaterThanOrEqual(2);
    expect(new Set(series(fs, total))).toEqual(new Set([1000]));
  });
});

describe("data pages", () => {
  it("one short page per data scene, with 2-4 explanations and 2-4 limits", () => {
    expect(dataPages.map((p) => p.concept).sort()).toEqual(SCENES.map((s) => s.id).sort());
    for (const p of dataPages) {
      expect(wordCount(p), p.concept).toBeLessThan(600);
      expect(p.how.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.how.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.breaks.length, p.concept).toBeGreaterThanOrEqual(2);
      expect(p.breaks.length, p.concept).toBeLessThanOrEqual(4);
      expect(p.problem.split(/(?<=\.)\s/).length, p.concept).toBeLessThanOrEqual(3);
      expect(p.sim).toBeUndefined();
    }
  });
});
