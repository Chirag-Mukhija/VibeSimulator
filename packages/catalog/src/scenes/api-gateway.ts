import type { BoxState, ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pstr } from "./types.ts";
import { World } from "./world.ts";
import { secs, throttledLog } from "./traffic-common.ts";

const HOP = 400; // ms on each link, slowed down to watch
const CHECK = 300; // verifying a token's signature: a little CPU, slowed down
const GAP = 900; // average ms between client requests
const EXPIRED = 0.25; // share of requests sent with an expired token

interface Service {
  id: "users" | "orders" | "payments";
  label: string;
  name: string;
  path: string;
  work: number;
  share: number;
}

const SERVICES: Service[] = [
  { id: "users", label: "User service", name: "user service", path: "/users", work: 600, share: 0.35 },
  { id: "orders", label: "Order service", name: "order service", path: "/orders", work: 900, share: 0.35 },
  { id: "payments", label: "Payment service", name: "payment service", path: "/payments", work: 1200, share: 0.3 },
];

/** True when this service has no token check of its own. */
const unchecked = (p: SceneParams, s: Service) => s.id === "payments" && pbool(p, "forgot");

export const apiGatewayScene: ConceptScene = {
  id: "api-gateway",
  title: "One front door for several services",
  intro: "Clients call three services: users, orders and payments. With a gateway, every request goes to one address; the gateway checks the token once, then routes by path (/orders goes to the order service). About one request in four carries an expired token. Slowed down; red envelopes are errors.",
  width: 780,
  height: 420,
  controls: [
    { type: "choice", id: "route", label: "Clients call", options: [{ value: "gateway", label: "One gateway" }, { value: "direct", label: "Each service directly" }] },
    { type: "toggle", id: "forgot", label: "Payment service has no token check" },
    { type: "toggle", id: "down", label: "Gateway is down" },
  ],
  defaults: { route: "gateway", forgot: false, down: false },
  layout(p: SceneParams) {
    const gw = pstr(p, "route") === "gateway";
    const boxes: SceneBox[] = [{ id: "clients", kind: "users", label: "Clients", detail: gw ? "know 1 address" : "know 3 addresses", x: 20, y: 160, w: 160, h: 100 }];
    const links: SceneLink[] = [];
    if (gw) {
      boxes.push({ id: "gateway", kind: "gateway", label: "API gateway", detail: "routes, checks tokens", x: 270, y: 150, w: 200, h: 120 });
      links.push({ id: "clients-gateway", from: "clients", to: "gateway", label: "HTTPS" });
    }
    SERVICES.forEach((s, i) => {
      const detail = gw
        ? (unchecked(p, s) ? "no check, relies on gateway" : "trusts the gateway's check")
        : (unchecked(p, s) ? "has no token check" : "checks tokens itself");
      boxes.push({ id: s.id, kind: "server", label: s.label, detail, x: 560, y: 10 + i * 148, w: 200, h: 104 });
      links.push(gw ? { id: `gateway-${s.id}`, from: "gateway", to: s.id, label: s.path } : { id: `clients-${s.id}`, from: "clients", to: s.id, label: s.path });
    });
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const gw = pstr(p, "route") === "gateway";
    const down = gw && pbool(p, "down");
    const say = throttledLog(world);
    const working: Record<string, number> = { users: 0, orders: 0, payments: 0 };
    const checkingAt: Record<string, number> = { users: 0, orders: 0, payments: 0 };
    const served: Record<string, number> = { users: 0, orders: 0, payments: 0 };
    let id = 0;
    let ok = 0;
    let refused = 0;
    let letThrough = 0;
    let failed = 0;
    let totalMs = 0;
    let routed = 0;
    let gwRefused = 0;
    let checking = 0;

    const pick = (): Service => {
      let r = world.random();
      for (const s of SERVICES) {
        r -= s.share;
        if (r < 0) return s;
      }
      return SERVICES[SERVICES.length - 1]!;
    };

    const work = (s: Service, then: () => void) => {
      working[s.id]!++;
      world.after(s.work, () => {
        working[s.id]!--;
        served[s.id]!++;
        then();
      });
    };

    const answered = (started: number) => {
      ok++;
      totalMs += world.time - started;
    };

    const viaGateway = (n: number, s: Service, expired: boolean, started: number) => {
      world.send("clients-gateway", "request", HOP, () => {
        if (down) {
          failed++;
          say("down", 5000, `#${n} for ${s.path} fails: the gateway is down, so the ${s.name} can't be reached, healthy as it is.`);
          world.send("clients-gateway", "error", HOP, undefined, { reverse: true, label: "connection refused" });
          return;
        }
        checking++;
        world.after(CHECK, () => {
          checking--;
          if (expired) {
            refused++;
            gwRefused++;
            say("401", 6000, `#${n} has an expired token: the gateway answers 401 Unauthorized, and no service ever sees the request.`);
            world.send("clients-gateway", "error", HOP, undefined, { reverse: true, label: "401 Unauthorized" });
            return;
          }
          routed++;
          if (unchecked(p, s)) say("trust", 60000, "The payment service has no token check of its own, but only requests the gateway has already checked can reach it.");
          else say("route", 9000, `#${n} for ${s.path}: the gateway checks the token once, then routes it by path to the ${s.name}.`);
          const l = `gateway-${s.id}`;
          world.send(l, "request", HOP, () => work(s, () =>
            world.send(l, "reply", HOP, () => world.send("clients-gateway", "reply", HOP, () => answered(started), { reverse: true, label: `#${n} 200 OK` }), { reverse: true, label: "200 OK" }),
          ), { label: `${s.path} + user id` });
        });
      }, { label: `#${n} ${s.path}` });
    };

    const direct = (n: number, s: Service, expired: boolean, started: number) => {
      const l = `clients-${s.id}`;
      const reply = () => world.send(l, "reply", HOP, () => answered(started), { reverse: true, label: `#${n} 200 OK` });
      world.send(l, "request", HOP, () => {
        if (unchecked(p, s)) {
          if (expired) {
            letThrough++;
            say("hole", 5000, `#${n} has an expired token, but the payment service has no check of its own, so it answers as if the token were fine.`);
          }
          work(s, reply);
          return;
        }
        checkingAt[s.id]!++;
        world.after(CHECK, () => {
          checkingAt[s.id]!--;
          if (expired) {
            refused++;
            say("401-direct", 6000, `#${n} has an expired token: the ${s.name} refuses it with 401, using its own copy of the token check.`);
            world.send(l, "error", HOP, undefined, { reverse: true, label: "401 Unauthorized" });
            return;
          }
          say("direct", 10000, `#${n} goes straight to the ${s.name}'s own address, and the service checks the token itself before working.`);
          work(s, reply);
        });
      }, { label: `#${n} ${s.path}` });
    };

    world.every(GAP, () => {
      const n = ++id;
      const s = pick();
      const expired = world.random() < EXPIRED;
      if (gw) viaGateway(n, s, expired, world.time);
      else direct(n, s, expired, world.time);
    }, 0.6);
    if (!gw && pbool(p, "down")) world.after(300, () => world.log("There is no gateway in this setup, so taking it down changes nothing."));

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, BoxState> = {
          clients: { note: down ? `${failed} failed` : `${ok} ok, ${refused} refused` },
        };
        if (gw) boxes.gateway = down ? { note: "down, not answering", tone: "bad" } : { note: `${routed} routed, ${gwRefused} refused`, tone: checking ? "ok" : "idle" };
        for (const s of SERVICES) {
          const w = working[s.id]!;
          const c = checkingAt[s.id]!;
          boxes[s.id] = down
            ? { note: "healthy, but unreachable", tone: "idle" }
            : { note: c ? "checking a token" : w ? `working on ${w}` : `${served[s.id]} served`, tone: w || c ? "ok" : "idle" };
        }
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Answered", value: String(ok) },
            { label: "Expired tokens refused", value: String(refused) },
            down
              ? { label: "Failed: gateway unreachable", value: String(failed), tone: failed ? "bad" : undefined }
              : { label: "Expired tokens let through", value: String(letThrough), tone: letThrough ? "bad" : undefined },
            { label: "Average time per answer", value: ok ? secs(totalMs / ok) : "–" },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Call each service directly: clients now need three addresses, each service checks tokens with its own copy of the code, and answers come back a little sooner, with one hop less each way.", params: { route: "direct" } },
    { text: "Directly, with no token check in the payment service: requests with expired tokens get real answers from it. One forgotten copy of the check is a hole.", params: { route: "direct", forgot: true } },
    { text: "Put the gateway back, payment check still missing: nothing gets through, because the gateway refuses expired tokens before they reach any service.", params: { route: "gateway", forgot: true } },
    { text: "Take the gateway down: every request fails, even though all three services are healthy and idle.", params: { route: "gateway", down: true } },
  ],
};
