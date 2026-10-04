import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pstr } from "./types.ts";
import { Station, World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const HOP = 400; // users to the Node process
const POOL_HOP = 300; // handing a task to the pool and getting the result back (instant for real, slowed to be visible)
const DB_HOP = 300; // the process to the database
const JS = 60; // the request's own JavaScript on the event loop, before and after its I/O
const HASH = 2000; // one bcrypt hash: CPU work on a pool thread
const READ = 500; // reading a file from disk on a pool thread
const QUERY = 600; // the database's work
const LOGIN_GAP: Record<string, number> = { few: 3000, many: 560 }; // average ms between logins
const READ_GAP = 1400; // average ms between page requests that read a file
const QUERY_GAP = 1100; // average ms between requests that query the database
const JITTER = 0.8; // real traffic comes in bursts

type Kind = "login" | "read" | "query";

interface Req {
  n: number;
  kind: Kind;
  started: number;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const sizeOf = (p: SceneParams) => (pstr(p, "size") === "8" ? 8 : 4);

export const threadPoolScene: ConceptScene = {
  id: "thread-pool",
  title: "Node's thread pool fills up",
  intro: "One Node process on a machine with 8 CPU cores. Your JavaScript runs on the event loop; file reads, dns.lookup and some crypto, like bcrypt's async hash, run on libuv's thread pool: 4 threads unless UV_THREADPOOL_SIZE says otherwise. Database queries travel over network sockets, which don't use the pool. Slowed down; each dot is a task waiting for a thread.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "size", label: "UV_THREADPOOL_SIZE", options: [{ value: "4", label: "4 (default)" }, { value: "8", label: "8" }] },
    { type: "choice", id: "logins", label: "Logins (bcrypt hashes)", options: [{ value: "few", label: "Few" }, { value: "many", label: "Many" }] },
  ],
  defaults: { size: "4", logins: "few" },
  layout(p: SceneParams) {
    const size = sizeOf(p);
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "log in, load pages", x: 20, y: 150, w: 150, h: 100 },
        { id: "node", kind: "server", label: "Node process", detail: "event loop runs your JS", x: 240, y: 140, w: 200, h: 120 },
        { id: "pool", kind: "thread", label: "Thread pool", detail: size === 4 ? "libuv, 4 threads (default)" : "UV_THREADPOOL_SIZE=8", x: 530, y: 16, w: 230, h: 130 },
        { id: "db", kind: "database", label: "Database", detail: "network socket: no pool", x: 530, y: 276, w: 230, h: 110 },
      ],
      links: [
        { id: "users-node", from: "users", to: "node", label: "HTTP" },
        { id: "node-pool", from: "node", to: "pool", label: "tasks" },
        { id: "node-db", from: "node", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const size = sizeOf(p);
    const loop = new Station(world, 1);
    const pool = new Station(world, size);
    const running: Record<Kind, number> = { login: 0, read: 0, query: 0 };
    const waiting: Record<Kind, number> = { login: 0, read: 0, query: 0 };
    const waitSum: Record<Kind, number> = { login: 0, read: 0, query: 0 }; // time spent in the pool's line
    const waitCount: Record<Kind, number> = { login: 0, read: 0, query: 0 };
    const timeSum: Record<Kind, number> = { login: 0, read: 0, query: 0 }; // whole request, user to user
    const timeCount: Record<Kind, number> = { login: 0, read: 0, query: 0 };
    let id = 0;
    let answered = 0;
    let poolAwait = 0; // requests whose JavaScript is awaiting a pool task
    let dbAwait = 0; // requests awaiting the database
    let dbRunning = 0;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

    /** Hands a task to the pool; it runs when a thread is free, first come first served. */
    const toPool = (r: Req, ms: number, then: () => void) => {
      const login = r.kind === "login";
      world.send("node-pool", "request", POOL_HOP, () => {
        const queuedAt = world.time;
        const full = pool.busy >= pool.slots;
        if (full) {
          waiting[r.kind]++;
          if (login) say("hash-wait", 8000, `#${r.n}'s hash waits: all ${size} threads are taken, so only ${size} hashes or reads can run at once.`);
          else {
            const hashes = running.login;
            say("read-wait", 6000, `#${r.n}'s file read waits: ${hashes === size ? `all ${size} threads are hashing passwords` : `all ${size} threads are busy`}, and reads and hashes share one line.`);
          }
        } else if (login) say("hash", 10_000, `#${r.n} logs in: await bcrypt.hash runs on a pool thread, and the event loop moves on to other requests.`);
        else say("read", 10_000, `#${r.n} reads a file: fs.readFile needs a pool thread too. One is free, so the read starts at once.`);
        pool.acquire((release) => {
          if (full) waiting[r.kind]--;
          const waited = world.time - queuedAt;
          waitSum[r.kind] += waited;
          waitCount[r.kind]++;
          if (!login && waited > 600) say("read-waited", 8000, `#${r.n}'s file read gets a thread after ${sec(waited)} in line, for ${sec(READ)} of actual reading.`);
          running[r.kind]++;
          world.after(ms, () => {
            running[r.kind]--;
            release();
            world.send("node-pool", "reply", POOL_HOP, then, { reverse: true, label: login ? "hash done" : "file data" });
          });
        });
      }, { label: login ? `#${r.n} hash` : `#${r.n} read file` });
    };

    const reply = (r: Req) => world.send("users-node", "reply", HOP, () => {
      answered++;
      timeSum[r.kind] += world.time - r.started;
      timeCount[r.kind]++;
    }, { reverse: true, label: `#${r.n}` });

    const arrive = (kind: Kind) => {
      const r: Req = { n: ++id, kind, started: world.time };
      const label = kind === "login" ? `#${r.n} log in` : kind === "read" ? `#${r.n} page` : `#${r.n} feed`;
      world.send("users-node", "request", HOP, () => loop.serve(JS, () => {
        if (kind === "query") {
          dbAwait++;
          if (pool.busy >= pool.slots) say("db-full", 9000, `The pool is full, yet #${r.n}'s query goes straight out: database sockets are watched by the event loop, not the pool.`);
          else say("db", 12_000, `#${r.n}'s query goes out over an open network socket. Sockets don't use the pool, so it never waits behind the hashes.`);
          world.send("node-db", "request", DB_HOP, () => {
            dbRunning++;
            world.after(QUERY, () => {
              dbRunning--;
              world.send("node-db", "reply", DB_HOP, () => {
                dbAwait--;
                loop.serve(JS, () => reply(r));
              }, { reverse: true, label: "rows" });
            });
          }, { label: `#${r.n} SELECT` });
          return;
        }
        poolAwait++;
        toPool(r, kind === "login" ? HASH : READ, () => {
          poolAwait--;
          loop.serve(JS, () => reply(r));
        });
      }), { label });
    };

    world.every(LOGIN_GAP[pstr(p, "logins")] ?? LOGIN_GAP.few!, () => arrive("login"), JITTER);
    world.every(READ_GAP, () => arrive("read"), JITTER);
    world.every(QUERY_GAP, () => arrive("query"), JITTER);

    return {
      tick(dt: number) {
        world.advance(dt);
        const q = pool.waiting.length;
        const doing = [running.login ? `${running.login} hashing` : "", running.read ? `${running.read} reading a file` : ""].filter(Boolean).join(", ");
        const lined = [waiting.login ? plural(waiting.login, "hash", "hashes") : "", waiting.read ? plural(waiting.read, "read", "reads") : ""].filter(Boolean).join(", ");
        const avg = (sum: number, count: number) => (count ? sec(sum / count) : "–");
        const readWait = waitCount.read ? waitSum.read / waitCount.read : 0;
        const boxes: Record<string, BoxState> = {
          users: { note: `${answered} answered` },
          node: {
            slots: { total: 1, busy: loop.busy, label: "main thread" },
            note: poolAwait || dbAwait ? `awaiting: ${poolAwait} pool, ${dbAwait} DB` : "event loop free",
            tone: loop.busy ? "ok" : "idle",
          },
          pool: {
            slots: { total: size, busy: pool.busy, label: "threads" },
            queue: q,
            note: q ? `waiting: ${lined}` : doing || "idle",
            tone: q >= 3 ? "bad" : pool.busy === size ? "busy" : pool.busy ? "ok" : "idle",
          },
          db: { note: dbRunning ? `${plural(dbRunning, "query", "queries")} running` : "idle", tone: dbRunning ? "ok" : "idle" },
        };
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "File reads: average wait for a thread", value: avg(waitSum.read, waitCount.read), tone: readWait > 800 ? "bad" : undefined },
            { label: "Logins: average time", value: avg(timeSum.login, timeCount.login) },
            { label: "Database requests: average time", value: avg(timeSum.query, timeCount.query) },
            { label: "Answered", value: String(answered) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Many logins: hashes take all 4 threads, so file reads wait in the same line behind them, while database requests take as long as before, because sockets don't use the pool.", params: { size: "4", logins: "many" } },
    { text: "Raise UV_THREADPOOL_SIZE to 8 with many logins: the pool rarely runs out of threads, so file reads and logins stop waiting. It helps here because the machine has 8 cores to run those threads on.", params: { size: "8", logins: "many" } },
    { text: "Few logins with the default 4 threads: a hash or a file read nearly always finds a free thread, so nothing waits. The pool only hurts when it is full.", params: { size: "4", logins: "few" } },
  ],
};
