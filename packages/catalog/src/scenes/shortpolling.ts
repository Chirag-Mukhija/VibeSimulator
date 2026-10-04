import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pnum, pstr } from "./types.ts";
import { World } from "./world.ts";
import { HEIGHT, HOP, NewsFeed, Tally, WIDTH, ids, makeTabs, newsControl, realtimeLayout, secs, tabsControl, type Tab } from "./realtime-common.ts";

export const shortPollingScene: ConceptScene = {
  id: "short-polling",
  title: "Asking for news on a timer",
  intro: "A few browser tabs each want every piece of news the server gets. With short polling, each tab asks \"anything new?\" on a timer and the server answers at once, usually with nothing. The news arrives at the same moments on the long polling, SSE and WebSocket pages, so you can compare the counters.",
  width: WIDTH,
  height: HEIGHT,
  controls: [
    newsControl,
    tabsControl,
    { type: "choice", id: "interval", label: "Each tab asks every", options: [{ value: "1", label: "1 s" }, { value: "3", label: "3 s" }, { value: "6", label: "6 s" }] },
  ],
  defaults: { news: "rare", tabs: 3, interval: "3" },
  layout(p: SceneParams) {
    return realtimeLayout(p, { tabDetail: `asks every ${pstr(p, "interval")} s`, serverDetail: "answers each ask at once", linkLabel: "HTTP", persistent: false });
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const tally = new Tally(world);
    // First, so the news comes at the same moments as on the other realtime pages.
    const feed = new NewsFeed(world, p, (item) => world.log(`News #${item.id} reaches the server. No tab hears about it until it next asks.`));
    const tabs = makeTabs(p);
    const every = pnum(p, "interval") * 1000;
    const nextAsk = tabs.map(() => 0);
    let quiet = 0; // empty answers in a row

    const ask = (tab: Tab) => {
      tally.requests++;
      nextAsk[tab.i] = world.time + every;
      const since = tab.seen; // the request says which news the tab already has
      world.send(tab.link, "request", HOP, () => {
        tally.answers++;
        const items = feed.since(since);
        if (!items.length) {
          tally.empty++;
          quiet++;
          if (tally.empty === 1) world.log(`${tab.name} asks "anything new?" and the server answers at once: nothing.`);
          else if (quiet % 6 === 0) world.log(`Still nothing new: ${quiet} empty answers in a row, each one a full HTTP request.`);
          world.send(tab.link, "empty", HOP, undefined, { reverse: true, label: "nothing new" });
          return;
        }
        quiet = 0;
        world.send(tab.link, "reply", HOP, () => {
          const fresh = tally.see(tab, items);
          if (fresh.length === 1) world.log(`${tab.name}'s ask picks up news ${ids(fresh)}, ${secs(world.time - fresh[0]!.at)} after it reached the server.`);
          else if (fresh.length) world.log(`${tab.name}'s ask picks up news ${ids(fresh)} together; the oldest waited ${secs(world.time - fresh[0]!.at)}.`);
        }, { reverse: true, label: `news ${ids(items)}` });
      }, { label: "anything new?" });
    };

    // A setInterval per tab, opened at different moments so the tabs don't ask in step.
    tabs.forEach((tab) => {
      const first = 300 + (tab.i * every) / tabs.length + world.random() * 200;
      nextAsk[tab.i] = first;
      world.after(first, () => {
        ask(tab);
        world.every(every, () => ask(tab));
      });
    });

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          server: { slots: { total: tabs.length, busy: 0, label: "requests held" }, note: feed.latest ? `has news up to #${feed.latest}` : "no news yet" },
          news: { note: `${feed.items.length} so far` },
        };
        for (const tab of tabs) {
          boxes[`tab${tab.i + 1}`] = { note: `${tab.seen ? `has #${tab.seen}` : "no news yet"} · asks in ${secs(Math.max(0, nextAsk[tab.i]! - world.time))}`, tone: tally.tone(tab) };
        }
        return { boxes, tokens: world.tokens(), counters: tally.counters(0, "poll"), log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Ask every 1 s: news reaches the tabs sooner, but requests climb three times as fast and almost every answer is still empty.", params: { interval: "1" } },
    { text: "Ask every 6 s: far fewer requests, but news now sits on the server for seconds before a tab happens to ask.", params: { interval: "6" } },
    { text: "Set News to often: more answers carry something, yet the request count doesn't change at all, because the timer decides when tabs ask, not the news.", params: { news: "often" } },
    { text: "Four tabs: requests grow with the number of tabs even though the news is exactly the same.", params: { tabs: 4 } },
  ],
};
