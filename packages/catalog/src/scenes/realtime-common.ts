import type { BoxState, Counter, SceneBox, SceneControl, SceneLink, SceneParams } from "./types.ts";
import { pnum, pstr } from "./types.ts";
import type { World } from "./world.ts";

/**
 * Shared by the four realtime scenes (short polling, long polling, SSE, WebSocket): the same
 * browser tabs, one server, a news source with the same timings for the same seed, and the
 * same four counters, so a reader can switch pages and compare like for like.
 */

export const WIDTH = 780;
export const HEIGHT = 400;
export const HOP = 400; // ms on each link, slowed down to watch
export const NEWS_LINK = "news-srv";

const NEWS_GAP: Record<string, number> = { rare: 8000, often: 2500 }; // average ms between news items
const NEWS_JITTER = 0.5;
const FIRST_NEWS = 3500;
const FLASH = 1200; // ms a tab stays highlighted after it learns something new

export const newsControl: SceneControl = { type: "choice", id: "news", label: "News", options: [{ value: "rare", label: "Rare" }, { value: "often", label: "Often" }] };
export const tabsControl: SceneControl = { type: "count", id: "tabs", label: "Browser tabs", min: 2, max: 4 };

export const tabLink = (i: number) => `tab${i + 1}-srv`;

export function realtimeLayout(p: SceneParams, o: { tabDetail: string; serverDetail: string; linkLabel: string; persistent: boolean }): { boxes: SceneBox[]; links: SceneLink[] } {
  const n = pnum(p, "tabs");
  const h = 76;
  const gap = n >= 4 ? 18 : n === 3 ? 34 : 60;
  const top = (HEIGHT - (n * h + (n - 1) * gap)) / 2;
  const boxes: SceneBox[] = [];
  const links: SceneLink[] = [];
  for (let i = 0; i < n; i++) {
    boxes.push({ id: `tab${i + 1}`, kind: "browser", label: `Tab ${i + 1}`, detail: o.tabDetail, x: 20, y: top + i * (h + gap), w: 190, h });
    links.push({ id: tabLink(i), from: `tab${i + 1}`, to: "server", label: o.linkLabel, persistent: o.persistent });
  }
  const gapMs = NEWS_GAP[pstr(p, "news")] ?? NEWS_GAP.rare!;
  boxes.push({ id: "server", kind: "server", label: "Server", detail: o.serverDetail, x: 310, y: (HEIGHT - 120) / 2, w: 200, h: 120 });
  boxes.push({ id: "news", kind: "channel", label: "News", detail: `one every ~${gapMs / 1000} s`, x: 600, y: (HEIGHT - 90) / 2, w: 160, h: 90 });
  links.push({ id: NEWS_LINK, from: "news", to: "server" });
  return { boxes, links };
}

export interface NewsItem {
  id: number;
  /** When it reached the server. */
  at: number;
}

/**
 * News appearing on the server. Construct it first in `start`, before anything else uses
 * `world.random()`: the gaps are drawn up front, so all four scenes get news at the same moments.
 */
export class NewsFeed {
  readonly items: NewsItem[] = [];
  private made = 0;

  constructor(world: World, p: SceneParams, onArrive: (item: NewsItem) => void) {
    const avg = NEWS_GAP[pstr(p, "news")] ?? NEWS_GAP.rare!;
    const gaps = Array.from({ length: 64 }, () => avg * (1 + (world.random() * 2 - 1) * NEWS_JITTER));
    const make = () => {
      const id = ++this.made;
      world.send(NEWS_LINK, "push", HOP, () => {
        const item = { id, at: world.time };
        this.items.push(item);
        onArrive(item);
      }, { label: `news #${id}` });
      world.after(gaps[(id - 1) % gaps.length]!, make);
    };
    world.after(FIRST_NEWS, make);
  }

  since(id: number): NewsItem[] {
    return this.items.filter((n) => n.id > id);
  }

  get latest(): number {
    return this.items.at(-1)?.id ?? 0;
  }
}

export interface Tab {
  i: number;
  name: string;
  link: string;
  /** The newest news id this tab has seen. */
  seen: number;
  got: Set<number>;
  flashUntil: number;
}

export function makeTabs(p: SceneParams): Tab[] {
  return Array.from({ length: pnum(p, "tabs") }, (_, i) => ({ i, name: `Tab ${i + 1}`, link: tabLink(i), seen: 0, got: new Set<number>(), flashUntil: -1 }));
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** "#3", "#3 and #4", "#3 to #6". */
export function ids(items: NewsItem[]): string {
  if (items.length === 1) return `#${items[0]!.id}`;
  if (items.length === 2) return `#${items[0]!.id} and #${items[1]!.id}`;
  return `#${items[0]!.id} to #${items.at(-1)!.id}`;
}

/** The four numbers every realtime scene shows. */
export class Tally {
  requests = 0;
  answers = 0;
  empty = 0;
  delivered = 0;
  waited = 0;
  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  /** A tab has received these items; returns the ones it had not seen before. */
  see(tab: Tab, items: NewsItem[]): NewsItem[] {
    const fresh = items.filter((n) => !tab.got.has(n.id));
    for (const n of fresh) {
      tab.got.add(n.id);
      this.delivered++;
      this.waited += this.world.time - n.at;
      tab.seen = Math.max(tab.seen, n.id);
    }
    if (fresh.length) tab.flashUntil = this.world.time + FLASH;
    return fresh;
  }

  tone(tab: Tab): BoxState["tone"] {
    return this.world.time < tab.flashUntil ? "ok" : undefined;
  }

  /**
   * `style`: "poll" flags mostly-empty answers as waste; "hold" (long polling) doesn't, since a
   * timeout answer is cheap and expected; "push" has no answers at all.
   */
  counters(held: number, style: "poll" | "hold" | "push"): Counter[] {
    const avg = this.delivered ? this.waited / this.delivered : 0;
    const mostlyEmpty = this.answers >= 6 && this.empty * 2 > this.answers;
    return [
      { label: "Requests sent", value: String(this.requests) },
      { label: "Empty answers", value: this.answers ? `${this.empty} of ${this.answers}` : "0", tone: style === "push" ? "good" : style === "poll" && mostlyEmpty ? "bad" : undefined },
      { label: "Average wait until a tab sees news", value: this.delivered ? secs(avg) : "–", tone: !this.delivered ? undefined : avg > 2500 ? "bad" : avg <= 1000 ? "good" : undefined },
      { label: "Held open by the server", value: String(held) },
    ];
  }
}
