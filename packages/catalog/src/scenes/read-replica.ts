import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pnum, pstr } from "./types.ts";
import { Station, World } from "./world.ts";

// Scene timings (ms), slowed down to watch. Real replication lag is usually milliseconds,
// sometimes seconds when a replica is busy or far away.
const USER_HOP = 400; // users to the app
const DB_HOP = 300; // the app to a database
const STREAM_HOP = 450; // the primary streaming a change to a replica
const READ = 1000; // a feed query
const WRITE = 600; // saving a post
const SLOTS = 2; // queries each database runs at once
const APPLY: Record<string, number> = { low: 150, high: 3500 }; // from receiving a change to applying it
const USERS = 10;
const PAUSE: [number, number] = [600, 1400]; // a user reads, then pauses before the next action
const POST_SHARE = 0.2; // share of actions that are a new post (the rest are reads)

interface User {
  n: number;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const readReplicaScene: ConceptScene = {
  id: "read-replica",
  title: "A primary for writes, replicas for reads",
  intro: "Ten users read a feed and sometimes post. The app sends every write to the primary, which saves it and streams the change to each replica; the replicas apply it a moment later and serve the reads. Right after posting, a user reloads to see their post. Each database runs 2 queries at a time. Slowed down.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "lag", label: "Replication lag", options: [{ value: "low", label: "Low" }, { value: "high", label: "High" }] },
    { type: "count", id: "replicas", label: "Replicas", min: 1, max: 3 },
    { type: "toggle", id: "ownReads", label: "Read your own posts from the primary" },
  ],
  defaults: { lag: "low", replicas: 2, ownReads: false },
  layout(p: SceneParams) {
    const n = pnum(p, "replicas");
    const h = 110;
    const gap = n === 3 ? 20 : 40;
    const top = (400 - (n * h + (n - 1) * gap)) / 2;
    const boxes: SceneBox[] = [
      { id: "users", kind: "users", label: "Users", detail: `${USERS} people`, x: 20, y: 263, w: 140, h: 84 },
      { id: "app", kind: "app", label: "App", detail: "routes reads and writes", x: 230, y: 250, w: 190, h: 110 },
      { id: "primary", kind: "database", label: "Primary", detail: "takes every write", x: 230, y: 30, w: 190, h: 110 },
    ];
    const links: SceneLink[] = [
      { id: "u-app", from: "users", to: "app", label: "HTTP" },
      { id: "app-primary", from: "app", to: "primary", label: "writes" },
    ];
    for (let i = 0; i < n; i++) {
      boxes.push({ id: `r${i + 1}`, kind: "database", label: `Replica ${i + 1}`, detail: "a copy that serves reads", x: 540, y: top + i * (h + gap), w: 220, h });
      links.push({ id: `p-r${i + 1}`, from: "primary", to: `r${i + 1}`, label: i === 0 ? "changes" : undefined, persistent: true });
      links.push({ id: `app-r${i + 1}`, from: "app", to: `r${i + 1}`, label: i === n - 1 ? "reads" : undefined });
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const n = pnum(p, "replicas");
    const lagMs = APPLY[pstr(p, "lag")] ?? APPLY.low!;
    const ownReads = pbool(p, "ownReads");
    const primary = new Station(world, SLOTS);
    const replicas = Array.from({ length: n }, () => new Station(world, SLOTS));
    const applied = Array.from({ length: n }, () => new Set<number>());
    const pendingApply = Array.from({ length: n }, () => 0);
    let committed = 0; // posts saved on the primary
    let nextRead = 0; // round robin over replicas
    let reads = 0;
    let readMs = 0;
    let primaryReads = 0;
    let missing = 0;
    let missFlash = -1;
    let allAppliedSaid = false;
    let appNote = "starting";
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const pause = () => PAUSE[0] + world.random() * (PAUSE[1] - PAUSE[0]);

    /** The primary streams a committed post to every replica, which applies it after the lag. */
    const stream = (post: number) => {
      for (let i = 0; i < n; i++) {
        world.send(`p-r${i + 1}`, "push", STREAM_HOP, () => {
          pendingApply[i]!++;
          world.after(lagMs, () => {
            pendingApply[i]!--;
            applied[i]!.add(post);
            if (!allAppliedSaid && applied.every((s) => s.has(post))) {
              allAppliedSaid = true;
              world.log(`Every replica has now applied post #${post}. Each one replays every write, so replicas add read capacity, not write capacity.`);
            }
          });
        }, { label: `post #${post}` });
      }
    };

    /** A feed read. `own` is the post this user just made, if this is the reload right after it. */
    const read = (u: User, own?: number) => {
      const started = world.time;
      const toPrimary = own !== undefined && ownReads;
      const r = toPrimary ? -1 : nextRead++ % n;
      const link = toPrimary ? "app-primary" : `app-r${r + 1}`;
      const db = toPrimary ? primary : replicas[r]!;
      const where = toPrimary ? "the primary" : `replica ${r + 1}`;
      world.send("u-app", "request", USER_HOP, () => {
        appNote = own !== undefined ? `reload → ${toPrimary ? "primary" : `replica ${r + 1}`}` : `read → replica ${r + 1}`;
        if (toPrimary) {
          primaryReads++;
          say("own", 9000, `User ${u.n} reloads right after posting, so the app sends this read to the primary, which always has the post.`);
        }
        world.send(link, "request", DB_HOP, () => {
          if (!toPrimary && db.busy >= SLOTS) say("line", 9000, `Reads wait in line at replica ${r + 1}: both of its query slots are busy. More replicas would share the reads.`);
          db.acquire((release) => {
            // The query sees what this database has applied when it starts.
            const sees = own === undefined || toPrimary || applied[r]!.has(own);
            if (own !== undefined && !toPrimary) {
              if (sees) say("saw", 12000, `User ${u.n} reloads right after posting; replica ${r + 1} has already applied post #${own}, so it shows up.`);
              else say("miss", 4000, `User ${u.n} reloads right after posting, but ${where} hasn't applied post #${own} yet, so the feed comes back without it.`);
            }
            world.after(READ, () => {
              release();
              world.send(link, sees ? "reply" : "empty", DB_HOP, () => {
                world.send("u-app", sees ? "reply" : "empty", USER_HOP, () => {
                  reads++;
                  readMs += world.time - started;
                  if (!sees) {
                    missing++;
                    missFlash = world.time + 1800;
                  }
                  world.after(pause(), () => act(u));
                }, { reverse: true, label: sees ? "feed with your post" : "feed without your post" });
              }, { reverse: true, label: sees ? "rows" : `no post #${own}` });
            });
          });
        }, { label: "SELECT feed" });
      }, { label: own !== undefined ? "reload after posting" : "GET /feed" });
    };

    const post = (u: User) => {
      world.send("u-app", "request", USER_HOP, () => {
        appNote = "post → primary";
        world.send("app-primary", "request", DB_HOP, () => {
          primary.acquire((release) => world.after(WRITE, () => {
            release();
            const id = ++committed;
            if (id === 1) world.log(`User ${u.n} posts: the write goes to the primary, which saves it and streams the change to every replica.`);
            stream(id);
            world.send("app-primary", "reply", DB_HOP, () => {
              world.send("u-app", "reply", USER_HOP, () => read(u, id), { reverse: true, label: "posted" });
            }, { reverse: true, label: "saved" });
          }));
        }, { label: "INSERT post" });
      }, { label: "POST" });
    };

    const act = (u: User) => (world.random() < POST_SHARE ? post(u) : read(u));

    for (let i = 0; i < USERS; i++) world.after(200 + i * 300 + world.random() * 200, () => act({ n: i + 1 }));

    const dbState = (st: Station, note: string): BoxState => {
      const q = st.waiting.length;
      return { slots: { total: SLOTS, busy: st.busy, label: "query slots" }, queue: q, note, tone: q >= 4 ? "bad" : st.busy === SLOTS ? "busy" : st.busy ? "ok" : "idle" };
    };

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          users: world.time < missFlash ? { note: "can't see own post", tone: "bad" } : { note: `${reads} reads answered` },
          app: { note: appNote },
          primary: dbState(primary, `${committed} posts saved${primaryReads ? `, ${primaryReads} reads` : ""}`),
        };
        replicas.forEach((st, i) => {
          const behind = committed - applied[i]!.size;
          boxes[`r${i + 1}`] = dbState(st, behind ? `behind by ${behind} post${behind === 1 ? "" : "s"}` : `up to date, ${applied[i]!.size} posts`);
        });
        const avg = reads ? readMs / reads : 0;
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Average read time (slowed down)", value: reads ? sec(avg) : "–", tone: reads && avg > 4000 ? "bad" : undefined },
            { label: "Reads sent to the primary", value: String(primaryReads) },
            { label: "Writes, all on the primary", value: String(committed) },
            { label: "Reloads missing the user's own post", value: String(missing), tone: missing ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Set replication lag to High: a user who posts and reloads at once often gets a feed without their post, because the replica they read from hasn't applied it yet.", params: { lag: "high", ownReads: false } },
    { text: "Keep the lag High and read your own posts from the primary: the reload right after posting goes to the primary, which always has the post, so none go missing.", params: { lag: "high", ownReads: true } },
    { text: "Drop to 1 replica: every read lines up at it and reads slow down. Go to 3 and the reads spread out, while the primary still takes every write either way.", params: { replicas: 1 } },
  ],
};
