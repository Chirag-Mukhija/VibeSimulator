import type { BoxState, ConceptScene, SceneParams } from "./types.ts";
import { pbool } from "./types.ts";
import { World } from "./world.ts";

// Scene timings (ms), slowed down to watch and not to scale.
const DNS_HOP = 300; // browser to its DNS resolver
const NEAR_HOP = 350; // browser to your server, one way, user nearby
const FAR_HOP = 750; // the same for a user on another continent: longer on purpose, it is the point of that control
const DB_HOP = 300; // your server to the database, same data center
const MIDDLEWARE = 500;
const HANDLER = 400;
const QUERY = 450;
const RESPOND = 300;
const PAUSE = 1800; // the user reads the page, then clicks again

// Real-world costs the counters report (same assumptions as the lifecycle simulation).
const NEAR_RTT = 20;
const FAR_RTT = 150;
const SERVER_MS = 27; // middleware about 2 ms, handler and database about 25 ms

const IP = "203.0.113.10";

/** Runs steps one after another; each step calls `next` when it is done. */
function chain(steps: ((next: () => void) => void)[]): void {
  const run = (i: number) => {
    const step = steps[i];
    if (step) step(() => run(i + 1));
  };
  run(0);
}

export const lifecycleScene: ConceptScene = {
  id: "http-request-lifecycle",
  title: "What happens before your handler runs",
  intro: "A user clicks, and the browser needs your server's address (DNS), a connection (TCP) and encryption (TLS) before the request can even leave. Then your middleware, handler and database do their work and the response comes back. Slowed down and not to scale; the counters show real-world times.",
  width: 780,
  height: 340,
  controls: [
    { type: "toggle", id: "keepAlive", label: "Keep-alive: reuse the connection" },
    { type: "toggle", id: "far", label: "User is far away" },
  ],
  defaults: { keepAlive: true, far: false },
  layout(p: SceneParams) {
    const far = pbool(p, "far");
    return {
      boxes: [
        { id: "dns", kind: "dns", label: "DNS resolver", detail: "name to IP address", x: 20, y: 24, w: 170, h: 88 },
        { id: "browser", kind: "browser", label: "Browser", detail: far ? `${FAR_RTT} ms round trip` : `${NEAR_RTT} ms round trip`, x: 20, y: 212, w: 170, h: 96 },
        { id: "server", kind: "server", label: "Your server", detail: "middleware, then handler", x: 290, y: 200, w: 220, h: 120 },
        { id: "db", kind: "database", label: "Database", detail: "same data center", x: 600, y: 215, w: 160, h: 90 },
      ],
      links: [
        { id: "b-dns", from: "browser", to: "dns", label: "DNS" },
        { id: "b-srv", from: "browser", to: "server", label: "HTTPS" },
        { id: "srv-db", from: "server", to: "db", label: "SQL" },
      ],
    };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const keepAlive = pbool(p, "keepAlive");
    const far = pbool(p, "far");
    const hop = far ? FAR_HOP : NEAR_HOP;
    const rtt = far ? FAR_RTT : NEAR_RTT;
    const dnsMs = Math.min(rtt, 30);

    let id = 0;
    let done = 0;
    let dnsCached = false;
    let connected = false;
    let setupTrips = 0; // round trips the current request paid before it was sent
    let firstMs: number | undefined;
    let laterMs: number | undefined;
    let browser: BoxState = { note: "no connection yet", tone: "idle" };
    let server: BoxState = { note: "idle", tone: "idle" };
    let db: BoxState = { note: "idle", tone: "idle" };
    let dns: BoxState = { note: "idle", tone: "idle" };

    const lookup = (next: () => void) => {
      browser = { note: "asking DNS…", tone: "busy" };
      dns = { note: "looking up the name", tone: "busy" };
      world.send("b-dns", "handshake", DNS_HOP, () => {
        dns = { note: `found ${IP}`, tone: "ok" };
        world.send("b-dns", "handshake", DNS_HOP, () => {
          dnsCached = true;
          dns = { note: `answered ${IP}`, tone: "idle" };
          world.log("DNS answers with the server's IP address, and the browser caches it for later requests.");
          next();
        }, { reverse: true, label: IP });
      }, { label: "api.example.com?" });
    };

    const tcp = (next: () => void) => {
      browser = { note: "TCP handshake…", tone: "busy" };
      world.send("b-srv", "handshake", hop, () => {
        world.send("b-srv", "handshake", hop, () => {
          connected = true;
          world.log(`TCP handshake: SYN out, SYN-ACK back. One round trip (${rtt} ms for real), and no request sent yet.`);
          next();
        }, { reverse: true, label: "SYN-ACK" });
      }, { label: "SYN" });
    };

    const tls = (next: () => void) => {
      browser = { note: "TLS handshake…", tone: "busy" };
      world.send("b-srv", "handshake", hop, () => {
        world.send("b-srv", "handshake", hop, () => {
          world.log("TLS 1.3: one more round trip to agree on encryption keys. Only now can the request go.");
          next();
        }, { reverse: true, label: "ServerHello" });
      }, { label: "ClientHello" });
    };

    const click = () => {
      const n = ++id;
      const needDns = !dnsCached;
      const needConn = !connected;
      setupTrips = (needDns ? 1 : 0) + (needConn ? 2 : 0);
      const setupMs = (needDns ? dnsMs : 0) + (needConn ? 2 * rtt : 0);
      const realMs = setupMs + rtt + SERVER_MS;
      if (n === 1) world.log("#1: the browser doesn't know the server's IP address yet, so it asks DNS first.");
      else if (needConn) world.log(`#${n} needs a new connection: TCP and TLS again. The DNS answer is still cached.`);
      else world.log(`#${n} reuses the open connection: no DNS, no handshakes, the request goes straight out.`);

      const steps: ((next: () => void) => void)[] = [];
      if (needDns) steps.push(lookup);
      if (needConn) steps.push(tcp, tls);
      steps.push((next) => {
        browser = { note: "waiting for the response", tone: "busy" };
        world.send("b-srv", "request", hop, next, { label: `#${n} GET /feed` });
      });
      steps.push((next) => {
        server = { note: "middleware: parse, auth", tone: "busy" };
        world.log(`#${n} reaches your server: middleware runs first, in order (parse the body, check auth), then the handler.`);
        world.after(MIDDLEWARE, next);
      });
      steps.push((next) => {
        server = { note: "handler: GET /feed", tone: "busy" };
        world.after(HANDLER, next);
      });
      steps.push((next) => {
        server = { note: "waiting for the database", tone: "busy" };
        world.send("srv-db", "request", DB_HOP, () => {
          db = { note: "running the query", tone: "busy" };
          world.after(QUERY, () => {
            db = { note: "idle", tone: "idle" };
            world.send("srv-db", "reply", DB_HOP, next, { reverse: true, label: "rows" });
          });
        }, { label: "SELECT" });
      });
      steps.push((next) => {
        server = { note: "building the response", tone: "busy" };
        world.after(RESPOND, next);
      });
      steps.push((next) => {
        server = { note: keepAlive ? "idle, connection kept open" : "idle", tone: "idle" };
        world.send("b-srv", "reply", hop, next, { reverse: true, label: `#${n} 200 OK` });
      });
      steps.push(() => {
        done++;
        if (n === 1) firstMs = realMs;
        else laterMs = realMs;
        world.log(setupMs
          ? `#${n} answered: about ${realMs} ms for real, ${setupMs} ms of it spent setting up before the request was sent.`
          : `#${n} answered: about ${realMs} ms for real, just the request, your code and the response.`);
        if (keepAlive) {
          browser = { note: "connection open, idle", tone: "ok" };
        } else {
          connected = false;
          browser = { note: "connection closed", tone: "idle" };
          server = { note: "idle, connection closed", tone: "idle" };
          world.log("Keep-alive is off, so the connection closes after the response.");
        }
        world.after(PAUSE, click);
      });
      chain(steps);
    };

    world.after(400, click);

    return {
      tick(dt: number) {
        world.advance(dt);
        const repeating = !keepAlive && id > 1 && setupTrips > 0;
        return {
          boxes: { dns, browser, server, db },
          tokens: world.tokens(),
          counters: [
            { label: "Round trips before the request was sent", value: id === 0 ? "–" : setupTrips === 3 ? "3: DNS, TCP, TLS" : setupTrips === 2 ? "2: TCP, TLS" : "0", tone: repeating ? "bad" : undefined },
            { label: "First request, real time", value: firstMs === undefined ? "–" : `${firstMs} ms` },
            { label: "Each later request, real time", value: laterMs === undefined ? "–" : `${laterMs} ms`, tone: laterMs !== undefined && keepAlive ? "good" : undefined },
            { label: "Answered", value: String(done) },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Watch the first request: DNS, then two handshake round trips, before the request leaves. Later clicks reuse the connection and go straight out, which is why they are faster.", params: { keepAlive: true, far: false } },
    { text: "Turn keep-alive off: the connection closes after each response, so every click pays the TCP and TLS round trips again (the DNS answer stays cached).", params: { keepAlive: false, far: false } },
    { text: "Make the user far away with keep-alive off: each round trip is now 150 ms, so setup costs 300 ms per request while your code takes 27 ms.", params: { keepAlive: false, far: true } },
    { text: "Far away with keep-alive on: only the first click pays the handshakes; later ones need just one round trip.", params: { keepAlive: true, far: true } },
  ],
};
