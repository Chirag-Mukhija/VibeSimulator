import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pnum, pstr } from "./types.ts";
import { World } from "./world.ts";

const HOP = 400; // ms on each link, slowed down to watch
const ENQUEUE = 150; // ms for the API to add a job to the queue
const SEND_MIN = 1300; // ms to send one email: the slow part
const SEND_MAX = 1900;
const FAIL = 0.12; // chance the email service times out on any one try
const RETRY_AFTER = 2500; // ms a failed job waits before it is tried again
const MAX_TRIES = 3; // after this many failures a job is set aside for a person
const BACKLOG = 5; // a line this long means the workers are falling behind
const GAP: Record<string, number> = { light: 1300, busy: 600 }; // average ms between orders

interface Job {
  id: number;
  tries: number;
}

export const messageQueueScene: ConceptScene = {
  id: "message-queue",
  title: "Slow work handed to a queue",
  intro: "Every order needs a receipt email, and sending one is slow. With a queue, the API only adds a job and answers at once; workers take jobs off the queue at their own pace. Without it, the API sends the email itself while the user waits. Slowed down; each envelope is a request or a job.",
  width: 780,
  height: 400,
  controls: [
    { type: "toggle", id: "queue", label: "Use a queue" },
    { type: "count", id: "workers", label: "Workers", min: 1, max: 4 },
    { type: "choice", id: "traffic", label: "Orders", options: [{ value: "light", label: "Light" }, { value: "busy", label: "Busy" }] },
  ],
  defaults: { queue: true, workers: 2, traffic: "light" },
  layout(p: SceneParams) {
    const queued = pbool(p, "queue");
    const n = pnum(p, "workers");
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "place orders", x: 20, y: 148, w: 140, h: 84 },
        { id: "api", kind: "app", label: "API", detail: queued ? "adds a job, answers 202" : "sends the email itself", x: 240, y: 136, w: 190, h: 108 },
        { id: "queue", kind: "queue", label: "Job queue", detail: queued ? "jobs wait here in order" : "not used", x: 520, y: 20, w: 220, h: 116 },
        { id: "workers", kind: "worker", label: "Workers", detail: queued ? `${n} worker${n === 1 ? "" : "s"}, ~1.6 s per email` : "not used", x: 520, y: 260, w: 220, h: 120 },
      ],
      links: [
        { id: "u-api", from: "users", to: "api", label: "HTTP" },
        { id: "api-q", from: "api", to: "queue", label: "add job" },
        { id: "q-w", from: "queue", to: "workers", label: "take job" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const queued = pbool(p, "queue");
    const n = pnum(p, "workers");
    const waiting: Job[] = [];
    let busy = 0; // workers holding a job
    let backingOff = 0; // failed jobs waiting out their delay before going back in line
    let behind = false; // the line got long; say so when it empties
    let id = 0;
    let answered = 0;
    let totalMs = 0;
    let sent = 0;
    let retries = 0;
    let setAside = 0;
    let errors = 0;
    let inline = 0; // requests waiting on an email inside the API (no queue)
    const sendTime = () => SEND_MIN + world.random() * (SEND_MAX - SEND_MIN);
    const allBusy = () => (n === 1 ? "the only worker is busy" : n === 2 ? "both workers are busy" : `all ${n} workers are busy`);

    const reply = (started: number, ok: boolean, label: string) =>
      world.send("u-api", ok ? "reply" : "error", HOP, () => {
        answered++;
        totalMs += world.time - started;
      }, { reverse: true, label });

    /** Free workers take the oldest jobs. */
    const dispatch = () => {
      while (busy < n && waiting.length > 0) {
        const job = waiting.shift()!;
        busy++;
        world.send("q-w", "request", HOP, () => work(job), { label: `job #${job.id}` });
      }
      if (behind && waiting.length === 0) {
        behind = false;
        world.log("The line is empty again: the workers caught up with the backlog.");
      }
    };

    const work = (job: Job) => {
      job.tries++;
      world.after(sendTime(), () => {
        busy--;
        if (world.random() >= FAIL) {
          sent++;
          dispatch();
          return;
        }
        if (job.tries >= MAX_TRIES) {
          setAside++;
          world.log(`Job #${job.id} failed ${MAX_TRIES} times, so it is set aside in a failed list for a person to look at.`);
          dispatch();
          return;
        }
        retries++;
        world.log(`Job #${job.id} failed: the email service timed out. It goes back on the queue to try again in ${RETRY_AFTER / 1000} s.`);
        world.send("q-w", "error", HOP, () => {
          backingOff++;
          world.after(RETRY_AFTER, () => {
            backingOff--;
            waiting.push(job);
            dispatch();
          });
        }, { reverse: true, label: `#${job.id} retry` });
        dispatch();
      });
    };

    world.every(GAP[pstr(p, "traffic")] ?? 1300, () => {
      const req = ++id;
      const started = world.time;
      world.send("u-api", "request", HOP, () => {
        if (queued) {
          world.after(ENQUEUE, () => {
            reply(started, true, "202");
            world.send("api-q", "request", HOP, () => {
              waiting.push({ id: req, tries: 0 });
              const ahead = waiting.length - 1;
              if (busy < n) world.log(`Job #${req} lands on the queue and a free worker takes it. The user already has their answer.`);
              else if (ahead >= BACKLOG) {
                behind = true;
                world.log(`Job #${req} joins a line of ${ahead}: orders arrive faster than ${n === 1 ? "one worker" : `${n} workers`} can send emails.`);
              } else world.log(`Job #${req} waits: ${allBusy()}${ahead ? `, ${ahead} ahead of it` : ""}. The user already has their answer.`);
              dispatch();
            }, { label: `job #${req}` });
          });
          return;
        }
        inline++;
        world.log(`#${req}: no queue, so the API sends the email itself and the user waits for it.`);
        world.after(sendTime(), () => {
          inline--;
          if (world.random() < FAIL) {
            errors++;
            world.log(`#${req}: the email service timed out, so the user gets an error after all that waiting.`);
            reply(started, false, "error");
          } else {
            sent++;
            reply(started, true, "sent");
          }
        });
      }, { label: `#${req}` });
    }, 0.35);

    return {
      tick(dt: number) {
        world.advance(dt);
        const q = waiting.length;
        const avg = answered ? totalMs / answered : 0;
        const later = backingOff ? `${backingOff} retrying soon` : "";
        const boxes: Record<string, BoxState> = {
          users: { note: `${answered} answered${errors ? `, ${errors} errors` : ""}` },
          api: queued
            ? { note: "answers without waiting", tone: "ok" }
            : { note: inline ? `${inline} user${inline === 1 ? "" : "s"} waiting on an email` : "idle", tone: inline ? "busy" : "idle" },
          queue: queued
            ? { queue: q, note: q ? `${q} waiting${later ? `, ${later}` : ""}` : later || "empty", tone: q >= BACKLOG ? "bad" : q ? "busy" : "ok" }
            : { note: "not used", tone: "idle" },
          workers: queued
            ? { slots: { total: n, busy, label: "workers" }, note: `${sent} emails sent${setAside ? `, ${setAside} set aside` : ""}`, tone: busy === n ? "busy" : busy ? "ok" : "idle" }
            : { note: "not used", tone: "idle" },
        };
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Average response time", value: answered ? `${(avg / 1000).toFixed(1)} s` : "–", tone: answered && avg > 2000 ? "bad" : undefined },
            queued
              ? { label: "Jobs waiting", value: String(q), tone: q >= BACKLOG ? "bad" : undefined }
              : { label: "Users waiting on an email", value: String(inline) },
            { label: "Emails sent", value: String(sent) },
            queued
              ? { label: "Retried after a failure", value: String(retries) }
              : { label: "Errors shown to users", value: String(errors), tone: errors ? "bad" : "good" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn the queue off: the API now sends each email before answering, so every user waits well over a second longer, and when the email service times out the user gets the error.", params: { queue: false } },
    { text: "Busy orders with 1 worker: jobs arrive faster than one worker can send emails, so the line keeps growing, yet users still get their answer in about a second.", params: { queue: true, workers: 1, traffic: "busy" } },
    { text: "Same busy orders with 4 workers: together they send emails as fast as orders arrive, so the line stays short.", params: { queue: true, workers: 4, traffic: "busy" } },
    { text: "With the queue on, watch for red envelopes from the workers: a failed send goes back on the queue and is tried again a few seconds later, and the user never notices.", params: { queue: true, workers: 2, traffic: "light" } },
  ],
};
