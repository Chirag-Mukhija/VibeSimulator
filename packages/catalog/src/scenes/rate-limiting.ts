import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";
import { throttledLog } from "./traffic-common.ts";

const HOP = 400; // clients, balancer and apps, slowed down to watch
const REDIS_HOP = 300;
const COUNT = 60; // Redis updating a count: a fraction of a millisecond for real
const WORK = 500; // the handler's own work, for a request that passes
const LIMIT = 5; // requests per client per 10 s: tiny, so you can watch it fill
const WINDOW = 10_000;
const BURST = 6; // the bot sends one more than the limit each time
const BURST_GAP = 300; // ms between the bot's requests inside a burst
const BURST_EVERY = 7000; // average ms between bursts
const FIRST_BURST = 3000;
const USER_GAP = 4500; // Alice and Bob: a request every ~4.5 s each, under the limit

type Who = "Alice" | "Bob" | "Bot";
type Verdict = { ok: true; count: number } | { ok: false; retryAfter: number };

const windowStart = (t: number) => Math.floor(t / WINDOW) * WINDOW;

/** One place the counts live: the shared Redis, or one app's own memory. */
class Counts {
  private readonly world: World;
  private readonly sliding: boolean;
  private readonly windows = new Map<Who, { start: number; count: number }>();
  private readonly passed = new Map<Who, number[]>();

  constructor(world: World, sliding: boolean) {
    this.world = world;
    this.sliding = sliding;
  }

  /** How many of this client's requests count against it right now. */
  count(who: Who): number {
    const now = this.world.time;
    if (this.sliding) return (this.passed.get(who) ?? []).filter((t) => t > now - WINDOW).length;
    const w = this.windows.get(who);
    return w && w.start === windowStart(now) ? w.count : 0;
  }

  /** Counts the request if the client is under the limit; otherwise says how long until it would be. */
  take(who: Who): Verdict {
    const now = this.world.time;
    if (this.sliding) {
      // Sliding window: requests that passed in the last 10 s, whenever the 10 s began.
      const recent = (this.passed.get(who) ?? []).filter((t) => t > now - WINDOW);
      this.passed.set(who, recent);
      if (recent.length < LIMIT) {
        recent.push(now);
        return { ok: true, count: recent.length };
      }
      return { ok: false, retryAfter: Math.max(1, Math.ceil((recent[0]! + WINDOW - now) / 1000)) };
    }
    // Fixed window: one count per client per 10 s block of the clock, back to 0 when the block ends.
    const start = windowStart(now);
    let w = this.windows.get(who);
    if (!w || w.start !== start) {
      w = { start, count: 0 };
      this.windows.set(who, w);
    }
    if (w.count < LIMIT) {
      w.count++;
      return { ok: true, count: w.count };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil((start + WINDOW - now) / 1000)) };
  }
}

