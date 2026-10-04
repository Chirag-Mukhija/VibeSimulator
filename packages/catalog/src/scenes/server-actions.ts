import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const HOP = 420; // the browser or the script to the server
const DB_HOP = 300; // the server to the database
const DECODE = 200; // the server reads the Next-Action header, finds the function and decodes the arguments
const AUTH = 200; // the action reads the session cookie and checks who is calling
const INSERT = 500; // one INSERT, whether it adds one row or five
const DELETE = 450;
const RESULT = 250; // the return value is serialized into the response
const ITEMS = 5;
const PAUSE = [1500, 2500] as const; // the user types the next list
const SCRIPT_GAP = 4000; // average ms between the script's calls
const FIRST_TODO_OF_OTHERS = 40; // the script deletes todos #40, #41, … which belong to other people

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export const serverActionsScene: ConceptScene = {
  id: "server-actions",
  title: "A function call that is really an HTTP POST",
  intro: "A client component saves a list of 5 todos by calling a Server Action as if it were a local function. Next.js sends each call as an HTTP POST to the page's URL, with the action's id in a Next-Action header and the arguments serialized in the body; the server finds the action by its id and runs it. A script sends the same kind of POST to deleteTodo. Slowed down.",
  width: 780,
  height: 400,
  controls: [
    { type: "toggle", id: "check", label: "Actions check the session themselves" },
    { type: "toggle", id: "script", label: "A script calls deleteTodo directly" },
    { type: "choice", id: "calls", label: "Saving 5 todos takes", options: [{ value: "one", label: "One call with the list" }, { value: "each", label: "One call per todo" }] },
  ],
  defaults: { check: true, script: true, calls: "one" },
  layout(p: SceneParams) {
    const each = pstr(p, "calls") === "each";
    return {
      boxes: [
        { id: "browser", kind: "browser", label: "Browser", detail: each ? "calls addTodo() per item" : "calls addTodos(list)", x: 20, y: 30, w: 210, h: 110 },
        { id: "script", kind: "users", label: "Script", detail: "has deleteTodo's action id", x: 20, y: 270, w: 210, h: 110 },
        { id: "server", kind: "server", label: "Next.js server", detail: "finds the action by its id", x: 320, y: 145, w: 210, h: 120 },
        { id: "db", kind: "database", label: "Database", detail: "todos table", x: 610, y: 150, w: 150, h: 110 },
      ],
      links: [
        { id: "browser-server", from: "browser", to: "server", label: "POST" },
        { id: "script-server", from: "script", to: "server", label: "POST" },
        { id: "server-db", from: "server", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const check = pbool(p, "check");
    const scriptOn = pbool(p, "script");
    const each = pstr(p, "calls") === "each";
    let todos = 12;
    let saves = 0;
    let saved = 0;
    let saveMsSum = 0;
    let postsPerSave = 0;
    let rejected = 0;
    let deleted = 0;
    let target = FIRST_TODO_OF_OTHERS;
    let queries = 0; // running in the database right now
    let browser: BoxState = { note: "typing a list", tone: "idle" };
    let script: BoxState = { note: scriptOn ? "about to call" : "not calling", tone: "idle" };
    let serverNote = "idle";
    let serverActive = 0;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    /** One Server Action call from the browser: a POST there, the action runs, the result comes back. */
    const call = (action: string, rows: number, then: () => void) => {
      world.send("browser-server", "request", HOP, () => {
        serverActive++;
        serverNote = `finding ${action} by its id`;
        say("server", 10_000, `The server reads the Next-Action id, finds ${action}, decodes ${rows === 1 ? "the todo" : "the list"} from the body and runs it${check ? ", which checks the session first" : ""}.`);
        world.after(DECODE + (check ? AUTH : 0), () => {
          serverNote = `${action}: inserting ${rows} row${rows === 1 ? "" : "s"}`;
          world.send("server-db", "request", DB_HOP, () => {
            queries++;
            world.after(INSERT, () => {
              queries--;
              todos += rows;
              world.send("server-db", "reply", DB_HOP, () => {
                serverNote = `${action}: sending the result`;
                world.after(RESULT, () => {
                  serverActive--;
                  if (!serverActive) serverNote = "idle";
                  world.send("browser-server", "reply", HOP, then, { reverse: true, label: "result" });
                });
              }, { reverse: true, label: "ok" });
            });
          }, { label: rows === 1 ? "INSERT 1 row" : `INSERT ${rows} rows` });
        });
      }, { label: action === "addTodos" ? "addTodos(5 todos)" : "addTodo(1 todo)" });
    };

    const save = () => {
      const k = ++saves;
      const started = world.time;
      let posts = 0;
      const finish = () => {
        const took = world.time - started;
        saved++;
        saveMsSum += took;
        postsPerSave = posts;
        browser = { note: `saved in ${sec(took)}`, tone: "ok" };
        say(each ? "each-done" : "done", 10_000, each
          ? `${posts} POSTs, one after another: saving the list took ${sec(took)}. One call with the whole list takes about a fifth of that.`
          : `The result comes back as the POST's response, and only then does the await finish: ${sec(took)} for one "function call".`);
        world.after(PAUSE[0] + world.random() * (PAUSE[1] - PAUSE[0]), save);
      };
      if (!each) {
        posts++;
        browser = { note: "await addTodos(5 items)…", tone: "busy" };
        say("call", 10_000, `Save #${k}: await addTodos(list) looks local, but Next.js sends it as POST /todos with the action's id in a Next-Action header.`);
        call("addTodos", ITEMS, finish);
        return;
      }
      say("each", 10_000, `Save #${k} calls await addTodo(item) in a loop: every call is its own POST and round trip, and each waits for the one before.`);
      const step = (i: number) => {
        if (i >= ITEMS) return finish();
        posts++;
        browser = { note: `await addTodo(), ${i + 1} of ${ITEMS}`, tone: "busy" };
        call("addTodo", 1, () => step(i + 1));
      };
      step(0);
    };

    /** The script POSTs to the same URL with deleteTodo's id and someone else's todo, and no session cookie. */
    const attack = () => {
      const t = target++;
      script = { note: `POST deleteTodo(#${t})`, tone: "busy" };
      world.send("script-server", "request", HOP, () => {
        serverActive++;
        serverNote = "finding deleteTodo by its id";
        world.after(DECODE, () => {
          if (check) {
            serverNote = "deleteTodo: no session, stops";
            world.after(AUTH, () => {
              serverActive--;
              if (!serverActive) serverNote = "idle";
              rejected++;
              script = { note: "turned away: no session", tone: "ok" };
              say("reject", 8000, `A script POSTs deleteTodo's id, copied from the page's JavaScript, for todo #${t}. No session cookie, so the action stops before the database.`);
              world.send("script-server", "error", HOP, undefined, { reverse: true, label: "error" });
            });
            return;
          }
          serverNote = "deleteTodo: nothing checked";
          world.send("server-db", "request", DB_HOP, () => {
            queries++;
            world.after(DELETE, () => {
              queries--;
              todos--;
              deleted++;
              say("hole", 6000, `A script POSTs deleteTodo's id for todo #${t}, someone else's. Nothing in the action checks the caller, so the database deletes it.`);
              world.send("server-db", "reply", DB_HOP, () => {
                serverActive--;
                if (!serverActive) serverNote = "idle";
                script = { note: `deleted todo #${t}`, tone: "bad" };
                world.send("script-server", "reply", HOP, undefined, { reverse: true, label: "deleted" });
              }, { reverse: true, label: "1 row deleted" });
            });
          }, { label: `DELETE #${t}` });
        });
      }, { label: `deleteTodo(#${t})` });
    };

    world.after(500, save);
    if (scriptOn) world.every(SCRIPT_GAP, attack, 0.5);

    return {
      tick(dt: number) {
        world.advance(dt);
        return {
          boxes: {
            browser,
            script,
            server: { note: serverNote, tone: serverActive ? "ok" : "idle" },
            db: { note: deleted ? `${todos} todos, ${deleted} deleted` : `${todos} todos`, tone: deleted ? "bad" : queries ? "ok" : "idle" },
          },
          tokens: world.tokens(),
          counters: [
            { label: "POSTs per save", value: postsPerSave ? String(postsPerSave) : "–" },
            { label: "Average time to save 5 todos", value: saved ? sec(saveMsSum / saved) : "–" },
            { label: "Script calls turned away", value: scriptOn ? String(rejected) : "–" },
            { label: "Todos deleted by the script", value: scriptOn ? String(deleted) : "–", tone: deleted ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Watch the script: its POSTs reach the server exactly like the browser's, and only the session check inside deleteTodo turns them away.", params: { check: true, script: true, calls: "one" } },
    { text: "Turn off the actions' own check: the script's POST runs deleteTodo like any other caller and deletes other people's todos. Hiding the delete button on the page does nothing to a direct POST.", params: { check: false, script: true, calls: "one" } },
    { text: "Save with one call per todo: each await addTodo is its own POST round trip, one after another, so saving 5 todos takes about five times as long.", params: { check: true, script: false, calls: "each" } },
  ],
};
