import type { BoxState, ConceptScene, Counter, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

const HOP = 400; // ms on each link, slowed down to watch
const GAP = 1400; // average ms between new jobs; bursty, like real orders
const WORK_MIN = 1000; // ms a healthy job takes
const WORK_MAX = 1400;
const CRASH = 900; // ms a broken job runs before the bug throws
const RETRY_AFTER = 1500; // ms a failed job waits before it is tried again
const MAX_TRIES = 3; // tries before a job is given up on (when there is a limit)
const WORKERS = 2;
const FIX_AT = 20000; // ms into the run when the developer starts on a fix
const FIX_WORK = 2500; // ms to find the bug and deploy the fix
const REPLAY_GAP = 350; // ms between replayed jobs
const SLOW_WAIT = 1500; // a recent average wait above this means healthy jobs are being held up
const RECENT = 8; // healthy jobs in the "recent wait" average
const BROKEN: Record<string, number> = { few: 1 / 5, many: 1 / 3 };

type Mode = "forever" | "drop" | "dlq";

interface Job {
  id: number;
  broken: boolean;
  tries: number;
  /** When it last joined the line. */
  queuedAt: number;
  replayed: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const deadLetterQueueScene: ConceptScene = {
  id: "dead-letter-queue",
  title: "Setting aside jobs that keep failing",
  intro: "The API adds a job per order and 2 workers take jobs off the queue. Some jobs are broken: a bug makes the worker crash on them every time, so retrying can never help. With a dead-letter queue (DLQ), a job that fails 3 tries is moved aside with its error, and the line keeps moving. Slowed down; each envelope is one job.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "failing", label: "A job that keeps failing", options: [
      { value: "forever", label: "Is retried forever" },
      { value: "drop", label: "Is deleted after 3 tries" },
      { value: "dlq", label: "Goes to the DLQ after 3 tries" },
    ] },
    { type: "choice", id: "broken", label: "Broken jobs", options: [{ value: "few", label: "1 in 5" }, { value: "many", label: "1 in 3" }] },
    { type: "toggle", id: "fix", label: "At 20 s a developer fixes the bug" },
  ],
  defaults: { failing: "dlq", broken: "few", fix: false },
  layout(p: SceneParams) {
    const mode = pstr(p, "failing") as Mode;
    const queueDetail = mode === "forever" ? "failed jobs rejoin, no limit" : mode === "drop" ? "3 tries, then deleted" : "3 tries, then to the DLQ";
    return {
      boxes: [
        { id: "api", kind: "app", label: "API", detail: "adds a job per order", x: 20, y: 40, w: 160, h: 90 },
        { id: "queue", kind: "queue", label: "Job queue", detail: queueDetail, x: 260, y: 30, w: 220, h: 110 },
        { id: "workers", kind: "worker", label: "Workers", detail: `${WORKERS} workers, a job each`, x: 560, y: 30, w: 200, h: 110 },
        { id: "dlq", kind: "queue", label: "Dead-letter queue", detail: mode === "dlq" ? "failed jobs, kept" : "not used", x: 560, y: 270, w: 200, h: 110 },
        { id: "dev", kind: "users", label: "Developer", detail: mode === "dlq" ? "reads errors, replays" : "no failed list to read", x: 260, y: 270, w: 220, h: 110 },
      ],
      links: [
        { id: "api-q", from: "api", to: "queue", label: "add job" },
        { id: "q-w", from: "queue", to: "workers", label: "take job" },
        { id: "w-dlq", from: "workers", to: "dlq", label: "give up" },
        { id: "dlq-dev", from: "dlq", to: "dev", label: "inspect" },
        { id: "dev-q", from: "dev", to: "queue", label: "replay" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const mode = pstr(p, "failing") as Mode;
    const share = BROKEN[pstr(p, "broken")] ?? BROKEN.few!;
    const fix = pbool(p, "fix");
    const waiting: Job[] = [];
    const dlq: Job[] = [];
    const onWorker: (Job | undefined)[] = Array.from({ length: WORKERS }, () => undefined);
    let delayed = 0; // failed jobs waiting out their delay before rejoining the line
    let id = 0;
    let done = 0;
    const waits: number[] = []; // recent healthy jobs: time from joining the line to a worker taking them
    let busyMs = 0; // worker time, all jobs
    let brokenMs = 0; // worker time spent on tries that crashed
    let dropped = 0;
    let live = 0; // broken jobs in the system: in line, delayed, on their way back, or on a worker
    let replayed = 0; // jobs sent back from the DLQ
    let recovered = 0; // replayed jobs that then completed
    let fixed = false;
    let dev: BoxState = mode === "dlq" ? { note: "no failed jobs yet", tone: "idle" } : { note: mode === "drop" ? "no record of dropped jobs" : "nothing set aside", tone: "idle" };
    const lastSaid = new Map<string, number>();

    /** Logs at most once per `gap` ms for the same kind of event, so the log stays readable. */
    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const alive = () => {
      // Broken jobs not yet finished or given up on: in line, delayed, or on a worker.
      const inLine = waiting.filter((j) => j.broken && !fixed).length;
      const working = onWorker.filter((j) => j?.broken && !fixed).length;
      return { inLine, working };
    };

    const dispatch = () => {
      for (let w = 0; w < WORKERS && waiting.length > 0; w++) {
        if (onWorker[w]) continue;
        const job = waiting.shift()!;
        onWorker[w] = job;
        if (!job.broken && job.tries === 0 && !job.replayed) {
          waits.push(world.time - job.queuedAt);
          if (waits.length > RECENT) waits.shift();
        }
        const took = world.time;
        world.send("q-w", "request", HOP, () => work(w, job, took), { label: `job #${job.id}` });
      }
    };

    const requeue = (job: Job) => {
      world.send("q-w", "error", HOP, () => {
        delayed++;
        world.after(RETRY_AFTER, () => {
          delayed--;
          job.queuedAt = world.time;
          waiting.push(job);
          dispatch();
        });
      }, { reverse: true, label: `#${job.id} retry` });
    };

    const work = (w: number, job: Job, took: number) => {
      job.tries++;
      const crashes = job.broken && !fixed;
      world.after(crashes ? CRASH : WORK_MIN + world.random() * (WORK_MAX - WORK_MIN), () => {
        onWorker[w] = undefined;
        const held = world.time - took;
        busyMs += held;
        if (!crashes) {
          done++;
          if (job.broken && !job.replayed) live--;
          if (job.replayed) {
            recovered++;
            say("recovered", 2500, `Replayed job #${job.id} completes: the order it belongs to is finally handled.`);
          } else if (job.broken) say("fixed-ok", 8000, `Job #${job.id} is the kind of order that used to crash; with the fix deployed it succeeds.`);
          dispatch();
          return;
        }
        brokenMs += held;
        if (mode === "forever") {
          say("forever", 3500, job.tries === 1
            ? `Job #${job.id} crashes. There is no limit on tries, so it goes back in line, and it will crash every time it comes round.`
            : `Job #${job.id} crashes for the ${ordinal(job.tries)} time and rejoins the line. ${plural(live, "broken job")} now keep${live === 1 ? "s" : ""} coming back.`);
          requeue(job);
        } else if (job.tries < MAX_TRIES) {
          say("retry", 3500, `Job #${job.id} crashes on try ${job.tries} of ${MAX_TRIES}, so it goes back in line to be tried again in ${RETRY_AFTER / 1000} s.`);
          requeue(job);
        } else if (mode === "drop") {
          live--;
          dropped++;
          say("drop", 2500, `Job #${job.id} failed ${MAX_TRIES} tries and is deleted. The worker is free, but nothing records which order was never handled.`);
        } else {
          live--;
          world.send("w-dlq", "error", HOP, () => {
            // A try that started just before the fix went live still ran the old code; replay it too.
            if (fixed) return replay(job, true);
            dlq.push(job);
            if (!fix || world.time < FIX_AT) dev = { note: `can read ${plural(dlq.length, "failed job")}`, tone: "busy" };
          }, { label: `#${job.id} dead` });
          say("dlq", 2500, `Job #${job.id} failed ${MAX_TRIES} tries, so it moves to the dead-letter queue with its error and data. The line keeps moving.`);
        }
        dispatch();
      });
    };

    /** The developer sends a dead job back to the queue, data unchanged. */
    const replay = (job: Job, last: boolean) => {
      replayed++;
      world.send("dev-q", "request", HOP, () => {
        job.tries = 0;
        job.replayed = true;
        job.queuedAt = world.time;
        waiting.push(job);
        dispatch();
        if (last) dev = { note: `fix live, ${replayed} replayed`, tone: "ok" };
      }, { label: `replay #${job.id}` });
    };

    world.every(GAP, () => {
      const job: Job = { id: ++id, broken: world.random() < share, tries: 0, queuedAt: 0, replayed: false };
      world.send("api-q", "request", HOP, () => {
        if (job.broken) live++;
        job.queuedAt = world.time;
        waiting.push(job);
        const ahead = waiting.length - 1;
        if (ahead >= 4) {
          const { inLine } = alive();
          say("line", 5000, inLine
            ? `Job #${job.id} joins a line of ${ahead}, and ${inLine} of them are broken jobs that will only crash again.`
            : `Job #${job.id} joins a line of ${ahead}: both workers are busy.`);
        }
        dispatch();
      }, { label: `job #${job.id}` });
    }, 0.6);

    if (fix) {
      world.after(FIX_AT, () => {
        const ship = () => {
          dev = { note: "deploying a fix", tone: "busy" };
          world.after(FIX_WORK, () => {
            fixed = true;
            if (mode === "dlq") {
              const dead = dlq.splice(0, dlq.length);
              dev = { note: dead.length ? `replaying ${plural(dead.length, "job")}` : "fix live, nothing to replay", tone: "ok" };
              world.log(dead.length
                ? `The fix is live. The developer replays the ${plural(dead.length, "job")} from the DLQ: they rejoin the line with their original data.`
                : "The fix is live; the DLQ is empty, so there is nothing to replay.");
              dead.forEach((job, i) => world.after(i * REPLAY_GAP, () => replay(job, i === dead.length - 1)));
            } else if (mode === "drop") {
              dev = { note: "fix live, nothing to replay", tone: "ok" };
              world.log(dropped
                ? `The fix is live, but the ${plural(dropped, "job")} deleted earlier left no trace: those orders are never handled.`
                : "The fix is live. No jobs had been deleted yet.");
            } else {
              dev = { note: "fix live", tone: "ok" };
              world.log("The fix is live: the broken jobs still going round will succeed on their next try instead of crashing.");
            }
          });
        };
        if (mode === "dlq") {
          dev = { note: "reading the failed jobs", tone: "busy" };
          world.log(dlq.length
            ? `A developer opens the DLQ: ${plural(dlq.length, "failed job")}, each with its data and the same error. That points straight at the bug.`
            : "A developer opens the DLQ: nothing in it yet.");
          world.send("dlq-dev", "error", HOP, () => world.after(600, ship), { label: "errors + data" });
        } else {
          world.log(mode === "drop"
            ? "A developer notices the crashes in the logs and starts on a fix. There is no list of the jobs that were deleted."
            : "A developer notices the crashes in the logs and starts on a fix. The broken jobs are still going round the queue.");
          ship();
        }
      });
    }

    return {
      tick(dt: number) {
        world.advance(dt);
        const q = waiting.length;
        const { inLine, working } = alive();
        const busy = onWorker.filter(Boolean).length;
        const avg = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : 0;
        const brokenShare = busyMs ? brokenMs / busyMs : 0;
        const full = `${q} waiting${inLine ? `, ${inLine} broken` : ""}${delayed ? `, ${delayed} delayed` : ""}`;
        const queueNote = q
          ? full.length <= 30 ? full : `${q} waiting${inLine ? `, ${inLine} broken` : ""}`
          : delayed ? `${delayed} waiting to retry` : "empty";
        const boxes: Record<string, BoxState> = {
          api: { note: `${id} jobs added` },
          queue: { queue: q, note: queueNote, tone: q >= 6 ? "bad" : q ? "busy" : "ok" },
          workers: {
            slots: { total: WORKERS, busy, label: "workers" },
            note: working ? `${working} on a broken job` : `${done} jobs done`,
            tone: busy === WORKERS ? "busy" : busy ? "ok" : "idle",
          },
          dlq: mode === "dlq"
            ? { queue: dlq.length, note: dlq.length ? `${plural(dlq.length, "job")}, each with its error` : replayed ? `${recovered} of ${replayed} replays done` : "empty", tone: dlq.length ? "busy" : "ok" }
            : { note: "not used", tone: "idle" },
          dev,
        };
        const last: Counter = mode === "forever"
          ? { label: "Worker time on broken jobs", value: `${Math.round(brokenShare * 100)}%`, tone: brokenShare > 0.5 ? "bad" : undefined }
          : mode === "drop"
            ? { label: "Jobs deleted, no record kept", value: String(dropped), tone: dropped ? "bad" : undefined }
            : { label: "In the dead-letter queue", value: String(dlq.length) };
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Jobs done", value: String(done) },
            { label: "Wait for a worker, recent healthy jobs", value: waits.length ? secs(avg) : "–", tone: avg > SLOW_WAIT ? "bad" : undefined },
            { label: "Broken jobs still being retried", value: String(live), tone: live >= 6 ? "bad" : undefined },
            last,
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Retry forever: broken jobs never leave, so more and more of them keep coming back for another try, the line grows, and healthy jobs wait longer and longer for a worker.", params: { failing: "forever", fix: false } },
    { text: "Delete after 3 tries: the workers stay free and healthy jobs barely wait, but each deleted job is simply gone, with no record of which order was never handled.", params: { failing: "drop", fix: false } },
    { text: "Keep the DLQ and turn on the fix: at 20 s a developer reads the failed jobs and their error, deploys a fix and replays them, and every replayed job completes.", params: { failing: "dlq", fix: true } },
    { text: "Turn on the fix with deleting instead: orders after the fix succeed, but the jobs deleted before it are lost for good, because there is nothing to replay.", params: { failing: "drop", fix: true } },
  ],
};

function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const end = teen ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${end}`;
}
