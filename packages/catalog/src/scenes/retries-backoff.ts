import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pnum, pstr } from "./types.ts";
import { Station, World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const HOP = 400; // clients to the service
const GROUPS = 3; // client boxes
const PER_GROUP = 4; // clients in each box
const EVERY = 4000; // each client starts a new request about this often, whatever happened to its last one
const USUAL = (GROUPS * PER_GROUP) / (EVERY / 1000); // new requests per second: 3
const WORKERS = 4; // requests the service works on at once
const LINE = 4; // requests it lets wait; beyond that it answers 503 at once
const WORK: [number, number] = [500, 1000];
const BASE = 1000; // first backoff wait; it doubles after each failure
const CYCLE = 40000; // the outage repeats every 40 s, starting 6 s in
const OUTAGE_AT = 6000;
const OUTAGE: Record<string, number> = { short: 5000, long: 20000 };

interface Req {
  n: number;
  group: number;
  tries: number;
  started: number;
  inOutage: number; // tries that landed while the service was down
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const retriesBackoffScene: ConceptScene = {
  id: "retries-backoff",
  title: "Retrying without making an outage worse",
  intro: "Twelve clients each start a new request every few seconds, about 3 per second in all. At 6 s the service has an outage: it answers every request with 503 Service Unavailable at once. What happens next depends on how the clients retry. Slowed down; each envelope is a request or a reply.",
  width: 780,
  height: 380,
  controls: [
    { type: "choice", id: "retries", label: "Retries", options: [
      { value: "off", label: "Off" },
      { value: "immediate", label: "Immediate" },
      { value: "backoff", label: "Backoff + jitter" },
    ] },
    { type: "count", id: "maxTries", label: "Max tries per request", min: 2, max: 6 },
    { type: "choice", id: "outage", label: "Outage", options: [{ value: "short", label: "5 s" }, { value: "long", label: "20 s" }] },
  ],
  defaults: { retries: "backoff", maxTries: 4, outage: "short" },
  layout(p: SceneParams) {
    const retries = pstr(p, "retries");
    const detail = retries === "off" ? "an error is final" : retries === "immediate" ? "resend at once on 503" : "wait 1 s, 2 s, 4 s…";
    const boxes: SceneBox[] = [];
    const links: SceneLink[] = [];
    for (let g = 0; g < GROUPS; g++) {
      boxes.push({ id: `c${g + 1}`, kind: "users", label: `Clients ${g * PER_GROUP + 1}–${(g + 1) * PER_GROUP}`, detail, x: 20, y: 20 + g * 125, w: 170, h: 90 });
      links.push({ id: `c${g + 1}-svc`, from: `c${g + 1}`, to: "svc", label: g === 1 ? "HTTP" : undefined });
    }
    boxes.push({ id: "svc", kind: "server", label: "Service", detail: `${WORKERS} workers, line of ${LINE}`, x: 500, y: 125, w: 240, h: 130 });
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const mode = pstr(p, "retries");
    const maxTries = pnum(p, "maxTries");
    const outageMs = OUTAGE[pstr(p, "outage")] ?? 5000;
    const svc = new Station(world, WORKERS);
    const isDown = (t: number) => {
      const m = t % CYCLE;
      return m >= OUTAGE_AT && m < OUTAGE_AT + outageMs;
    };
    const sent = Array.from({ length: GROUPS }, () => 0); // requests out, per client box
    const backingOff = Array.from({ length: GROUPS }, () => 0); // requests waiting to retry, per box
    const arrivals: number[] = []; // when requests reached the service, for the rate
    let id = 0;
    let ok = 0;
    let failed = 0;
    let retries = 0;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const link = (r: Req) => `c${r.group + 1}-svc`;

    const attempt = (r: Req) => {
      r.tries++;
      if (r.tries > 1) retries++;
      sent[r.group]!++;
      world.send(link(r), "request", HOP, () => arrive(r), { label: r.tries > 1 ? `#${r.n} try ${r.tries}` : `#${r.n}` });
    };

    const arrive = (r: Req) => {
      arrivals.push(world.time);
      if (isDown(world.time)) {
        r.inOutage++;
        world.send(link(r), "error", HOP, () => failedTry(r, "down"), { reverse: true, label: "503" });
        return;
      }
      if (svc.busy >= WORKERS && svc.waiting.length >= LINE) {
        say("full", 3000, `#${r.n} gets 503: the service is up, but its ${WORKERS} workers are busy and its line of ${LINE} is full.`);
        world.send(link(r), "error", HOP, () => failedTry(r, "full"), { reverse: true, label: "503" });
        return;
      }
      svc.serve(WORK[0] + world.random() * (WORK[1] - WORK[0]), () => {
        world.send(link(r), "reply", HOP, () => {
          sent[r.group]!--;
          ok++;
          if (r.tries > 1) say("ok-retry", 3000, `#${r.n} succeeds on try ${r.tries}, ${sec(world.time - r.started)} after its first try${r.inOutage ? ", once the outage was over" : ""}.`);
        }, { reverse: true, label: "200" });
      });
    };

    const failedTry = (r: Req, why: "down" | "full") => {
      sent[r.group]!--;
      if (mode === "off") {
        failed++;
        say("off", 2500, `#${r.n} gets 503 and fails: with retries off, its user sees the error.`);
        return;
      }
      if (r.tries >= maxTries) {
        failed++;
        const reason = r.inOutage === r.tries ? "every try landed inside the outage" : why === "full" ? "the service's line was full" : "the outage outlasted its tries";
        say("gave-up", 3000, `#${r.n} gives up after ${r.tries} tries in ${sec(world.time - r.started)}: ${reason}.`);
        return;
      }
      if (mode === "immediate") {
        say("immediate", 2500, `#${r.n} gets 503 and is sent again at once (try ${r.tries + 1} of ${maxTries})${isDown(world.time) ? ", straight back into the same outage" : ""}.`);
        attempt(r);
        return;
      }
      // Exponential backoff with jitter: 1 s, 2 s, 4 s ..., each between half and one and a half times that.
      const wait = BASE * 2 ** (r.tries - 1) * (0.5 + world.random());
      say("backoff", 3000, `#${r.n} gets 503 and waits ${sec(wait)} before try ${r.tries + 1}: the wait doubles after each failure, plus a random part.`);
      backingOff[r.group]!++;
      world.after(wait, () => {
        backingOff[r.group]!--;
        attempt(r);
      });
    };

    for (let c = 0; c < 3; c++) {
      world.after(c * CYCLE + OUTAGE_AT, () => world.log(`The service has an outage: for ${outageMs / 1000} s it answers every request with 503.`));
      world.after(c * CYCLE + OUTAGE_AT + outageMs, () => world.log("The outage is over: the service answers normally again."));
    }
    // The storm, when there is one: instant retries pile onto the service that is down.
    world.every(250, () => {
      const k = arrivals.filter((t) => t > world.time - 1000).length;
      if (mode === "immediate" && isDown(world.time) && k >= 3 * USUAL) {
        say("storm", 5000, `${k} requests reached the service in the last second, ${(k / USUAL).toFixed(1)}× the usual ${USUAL}: most are instant retries.`);
      }
    });

    for (let c = 0; c < GROUPS * PER_GROUP; c++) {
      const group = c % GROUPS;
      world.every(EVERY, () => attempt({ n: ++id, group, tries: 0, started: world.time, inOutage: 0 }), 0.6);
    }

    return {
      tick(dt: number) {
        world.advance(dt);
        while (arrivals.length && arrivals[0]! <= world.time - 2000) arrivals.shift();
        const rate = arrivals.length / 2;
        const down = isDown(world.time);
        const full = svc.busy >= WORKERS && svc.waiting.length >= LINE;
        const left = Math.max(1, Math.ceil((OUTAGE_AT + outageMs - (world.time % CYCLE)) / 1000));
        const boxes: Record<string, BoxState> = {
          svc: {
            slots: { total: WORKERS, busy: svc.busy, label: "workers" },
            queue: svc.waiting.length,
            note: down ? `outage: 503 to all, ${left} s left` : full ? "line full: extras get 503" : `${svc.served} served`,
            tone: down ? "bad" : full ? "busy" : svc.busy ? "ok" : "idle",
          },
        };
        for (let g = 0; g < GROUPS; g++) {
          const b = backingOff[g]!;
          const s = sent[g]!;
          boxes[`c${g + 1}`] = { note: b ? `${s} sent, ${b} backing off` : s ? `${s} awaiting a reply` : "between requests", tone: b ? "busy" : undefined };
        }
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: `Requests per second at the service (new: ${USUAL})`, value: rate.toFixed(1), tone: rate > 4 * USUAL ? "bad" : undefined },
            { label: "Succeeded", value: String(ok) },
            { label: mode === "off" ? "Failed (not retried)" : `Gave up after ${maxTries} tries`, value: String(failed), tone: failed ? "bad" : undefined },
            { label: "Retries sent", value: String(retries) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn retries off: every request that reaches the service during the 5 s outage fails, and its user sees the error.", params: { retries: "off", maxTries: 4, outage: "short" } },
    { text: "Retry immediately: each failed request is resent the moment its 503 arrives, so the service gets several times its usual load, and many requests burn all their tries inside the outage and fail anyway.", params: { retries: "immediate", maxTries: 4, outage: "short" } },
    { text: "Allow only 2 tries with backoff: the single retry comes about 1 s later, often still inside the outage, so many more requests give up.", params: { retries: "backoff", maxTries: 2, outage: "short" } },
    { text: "Make the outage 20 s long: even with backoff, requests run out of tries and give up. The cap stops them retrying forever; retries can't fix a long outage.", params: { retries: "backoff", maxTries: 4, outage: "long" } },
  ],
};
