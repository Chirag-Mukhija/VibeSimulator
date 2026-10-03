// Load generator, run as its own process so its memory never mixes with the server's.
// Usage:
//   node client.mjs hold <ws|sse|longpoll> <count> <port>   open and hold connections
//   node client.mjs rate <reqPerSec> <seconds> <port>        short-poll at a fixed rate
import http from "node:http";
import WebSocket from "ws";

const [mode, a, b, portArg] = process.argv.slice(2);
const port = Number(portArg);
const report = (msg) => process.send?.(msg);

if (mode === "hold") {
  const kind = a;
  const count = Number(b);
  const held = [];
  const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
  let open = 0;
  const openOne = () =>
    new Promise((resolve, reject) => {
      if (kind === "ws") {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false });
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
        ws.on("message", () => {});
        held.push(ws);
      } else {
        const req = http.get({ host: "127.0.0.1", port, path: kind === "sse" ? "/sse" : "/longpoll", agent: new http.Agent({ keepAlive: false }) }, (res) => {
          res.on("data", () => {});
          if (kind === "sse") resolve(res);
        });
        req.on("error", reject);
        if (kind === "longpoll") req.on("socket", (s) => s.on("connect", () => resolve(req)));
        held.push(req);
      }
    });
  // Open in batches below the OS listen backlog (macOS caps it at 128), retrying resets.
  const withRetry = async (tries = 5) => {
    for (let t = 0; ; t++) {
      try {
        return await openOne();
      } catch (e) {
        if (t >= tries) throw e;
        await new Promise((r) => setTimeout(r, 50 * (t + 1)));
      }
    }
  };
  for (let i = 0; i < count; i += 100) {
    const batch = [];
    for (let j = i; j < Math.min(count, i + 100); j++) batch.push(withRetry().then(() => open++));
    await Promise.all(batch);
  }
  void agent;
  report({ ready: open });
  process.on("message", (m) => {
    if (m === "close") setTimeout(() => process.exit(0), 800); // the server has already closed the sockets
  });
} else if (mode === "rate") {
  const rate = Number(a);
  const seconds = Number(b);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  let done = 0;
  let errors = 0;
  const tickMs = 10;
  const perTick = rate * (tickMs / 1000);
  let carry = 0;
  const started = Date.now();
  const timer = setInterval(() => {
    carry += perTick;
    while (carry >= 1) {
      carry--;
      http.get({ host: "127.0.0.1", port, path: "/poll", agent }, (res) => {
        res.resume();
        res.on("end", () => done++);
      }).on("error", () => errors++);
    }
    if (Date.now() - started >= seconds * 1000) {
      clearInterval(timer);
      setTimeout(() => {
        report({ done, errors, seconds: (Date.now() - started) / 1000 });
        process.exit(0);
      }, 500);
    }
  }, tickMs);
}
