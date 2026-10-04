import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pnum, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms). One hour on the job's clock passes every HOUR ms of scene time.
const HOUR = 8000;
const FIRST = 1200; // the 8:00 tick
const START_HOUR = 8;
const CLOCK_HOP = 350; // the timer firing inside each instance (drawn as a hop)
const SKEW = 250; // instances' clocks and timers differ by up to this much
const REDIS_HOP = 350;
const EMAIL_HOP = 400;
const PREP = 500; // building one batch of reminders: a query and the templates
const BATCHES: Record<string, number> = { short: 2, long: 8 }; // batches per run
const RUN_MS = (k: number) => k * (PREP + 2 * EMAIL_HOP);
const minutes = (ms: number) => Math.round((ms / HOUR) * 60 / 10) * 10; // "about N min" on the job's clock

interface Run {
  inst: number;
  hour: number;
  batch: number;
  /** Not the first run for its hour: everything it sends was already sent. */
  extra: boolean;
}

const hourLabel = (h: number) => `${START_HOUR + h}:00`;
const instName = (i: number) => `Instance ${i + 1}`;
const names = (list: number[]) => {
  const n = list.map(instName);
  return n.length === 1 ? n[0]! : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};
const clockLink = (i: number) => `clk-i${i + 1}`;
const emailLink = (i: number) => `i${i + 1}-email`;
const redisLink = (i: number) => `i${i + 1}-redis`;

