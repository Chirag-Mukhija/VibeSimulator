import type { BoxState, ConceptScene, Counter, SceneParams } from "./types.ts";
import { pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const HOP = 400; // users to the app, and the app to the API
const CONNECTIONS = 4; // calls the app may have open to the API at once (its connection limit)
const GAP = 900; // average ms between requests; real traffic is bursty, so the gaps vary
const FAST: [number, number] = [400, 900]; // the API's work on most calls
const SLOW: [number, number] = [1300, 1900]; // the API's work on a slow call
const SLOW_SHARE = 0.2; // share of answered calls that are slow but healthy
const HANG = 0.22; // share of calls the API never answers, when it sometimes hangs
const TIMEOUT: Record<string, number> = { generous: 4000, tight: 2000 };

interface Req {
  n: number;
  started: number;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const timeoutsScene: ConceptScene = {
  id: "timeouts",
  title: "Giving up on a call that never answers",
  intro: "Each page needs data from an outside API. The app can have at most 4 calls open to that API at once (its connection limit); more requests wait in line. Some calls are never answered: the API is stuck, or the connection died without notice. A timeout decides how long the app waits. Slowed down; each envelope is a request or a reply.",
  width: 780,
  height: 360,
  controls: [
    { type: "choice", id: "timeout", label: "Timeout on the API call", options: [
      { value: "none", label: "None" },
      { value: "generous", label: "Generous (4 s)" },
      { value: "tight", label: "Tight (2 s)" },
    ] },
    { type: "choice", id: "api", label: "The API", options: [{ value: "hangs", label: "Sometimes hangs" }, { value: "healthy", label: "Always answers" }] },
    { type: "choice", id: "onTimeout", label: "When it times out, answer", options: [{ value: "error", label: "504 error" }, { value: "fallback", label: "A fallback" }] },
  ],
  defaults: { timeout: "generous", api: "hangs", onTimeout: "error" },
  layout(p: SceneParams) {
    const limit = TIMEOUT[pstr(p, "timeout")];
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "open pages", x: 20, y: 135, w: 160, h: 90 },
        { id: "app", kind: "app", label: "App", detail: limit ? `gives up after ${limit / 1000} s` : "no timeout on the call", x: 260, y: 115, w: 220, h: 130 },
        { id: "api", kind: "external", label: "Outside API", detail: pstr(p, "api") === "hangs" ? "some calls never answered" : "answers every call", x: 570, y: 125, w: 190, h: 110 },
      ],
      links: [
        { id: "u-app", from: "users", to: "app", label: "HTTP" },
        { id: "app-api", from: "app", to: "api", label: "fetch" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const limit = TIMEOUT[pstr(p, "timeout")]; // undefined: no timeout
    const hangs = pstr(p, "api") === "hangs";
    const fallback = pstr(p, "onTimeout") === "fallback";
    const line: Req[] = []; // requests waiting for a free connection
    const pending = new Set<Req>(); // sent by a user and not answered yet, oldest first
    let busy = 0; // connections in use
    let stuck = 0; // connections held by calls that will never be answered (no timeout)
    let working = 0; // calls the API is working on
    let unanswered = 0; // calls the API will never answer that the app is still waiting on
    let id = 0;
    let ok = 0;
    let timedOut = 0;
    let healthyCut = 0;
    const lastSaid = new Map<string, number>();

    /** Logs at most once per `gap` ms for the same kind of event, so the log stays readable. */
    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const answer = (r: Req, kind: "reply" | "error", label: string) =>
      world.send("u-app", kind, HOP, () => pending.delete(r), { reverse: true, label });

    const release = () => {
      busy--;
      const next = line.shift();
      if (next) call(next);
    };

    const giveUp = (r: Req, hung: boolean, wouldTake: number) => {
      timedOut++;
      release();
      const what = fallback ? "answers with a fallback (say, the last cached copy)" : "answers 504 Gateway Timeout";
      if (hung) {
        unanswered--;
        say("cut-hung", 3000, `#${r.n}: no answer after ${limit! / 1000} s, so the app gives up, frees the connection and ${what}.`);
      } else {
        healthyCut++;
        say("cut-healthy", 3000, `#${r.n} is cut off at ${limit! / 1000} s, but the API was only slow: it would have answered after ${sec(wouldTake)}. The user ${fallback ? "gets the fallback" : "gets a 504"} anyway.`);
      }
      answer(r, fallback ? "reply" : "error", fallback ? "fallback" : "504");
    };

    /** Takes a connection and calls the API. */
    const call = (r: Req) => {
      busy++;
      const hung = hangs && world.random() < HANG;
      const work = world.random() < SLOW_SHARE ? SLOW[0] + world.random() * (SLOW[1] - SLOW[0]) : FAST[0] + world.random() * (FAST[1] - FAST[0]);
      const total = HOP + work + HOP; // what the call takes if it is answered
      const cut = limit !== undefined && (hung || total > limit);
      if (cut) world.after(limit!, () => giveUp(r, hung, total));
      world.send("app-api", "request", HOP, () => {
        if (hung) {
          if (cut) {
            unanswered++;
            return;
          }
          stuck++;
          unanswered++;
          say("hang", 5000, stuck === 1
            ? `#${r.n}'s call gets no answer. With no timeout the app keeps waiting (Node's fetch waits minutes by default), and the connection stays held.`
            : `#${r.n}'s call gets no answer either: ${stuck === CONNECTIONS ? `all ${CONNECTIONS}` : `${stuck} of the ${CONNECTIONS}`} connections are now held by calls that will never return.`);
          return;
        }
        working++;
        world.after(work, () => {
          working--;
          if (cut) return; // the app already gave up and closed the connection, so this answer goes nowhere
          world.send("app-api", "reply", HOP, () => {
            ok++;
            release();
            say("ok", 9000, limit
              ? `#${r.n} gets its data: the call took ${sec(total)}, inside the ${limit / 1000} s limit.`
              : `#${r.n} gets its data after ${sec(total)}. When the API answers, the missing timeout changes nothing.`);
            answer(r, "reply", "200");
          }, { reverse: true, label: "data" });
        });
      }, { label: `#${r.n}` });
    };

    world.every(GAP, () => {
      const r: Req = { n: ++id, started: world.time };
      pending.add(r);
      world.send("u-app", "request", HOP, () => {
        if (busy < CONNECTIONS) {
          call(r);
          return;
        }
        line.push(r);
        if (stuck === CONNECTIONS) say("jam", 4000, `#${r.n} waits in line: all ${CONNECTIONS} connections are held by calls the API will never answer, so nothing moves.`);
        else if (stuck > 0) say("jam", 4000, `#${r.n} waits for a connection: ${stuck} of the ${CONNECTIONS} are held by hung calls and the rest are busy.`);
        else say("wait", 5000, `#${r.n} waits for a connection: all ${CONNECTIONS} are in use${limit ? `, but each will be free within ${limit / 1000} s at most` : ""}.`);
      }, { label: `#${r.n}` });
    }, 0.6);

    return {
      tick(dt: number) {
        world.advance(dt);
        const first = pending.values().next().value as Req | undefined;
        const oldest = first ? world.time - first.started : 0;
        const q = line.length;
        const boxes: Record<string, BoxState> = {
          users: { note: pending.size ? `${pending.size} waiting` : "all answered", tone: pending.size >= 8 ? "bad" : undefined },
          app: {
            slots: { total: CONNECTIONS, busy, label: "API connections" },
            queue: q,
            note: stuck ? `${stuck} of ${CONNECTIONS} held by hung calls` : q ? `${q} waiting for a connection` : busy ? `${busy} call${busy === 1 ? "" : "s"} out to the API` : "idle",
            tone: stuck === CONNECTIONS || q >= 4 ? "bad" : busy === CONNECTIONS ? "busy" : busy ? "ok" : "idle",
          },
          api: {
            note: unanswered ? `${unanswered} call${unanswered === 1 ? "" : "s"} will never answer` : working ? `answering ${working} call${working === 1 ? "" : "s"}` : "idle",
            tone: unanswered ? "bad" : working ? "ok" : "idle",
          },
        };
        const counters: Counter[] = [
          { label: "Answered with API data", value: String(ok) },
          limit === undefined
            ? { label: "Calls stuck, holding a connection", value: String(stuck), tone: stuck ? "bad" : undefined }
            : { label: fallback ? "Timed out, got the fallback" : "Timed out, got a 504", value: String(timedOut) },
          { label: "Healthy calls cut off", value: String(healthyCut), tone: healthyCut ? "bad" : undefined },
          { label: "Longest wait right now", value: sec(oldest), tone: oldest > 6000 ? "bad" : undefined },
        ];
        return { boxes, tokens: world.tokens(), counters, log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Turn the timeout off: each call the API never answers keeps its connection, and once all 4 are held every new request waits in line, even though the API answers most calls quickly.", params: { timeout: "none", api: "hangs", onTimeout: "error" } },
    { text: "Make the timeout tight: hung calls are cut off sooner, but so are healthy calls that are only slow, and those users get an error they didn't need.", params: { timeout: "tight", api: "hangs", onTimeout: "error" } },
    { text: "Answer with a fallback: when a call times out the user gets a default answer (say, a cached copy) instead of a 504, so the page still works.", params: { timeout: "generous", api: "hangs", onTimeout: "fallback" } },
    { text: "Let the API always answer, with no timeout: everything flows, which is why a missing timeout goes unnoticed until the API has a bad day.", params: { timeout: "none", api: "healthy", onTimeout: "error" } },
  ],
};
