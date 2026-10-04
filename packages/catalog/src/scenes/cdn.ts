import type { BoxState, ConceptScene, Counter, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";
import { secs, throttledLog } from "./traffic-common.ts";

const NEAR_HOP = 300; // users to the edge in their region, slowed down to watch
const FAR_HOP = 1100; // anywhere to the far-away origin: long on purpose, distance is the point
const LOOKUP = 100; // an edge checking its cache
const ORIGIN_WORK = 400; // the origin reading the file
const GAP = 1600; // average ms between file requests in each region
const FILES = ["logo.png", "app.js", "style.css"];
const TTL: Record<string, number> = { "10": 10_000, "60": 60_000 };
const FIRST_DEPLOY = 15_000;
const DEPLOY_EVERY = 20_000;
const PURGE_NOTE = 2500; // ms an edge says it was just purged
const RECENT = 20; // the average time covers the last 20 files, so it shows how things are now

interface Copy {
  version: number;
  expires: number;
}

interface Region {
  id: "eu" | "as";
  users: string;
  edge: string;
  city: string;
  cache: Map<string, Copy>;
  purged: Set<string>; // files dropped by a purge and not fetched again yet
  purgedAt: number;
  hits: number;
  misses: number;
  took: number[]; // the last few request times in this region
}

const ttlOf = (p: SceneParams) => TTL[pstr(p, "ttl")] ?? 60_000;

export const cdnScene: ConceptScene = {
  id: "cdn",
  title: "Copies of your files near your users",
  intro: "Users in Europe and in Asia ask for three static files. Your server, the origin, is far from both. A CDN puts an edge location near each group: the first request for a file at an edge misses and fetches it from the origin, and later ones get the edge's copy until it expires. Slowed down; the trips to the origin are long because distance is the point.",
  width: 780,
  height: 420,
  controls: [
    { type: "toggle", id: "cdn", label: "Use a CDN" },
    { type: "choice", id: "ttl", label: "Edges keep a copy for", options: [{ value: "10", label: "10 s" }, { value: "60", label: "60 s" }] },
    { type: "choice", id: "deploy", label: "You deploy new files", options: [{ value: "never", label: "Never" }, { value: "wait", label: "Without a purge" }, { value: "purge", label: "And purge the CDN" }] },
  ],
  defaults: { cdn: true, ttl: "60", deploy: "never" },
  layout(p: SceneParams) {
    const cdn = pbool(p, "cdn");
    const keep = `keeps copies ${ttlOf(p) / 1000} s`;
    const boxes: SceneBox[] = [
      { id: "usersEU", kind: "users", label: "Users in Europe", detail: "ask for 3 files", x: 20, y: 30, w: 160, h: 90 },
      { id: "usersAS", kind: "users", label: "Users in Asia", detail: "ask for 3 files", x: 20, y: 300, w: 160, h: 90 },
      { id: "origin", kind: "server", label: "Origin server", detail: "your server, far away", x: 570, y: 150, w: 190, h: 120 },
    ];
    const links: SceneLink[] = [];
    if (cdn) {
      boxes.push(
        { id: "edgeEU", kind: "edge", label: "Frankfurt edge", detail: keep, x: 270, y: 20, w: 200, h: 110 },
        { id: "edgeAS", kind: "edge", label: "Singapore edge", detail: keep, x: 270, y: 290, w: 200, h: 110 },
      );
      links.push(
        { id: "usersEU-edgeEU", from: "usersEU", to: "edgeEU", label: "nearby" },
        { id: "usersAS-edgeAS", from: "usersAS", to: "edgeAS", label: "nearby" },
        { id: "edgeEU-origin", from: "edgeEU", to: "origin", label: "far away" },
        { id: "edgeAS-origin", from: "edgeAS", to: "origin", label: "far away" },
      );
    } else {
      links.push(
        { id: "usersEU-origin", from: "usersEU", to: "origin", label: "far away" },
        { id: "usersAS-origin", from: "usersAS", to: "origin", label: "far away" },
      );
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const cdn = pbool(p, "cdn");
    const ttl = ttlOf(p);
    const deploy = pstr(p, "deploy");
    const say = throttledLog(world);
    const region = (id: Region["id"], users: string, edge: string, city: string): Region =>
      ({ id, users, edge, city, cache: new Map(), purged: new Set(), purgedAt: -Infinity, hits: 0, misses: 0, took: [] });
    const regions = [region("eu", "usersEU", "edgeEU", "Frankfurt"), region("as", "usersAS", "edgeAS", "Singapore")];
    const fresh = (c: Copy | undefined): c is Copy => !!c && c.expires > world.time;
    let version = 1;
    let id = 0;
    let originServed = 0;
    let hits = 0;
    let misses = 0;
    let stale = 0;
    const took: number[] = []; // the last RECENT request times, both regions

    const keep = (list: number[], ms: number, max: number) => {
      list.push(ms);
      if (list.length > max) list.shift();
    };
    const avg = (list: number[]) => list.reduce((a, b) => a + b, 0) / list.length;
    const finish = (r: Region, started: number) => {
      keep(took, world.time - started, RECENT);
      keep(r.took, world.time - started, RECENT / 2);
    };

    const ask = (r: Region) => {
      const n = ++id;
      const file = FILES[Math.floor(world.random() * FILES.length)]!;
      const started = world.time;
      if (!cdn) {
        const l = `${r.users}-origin`;
        world.send(l, "request", FAR_HOP, () => world.after(ORIGIN_WORK, () => {
          originServed++;
          say("direct", 9000, `#${n} for ${file} travels all the way to the origin and back: there is no copy anywhere nearer.`);
          world.send(l, "reply", FAR_HOP, () => finish(r, started), { reverse: true, label: `${file} v${version}` });
        }), { label: `GET ${file}` });
        return;
      }
      const near = `${r.users}-${r.edge}`;
      world.send(near, "request", NEAR_HOP, () => world.after(LOOKUP, () => {
        const copy = r.cache.get(file);
        if (fresh(copy)) {
          hits++;
          r.hits++;
          if (copy.version < version) {
            stale++;
            const left = Math.ceil((copy.expires - world.time) / 1000);
            say("stale", 5000, `${r.city} serves its old copy of ${file} (version ${copy.version}): the origin has version ${version}, but the copy is good for ${left} s more.`);
          } else {
            say(`hit-${r.id}`, 9000, `${r.city} has ${file}: it answers from its copy, and the origin never hears about it.`);
          }
          world.send(near, "reply", NEAR_HOP, () => finish(r, started), { reverse: true, label: `HIT ${file} v${copy.version}` });
          return;
        }
        misses++;
        r.misses++;
        if (r.purged.delete(file)) say(`miss-${r.id}`, 3000, `${r.city} has no copy of ${file} since the purge, so it fetches version ${version} from the origin.`);
        else if (copy) say(`miss-${r.id}`, 4000, `${r.city}'s copy of ${file} has expired, so this request goes all the way to the origin again.`);
        else say(`miss-${r.id}`, 4000, `${r.city} has no copy of ${file} yet: it fetches it from the far-away origin, keeps a copy for ${ttl / 1000} s, then answers.`);
        const far = `${r.edge}-origin`;
        world.send(far, "request", FAR_HOP, () => world.after(ORIGIN_WORK, () => {
          originServed++;
          const v = version;
          world.send(far, "reply", FAR_HOP, () => {
            r.cache.set(file, { version: v, expires: world.time + ttl });
            world.send(near, "reply", NEAR_HOP, () => finish(r, started), { reverse: true, label: `MISS ${file} v${v}` });
          }, { reverse: true, label: `${file} v${v}` });
        }), { label: `GET ${file}` });
      }), { label: `GET ${file}` });
    };

    const release = () => {
      version++;
      if (!cdn) {
        say("deploy", 0, `You deploy version ${version} to the origin. With no CDN every request goes there anyway, so everyone gets it at once.`);
        return;
      }
      if (deploy === "wait") {
        say("deploy", 0, `You deploy version ${version}. Nobody tells the edges, so they keep serving their old copies until those expire.`);
        return;
      }
      say("deploy", 0, `You deploy version ${version} and purge the CDN: the purge goes out to every edge.`);
      for (const r of regions) {
        world.send(`${r.edge}-origin`, "push", FAR_HOP, () => {
          for (const f of r.cache.keys()) r.purged.add(f);
          r.cache.clear();
          r.purgedAt = world.time;
          say(`purge-${r.id}`, 0, `The purge reaches ${r.city}: it drops its copies, so the next request for each file goes to the origin.`);
        }, { reverse: true, label: "PURGE" });
      }
    };

    regions.forEach((r, i) => world.after(400 + i * 700, () => {
      ask(r);
      world.every(GAP, () => ask(r), 0.6);
    }));
    if (deploy !== "never") {
      world.after(FIRST_DEPLOY, () => {
        release();
        world.every(DEPLOY_EVERY, release);
      });
    }

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          origin: { note: deploy === "never" ? `${originServed} requests served` : `version ${version}, ${originServed} served` },
        };
        for (const r of regions) {
          boxes[r.users] = { note: r.took.length ? `about ${secs(avg(r.took))} per file` : "waiting" };
          if (!cdn) continue;
          const held = [...r.cache.values()].filter(fresh);
          const old = held.filter((c) => c.version < version).length;
          boxes[r.edge] = {
            slots: { total: FILES.length, busy: held.length, label: "files cached" },
            note: old ? `${old} out-of-date ${old === 1 ? "copy" : "copies"}` : world.time - r.purgedAt < PURGE_NOTE ? "copies dropped by purge" : `${r.hits} hits, ${r.misses} misses`,
            tone: old ? "bad" : "ok",
          };
        }
        const looked = hits + misses;
        const counters: Counter[] = [
          { label: "Answered by an edge", value: !cdn ? "no CDN" : looked ? `${Math.round((hits / looked) * 100)}%` : "–" },
          { label: "Requests that reached the origin", value: String(originServed) },
          { label: `Average time, last ${RECENT} files`, value: took.length ? secs(avg(took)) : "–" },
        ];
        if (deploy !== "never") counters.push({ label: "Old versions served", value: String(stale), tone: stale ? "bad" : undefined });
        return { boxes, tokens: world.tokens(), counters, log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Turn the CDN off: every request travels to the far-away origin and back, so each file takes several times longer and the origin serves every single one.", params: { cdn: false } },
    { text: "Deploy new files without a purge: after each deploy the edges keep serving their old copies, because those copies don't expire until 60 s after they were made.", params: { deploy: "wait" } },
    { text: "Deploy and purge: the purge takes a moment to reach each edge, then the next request for each file misses and fetches the new version, so old copies stop almost at once.", params: { deploy: "purge" } },
    { text: "Keep copies only 10 s: they keep expiring, so each edge goes back to the origin for each file every 10 s or so. Fresher files, more trips to the origin.", params: { ttl: "10" } },
  ],
};
