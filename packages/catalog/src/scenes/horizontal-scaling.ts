import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pnum, pstr } from "./types.ts";
import { Station, World } from "./world.ts";
import { plural, secs, throttledLog } from "./traffic-common.ts";

const HOP = 400; // users, balancer and instances, slowed down to watch
const DB_HOP = 300;
const CPU = 1000; // an instance's own work per request, on its one event loop
const QUERY = 1200; // the database's work per request
const DB_SLOTS = 4; // queries the database runs at once
const REFUSE = 400; // an instance answering 401: no database trip
const WINDOW = 10_000; // answers per second are counted over the last 10 s
const TRAFFIC = {
  normal: { users: 6, think: [1500, 3500] },
  rush: { users: 24, think: [600, 1400] },
} as const;

interface User {
  k: number;
  /** Where this user's login lives: an instance's memory, the database, or nowhere yet. */
  session: number | "db" | undefined;
}

const trafficOf = (p: SceneParams) => (pstr(p, "traffic") === "rush" ? TRAFFIC.rush : TRAFFIC.normal);

export const horizontalScalingScene: ConceptScene = {
  id: "horizontal-scaling",
  title: "More copies of the server, one shared database",
  intro: "Users log in once, then keep clicking. A load balancer spreads their requests over identical app instances; each instance works through one request's code at a time, then makes one trip to the shared database, which runs 4 queries at once. Slowed down; dots in a box are requests waiting their turn.",
  width: 780,
  height: 420,
  controls: [
    { type: "count", id: "instances", label: "App instances", min: 1, max: 4 },
    { type: "choice", id: "traffic", label: "Traffic", options: [{ value: "normal", label: "Normal" }, { value: "rush", label: "Rush hour" }] },
    { type: "toggle", id: "memory", label: "Keep logins in each instance's memory" },
  ],
  defaults: { instances: 2, traffic: "normal", memory: false },
  layout(p: SceneParams) {
    const n = pnum(p, "instances");
    const h = 88;
    const gap = n >= 4 ? 16 : n === 3 ? 40 : 70;
    const top = (420 - (n * h + (n - 1) * gap)) / 2;
    const boxes: SceneBox[] = [
      { id: "users", kind: "users", label: "Users", detail: `${trafficOf(p).users} people`, x: 20, y: 24, w: 160, h: 80 },
      { id: "lb", kind: "balancer", label: "Load balancer", detail: "takes turns", x: 20, y: 165, w: 160, h: 90 },
      { id: "db", kind: "database", label: "Database", detail: `runs ${DB_SLOTS} queries at a time`, x: 550, y: 150, w: 210, h: 120 },
    ];
    const links: SceneLink[] = [{ id: "users-lb", from: "users", to: "lb", label: "HTTP" }];
    for (let i = 0; i < n; i++) {
      boxes.push({ id: `i${i + 1}`, kind: "server", label: `Instance ${i + 1}`, detail: pbool(p, "memory") ? "logins in its own memory" : "logins in the database", x: 260, y: top + i * (h + gap), w: 200, h });
      links.push({ id: `lb-i${i + 1}`, from: "lb", to: `i${i + 1}` }, { id: `i${i + 1}-db`, from: `i${i + 1}`, to: "db", label: i === 0 ? "SQL" : undefined });
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const n = pnum(p, "instances");
    const memory = pbool(p, "memory");
    const traffic = trafficOf(p);
    const say = throttledLog(world);
    const inst = Array.from({ length: n }, () => new Station(world, 1));
    const db = new Station(world, DB_SLOTS);
    const users: User[] = Array.from({ length: traffic.users }, (_, k) => ({ k: k + 1, session: undefined }));
    const answeredAt: number[] = [];
    let id = 0;
    let turn = 0;
    let answered = 0;
    let logouts = 0;
    let totalMs = 0;

    const think = (u: User) => world.after(traffic.think[0] + world.random() * (traffic.think[1] - traffic.think[0]), () => click(u));

    const back = (i: number, kind: "reply" | "error", label: string, then: () => void) =>
      world.send(`lb-i${i + 1}`, kind, HOP, () => world.send("users-lb", kind, HOP, then, { reverse: true, label }), { reverse: true, label });

    const click = (u: User) => {
      const r = ++id;
      const login = u.session === undefined;
      const started = world.time;
      const label = login ? `#${r} POST /login` : `#${r} GET /feed`;
      world.send("users-lb", "request", HOP, () => {
        const i = turn++ % n;
        world.send(`lb-i${i + 1}`, "request", HOP, () => {
          const station = inst[i]!;
          if (!login && memory && u.session !== i) {
            // The login lives in another instance's memory: this one has never heard of it.
            const home = Number(u.session) + 1;
            station.serve(REFUSE, () => {
              logouts++;
              u.session = undefined;
              say("stranger", 5000, `Instance ${i + 1} has no session for user ${u.k}: it lives in Instance ${home}'s memory. So #${r} gets 401, log in again.`);
              back(i, "error", "401 log in again", () => think(u));
            });
            return;
          }
          if (!login) {
            say("served", 9000, memory
              ? `#${r} lands on Instance ${i + 1}, where user ${u.k} logged in, so it works this time.`
              : `#${r} for user ${u.k} goes to Instance ${i + 1}: any instance can serve any user, since logins live in the database.`);
          }
          const q = station.waiting.length;
          if (q >= 3) say("inst-line", 8000, `${q} requests wait for Instance ${i + 1}: it works through one request's code at a time, and they arrive faster than that.`);
          station.serve(CPU, () => {
            world.send(`i${i + 1}-db`, "request", DB_HOP, () => {
              if (db.busy >= DB_SLOTS) {
                say("db-full", 7000, n >= 3
                  ? `#${r} waits at the database: all ${DB_SLOTS} query slots are busy, and adding instances can't change that.`
                  : `#${r} waits at the database: all ${DB_SLOTS} query slots are busy.`);
              }
              db.serve(QUERY, () => world.send(`i${i + 1}-db`, "reply", DB_HOP, () => {
                if (login) {
                  u.session = memory ? i : "db";
                  say(memory ? "login-mem" : "login-db", 12000, memory
                    ? `User ${u.k} logs in on Instance ${i + 1}: the session is kept in that instance's memory, nowhere else.`
                    : `User ${u.k} logs in: the session is saved in the database, so every instance can find it.`);
                }
                back(i, "reply", login ? "logged in" : "200 OK", () => {
                  answered++;
                  answeredAt.push(world.time);
                  totalMs += world.time - started;
                  think(u);
                });
              }, { reverse: true, label: "rows" }));
            }, { label: login ? "check password" : memory ? "SELECT feed" : "session + feed" });
          });
        }, { label });
      }, { label });
    };

    users.forEach((u, k) => world.after(200 + k * (traffic.users > 10 ? 160 : 500) + world.random() * 300, () => click(u)));
    world.after(100, () => world.log(n === 1
      ? "One instance: every request goes to it."
      : `The balancer spreads requests over ${n} identical instances, taking turns.`));

    return {
      tick(dt: number) {
        world.advance(dt);
        while (answeredAt.length && answeredAt[0]! <= world.time - WINDOW) answeredAt.shift();
        const span = Math.min(WINDOW, world.time) / 1000;
        const rate = span > 0 ? answeredAt.length / span : 0;
        const dq = db.waiting.length;
        const boxes: Record<string, BoxState> = {
          users: { note: `${answered} answered` },
          lb: { note: n === 1 ? "only one to choose" : `next: Instance ${(turn % n) + 1}` },
          db: { slots: { total: DB_SLOTS, busy: db.busy, label: "query slots" }, queue: dq, note: dq ? `${dq} waiting` : `${db.served} queries done`, tone: dq >= 4 ? "bad" : db.busy === DB_SLOTS ? "busy" : db.busy ? "ok" : "idle" },
        };
        let iq = 0;
        inst.forEach((s, i) => {
          const q = s.waiting.length;
          iq += q;
          const here = users.filter((u) => u.session === i).length;
          const note = memory ? `${plural(here, "login")} here${q ? `, ${q} waiting` : ""}` : q ? `${q} waiting` : s.busy ? "working" : "idle";
          boxes[`i${i + 1}`] = { queue: q, note, tone: q >= 4 ? "bad" : s.busy ? (q ? "busy" : "ok") : "idle" };
        });
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Answered per second", value: rate.toFixed(1) },
            { label: "Waiting for an instance", value: String(iq), tone: iq >= 6 ? "bad" : undefined },
            { label: "Waiting for the database", value: String(dq), tone: dq >= 4 ? "bad" : undefined },
            memory
              ? { label: "Logged out by surprise", value: String(logouts), tone: logouts ? "bad" : undefined }
              : { label: "Average time per request", value: answered ? secs(totalMs / answered) : "–" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Rush hour with 1 instance: users send requests faster than one instance can work through them, so a long line builds up in front of it.", params: { instances: 1, traffic: "rush" } },
    { text: "Rush hour with 3 instances: the same users now get about three times as many answers per second, and the lines at the instances shrink.", params: { instances: 3, traffic: "rush" } },
    { text: "Rush hour with 4 instances: hardly more answers than with 3, because the database runs only 4 queries at a time. The line has moved to the database.", params: { instances: 4, traffic: "rush" } },
    { text: "Keep logins in each instance's memory: a user who logged in on one instance is a stranger to the other, so many requests come back 401 and they must log in again.", params: { instances: 2, memory: true } },
  ],
};
