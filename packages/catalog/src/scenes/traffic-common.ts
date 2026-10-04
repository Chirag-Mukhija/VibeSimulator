import type { World } from "./world.ts";

/** Small helpers shared by the traffic scenes: rate limiting, reverse proxy, CDN, API gateway, horizontal scaling. */

/** Logs at most once per `gap` ms for the same kind of event, so the log stays readable. */
export function throttledLog(world: World): (key: string, gap: number, text: string) => void {
  const last = new Map<string, number>();
  return (key, gap, text) => {
    const at = last.get(key);
    if (at !== undefined && world.time - at < gap) return;
    last.set(key, world.time);
    world.log(text);
  };
}

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