export const cronScene: ConceptScene = {
  id: "cron",
  title: "A job that runs on a schedule",
  intro: "A reminder job is scheduled for the top of every hour; here an hour passes every 8 s. The schedule lives in the app's code, so every running instance has its own timer, and they all fire at about the same moment. Before starting, each instance tries to take a lock in Redis, and only the one that gets it runs the job. Slowed down; each envelope is one message.",
  width: 780,
  height: 400,
  controls: [
    { type: "count", id: "instances", label: "App instances", min: 1, max: 3 },
    { type: "toggle", id: "lock", label: "Take a Redis lock before running" },
    { type: "choice", id: "job", label: "The job takes", options: [
      { value: "short", label: `About ${minutes(RUN_MS(BATCHES.short!))} min` },
      { value: "long", label: `About ${minutes(RUN_MS(BATCHES.long!))} min (over an hour)` },
    ] },
  ],
  defaults: { instances: 3, lock: true, job: "short" },
  layout(p: SceneParams) {
    const n = pnum(p, "instances");
    const lock = pbool(p, "lock");
    const gap = 54;
    const h = 84;
    const top = (400 - (n * h + (n - 1) * gap)) / 2;
    const boxes: SceneBox[] = [
      { id: "clock", kind: "clock", label: "Cron schedule", detail: "every hour, on the hour", x: 20, y: 155, w: 170, h: 90 },
      { id: "email", kind: "external", label: "Email provider", detail: "sends the reminders", x: 560, y: 40, w: 200, h: 100 },
      { id: "redis", kind: "cache", label: "Redis lock", detail: lock ? "SET NX: first one wins" : "not used", x: 560, y: 260, w: 200, h: 100 },
    ];
    const links: SceneLink[] = [];
    for (let i = 0; i < n; i++) {
      boxes.push({ id: `i${i + 1}`, kind: "server", label: instName(i), detail: "same code, same schedule", x: 280, y: top + i * (h + gap), w: 200, h });
      links.push(
        { id: clockLink(i), from: "clock", to: `i${i + 1}` },
        { id: emailLink(i), from: `i${i + 1}`, to: "email", label: "send" },
        { id: redisLink(i), from: `i${i + 1}`, to: "redis", label: "lock" },
      );
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const n = pnum(p, "instances");
    const lock = pbool(p, "lock");
    const batches = BATCHES[pstr(p, "job")] ?? BATCHES.short!;
    const runs: Run[][] = Array.from({ length: n }, () => []);
    const asking = Array.from({ length: n }, () => false);
    const idle: string[] = Array.from({ length: n }, () => "waiting for the hour"); // what an idle instance last did
    const perHour = new Map<number, number>();
    let holder: { inst: number; hour: number } | undefined;
    let ticks = 0;
    let started = 0;
    let extra = 0;
    let most = 0;
    let sent = 0;
    let dupSent = 0;
    let nextTick = FIRST;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const running = () => runs.reduce((a, r) => a + r.length, 0);

    const finish = (run: Run) => {
      const mine = runs[run.inst]!;
      mine.splice(mine.indexOf(run), 1);
      idle[run.inst] = `${hourLabel(run.hour)} run done`;
      if (!lock) {
        say("done", 6000, run.extra
          ? `${instName(run.inst)} finishes its copy of the ${hourLabel(run.hour)} run: every reminder in it had already been sent by another instance.`
          : `${instName(run.inst)} finishes the ${hourLabel(run.hour)} run: ${batches} batches of reminders sent.`);
        return;
      }
      world.send(redisLink(run.inst), "request", REDIS_HOP, () => {
        if (holder?.inst === run.inst && holder.hour === run.hour) holder = undefined;
        say("done", 6000, `${instName(run.inst)} finishes the ${hourLabel(run.hour)} run and deletes the lock, so the next hour's run can take it.`);
      }, { label: "DEL lock" });
    };

    const batch = (run: Run) => {
      run.batch++;
      world.after(PREP, () => {
        world.send(emailLink(run.inst), "request", EMAIL_HOP, () => {
          sent++;
          if (run.extra) dupSent++;
          world.send(emailLink(run.inst), "reply", EMAIL_HOP, () => (run.batch < batches ? batch(run) : finish(run)), { reverse: true, label: "202" });
        }, { label: `${hourLabel(run.hour)} batch ${run.batch}` });
      });
    };

    const begin = (i: number, hour: number) => {
      const count = (perHour.get(hour) ?? 0) + 1;
      perHour.set(hour, count);
      const run: Run = { inst: i, hour, batch: 0, extra: count > 1 };
      if (run.extra) extra++;
      const earlier = runs[i]!.find((r) => r.hour < hour);
      runs[i]!.push(run);
      started++;
      most = Math.max(most, running());
      if (earlier) say("overlap", 6000, `The ${hourLabel(hour)} run starts on ${instName(i)} while its ${hourLabel(earlier.hour)} run is still sending: two copies of the job now run at once.`);
      else if (!lock && count === n && n > 1) say("dup", 6000, `${hourLabel(hour)}: all ${n} instances started the job, so every reminder for this hour goes out ${n} times.`);
      batch(run);
    };

    /** Lock replies for one hour, so the losers share one log line. */
    const outcome = new Map<number, { winner?: number; losers: number[]; answers: number }>();
    const answered = (hour: number) => {
      const o = outcome.get(hour)!;
      o.answers++;
      if (o.answers < n || !o.losers.length) return;
      const busy = holder && holder.hour < hour ? holder : undefined;
      if (o.winner === undefined && busy) {
        say("held", 4000, `${hourLabel(hour)}: the lock is still held by the ${hourLabel(busy.hour)} run on ${instName(busy.inst)}, so ${n === 1 ? "the instance skips" : "every instance skips"} this hour instead of starting a second copy.`);
      } else if (o.winner !== undefined) {
        o.losers.sort((a, b) => a - b);
        say("lost", 4000, `${names(o.losers)} ${o.losers.length === 1 ? "finds" : "find"} the lock already taken, so ${o.losers.length === 1 ? "it skips" : "they skip"} the ${hourLabel(hour)} run.`);
      }
    };

    const fired = (i: number, hour: number) => {
      if (!lock) return begin(i, hour);
      asking[i] = true;
      world.send(redisLink(i), "request", REDIS_HOP + world.random() * 60, () => {
        const o = outcome.get(hour)!;
        if (!holder) {
          holder = { inst: i, hour };
          o.winner = i;
          world.send(redisLink(i), "reply", REDIS_HOP, () => {
            asking[i] = false;
            if (n > 1) say("won", 4000, `${hourLabel(hour)}: ${instName(i)}'s SET NX reaches Redis first, so it gets the lock and runs the job.`);
            answered(hour);
            begin(i, hour);
          }, { reverse: true, label: "OK" });
          return;
        }
        o.losers.push(i);
        world.send(redisLink(i), "empty", REDIS_HOP, () => {
          asking[i] = false;
          idle[i] = `skipped ${hourLabel(hour)}: lock taken`;
          answered(hour);
        }, { reverse: true, label: "taken" });
      }, { label: "SET lock NX" });
    };

    const tick = (hour: number) => {
      ticks++;
      nextTick = world.time + HOUR;
      outcome.set(hour, { losers: [], answers: 0 });
      if (n === 1 && !lock && runs[0]!.length === 0) say("tick", 6000, `${hourLabel(hour)}: the timer fires and the instance starts the reminder job.`);
      else if (n > 1 && !lock) say("tick", 6000, `${hourLabel(hour)}: every instance's timer fires, and nothing stops each of them from starting the job.`);
      for (let i = 0; i < n; i++) {
        world.after(world.random() * SKEW, () => world.send(clockLink(i), "push", CLOCK_HOP, () => fired(i, hour), { label: hourLabel(hour) }));
      }
      world.after(HOUR, () => tick(hour + 1));
    };
    world.after(FIRST, () => tick(0));

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          clock: { note: `next: ${hourLabel(ticks)} in ${Math.max(0, Math.ceil((nextTick - world.time) / 1000))} s`, tone: "ok" },
          email: { note: `${sent} batches${dupSent ? `, ${dupSent} duplicates` : ""}`, tone: dupSent ? "bad" : sent ? "ok" : "idle" },
          redis: lock
            ? { note: holder ? `held by ${instName(holder.inst)} (${hourLabel(holder.hour)})` : "free", tone: holder ? "busy" : "ok" }
            : { note: "not used", tone: "idle" },
        };
        for (let i = 0; i < n; i++) {
          const mine = runs[i]!;
          const r = mine.at(-1);
          let st: BoxState;
          if (mine.length > 1) st = { note: `${mine.length} runs at once`, tone: "bad" };
          else if (r) st = r.extra ? { note: `copy of ${hourLabel(r.hour)} run: batch ${r.batch}/${batches}`, tone: "bad" } : { note: `${hourLabel(r.hour)} run: batch ${r.batch} of ${batches}`, tone: "ok" };
          else if (asking[i]) st = { note: "asking Redis for the lock", tone: "busy" };
          else st = { note: idle[i], tone: "idle" };
          boxes[`i${i + 1}`] = st;
        }
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Times the schedule fired", value: String(ticks) },
            { label: "Job runs started", value: String(started) },
            { label: "Duplicate runs (same hour again)", value: String(extra), tone: extra ? "bad" : undefined },
            { label: "Most runs at the same time", value: String(most), tone: most > 1 ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn the lock off: all 3 instances start the job every hour, so every reminder goes out 3 times.", params: { instances: 3, lock: false, job: "short" } },
    { text: "One instance, no lock, and a job that takes over an hour: the next hour's run starts while the last one is still sending, so two copies run at once.", params: { instances: 1, lock: false, job: "long" } },
    { text: "Three instances, the lock on, and the long job: the lock stays taken until the run finishes, so the next hour finds it held and is skipped. Never more than one run at a time.", params: { instances: 3, lock: true, job: "long" } },
  ],
};
