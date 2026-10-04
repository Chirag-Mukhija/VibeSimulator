import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

const HOP = 420; // ms on each link, slowed down to watch
const INSTANCES = 3;
const USERS_EACH = 3; // users connected to each instance
const FLAKY = 1; // index of the instance that drops off Redis: API 2
const FIRST_DROP = 5000; // ms into the run when API 2 first loses Redis
const DOWN_FOR = 9000; // ms it stays offline each time
const UP_FOR = 11000; // ms it stays connected before the next drop
const FLASH = 2500; // ms a group of users stays highlighted after missing a message
const GAP: Record<string, number> = { few: 2400, many: 1100 }; // average ms between chat messages

const api = (i: number) => `API ${i + 1}`;
const userLink = (i: number) => `u${i + 1}-a${i + 1}`;
const redisLink = (i: number) => `a${i + 1}-r`;
const range = Array.from({ length: INSTANCES }, (_, i) => i);

export const pubSubScene: ConceptScene = {
  id: "pub-sub",
  title: "One publish, a copy for every subscriber",
  intro: "Users are spread over three app instances, and each instance holds only its own users' WebSockets. When someone sends a chat message, their instance publishes it once to a Redis channel; Redis hands a copy to every instance subscribed to it, and each one pushes it to its own users. Slowed down; each envelope is one message.",
  width: 780,
  height: 370,
  controls: [
    { type: "choice", id: "delivery", label: "Sharing messages", options: [{ value: "redis", label: "Redis pub/sub" }, { value: "local", label: "Each instance alone" }] },
    { type: "toggle", id: "flaky", label: "API 2 drops off Redis now and then" },
    { type: "choice", id: "traffic", label: "Messages", options: [{ value: "few", label: "Few" }, { value: "many", label: "Many" }] },
  ],
  defaults: { delivery: "redis", flaky: false, traffic: "few" },
  layout(p: SceneParams) {
    const redis = pstr(p, "delivery") === "redis";
    const flaky = redis && pbool(p, "flaky");
    const boxes: SceneBox[] = [];
    const links: SceneLink[] = [];
    for (const i of range) {
      const y = 22 + i * 120;
      boxes.push({ id: `u${i + 1}`, kind: "users", label: `Users on ${api(i)}`, detail: `${USERS_EACH} connected`, x: 20, y, w: 150, h: 84 });
      boxes.push({ id: `a${i + 1}`, kind: "server", label: api(i), detail: !redis ? "only its own sockets" : flaky && i === FLAKY ? "loses Redis now and then" : 'subscribed to "chat"', x: 260, y, w: 180, h: 84 });
      links.push({ id: userLink(i), from: `u${i + 1}`, to: `a${i + 1}`, label: "WebSocket", persistent: true });
      links.push({ id: redisLink(i), from: `a${i + 1}`, to: "redis", persistent: redis });
    }
    boxes.push({ id: "redis", kind: "channel", label: "Redis", detail: redis ? 'channel "chat"' : "not used", x: 540, y: 128, w: 210, h: 100 });
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const redis = pstr(p, "delivery") === "redis";
    const flaky = redis && pbool(p, "flaky");
    const connected = range.map(() => redis);
    const got = range.map(() => 0); // messages each group of users received
    const missed = range.map(() => 0); // messages each group never received
    const missedAt = range.map(() => -Infinity);
    let id = 0;
    let sent = 0;
    let copies = 0;
    let reached = 0; // user deliveries made
    let lost = 0; // user deliveries that never happened
    let nextDrop = flaky ? FIRST_DROP : Infinity;
    let missedWhileDown = 0;

    const miss = (i: number) => {
      missed[i]!++;
      missedAt[i] = world.time;
      lost += USERS_EACH;
      if (i === FLAKY && !connected[i]) missedWhileDown++;
    };
    const pushToUsers = (i: number, msg: number) =>
      world.send(userLink(i), "push", HOP, () => {
        got[i]!++;
        reached += USERS_EACH;
      }, { reverse: true, label: `#${msg}` });

    if (flaky) {
      const drop = () => {
        connected[FLAKY] = false;
        missedWhileDown = 0;
        nextDrop = Infinity;
        world.log("API 2 loses its connection to Redis, and its subscription with it. Its users are still connected to API 2.");
        world.after(DOWN_FOR, () => {
          connected[FLAKY] = true;
          nextDrop = world.time + UP_FOR;
          world.log(missedWhileDown
            ? `API 2 reconnects and subscribes again, but the ${missedWhileDown} message${missedWhileDown === 1 ? "" : "s"} sent meanwhile ${missedWhileDown === 1 ? "is" : "are"} gone: Redis pub/sub doesn't keep messages.`
            : "API 2 reconnects and subscribes again.");
          world.after(UP_FOR, drop);
        });
      };
      world.after(FIRST_DROP, drop);
    }

    world.every(GAP[pstr(p, "traffic")] ?? 2400, () => {
      // Someone on one of the instances sends a chat message. While API 2 is offline from Redis
      // (or about to be), its users are left out as senders so a publish never crosses a dead link.
      const soon = world.time + 2 * HOP + 100;
      const senders = range.filter((i) => !redis || (connected[i] && !(i === FLAKY && soon >= nextDrop)));
      const src = senders[Math.floor(world.random() * senders.length)] ?? 0;
      const msg = ++id;
      world.send(userLink(src), "request", HOP, () => {
        sent++;
        if (!redis) {
          for (const i of range) if (i !== src) miss(i);
          world.log(`${api(src)} pushes #${msg} to its own users only. Users on the other two instances never see it: their sockets live elsewhere.`);
          pushToUsers(src, msg);
          return;
        }
        world.send(redisLink(src), "request", HOP, () => {
          const subscribers = range.filter((i) => connected[i]);
          const away = range.filter((i) => !connected[i]);
          for (const i of away) miss(i);
          copies += subscribers.length;
          world.log(away.length
            ? `${api(src)} published #${msg} once. Redis copies it to the ${subscribers.length} instances subscribed right now; ${away.map(api).join(" and ")} is offline, so its users miss it.`
            : `${api(src)} published #${msg} once, without knowing who listens. Redis sends a copy to all ${subscribers.length} subscribers, ${api(src)} included.`);
          for (const i of subscribers) {
            world.send(redisLink(i), "push", HOP, () => {
              // The connection dropped while this copy was on its way: it is lost too.
              if (!connected[i]) return miss(i);
              pushToUsers(i, msg);
            }, { reverse: true, label: `#${msg}` });
          }
        }, { label: `PUBLISH #${msg}` });
      }, { label: `#${msg}` });
    }, 0.3);

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {};
        for (const i of range) {
          boxes[`u${i + 1}`] = { note: `got ${got[i]}${missed[i] ? `, missed ${missed[i]}` : ""}`, tone: world.time - missedAt[i]! < FLASH ? "bad" : "ok" };
          boxes[`a${i + 1}`] = !redis
            ? { note: `pushes to its ${USERS_EACH} users only`, tone: "ok" }
            : connected[i] ? { note: "subscribed", tone: "ok" } : { note: "offline: not subscribed", tone: "bad" };
        }
        const subscribers = connected.filter(Boolean).length;
        boxes.redis = redis ? { note: `${subscribers} subscriber${subscribers === 1 ? "" : "s"}`, tone: "ok" } : { note: "instances don't share", tone: "idle" };
        const total = reached + lost;
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Messages sent", value: String(sent) },
            { label: "Copies Redis sent", value: String(copies) },
            { label: "Users reached", value: total ? `${Math.round((reached / total) * 100)}%` : "–", tone: lost ? "bad" : undefined },
            { label: "Missed deliveries", value: String(lost), tone: lost ? "bad" : "good" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Switch to each instance alone: an instance can only push to the sockets it holds, so every message reaches one group of users and the other two miss it.", params: { delivery: "local", flaky: false } },
    { text: "Turn on API 2 dropping off Redis: while it is offline Redis simply skips it, and when it reconnects the messages it missed are not sent again.", params: { delivery: "redis", flaky: true } },
    { text: "Many messages with Redis pub/sub: every message still reaches every instance, and Redis sends one copy per subscriber, so its work grows with the number of instances.", params: { delivery: "redis", flaky: false, traffic: "many" } },
  ],
};
