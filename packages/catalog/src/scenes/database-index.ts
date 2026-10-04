import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down and not to scale: a real scan of a million rows takes far
// longer next to an index lookup than it does here. The counters give the real row counts.
const APP_HOP = 350; // your app to Postgres
const INNER_HOP = 300; // from the index to the table: both live inside Postgres, drawn apart to show which is read
const LEVEL = 120; // reading one page of the index, one level of the tree
const FETCH_BASE = 150; // fetching the matching rows from the table by their locations
const FETCH_PER_ROW = 20;
const SCAN: Record<string, number> = { small: 1100, big: 2000 }; // reading the whole table
const ROWS: Record<string, number> = { small: 10_000, big: 1_000_000 };
/** B-tree depth for an index on an integer column: hundreds of entries fit in one page, so few levels. */
const LEVELS: Record<string, number> = { small: 2, big: 3 };
const PAUSE = 800; // between one lookup's answer and the next lookup
const WRITE_ROW = 400; // adding the new row to the table
const WRITE_ENTRY = 300; // adding its entry to the index, at its sorted place
const INSERT_GAP: Record<string, number> = { rare: 6000, frequent: 1500 };
const SQUARES = 20; // the table box shows how much of the table a query read, in twentieths

const fmt = (n: number) => n.toLocaleString("en-US");
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const LEVEL_NAMES: Record<number, string[]> = { 2: ["root", "leaf"], 3: ["root", "branch", "leaf"] };

interface Lookup {
  uid: number;
  matches: number;
  phase: "walk" | "fetch" | "scan";
  start: number;
}

