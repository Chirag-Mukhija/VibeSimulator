import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pnum } from "./types.ts";
import { Station, World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const USER_HOP = 400; // users to the app
const DB_HOP = 300; // the app to a shard
const LOOKUP = 1000; // one user's orders, on the shard that holds them
const SEARCH = 1300; // a search through one shard's part of the data
const MERGE = 250; // the app combining the shards' partial results
const SLOTS = 2; // queries each shard runs at once
const GAP = 340; // average ms between requests; real traffic is bursty
const USER_COUNT = 10_000;
const HOT_USER = 4242;
const HOT_SHARE = 0.7; // share of requests that are for the popular user, when on
const SEARCH_SHARE = 0.25; // share of requests that search across all users, when on

/** FNV-1a: a simple, well-spread hash of the user id's text. */
export function hashId(id: number): number {
  let h = 0x811c9dc5;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const shardOf = (id: number, n: number) => hashId(id) % n;
const fmt = (n: number) => n.toLocaleString("en-US");
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** How many of the users each shard holds, for n shards. */
function usersPerShard(n: number): number[] {
  const counts = Array.from({ length: n }, () => 0);
  for (let id = 1; id <= USER_COUNT; id++) counts[shardOf(id, n)]!++;
  return counts;
}

/** Users that live on a different shard with `a` shards than with `b`. */
export function usersMoved(a: number, b: number): number {
  let moved = 0;
  for (let id = 1; id <= USER_COUNT; id++) if (shardOf(id, a) !== shardOf(id, b)) moved++;
  return moved;
}

export const shardingScene: ConceptScene = {
  id: "sharding",
  title: "Splitting users across shards by key",
  intro: "10,000 users' orders are split across several databases (shards). The app picks the shard from the user id: hash(user_id) % N, so one user's rows always live on one shard. A request for one user's orders goes to that shard alone. Each shard runs 2 queries at a time. Slowed down.",
  width: 780,
  height: 420,
  controls: [
    { type: "count", id: "shards", label: "Shards", min: 2, max: 4 },
    { type: "toggle", id: "search", label: "Add searches across all users" },
    { type: "toggle", id: "hot", label: "One very popular user (hot key)" },
  ],
  defaults: { shards: 3, search: false, hot: false },
  layout(p: SceneParams) {
    const n = pnum(p, "shards");
    const hot = pbool(p, "hot");
    const counts = usersPerShard(n);
    const h = n === 4 ? 98 : n === 3 ? 108 : 110;
    const gap = n === 4 ? 8 : n === 3 ? 24 : 60;
    const top = (420 - (n * h + (n - 1) * gap)) / 2;
    const boxes: SceneBox[] = [
      { id: "users", kind: "users", label: "Users", detail: `${fmt(USER_COUNT)} accounts`, x: 20, y: 168, w: 140, h: 84 },
      { id: "app", kind: "app", label: "App (router)", detail: `shard = hash(user_id) % ${n}`, x: 230, y: 155, w: 210, h: 110 },
    ];
    const links: SceneLink[] = [{ id: "u-app", from: "users", to: "app", label: "HTTP" }];
    for (let i = 0; i < n; i++) {
      const holdsHot = hot && shardOf(HOT_USER, n) === i;
      boxes.push({ id: `s${i}`, kind: "database", label: `Shard ${i}`, detail: holdsHot ? `${fmt(counts[i]!)} users, incl. ${HOT_USER}` : `${fmt(counts[i]!)} of ${fmt(USER_COUNT)} users`, x: 540, y: top + i * (h + gap), w: 220, h });
      links.push({ id: `app-s${i}`, from: "app", to: `s${i}` });
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const n = pnum(p, "shards");
    const searchOn = pbool(p, "search");
    const hotOn = pbool(p, "hot");
    const shards = Array.from({ length: n }, () => new Station(world, SLOTS));
    const hotShard = shardOf(HOT_USER, n);
    let req = 0;
    let answered = 0;
    let totalMs = 0;
    let shardQueries = 0;
    let appNote = "waiting for requests";
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const other = n === 2 ? 3 : n - 1;
    world.log(`With ${n} shards, ${fmt(usersMoved(n, other))} of the ${fmt(USER_COUNT)} users sit on a different shard than with ${other}: changing N means moving their data.`);

    const answer = (started: number, label: string) =>
      world.send("u-app", "reply", USER_HOP, () => {
        answered++;
        totalMs += world.time - started;
      }, { reverse: true, label });

    const lookup = (uid: number, started: number) => {
      const s = shardOf(uid, n);
      appNote = `user ${uid} → shard ${s}`;
      if (hotOn && uid === HOT_USER) {
        if (shards[s]!.waiting.length >= 3) say("hot", 8000, `${Math.round(HOT_SHARE * 100)}% of requests are for user ${HOT_USER}, and hash(${HOT_USER}) % ${n} = ${s}, so all of them land on shard ${s}. Its line grows; the others have room.`);
      } else say("route", 10000, `User ${uid}: hash(${uid}) % ${n} = ${s}, so the router sends the query to shard ${s} only. No other shard is asked.`);
      shardQueries++;
      world.send(`app-s${s}`, "request", DB_HOP, () => {
        shards[s]!.serve(LOOKUP, () => {
          world.send(`app-s${s}`, "reply", DB_HOP, () => answer(started, "orders"), { reverse: true, label: "rows" });
        });
      }, { label: `user_id = ${uid}` });
    };

    const search = (id: number, started: number) => {
      appNote = `search → all ${n} shards`;
      say("search", 9000, `Request #${id} searches all users' orders: there is no user id to route by, so the router asks all ${n} shards and merges what they send back.`);
      let left = n;
      let firstBack = 0;
      for (let s = 0; s < n; s++) {
        shardQueries++;
        world.send(`app-s${s}`, "request", DB_HOP, () => {
          shards[s]!.serve(SEARCH, () => {
            world.send(`app-s${s}`, "reply", DB_HOP, () => {
              if (left === n) firstBack = world.time;
              left--;
              if (left > 0) return;
              const waited = world.time - firstBack;
              if (waited > 600) say("slowest", 9000, `Search #${id} waited ${sec(waited)} after its first shard answered: a search is only as fast as its slowest shard.`);
              world.after(MERGE, () => answer(started, "results"));
            }, { reverse: true, label: "matches" });
          });
        }, { label: "search" });
      }
    };

    world.every(GAP, () => {
      const id = ++req;
      const started = world.time;
      const isSearch = searchOn && world.random() < SEARCH_SHARE;
      const uid = isSearch ? 0 : hotOn && world.random() < HOT_SHARE ? HOT_USER : 1 + Math.floor(world.random() * USER_COUNT);
      world.send("u-app", "request", USER_HOP, () => (isSearch ? search(id, started) : lookup(uid, started)), { label: isSearch ? "search" : `user ${uid}` });
    }, 0.6);

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          users: { note: `${answered} answered` },
          app: { note: appNote, tone: "ok" },
        };
        const total = shards.reduce((a, s) => a + s.served + s.busy, 0);
        let busiest = 0;
        shards.forEach((st, i) => {
          const q = st.waiting.length;
          busiest = Math.max(busiest, st.served + st.busy);
          boxes[`s${i}`] = { queue: q, note: q ? `${q} waiting, ${st.served} done` : `${st.busy}/${SLOTS} running, ${st.served} done`, tone: q >= 4 ? "bad" : st.busy === SLOTS ? "busy" : st.busy ? "ok" : "idle" };
        });
        const longest = Math.max(...shards.map((s) => s.waiting.length));
        const share = total ? busiest / total : 0;
        const avg = answered ? totalMs / answered : 0;
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Longest line at a shard", value: String(longest), tone: longest >= 4 ? "bad" : undefined },
            { label: "Busiest shard's share of queries", value: total ? `${Math.round(share * 100)}%` : "–", tone: total >= 10 && share > 1 / n + 0.25 ? "bad" : undefined },
            { label: "Shard queries per request", value: req ? (shardQueries / Math.max(1, req)).toFixed(1) : "–" },
            { label: "Average answer time (slowed down)", value: answered ? sec(avg) : "–" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn on the very popular user: every request for that user hashes to the same shard, so its line grows while the other shards have room.", params: { hot: true, search: false, shards: 3 } },
    { text: "Then go to 4 shards with that popular user: the other shards get quieter, but the hot user's shard is still overloaded, because one key always maps to one shard.", params: { hot: true, search: false, shards: 4 } },
    { text: "Add searches across all users: a search has no user id to route by, so the router asks every shard and waits for the slowest before it can answer.", params: { search: true, hot: false, shards: 3 } },
    { text: "Searches with 4 shards: lookups spread thinner, but each search now costs 4 shard queries, one on every shard.", params: { search: true, hot: false, shards: 4 } },
  ],
};
