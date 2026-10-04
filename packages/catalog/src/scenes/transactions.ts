import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const USER_HOP = 400; // customers to the app
const DB_HOP = 300; // the app to Postgres, over a pooled connection
const WORK: Record<string, number> = { BEGIN: 150, UPDATE: 400, COMMIT: 250 }; // Postgres's work per statement
const PAUSE = 1200; // between one transfer's answer and the next transfer
const RESTART = 1800; // the crashed app process coming back up
const CRASH_CHANCE = 0.3; // per transfer, when crashes are on
const AMOUNT = 100;
const START = 500; // each account's opening balance
const POOL = 3; // connections in the app's pool

type Name = "Alice" | "Bob";
interface Transfer {
  n: number;
  from: Name;
  to: Name;
}

const money = (n: number) => `$${n.toLocaleString("en-US")}`;

export const transactionsScene: ConceptScene = {
  id: "transactions",
  title: "Two writes that must happen together",
  intro: "Each transfer moves $100 between Alice and Bob: one UPDATE takes it from the sender, a second gives it to the receiver. Now and then the app process crashes between the two. In a transaction (BEGIN … COMMIT, all on one checked-out connection), a crash before COMMIT is rolled back. Slowed down; each envelope to Postgres is one statement.",
  width: 780,
  height: 340,
  controls: [
    { type: "toggle", id: "tx", label: "Wrap both UPDATEs in a transaction" },
    { type: "toggle", id: "crash", label: "App crashes now and then" },
  ],
  defaults: { tx: true, crash: true },
  layout(p: SceneParams) {
    const tx = pbool(p, "tx");
    return {
      boxes: [
        { id: "users", kind: "users", label: "Customers", detail: "send $100 at a time", x: 20, y: 120, w: 150, h: 84 },
        { id: "app", kind: "app", label: "App", detail: tx ? "BEGIN, 2 UPDATEs, COMMIT" : "2 UPDATEs, each on its own", x: 250, y: 104, w: 200, h: 116 },
        { id: "db", kind: "database", label: "Postgres", detail: "accounts table", x: 540, y: 110, w: 220, h: 104 },
      ],
      links: [
        { id: "u-app", from: "users", to: "app", label: "HTTP" },
        { id: "app-db", from: "app", to: "db", label: "SQL", persistent: true },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const tx = pbool(p, "tx");
    const crashes = pbool(p, "crash");
    const balance: Record<Name, number> = { Alice: START, Bob: START }; // committed: what any other connection reads
    let pending: { from: Name; to: Name } | undefined; // inside an open transaction, not committed yet
    let n = 0;
    let done = 0;
    let crashed = 0;
    let held = 0; // pooled connections checked out
    let down = false;
    let appNote = "starting";
    let dbFlash: { note: string; tone: BoxState["tone"]; until: number } | undefined;
    let explained = false;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const total = () => balance.Alice + balance.Bob;
    const flash = (note: string, tone: BoxState["tone"]) => {
      dbFlash = { note, tone, until: world.time + 1500 };
    };

    /** One statement: a round trip over the connection, plus Postgres's work; `effect` runs when Postgres does it. */
    const statement = (label: string, work: number, reply: string, effect: () => void, next: () => void) => {
      world.send("app-db", "request", DB_HOP, () => world.after(work, () => {
        effect();
        world.send("app-db", "reply", DB_HOP, next, { reverse: true, label: reply });
      }), { label });
    };

    const crash = (t: Transfer) => {
      crashed++;
      down = true;
      held = 0;
      appNote = "crashed, restarting";
      // The process dies; the OS closes its sockets, so Postgres sees the connection end.
      world.send("app-db", "handshake", DB_HOP, () => {
        if (tx && pending) {
          pending = undefined;
          flash("connection lost: rolled back", "ok");
          world.log(`The app crashed after taking ${money(AMOUNT)} from ${t.from}, before giving it to ${t.to}. Postgres saw the connection drop and rolled back: ${t.from} still has ${money(balance[t.from])}.`);
        } else {
          flash(`connection lost, ${money(AMOUNT)} gone`, "bad");
          world.log(`The app crashed after ${t.from}'s UPDATE was saved and before ${t.to}'s ran. ${money(AMOUNT)} left ${t.from} and arrived nowhere: the total is now ${money(total())}.`);
        }
      }, { label: "connection closed" });
      world.send("u-app", "error", USER_HOP, undefined, { reverse: true, label: "connection reset" });
      world.after(RESTART, () => {
        down = false;
        appNote = "restarted";
        world.after(PAUSE, transfer);
      });
    };

    const finish = (t: Transfer) => {
      appNote = `transfer #${t.n} done`;
      world.send("u-app", "reply", USER_HOP, () => {
        done++;
        world.after(PAUSE, transfer);
      }, { reverse: true, label: "200 sent" });
    };

    /** After the money is taken from the sender: maybe crash, otherwise give it to the receiver. */
    const midpoint = (t: Transfer, rest: () => void) => {
      if (crashes && world.random() < CRASH_CHANCE) crash(t);
      else rest();
    };

    const withTransaction = (t: Transfer) => {
      held++; // const client = await pool.connect()
      if (!explained) {
        explained = true;
        world.log(`Transfer #${t.n} checks out one pooled connection. BEGIN, both UPDATEs and COMMIT all go over it: a transaction belongs to one connection.`);
      }
      appNote = `#${t.n}: BEGIN`;
      statement("BEGIN", WORK.BEGIN!, "BEGIN", () => {}, () => {
        appNote = `#${t.n}: UPDATE ${t.from} −${AMOUNT}`;
        statement(`UPDATE ${t.from} −${money(AMOUNT)}`, WORK.UPDATE!, "1 row updated", () => {
          pending = { from: t.from, to: t.to };
          say("pending", 12000, `${t.from}'s ${money(AMOUNT)} is taken out inside the transaction. No other connection sees that until COMMIT.`);
        }, () => midpoint(t, () => {
          appNote = `#${t.n}: UPDATE ${t.to} +${AMOUNT}`;
          statement(`UPDATE ${t.to} +${money(AMOUNT)}`, WORK.UPDATE!, "1 row updated", () => {}, () => {
            appNote = `#${t.n}: COMMIT`;
            statement("COMMIT", WORK.COMMIT!, "COMMIT", () => {
              pending = undefined;
              balance[t.from] -= AMOUNT;
              balance[t.to] += AMOUNT;
              flash("committed both changes", "ok");
              say("commit", 12000, `COMMIT: both UPDATEs become visible at once. ${t.from} ${money(balance[t.from])}, ${t.to} ${money(balance[t.to])}, total still ${money(total())}.`);
            }, () => {
              held--; // client.release()
              finish(t);
            });
          });
        }));
      });
    };

    const withoutTransaction = (t: Transfer) => {
      // pool.query(): each statement borrows a connection, returns it, and is saved on its own.
      held++;
      appNote = `#${t.n}: UPDATE ${t.from} −${AMOUNT}`;
      statement(`UPDATE ${t.from} −${money(AMOUNT)}`, WORK.UPDATE!, "1 row updated", () => {
        balance[t.from] -= AMOUNT;
        say("half", 12000, `${t.from}'s UPDATE is saved on its own, straight away. Until ${t.to}'s runs, anyone reading sees ${money(AMOUNT)} missing from the total.`);
      }, () => {
        held--;
        midpoint(t, () => {
          held++;
          appNote = `#${t.n}: UPDATE ${t.to} +${AMOUNT}`;
          statement(`UPDATE ${t.to} +${money(AMOUNT)}`, WORK.UPDATE!, "1 row updated", () => {
            balance[t.to] += AMOUNT;
            say("whole", 12000, `${t.to}'s UPDATE is saved too, so the ${money(AMOUNT)} is back in the total, only because nothing failed in between.`);
          }, () => {
            held--;
            finish(t);
          });
        });
      });
    };

    const transfer = () => {
      if (down) return;
      // Alternate directions; the sender must have the money.
      let from: Name = n % 2 === 0 ? "Alice" : "Bob";
      if (balance[from] < AMOUNT) from = from === "Alice" ? "Bob" : "Alice";
      if (balance[from] < AMOUNT) {
        appNote = "no money left to move";
        world.log(`Both accounts are nearly empty: ${money(2 * START - total())} vanished in crashes. Press Start over to reset.`);
        return;
      }
      const t: Transfer = { n: ++n, from, to: from === "Alice" ? "Bob" : "Alice" };
      appNote = `#${t.n}: ${t.from} → ${t.to}`;
      world.send("u-app", "request", USER_HOP, () => (tx ? withTransaction(t) : withoutTransaction(t)), { label: `${t.from} → ${t.to} ${money(AMOUNT)}` });
    };

    world.after(300, transfer);

    return {
      tick(dt: number) {
        world.advance(dt);
        const off = total() !== 2 * START;
        let db: BoxState;
        if (dbFlash && world.time < dbFlash.until) db = { note: dbFlash.note, tone: dbFlash.tone };
        else if (pending) db = { note: `${pending.from} −${money(AMOUNT)}, not committed`, tone: "busy" };
        else db = { note: `Alice ${money(balance.Alice)} · Bob ${money(balance.Bob)}`, tone: off ? "bad" : "ok" };
        return {
          boxes: {
            users: { note: `${done} done${crashed ? `, ${crashed} failed` : ""}` },
            app: down
              ? { note: appNote, tone: "bad" }
              : { slots: { total: POOL, busy: held, label: "pooled connections" }, note: appNote, tone: held ? "busy" : "ok" },
            db,
          },
          tokens: world.tokens(),
          counters: [
            { label: "Alice's balance", value: money(balance.Alice) },
            { label: "Bob's balance", value: money(balance.Bob) },
            { label: "Total, should stay $1,000", value: money(total()), tone: off ? "bad" : undefined },
            { label: "Crashes mid-transfer", value: String(crashed) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Turn the transaction off: when the app crashes between the two UPDATEs, the sender's UPDATE is already saved and the receiver's never runs, so $100 disappears from the total.", params: { tx: false, crash: true } },
    { text: "No transaction and no crashes: no money is lost, but between the two UPDATEs the total briefly reads $900, because each UPDATE is saved on its own and anyone can read in between.", params: { tx: false, crash: false } },
    { text: "Back to BEGIN … COMMIT with crashes: each crash before COMMIT is rolled back, so the total stays $1,000 however often it happens.", params: { tx: true, crash: true } },
  ],
};
