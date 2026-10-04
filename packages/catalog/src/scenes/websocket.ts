import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool } from "./types.ts";
import { World } from "./world.ts";
import { HEIGHT, HOP, NewsFeed, Tally, WIDTH, makeTabs, newsControl, plural, realtimeLayout, tabsControl, type NewsItem, type Tab } from "./realtime-common.ts";

const TYPING_EVERY = 4500; // ms between "typing…" messages from some tab, when typing is on

export const websocketScene: ConceptScene = {
  id: "websocket",
  title: "One two-way connection per tab",
  intro: "The same tabs and news as the other realtime pages. Each tab sends one HTTP request asking to upgrade, and that connection stays open as a WebSocket (the thicker links). After that either side can send a message at any time without a request: news comes down, and a tab can send \"typing…\" up.",
  width: WIDTH,
  height: HEIGHT,
  controls: [
    newsControl,
    tabsControl,
    { type: "toggle", id: "typing", label: "Tabs send \"typing…\"" },
  ],
  defaults: { news: "rare", tabs: 3, typing: true },
  layout(p: SceneParams) {
    return realtimeLayout(p, { tabDetail: "new WebSocket('/live')", serverDetail: "keeps a socket per tab", linkLabel: "WebSocket", persistent: true });
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const tally = new Tally(world);
    const feed = new NewsFeed(world, p, (item) => onNews(item));
    const tabs = makeTabs(p);
    const typing = pbool(p, "typing");
    const sockets = new Set<number>(); // open at the server
    const open = tabs.map(() => false); // open as far as the tab knows
    const sent = tabs.map(() => 0);
    let fromTabs = 0;

    const connect = (tab: Tab) => {
      tally.requests++;
      world.send(tab.link, "handshake", HOP, () => {
        sockets.add(tab.i);
        world.log(sockets.size === 1
          ? `${tab.name} sends one HTTP request asking to upgrade. The server answers 101 Switching Protocols, and the connection stays open as a WebSocket.`
          : `${tab.name}'s WebSocket is open too.`);
        world.send(tab.link, "handshake", HOP, () => {
          open[tab.i] = true;
        }, { reverse: true, label: "101 Switching Protocols" });
      }, { label: "GET /live, Upgrade: websocket" });
    };

    function onNews(item: NewsItem) {
      const to = tabs.filter((t) => sockets.has(t.i));
      world.log(`News #${item.id}: the server sends it as one small message down each of the ${plural(to.length, "open socket")}.`);
      for (const tab of to) world.send(tab.link, "push", HOP, () => tally.see(tab, [item]), { reverse: true, label: `news #${item.id}` });
    }

    tabs.forEach((tab) => world.after(300 + tab.i * 350, () => connect(tab)));

    if (typing) {
      world.every(TYPING_EVERY, () => {
        const ready = tabs.filter((t) => open[t.i]);
        if (!ready.length) return;
        const tab = ready[Math.floor(world.random() * ready.length)]!;
        sent[tab.i]!++;
        // Browser to server on the same open connection: no request, and nothing comes back for it.
        world.send(tab.link, "push", HOP, () => {
          fromTabs++;
          const others = tabs.filter((t) => t !== tab && sockets.has(t.i));
          world.log(`${tab.name} sent "typing…" up its open socket: no new request, no HTTP headers, no reply. The server passes it on to the other ${plural(others.length, "tab")}.`);
          for (const o of others) world.send(o.link, "push", HOP, undefined, { reverse: true, label: `${tab.name} is typing…` });
        }, { label: "typing…" });
      }, 0.5);
    }

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          server: { slots: { total: tabs.length, busy: sockets.size, label: "sockets open" }, note: `${plural(sockets.size, "socket")} open${typing ? ` · ${fromTabs} msgs in` : ""}` },
          news: { note: `${feed.items.length} so far` },
        };
        for (const tab of tabs) {
          const has = tab.seen ? `has #${tab.seen}` : "socket open";
          const note = !open[tab.i] ? "upgrading…" : typing ? `${has} · sent ${plural(sent[tab.i]!, "msg")}` : `socket open${tab.seen ? ` · has #${tab.seen}` : ""}`;
          boxes[`tab${tab.i + 1}`] = { note, tone: tally.tone(tab) };
        }
        return { boxes, tokens: world.tokens(), counters: tally.counters(sockets.size, "push"), log: world.recent() };
      },
    };
  },
  tryThis: [
    { text: "Watch a tab send \"typing…\": it goes up the same open socket with no new request, and the server passes it straight on to the other tabs.", params: { typing: true } },
    { text: "Turn typing off: now it looks just like the SSE page, because what a WebSocket adds is the browser sending on the same connection.", params: { typing: false } },
    { text: "Set News to often: each update is one small message down an open socket, and requests sent stays at one upgrade per tab.", params: { news: "often" } },
  ],
};