export const databaseIndexScene: ConceptScene = {
  id: "database-index",
  title: "Finding one user's orders, with and without an index",
  intro: "Your app asks Postgres for one user's orders: WHERE user_id = ?. Without an index on user_id, Postgres reads every row and checks it. With one, it walks a few levels of a sorted tree to that user's entries and fetches only those rows. The index lives inside Postgres too; it is drawn apart so you can see what each query reads. Slowed down and not to scale; the row counts are exact.",
  width: 780,
  height: 350,
  controls: [
    { type: "toggle", id: "index", label: "Index on user_id" },
    { type: "choice", id: "size", label: "Orders in the table", options: [{ value: "small", label: "10 thousand" }, { value: "big", label: "1 million" }] },
    { type: "choice", id: "inserts", label: "New orders", options: [{ value: "rare", label: "Rare" }, { value: "frequent", label: "Frequent" }] },
  ],
  defaults: { index: true, size: "big", inserts: "rare" },
  layout(p: SceneParams) {
    const on = pbool(p, "index");
    const size = pstr(p, "size");
    return {
      boxes: [
        { id: "app", kind: "app", label: "Your app", detail: "looks up a user's orders", x: 20, y: 120, w: 200, h: 110 },
        { id: "index", kind: "database", label: "Index on user_id", detail: on ? `sorted tree, ${LEVELS[size]} levels` : "not created", x: 540, y: 14, w: 220, h: 110 },
        { id: "table", kind: "database", label: "orders table", detail: `${fmt(ROWS[size] ?? 0)} orders`, x: 540, y: 200, w: 220, h: 130 },
      ],
      links: [
        { id: "app-index", from: "app", to: "index", label: "SQL" },
        { id: "app-table", from: "app", to: "table", label: "SQL" },
        { id: "index-table", from: "index", to: "table", label: "row locations" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const on = pbool(p, "index");
    const size = pstr(p, "size");
    const levels = LEVELS[size] ?? 3;
    const names = LEVEL_NAMES[levels] ?? LEVEL_NAMES[3]!;
    const scanMs = SCAN[size] ?? 2000;
    let rows = ROWS[size] ?? 1_000_000;
    let lookup: Lookup | undefined;
    let lookups = 0;
    let lastRead: number | undefined;
    let lastLookupMs: number | undefined;
    let lastInsertMs: number | undefined;
    let tableWrites = 0; // new rows being written right now
    let indexWrites = 0; // index entries being added right now
    let entryFor = 0; // the user id of the latest index entry being added
    let inserted = 0;
    let appNote = "starting";
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const finish = (l: Lookup, read: number, started: number) => {
      world.send("app-table", "reply", APP_HOP, () => {
        lookups++;
        lastRead = read;
        lastLookupMs = world.time - started;
        appNote = `got ${l.matches} orders of user ${l.uid}`;
        world.after(PAUSE, next);
      }, { reverse: true, label: `${l.matches} rows` });
    };

    const next = () => {
      const uid = 1 + Math.floor(world.random() * 2000);
      const matches = 2 + Math.floor(world.random() * 7);
      const started = world.time;
      appNote = `WHERE user_id = ${uid}`;
      if (on) {
        world.send("app-index", "request", APP_HOP, () => {
          const l: Lookup = { uid, matches, phase: "walk", start: world.time };
          lookup = l;
          say("walk", 9000, `User ${uid}'s orders: the index walks ${levels} levels (${names.join(", ")}) to user ${uid}'s entries, then the table fetches just those ${matches} rows.`);
          world.after(levels * LEVEL, () => {
            world.send("index-table", "request", INNER_HOP, () => {
              l.phase = "fetch";
              l.start = world.time;
              world.after(FETCH_BASE + FETCH_PER_ROW * matches, () => {
                lookup = undefined;
                finish(l, matches, started);
              });
            }, { label: `${matches} row locations` });
          });
        }, { label: `user_id = ${uid}` });
        return;
      }
      world.send("app-table", "request", APP_HOP, () => {
        const l: Lookup = { uid, matches, phase: "scan", start: world.time };
        lookup = l;
        const read = rows;
        say("scan", 9000, `No index on user_id: Postgres reads all ${fmt(read)} rows, checking each one's user_id, to find user ${uid}'s ${matches} orders.`);
        world.after(scanMs, () => {
          lookup = undefined;
          finish(l, read, started);
        });
      }, { label: `user_id = ${uid}` });
    };

    world.every(INSERT_GAP[pstr(p, "inserts")] ?? 6000, () => {
      const uid = 1 + Math.floor(world.random() * 2000);
      const started = world.time;
      const saved = (link: string) => world.send(link, "reply", APP_HOP, () => {
        lastInsertMs = world.time - started;
      }, { reverse: true, label: "saved" });
      world.send("app-table", "request", APP_HOP, () => {
        tableWrites++;
        world.after(WRITE_ROW, () => {
          tableWrites--;
          rows++;
          inserted++;
          if (!on) {
            say("insert", 9000, `New order for user ${uid}: one write, into the table. There is no index to keep up to date.`);
            saved("app-table");
            return;
          }
          say("insert", 9000, `New order for user ${uid}: the row goes into the table, then an entry goes into the index at its sorted place. Two writes, not one.`);
          world.send("index-table", "request", INNER_HOP, () => {
            indexWrites++;
            entryFor = uid;
            world.after(WRITE_ENTRY, () => {
              indexWrites--;
              saved("app-index");
            });
          }, { reverse: true, label: `entry for user ${uid}` });
        });
      }, { label: "INSERT order" });
    }, 0.5);

    world.after(300, next);

    return {
      tick(dt: number) {
        world.advance(dt);
        const l = lookup;
        let index: BoxState;
        if (!on) index = { note: "not created", tone: "idle" };
        else if (l?.phase === "walk") {
          const walked = Math.min(levels, 1 + Math.floor((world.time - l.start) / LEVEL));
          index = { slots: { total: levels, busy: walked, label: "levels walked" }, note: `${names[walked - 1]}: looking for ${l.uid}`, tone: "busy" };
        } else if (indexWrites) index = { slots: { total: levels, busy: 0, label: "levels walked" }, note: `adding user ${entryFor}'s entry`, tone: "busy" };
        else index = { slots: { total: levels, busy: 0, label: "levels walked" }, note: `${fmt(rows)} entries, sorted`, tone: "ok" };

        let table: BoxState;
        if (l?.phase === "scan") {
          const done = Math.min(1, (world.time - l.start) / scanMs);
          table = { slots: { total: SQUARES, busy: Math.floor(done * SQUARES), label: "of the table read" }, note: `checked ${fmt(Math.floor(done * rows))} of ${fmt(rows)}`, tone: "busy" };
        } else if (l?.phase === "fetch") {
          table = { slots: { total: SQUARES, busy: 0, label: "of the table read" }, note: `fetching ${l.matches} rows directly`, tone: "ok" };
        } else {
          table = { slots: { total: SQUARES, busy: 0, label: "of the table read" }, note: tableWrites ? "writing a new order" : "waiting for a query", tone: tableWrites ? "busy" : "idle" };
        }
        const many = lastRead !== undefined && lastRead > 1000;
        return {
          boxes: {
            app: { note: appNote, tone: l ? "busy" : "ok" },
            index,
            table,
          },
          tokens: world.tokens(),
          counters: [
            { label: "Rows read, last lookup", value: lastRead === undefined ? "–" : fmt(lastRead), tone: many ? "bad" : undefined },
            { label: "Last lookup took (slowed down)", value: lastLookupMs === undefined ? "–" : sec(lastLookupMs) },
            { label: "Saving a new order took (slowed down)", value: lastInsertMs === undefined ? "–" : sec(lastInsertMs) },
            { label: "Writes per new order", value: on ? "2: row + index" : "1: the row" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn the index off: each lookup reads all 1,000,000 rows, checking every one, to find a handful of orders, and takes clearly longer.", params: { index: false, size: "big" } },
    { text: "No index and only 10 thousand orders: the scan still reads every row, just fewer of them, so it is quicker; a scan's cost grows with the table.", params: { index: false, size: "small" } },
    { text: "Index on, 10 thousand orders: the tree has 2 levels instead of 3, so a lookup costs about the same as with a million rows.", params: { index: true, size: "small" } },
    { text: "Frequent new orders with the index on: each one writes the row and then an index entry, so saving an order takes longer than with the index off.", params: { index: true, inserts: "frequent" } },
  ],
};
