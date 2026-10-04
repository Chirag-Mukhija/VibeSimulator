import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch. A real database reads a row in microseconds,
// but the shape is the same: the work grows with the number of rows it has to read.
const READER_HOP = 400; // the reader's browser to the feed API
const BIG_HOP = 500; // the same trip carrying every post at once: a much bigger response
const DB_HOP = 300; // the API to Postgres
const BASE = 300; // database work any query pays: parse, plan, find its starting point in the index
const PER_ROW = 10; // database work for each row it reads, kept or skipped
const PAGE = 10; // posts per page
const START_POSTS = 150; // posts in the table when the scene starts
const READ_PAGE = 1100; // the reader looks at a page, then asks for the next
const READ_ALL = 3500; // with everything on one page, the reader scrolls a while before reloading
const INSERT = 400; // the database saving a new post
const POST_GAP = 4500; // average gap between new posts from other users
const BLOCK = 10; // rows per square in the database box

type Mode = "all" | "offset" | "cursor";

interface Query {
  start: number;
  work: number;
  read: number;
  offset: number;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const posts = (ids: number[]) => {
  const tags = ids.map((id) => `#${id}`);
  return tags.length === 1 ? `Post ${tags[0]}` : `Posts ${tags.slice(0, -1).join(", ")} and ${tags.at(-1)}`;
};

export const paginationScene: ConceptScene = {
  id: "pagination",
  title: "Paging through a feed: OFFSET vs a cursor",
  intro: "A reader scrolls a feed of posts, newest first, 10 per page, while other users keep posting. Both page styles use an index on (created_at, id). OFFSET says how many posts to skip; a cursor says \"posts older than the last one I saw\". Slowed down; each square in Postgres is 10 rows read.",
  width: 780,
  height: 360,
  controls: [
    { type: "choice", id: "mode", label: "Feed is loaded", options: [
      { value: "all", label: "All posts at once" },
      { value: "offset", label: "Pages with OFFSET" },
      { value: "cursor", label: "Pages with a cursor" },
    ] },
    { type: "toggle", id: "others", label: "Others post while you read" },
  ],
  defaults: { mode: "cursor", others: true },
  layout(p: SceneParams) {
    const mode = pstr(p, "mode") as Mode;
    const others = pbool(p, "others");
    return {
      boxes: [
        { id: "reader", kind: "browser", label: "Reader", detail: mode === "all" ? "asks for every post" : mode === "offset" ? "asks ?page=N" : "asks ?after=last post", x: 20, y: 50, w: 180, h: 92 },
        { id: "others", kind: "users", label: "Other users", detail: others ? "write new posts" : "not posting", x: 20, y: 236, w: 180, h: 84 },
        { id: "api", kind: "app", label: "Feed API", detail: mode === "all" ? "no LIMIT" : mode === "offset" ? "LIMIT 10 OFFSET n" : "LIMIT 10 after a cursor", x: 280, y: 124, w: 200, h: 100 },
        { id: "db", kind: "database", label: "Postgres", detail: "indexed by created_at, id", x: 560, y: 104, w: 200, h: 130 },
      ],
      links: [
        { id: "r-api", from: "reader", to: "api", label: "GET /feed" },
        { id: "o-api", from: "others", to: "api", label: "POST" },
        { id: "api-db", from: "api", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const mode = pstr(p, "mode") as Mode;
    const othersOn = pbool(p, "others");
    // Newest first, as the feed shows them. Ids grow with time, so a bigger id is a newer post.
    const feed: number[] = Array.from({ length: START_POSTS }, (_, i) => START_POSTS - i);
    let nextPost = START_POSTS + 1;
    let pageNo = 0;
    let cursor: number | undefined; // the last post the reader has seen (cursor mode)
    let seen = new Set<number>();
    let seenCount = 0;
    let repeats = 0;
    let lastRead: number | undefined;
    let lastMs: number | undefined;
    let lastCount: number | undefined;
    let flashUntil = -1;
    let query: Query | undefined;
    let apiNote = "starting";
    let posted = 0;
    let lastSaved: { id: number; at: number } | undefined;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const newPass = () => {
      pageNo = 0;
      cursor = undefined;
      seen = new Set<number>();
      seenCount = 0;
    };

    const arrive = (k: number, rows: number[], read: number, started: number) => {
      lastMs = world.time - started;
      lastRead = read;
      lastCount = rows.length;
      const again = mode === "all" ? [] : rows.filter((id) => seen.has(id));
      for (const id of rows) if (!seen.has(id)) {
        seen.add(id);
        seenCount++;
      }
      if (again.length) {
        repeats += again.length;
        flashUntil = world.time + 1600;
        const n = again.length;
        world.log(`${posts(again)} shown again on page ${k}: ${n === 1 ? "1 new post" : `${n} new posts`} since page ${k - 1} pushed every post down ${n === 1 ? "one place" : `${n} places`}, so OFFSET ${(k - 1) * PAGE} now starts on ${n === 1 ? "it" : "them"}.`);
      }
      if (rows.length) cursor = rows.at(-1);
      if (mode === "all") {
        world.after(READ_ALL, () => {
          newPass();
          load();
        });
        return;
      }
      if (rows.length < PAGE) {
        world.log(`Page ${k} reaches the oldest post. The reader goes back to the top to see what's new.`);
        world.after(READ_PAGE, () => {
          newPass();
          load();
        });
        return;
      }
      world.after(READ_PAGE, load);
    };

    const load = () => {
      const k = ++pageNo;
      const started = world.time;
      const offset = (k - 1) * PAGE;
      const after = cursor;
      apiNote = mode === "all" ? "SELECT every post" : mode === "offset" ? `page ${k}: OFFSET ${offset}` : after === undefined ? `page ${k}: newest 10` : `page ${k}: older than #${after}`;
      world.send("r-api", "request", READER_HOP, () => {
        world.send("api-db", "request", DB_HOP, () => {
          // The query sees the table as it is when it runs, new posts included.
          let rows: number[];
          let read: number;
          if (mode === "all") {
            rows = [...feed];
            read = feed.length;
            say("all", 8000, `All ${feed.length} posts in one response: the database reads every row, and each new post makes the next load bigger.`);
          } else if (mode === "offset") {
            rows = feed.slice(offset, offset + PAGE);
            read = Math.min(feed.length, offset + PAGE);
            if (k === 1) world.log("Page 1: LIMIT 10 OFFSET 0. Nothing to skip, so the database reads just 10 rows.");
            else world.log(`Page ${k}: OFFSET ${offset} makes the database walk past ${offset} posts before it keeps 10, so it reads ${read} rows.`);
          } else {
            const from = after === undefined ? 0 : feed.findIndex((id) => id < after);
            rows = from < 0 ? [] : feed.slice(from, from + PAGE);
            read = rows.length;
            if (k === 1) world.log("Page 1: the newest 10 posts. The API returns the last one's (created_at, id) as the cursor for the next page.");
            else say("cursor", 9000, `Page ${k} asks for posts older than #${after}. The index goes straight there, so it reads ${read} rows, the same as page 1.`);
          }
          const work = BASE + PER_ROW * read;
          query = { start: world.time, work, read, offset: mode === "offset" ? offset : 0 };
          world.after(work, () => {
            query = undefined;
            world.send("api-db", "reply", DB_HOP, () => {
              world.send("r-api", "reply", mode === "all" ? BIG_HOP : READER_HOP, () => arrive(k, rows, read, started), { reverse: true, label: `${rows.length} posts` });
            }, { reverse: true, label: `${rows.length} rows` });
          });
        }, { label: mode === "offset" ? `LIMIT 10 OFFSET ${offset}` : mode === "cursor" ? (after === undefined ? "LIMIT 10" : `older than #${after}`) : "every post" });
      }, { label: mode === "all" ? "GET every post" : mode === "offset" ? `?page=${k}` : after === undefined ? "first page" : `?after=${after}` });
    };

    if (othersOn) {
      world.every(POST_GAP, () => {
        world.send("o-api", "request", READER_HOP, () => {
          world.send("api-db", "request", DB_HOP, () => world.after(INSERT, () => {
            const id = nextPost++;
            feed.unshift(id);
            posted++;
            lastSaved = { id, at: world.time };
            if (mode === "offset") say("post", 7000, pageNo > 0 && seenCount > 0
              ? `New post #${id} goes to the top of the feed. Every older post moves down one place, including the ones on pages not loaded yet.`
              : `New post #${id} goes to the top of the feed.`);
            else if (mode === "cursor") say("post", 9000, `New post #${id} goes to the top. It's newer than the cursor, so the pages still to come don't change.`);
            else say("post", 9000, `New post #${id}: the next full load has one more row to read and send.`);
            world.send("api-db", "reply", DB_HOP, () => world.send("o-api", "reply", READER_HOP, undefined, { reverse: true, label: "201 Created" }), { reverse: true });
          }), { label: "INSERT" });
        }, { label: "POST new post" });
      }, 0.6);
    }

    world.after(300, load);

    return {
      tick(dt: number) {
        world.advance(dt);
        let db: BoxState;
        if (query) {
          const done = Math.min(1, (world.time - query.start) / query.work);
          const walked = Math.floor(done * query.read);
          const note = mode === "all"
            ? `reading row ${walked} of ${query.read}`
            : mode === "offset" && walked < query.offset
              ? `OFFSET ${query.offset}: skipped ${walked}`
              : mode === "offset"
                ? `keeping rows ${query.offset + 1} to ${query.read}`
                : `seeks the cursor, reads ${query.read}`;
          db = { slots: { total: Math.max(1, Math.ceil(query.read / BLOCK)), busy: Math.floor(walked / BLOCK), label: "blocks of 10 rows" }, note, tone: "busy" };
        } else if (lastSaved && world.time - lastSaved.at < 1200) {
          db = { note: `saved new post #${lastSaved.id}`, tone: "ok" };
        } else {
          db = { note: `${feed.length} posts in the table`, tone: "idle" };
        }
        const repeatNow = world.time < flashUntil;
        const reader: BoxState = mode === "all"
          ? { note: lastCount === undefined ? "loading" : `showing ${lastCount} posts`, tone: "ok" }
          : { note: repeatNow ? "same post shown twice" : pageNo ? `page ${pageNo}, ${seenCount} posts seen` : "starting", tone: repeatNow ? "bad" : "ok" };
        const deep = lastRead !== undefined && lastRead >= 3 * PAGE;
        return {
          boxes: {
            reader,
            others: othersOn ? { note: `${posted} new post${posted === 1 ? "" : "s"}`, tone: "ok" } : { note: "not posting", tone: "idle" },
            api: { note: apiNote, tone: query ? "busy" : "ok" },
            db,
          },
          tokens: world.tokens(),
          counters: [
            { label: "Rows read, last request", value: lastRead === undefined ? "–" : String(lastRead), tone: deep ? "bad" : undefined },
            { label: "Last request took (slowed down)", value: lastMs === undefined ? "–" : sec(lastMs) },
            { label: "Posts in the last response", value: lastCount === undefined ? "–" : String(lastCount) },
            { label: "Posts shown twice", value: String(repeats), tone: repeats ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Switch to OFFSET with nobody posting: page 8 makes the database walk past 70 posts to keep 10, so rows read and time grow with every page you go deeper.", params: { mode: "offset", others: false } },
    { text: "OFFSET while others post: each new post pushes the whole feed down one place, so a post from the end of the page you just read shows up again on the next one.", params: { mode: "offset", others: true } },
    { text: "Load all posts at once: every request reads and sends the whole table, and as others keep posting, each reload gets bigger.", params: { mode: "all", others: true } },
    { text: "Back to the cursor: every page reads 10 rows however deep you go, and new posts never repeat anything, because they are newer than the cursor.", params: { mode: "cursor", others: true } },
  ],
};
