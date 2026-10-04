import type { BoxState, ConceptScene, Counter, SceneParams } from "./types.ts";
import { pnum, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const HOP = 400; // on every link
const ACCEPT = 150; // the API reading an upload
const WORK: [number, number] = [1200, 1800]; // a worker's time per job
const USERS = 4;
const PAUSE: [number, number] = [400, 1000]; // a user's pause between one upload's answer and the next upload
const LIMIT = 8; // most jobs a bounded queue holds
const JOB_MB = 2; // each waiting job keeps its upload in the queue
const RETRY_AFTER = 2000; // what the 503 tells the client to wait

type Mode = "none" | "wait" | "reject";

interface Upload {
  n: number;
  heldAt?: number;
}

interface Job {
  n: number;
  at: number; // when it joined the queue
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const backpressureScene: ConceptScene = {
  id: "backpressure",
  title: "A full queue that pushes back",
  intro: "Four users keep uploading files. For each upload the API adds a job to a queue and answers 202 Accepted; workers take jobs off the queue. With 2 workers, jobs are finished more slowly than uploads arrive. Each waiting job keeps its 2 MB upload in the queue. Slowed down; each envelope is a request or a job.",
  width: 780,
  height: 380,
  controls: [
    { type: "choice", id: "limit", label: "Queue size", options: [
      { value: "none", label: "No limit" },
      { value: "wait", label: "Max 8, API waits" },
      { value: "reject", label: "Max 8, API sends 503" },
    ] },
    { type: "count", id: "workers", label: "Workers", min: 1, max: 4 },
  ],
  defaults: { limit: "wait", workers: 2 },
  layout(p: SceneParams) {
    const mode = pstr(p, "limit") as Mode;
    const n = pnum(p, "workers");
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: `${USERS} users uploading`, x: 20, y: 140, w: 150, h: 90 },
        { id: "api", kind: "app", label: "API", detail: "adds a job per upload", x: 240, y: 125, w: 170, h: 120 },
        { id: "queue", kind: "queue", label: "Job queue", detail: mode === "none" ? "no limit" : mode === "wait" ? `max ${LIMIT} jobs, then API waits` : `max ${LIMIT} jobs, then 503`, x: 500, y: 20, w: 240, h: 120 },
        { id: "workers", kind: "worker", label: "Workers", detail: `${n} worker${n === 1 ? "" : "s"}, ~1.5 s per job`, x: 500, y: 250, w: 240, h: 110 },
      ],
      links: [
        { id: "u-api", from: "users", to: "api", label: "upload" },
        { id: "api-q", from: "api", to: "queue", label: "add job" },
        { id: "q-w", from: "queue", to: "workers", label: "take job" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const mode = pstr(p, "limit") as Mode;
    const n = pnum(p, "workers");
    const queue: Job[] = [];
    const held: Upload[] = []; // uploads the API is holding until the queue has room
    let adding = 0; // jobs on their way to the queue: their places are already taken
    let busy = 0;
    let retrying = 0; // users waiting out a Retry-After
    let id = 0;
    let done = 0;
    let refused = 0;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const full = () => mode !== "none" && queue.length + adding >= LIMIT;

    const nextUpload = () => world.after(PAUSE[0] + world.random() * (PAUSE[1] - PAUSE[0]), () => upload({ n: ++id }));

    /** Free workers take the oldest jobs; each job taken frees a place for an upload the API is holding. */
    const dispatch = () => {
      while (busy < n && queue.length > 0) {
        const job = queue.shift()!;
        busy++;
        world.send("q-w", "request", HOP, () => world.after(WORK[0] + world.random() * (WORK[1] - WORK[0]), () => {
          busy--;
          done++;
          dispatch();
        }), { label: `job #${job.n}` });
        const next = held.shift();
        if (next) {
          say("admit", 6000, `A worker took a job, so #${next.n} gets a place after waiting ${sec(world.time - next.heldAt!)}. Its user's next upload starts later: the slowdown reaches the source.`);
          add(next);
        }
      }
    };

    /** Adds the job to the queue, then answers 202. */
    const add = (u: Upload) => {
      adding++;
      world.send("api-q", "request", HOP, () => {
        adding--;
        queue.push({ n: u.n, at: world.time });
        const ahead = queue.length - 1;
        if (busy < n) say("ok", 8000, `Job #${u.n} is added and a free worker takes it at once.`);
        else if (mode === "none" && ahead >= LIMIT) {
          say("grow", 5000, `Job #${u.n} joins a line of ${ahead}: uploads arrive faster than ${n === 1 ? "one worker finishes" : `${n} workers finish`} jobs, and nothing slows the API down.`);
          say("mem", 9000, `The queue holds ${queue.length} jobs (${queue.length * JOB_MB} MB). Every user got 202 at once, but the oldest job has waited ${sec(world.time - queue[0]!.at)}.`);
        }
        dispatch();
        world.send("u-api", "reply", HOP, nextUpload, { reverse: true, label: "202" });
      }, { label: `job #${u.n}` });
    };

    const upload = (u: Upload) => {
      world.send("u-api", "request", HOP, () => world.after(ACCEPT, () => {
        if (!full()) {
          add(u);
          return;
        }
        if (mode === "wait") {
          u.heldAt = world.time;
          held.push(u);
          say("held", 4000, `#${u.n} is held: the queue is full (${LIMIT} jobs). The API waits for room before adding it, so this user waits too.`);
          return;
        }
        refused++;
        say("refuse", 4000, `#${u.n} gets 503 with Retry-After: 2. The queue is full, so the API refuses instead of piling up; the user tries again in 2 s.`);
        world.send("u-api", "error", HOP, () => {
          retrying++;
          world.after(RETRY_AFTER, () => {
            retrying--;
            upload(u);
          });
        }, { reverse: true, label: "503" });
      }), { label: `upload #${u.n}` });
    };

    for (let i = 0; i < USERS; i++) world.after(200 + i * 450 + world.random() * 300, () => upload({ n: ++id }));

    return {
      tick(dt: number) {
        world.advance(dt);
        const q = queue.length;
        const oldest = q ? world.time - queue[0]!.at : 0;
        const users: BoxState = mode === "wait" && held.length
          ? { note: `${held.length} waiting for room`, tone: "busy" }
          : mode === "reject" && retrying
            ? { note: `${retrying} retrying in 2 s`, tone: "busy" }
            : { note: "uploading" };
        const api: BoxState = mode === "none"
          ? { note: "accepts everything", tone: "ok" }
          : mode === "wait"
            ? held.length ? { note: `holding ${held.length}: queue full`, tone: "busy" } : { note: "adds jobs, answers 202", tone: "ok" }
            : refused ? { note: `${refused} refused with 503`, tone: full() ? "busy" : "ok" } : { note: "adds jobs, answers 202", tone: "ok" };
        const boxes: Record<string, BoxState> = {
          users,
          api,
          queue: {
            ...(mode === "none" ? { queue: q } : { slots: { total: LIMIT, busy: Math.min(LIMIT, q), label: "places" } }),
            note: q ? `${q} waiting, oldest ${sec(oldest)}` : "empty",
            tone: q > LIMIT ? "bad" : q >= LIMIT ? "busy" : q ? "ok" : "idle",
          },
          workers: { slots: { total: n, busy, label: "workers" }, note: `${done} jobs done`, tone: busy === n ? "busy" : busy ? "ok" : "idle" },
        };
        const counters: Counter[] = [
          { label: "Jobs in the queue", value: String(q), tone: q > LIMIT ? "bad" : undefined },
          { label: "Memory held by the queue", value: `${q * JOB_MB} MB`, tone: q > LIMIT ? "bad" : undefined },
          { label: "Oldest job has waited", value: sec(oldest), tone: oldest > 10000 ? "bad" : undefined },
          { label: "Jobs done", value: String(done) },
        ];
        return { boxes, tokens: world.tokens(), counters, log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Remove the limit: the API accepts every upload at once, so the queue, its memory and the oldest job's wait keep growing, yet the workers finish jobs no faster than before.", params: { limit: "none", workers: 2 } },
    { text: "Refuse with 503 when full: the queue never holds more than 8 jobs, and users whose upload is refused try again after the Retry-After delay.", params: { limit: "reject", workers: 2 } },
    { text: "Use 4 workers: together they keep up with the uploads, so the queue rarely fills and users rarely wait for room. Push back only matters when consumers fall behind.", params: { limit: "wait", workers: 4 } },
    { text: "One worker, still with the limit: memory and waits stay capped, but users spend much of their time waiting for room. A limit protects the system; only more workers get more done.", params: { limit: "wait", workers: 1 } },
  ],
};
