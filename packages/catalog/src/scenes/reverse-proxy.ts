import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";
import { plural, secs, throttledLog } from "./traffic-common.ts";

const HOP = 400; // a browser to whatever it connects to, slowed down to watch
const LOCAL_HOP = 300; // Nginx to the app: same machine or private network
const SLOW = 2000; // a page or file crawling down to the slow phone: long on purpose, it is the point of that control
const NGINX_FILE = 150; // Nginx reading a static file from disk
const APP_FILE = 400; // the app serving the same file through express.static
const PAGE = 700; // the app building a page
const PAUSE: [number, number] = [1200, 2600]; // between visits
const PATHS = ["GET /", "GET /app.js", "GET /logo.png"];

interface Client {
  name: string;
  box: "users" | "phone";
  slow: boolean;
  pages: number;
  downloading: boolean;
}

export const reverseProxyScene: ConceptScene = {
  id: "reverse-proxy",
  title: "Nginx in front of your app",
  intro: "Two browsers and a phone each load a page plus two static files, then come back for more. With Nginx in front, clients only ever talk to Nginx: it does TLS, answers static files itself and forwards page requests to the app over a private connection. The phone's network is slow, so big responses take a while to reach it. Slowed down; small ochre envelopes are connection setup.",
  width: 780,
  height: 400,
  controls: [
    { type: "choice", id: "front", label: "Clients connect to", options: [{ value: "nginx", label: "Nginx, then the app" }, { value: "direct", label: "The app directly" }] },
    { type: "toggle", id: "slow", label: "The phone is on a slow network" },
    { type: "toggle", id: "keepAlive", label: "Nginx keeps connections to the app open" },
  ],
  defaults: { front: "nginx", slow: true, keepAlive: true },
  layout(p: SceneParams) {
    const nginx = pstr(p, "front") === "nginx";
    const front = nginx ? "nginx" : "app";
    const boxes: SceneBox[] = [
      { id: "users", kind: "browser", label: "Browsers", detail: "2 users, fast network", x: 20, y: 40, w: 170, h: 96 },
      { id: "phone", kind: "browser", label: "Phone", detail: pbool(p, "slow") ? "slow network" : "fast network", x: 20, y: 264, w: 170, h: 96 },
    ];
    if (nginx) boxes.push({ id: "nginx", kind: "proxy", label: "Nginx", detail: "TLS, files, buffering", x: 280, y: 142, w: 200, h: 116 });
    boxes.push({ id: "app", kind: "app", label: "Node app", detail: nginx ? "private, plain HTTP" : "public, does its own TLS", x: 570, y: 142, w: 190, h: 116 });
    const links: SceneLink[] = [
      { id: `users-${front}`, from: "users", to: front, label: "HTTPS" },
      { id: `phone-${front}`, from: "phone", to: front, label: "HTTPS" },
    ];
    if (nginx) links.push({ id: "nginx-app", from: "nginx", to: "app", label: "HTTP", persistent: pbool(p, "keepAlive") });
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const nginx = pstr(p, "front") === "nginx";
    const keepAlive = pbool(p, "keepAlive");
    const front = nginx ? "nginx" : "app";
    const say = throttledLog(world);
    const clients: Client[] = [
      { name: "Browser 1", box: "users", slow: false, pages: 0, downloading: false },
      { name: "Browser 2", box: "users", slow: false, pages: 0, downloading: false },
      { name: "The phone", box: "phone", slow: pbool(p, "slow"), pages: 0, downloading: false },
    ];
    const link = (c: Client) => `${c.box}-${front}`;
    let sent = 0; // requests the clients sent
    let atApp = 0; // requests that reached the app
    let appTls = 0; // TLS handshakes the app did itself
    let appConns = 0; // connections the app accepted
    let open = 0; // connections open at the app right now
    let idle = 0; // Nginx's open connections to the app not in use
    let filesByNginx = 0;
    let feeding = 0; // responses Nginx is passing on to the slow phone
    let building = 0;
    let servingFiles = 0;
    let sending = 0;
    let sendingSlow = 0;
    let longest = 0; // longest the app spent sending one response

    /** TCP, then TLS, with whatever the client connects to. */
    const connect = (c: Client, next: () => void) => {
      const l = link(c);
      world.send(l, "handshake", HOP, () => {
        if (!nginx) {
          appConns++;
          open++;
        }
        world.send(l, "handshake", HOP, () => world.send(l, "handshake", HOP, () => world.send(l, "handshake", HOP, () => {
          if (nginx) say("tls-nginx", 20000, `${c.name} connects to Nginx: TCP, then TLS. The certificate lives on Nginx; the app never handles encryption.`);
          else {
            appTls++;
            say("tls-app", 20000, `${c.name} connects straight to the app: the app does the TLS handshake itself and must hold the certificate.`);
          }
          next();
        }, { reverse: true, label: "TLS done" }), { label: "TLS hello" }), { reverse: true, label: "SYN-ACK" });
      }, { label: "SYN" });
    };

    const download = (c: Client, label: string, done: () => void) => {
      c.downloading = true;
      world.send(link(c), "reply", c.slow ? SLOW : HOP, () => {
        c.downloading = false;
        done();
      }, { reverse: true, label });
    };

    const viaNginx = (c: Client, path: string, next: () => void) => {
      if (path !== "GET /") {
        world.after(NGINX_FILE, () => {
          filesByNginx++;
          say("file-nginx", 10000, `Nginx answers ${path} from disk itself: static files never reach the app.`);
          if (c.slow) feeding++;
          download(c, path.slice(5), () => {
            if (c.slow) feeding--;
            next();
          });
        });
        return;
      }
      const forward = () => world.send("nginx-app", "request", LOCAL_HOP, () => {
        atApp++;
        building++;
        world.after(PAGE, () => {
          building--;
          sending++;
          const handed = world.time;
          world.send("nginx-app", "reply", LOCAL_HOP, () => {
            sending--;
            longest = Math.max(longest, world.time - handed);
            if (keepAlive) idle++;
            else open--;
            if (c.slow) {
              feeding++;
              say("buffer", 8000, "The app hands its page to Nginx over the fast local link and is free again. Nginx feeds it to the slow phone at the phone's pace.");
            }
            download(c, "200 page", () => {
              if (c.slow) feeding--;
              next();
            });
          }, { reverse: true, label: "200 page" });
        });
      }, { label: "GET /" });
      if (keepAlive && idle > 0) {
        idle--;
        say("reuse", 12000, "Nginx forwards GET / to the app over a connection it already has open: no handshake this time.");
        forward();
        return;
      }
      appConns++;
      open++;
      if (keepAlive) say("open", 12000, "Nginx opens a connection to the app to forward GET /, and keeps it open afterwards for the next requests.");
      else say("no-keepalive", 8000, "Keep-alive is off, so Nginx opens a new connection to the app just to forward GET /, and closes it afterwards.");
      world.send("nginx-app", "handshake", LOCAL_HOP, () => world.send("nginx-app", "handshake", LOCAL_HOP, forward, { reverse: true, label: "SYN-ACK" }), { label: "SYN" });
    };

    const direct = (c: Client, path: string, next: () => void) => {
      atApp++;
      const page = path === "GET /";
      if (page) building++;
      else {
        servingFiles++;
        say("file-app", 10000, `The app serves ${path} itself: with nothing in front, every static file is a request for your Node process.`);
      }
      world.after(page ? PAGE : APP_FILE, () => {
        if (page) building--;
        else servingFiles--;
        sending++;
        if (c.slow) {
          sendingSlow++;
          say("slow-app", 8000, "The app is sending to the slow phone at the phone's pace: it keeps the connection and the unsent bytes until the phone has them all.");
        }
        const handed = world.time;
        download(c, page ? "200 page" : path.slice(5), () => {
          sending--;
          if (c.slow) sendingSlow--;
          longest = Math.max(longest, world.time - handed);
          next();
        });
      });
    };

    const fetch = (c: Client, k: number) => {
      const path = PATHS[k];
      if (!path) {
        c.pages++;
        if (!nginx) open--; // the browser closes its connection to the app
        world.after(PAUSE[0] + world.random() * (PAUSE[1] - PAUSE[0]), () => visit(c));
        return;
      }
      world.send(link(c), "request", HOP, () => {
        sent++;
        const next = () => fetch(c, k + 1);
        if (nginx) viaNginx(c, path, next);
        else direct(c, path, next);
      }, { label: path });
    };

    const visit = (c: Client) => connect(c, () => fetch(c, 0));

    clients.forEach((c, i) => world.after(300 + i * 700, () => visit(c)));

    const appNote = () => {
      if (building) return "building a page";
      if (servingFiles) return "serving a static file";
      if (sendingSlow) return "still sending to the phone";
      if (sending) return "sending a response";
      return `idle, ${plural(open, "connection")} open`;
    };

    return {
      tick(dt: number) {
        world.advance(dt);
        const phone = clients[2]!;
        const crawling = phone.slow && phone.downloading;
        const boxes: Record<string, BoxState> = {
          users: { note: `${clients[0]!.pages + clients[1]!.pages} pages loaded` },
          phone: { note: crawling ? "downloading slowly" : `${phone.pages} pages loaded`, tone: crawling ? "busy" : undefined },
          app: { note: appNote(), tone: building || servingFiles || sending ? "ok" : "idle" },
        };
        if (nginx) boxes.nginx = { note: feeding ? "feeding the slow phone" : `${filesByNginx} files served itself`, tone: feeding ? "busy" : "ok" };
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Requests that reached the app", value: `${atApp} of ${sent}` },
            { label: "TLS handshakes done by the app", value: String(appTls) },
            { label: "New connections to the app", value: String(appConns) },
            { label: "Longest the app spent sending one response", value: longest ? secs(longest) : "–", tone: longest > 1500 ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Watch the slow phone: Nginx takes each page from the app over the fast local link and feeds it to the phone itself, so the app is free long before the phone has finished.", params: { front: "nginx", slow: true, keepAlive: true } },
    { text: "Connect clients straight to the app: it now does every TLS handshake, serves every static file, and holds each response to the slow phone (the connection and the unsent bytes) until the whole download is done.", params: { front: "direct" } },
    { text: "Turn off keep-alive to the app: Nginx opens a fresh connection, with its own handshake, for every page it forwards.", params: { keepAlive: false } },
  ],
};
