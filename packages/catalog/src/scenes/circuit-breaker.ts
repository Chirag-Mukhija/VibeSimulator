import type { BoxState, ConceptScene, Counter, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pnum, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const USER_HOP = 400; // users to the app
const IN_PROCESS = 300; // the app to its breaker: a function call in the same process, slowed down to be visible
const HOP = 400; // to the stock service
const WORK: [number, number] = [400, 800]; // the service's work when it is healthy
const CALL_TIMEOUT = 2500; // the app gives up on a call after this long
const GAP = 900; // average ms between requests
const CYCLE = 60000; // the outages repeat every minute:
const OUTAGES: [number, number][] = [[6000, 12000], [24000, 38000]]; // a short one (6 s), then a long one (14 s)

type State = "closed" | "open" | "half-open";

const isDown = (t: number) => {
  const m = t % CYCLE;
  return OUTAGES.some(([from, to]) => m >= from && m < to);
};

export const circuitBreakerScene: ConceptScene = {
  id: "circuit-breaker",
  title: "A breaker that stops calling a service that is down",
  intro: "The app calls a stock service for every request. Twice a minute the service goes down, first for 6 s, then for 14 s: it takes calls but never answers, so each call fails only when the app's 2.5 s timeout runs out. A circuit breaker wraps the call, counts failures in a row, and once open fails calls at once without sending them. Slowed down; each envelope is a request or a reply.",
  width: 780,
  height: 400,
  controls: [
    { type: "toggle", id: "breaker", label: "Circuit breaker" },
    { type: "count", id: "threshold", label: "Failures in a row to open", min: 2, max: 5 },
    { type: "choice", id: "cooldown", label: "Wait before a trial call", options: [
      { value: "2", label: "2 s" },
      { value: "5", label: "5 s" },
      { value: "10", label: "10 s" },
    ] },
  ],
  defaults: { breaker: true, threshold: 3, cooldown: "5" },
  layout(p: SceneParams) {
    const on = pbool(p, "breaker");
    const boxes: SceneBox[] = [
      { id: "users", kind: "users", label: "Users", detail: "send requests", x: 20, y: 155, w: 150, h: 90 },
      { id: "app", kind: "app", label: "App", detail: on ? "calls via the breaker" : "calls the service", x: 240, y: 140, w: 180, h: 120 },
      { id: "svc", kind: "server", label: "Stock service", detail: "answers in about 1 s", x: 500, y: 270, w: 240, h: 110 },
    ];
    const links: SceneLink[] = [{ id: "u-app", from: "users", to: "app", label: "HTTP" }];
    if (on) {
      boxes.push({ id: "breaker", kind: "proxy", label: "Circuit breaker", detail: `opens after ${pnum(p, "threshold")} failures in a row`, x: 500, y: 20, w: 240, h: 120 });
      links.push({ id: "app-br", from: "app", to: "breaker", label: "in process" }, { id: "br-svc", from: "breaker", to: "svc", label: "HTTP" });
    } else {
      links.push({ id: "app-svc", from: "app", to: "svc", label: "HTTP" });
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const on = pbool(p, "breaker");
    const threshold = pnum(p, "threshold");
    const cooldown = Number(pstr(p, "cooldown")) * 1000;
    const out = on ? "br-svc" : "app-svc"; // the link calls travel to the service
    // Drawn up front, so every setting sees the same requests at the same moments and only the breaker differs.
    const gaps = Array.from({ length: 128 }, () => GAP * (1 + (world.random() * 2 - 1) * 0.5));
    const works = Array.from({ length: 128 }, () => WORK[0] + world.random() * (WORK[1] - WORK[0]));
    let state: State = "closed";
    let failures = 0; // in a row
    let halfOpenAt = 0;
    let trialOut = false;
    let id = 0;
    let ok = 0;
    let slowErrors = 0; // waited for the timeout, then failed
    let fastErrors = 0; // failed at once: the breaker was open
    let turnedAway = 0; // failed at once although the service was already back up
    let inFlight = 0; // calls the app is waiting on
    let working = 0;
    let unanswered = 0;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const toUser = (n: number, kind: "reply" | "error", label: string) => world.send("u-app", kind, USER_HOP, undefined, { reverse: true, label: `#${n} ${label}` });

    const open = (text: string) => {
      state = "open";
      halfOpenAt = world.time + cooldown;
      world.log(text);
      world.after(cooldown, () => {
        state = "half-open";
        world.log(`${cooldown / 1000} s are up: the breaker goes half-open and will let the next call through as a trial.`);
      });
    };

    /** The result of one call reaches the app (through the breaker when there is one). */
    const settle = (n: number, success: boolean, trial: boolean) => {
      inFlight--;
      if (success) {
        ok++;
        if (trial) {
          trialOut = false;
          state = "closed";
          failures = 0;
          world.log(`The trial call #${n} succeeded, so the breaker closes and calls flow to the service again.`);
        } else if (state === "closed") {
          if (failures > 0 && on) say("reset", 3000, `#${n} succeeded, so the count of failures in a row goes back to 0.`);
          failures = 0;
        }
        toUser(n, "reply", "200");
        return;
      }
      slowErrors++;
      if (!on) {
        say("slow", 3500, `#${n} waited ${CALL_TIMEOUT / 1000} s for the timeout, then got 504: with no breaker, every call still goes to the service that is down.`);
      } else if (trial) {
        trialOut = false;
        open(`Trial #${n} got no answer (the service was down when it arrived), so the breaker opens again for ${cooldown / 1000} s.`);
      } else if (state === "closed") {
        failures++;
        if (failures >= threshold) open(`#${n} timed out: ${failures} failures in a row. The breaker opens: for ${cooldown / 1000} s calls fail at once, and nothing is sent.`);
        else say("fail", 1500, `#${n} timed out after ${CALL_TIMEOUT / 1000} s: ${failures} failure${failures === 1 ? "" : "s"} in a row, the breaker opens at ${threshold}.`);
      }
      toUser(n, "error", "504");
    };

    /** Sends one call to the stock service; it fails if no answer comes within the timeout. */
    const call = (n: number, trial: boolean) => {
      inFlight++;
      const back = (success: boolean) => {
        if (on) world.send("app-br", success ? "reply" : "error", IN_PROCESS, () => settle(n, success, trial), { reverse: true, label: success ? "stock" : "timeout" });
        else settle(n, success, trial);
      };
      world.send(out, "request", HOP, () => {
        if (isDown(world.time)) {
          unanswered++;
          world.after(CALL_TIMEOUT - HOP, () => {
            unanswered--;
            back(false);
          });
          return;
        }
        working++;
        world.after(works[(n - 1) % works.length]!, () => {
          working--;
          world.send(out, "reply", HOP, () => back(true), { reverse: true, label: "stock" });
        });
      }, { label: trial ? `#${n} trial` : `#${n}` });
    };

    const request = (n: number) => {
      if (!on) {
        call(n, false);
        return;
      }
      world.send("app-br", "request", IN_PROCESS, () => {
        if (state === "closed") {
          call(n, false);
          return;
        }
        if (state === "half-open" && !trialOut) {
          trialOut = true;
          world.log(`#${n} is the trial call. Until it comes back, other requests still fail at once.`);
          call(n, true);
          return;
        }
        fastErrors++;
        const healthy = !isDown(world.time);
        if (healthy) {
          turnedAway++;
          say("turned", 4000, `#${n} fails at once although the service is back up: the breaker only learns that from a trial call.`);
        } else say("fast", 4000, `#${n} fails at once with 503: the breaker is ${state === "open" ? "open" : "waiting on its trial call"}, so nothing is sent to the service.`);
        world.send("app-br", "error", IN_PROCESS, () => toUser(n, "error", "503"), { reverse: true, label: "open" });
      }, { label: `#${n}` });
    };

    // Say when the service goes down and comes back.
    for (let c = 0; c < 4; c++) for (const [from, to] of OUTAGES) {
      world.after(c * CYCLE + from, () => world.log(`The stock service goes down for ${(to - from) / 1000} s: it takes calls but doesn't answer them.`));
      world.after(c * CYCLE + to, () => world.log(on && state !== "closed"
        ? `The stock service is back up, but the breaker is ${state}: it finds out only when a trial call succeeds.`
        : "The stock service is back up and answers calls again."));
    }

    const arrive = () => {
      const n = ++id;
      world.send("u-app", "request", USER_HOP, () => request(n), { label: `#${n}` });
      world.after(gaps[n % gaps.length]!, arrive);
    };
    world.after(gaps[0]!, arrive);

    return {
      tick(dt: number) {
        world.advance(dt);
        const down = isDown(world.time);
        const left = Math.max(1, Math.ceil((halfOpenAt - world.time) / 1000));
        const boxes: Record<string, BoxState> = {
          users: { note: `${ok} OK, ${slowErrors + fastErrors} errors` },
          app: { note: inFlight ? `${inFlight} waiting on the service` : "idle", tone: inFlight >= 4 ? "bad" : inFlight ? "ok" : "idle" },
          svc: down
            ? { note: unanswered ? `down: ${unanswered} call${unanswered === 1 ? "" : "s"} unanswered` : "down: not answering", tone: "bad" }
            : { note: working ? `healthy, answering ${working}` : "healthy", tone: working ? "ok" : "idle" },
        };
        if (on) {
          boxes.breaker = state === "closed"
            ? { note: failures ? `Closed: ${failures} failure${failures === 1 ? "" : "s"} in a row` : "Closed: calls pass through", tone: failures ? "busy" : "ok" }
            : state === "open"
              ? { note: `Open: failing fast, trial in ${left} s`, tone: "bad" }
              : { note: trialOut ? "Half-open: trial call out" : "Half-open: next call is a trial", tone: "busy" };
        }
        const counters: Counter[] = [
          { label: "Answered OK", value: String(ok) },
          { label: "Errors after waiting for the timeout", value: String(slowErrors), tone: slowErrors ? "bad" : undefined },
          { label: "Errors at once, nothing sent", value: String(fastErrors) },
          { label: "Turned away after it was back up", value: String(turnedAway), tone: turnedAway ? "bad" : undefined },
        ];
        return { boxes, tokens: world.tokens(), counters, log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Watch the breaker: after 3 timeouts in a row it opens and fails calls at once; 5 s later it goes half-open and sends one trial call. A trial that gets no answer opens it again; one that succeeds closes it.", params: { breaker: true, threshold: 3, cooldown: "5" } },
    { text: "Turn the breaker off: while the service is down every request still goes to it and waits 2.5 s for the timeout before its user gets an error.", params: { breaker: false } },
    { text: "Wait 10 s before a trial call: fewer trials go into the long outage, but after the short one the breaker stays open for seconds while the service is fine, turning away requests that would have worked.", params: { breaker: true, threshold: 3, cooldown: "10" } },
    { text: "Wait only 2 s: after the short outage the breaker closes within a couple of seconds, but in the long one more trial calls land while the service is down, and each of those users waits out the timeout.", params: { breaker: true, threshold: 3, cooldown: "2" } },
  ],
};