export const rateLimitingScene: ConceptScene = {
  id: "rate-limiting",
  title: "Counting each client's requests and refusing the excess",
  intro: "Alice, Bob and a bot call an API that runs as two app instances behind a load balancer. Each client may make 5 requests per 10 s (a tiny limit, so you can watch it fill); past that, the app answers 429 Too Many Requests with a Retry-After header. Slowed down; red envelopes are 429s.",
  width: 780,
  height: 420,
  controls: [
    { type: "choice", id: "window", label: "Counting window", options: [{ value: "sliding", label: "Sliding: last 10 s" }, { value: "fixed", label: "Fixed: resets every 10 s" }] },
    { type: "choice", id: "store", label: "Counts kept in", options: [{ value: "redis", label: "Shared Redis" }, { value: "memory", label: "Each app's memory" }] },
    { type: "toggle", id: "bot", label: "A bot sends bursts" },
  ],
  defaults: { window: "sliding", store: "redis", bot: true },
  layout(p: SceneParams) {
    const shared = pstr(p, "store") === "redis";
    const detail = shared ? "limit 5 per 10 s, via Redis" : "limit 5 per 10 s, own counts";
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "Alice and Bob", x: 20, y: 46, w: 150, h: 90 },
        { id: "bot", kind: "users", label: "Bot", detail: pbool(p, "bot") ? "bursts of 6 requests" : "switched off", x: 20, y: 284, w: 150, h: 90 },
        { id: "lb", kind: "balancer", label: "Load balancer", detail: "takes turns", x: 250, y: 165, w: 150, h: 90 },
        { id: "app1", kind: "app", label: "App 1", detail, x: 480, y: 8, w: 240, h: 96 },
        { id: "redis", kind: "cache", label: "Redis", detail: shared ? "one count per client" : "not used", x: 480, y: 158, w: 240, h: 104 },
        { id: "app2", kind: "app", label: "App 2", detail, x: 480, y: 316, w: 240, h: 96 },
      ],
      links: [
        { id: "users-lb", from: "users", to: "lb", label: "HTTP" },
        { id: "bot-lb", from: "bot", to: "lb", label: "HTTP" },
        { id: "lb-app1", from: "lb", to: "app1" },
        { id: "lb-app2", from: "lb", to: "app2" },
        { id: "app1-redis", from: "app1", to: "redis", label: "count" },
        { id: "app2-redis", from: "app2", to: "redis", label: "count" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const sliding = pstr(p, "window") === "sliding";
    const shared = pstr(p, "store") === "redis";
    const botOn = pbool(p, "bot");
    const say = throttledLog(world);
    const redis = new Counts(world, sliding);
    const own = [new Counts(world, sliding), new Counts(world, sliding)];
    const where = sliding ? "in the last 10 s" : "this window";
    const working = [0, 0];
    const appPassed = [0, 0];
    const appRefused = [0, 0];
    const botPassedAt: number[] = [];
    let id = 0;
    let turn = 0;
    let passed = 0;
    let refused = 0;
    let usersOk = 0;
    let usersRefused = 0;
    let botOk = 0;
    let botRefused = 0;
    let mostBot = 0;
    let lastDecision = -Infinity;

    const name = (who: Who, n: number) => (who === "Bot" ? `Bot #${n}` : `${who}'s request #${n}`);

    /** The limiter's decision, made where the counts live. */
    const judge = (n: number, who: Who, i: number, counts: Counts): Verdict => {
      const v = counts.take(who);
      const app = `App ${i + 1}`;
      lastDecision = world.time;
      if (!v.ok) {
        refused++;
        appRefused[i]!++;
        if (who === "Bot") botRefused++;
        else usersRefused++;
        const whose = who === "Bot" ? "the bot's" : `${who}'s`;
        say("429", 4000, shared
          ? `${name(who, n)} gets 429 Too Many Requests: all ${LIMIT} of ${whose} allowed requests passed ${where}. Retry-After: ${v.retryAfter} s.`
          : `${name(who, n)} gets 429 from ${app}: ${app} alone has counted ${LIMIT} of ${whose} requests ${where}. Retry-After: ${v.retryAfter} s.`);
        return v;
      }
      passed++;
      appPassed[i]!++;
      if (who !== "Bot") {
        usersOk++;
        say("user-ok", 12000, `${name(who, n)} passes: ${who === "Alice" ? "her" : "his"} own count is ${v.count} of ${LIMIT} ${where}. The bot's count is separate.`);
        return v;
      }
      botOk++;
      botPassedAt.push(world.time);
      while (botPassedAt.length && botPassedAt[0]! <= world.time - WINDOW) botPassedAt.shift();
      const recent = botPassedAt.length;
      mostBot = Math.max(mostBot, recent);
      if (recent > LIMIT && !shared) {
        say("split", 6000, `${app} lets bot #${n} through: it has counted only ${v.count} bot requests itself. The other app saw the rest: ${recent} in 10 s.`);
      } else if (recent > LIMIT) {
        const ago = ((world.time - windowStart(world.time)) / 1000).toFixed(1);
        say("edge", 6000, `Bot #${n} passes: the window reset ${ago} s ago and the count restarted at 0, yet that makes ${recent} bot requests in 10 s.`);
      } else {
        say("bot-ok", 8000, `Bot #${n} passes: ${v.count} of its ${LIMIT} allowed ${where}${shared ? "" : ` at ${app}`}.`);
      }
      return v;
    };

    const respond = (n: number, who: Who, i: number, v: Verdict) => {
      const client = who === "Bot" ? "bot-lb" : "users-lb";
      const kind = v.ok ? "reply" : "error";
      const label = v.ok ? `#${n} 200 OK` : `429, retry in ${v.retryAfter} s`;
      const back = () => {
        working[i]!--;
        world.send(`lb-app${i + 1}`, kind, HOP, () => world.send(client, kind, HOP, undefined, { reverse: true, label }), { reverse: true, label });
      };
      if (v.ok) world.after(WORK, back);
      else back(); // refused before the handler runs: no work done
    };

    const send = (who: Who) => {
      const n = ++id;
      const label = who === "Bot" ? `bot #${n}` : `#${n} ${who}`;
      world.send(who === "Bot" ? "bot-lb" : "users-lb", "request", HOP, () => {
        const i = turn++ % 2;
        world.send(`lb-app${i + 1}`, "request", HOP, () => {
          working[i]!++;
          if (!shared) {
            respond(n, who, i, judge(n, who, i, own[i]!));
            return;
          }
          const link = `app${i + 1}-redis`;
          world.send(link, "request", REDIS_HOP, () => world.after(COUNT, () => {
            const v = judge(n, who, i, redis);
            world.send(link, "reply", REDIS_HOP, () => respond(n, who, i, v), { reverse: true, label: v.ok ? `count ${v.count} of ${LIMIT}` : "over the limit" });
          }), { label: `count ${who}` });
        }, { label });
      }, { label });
    };

    world.after(700, () => {
      send("Alice");
      world.every(USER_GAP, () => send("Alice"), 0.4);
    });
    world.after(2400, () => {
      send("Bob");
      world.every(USER_GAP, () => send("Bob"), 0.4);
    });
    if (botOn) {
      const burst = () => {
        for (let k = 0; k < BURST; k++) world.after(k * BURST_GAP, () => send("Bot"));
      };
      world.after(FIRST_BURST, () => {
        burst();
        world.every(BURST_EVERY, burst, 0.08);
      });
    }
    if (!sliding) {
      world.every(WINDOW, () => {
        if (world.time - lastDecision < WINDOW) say("reset", 0, "A new 10 s window starts: every client's count goes back to 0.");
      });
    }

    const keyNote = (c: Counts) => {
      const left = Math.max(1, Math.ceil((windowStart(world.time) + WINDOW - world.time) / 1000));
      return `Alice ${c.count("Alice")}, Bob ${c.count("Bob")} · ${sliding ? "last 10 s" : `resets in ${left} s`}`;
    };
    const counted = (c: Counts, busy: boolean): BoxState => {
      const b = c.count("Bot");
      return { slots: { total: LIMIT, busy: b, label: "bot requests" }, note: keyNote(c), tone: b >= LIMIT ? "busy" : busy ? "ok" : "idle" };
    };

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          users: { note: `${usersOk} ok, ${usersRefused} got 429` },
          bot: botOn ? { note: `${botOk} ok, ${botRefused} got 429` } : { note: "sends nothing", tone: "idle" },
          lb: { note: `next: App ${(turn % 2) + 1}` },
          redis: shared ? counted(redis, true) : { note: "not used", tone: "idle" },
        };
        for (const i of [0, 1]) {
          const busy = working[i]! > 0;
          boxes[`app${i + 1}`] = shared
            ? { note: `${appPassed[i]} passed, ${appRefused[i]} refused`, tone: busy ? "ok" : "idle" }
            : counted(own[i]!, busy);
        }
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Let through", value: String(passed) },
            { label: "Refused with 429", value: String(refused) },
            { label: "Most bot requests let through in 10 s", value: botOn ? `${mostBot} (limit ${LIMIT})` : "bot off", tone: mostBot > LIMIT ? "bad" : undefined },
            { label: "Alice and Bob refused", value: String(usersRefused), tone: usersRefused ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Switch to fixed windows: every count drops to 0 at each reset, so one bot burst before a reset and the next one after it both pass in full: 10 bot requests within 10 s, twice the limit.", params: { window: "fixed" } },
    { text: "Keep the counts in each app's memory: the balancer splits the bot's requests between the two apps and each counts only its own share, so about twice the limit gets through.", params: { store: "memory" } },
    { text: "Turn the bot off: Alice and Bob stay under 5 requests per 10 s, so nobody gets a 429. The limiter costs them one quick trip to Redis per request, nothing more.", params: { bot: false } },
  ],
};
