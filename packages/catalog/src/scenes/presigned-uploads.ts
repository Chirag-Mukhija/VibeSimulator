import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down and not to scale.
const HOP = 400; // a small request or answer between the browser and the API, or storage
const PIECE_HOP = 450; // one 20 MB piece crossing a link
const PIECES = 5;
const PIECE_MB = 20;
const FILE_MB = PIECES * PIECE_MB;
const SEND: Record<string, number> = { fast: 4000, slow: 8000 }; // how long a browser takes to send all its pieces
const FORWARD = 1500; // the API sending a whole file on to storage: data-center links are faster than users' uplinks
const SIGN = 150; // signing a URL is a local calculation with the secret key: no network call
const RECORD = 300; // the API records the finished upload
const STORE = 200; // storage writes the object and answers
const MEMORY_MB = 512; // what this server is allowed to use
const BLOCK_MB = 64; // one square in the memory row
const NODE_MB = 64; // what the process itself uses before any upload: one square
const RESTART = 3000;
const GAP: Record<string, number> = { light: 3400, busy: 1300 }; // average ms between new uploads

interface Upload {
  n: number;
  failed: boolean;
  /** MB of this file held in the API's memory. */
  held: number;
  heldFrom: number;
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const size = (mb: number) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

export const presignedUploadsScene: ConceptScene = {
  id: "presigned-uploads",
  title: "Uploading through your API or straight to storage",
  intro: "Users upload 100 MB videos, sent in 20 MB pieces. Through the API, every piece goes to your server, which (like multer's default memory storage) keeps the file in memory until it has passed it on to storage. With a presigned URL, the API only signs a short-lived URL and the browser uploads straight to storage. The server process may use 512 MB. Slowed down and not to scale.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "route", label: "Files go", options: [{ value: "direct", label: "Straight to storage" }, { value: "api", label: "Through your API" }] },
    { type: "choice", id: "traffic", label: "Uploads", options: [{ value: "light", label: "Light" }, { value: "busy", label: "Busy" }] },
    { type: "toggle", id: "slow", label: "Users on slow connections" },
  ],
  defaults: { route: "direct", traffic: "light", slow: false },
  layout(p: SceneParams) {
    const api = pstr(p, "route") === "api";
    return {
      boxes: [
        { id: "users", kind: "users", label: "Users", detail: "upload 100 MB videos", x: 20, y: 150, w: 160, h: 100 },
        { id: "app", kind: "app", label: "Your API", detail: api ? "multer keeps files in memory" : "signs upload URLs", x: 520, y: 16, w: 240, h: 124 },
        { id: "storage", kind: "storage", label: "Storage (S3)", detail: "the uploads bucket", x: 520, y: 270, w: 240, h: 110 },
      ],
      links: [
        { id: "users-app", from: "users", to: "app", label: api ? "POST file" : "small JSON" },
        { id: "users-storage", from: "users", to: "storage", label: "PUT file" },
        { id: "app-storage", from: "app", to: "storage", label: "PUT file" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const api = pstr(p, "route") === "api";
    const send = SEND[pbool(p, "slow") ? "slow" : "fast"]!;
    const holding = new Set<Upload>(); // uploads whose bytes are in the API's memory
    let mem = 0; // MB of file data in the API's memory
    let down = false;
    let restartedOnce = false;
    let id = 0;
    let active = 0; // uploads in progress, seen from the users' side
    let done = 0;
    let failed = 0;
    let stored = 0;
    let received = 0; // MB of file data that reached the API
    let heldMs = 0; // time the API spent holding upload requests
    let heldCount = 0;
    let signed = 0;
    let busy = 0; // small requests the API is working on (presigned)
    let storing = 0;
    const lastSaid = new Map<string, number>();

    const say = (key: string, gap: number, text: string) => {
      const last = lastSaid.get(key);
      if (last !== undefined && world.time - last < gap) return;
      lastSaid.set(key, world.time);
      world.log(text);
    };

    const fail = (u: Upload, why: string) => {
      if (u.failed) return;
      u.failed = true;
      failed++;
      active--;
      world.send("users-app", "error", HOP, undefined, { reverse: true, label: why });
    };

    /** Over the memory limit: the platform kills the process, and every upload it holds dies with it. */
    const kill = () => {
      const need = mem;
      const lost = [...holding];
      down = true;
      mem = 0;
      holding.clear();
      world.log(`Files in memory reach ${need} MB. With what Node itself uses, that's more than the server's 512 MB, so the process is killed.`);
      world.log(`${lost.length === 1 ? "The upload" : `All ${lost.length} uploads`} in progress fail with it, and the server takes a few seconds to restart.`);
      for (const u of lost) fail(u, "upload failed");
      world.after(RESTART, () => {
        down = false;
        if (!restartedOnce) world.log("The server is back after its restart, with empty memory. Uploads that were in progress must start again.");
        restartedOnce = true;
      });
    };

    // ---- through the API: browser -> API (held in memory) -> storage
    const throughApi = (u: Upload) => {
      const gap = send / PIECES;
      for (let i = 0; i < PIECES; i++) {
        world.after(i * gap, () => {
          if (u.failed) return;
          world.send("users-app", "request", PIECE_HOP, () => arrive(u, i), { label: `#${u.n} ${i + 1}/${PIECES}` });
        });
      }
    };

    const arrive = (u: Upload, piece: number) => {
      if (u.failed) return;
      if (down) {
        say("down", 4000, `#${u.n} can't reach the API: the server is still restarting.`);
        fail(u, "can't connect");
        return;
      }
      if (piece === 0) {
        holding.add(u);
        u.heldFrom = world.time;
        say("through", 10_000, `#${u.n} POSTs a 100 MB video to the API. multer keeps every byte in memory until the handler can pass the file on.`);
      }
      mem += PIECE_MB;
      u.held += PIECE_MB;
      received += PIECE_MB;
      if (NODE_MB + mem > MEMORY_MB) return kill();
      if (piece === PIECES - 1) forward(u);
    };

    const forward = (u: Upload) => {
      say("forward", 10_000, `All of #${u.n} is in memory now (${mem} MB of files held), so the API sends the same 100 MB on to storage.`);
      const gap = FORWARD / PIECES;
      for (let i = 0; i < PIECES; i++) {
        world.after(i * gap, () => {
          if (u.failed) return;
          world.send("app-storage", "request", PIECE_HOP, () => {
            if (u.failed || i < PIECES - 1) return;
            storing++;
            world.after(STORE, () => {
              storing--;
              if (u.failed) return;
              stored++;
              world.send("app-storage", "reply", PIECE_HOP, () => {
                if (u.failed) return;
                const took = world.time - u.heldFrom;
                holding.delete(u);
                mem -= u.held;
                u.held = 0;
                heldMs += took;
                heldCount++;
                say("freed", 10_000, `Storage has #${u.n}, so the API answers and frees its 100 MB. It held that request open for ${sec(took)}.`);
                world.send("users-app", "reply", HOP, () => {
                  done++;
                  active--;
                }, { reverse: true, label: "200 saved" });
              }, { reverse: true, label: "200" });
            });
          }, { label: `#${u.n} ${i + 1}/${PIECES}` });
        });
      }
    };

    // ---- presigned: browser asks the API for a URL, uploads to storage, tells the API it's done
    const presigned = (u: Upload) => {
      world.send("users-app", "request", HOP, () => {
        busy++;
        world.after(SIGN, () => {
          busy--;
          signed++;
          heldMs += SIGN;
          say("sign", 10_000, `#${u.n} asks for an upload URL. The API signs one with its secret key, a calculation with no call to S3, and answers at once.`);
          world.send("users-app", "reply", HOP, () => direct(u), { reverse: true, label: "signed URL" });
        });
      }, { label: `#${u.n} URL?` });
    };

    const direct = (u: Upload) => {
      say("direct", 10_000, `#${u.n} PUTs its 100 MB straight to storage with that URL. The API takes no part while the bytes move.`);
      const gap = send / PIECES;
      for (let i = 0; i < PIECES; i++) {
        world.after(i * gap, () => world.send("users-storage", "request", PIECE_HOP, () => {
          if (i < PIECES - 1) return;
          storing++;
          world.after(STORE, () => {
            storing--;
            stored++;
            world.send("users-storage", "reply", HOP, () => finish(u), { reverse: true, label: "200" });
          });
        }, { label: `#${u.n} ${i + 1}/${PIECES}` }));
      }
    };

    const finish = (u: Upload) => {
      world.send("users-app", "request", HOP, () => {
        busy++;
        world.after(RECORD, () => {
          busy--;
          heldMs += RECORD;
          heldCount++;
          say("record", 10_000, `#${u.n} tells the API the upload is done, and the API records the file's key. Its whole part: two small requests.`);
          world.send("users-app", "reply", HOP, () => {
            done++;
            active--;
          }, { reverse: true, label: "recorded" });
        });
      }, { label: `#${u.n} done` });
    };

    world.every(GAP[pstr(p, "traffic")] ?? GAP.light!, () => {
      const u: Upload = { n: ++id, failed: false, held: 0, heldFrom: 0 };
      active++;
      if (api) throughApi(u);
      else presigned(u);
    }, 0.7);

    return {
      tick(dt: number) {
        world.advance(dt);
        const blocks = down ? 0 : Math.min(MEMORY_MB / BLOCK_MB, Math.ceil((NODE_MB + mem) / BLOCK_MB));
        const total = MEMORY_MB / BLOCK_MB;
        const app: BoxState = down
          ? { slots: { total, busy: 0, label: "memory, 64 MB each" }, note: "killed: restarting…", tone: "bad" }
          : api
            ? { slots: { total, busy: blocks, label: "memory, 64 MB each" }, note: holding.size ? `holding ${holding.size} upload${holding.size === 1 ? "" : "s"}, ${mem} MB` : "idle, no files in memory", tone: blocks >= total - 1 ? "busy" : holding.size ? "ok" : "idle" }
            : { slots: { total, busy: blocks, label: "memory, 64 MB each" }, note: busy ? "signing or recording" : `idle, ${signed} URLs signed`, tone: busy ? "ok" : "idle" };
        return {
          boxes: {
            users: { note: failed ? `${done} done, ${failed} failed` : `${done} done, ${active} going`, tone: failed ? "bad" : undefined },
            app,
            storage: { note: `${stored} file${stored === 1 ? "" : "s"} stored`, tone: storing ? "ok" : "idle" },
          },
          tokens: world.tokens(),
          counters: [
            { label: "Uploads finished", value: String(done) },
            { label: "File data through your server", value: size(received) },
            { label: "Server time per upload", value: heldCount ? sec(heldMs / heldCount) : "–" },
            { label: "Failed uploads", value: String(failed), tone: failed ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Send files through your API: each 100 MB file sits in the server's memory from its first piece until storage has it, and the server holds each upload's request for several seconds instead of a fraction of one.", params: { route: "api", traffic: "light", slow: false } },
    { text: "Through your API with busy uploads: the files held at once need more than the server's 512 MB, the process is killed, and every upload in progress fails.", params: { route: "api", traffic: "busy", slow: false } },
    { text: "Through your API with slow connections: each file takes longer to arrive and sits in memory that much longer, so more memory is held at once, though traffic is light.", params: { route: "api", traffic: "light", slow: true } },
    { text: "Straight to storage, busy and slow: uploads take longer, but your server's part stays two small requests each, so its memory never moves and nothing fails.", params: { route: "direct", traffic: "busy", slow: true } },
  ],
};
