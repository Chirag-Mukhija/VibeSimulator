import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch. For real, a Redis trip in the same data center
// takes well under a millisecond and a signature check takes microseconds.
const HOP = 400; // browsers to the app
const REDIS_HOP = 300; // the app to Redis
const REDIS = 60; // Redis reads or writes one key
const VERIFY = 150; // checking a JWT's signature: CPU work inside the app
const SIGN = 150; // signing a new JWT
const HANDLER = 400; // the request's own work, once the app knows who is asking
const PAUSE = [1200, 2600] as const; // each user reads the page, then clicks again
const ATTACK_START = 2500;
const ATTACK_PAUSE = [1800, 2800] as const;
const LOGOUT_AT = 10_000; // Ann logs out now, or as soon as her request in flight is answered
const REFRESH_EARLY = 1000; // browsers swap a token for a new one shortly before it expires
const LIFETIME: Record<string, number> = { "10": 10_000, "30": 30_000 };
const ANN_SIGNED = -2000; // Ann's token was signed 2 s before the scene starts; that is the one the attacker copied

type Mode = "session" | "jwt" | "denylist";
/** Why a request was refused. */
type Why = "no-session" | "expired" | "denied";

/** What a request carries: a session id (`key`) or a token with an id (`jti`) and an expiry. */
interface Cred {
  key: string;
  jti: number;
  exp: number;
}

interface User extends Cred {
  name: string;
  out: boolean;
  /** A request of theirs is on its way or being answered. */
  busy: boolean;
}

const modeOf = (p: SceneParams) => pstr(p, "auth") as Mode;
const lifetimeOf = (p: SceneParams) => LIFETIME[pstr(p, "lifetime")] ?? 30_000;
const whole = (ms: number) => (ms < 1000 ? "under 1 s" : `${Math.round(ms / 1000)} s`);

