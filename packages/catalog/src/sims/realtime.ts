import { CALIBRATION, Histogram, Resource, Sim } from "@vibesim/sim";
import { bucket, num, type Params, type SimDef, type SimResult } from "./types.ts";

/**
 * Same users, four ways to deliver updates. Memory and CPU per connection,
 * request and message come from measurements of a real Node server
 * (calibration/REPORT.md); the server's queue is simulated so overload shows up.
 */

export type Mode = "short-poll" | "long-poll" | "sse" | "websocket";
export const MODE_LABEL: Record<Mode, string> = {
  "short-poll": "Short polling",
  "long-poll": "Long polling",
  sse: "Server-Sent Events",
  websocket: "WebSocket",
};

const RTT_MS = 40;
const LONG_POLL_TIMEOUT_S = 30;
const C = CALIBRATION;

export interface ModeResult {
  mode: Mode;
  requestsPerSec: number;
  messagesPerSec: number;
  wastedPct: number;
  cpuPct: number;
  memoryMB: number;
  delayMs: number;
  overloaded: boolean;
  p95ServerMs: number;
}

/** Simulates a single-core Node server's queue for `seconds` at the given op mix. */
function serverQueue(opsPerSec: number, costUs: number, seed: number): { p95: number; overloaded: boolean } {
  if (opsPerSec <= 0) return { p95: 0, overloaded: false };
  const sim = new Sim(seed);
  const cpu = new Resource(sim, 1);
  const waits = new Histogram();
  // Sample a slice: at most ~40k operations, scaled to the same load.
  const seconds = Math.min(5, 40_000 / opsPerSec);
  const total = Math.max(200, Math.round(opsPerSec * seconds));
  let n = 0;
  function* op() {
    const start = sim.now;
    yield cpu.acquire();
    yield sim.timeout(costUs / 1000);
    cpu.release();
    waits.add(sim.now - start);
  }
  function* arrivals() {
    while (n < total) {
      yield sim.timeout(sim.rng.exp(1000 / opsPerSec));
      n++;
      sim.spawn(op());
    }
  }
  sim.spawn(arrivals());
  sim.run(Infinity, 600_000);
  const util = (opsPerSec * costUs) / 1e6;
  return { p95: waits.percentile(95), overloaded: util >= 0.95 };
}

export function deliver(mode: Mode, users: number, intervalS: number, updatesPerMin: number, seed = 1): ModeResult {
  const updateRate = updatesPerMin / 60; // per user per second
  const messagesPerSec = users * updateRate;
  let requestsPerSec = 0;
  let wastedPct = 0;
  let memoryKB = 0;
  let delayMs = RTT_MS / 2;
  let cpuUs = 0;
  if (mode === "short-poll") {
    requestsPerSec = users / intervalS;
    wastedPct = Math.exp(-updateRate * intervalS) * 100; // chance nothing changed since the last poll
    delayMs = (intervalS * 1000) / 2 + RTT_MS;
    cpuUs = requestsPerSec * C.cpuPerRequestUs;
    memoryKB = 0;
  } else if (mode === "long-poll") {
    // One request per update or per timeout, whichever comes first.
    requestsPerSec = users * Math.max(updateRate, 1 / LONG_POLL_TIMEOUT_S);
    wastedPct = updateRate >= 1 / LONG_POLL_TIMEOUT_S ? 0 : (1 - updateRate * LONG_POLL_TIMEOUT_S) * 100;
    delayMs = RTT_MS * 1.5;
    cpuUs = requestsPerSec * C.cpuPerRequestUs + messagesPerSec * C.cpuPerWsMessageUs;
    memoryKB = users * C.memoryPerConnectionKB.longpoll;
  } else {
    const kb = mode === "sse" ? C.memoryPerConnectionKB.sse : C.memoryPerConnectionKB.ws;
    requestsPerSec = 0;
    delayMs = RTT_MS / 2;
    cpuUs = messagesPerSec * C.cpuPerWsMessageUs;
    memoryKB = users * kb;
  }
  const busy = requestsPerSec + messagesPerSec > 0 ? C.cpuBusyBaseFraction : 0;
  const cpuPct = (busy + cpuUs / 1e6) * 100;
  const ops = requestsPerSec + messagesPerSec;
  const perOpUs = ops > 0 ? cpuUs / ops : 0;
  const q = serverQueue(ops, perOpUs, seed);
  const overloaded = cpuPct >= 95 || q.overloaded;
  return {
    mode, requestsPerSec, messagesPerSec, wastedPct, cpuPct, memoryMB: memoryKB / 1024,
    delayMs: overloaded ? Math.max(delayMs, 5_000) : delayMs + q.p95, overloaded, p95ServerMs: q.p95,
  };
}

