import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { Station, World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const USER_HOP = 400;
const DB_HOP = 300; // one way to the database
const QUERY = 400; // the database's work; your server holds no CPU while it runs
const POOL_HOP = 300; // handing a task to a pool thread (instant for real, slowed to be visible)
const CPU = 80; // JavaScript a quick request runs: once to start its query, once to send the response
const HASH = 2000; // a password hash: CPU-heavy
const HEAVY_SHARE = 0.3; // share of requests that hash a password, when turned on
const THREADS = 4; // libuv's default thread pool size
const PROCESSES = 4;
/** Each user clicks, waits for the answer, pauses, and clicks again, so traffic can never flood. */
const TRAFFIC = {
  light: { users: 4, pause: [900, 2100] },
  busy: { users: 12, pause: [300, 900] },
} as const;

type Model = "event-loop" | "thread-pool" | "cluster";

interface Req {
  n: number;
  heavy: boolean;
  proc: number;
  wait: number; // total time spent waiting in a line (event loop or thread pool)
}

interface Running {
  req: Req;
  what: string;
  heavy: boolean;
}

const procId = (model: Model, i: number) => (model === "cluster" ? `p${i + 1}` : "node");
const traffic = (p: SceneParams) => (pstr(p, "traffic") === "busy" ? TRAFFIC.busy : TRAFFIC.light);
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const concurrencyScene: ConceptScene = {
  id: "concurrency-models",
  title: "One event loop, a thread pool, or several processes",
  intro: "Node runs your JavaScript on one main thread, the event loop: each request's code takes its turn there. While a request waits for the database the loop is free for others. A password hash is different: done synchronously, it holds the loop and everyone behind it waits. Slowed down; each dot in a box is a request waiting its turn.",
  width: 780,
  height: 410,
  controls: [
    { type: "choice", id: "model", label: "Server runs", options: [
      { value: "event-loop", label: "Event loop only" },
      { value: "thread-pool", label: "Heavy work on thread pool" },
      { value: "cluster", label: "4 processes" },
    ] },
    { type: "toggle", id: "heavy", label: "Include CPU-heavy requests" },
    { type: "choice", id: "traffic", label: "Traffic", options: [{ value: "light", label: "Light" }, { value: "busy", label: "Busy" }] },
  ],
  defaults: { model: "event-loop", heavy: false, traffic: "light" },
  layout(p: SceneParams) {
    const model = pstr(p, "model") as Model;
    const boxes: SceneBox[] = [
      { id: "users", kind: "users", label: "Users", detail: `${traffic(p).users} people`, x: 20, y: 165, w: 150, h: 80 },
    ];
    const links: SceneLink[] = [];
    if (model === "cluster") {
      for (let i = 0; i < PROCESSES; i++) {
        const id = procId(model, i);
        boxes.push({ id, kind: "server", label: `Process ${i + 1}`, detail: "its own event loop", x: 250, y: 6 + i * 102, w: 210, h: 92 });
        links.push({ id: `u-${id}`, from: "users", to: id }, { id: `${id}-db`, from: id, to: "db" });
      }
      boxes.push({ id: "db", kind: "database", label: "Database", detail: "over the network", x: 590, y: 155, w: 170, h: 100 });
      return { boxes, links };
    }
    boxes.push(
      { id: "node", kind: "server", label: "Node process", detail: "event loop on 1 main thread", x: 250, y: 140, w: 230, h: 130 },
      { id: "db", kind: "database", label: "Database", detail: "over the network", x: 590, y: 40, w: 170, h: 90 },
      { id: "pool", kind: "thread", label: "Thread pool", detail: `libuv, ${THREADS} threads`, x: 590, y: 260, w: 170, h: 120 },
    );
    links.push(
      { id: "u-node", from: "users", to: "node", label: "HTTP" },
      { id: "node-db", from: "node", to: "db", label: "SQL" },
      { id: "node-pool", from: "node", to: "pool" },
    );
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const model = pstr(p, "model") as Model;
    const heavyOn = pbool(p, "heavy");
    const { users, pause } = traffic(p);
    const procs = model === "cluster" ? PROCESSES : 1;
    const loops = Array.from({ length: procs }, () => new Station(world, 1));
    const running: (Running | undefined)[] = Array.from({ length: procs }, () => undefined);
    const busyMs = Array.from({ length: procs }, () => 0);
    const ioWaiting = Array.from({ length: procs }, () => 0); // this process's requests waiting on the database
    const pool = new Station(world, THREADS);
    let dbRunning = 0;
    let id = 0;
    let rr = 0;
    let answered = 0;
    let quickWaitSum = 0;
    let quickDone = 0;
    let longest = 0;
    const lastSaid = new Map<string, number>();
    const blamed = new Set<number>(); // hashes we already explained a wait for

    /** Logs at most once per `gap` ms for the same kind of event, so the log stays readable. */
    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const loopName = (i: number) => (model === "cluster" ? `process ${i + 1}'s event loop` : "the event loop");

    /** Queues a piece of JavaScript on the request's event loop; it runs when the loop is free. */
    const onLoop = (r: Req, ms: number, what: string, heavy: boolean, then: () => void, started?: () => void) => {
      const i = r.proc;
      const queuedAt = world.time;
      const blocker = running[i];
      if (blocker?.heavy && !blamed.has(blocker.req.n)) {
        blamed.add(blocker.req.n);
        say("hash-wait", 4000, `#${r.n} is ready but has to wait: ${loopName(i)} is busy hashing #${blocker.req.n}.`);
      }
      loops[i]!.acquire((release) => {
        r.wait += world.time - queuedAt;
        longest = Math.max(longest, r.wait);
        running[i] = { req: r, what, heavy };
        started?.();
        world.after(ms, () => {
          running[i] = undefined;
          busyMs[i]! += ms;
          release();
          then();
        });
      });
    };

    const reply = (r: Req) => {
      world.send(`u-${procId(model, r.proc)}`, "reply", USER_HOP, () => {
        answered++;
        if (!r.heavy) {
          quickWaitSum += r.wait;
          quickDone++;
          say("answered", 7000, r.wait < 50
            ? `#${r.n} is answered without waiting: the event loop was free each time its code was ready.`
            : `#${r.n} is answered after ${sec(r.wait)} in line for ${loopName(r.proc)}, for under 0.2 s of its own work.`);
        }
        world.after(pause[0] + world.random() * (pause[1] - pause[0]), click);
      }, { reverse: true, label: `#${r.n}` });
    };

    const quick = (r: Req) => {
      const pid = procId(model, r.proc);
      onLoop(r, CPU, `#${r.n}: handler runs`, false, () => {
        ioWaiting[r.proc]!++;
        const io = ioWaiting.reduce((a, b) => a + b, 0);
        if (io >= 3) say("io", 12000, `${io} requests are waiting on the database at once, and none of them holds the event loop: async I/O doesn't block it.`);
        else say("io-first", 600000, `#${r.n} waits for the database. The event loop isn't held while it waits, so it can serve other requests.`);
        world.send(`${pid}-db`, "request", DB_HOP, () => {
          dbRunning++;
          world.after(QUERY, () => {
            dbRunning--;
            world.send(`${pid}-db`, "reply", DB_HOP, () => {
              ioWaiting[r.proc]!--;
              onLoop(r, CPU, `#${r.n}: sends response`, false, () => reply(r));
            }, { reverse: true, label: "rows" });
          });
        }, { label: "SELECT" });
      });
    };

    const heavy = (r: Req) => {
      if (model !== "thread-pool") {
        // bcrypt.hashSync: the hash runs inside the request's own JavaScript, on the event loop.
        const started = () => say("hash-start", 4000, model === "cluster"
          ? `#${r.n} runs bcrypt.hashSync on process ${r.proc + 1}: that process's line waits, the other ${PROCESSES - 1} keep serving.`
          : `#${r.n} runs bcrypt.hashSync on the event loop: until the hash is done, nothing else in this process can run.`);
        onLoop(r, CPU + HASH, `hashSync #${r.n}: others wait`, true, () => {
          // release() has already started the next one in line, so count it too.
          const behind = loops[r.proc]!.waiting.length + (running[r.proc] ? 1 : 0);
          if (behind) say("hash-done", 4000, behind === 1
            ? `#${r.n}'s hash is done, so the request waiting behind it can finally run.`
            : `#${r.n}'s hash is done. The ${behind} requests waiting behind it now run, one at a time.`);
          reply(r);
        }, started);
        return;
      }
      // await bcrypt.hash: the loop only starts it; a pool thread does the hashing.
      onLoop(r, CPU, `#${r.n}: hands hash to pool`, false, () => {
        say("pool", 9000, `#${r.n} calls bcrypt.hash: a pool thread does the hashing and the event loop moves on to other requests.`);
        world.send("node-pool", "request", POOL_HOP, () => {
          const queuedAt = world.time;
          if (pool.busy >= pool.slots) say("pool-full", 6000, `#${r.n}'s hash waits: all ${THREADS} pool threads are busy, and only ${THREADS} hashes can run at once.`);
          pool.acquire((release) => {
            r.wait += world.time - queuedAt;
            longest = Math.max(longest, r.wait);
            world.after(HASH, () => {
              release();
              world.send("node-pool", "reply", POOL_HOP, () => onLoop(r, CPU, `#${r.n}: sends response`, false, () => reply(r)), { reverse: true, label: "hash" });
            });
          });
        }, { label: `hash #${r.n}` });
      });
    };

    const click = () => {
      const r: Req = { n: ++id, heavy: heavyOn && world.random() < HEAVY_SHARE, proc: rr++ % procs, wait: 0 };
      world.send(`u-${procId(model, r.proc)}`, "request", USER_HOP, () => (r.heavy ? heavy(r) : quick(r)), { label: `#${r.n}${r.heavy ? " hash" : ""}` });
    };

    for (let u = 0; u < users; u++) world.after(200 + u * 350 + world.random() * 300, click);

    const loopState = (i: number): BoxState => {
      const run = running[i];
      const q = loops[i]!.waiting.length;
      const io = ioWaiting[i]!;
      return {
        // Four stacked process boxes have no room for a slot row; their tone shows when they are busy.
        slots: model === "cluster" ? undefined : { total: 1, busy: run ? 1 : 0, label: "main thread" },
        queue: q,
        note: run ? run.what : io ? `free, ${io} awaiting the DB` : "free",
        tone: q >= 4 ? "bad" : run?.heavy ? "busy" : run ? "ok" : "idle",
      };
    };

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          users: { note: `${answered} answered` },
          db: { note: dbRunning ? `${dbRunning} ${dbRunning === 1 ? "query" : "queries"} running` : "idle", tone: dbRunning ? "ok" : "idle" },
        };
        for (let i = 0; i < procs; i++) boxes[procId(model, i)] = loopState(i);
        if (model === "thread-pool") {
          const q = pool.waiting.length;
          boxes.pool = { slots: { total: THREADS, busy: pool.busy, label: "threads" }, queue: q, note: q ? `all busy, ${q} waiting` : pool.busy ? `${pool.busy} hashing` : "idle", tone: q ? "busy" : pool.busy ? "ok" : "idle" };
        } else if (model === "event-loop") {
          boxes.pool = { slots: { total: THREADS, busy: 0, label: "threads" }, note: heavyOn ? "unused by hashSync" : "idle", tone: "idle" };
        }
        const avg = quickDone ? quickWaitSum / quickDone : 0;
        const busyShare = world.time ? busyMs.reduce((a, b) => a + b, 0) / (world.time * procs) : 0;
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Average wait, quick requests", value: quickDone ? sec(avg) : "–", tone: quickDone ? (avg > 600 ? "bad" : "good") : undefined },
            { label: "Longest wait", value: sec(longest), tone: longest > 1500 ? "bad" : undefined },
            { label: "Answered", value: String(answered) },
            { label: model === "cluster" ? "Event loops busy" : "Event loop busy", value: `${Math.round(Math.min(1, busyShare) * 100)}%`, tone: busyShare > 0.85 ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Busy traffic, no heavy requests: many requests wait on the database at the same time, yet quick requests barely wait for the event loop, because waiting on I/O holds no CPU.", params: { model: "event-loop", heavy: false, traffic: "busy" } },
    { text: "Turn on CPU-heavy requests: each synchronous password hash holds the event loop for 2 s, and every request behind it waits in line, even the quick ones.", params: { model: "event-loop", heavy: true, traffic: "light" } },
    { text: "Move the heavy work to the thread pool: the event loop only starts each hash, so quick requests stop waiting. Under busy traffic all 4 threads are sometimes taken, and the next hash waits for one.", params: { model: "thread-pool", heavy: true, traffic: "busy" } },
    { text: "Run 4 processes instead: each has its own event loop, so a hash blocks only the requests sent to that process, but those still wait for it to finish.", params: { model: "cluster", heavy: true, traffic: "busy" } },
  ],
};
