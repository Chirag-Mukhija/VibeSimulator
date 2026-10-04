import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pnum, pstr } from "./types.ts";
import { Station, World } from "./world.ts";

const HOP = 380; // ms per trip between the app and the database, slowed down
const USER_HOP = 420;
const QUERY = 450; // ms the database spends on one query
const MAX_CONNECTIONS = 12; // the database's limit, scaled down from Postgres's 100 to fit on screen

export const poolingScene: ConceptScene = {
  id: "connection-pooling",
  title: "A pool of connections vs a new one per request",
  intro: "Requests arrive at the app, and each needs one database query. With a pool, the app keeps a few connections open and lends them out. Without one, every request opens its own connection first: a handshake and a login, several trips before the query can even start.",
  width: 780,
  height: 360,
  controls: [
    { type: "choice", id: "mode", label: "Connections", options: [{ value: "pool", label: "Shared pool" }, { value: "per-request", label: "New per request" }] },
    { type: "count", id: "pool", label: "Pool size", min: 2, max: 8 },
    { type: "choice", id: "traffic", label: "Traffic", options: [{ value: "light", label: "Light" }, { value: "busy", label: "Busy" }] },
  ],
  defaults: { mode: "pool", pool: 4, traffic: "light" },
  layout(p: SceneParams) {
    const pooled = pstr(p, "mode") === "pool";
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "one query each", x: 20, y: 140, w: 140, h: 76 },
        { id: "app", kind: "app", label: "Your app", detail: pooled ? `pool of ${pnum(p, "pool")} connections` : "opens a connection per request", x: 260, y: 118, w: 230, h: 120 },
        { id: "db", kind: "database", label: "Postgres", detail: `max ${MAX_CONNECTIONS} connections`, x: 560, y: 114, w: 200, h: 124 },
      ],
      links: [
        { id: "u-app", from: "users", to: "app", label: "HTTP" },
        { id: "app-db", from: "app", to: "db", label: "SQL", persistent: pooled },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const pooled = pstr(p, "mode") === "pool";
    const pool = new Station(world, pnum(p, "pool"));
    let open = pooled ? pnum(p, "pool") : 0;
    let id = 0;
    let done = 0;
    let refused = 0;
    let handshakes = 0;
    let totalMs = 0;

    const answer = (req: number, started: number, ok: boolean) => {
      world.send("u-app", ok ? "reply" : "error", USER_HOP, () => {
        if (ok) {
          done++;
          totalMs += world.time - started;
        }
      }, { reverse: true, label: ok ? undefined : `#${req} failed` });
    };

    /** One query over an open connection: there, run, and back. */
    const query = (req: number, then: () => void) => {
      world.send("app-db", "request", HOP, () => world.after(QUERY, () => world.send("app-db", "reply", HOP, then, { reverse: true })), { label: `#${req} SELECT` });
    };

    world.every(pstr(p, "traffic") === "busy" ? 260 : 700, () => {
      const req = ++id;
      const started = world.time;
      world.send("u-app", "request", USER_HOP, () => {
        if (pooled) {
          if (pool.busy >= pool.slots) world.log(`#${req} waits: all ${pool.slots} pooled connections are lent out.`);
          pool.acquire((release) => query(req, () => {
            release();
            answer(req, started, true);
          }));
          return;
        }
        if (open >= MAX_CONNECTIONS) {
          refused++;
          world.log(`Postgres refuses #${req}: ${open} connections are already open, the most it allows.`);
          world.send("app-db", "error", HOP, () => answer(req, started, false), { label: "refused" });
          return;
        }
        open++;
        handshakes++;
        world.log(`#${req} opens a new connection: TCP handshake, then login, before its query.`);
        // TCP handshake, then authentication: two round trips before the query.
        world.send("app-db", "handshake", HOP, () => world.send("app-db", "handshake", HOP, () =>
          world.send("app-db", "handshake", HOP, () => world.send("app-db", "handshake", HOP, () =>
            query(req, () => {
              open--;
              answer(req, started, true);
            }), { reverse: true, label: "ok" }), { label: "login" }), { reverse: true, label: "SYN-ACK" }), { label: "SYN" });
      }, { label: `#${req}` });
    }, 0.35);

    return {
      tick(dt: number) {
        world.advance(dt);
        const app: BoxState = pooled
          ? { slots: { total: pool.slots, busy: pool.busy, label: "pooled connections" }, queue: pool.waiting.length, note: pool.waiting.length ? `${pool.waiting.length} waiting for a connection` : `${pool.slots - pool.busy} connections free`, tone: pool.waiting.length >= 4 ? "bad" : pool.busy === pool.slots ? "busy" : "ok" }
          : { note: `${open} connections being opened or used`, tone: open >= MAX_CONNECTIONS ? "bad" : "ok" };
        const avg = done ? totalMs / done : 0;
        return {
          boxes: {
            users: { note: `${done} answered${refused ? `, ${refused} failed` : ""}` },
            app,
            db: { slots: { total: MAX_CONNECTIONS, busy: open, label: "connections" }, note: `${open} of ${MAX_CONNECTIONS} connections open`, tone: open >= MAX_CONNECTIONS ? "bad" : open > MAX_CONNECTIONS * 0.7 ? "busy" : "ok" },
          },
          tokens: world.tokens(),
          counters: [
            { label: "Answered", value: String(done) },
            { label: "Average time per request", value: done ? `${(avg / 1000).toFixed(1)} s` : "–" },
            { label: pooled ? "Waiting for a connection" : "Handshakes paid", value: String(pooled ? pool.waiting.length : handshakes) },
            { label: "Refused by the database", value: String(refused), tone: refused ? "bad" : "good" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Switch to a new connection per request: every request now makes two extra round trips (TCP, then login) before its query, so each takes noticeably longer.", params: { mode: "per-request", traffic: "light" } },
    { text: "Keep that, and make traffic busy: open connections pile up faster than they close, until Postgres refuses new ones and requests fail.", params: { mode: "per-request", traffic: "busy" } },
    { text: "Back to a pool of 2 under busy traffic: nothing fails, but requests line up for a free connection.", params: { mode: "pool", pool: 2, traffic: "busy" } },
    { text: "A pool of 8: the line disappears, and Postgres never sees more than 8 connections from this app.", params: { mode: "pool", pool: 8, traffic: "busy" } },
  ],
};
