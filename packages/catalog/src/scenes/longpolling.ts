import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pnum } from "./types.ts";
import { World } from "./world.ts";
import { HEIGHT, HOP, NewsFeed, Tally, WIDTH, ids, makeTabs, newsControl, plural, realtimeLayout, secs, tabsControl, type NewsItem, type Tab } from "./realtime-common.ts";

interface Held {
  tab: Tab;
  since: number;
  at: number;
  open: boolean;
}

export const longPollingScene: ConceptScene = {
  id: "long-polling",
  title: "Asking once and waiting for the answer",
  intro: "The same tabs and news as the other realtime pages. Each tab sends one request, and the server holds it unanswered until there is news or a timeout passes (real apps often wait about 30 s; shortened here). The moment an answer arrives, the tab sends its next request.",
  width: WIDTH,
  height: HEIGHT,
  controls: [
    newsControl,
    tabsControl,
    { type: "choice", id: "timeout", label: "Server holds a request up to", options: [{ value: "4", label: "4 s" }, { value: "10", label: "10 s" }] },
  ],
  defaults: { news: "rare", tabs: 3, timeout: "10" },
  layout(p: SceneParams) {
    return realtimeLayout(p, { tabDetail: "asks, waits, asks again", serverDetail: "holds each request until news", linkLabel: "HTTP", persistent: false });
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const tally = new Tally(world);
    const feed = new NewsFeed(world, p, (item) => onNews(item));
    const tabs = makeTabs(p);
    const timeout = pnum(p, "timeout") * 1000;
    const held = new Map<number, Held>(); // by tab
    const phase = tabs.map((): "asking" | "held" | "answer" => "asking");
    let explained = false;
    let timedOut: Tab[] = []; // timeouts at the same moment share one log line

    const logTimeout = (tab: Tab) => {
      timedOut.push(tab);
      if (timedOut.length > 1) return;
      world.after(1, () => {
        const names = timedOut.map((t) => t.name);
        const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
        world.log(names.length === 1
          ? `Nothing new for ${who} after ${timeout / 1000} s: the server ends its request with an empty answer, and the tab asks again right away.`
          : `Nothing new for ${who} after ${timeout / 1000} s: the server ends their requests with empty answers, and each tab asks again right away.`);
        timedOut = [];
      });
    };

    const answer = (h: Held, items: NewsItem[]) => {
      h.open = false;
      held.delete(h.tab.i);
      tally.answers++;
      phase[h.tab.i] = "answer";
      world.send(h.tab.link, "reply", HOP, () => {
        tally.see(h.tab, items);
        ask(h.tab); // straight away, so the server always has a request to answer
      }, { reverse: true, label: `news ${ids(items)}` });
    };

    const ask = (tab: Tab) => {
      tally.requests++;
      phase[tab.i] = "asking";
      const since = tab.seen;
      world.send(tab.link, "request", HOP, () => {
        const h: Held = { tab, since, at: world.time, open: true };
        const waiting = feed.since(since);
        if (waiting.length) {
          world.log(`${tab.name}'s new request finds news ${ids(waiting)} already there (it came while the tab was between requests), so it's answered at once.`);
          answer(h, waiting);
          return;
        }
        held.set(tab.i, h);
        phase[tab.i] = "held";
        if (!explained) {
          explained = true;
          world.log(`The server holds ${tab.name}'s request: no answer until there is news or ${timeout / 1000} s pass.`);
        }
        world.after(timeout, () => {
          if (!h.open) return; // already answered with news
          h.open = false;
          held.delete(tab.i);
          tally.answers++;
          tally.empty++;
          phase[tab.i] = "answer";
          logTimeout(tab);
          world.send(tab.link, "empty", HOP, () => ask(tab), { reverse: true, label: "timeout, nothing new" });
        });
      }, { label: "anything new? (I'll wait)" });
    };

    function onNews(item: NewsItem) {
      const waiting = [...held.values()];
      world.log(waiting.length
        ? `News #${item.id} reaches the server, which answers the ${plural(waiting.length, "held request")} with it at once. Each tab asks again as soon as its answer lands.`
        : `News #${item.id} reaches the server while no request is held; the next request will get it straight away.`);
      for (const h of waiting) answer(h, feed.since(h.since));
    }

    tabs.forEach((tab) => world.after(300 + tab.i * 350, () => ask(tab)));

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          server: { slots: { total: tabs.length, busy: held.size, label: "requests held" }, note: `holding ${plural(held.size, "request")}` },
          news: { note: `${feed.items.length} so far` },
        };
        for (const tab of tabs) {
          const h = held.get(tab.i);
          const ph = phase[tab.i];
          const note = h ? `request held ${secs(world.time - h.at)}` : ph === "answer" ? "answer on its way" : "sending a request";
          boxes[`tab${tab.i + 1}`] = { note, tone: tally.tone(tab) };
        }
        return { boxes, tokens: world.tokens(), counters: tally.counters(held.size, "hold"), log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Hold requests only 4 s: with rare news, many requests now end with an empty answer and the tab asks again at once, so requests climb, yet news still reaches the tabs within one hop.", params: { timeout: "4" } },
    { text: "Set News to often: nearly every request comes back with news, so long polling turns into one full HTTP request per update per tab.", params: { news: "often" } },
    { text: "Four tabs: the server now holds four requests open at once, the memory it pays for near-instant updates.", params: { tabs: 4 } },
  ],
};
