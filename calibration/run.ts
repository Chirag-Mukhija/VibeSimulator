// Measures a real Node server on this machine and writes the simulator's
// parameters plus a report comparing held-out measurements to predictions.
// Usage: pnpm --filter @vibesim/calibration calibrate
import { fork, type ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const paramsOut = path.resolve(here, "../packages/sim/src/params.json");
const reportOut = path.resolve(here, "REPORT.md");
let nextPort = 4600;

interface Stats { rss: number; heapUsed: number; external: number; cpuUser: number; cpuSystem: number; ws: number; sse: number; longPoll: number; wsSends: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function once<T>(child: ChildProcess, pred: (m: any) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (m: any) => {
      if (pred(m)) {
        child.off("message", onMsg);
        resolve(m as T);
      }
    };
    child.on("message", onMsg);
    child.once("exit", (code) => reject(new Error(`process exited (${code}) before replying`)));
  });
}

const children = new Set<ChildProcess>();
process.on("exit", () => {
  for (const c of children) c.kill();
});

function track(c: ChildProcess): ChildProcess {
  children.add(c);
  c.once("exit", () => children.delete(c));
  return c;
}

async function startServer(): Promise<{ proc: ChildProcess; port: number }> {
  const port = nextPort++;
  const proc = track(fork(path.join(here, "server.mjs"), [String(port)], { execArgv: ["--expose-gc"], stdio: ["ignore", "inherit", "inherit", "ipc"] }));
  await once(proc, (m) => m === "listening");
  await sleep(200);
  return { proc, port };
}

async function stats(port: number, gc = true): Promise<Stats> {
  const res = await fetch(`http://127.0.0.1:${port}/__stats${gc ? "?gc=1" : ""}`);
  return (await res.json()) as Stats;
}

async function settledStats(port: number): Promise<Stats> {
  await sleep(400);
  await stats(port);
  await sleep(200);
  return stats(port);
}

async function hold(kind: string, count: number, port: number): Promise<ChildProcess> {
  const c = track(fork(path.join(here, "client.mjs"), ["hold", kind, String(count), String(port)], { stdio: ["ignore", "inherit", "inherit", "ipc"] }));
  const m = await once<{ ready: number }>(c, (x) => typeof x === "object" && "ready" in x);
  if (m.ready !== count) throw new Error(`only ${m.ready}/${count} ${kind} connections opened`);
  return c;
}

async function closeAll(clients: ChildProcess[], port: number) {
  await fetch(`http://127.0.0.1:${port}/__close`);
  for (const c of clients) c.send("close");
  await Promise.all(clients.map((c) => new Promise((r) => c.once("exit", r))));
  await sleep(1500);
}

async function rate(reqPerSec: number, seconds: number, port: number) {
  const c = track(fork(path.join(here, "client.mjs"), ["rate", String(reqPerSec), String(seconds), String(port)], { stdio: ["ignore", "inherit", "inherit", "ipc"] }));
  return once<{ done: number; errors: number; seconds: number }>(c);
}

/** Ordinary least squares: y = a + b * x. */
function line(points: [number, number][]): { a: number; b: number } {
  const n = points.length;
  const mx = points.reduce((s, [x]) => s + x, 0) / n;
  const my = points.reduce((s, [, y]) => s + y, 0) / n;
  const b = points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) / points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
  return { a: my - b * mx, b };
}

/** Least-squares slope through the origin: y = k * x. */
function slope(points: [number, number][]): number {
  const sxy = points.reduce((a, [x, y]) => a + x * y, 0);
  const sxx = points.reduce((a, [x]) => a + x * x, 0);
  return sxy / sxx;
}

const kb = (bytes: number) => bytes / 1024;
const fmt = (n: number, d = 1) => n.toFixed(d);

async function memoryPerConnection(kind: string, steps: number[]) {
  const { proc, port } = await startServer();
  const base = await settledStats(port);
  const clients: ChildProcess[] = [];
  const points: { n: number; rssKB: number; heapKB: number }[] = [];
  let opened = 0;
  for (const target of steps) {
    clients.push(await hold(kind, target - opened, port));
    opened = target;
    const s = await settledStats(port);
    points.push({ n: target, rssKB: kb(s.rss - base.rss), heapKB: kb(s.heapUsed + s.external - base.heapUsed - base.external) });
  }
  await closeAll(clients, port);
  proc.kill();
  return {
    kind,
    baseRssMB: base.rss / 1024 / 1024,
    points,
    rssKBPerConn: slope(points.map((p) => [p.n, p.rssKB])),
    heapKBPerConn: slope(points.map((p) => [p.n, p.heapKB])),
  };
}

