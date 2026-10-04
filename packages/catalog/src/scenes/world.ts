import type { Token, TokenKind } from "./types.ts";

/** Deterministic random numbers (mulberry32), so a scene replays the same way. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Moving {
  token: Token;
  duration: number;
  elapsed: number;
  onArrive?: () => void;
}

/**
 * The little world a scene runs in: tokens moving along links, timers, and a log.
 * Time is scene milliseconds; the renderer decides how fast scene time passes.
 */
export class World {
  time = 0;
  readonly random: () => number;
  private moving: Moving[] = [];
  private timers: { at: number; fn: () => void }[] = [];
  private nextId = 1;
  private lines: string[] = [];

  constructor(seed = 1) {
    this.random = rng(seed);
  }

  /** Sends a token along a link; `onArrive` runs when it gets there. */
  send(link: string, kind: TokenKind, duration: number, onArrive?: () => void, opts: { reverse?: boolean; label?: string } = {}): void {
    this.moving.push({ token: { id: this.nextId++, link, t: 0, reverse: opts.reverse ?? false, kind, label: opts.label }, duration: Math.max(1, duration), elapsed: 0, onArrive });
  }

  after(ms: number, fn: () => void): void {
    this.timers.push({ at: this.time + ms, fn });
  }

  /** Calls `fn` every `ms` (with optional random jitter as a fraction of `ms`). */
  every(ms: number, fn: () => void, jitter = 0): void {
    const schedule = () => {
      const gap = ms * (1 + (this.random() * 2 - 1) * jitter);
      this.after(Math.max(10, gap), () => {
        fn();
        schedule();
      });
    };
    schedule();
  }

  log(text: string): void {
    this.lines.push(text);
    if (this.lines.length > 4) this.lines.shift();
  }

  advance(dt: number): void {
    // Small fixed steps keep arrivals and timers in order even on a slow frame.
    let left = Math.min(dt, 250);
    while (left > 0) {
      const step = Math.min(left, 16);
      left -= step;
      this.time += step;
      const arrived: Moving[] = [];
      for (const m of this.moving) {
        m.elapsed += step;
        m.token.t = Math.min(1, m.elapsed / m.duration);
        if (m.elapsed >= m.duration) arrived.push(m);
      }
      this.moving = this.moving.filter((m) => !arrived.includes(m));
      for (const m of arrived) m.onArrive?.();
      const due = this.timers.filter((t) => t.at <= this.time).sort((a, b) => a.at - b.at);
      this.timers = this.timers.filter((t) => t.at > this.time);
      for (const t of due) t.fn();
    }
  }

  tokens(): Token[] {
    return this.moving.map((m) => ({ ...m.token }));
  }

  recent(): string[] {
    return [...this.lines];
  }
}

/** A server (or pool, or worker set) with a fixed number of slots and a FIFO line. */
export class Station {
  busy = 0;
  readonly waiting: (() => void)[] = [];
  served = 0;
  readonly slots: number;
  private readonly world: World;

  constructor(world: World, slots: number) {
    this.world = world;
    this.slots = slots;
  }

  /** Runs `work` when a slot is free; `work` must call the release function it is given. */
  acquire(work: (release: () => void) => void): void {
    const run = () => {
      this.busy++;
      work(() => {
        this.busy--;
        this.served++;
        const next = this.waiting.shift();
        if (next) next();
      });
    };
    if (this.busy < this.slots) run();
    else this.waiting.push(run);
  }

  /** Holds a slot for `ms`, then calls `done`. */
  serve(ms: number, done: () => void): void {
    this.acquire((release) => this.world.after(ms, () => {
      release();
      done();
    }));
  }
}
