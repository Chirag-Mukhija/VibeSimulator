import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down and shortened to watch.
const HOP = 400;
const DB_HOP = 300;
const VERIFY = 100; // checking the signature: an HMAC, CPU only
const ENQUEUE = 150;
const WORK = 1800; // fulfilling an order: shipment, receipt email
const TIMEOUT = 2500; // how long the provider waits for your answer (shortened)
const BACKOFF = [3000, 6000, 12000]; // the provider waits longer before each retry
const MAX_TRIES = BACKOFF.length + 1;
const GAP = 3200; // average ms between payment events
const LOST = 0.15; // chance a 200 never reaches the provider (connection dropped); far more often than real life
const WORKERS = 2;
const FIRST_FORGERY = 7000;
const FORGERY_GAP = 11000;

type Source = "p-ep" | "a-ep";

interface Ev {
  id: number;
  name: string;
  forged: boolean;
  tries: number;
  delivered: boolean;
}

const forgeries = (n: number) => `${n} ${n === 1 ? "forgery" : "forgeries"}`;

export const webhooksScene: ConceptScene = {
  id: "webhooks",
  title: "Another service calling your URL",
  intro: "When a payment succeeds, the payment provider POSTs a signed event to your webhook URL. Your handler checks the signature (an attacker posts fakes too), queues the slow work and answers 200 at once. With no 2xx in time, the provider sends the event again, so the worker skips event ids it has already seen. Slowed down; timeouts and retry delays are shortened, and answers get lost far more often than in real life.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "handler", label: "Your handler", options: [
      { value: "fast", label: "Answers 200, queues the work" },
      { value: "slow", label: "Does the work, then answers" },
    ] },
    { type: "toggle", id: "dedupe", label: "Skip event ids already seen" },
    { type: "toggle", id: "verify", label: "Check the signature" },
  ],
  defaults: { handler: "fast", dedupe: true, verify: true },
  layout(p: SceneParams) {
    const fast = pstr(p, "handler") === "fast";
    return {
      boxes: [
        { id: "provider", kind: "external", label: "Payment provider", detail: "POSTs each event to you", x: 20, y: 30, w: 180, h: 100 },
        { id: "endpoint", kind: "app", label: "Your webhook", detail: fast ? "200 at once, work queued" : "does the work, then 200", x: 290, y: 30, w: 200, h: 100 },
        { id: "queue", kind: "queue", label: "Job queue", detail: fast ? "work for later" : "not used", x: 580, y: 30, w: 180, h: 100 },
        { id: "attacker", kind: "users", label: "Attacker", detail: "forges a paid event", x: 20, y: 270, w: 180, h: 100 },
        { id: "db", kind: "database", label: "Database", detail: pbool(p, "dedupe") ? "orders + seen event ids" : "orders", x: 290, y: 270, w: 200, h: 100 },
        { id: "workers", kind: "worker", label: "Workers", detail: fast ? `${WORKERS} workers fulfil orders` : "not used", x: 580, y: 270, w: 180, h: 100 },
      ],
      links: [
        { id: "p-ep", from: "provider", to: "endpoint", label: "POST" },
        { id: "a-ep", from: "attacker", to: "endpoint", label: "POST" },
        { id: "ep-q", from: "endpoint", to: "queue", label: "add job" },
        { id: "q-w", from: "queue", to: "workers", label: "take job" },
        { id: "ep-db", from: "endpoint", to: "db", label: "SQL" },
        { id: "w-db", from: "workers", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const fast = pstr(p, "handler") === "fast";
    const dedupe = pbool(p, "dedupe");
    const verify = pbool(p, "verify");
    const seen = new Set<number>(); // event ids recorded in the database
    const fulfilled = new Map<number, number>(); // times each event's order was fulfilled
    const waiting: Ev[] = [];
    const worker: (string | undefined)[] = Array.from({ length: WORKERS }, () => undefined);
    let events = 0;
    let deliveries = 0;
    let delivered = 0;
    let retrying = 0;
    let timeouts = 0;
    let inflight = 0; // requests your handler is still working on (slow handler)
    let answered = 0;
    let forged = 0;
    let rejected = 0;
    let letIn = 0;
    let newest = 0; // highest event id that has reached your endpoint
    let workerNote = "idle";
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const twice = () => [...fulfilled.values()].filter((n) => n > 1).length;

    /** The provider counts this try as failed and, unless it has tried enough, sends the event again later. */
    const failed = (ev: Ev, why: "timeout" | "lost") => {
      if (ev.tries >= MAX_TRIES) {
        say("give-up", 6000, `The provider gives up on ${ev.name} after ${MAX_TRIES} tries (real providers keep trying for much longer).`);
        return;
      }
      const wait = BACKOFF[ev.tries - 1]!;
      if (why === "timeout") say("timeout", 5000, `No answer to ${ev.name} after ${TIMEOUT / 1000} s: the provider counts this try as failed and will send it again in ${wait / 1000} s.`);
      else say("lost", 4000, `Your 200 for ${ev.name} never reached the provider (the connection dropped), so to it this try failed. It sends ${ev.name} again in ${wait / 1000} s.`);
      retrying++;
      world.after(wait, () => {
        retrying--;
        deliver(ev);
      });
    };

    /** The order is fulfilled: the slow work is done and the database says so. */
    const fulfil = (ev: Ev) => {
      const n = (fulfilled.get(ev.id) ?? 0) + 1;
      fulfilled.set(ev.id, n);
      if (ev.forged) say("forged-done", 5000, `The forged ${ev.name} is fulfilled: an order is marked paid and shipped, though no payment exists.`);
      else if (n > 1) say("twice", 4000, `${ev.name}'s order is fulfilled for the ${n === 2 ? "second" : n === 3 ? "third" : `${n}th`} time: nothing checked whether this event was already handled.`);
    };

    /**
     * Claims the event id before doing the work (INSERT ... ON CONFLICT DO NOTHING on a UNIQUE column),
     * so two copies can never both get past this step. `fresh` is false for an id seen before.
     */
    const claim = (link: "ep-db" | "w-db", ev: Ev, then: (fresh: boolean) => void) => {
      if (!dedupe) return then(true);
      world.send(link, "request", DB_HOP, () => {
        const fresh = !seen.has(ev.id);
        seen.add(ev.id);
        world.send(link, fresh ? "reply" : "empty", DB_HOP, () => then(fresh), { reverse: true, label: fresh ? "new id" : "seen before" });
      }, { label: `INSERT ${ev.name}` });
    };

    /** The slow part, then saving the order. */
    const work = (link: "ep-db" | "w-db", ev: Ev, then: () => void) => {
      world.after(WORK, () => world.send(link, "request", DB_HOP, () => {
        fulfil(ev);
        world.send(link, "reply", DB_HOP, then, { reverse: true, label: "saved" });
      }, { label: `UPDATE order (${ev.name})` }));
    };

    const dispatch = () => {
      for (let w = 0; w < WORKERS && waiting.length > 0; w++) {
        if (worker[w]) continue;
        const ev = waiting.shift()!;
        worker[w] = ev.name;
        world.send("q-w", "request", HOP, () => claim("w-db", ev, (fresh) => {
          if (!fresh) {
            workerNote = `skipped ${ev.name}: seen`;
            say("skip", 4000, `The worker finds ${ev.name} already recorded, so it skips it: this copy came from a retry, and the order is not fulfilled twice.`);
            worker[w] = undefined;
            dispatch();
            return;
          }
          workerNote = `fulfilling ${ev.name}`;
          work("w-db", ev, () => {
            worker[w] = undefined;
            dispatch();
          });
        }), { label: ev.name });
      }
    };

    /**
     * Your handler's answer. For the provider's events, `sentAt` is when that try left the provider:
     * an answer that would arrive after the provider's timeout is too late.
     */
    const answer = (src: Source, ev: Ev, status: "200" | "400", sentAt: number, settle?: () => void): "ok" | "late" | "lost" => {
      answered++;
      if (src === "a-ep") {
        world.send("a-ep", status === "200" ? "reply" : "error", HOP, undefined, { reverse: true, label: status });
        return "ok";
      }
      if (world.time + HOP > sentAt + TIMEOUT) {
        say("late", 5000, `Your handler finishes ${ev.name} and answers 200, but the provider stopped waiting at ${TIMEOUT / 1000} s: to it, this try failed.`);
        return "late";
      }
      settle?.();
      if (world.random() < LOST) {
        world.send("p-ep", "error", HOP, () => failed(ev, "lost"), { reverse: true, label: "200 lost" });
        return "lost";
      }
      world.send("p-ep", "reply", HOP, () => {
        if (!ev.delivered) delivered++;
        ev.delivered = true;
      }, { reverse: true, label: "200" });
      return "ok";
    };

    /** An event reaches your endpoint (from the provider or the attacker). */
    const arrive = (src: Source, ev: Ev, sentAt: number, settle?: () => void) => {
      if (!ev.forged) {
        if (ev.id < newest) say("order", 9000, `${ev.name} arrives after newer events: a retried event comes late, so webhooks can arrive out of order.`);
        newest = Math.max(newest, ev.id);
      }
      world.after(VERIFY, () => {
        if (ev.forged) {
          if (verify) {
            rejected++;
            say("forged", 5000, `The forged event's signature doesn't match: the attacker doesn't have your webhook secret. Rejected with 400, nothing done.`);
            answer(src, ev, "400", sentAt);
            return;
          }
          letIn++;
          say("forged-in", 5000, `Nothing checks the signature, so the attacker's fake "payment succeeded" event is treated as real.`);
        }
        if (fast) {
          world.after(ENQUEUE, () => {
            if (!ev.forged && ev.tries === 1) say("fast", 9000, `${ev.name}: the signature checks out, the handler adds a job to the queue and answers 200 straight away.`);
            else if (!ev.forged) say("fast-retry", 5000, `${ev.name} arrives again (try ${ev.tries}). The handler doesn't check for copies; it queues it and answers 200.`);
            answer(src, ev, "200", sentAt, settle);
            world.send("ep-q", "request", HOP, () => {
              waiting.push(ev);
              dispatch();
            }, { label: ev.name });
          });
          return;
        }
        inflight++;
        claim("ep-db", ev, (fresh) => {
          if (!fresh) {
            inflight--;
            if (answer(src, ev, "200", sentAt, settle) === "ok") say("seen", 5000, `${ev.name} arrives again, but its id is already recorded, so the handler skips the work and answers 200 in time. No more retries.`);
            return;
          }
          if (!ev.forged) say("slow", 7000, `${ev.name}${ev.tries > 1 ? ` (try ${ev.tries})` : ""}: the handler starts the slow work before answering, and the provider waits.`);
          work("ep-db", ev, () => {
            inflight--;
            answer(src, ev, "200", sentAt, settle);
          });
        });
      });
    };

    /** One try at delivering an event, with the provider's timeout running. */
    function deliver(ev: Ev) {
      ev.tries++;
      deliveries++;
      const sentAt = world.time;
      let answeredInTime = false;
      world.send("p-ep", "request", HOP, () => arrive("p-ep", ev, sentAt, () => (answeredInTime = true)), { label: ev.tries > 1 ? `${ev.name} try ${ev.tries}` : ev.name });
      world.after(TIMEOUT, () => {
        if (answeredInTime) return;
        timeouts++;
        failed(ev, "timeout");
      });
    }

    world.every(GAP, () => {
      const id = 100 + ++events;
      deliver({ id, name: `evt_${id}`, forged: false, tries: 0, delivered: false });
    }, 0.5);

    const forge = () => {
      const k = ++forged;
      const ev: Ev = { id: -k, name: `fake_${k}`, forged: true, tries: 1, delivered: false };
      world.send("a-ep", "request", HOP, () => arrive("a-ep", ev, world.time), { label: "forged event" });
      world.after(FORGERY_GAP * (0.8 + world.random() * 0.4), forge);
    };
    world.after(FIRST_FORGERY, forge);

    return {
      tick(dt: number) {
        world.advance(dt);
        const busy = worker.filter(Boolean).length;
        const dup = twice();
        const total = [...fulfilled.values()].reduce((a, b) => a + b, 0);
        const boxes: Record<string, BoxState> = {
          provider: { note: retrying ? `${delivered} delivered, ${retrying} to retry` : `${delivered} delivered`, tone: retrying ? "busy" : "ok" },
          attacker: verify
            ? { note: forged ? `${forgeries(rejected)} rejected` : "waiting", tone: "idle" }
            : { note: letIn ? `${forgeries(letIn)} let in` : "waiting", tone: letIn ? "bad" : "idle" },
          endpoint: fast
            ? { note: `${answered} answered`, tone: "ok" }
            : { note: inflight ? `${inflight} working, provider waits` : `${answered} answered`, tone: inflight ? "busy" : "ok" },
          queue: fast ? { queue: waiting.length, note: waiting.length ? `${waiting.length} waiting` : "empty", tone: waiting.length ? "busy" : "ok" } : { note: "not used", tone: "idle" },
          workers: fast
            ? { slots: { total: WORKERS, busy, label: "workers" }, note: busy ? workerNote : "idle", tone: busy ? "ok" : "idle" }
            : { note: "not used", tone: "idle" },
          db: { note: dup ? `${total} fulfilments, ${dup} repeated` : `${total} orders fulfilled`, tone: dup ? "bad" : "ok" },
        };
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Events", value: String(events) },
            { label: "Deliveries, retries included", value: String(deliveries), tone: timeouts && deliveries > events * 1.5 ? "bad" : undefined },
            { label: "Orders fulfilled more than once", value: String(dup), tone: dup ? "bad" : undefined },
            { label: "Forged events let in", value: String(letIn), tone: letIn ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn off skipping seen ids: most events are fine, but when a 200 gets lost the provider sends the event again and the worker fulfils that order a second time.", params: { handler: "fast", dedupe: false, verify: true } },
    { text: "Make the handler do the work before answering: it takes longer than the provider waits, so every event times out and is sent again. The id check catches the copy, but each event now costs two deliveries.", params: { handler: "slow", dedupe: true, verify: true } },
    { text: "Slow handler and no id check: every retry does the work again and times out again, so orders are fulfilled three or four times.", params: { handler: "slow", dedupe: false, verify: true } },
    { text: "Turn off the signature check: anyone who knows your URL can post a fake \"payment succeeded\" event, and an order ships that nobody paid for.", params: { handler: "fast", dedupe: true, verify: false } },
  ],
};
