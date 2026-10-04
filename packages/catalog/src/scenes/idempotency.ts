import type { BoxState, ConceptScene, SceneParams, Token } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch.
const HOP = 400; // the checkout page to the API
const PAY_HOP = 400; // the API to the payment provider
const DB_HOP = 300; // the API to its database
const DB_WORK = 100;
const CHARGE: [number, number] = [500, 800]; // the provider charging a card
const CLIENT_TIMEOUT = 4500; // the page resends if no answer comes within this long
const MAX_TRIES = 3;
const GAP = 3500; // average ms between checkouts
const LOST = 0.35; // chance a successful response is lost on the way back, when that is on
const DOUBLE = 0.5; // chance a click sends two copies at once, when that is on
const DOUBLE_GAP = 80; // ms between the two copies
const LOST_MARK = "(lost)"; // token label suffix: drawn only up to the middle of the link, where it is lost

type Mode = "none" | "code" | "unique";

interface Checkout {
  n: number;
  key: string;
  tries: number;
  done: boolean;
}

interface Row {
  result?: string;
}

export const idempotencyScene: ConceptScene = {
  id: "idempotency",
  title: "Making a repeated payment safe",
  intro: "Customers pay on a checkout page. Some responses are lost on the way back (a dropped connection), so the page can't tell whether the payment went through, and after 4.5 s without an answer it sends the same payment again. With an idempotency key, the page sends a unique key with each payment and the API remembers what it did for that key. Slowed down.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "key", label: "Idempotency key", options: [
      { value: "none", label: "Not used" },
      { value: "code", label: "Checked in code" },
      { value: "unique", label: "UNIQUE in database" },
    ] },
    { type: "toggle", id: "lost", label: "Some responses get lost" },
    { type: "toggle", id: "double", label: "Double clicks send two copies" },
  ],
  defaults: { key: "unique", lost: true, double: false },
  layout(p: SceneParams) {
    const mode = pstr(p, "key") as Mode;
    return {
      boxes: [
        { id: "page", kind: "browser", label: "Checkout page", detail: `resends after ${CLIENT_TIMEOUT / 1000} s`, x: 20, y: 150, w: 180, h: 100 },
        { id: "api", kind: "app", label: "Payment API", detail: mode === "none" ? "charges every request" : mode === "code" ? "looks up key, then charges" : "INSERTs key, then charges", x: 270, y: 140, w: 200, h: 120 },
        { id: "pay", kind: "external", label: "Payment provider", detail: "charges the card", x: 560, y: 20, w: 200, h: 110 },
        { id: "db", kind: "database", label: "Database", detail: mode === "none" ? "not used for keys" : mode === "code" ? "keys, no UNIQUE constraint" : "key column is UNIQUE", x: 560, y: 270, w: 200, h: 110 },
      ],
      links: [
        { id: "page-api", from: "page", to: "api", label: "HTTPS" },
        { id: "api-pay", from: "api", to: "pay", label: "charge" },
        { id: "api-db", from: "api", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const mode = pstr(p, "key") as Mode;
    const losing = pbool(p, "lost");
    const doubling = pbool(p, "double");
    const keys = new Map<string, Row>(); // the idempotency_keys table
    const charged = new Map<number, number>(); // charges per customer
    let id = 0;
    let charges = 0;
    let twice = 0;
    let caught = 0; // repeats answered from the stored result, or refused with 409
    let resent = 0; // retries after no answer
    let rows = 0; // rows in the keys table: without UNIQUE, two copies can both insert one
    let inProgress = 0; // requests the API is handling
    let apiNote = "";
    let apiNoteAt = -1e9;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };
    const note = (text: string) => {
      apiNote = text;
      apiNoteAt = world.time;
    };

    /** One SQL round trip to the database. */
    const sql = (label: string, reply: { kind: "reply" | "empty" | "error"; label: string }, then: () => void) =>
      world.send("api-db", "request", DB_HOP, () => world.after(DB_WORK, () => world.send("api-db", reply.kind, DB_HOP, then, { reverse: true, label: reply.label })), { label });

    /** Charges the card at the provider. */
    const charge = (c: Checkout, then: (result: string) => void) => {
      note(`#${c.n}: charging the card`);
      world.send("api-pay", "request", PAY_HOP, () => world.after(CHARGE[0] + world.random() * (CHARGE[1] - CHARGE[0]), () => {
        charges++;
        const times = (charged.get(c.n) ?? 0) + 1;
        charged.set(c.n, times);
        if (times === 2) {
          twice++;
          if (mode === "none") world.log(`The provider charges customer #${c.n} a second time: without a key the API can't tell this is the same payment.`);
        }
        world.send("api-pay", "reply", PAY_HOP, () => then(`ch_${c.n}${times > 1 ? `_${times}` : ""}`), { reverse: true, label: "charged" });
      }), { label: `charge #${c.n}` });
    };

    /** The API answers the page; a successful answer may be lost on the way. */
    const respond = (c: Checkout, status: 200 | 409) => {
      inProgress--;
      const lost = status === 200 && losing && world.random() < LOST;
      if (lost) {
        say("lost", 0, `#${c.n}'s card was charged, but the response is lost on the way back. The page can't tell whether the payment went through.`);
        world.send("page-api", "reply", HOP, undefined, { reverse: true, label: `200 ${LOST_MARK}` });
        return;
      }
      world.send("page-api", status === 200 ? "reply" : "error", HOP, () => {
        if (status !== 200 || c.done) return;
        c.done = true;
        say("paid", 8000, `#${c.n} is paid and the page shows it${mode === "none" ? "" : `; key ${c.key} stays stored with the result`}.`);
      }, { reverse: true, label: String(status) });
    };

    /** What the API does with one copy of a payment request. */
    const handle = (c: Checkout, copy: string) => {
      inProgress++;
      if (mode === "none") {
        charge(c, () => respond(c, 200));
        return;
      }
      if (mode === "code") {
        // Look the key up, charge if it is new, then save it with the result: two copies at once both see "not found".
        sql(`SELECT ${c.key}`, keys.get(c.key)?.result ? { kind: "reply", label: "found" } : { kind: "empty", label: "not found" }, () => {
          const row = keys.get(c.key);
          if (row?.result) {
            caught++;
            note(`#${c.n}: key found, no charge`);
            say("caught", 2500, `#${c.n}${copy}: key ${c.key} is already stored with its result, so the API returns that result and charges nothing.`);
            respond(c, 200);
            return;
          }
          charge(c, (result) => {
            if ((charged.get(c.n) ?? 0) >= 2) world.log(`Both copies of #${c.n} looked up key ${c.key} before either saved it, so both charged: customer #${c.n} is charged twice.`);
            sql(`INSERT ${c.key}`, { kind: "reply", label: "saved" }, () => {
              rows++;
              keys.set(c.key, { result });
              respond(c, 200);
            });
          });
        });
        return;
      }
      // UNIQUE: insert the key first; only the copy whose INSERT adds the row goes on to charge.
      const isNew = !keys.has(c.key);
      if (isNew) {
        keys.set(c.key, {});
        rows++;
      }
      sql(`INSERT ${c.key}`, isNew ? { kind: "reply", label: "1 row" } : { kind: "empty", label: "0 rows: exists" }, () => {
        if (isNew) {
          charge(c, (result) => sql("UPDATE result", { kind: "reply", label: "saved" }, () => {
            keys.get(c.key)!.result = result;
            respond(c, 200);
          }));
          return;
        }
        sql(`SELECT ${c.key}`, { kind: "reply", label: keys.get(c.key)?.result ? "stored result" : "in progress" }, () => {
          caught++;
          if (keys.get(c.key)?.result) {
            note(`#${c.n}: key exists, no charge`);
            say("caught", 2500, `#${c.n}${copy}: the INSERT adds nothing because key ${c.key} exists (UNIQUE), so the API returns the stored result. No new charge.`);
            respond(c, 200);
          } else {
            note(`#${c.n}: 409, still in progress`);
            say("conflict", 2500, `#${c.n}'s second copy: key ${c.key} is taken (UNIQUE) and its payment is still running, so this copy gets 409 Conflict. One charge.`);
            respond(c, 409);
          }
        });
      });
    };

    /** The page sends the payment (twice at once on a double click), and resends if nothing comes back. */
    const send = (c: Checkout) => {
      c.tries++;
      const copies = c.tries === 1 && doubling && world.random() < DOUBLE ? 2 : 1;
      for (let i = 0; i < copies; i++) {
        const copy = copies === 2 ? (i === 0 ? "'s first copy" : "'s second copy") : c.tries > 1 ? "'s retry" : "";
        world.after(i * DOUBLE_GAP, () => world.send("page-api", "request", HOP, () => handle(c, copy), { label: `#${c.n}${mode === "none" ? "" : ` key ${c.key}`}${c.tries > 1 ? " again" : ""}` }));
      }
      if (copies === 2) say("double", 2500, `A double click on #${c.n} sends two identical copies${mode === "none" ? "" : `, both with key ${c.key}`}.`);
      world.after(CLIENT_TIMEOUT, () => {
        if (c.done || c.tries >= MAX_TRIES) return;
        resent++;
        say("resend", 0, `#${c.n} hears nothing for ${CLIENT_TIMEOUT / 1000} s, so the page sends the same payment again${mode === "none" ? ", with nothing to mark it as a repeat" : ` with the same key ${c.key}`}.`);
        send(c);
      });
    };

    world.every(GAP, () => {
      const n = ++id;
      send({ n, key: `k${n}`, tries: 0, done: false });
    }, 0.4);

    return {
      tick(dt: number) {
        world.advance(dt);
        // A lost response is drawn up to the middle of the link, then disappears.
        const tokens = world.tokens().filter((t: Token) => !(t.label?.endsWith(LOST_MARK) && t.t > 0.5));
        const recent = world.time - apiNoteAt < 2000;
        const boxes: Record<string, BoxState> = {
          page: { note: `${id} checkout${id === 1 ? "" : "s"}, ${resent} resent` },
          api: { note: recent ? apiNote : inProgress ? `${inProgress} payment${inProgress === 1 ? "" : "s"} in progress` : "idle", tone: inProgress ? "ok" : "idle" },
          pay: { note: twice ? `${twice} charged more than once` : `${charges} charges, one each`, tone: twice ? "bad" : "ok" },
          db: mode === "none" ? { note: "no keys stored", tone: "idle" } : { note: `${rows} key${rows === 1 ? "" : "s"} stored${rows > keys.size ? `, ${rows - keys.size} twice` : ""}`, tone: rows > keys.size ? "bad" : "ok" },
        };
        return {
          boxes,
          tokens,
          counters: [
            { label: "Checkouts", value: String(id) },
            { label: "Charges made", value: String(charges) },
            { label: "Customers charged more than once", value: String(twice), tone: twice ? "bad" : undefined },
            mode === "none"
              ? { label: "Payments sent again", value: String(resent) }
              : { label: "Repeats caught by the key", value: String(caught) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Stop using the key: when a response is lost the page sends the payment again, the API charges the card again, and that customer pays twice.", params: { key: "none", lost: true, double: false } },
    { text: "Turn on double clicks with the key checked in code: both copies look the key up before either has saved it, so both charge.", params: { key: "code", lost: true, double: true } },
    { text: "Now keep the key in a UNIQUE column: the second copy's INSERT adds nothing, it gets 409 Conflict, and only one charge is made.", params: { key: "unique", lost: true, double: true } },
    { text: "No key and no lost responses: nothing is ever sent twice, so nobody is charged twice. The bug only shows when the network misbehaves, which is why it slips through testing.", params: { key: "none", lost: false, double: false } },
  ],
};
