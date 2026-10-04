import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pnum, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch. Real queries take about a millisecond each.
const BROWSER_HOP = 400;
const DB_HOP = 300; // one way between your handler and Postgres
const LOOKUP = 150; // database work for one indexed lookup: small next to the round trip
const PER_ROW = 15; // extra database work per row returned
const RENDER = 300; // building the JSON after the last query
const PAUSE = 1500; // before the page is loaded again

type Mode = "naive" | "batched" | "join";

const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const nPlusOneScene: ConceptScene = {
  id: "n-plus-one",
  title: "One query per item vs one query for all",
  intro: "A page shows a list of posts with each post's author. The handler asks Postgres for the posts, then needs their authors. Each envelope to Postgres is one query: a full round trip, and a pooled connection is busy until its answer is back. Slowed down; real queries take about a millisecond.",
  width: 780,
  height: 300,
  controls: [
    { type: "choice", id: "mode", label: "Authors are loaded", options: [
      { value: "naive", label: "One query per post" },
      { value: "batched", label: "One batched query" },
      { value: "join", label: "With a JOIN" },
    ] },
    { type: "count", id: "items", label: "Posts on the page", min: 5, max: 30 },
  ],
  defaults: { mode: "batched", items: 10 },
  layout(p: SceneParams) {
    const mode = pstr(p, "mode") as Mode;
    return {
      boxes: [
        { id: "browser", kind: "browser", label: "Browser", detail: "GET /posts", x: 20, y: 105, w: 150, h: 90 },
        { id: "app", kind: "app", label: "Your handler", detail: mode === "naive" ? "loops: await per post" : mode === "batched" ? "list, then one batch" : "one JOIN query", x: 260, y: 85, w: 230, h: 130 },
        { id: "db", kind: "database", label: "Postgres", detail: "posts and users tables", x: 580, y: 100, w: 180, h: 100 },
      ],
      links: [
        { id: "b-app", from: "browser", to: "app", label: "HTTP" },
        { id: "app-db", from: "app", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const mode = pstr(p, "mode") as Mode;
    const n = pnum(p, "items");

    let page = 0;
    let pagesDone = 0;
    let queries = 0; // for the page in progress (or the last one)
    let held = false; // a query of this page is in flight
    let busyMs = 0; // connection time this page's queries used: each one's round trip plus the database's work
    let lastPageMs: number | undefined;
    let remaining = 0; // author lookups not sent yet
    let browser: BoxState = { note: "about to load the page", tone: "idle" };
    let appNote = "idle";
    let db: BoxState = { note: "idle", tone: "idle" };

    /** One query: there, the database's work, and back. The handler waits for the answer. */
    const query = (sql: string, work: number, then: () => void) => {
      queries++;
      busyMs += 2 * DB_HOP + work;
      world.send("app-db", "request", DB_HOP, () => {
        db = { note: sql, tone: "busy" };
        world.after(work, () => {
          db = { note: "idle", tone: "idle" };
          world.send("app-db", "reply", DB_HOP, then, { reverse: true, label: "rows" });
        });
      }, { label: sql });
    };

    const finish = (pageNo: number, started: number) => {
      held = false;
      remaining = 0;
      appNote = "building the JSON";
      world.log(`Page #${pageNo}: ${queries} ${queries === 1 ? "query" : "queries"}, one round trip each, so pooled connections were busy for ${s(busyMs)} on this one page.`);
      world.after(RENDER, () => {
        appNote = "idle";
        world.send("b-app", "reply", BROWSER_HOP, () => {
          pagesDone++;
          lastPageMs = world.time - started;
          browser = { note: `showing ${n} posts`, tone: "ok" };
          world.after(PAUSE, load);
        }, { reverse: true, label: `${n} posts` });
      });
    };

    const authors = (i: number, pageNo: number, started: number) => {
      if (i > n) {
        finish(pageNo, started);
        return;
      }
      remaining = n - i;
      appNote = `author ${i} of ${n}`;
      if (i === 1) world.log(`Author query 1 of ${n} goes out. The loop awaits each answer before it sends the next.`);
      if (i === n) world.log(`Author query ${n} of ${n}: round trip number ${queries + 1} for this one page.`);
      const author = 1 + Math.floor(world.random() * 20);
      query(`users WHERE id = ${author}`, LOOKUP + PER_ROW, () => authors(i + 1, pageNo, started));
    };

    const load = () => {
      const pageNo = ++page;
      const started = world.time;
      queries = 0;
      browser = { note: `loading page #${pageNo}`, tone: "busy" };
      world.send("b-app", "request", BROWSER_HOP, () => {
        held = true;
        busyMs = 0;
        if (mode === "join") {
          appNote = "one JOIN query";
          world.log(`Page #${pageNo}: one query joins posts with users, so each post arrives with its author.`);
          query("posts JOIN users", LOOKUP + 2 * PER_ROW * n, () => finish(pageNo, started));
          return;
        }
        appNote = "list query";
        world.log(`Page #${pageNo}: the handler asks Postgres for the ${n} newest posts.`);
        query(`posts LIMIT ${n}`, LOOKUP + PER_ROW * n, () => {
          if (mode === "naive") {
            remaining = n;
            world.log(`${n} posts came back. Now a loop asks for each post's author: ${n} more queries, one after another.`);
            authors(1, pageNo, started);
            return;
          }
          appNote = "one query for all authors";
          world.log(`${n} posts came back. One more query fetches all their authors at once: WHERE id = ANY($1).`);
          query("users WHERE id = ANY(…)", LOOKUP + PER_ROW * n, () => finish(pageNo, started));
        });
      }, { label: "GET /posts" });
    };

    world.after(400, load);

    return {
      tick(dt: number) {
        world.advance(dt);
        const app: BoxState = {
          queue: remaining,
          note: held ? (remaining ? `${appNote}, ${remaining} to go` : appNote) : appNote,
          tone: held ? (mode === "naive" && remaining ? "busy" : "ok") : "idle",
        };
        return {
          boxes: { browser, app, db },
          tokens: world.tokens(),
          counters: [
            { label: "Queries for this page", value: page ? String(queries) : "–", tone: queries > 3 ? "bad" : queries ? "good" : undefined },
            { label: "Page took (slowed down)", value: lastPageMs === undefined ? "–" : s(lastPageMs) },
            { label: "Connection time used (slowed down)", value: page ? s(busyMs) : "–" },
            { label: "Pages loaded", value: String(pagesDone) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Switch to one query per post: after the list, a loop sends 10 author queries one after another, so the page makes 11 round trips instead of 2.", params: { mode: "naive", items: 10 } },
    { text: "Keep one query per post and show 30 posts: 31 queries back to back, so the page waits for 31 round trips and a pooled connection is busy for nearly all of that time.", params: { mode: "naive", items: 30 } },
    { text: "One batched query with 30 posts: still 2 queries. The second just carries 30 ids, so the page barely slows down as the list grows.", params: { mode: "batched", items: 30 } },
    { text: "Try the JOIN: a single query returns each post with its author already attached.", params: { mode: "join", items: 10 } },
  ],
};