function run(focus: Mode) {
  return (p: Params, seed = 1): SimResult => {
    const users = num(p, "users");
    const interval = num(p, "interval");
    const updates = num(p, "updates");
    const all = (Object.keys(MODE_LABEL) as Mode[]).map((m) => deliver(m, users, interval, updates, seed));
    const me = all.find((r) => r.mode === focus)!;
    const bars = (title: string, unit: string, pick: (r: ModeResult) => number) => ({
      type: "bars" as const, title, unit,
      bars: all.map((r) => ({ label: MODE_LABEL[r.mode], value: pick(r), highlight: r.mode === focus, note: r.overloaded ? "overloaded" : undefined })),
    });
    return {
      metrics: [
        { label: "Requests per second", value: me.requestsPerSec, format: "rps", tone: me.requestsPerSec > 5000 ? "bad" : "neutral" },
        { label: "Server CPU", value: me.cpuPct, format: "pct", tone: me.overloaded ? "bad" : me.cpuPct > 60 ? "neutral" : "good", hint: "share of one core (Node runs your JS on one)" },
        { label: "Memory for open connections", value: me.memoryMB, format: "mb" },
        { label: "Time until the user sees an update", value: me.delayMs, format: "ms", tone: me.delayMs > 1500 ? "bad" : "good" },
        { label: "Responses with nothing new", value: me.wastedPct, format: "pct", tone: me.wastedPct > 50 ? "bad" : "good" },
      ],
      charts: [
        bars("Requests per second hitting the server", "req/s", (r) => r.requestsPerSec),
        bars("Server CPU (% of one core)", "%", (r) => r.cpuPct),
        bars("Memory held for open connections", "MB", (r) => r.memoryMB),
        bars("Average delay before the user sees an update", "ms", (r) => r.delayMs),
      ],
      verdict: me.overloaded
        ? `${MODE_LABEL[focus]} needs more than one core at this load, so requests queue up and time out. Something has to change: fewer requests (push instead of poll) or more instances.`
        : verdictFor(focus, me, all),
    };
  };
}

function verdictFor(focus: Mode, me: ModeResult, all: ModeResult[]): string {
  const ws = all.find((r) => r.mode === "websocket")!;
  if (focus === "short-poll") {
    return `Polling costs ${Math.round(me.requestsPerSec).toLocaleString("en-US")} requests every second whether or not anything changed (${Math.round(me.wastedPct)}% come back empty), and users wait about ${(me.delayMs / 1000).toFixed(1)} s on average. A WebSocket would send only the ${Math.round(ws.messagesPerSec).toLocaleString("en-US")} real updates per second, but holds ${ws.memoryMB.toFixed(0)} MB of open connections.`;
  }
  if (focus === "long-poll") {
    return `Long polling answers within about one round trip and cuts requests to ${Math.round(me.requestsPerSec).toLocaleString("en-US")}/s, but every waiting user holds an open HTTP request (${me.memoryMB.toFixed(0)} MB here) and each update costs a full new request.`;
  }
  if (focus === "sse") {
    return `One open stream per user: no polling requests at all, updates arrive in one hop, and memory (${me.memoryMB.toFixed(0)} MB here) is the cost. It is one-way: the browser still uses normal requests to send anything back.`;
  }
  return `Each user holds one small connection (${me.memoryMB.toFixed(0)} MB total here) and the server sends only real updates, so CPU tracks how much changes, not how many users there are. The catch: connections stick to one server, so you need sticky load balancing and a pub/sub backplane to scale out.`;
}

const knobs = [
  { type: "slider" as const, id: "users", label: "Users online", min: 100, max: 200_000, log: true },
  { type: "slider" as const, id: "interval", label: "Poll interval (short polling)", min: 1, max: 60, step: 1, unit: "s" },
  { type: "slider" as const, id: "updates", label: "Updates per user per minute", min: 0.1, max: 60, log: true },
];

function makeSim(id: string, focus: Mode, title: string): SimDef {
  return {
    id, title, knobs,
    defaults: { users: 10_000, interval: 5, updates: 1 },
    run: run(focus),
    predict(p, result) {
      if (focus === "short-poll") {
        const rps = result.metrics[0]!.value;
        return {
          question: `${num(p, "users").toLocaleString("en-US")} users poll every ${num(p, "interval")} s. How many requests per second reach your server?`,
          options: [{ id: "a", label: "About 20" }, { id: "b", label: "About 200" }, { id: "c", label: "About 2,000" }, { id: "d", label: "About 20,000" }],
          answer: bucket(rps, [{ id: "a", at: 20 }, { id: "b", at: 200 }, { id: "c", at: 2000 }, { id: "d", at: 20000 }]),
        };
      }
      const mb = result.metrics[2]!.value;
      return {
        question: `${num(p, "users").toLocaleString("en-US")} users keep a ${MODE_LABEL[focus]} connection open. Roughly how much server memory do those connections take?`,
        options: [{ id: "a", label: "About 1 MB" }, { id: "b", label: "About 10 MB" }, { id: "c", label: "About 100 MB" }, { id: "d", label: "About 1 GB" }],
        answer: bucket(mb, [{ id: "a", at: 1 }, { id: "b", at: 10 }, { id: "c", at: 100 }, { id: "d", at: 1000 }]),
      };
    },
    assumptions: [
      `Memory per connection and CPU per request or message were measured on a real Node server (${C.measuredOn}, Node ${C.node}): WebSocket ${C.memoryPerConnectionKB.ws} KB, SSE ${C.memoryPerConnectionKB.sse} KB, pending long-poll ${C.memoryPerConnectionKB.longpoll} KB per connection; ${C.cpuPerRequestUs} µs per poll request plus ${Math.round(C.cpuBusyBaseFraction * 100)}% fixed; ${C.cpuPerWsMessageUs} µs per pushed message. Held-out checks landed within ±25%.`,
      "One Node process, no TLS, small JSON messages. TLS, bigger payloads and real handlers cost more.",
      `${RTT_MS} ms round trip between browser and server; long polls time out after ${LONG_POLL_TIMEOUT_S} s; updates arrive at random (Poisson).`,
      "SSE writes are costed like WebSocket messages (not separately calibrated).",
    ],
  };
}

export const shortPollingSim = makeSim("realtime-short-poll", "short-poll", "Same users, four ways to deliver updates");
export const longPollingSim = makeSim("realtime-long-poll", "long-poll", "Same users, four ways to deliver updates");
export const sseSim = makeSim("realtime-sse", "sse", "Same users, four ways to deliver updates");
export const websocketSim = makeSim("realtime-websocket", "websocket", "Same users, four ways to deliver updates");
