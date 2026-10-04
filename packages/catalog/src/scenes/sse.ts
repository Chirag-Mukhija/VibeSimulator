import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool } from "./types.ts";
import { World } from "./world.ts";
import { HEIGHT, HOP, NewsFeed, Tally, WIDTH, ids, makeTabs, newsControl, plural, realtimeLayout, secs, tabsControl, type NewsItem, type Tab } from "./realtime-common.ts";

const RETRY = 3000; // ms before EventSource reconnects (the server can change it with `retry:`)
const DROP_EVERY = 9000; // ms between dropped streams, when drops are on

export const sseScene: ConceptScene = {
  id: "server-sent-events",
  title: "One open stream per tab",
  intro: "The same tabs and news as the other realtime pages. Each tab opens one HTTP request with EventSource, and the server never finishes the response: it writes each piece of news into it as an event. The thicker links are those open streams; after the opening request, data on them only flows from the server to the tab.",
  width: WIDTH,
  height: HEIGHT,
  controls: [
    newsControl,
    tabsControl,
    { type: "toggle", id: "drops", label: "Connections drop now and then" },
  ],
  defaults: { news: "rare", tabs: 3, drops: false },
  layout(p: SceneParams) {
    return realtimeLayout(p, { tabDetail: "new EventSource('/events')", serverDetail: "keeps each response open", linkLabel: "event stream", persistent: true });
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const tally = new Tally(world);
    const feed = new NewsFeed(world, p, (item) => onNews(item));
    const tabs = makeTabs(p);
    const streams = new Set<number>(); // tabs whose response the server is holding open
    const state = tabs.map((): "opening" | "open" | "retry" => "opening");
    const epoch = tabs.map(() => 0); // bumps when a stream drops, so events already on the wire are lost
    const retryAt = tabs.map(() => 0);
    let opened = 0;

    /** The server writes events into a tab's open response. */
    const write = (tab: Tab, items: NewsItem[]) => {
      const e = epoch[tab.i];
      world.send(tab.link, "push", HOP, () => {
        if (epoch[tab.i] !== e || state[tab.i] !== "open") return;
        tally.see(tab, items);
      }, { reverse: true, label: items.length === 1 ? `event #${items[0]!.id}` : `${items.length} missed events` });
    };

    const connect = (tab: Tab, lastId: number) => {
      tally.requests++;
      state[tab.i] = "opening";
      world.send(tab.link, "request", HOP, () => {
        const e = ++epoch[tab.i]!;
        streams.add(tab.i);
        // Headers go back at once; the response then stays open.
        world.send(tab.link, "handshake", HOP, () => {
          if (epoch[tab.i] !== e) return;
          state[tab.i] = "open";
        }, { reverse: true, label: "200 text/event-stream" });
        if (opened++ === 0) world.log(`${tab.name} opens one request with EventSource. The server sends the headers and keeps the response open.`);
        else if (lastId === -1) world.log(`${tab.name}'s stream is open too.`);
        if (lastId === -1) return;
        if (lastId === 0) {
          world.log(`${tab.name} reconnects. It had no event id yet, so it just gets news from now on.`);
          return;
        }
        const missed = feed.since(lastId);
        if (!missed.length) {
          world.log(`${tab.name} reconnects and sends Last-Event-ID: ${lastId}. Nothing came while it was away.`);
          return;
        }
        world.log(`${tab.name} reconnects and sends Last-Event-ID: ${lastId}, so the server writes the ${plural(missed.length, "event")} it missed (${ids(missed)}).`);
        world.after(150, () => {
          if (epoch[tab.i] === e) write(tab, missed);
        });
      }, { label: lastId > 0 ? `GET /events, Last-Event-ID: ${lastId}` : "GET /events" });
    };

    function onNews(item: NewsItem) {
      const away = tabs.filter((t) => !streams.has(t.i));
      const open = tabs.filter((t) => streams.has(t.i));
      const names = away.map((t) => t.name).join(" and ");
      const later = away.length === 0 ? "" : away.every((t) => t.seen > 0)
        ? ` ${names} ${away.length === 1 ? "is" : "are"} reconnecting and will get it then.`
        : ` ${names} ${away.length === 1 ? "isn't" : "aren't"} connected right now.`;
      world.log(`News #${item.id}: the server writes it into ${plural(open.length, "open stream")} at once. No tab had to ask.${later}`);
      for (const tab of open) write(tab, [item]);
    }

    tabs.forEach((tab) => world.after(300 + tab.i * 350, () => connect(tab, -1)));

    if (pbool(p, "drops")) {
      world.every(DROP_EVERY, () => {
        const candidates = tabs.filter((t) => state[t.i] === "open");
        if (!candidates.length) return;
        const tab = candidates[Math.floor(world.random() * candidates.length)]!;
        streams.delete(tab.i);
        epoch[tab.i]!++;
        state[tab.i] = "retry";
        retryAt[tab.i] = world.time + RETRY;
        world.log(`${tab.name}'s stream drops (a network blip, or a proxy closing it). EventSource reconnects by itself after a few seconds.`);
        world.after(RETRY, () => connect(tab, tab.seen));
      }, 0.4);
    }

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          server: { slots: { total: tabs.length, busy: streams.size, label: "streams open" }, note: `${plural(streams.size, "stream")} open, one-way` },
          news: { note: `${feed.items.length} so far` },
        };
        for (const tab of tabs) {
          const s = state[tab.i];
          boxes[`tab${tab.i + 1}`] = s === "retry"
            ? { note: `reconnecting in ${secs(Math.max(0, retryAt[tab.i]! - world.time))}`, tone: "bad" }
            : { note: s === "opening" ? "opening the stream" : `stream open${tab.seen ? ` · has #${tab.seen}` : ""}`, tone: tally.tone(tab) };
        }
        return { boxes, tokens: world.tokens(), counters: tally.counters(streams.size, "push"), log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Set News to often: many more events flow, but requests stay at one per tab, because every event travels down a stream that is already open.", params: { news: "often" } },
    { text: "Turn on dropped connections: the tab reconnects by itself a few seconds later and sends the id of the last event it got, so the server can send what it missed.", params: { drops: true } },
    { text: "Four tabs: four streams stay open at the server the whole time, even while nothing happens. That memory is the price of no polling.", params: { tabs: 4 } },
  ],
};
