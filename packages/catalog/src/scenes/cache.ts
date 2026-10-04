import type { BoxState, ConceptScene, Counter, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { Station, World } from "./world.ts";

const USER_HOP = 360; // ms between users and the app, slowed down to watch
const HOP = 300; // ms between the app and the cache or the database
const LOOKUP = 60; // ms for Redis to look up a key
const QUERY = 1800; // ms for the database to read an item
const UPDATE = 900; // ms for the database to save an edit
const DB_SLOTS = 3; // queries the database runs at once
const READ_GAP = 800; // average ms between reads; real traffic comes in bursts, so the gaps vary a lot
const EDIT_GAP = 5000; // average ms between edits, when there are any
const EXPIRY: Record<string, number> = { short: 6000, long: 30000 };
/** How often each of 8 items is read when the same items come up often: a few are popular. */
const POPULAR = [9, 6, 4, 3, 2, 2, 1, 1];
const MANY = 60; // items to choose from when reads are spread out

interface Entry {
  version: number;
  expires: number;
}

export const cacheAsideScene: ConceptScene = {
  id: "cache-aside",
  title: "Checking a cache before the database",
  intro: "Users read product items. The app asks the Redis cache first: on a hit it answers straight away; on a miss it reads the database, stores a copy in the cache with an expiry, and answers. The database can only run 3 queries at a time. Slowed down; each envelope is one request or reply.",
  width: 780,
  height: 380,
  controls: [
    { type: "toggle", id: "cache", label: "Use the cache" },
    { type: "choice", id: "reuse", label: "Same items asked again", options: [{ value: "often", label: "Often" }, { value: "rarely", label: "Rarely" }] },
    { type: "choice", id: "expiry", label: "Cached copies expire after", options: [{ value: "short", label: "6 s" }, { value: "long", label: "30 s" }] },
    { type: "choice", id: "edits", label: "Items get edited", options: [{ value: "none", label: "Never" }, { value: "db", label: "Update DB only" }, { value: "invalidate", label: "Update DB + clear cache" }] },
  ],
  defaults: { cache: true, reuse: "often", expiry: "long", edits: "none" },
  layout(p: SceneParams) {
    const on = pbool(p, "cache");
    const ttl = EXPIRY[pstr(p, "expiry")] ?? 30000;
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "read products", x: 10, y: 140, w: 150, h: 84 },
        { id: "app", kind: "app", label: "App", detail: on ? "checks the cache first" : "always asks the database", x: 230, y: 128, w: 190, h: 108 },
        { id: "cache", kind: "cache", label: "Redis cache", detail: on ? `keeps copies for ${ttl / 1000} s` : "turned off", x: 510, y: 16, w: 240, h: 112 },
        { id: "db", kind: "database", label: "Database", detail: `runs ${DB_SLOTS} queries at a time`, x: 510, y: 250, w: 240, h: 116 },
      ],
      links: [
        { id: "u-app", from: "users", to: "app", label: "HTTP" },
        { id: "app-cache", from: "app", to: "cache", label: "GET / SET" },
        { id: "app-db", from: "app", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const on = pbool(p, "cache");
    const often = pstr(p, "reuse") === "often";
    const ttl = EXPIRY[pstr(p, "expiry")] ?? 30000;
    const edits = pstr(p, "edits");
    const db = new Station(world, DB_SLOTS);
    const cache = new Map<number, Entry>();
    const version = new Map<number, number>(); // the database's current version of each item
    const current = (item: number) => version.get(item) ?? 1;
    const fresh = (e: Entry | undefined): e is Entry => !!e && e.expires > world.time;
    const secondsLeft = (e: Entry) => Math.max(1, Math.ceil((e.expires - world.time) / 1000));
    let id = 0;
    let reads = 0;
    let hits = 0;
    let misses = 0;
    let dbReads = 0;
    let done = 0;
    let totalMs = 0;
    let stale = 0;

    const weights = POPULAR.reduce((a, b) => a + b, 0);
    const popular = () => {
      let r = world.random() * weights;
      for (let i = 0; i < POPULAR.length; i++) {
        r -= POPULAR[i]!;
        if (r < 0) return i + 1;
      }
      return POPULAR.length;
    };
    const pickItem = () => (often ? popular() : 1 + Math.floor(world.random() * MANY));

    const answer = (started: number, old: boolean) =>
      world.send("u-app", "reply", USER_HOP, () => {
        done++;
        totalMs += world.time - started;
      }, { reverse: true, label: old ? "old copy" : undefined });

    /** A miss (or no cache): read the database, then keep a copy in the cache if there is one. */
    const fromDb = (req: number, item: number, started: number) => {
      dbReads++;
      world.send("app-db", "request", HOP, () => {
        if (db.busy >= DB_SLOTS) world.log(`#${req} waits at the database: all ${DB_SLOTS} query slots are busy.`);
        db.serve(QUERY, () => {
          const v = current(item);
          world.send("app-db", "reply", HOP, () => {
            if (on) world.send("app-cache", "request", HOP, () => cache.set(item, { version: v, expires: world.time + ttl }), { label: `SET item ${item}` });
            answer(started, false);
          }, { reverse: true, label: `item ${item}` });
        });
      }, { label: `SELECT item ${item}` });
    };

    world.every(READ_GAP, () => {
      const req = ++id;
      const item = pickItem();
      const started = world.time;
      world.send("u-app", "request", USER_HOP, () => {
        reads++;
        if (!on) {
          if (db.busy < DB_SLOTS) world.log(`#${req} goes straight to the database for item ${item}: there is no cache.`);
          fromDb(req, item, started);
          return;
        }
        world.send("app-cache", "request", HOP, () => world.after(LOOKUP, () => {
          const e = cache.get(item);
          if (fresh(e)) {
            hits++;
            const old = e.version < current(item);
            if (old) {
              stale++;
              world.log(`#${req} hits item ${item}, but it's the old copy: the database has changed, and the cache keeps serving this one until it expires in ${secondsLeft(e)} s.`);
            } else world.log(`#${req} hits: item ${item} is in the cache, so the database isn't asked.`);
            world.send("app-cache", "reply", HOP, () => answer(started, old), { reverse: true, label: `item ${item}` });
            return;
          }
          misses++;
          world.log(e
            ? `#${req} misses: the copy of item ${item} expired, so the app reads the database and caches it again for ${ttl / 1000} s.`
            : `#${req} misses: item ${item} isn't cached, so the app reads the database, then keeps a copy for ${ttl / 1000} s.`);
          world.send("app-cache", "empty", HOP, () => fromDb(req, item, started), { reverse: true, label: "miss" });
        }), { label: `GET item ${item}` });
      }, { label: `#${req} item ${item}` });
    }, 0.9);

    if (edits !== "none") {
      world.every(EDIT_GAP, () => {
        const req = ++id;
        const item = popular(); // people edit the items they care about, which are the popular ones
        world.send("u-app", "request", USER_HOP, () => {
          world.send("app-db", "request", HOP, () => db.serve(UPDATE, () => {
            version.set(item, current(item) + 1);
            world.send("app-db", "reply", HOP, () => {
              const e = cache.get(item);
              if (on && edits === "invalidate") {
                world.log(`Item ${item} is edited: the app updates the database, then deletes the cached copy, so the next read fetches the new version.`);
                world.send("app-cache", "request", HOP, () => cache.delete(item), { label: `DEL item ${item}` });
              } else if (on && fresh(e)) {
                world.log(`Item ${item} is edited in the database only. The cache still holds the old copy and will serve it for ${secondsLeft(e)} more seconds.`);
              } else {
                world.log(`Item ${item} is edited in the database${on ? "; it isn't cached right now, so nothing is out of date" : ""}.`);
              }
              world.send("u-app", "reply", USER_HOP, undefined, { reverse: true, label: "saved" });
            }, { reverse: true, label: "updated" });
          }), { label: `UPDATE item ${item}` });
        }, { label: `#${req} edit item ${item}` });
      }, 0.25);
    }

    return {
      tick(dt: number) {
        world.advance(dt);
        // Redis drops keys whose expiry has passed.
        for (const [k, e] of cache) if (!fresh(e)) cache.delete(k);
        const held = cache.size;
        const outdated = [...cache].filter(([k, e]) => e.version < current(k)).length;
        const looked = hits + misses;
        const avg = done ? totalMs / done : 0;
        const q = db.waiting.length;
        const boxes: Record<string, BoxState> = {
          users: { note: `${done} answered${stale ? ` (${stale} old)` : ""}` },
          app: on ? { note: `${hits} hits, ${misses} misses` } : { note: `${reads} reads, all to the database` },
          cache: on
            ? { note: held ? `holds ${held} item${held === 1 ? "" : "s"}${outdated ? `, ${outdated} out of date` : ""}` : "empty", tone: outdated ? "bad" : "ok" }
            : { note: "not used", tone: "idle" },
          db: { slots: { total: DB_SLOTS, busy: db.busy, label: "query slots" }, queue: q, note: `${db.served} queries done${q ? `, ${q} waiting` : ""}`, tone: q >= 3 ? "bad" : db.busy === DB_SLOTS ? "busy" : db.busy ? "ok" : "idle" },
        };
        const counters: Counter[] = [
          { label: "Hit ratio", value: !on ? "off" : looked ? `${Math.round((hits / looked) * 100)}%` : "–" },
          { label: "Database reads", value: String(dbReads) },
          { label: "Average time per read", value: done ? `${(avg / 1000).toFixed(1)} s` : "–" },
        ];
        if (edits !== "none") counters.push({ label: "Stale answers", value: String(stale), tone: stale ? "bad" : "good" });
        return { boxes, tokens: world.tokens(), counters, log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Turn the cache off: every read now pays for a database query, so answers take noticeably longer, and in a burst of reads all 3 query slots fill up and reads wait in line.", params: { cache: false } },
    { text: "Ask for the same items rarely: most reads are for something not cached yet, so they miss, the database does nearly all the work, and each miss also pays for the cache check.", params: { cache: true, reuse: "rarely" } },
    { text: "Edit items in the database only: reads that hit the cache keep getting the old copy until it expires, up to 30 s after the edit.", params: { cache: true, reuse: "often", expiry: "long", edits: "db" } },
    { text: "Now also delete the cached copy on each edit: the next read misses and fetches the new version, so old data almost never reaches users.", params: { cache: true, reuse: "often", expiry: "long", edits: "invalidate" } },
  ],
};
