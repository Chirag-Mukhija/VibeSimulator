/**
 * A small deterministic discrete-event simulator. Simulated work is written
 * as generator "processes" that yield what they wait for:
 *
 *   sim.spawn(function* () {
 *     yield sim.timeout(2);          // network hop
 *     yield pool.acquire();          // borrow a connection (may queue)
 *     yield sim.timeout(5);          // query
 *     pool.release();
 *   });
 *
 * Time is in milliseconds. The same seed always gives the same result.
 */

export type Op =
  | { type: "timeout"; ms: number }
  | { type: "acquire"; resource: Resource; resolve?: (granted: boolean) => void }
  | { type: "wait"; signal: Signal };

export type Process = Generator<Op, void, unknown>;

interface Scheduled {
  time: number;
  seq: number;
  fn: () => void;
}

export class Sim {
  now = 0;
  readonly rng: Rng;
  private heap: Scheduled[] = [];
  private seq = 0;
  private stopped = false;
  events = 0;

  constructor(seed = 1) {
    this.rng = new Rng(seed);
  }

  schedule(delay: number, fn: () => void): void {
    push(this.heap, { time: this.now + Math.max(0, delay), seq: this.seq++, fn });
  }

  timeout(ms: number): Op {
    return { type: "timeout", ms };
  }

  spawn(process: Process, delay = 0): void {
    this.schedule(delay, () => this.step(process, undefined));
  }

  stop(): void {
    this.stopped = true;
  }

  /** Runs until the queue is empty, `until` ms, or `maxEvents`. */
  run(until = Infinity, maxEvents = 5_000_000): void {
    this.stopped = false;
    while (this.heap.length && !this.stopped && this.events < maxEvents) {
      const next = this.heap[0]!;
      if (next.time > until) {
        this.now = until;
        return;
      }
      pop(this.heap);
      this.now = next.time;
      this.events++;
      next.fn();
    }
    if (until !== Infinity && !this.stopped) this.now = Math.max(this.now, until);
  }

  /** Repeats `fn` every `ms` from `start`, for time series and periodic arrivals. */
  every(ms: number, fn: () => void, start = 0): void {
    const tick = () => {
      fn();
      this.schedule(ms, tick);
    };
    this.schedule(start, tick);
  }

  private step(process: Process, value: unknown): void {
    const r = process.next(value);
    if (r.done) return;
    const op = r.value;
    if (op.type === "timeout") {
      this.schedule(op.ms, () => this.step(process, undefined));
    } else if (op.type === "acquire") {
      op.resource.request((granted) => this.step(process, granted));
    } else {
      op.signal.waiters.push(() => this.step(process, undefined));
    }
  }
}

/** A pool of identical units (CPU cores, connections, worker slots) with a FIFO wait queue. */
export class Resource {
  inUse = 0;
  readonly queue: { since: number; cb: (granted: boolean) => void }[] = [];
  /** Time-weighted area of inUse and queue length, for utilization and Little's law. */
  private busyArea = 0;
  private queueArea = 0;
  private lastChange = 0;
  readonly waits = new Histogram();
  rejected = 0;

  private readonly sim: Sim;
  capacity: number;
  /** Requests beyond this many waiting are rejected (Infinity: never). */
  maxQueue: number;

  constructor(sim: Sim, capacity: number, maxQueue = Infinity) {
    this.sim = sim;
    this.capacity = capacity;
    this.maxQueue = maxQueue;
  }

  acquire(): Op {
    return { type: "acquire", resource: this };
  }

  request(cb: (granted: boolean) => void): void {
    this.account();
    if (this.inUse < this.capacity) {
      this.inUse++;
      this.waits.add(0);
      this.sim.schedule(0, () => cb(true));
    } else if (this.queue.length >= this.maxQueue) {
      this.rejected++;
      this.sim.schedule(0, () => cb(false));
    } else {
      this.queue.push({ since: this.sim.now, cb });
    }
  }

  release(): void {
    this.account();
    const next = this.queue.shift();
    if (next) {
      this.waits.add(this.sim.now - next.since);
      this.sim.schedule(0, () => next.cb(true));
    } else {
      this.inUse = Math.max(0, this.inUse - 1);
    }
  }

  private account(): void {
    const dt = this.sim.now - this.lastChange;
    this.busyArea += dt * this.inUse;
    this.queueArea += dt * this.queue.length;
    this.lastChange = this.sim.now;
  }

  /** Average fraction of capacity in use over [0, now]. */
  utilization(): number {
    this.account();
    return this.sim.now > 0 ? this.busyArea / (this.sim.now * this.capacity) : 0;
  }

  meanQueue(): number {
    this.account();
    return this.sim.now > 0 ? this.queueArea / this.sim.now : 0;
  }
}

/** Something processes can wait for until it fires (a new message, a job). */
export class Signal {
  waiters: (() => void)[] = [];
  private readonly sim: Sim;

  constructor(sim: Sim) {
    this.sim = sim;
  }

  wait(): Op {
    return { type: "wait", signal: this };
  }

  /** Wakes every waiter. */
  fire(): number {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) this.sim.schedule(0, w);
    return ws.length;
  }
}

/** Collects samples; percentiles by sorting on demand. */
export class Histogram {
  private values: number[] = [];
  private sorted = true;
  count = 0;
  sum = 0;
  max = 0;
  private readonly cap: number;

  constructor(cap = 400_000) {
    this.cap = cap;
  }

  add(v: number): void {
    this.count++;
    this.sum += v;
    if (v > this.max) this.max = v;
    if (this.values.length < this.cap) this.values.push(v);
    else this.values[this.count % this.cap] = v; // keep a rolling sample when huge
    this.sorted = false;
  }

  mean(): number {
    return this.count ? this.sum / this.count : 0;
  }

  percentile(p: number): number {
    if (!this.values.length) return 0;
    if (!this.sorted) {
      this.values.sort((a, b) => a - b);
      this.sorted = true;
    }
    const i = Math.min(this.values.length - 1, Math.max(0, Math.ceil((p / 100) * this.values.length) - 1));
    return this.values[i]!;
  }
}

/** mulberry32: tiny, fast, good enough for simulation. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Exponential with the given mean (Poisson inter-arrival times). */
  exp(mean: number): number {
    return -Math.log(1 - this.next()) * mean;
  }

  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Log-normal with a given mean and coefficient of variation: realistic service times. */
  lognormal(mean: number, cv: number): number {
    if (cv <= 0) return mean;
    const sigma2 = Math.log(1 + cv * cv);
    const mu = Math.log(mean) - sigma2 / 2;
    return Math.exp(mu + Math.sqrt(sigma2) * this.normal());
  }

  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

// ---- binary heap ordered by (time, seq)

function less(a: Scheduled, b: Scheduled): boolean {
  return a.time < b.time || (a.time === b.time && a.seq < b.seq);
}

function push(h: Scheduled[], item: Scheduled): void {
  h.push(item);
  let i = h.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!less(h[i]!, h[p]!)) break;
    [h[i], h[p]] = [h[p]!, h[i]!];
    i = p;
  }
}

function pop(h: Scheduled[]): Scheduled | undefined {
  const top = h[0];
  const last = h.pop();
  if (h.length && last) {
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < h.length && less(h[l]!, h[m]!)) m = l;
      if (r < h.length && less(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
  return top;
}