async function memoryAt(kind: string, n: number) {
  const { proc, port } = await startServer();
  const base = await settledStats(port);
  const c = await hold(kind, n, port);
  const s = await settledStats(port);
  await closeAll([c], port);
  proc.kill();
  return kb(s.rss - base.rss);
}

async function cpuPerRequest(reqPerSec: number, seconds: number) {
  const { proc, port } = await startServer();
  await rate(1000, 1, port); // warm up the JIT
  const before = await stats(port, false);
  const t0 = performance.now();
  const r = await rate(reqPerSec, seconds, port);
  const wall = (performance.now() - t0) / 1000;
  const after = await stats(port, false);
  proc.kill();
  const cpuUs = after.cpuUser + after.cpuSystem - before.cpuUser - before.cpuSystem;
  return { reqPerSec, done: r.done, errors: r.errors, cpuUsPerRequest: cpuUs / r.done, cpuFraction: cpuUs / 1e6 / wall };
}

async function cpuPerWsMessage(clientsN: number, rounds: number) {
  const { proc, port } = await startServer();
  const c = await hold("ws", clientsN, port);
  await fetch(`http://127.0.0.1:${port}/emit?n=2`); // warm up
  await sleep(300);
  const before = await stats(port, false);
  await fetch(`http://127.0.0.1:${port}/emit?n=${rounds}`);
  await sleep(800);
  const after = await stats(port, false);
  await closeAll([c], port);
  proc.kill();
  const sends = after.wsSends - before.wsSends;
  const cpuUs = after.cpuUser + after.cpuSystem - before.cpuUser - before.cpuSystem;
  return { clients: clientsN, sends, cpuUsPerMessage: cpuUs / sends };
}

