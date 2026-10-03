// A minimal realtime server with every delivery style the Learn pages compare.
// Run with --expose-gc so /__stats can measure memory after a collection.
import http from "node:http";
import { WebSocketServer } from "ws";

const port = Number(process.argv[2] ?? 4600);
const sseClients = new Set();
const longPollers = new Set();
let wsSends = 0;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/poll") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"events":[]}');
  } else if (url.pathname === "/longpoll") {
    longPollers.add(res);
    const t = setTimeout(() => {
      longPollers.delete(res);
      res.writeHead(204).end();
    }, 120_000);
    res.on("close", () => {
      clearTimeout(t);
      longPollers.delete(res);
    });
  } else if (url.pathname === "/sse") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(": connected\n\n");
    sseClients.add(res);
    res.on("close", () => sseClients.delete(res));
  } else if (url.pathname === "/emit") {
    const n = Number(url.searchParams.get("n") ?? 1);
    const payload = JSON.stringify({ type: "job:completed", jobId: 123, at: new Date().toISOString() });
    for (let i = 0; i < n; i++) {
      for (const ws of wss.clients) {
        ws.send(payload);
        wsSends++;
      }
      for (const s of sseClients) s.write(`data: ${payload}\n\n`);
    }
    res.end("ok");
  } else if (url.pathname === "/__close") {
    // The server closes first, so the load generator's ports never sit in TIME_WAIT.
    for (const ws of wss.clients) ws.terminate();
    for (const s of sseClients) s.destroy();
    for (const r of longPollers) r.destroy();
    res.end("closed");
  } else if (url.pathname === "/__stats") {
    if (url.searchParams.get("gc") && global.gc) {
      global.gc();
      global.gc();
    }
    const m = process.memoryUsage();
    const cpu = process.cpuUsage();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      rss: m.rss, heapUsed: m.heapUsed, external: m.external, arrayBuffers: m.arrayBuffers,
      cpuUser: cpu.user, cpuSystem: cpu.system, ws: wss.clients.size, sse: sseClients.size, longPoll: longPollers.size, wsSends,
    }));
  } else {
    res.writeHead(404).end();
  }
});
const wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: false });
server.keepAliveTimeout = 120_000;
server.listen(port, "127.0.0.1", () => process.send?.("listening"));