export const sessionsJwtScene: ConceptScene = {
  id: "sessions-jwt",
  title: "A session lookup or a signed token",
  intro: "Ann, Ben and Cai are signed in, and an attacker has copied Ann's cookie or token. With a session, the cookie holds only an id, so the app asks Redis who it belongs to on every request. With a JWT, the token carries the user and a signature the app checks itself. Ann logs out after about 10 s. Slowed down; token lifetimes are shortened (real ones last minutes to hours).",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "auth", label: "Remember users with", options: [
      { value: "session", label: "Session cookie" },
      { value: "jwt", label: "JWT" },
      { value: "denylist", label: "JWT + denylist" },
    ] },
    { type: "choice", id: "lifetime", label: "A JWT expires after", options: [{ value: "10", label: "10 s" }, { value: "30", label: "30 s" }] },
  ],
  defaults: { auth: "session", lifetime: "30" },
  layout(p: SceneParams) {
    const m = modeOf(p);
    const session = m === "session";
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "Ann, Ben and Cai", x: 20, y: 30, w: 170, h: 100 },
        { id: "attacker", kind: "browser", label: "Attacker", detail: session ? "copied Ann's cookie" : "copied Ann's token", x: 20, y: 280, w: 170, h: 100 },
        { id: "app", kind: "app", label: "App", detail: session ? "looks up every cookie" : m === "jwt" ? "checks signatures locally" : "signature, then denylist", x: 290, y: 150, w: 210, h: 110 },
        { id: "redis", kind: "cache", label: "Redis", detail: session ? "sessions: id to user" : m === "jwt" ? "refresh tokens only" : "refresh + denylist", x: 590, y: 155, w: 170, h: 100 },
      ],
      links: [
        { id: "users-app", from: "users", to: "app", label: session ? "cookie" : "token" },
        { id: "attacker-app", from: "attacker", to: "app", label: session ? "cookie" : "token" },
        { id: "app-redis", from: "app", to: "redis", label: "GET/SET" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const m = modeOf(p);
    const jwt = m !== "session";
    const life = lifetimeOf(p);
    const sessions = new Set(["ann", "ben", "cai"]);
    const refreshTokens = new Set(["ann", "ben", "cai"]);
    const denylist = new Set<number>();
    // Staggered sign-in times, so the three refreshes don't line up.
    const users: User[] = [
      { name: "Ann", key: "ann", jti: 1, exp: ANN_SIGNED + life, out: false, busy: false },
      { name: "Ben", key: "ben", jti: 2, exp: Math.round(0.6 * life), out: false, busy: false },
      { name: "Cai", key: "cai", jti: 3, exp: Math.round(0.25 * life), out: false, busy: false },
    ];
    const ann = users[0]!;
    const copy: Cred = { key: "ann", jti: 1, exp: ANN_SIGNED + life };
    let jtiSeq = 3;
    let id = 0;
    let checked = 0; // requests whose sender was checked (users and attacker)
    let trips = 0; // round trips to Redis, for any reason
    let pendingRedis = 0;
    let verifying = 0;
    let working = 0;
    let userAnswered = 0;
    let acceptedAfter = 0;
    let rejected = 0;
    let rejectedOnce = false;
    let logoutAt: number | undefined;
    let attacker: BoxState = { note: "about to try", tone: "idle" };
    const lastSaid = new Map<string, number>();

    /** Logs at most once per `gap` ms for the same kind of event, so the log stays readable. */
    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const between = (r: readonly [number, number]) => r[0] + world.random() * (r[1] - r[0]);

    /** One round trip to Redis: `atRedis` runs when the command arrives and returns whether it found something. */
    const redisTrip = (label: string, atRedis: () => boolean, then: (found: boolean) => void) => {
      trips++;
      pendingRedis++;
      world.send("app-redis", "request", REDIS_HOP, () => {
        const found = atRedis();
        world.after(REDIS, () => world.send("app-redis", found ? "reply" : "empty", REDIS_HOP, () => {
          pendingRedis--;
          then(found);
        }, { reverse: true }));
      }, { label });
    };

    /** Decides whether a credential is good. `at` is the moment the decision used: Redis's state, or the app's clock. */
    const check = (cred: Cred, done: (why: Why | undefined, at: number) => void) => {
      if (m === "session") {
        let at = 0;
        redisTrip("GET session", () => {
          at = world.time;
          return sessions.has(cred.key);
        }, (found) => done(found ? undefined : "no-session", at));
        return;
      }
      verifying++;
      world.after(VERIFY, () => {
        verifying--;
        const now = world.time;
        if (cred.exp <= now) return done("expired", now);
        if (m === "jwt") return done(undefined, now);
        let at = 0;
        redisTrip("denylisted?", () => {
          at = world.time;
          return denylist.has(cred.jti);
        }, (denied) => done(denied ? "denied" : undefined, at));
      });
    };

    const handle = (link: string, then: () => void, label?: string) => {
      working++;
      world.after(HANDLER, () => {
        working--;
        world.send(link, "reply", HOP, then, { reverse: true, label });
      });
    };

    const click = (u: User) => {
      if (u.out) return;
      if (u === ann && world.time >= LOGOUT_AT) return logout(u);
      if (jwt && u.exp - REFRESH_EARLY <= world.time) return refresh(u);
      const n = ++id;
      const cred: Cred = { key: u.key, jti: u.jti, exp: u.exp };
      u.busy = true;
      world.send("users-app", "request", HOP, () => check(cred, (why) => {
        checked++;
        if (why) {
          rejected++;
          world.send("users-app", "error", HOP, () => {
            u.busy = false;
            world.after(300, () => click(u));
          }, { reverse: true, label: "401" });
          return;
        }
        if (m === "session") say("lookup", 9000, `#${n} from ${u.name}: the cookie holds only a session id, so the app asks Redis whose session it is. One Redis trip, on every request.`);
        else if (m === "jwt") say("verify", 9000, `#${n} from ${u.name}: the app checks the token's signature with its secret key and reads who it is from the token. No Redis trip.`);
        else say("deny", 9000, `#${n} from ${u.name}: the signature checks out, then the app asks Redis whether this token was revoked. A Redis trip on every request again.`);
        handle("users-app", () => {
          u.busy = false;
          userAnswered++;
          if (u === ann && world.time >= LOGOUT_AT) return logout(u);
          world.after(between(PAUSE), () => click(u));
        });
      }), { label: `#${n} ${u.name}` });
    };

    /** The browser trades its refresh token for a new access token. Refresh tokens live in Redis so they can be revoked. */
    const refresh = (u: User) => {
      u.busy = true;
      world.send("users-app", "request", HOP, () => {
        redisTrip("GET refresh token", () => refreshTokens.has(u.key), (ok) => {
          if (!ok) return;
          world.after(SIGN, () => {
            u.jti = ++jtiSeq;
            u.exp = world.time + life;
            say("refresh", 9000, `${u.name}'s token is about to expire, so the browser sends its refresh token: one Redis trip to check it, then a new ${life / 1000} s token.`);
            world.send("users-app", "reply", HOP, () => {
              u.busy = false;
              click(u);
            }, { reverse: true, label: "new token" });
          });
        });
      }, { label: `${u.name}: refresh` });
    };

    const logout = (u: User) => {
      if (u.out) return;
      u.out = true; // Ann's browser forgets its cookie or token and she stops clicking
      const reply = () => world.send("users-app", "reply", HOP, undefined, { reverse: true, label: "logged out" });
      world.send("users-app", "request", HOP, () => {
        if (m === "session") {
          redisTrip("DEL session", () => {
            sessions.delete(u.key);
            logoutAt = world.time;
            return true;
          }, () => {
            world.log("Ann logs out: the app deletes her session from Redis. Any copy of her cookie now points at nothing.");
            reply();
          });
          return;
        }
        if (m === "jwt") {
          logoutAt = world.time;
          const left = copy.exp - world.time;
          world.log("Ann logs out: her browser drops its token and the app deletes her refresh token in Redis.");
          world.log(left > 0
            ? `But the attacker's copy stays valid ${whole(left)} more: the server keeps no list of the tokens it signed to strike it from.`
            : "The attacker's copy of her token has already expired, so it is useless anyway.");
          redisTrip("DEL refresh token", () => {
            refreshTokens.delete(u.key);
            return true;
          }, reply);
          return;
        }
        const revoked = u.jti;
        redisTrip("SET denylist", () => {
          refreshTokens.delete(u.key);
          denylist.add(revoked);
          logoutAt = world.time;
          // Stored with an expiry: once the token would have expired anyway, the entry can go.
          world.after(Math.max(1, u.exp - world.time), () => denylist.delete(revoked));
          return true;
        }, () => {
          world.log("Ann logs out: the app deletes her refresh token and adds her token's id to a denylist in Redis, kept until the token would have expired.");
          reply();
        });
      }, { label: "log out" });
    };

    const attack = () => {
      const n = ++id;
      const again = () => world.after(between(ATTACK_PAUSE), attack);
      world.send("attacker-app", "request", HOP, () => check(copy, (why, at) => {
        checked++;
        const afterLogout = logoutAt !== undefined && at >= logoutAt;
        if (!why) {
          if (afterLogout) {
            acceptedAfter++;
            say("still", 5000, `${whole(at - logoutAt!)} after Ann logged out, the copied token still works: validly signed, and ${whole(copy.exp - at)} until it expires.`);
          } else {
            say("as-ann", 9000, m === "session"
              ? "The attacker sends Ann's copied cookie. Redis says that id is Ann's session, so the app treats the attacker as Ann."
              : "The attacker sends Ann's copied token. The signature is valid and it hasn't expired, so the app treats the attacker as Ann.");
          }
          attacker = { note: "copy accepted, as Ann", tone: afterLogout ? "bad" : "busy" };
          handle("attacker-app", again, "200 as Ann");
          return;
        }
        rejected++;
        attacker = { note: "copy rejected: 401", tone: "ok" };
        if (!rejectedOnce) {
          rejectedOnce = true;
          if (why === "no-session") world.log("The attacker's copy gets 401: Redis has no session with that id any more, so the logout took effect at once.");
          else if (why === "denied") world.log("The attacker's copy gets 401: its id is on the denylist, so the logout took effect at once.");
          else if (logoutAt !== undefined && copy.exp > logoutAt) world.log(`The attacker's copy finally gets 401, ${whole(at - logoutAt)} after Ann logged out: the token has expired. Until then the app had nothing to check it against.`);
          else world.log(`The attacker's copy gets 401: the token expired${logoutAt === undefined ? ", though Ann is still signed in" : " before Ann even logged out"}. A short lifetime limits how long a copy is any use.`);
        } else say("again", 9000, "The attacker tries the copy again and gets 401 again.");
        world.send("attacker-app", "error", HOP, again, { reverse: true, label: "401" });
      }), { label: `#${n} as Ann` });
    };

    users.forEach((u, i) => world.after(300 + i * 450 + world.random() * 300, () => click(u)));
    // Ann logs out at 10 s, or as soon as the request she has in flight is answered.
    world.after(LOGOUT_AT, () => {
      if (!ann.busy) logout(ann);
    });
    world.after(ATTACK_START, attack);

    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

    return {
      tick(dt: number) {
        world.advance(dt);
        const appNote = pendingRedis ? `waiting on ${plural(pendingRedis, "Redis trip")}`
          : verifying ? `checking ${plural(verifying, "signature")}`
          : working ? `handling ${plural(working, "request")}` : "idle";
        const redisNote = m === "session" ? `${plural(sessions.size, "session")} stored`
          : m === "jwt" ? `${plural(refreshTokens.size, "refresh token")}`
          : `${refreshTokens.size} refresh, ${denylist.size} denied`;
        const boxes: Record<string, BoxState> = {
          users: { note: ann.out ? `Ann out, ${userAnswered} answered` : `${userAnswered} answered` },
          attacker,
          app: { note: appNote, tone: pendingRedis || verifying || working ? "ok" : "idle" },
          redis: { note: redisNote, tone: pendingRedis ? "ok" : "idle" },
        };
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Requests checked", value: String(checked) },
            { label: "Redis trips per request", value: checked ? (trips / checked).toFixed(1) : "–" },
            { label: "Stolen copy accepted after logout", value: String(acceptedAfter), tone: acceptedAfter ? "bad" : logoutAt !== undefined && rejected ? "good" : undefined },
            { label: "Rejected with 401", value: String(rejected) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Switch to JWT: the Redis link goes nearly quiet, since the app checks each signature itself, but after Ann logs out the attacker's copy keeps working until the token expires, more than 10 s later.", params: { auth: "jwt", lifetime: "30" } },
    { text: "Use JWT + denylist: logging out puts the token's id in Redis, so the copy is rejected at once, but every request is back to a Redis trip, the lookup JWTs were meant to avoid.", params: { auth: "denylist", lifetime: "30" } },
    { text: "JWT with a 10 s lifetime: the copied token dies within 10 s of being signed, logout or not, but each browser now refreshes every 10 s, a Redis trip each time.", params: { auth: "jwt", lifetime: "10" } },
  ],
};
