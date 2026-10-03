import { bucket, num, str, type Params, type SimDef, type SimResult } from "./types.ts";

/** One request, laid out on a timeline: where the time actually goes. */

const MIDDLEWARE_MS = 1.5;
const DB_RTT_MS = 0.6;

function run(p: Params): SimResult {
  const rtt = num(p, "rtt");
  const server = num(p, "server");
  const fresh = str(p, "conn") === "new";
  const segs = (cold: boolean) => {
    const out: { label: string; start: number; duration: number; kind: string }[] = [];
    let t = 0;
    const add = (label: string, duration: number, kind: string) => {
      out.push({ label, start: t, duration, kind });
      t += duration;
    };
    if (cold) {
      add("DNS lookup", Math.min(rtt, 30), "network");
      add("TCP handshake", rtt, "network");
      add("TLS handshake", rtt, "network");
    }
    add("Request travels", rtt / 2, "network");
    add("Middleware (parse, auth)", MIDDLEWARE_MS, "server");
    add("Handler + database", server + DB_RTT_MS, "server");
    add("Response travels", rtt / 2, "network");
    return { out, total: t };
  };
  const cold = segs(true);
  const warm = segs(false);
  const first = fresh ? cold : warm;
  const network = first.out.filter((s) => s.kind === "network").reduce((a, s) => a + s.duration, 0);
  return {
    metrics: [
      { label: fresh ? "First request (new connection)" : "Request on a reused connection", value: first.total, format: "ms" },
      { label: "Every later request (keep-alive)", value: warm.total, format: "ms", tone: "good" },
      { label: "Share of time on the network", value: (network / first.total) * 100, format: "pct", tone: network / first.total > 0.6 ? "bad" : "neutral" },
    ],
    charts: [
      { type: "waterfall", title: "Where the time goes", rows: [
        { label: "New connection", segments: cold.out },
        { label: "Reused connection", segments: warm.out },
      ] },
    ],
    verdict: rtt > 60
      ? `At ${rtt} ms per round trip, setting up a new connection costs ${(cold.total - warm.total).toFixed(0)} ms before your code even runs. Keep-alive, a CDN or a closer region help more than a faster handler.`
      : `On a short round trip, your server's own work (${(server + MIDDLEWARE_MS).toFixed(0)} ms) is most of the request, so optimizing the handler and database pays off.`,
  };
}

export const lifecycleSim: SimDef = {
  id: "http-request-lifecycle",
  title: "Where a request's time goes",
  knobs: [
    { type: "slider", id: "rtt", label: "Network round trip", min: 1, max: 300, log: true, unit: "ms" },
    { type: "slider", id: "server", label: "Time in your handler and database", min: 1, max: 500, log: true, unit: "ms" },
    { type: "select", id: "conn", label: "Connection", options: [{ value: "new", label: "New connection (TLS)" }, { value: "reused", label: "Reused (keep-alive)" }] },
  ],
  defaults: { rtt: 120, server: 25, conn: "new" },
  run,
  predict(p, r) {
    return {
      question: `A user ${num(p, "rtt")} ms away opens a new HTTPS connection to an endpoint that takes ${num(p, "server")} ms to run. When do they get the response?`,
      options: [{ id: "a", label: `About ${num(p, "server")} ms` }, { id: "b", label: `About ${num(p, "server") + num(p, "rtt")} ms` }, { id: "c", label: `About ${num(p, "server") + 3 * num(p, "rtt")} ms or more` }],
      answer: bucket(r.metrics[0]!.value, [{ id: "a", at: num(p, "server") }, { id: "b", at: num(p, "server") + num(p, "rtt") }, { id: "c", at: num(p, "server") + 3 * num(p, "rtt") }]),
    };
  },
  assumptions: [
    "TLS 1.3 (one round trip); DNS answered by a nearby resolver; no request body upload time.",
    `${MIDDLEWARE_MS} ms of middleware and a ${DB_RTT_MS} ms round trip to the database on top of the handler time.`,
  ],
};