async function main() {
  console.log("Calibrating on", os.cpus()[0]?.model, `(${os.cpus().length} cores), node`, process.version);
  const fits = [];
  for (const kind of ["ws", "sse", "longpoll"]) {
    const fit = await memoryPerConnection(kind, [500, 1000, 2000]);
    console.log(`memory ${kind}: ${fmt(fit.rssKBPerConn, 2)} KB RSS per connection (heap+external ${fmt(fit.heapKBPerConn, 2)} KB)`);
    fits.push(fit);
  }
  // CPU per request falls as load rises (wakeups amortize over more requests, and a busy
  // process moves to faster cores), so fit fixed overhead + marginal cost over three rates.
  const cpuPoints = [];
  for (const r of [1000, 2500, 4000]) {
    const m = await cpuPerRequest(r, 4);
    cpuPoints.push(m);
    console.log(`cpu: ${fmt(m.cpuFraction * 100)}% of a core at ${r} req/s (${fmt(m.cpuUsPerRequest)} µs per request)`);
  }
  const cpuLine = line(cpuPoints.map((m) => [m.reqPerSec, m.cpuFraction]));
  const wsFit = await cpuPerWsMessage(1000, 50);
  console.log(`cpu: ${fmt(wsFit.cpuUsPerMessage, 2)} µs per WebSocket message (${wsFit.sends} sends)`);

  const memory = Object.fromEntries(fits.map((f) => [f.kind, round(f.rssKBPerConn)]));
  const params = {
    measuredOn: `${os.cpus()[0]?.model} (${os.cpus().length} cores), ${os.platform()} ${os.release()}`,
    node: process.version,
    measuredAt: new Date().toISOString().slice(0, 10),
    baselineRssMB: round(fits[0]!.baseRssMB),
    memoryPerConnectionKB: memory,
    /** Marginal CPU per short-poll request. */
    cpuPerRequestUs: round(cpuLine.b * 1e6),
    /** Fixed share of a core spent once a server is handling steady traffic. */
    cpuBusyBaseFraction: round(Math.max(0, cpuLine.a), 4),
    cpuPerWsMessageUs: round(wsFit.cpuUsPerMessage),
  };

  // ---- held-out validation: different scales than the fit
  const validations: { what: string; measured: number; predicted: number; unit: string }[] = [];
  for (const [kind, n] of [["ws", 3000], ["sse", 3000], ["longpoll", 3000]] as const) {
    const measured = await memoryAt(kind, n);
    validations.push({ what: `${kind} memory, ${n} connections`, measured: measured / 1024, predicted: (memory[kind]! * n) / 1024, unit: "MB" });
  }
  for (const r of [1500, 3000]) {
    const v = await cpuPerRequest(r, 4);
    validations.push({ what: `short polling CPU at ${r.toLocaleString("en-US")} req/s`, measured: v.cpuFraction * 100, predicted: (params.cpuBusyBaseFraction + (r * params.cpuPerRequestUs) / 1e6) * 100, unit: "% of a core" });
  }
  const wsVal = await cpuPerWsMessage(2000, 20);
  validations.push({ what: "WebSocket push CPU, 2,000 clients × 20 messages", measured: (wsVal.cpuUsPerMessage * wsVal.sends) / 1000, predicted: (params.cpuPerWsMessageUs * wsVal.sends) / 1000, unit: "ms CPU" });

  const rows = validations.map((v) => ({ ...v, error: (v.predicted - v.measured) / v.measured }));
  const pass = rows.every((r) => Math.abs(r.error) <= 0.25);
  writeFileSync(paramsOut, JSON.stringify({ ...params, validation: rows.map((r) => ({ what: r.what, unit: r.unit, measured: round(r.measured), predicted: round(r.predicted), error: round(r.error, 3) })), pass }, null, 2) + "\n");

  const report = `# Calibration report

Measured on **${params.measuredOn}**, Node ${params.node}, ${params.measuredAt}.
Regenerate with \`pnpm --filter @vibesim/calibration calibrate\`; it rewrites \`packages/sim/src/params.json\` and this file.

The server (\`server.mjs\`) and the load generator (\`client.mjs\`) run as separate processes, so client memory never counts against the server. Memory is resident set size (RSS) after two forced garbage collections.

## Fitted parameters

| Parameter | Value | How |
|---|---|---|
| Memory per idle WebSocket | ${fmt(memory.ws!, 2)} KB | slope over 500 / 1,000 / 2,000 connections |
| Memory per open SSE stream | ${fmt(memory.sse!, 2)} KB | same |
| Memory per pending long-poll request | ${fmt(memory.longpoll!, 2)} KB | same |
| CPU per short-poll request (marginal) | ${fmt(params.cpuPerRequestUs)} µs | line fit over 1,000 / 2,500 / 4,000 req/s, 4 s each, keep-alive |
| Fixed CPU while serving traffic | ${fmt(params.cpuBusyBaseFraction * 100)}% of a core | intercept of the same fit |
| CPU per WebSocket message sent | ${fmt(params.cpuPerWsMessageUs, 2)} µs | 1,000 clients × 50 broadcasts |
| Idle server RSS | ${fmt(params.baselineRssMB)} MB | after startup |

### CPU fit points

| Rate | CPU | Per request |
|---|---|---|
${cpuPoints.map((m) => `| ${m.reqPerSec.toLocaleString("en-US")} req/s | ${fmt(m.cpuFraction * 100)}% of a core | ${fmt(m.cpuUsPerRequest)} µs |`).join("\n")}

Per-request cost falls as load rises: event-loop wakeups amortize over more requests, and macOS moves a busier process from the M-series efficiency cores to the faster performance cores. A fixed-plus-marginal line captures that over this range.

### Memory fit points

| Style | Connections | RSS delta | Heap + external delta |
|---|---|---|---|
${fits.flatMap((f) => f.points.map((p) => `| ${f.kind} | ${p.n.toLocaleString("en-US")} | ${fmt(p.rssKB / 1024, 1)} MB | ${fmt(p.heapKB / 1024, 1)} MB |`)).join("\n")}

## Held-out validation (gate: within ±25%)

| Check | Measured | Simulator predicts | Error |
|---|---|---|---|
${rows.map((r) => `| ${r.what} | ${fmt(r.measured, 2)} ${r.unit} | ${fmt(r.predicted, 2)} ${r.unit} | ${r.error >= 0 ? "+" : ""}${fmt(r.error * 100, 1)}% |`).join("\n")}

**Result: ${pass ? "PASS" : "FAIL"}.**

## What this does not cover

These numbers are for one small Node process on this machine. Real deployments add TLS (more memory and CPU per connection), larger messages, proxies and other hardware. The Learn pages say so next to every simulated number.
`;
  writeFileSync(reportOut, report);
  console.log(report.split("## Held-out")[1]);
  process.exitCode = pass ? 0 : 1;
}

function round(n: number, d = 2) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
}).finally(() => {
  for (const c of children) c.kill();
});
