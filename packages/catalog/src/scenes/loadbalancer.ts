import type { ConceptScene, SceneBox, SceneLink, SceneParams } from "./types.ts";
import { pbool, pnum, pstr } from "./types.ts";
import { Station, World } from "./world.ts";

const HOP = 450; // ms on each link, slowed down to watch
const SERVICE = 1600; // ms a server spends on one request
const SLOTS = 2; // requests a server works on at once

export const loadBalancerScene: ConceptScene = {
  id: "load-balancer",
  title: "Spreading requests over servers",
  intro: "Users send requests to a load balancer, which forwards each one to a server. Each server works on 2 requests at a time and lines up the rest. Slowed down so you can watch; each envelope is one request.",
  width: 780,
  height: 410,
  controls: [
    { type: "choice", id: "algorithm", label: "Balancer picks", options: [
      { value: "round-robin", label: "Round robin" },
      { value: "least-connections", label: "Least connections" },
      { value: "random", label: "Random" },
    ] },
    { type: "count", id: "servers", label: "Servers", min: 2, max: 4 },
    { type: "toggle", id: "slow", label: "Server 2 is slow (4×)" },
    { type: "choice", id: "traffic", label: "Traffic", options: [{ value: "light", label: "Light" }, { value: "busy", label: "Busy" }] },
  ],
  defaults: { algorithm: "round-robin", servers: 3, slow: false, traffic: "light" },
  layout(p: SceneParams) {
    const n = pnum(p, "servers");
    const boxes: SceneBox[] = [
      { id: "users", kind: "users", label: "Users", detail: "send requests", x: 20, y: 160, w: 140, h: 76 },
      { id: "lb", kind: "balancer", label: "Load balancer", detail: pstr(p, "algorithm").replace("-", " "), x: 270, y: 152, w: 170, h: 92 },
    ];
    const links: SceneLink[] = [{ id: "u-lb", from: "users", to: "lb", label: "HTTP" }];
    const top = (410 - (n * 96 + (n - 1) * 4)) / 2;
    for (let i = 0; i < n; i++) {
      boxes.push({ id: `s${i + 1}`, kind: "server", label: `Server ${i + 1}`, detail: i === 1 && pbool(p, "slow") ? "slow: 4× longer per request" : "app instance", x: 560, y: top + i * 100, w: 200, h: 96 });
      links.push({ id: `lb-s${i + 1}`, from: "lb", to: `s${i + 1}` });
    }
    return { boxes, links };
  },
  start(p: SceneParams, seed = 1) {
    const world = new World(seed);
    const n = pnum(p, "servers");
    const algorithm = pstr(p, "algorithm");
    const slow = pbool(p, "slow");
    const servers = Array.from({ length: n }, () => new Station(world, SLOTS));
    const inFlight = Array.from({ length: n }, () => 0); // what the balancer can see: sent and not yet answered
    let turn = 0;
    let id = 0;
    let done = 0;
    let totalMs = 0;
    let worst = 0;
    const name = (i: number) => `Server ${i + 1}`;

    const pick = (): number => {
      if (algorithm === "round-robin") return turn++ % n;
      if (algorithm === "random") return Math.floor(world.random() * n);
      let best = 0;
      for (let i = 1; i < n; i++) if (inFlight[i]! < inFlight[best]!) best = i;
      return best;
    };

    world.every(pstr(p, "traffic") === "busy" ? 340 : 760, () => {
      const req = ++id;
      const started = world.time;
      world.send("u-lb", "request", HOP, () => {
        const s = pick();
        const waiting = servers[s]!.waiting.length;
        if (algorithm === "round-robin") {
          world.log(waiting > 0 ? `Round robin sends #${req} to ${name(s)} because it's next in turn, though ${waiting} already wait there.` : `Round robin sends #${req} to ${name(s)}: simply the next in turn.`);
        } else if (algorithm === "least-connections") {
          world.log(`Least connections sends #${req} to ${name(s)}: it has the fewest requests in progress (${inFlight[s]}).`);
        } else world.log(`Random picks ${name(s)} for #${req}${waiting > 0 ? `, where ${waiting} are waiting` : ""}.`);
        inFlight[s]!++;
        world.send(`lb-s${s + 1}`, "request", HOP, () => {
          servers[s]!.serve(slow && s === 1 ? SERVICE * 4 : SERVICE, () => {
            world.send(`lb-s${s + 1}`, "reply", HOP, () => {
              inFlight[s]!--;
              world.send("u-lb", "reply", HOP, () => {
                done++;
                const took = world.time - started;
                totalMs += took;
                worst = Math.max(worst, took);
              }, { reverse: true });
            }, { reverse: true });
          });
        }, { label: `#${req}` });
      }, { label: `#${req}` });
    }, 0.4);

    return {
      tick(dt: number) {
        world.advance(dt);
        const boxes: Record<string, import("./types.ts").BoxState> = {
          users: { note: `${done} answered` },
          lb: { note: algorithm === "least-connections" ? `in progress: ${inFlight.join(" / ")}` : algorithm === "round-robin" ? `next: ${name(turn % n)}` : "picks at random" },
        };
        servers.forEach((st, i) => {
          const q = st.waiting.length;
          boxes[`s${i + 1}`] = { slots: { total: SLOTS, busy: st.busy, label: "working on" }, queue: q, note: `${st.served} done${q ? `, ${q} waiting` : ""}`, tone: q >= 4 ? "bad" : st.busy === SLOTS ? "busy" : st.busy ? "ok" : "idle" };
        });
        const avg = done ? totalMs / done : 0;
        const longest = Math.max(...servers.map((s) => s.waiting.length));
        return {
          boxes,
          tokens: world.tokens(),
          counters: [
            { label: "Answered", value: String(done) },
            { label: "Average time per request", value: done ? `${(avg / 1000).toFixed(1)} s` : "–", tone: done && avg > 3 * (HOP * 4 + SERVICE) / 2 ? "bad" : undefined },
            { label: "Longest line", value: String(longest), tone: longest >= 4 ? "bad" : undefined },
          ],
          log: world.recent(),
        };
      },
    };
  },
  tryThis: [
    { text: "Make Server 2 slow under busy traffic with round robin: it still gets every third request, so its line keeps growing while the others have room.", params: { algorithm: "round-robin", slow: true, traffic: "busy", servers: 3 } },
    { text: "Now switch to least connections: the balancer sees Server 2 still has requests in progress and sends new ones elsewhere.", params: { algorithm: "least-connections", slow: true, traffic: "busy", servers: 3 } },
    { text: "Two servers, busy traffic, nothing slow: both lines grow. More servers is the fix here, not a smarter algorithm.", params: { algorithm: "least-connections", slow: false, traffic: "busy", servers: 2 } },
  ],
};
