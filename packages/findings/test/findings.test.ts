import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateTraceSpec, type TraceSpec } from "@vibesim/spec";
import { analyzeRepo } from "../../extractor/src/index.ts";
import { runFindings, RULES } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repos = path.resolve(here, "../../../fixtures/repos");

const summary = (spec: TraceSpec) =>
  spec.findings.map((f) => `${f.rule} @ ${f.evidence[0]!.file}:${f.evidence[0]!.line}`).sort();

/** Reviewed by hand against each repo's code: every entry is a real issue. */
const EXPECTED: Record<string, string[]> = {
  paytmentgateway: [
    "check-then-insert @ src/services/paymentService.js:21",
    "db-per-request-middleware @ src/middleware/auth.js:15",
    "unbounded-query @ src/services/paymentService.js:67",
  ],
  instabackend: [
    "bulk-insert-params @ src/services/feed.service.js:18",
    "check-then-insert @ src/services/user.service.js:43",
    "redis-check-then-act @ src/services/token.service.js:30",
    "redundant-index @ src/db/migrations/001_create_users_table.sql:12",
    "redundant-index @ src/db/migrations/001_create_users_table.sql:13",
    "sort-without-index @ src/services/post.service.js:59",
    "threadpool-saturation @ src/utils/password.js:6",
    "threadpool-saturation @ src/utils/password.js:8",
    "unbounded-query @ src/services/follow.service.js:105",
  ],
  "job-scheduler": [
    "db-call-in-loop @ api/services/queueService.js:56",
    "dual-write @ api/services/redisQueue.js:12",
    "full-table-aggregate @ api/routes/stats.js:10",
    "polling-via-timer @ api/public/dashboard.html:146",
    "push-triggers-fetch @ api/public/dashboard.html:140",
    "redundant-index @ api/db/migrations/001_create_jobs_table.sql:14",
    "sort-without-index @ api/services/queueService.js:32",
    "worker-idle-polling @ worker/index.js:29",
  ],
  "next-prisma-app": [
    "db-call-in-loop @ lib/posts.ts:10",
    "external-call-in-request-path @ app/api/summarize/route.ts:11",
    "external-call-in-request-path @ app/api/summarize/route.ts:7",
    "polling-via-timer @ components/Feed.tsx:11",
  ],
  "express-ts-mongo": [
    "connection-per-request @ src/services/mailer.ts:6",
    "cpu-blocking-event-loop @ src/routes/auth.ts:13",
    "external-call-in-request-path @ src/services/shipping.ts:11",
    "external-call-in-request-path @ src/services/shipping.ts:6",
    "in-memory-state @ src/routes/auth.ts:9",
    "unbounded-query @ src/services/OrderService.ts:16",
    "websocket-no-backplane @ src/services/OrderService.ts:11",
  ],
  "next-drizzle-app": ["unbounded-query @ app/api/users/route.ts:4"],
};

describe("findings on fixture repos", () => {
  it.each(Object.keys(EXPECTED))("%s", (name) => {
    const spec = analyzeRepo(path.join(repos, name), { now: new Date(0) });
    expect(summary(spec)).toEqual(EXPECTED[name]!.sort());
  }, 30_000);

  it("explains every finding and points at real evidence", () => {
    for (const name of Object.keys(EXPECTED)) {
      const spec = analyzeRepo(path.join(repos, name), { now: new Date(0) });
      for (const f of spec.findings) {
        expect(f.consequence.length, f.id).toBeGreaterThan(40);
        expect(f.fix, f.id).toBeTruthy();
        expect(f.concept, f.id).toMatch(/^[a-z-]+$/);
      }
    }
  }, 60_000);

  it("flags the hand-written connection-per-request fixture", () => {
    const json = JSON.parse(readFileSync(path.resolve(here, "../../spec/fixtures/notifications-polling.trace.json"), "utf8"));
    const result = validateTraceSpec(json);
    if (!result.ok) throw new Error(result.issues.join("\n"));
    expect(runFindings(result.spec).map((f) => f.rule)).toContain("connection-per-request");
  });

  it("has a description for every rule", () => {
    for (const r of RULES) expect(r.description.length).toBeGreaterThan(10);
  });
});

/** Writes a throwaway repo and analyzes it. */
function mini(files: Record<string, string>): TraceSpec {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibesim-mini-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return analyzeRepo(dir, { now: new Date(0) });
}

const rules = (spec: TraceSpec) => spec.findings.map((f) => f.rule);
const PKG = JSON.stringify({ dependencies: { express: "4", pg: "8" } });

describe("rules on synthetic repos", () => {
  it("connection-per-request: fires for new Client() per call, not for a shared Pool", () => {
    const bad = mini({
      "package.json": PKG,
      "app.js": `const express = require('express'); const { Client } = require('pg');
const app = express();
app.get('/x', async (req, res) => { const c = new Client(); await c.connect(); const r = await c.query('SELECT 1'); await c.end(); res.json(r.rows); });`,
    });
    expect(rules(bad)).toContain("connection-per-request");
    const good = mini({
      "package.json": PKG,
      "app.js": `const express = require('express'); const { Pool } = require('pg'); const pool = new Pool();
const app = express();
app.get('/x', async (req, res) => { const r = await pool.query('SELECT 1'); res.json(r.rows); });`,
    });
    expect(rules(good)).not.toContain("connection-per-request");
  });

  it("missing-index: uses the repo's schema", () => {
    const files = (indexed: boolean) => ({
      "package.json": PKG,
      "schema.sql": `CREATE TABLE orders (id SERIAL PRIMARY KEY, customer_email TEXT, total INT);${indexed ? "\nCREATE INDEX idx_orders_email ON orders (customer_email);" : ""}`,
      "app.js": `const express = require('express'); const { Pool } = require('pg'); const pool = new Pool();
const app = express();
app.get('/orders', async (req, res) => { const r = await pool.query('SELECT * FROM orders WHERE customer_email = $1 LIMIT 20', [req.query.email]); res.json(r.rows); });
app.get('/orders/:id', async (req, res) => { const r = await pool.query('SELECT * FROM orders WHERE id = $1', [req.params.id]); res.json(r.rows[0]); });`,
    });
    const bad = mini(files(false));
    expect(bad.findings.filter((f) => f.rule === "missing-index").map((f) => f.data.columns)).toEqual([["customer_email"]]);
    expect(rules(bad)).not.toContain("unbounded-query"); // the id lookup is a primary-key lookup
    expect(rules(mini(files(true)))).not.toContain("missing-index");
  });

  it("rate-limit-in-memory: fires without a store, not with a Redis store", () => {
    const base = (store: string) => ({
      "package.json": JSON.stringify({ dependencies: { express: "4", "express-rate-limit": "7", ioredis: "5", "rate-limit-redis": "4" } }),
      "app.js": `const express = require('express'); const rateLimit = require('express-rate-limit');
const Redis = require('ioredis'); const { RedisStore } = require('rate-limit-redis'); const redis = new Redis();
const limiter = rateLimit({ windowMs: 60000, limit: 10${store} });
const app = express(); app.use(limiter); app.get('/', (req, res) => res.send('ok'));`,
    });
    expect(rules(mini(base("")))).toContain("rate-limit-in-memory");
    expect(rules(mini(base(", store: new RedisStore({ sendCommand: (...a) => redis.call(...a) })")))).not.toContain("rate-limit-in-memory");
  });

  it("no-timeout: background calls without a timeout; request-path calls fold into external-call", () => {
    const spec = mini({
      "package.json": PKG,
      "worker.js": `async function sync() { await fetch('https://api.partner.example/feed'); }
setInterval(sync, 60000);`,
    });
    expect(rules(spec)).toContain("no-timeout");
    const withTimeout = mini({
      "package.json": PKG,
      "worker.js": `async function sync() { await fetch('https://api.partner.example/feed', { signal: AbortSignal.timeout(5000) }); }
setInterval(sync, 60000);`,
    });
    expect(rules(withTimeout)).not.toContain("no-timeout");
  });

  it("in-memory-state: ignores a lazily cached client", () => {
    const spec = mini({
      "package.json": JSON.stringify({ dependencies: { express: "4", redis: "4" } }),
      "app.js": `const express = require('express'); const { createClient } = require('redis');
let client = null;
const hits = new Map();
async function getClient() { if (!client) { client = createClient(); await client.connect(); } return client; }
const app = express();
app.get('/a', async (req, res) => { const c = await getClient(); await c.incr('a'); res.send('ok'); });
app.get('/b', async (req, res) => { hits.set(req.ip, (hits.get(req.ip) ?? 0) + 1); const c = await getClient(); await c.get('b'); res.send('ok'); });`,
    });
    const state = spec.findings.filter((f) => f.rule === "in-memory-state");
    expect(state).toHaveLength(1);
    expect(state[0]!.data.names).toEqual(["hits"]);
  });

  it("check-then-insert: fires for SELECT-then-INSERT on a unique key, not with ON CONFLICT", () => {
    const files = (insert: string) => ({
      "package.json": PKG,
      "schema.sql": "CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT UNIQUE);",
      "app.js": `const express = require('express'); const { Pool } = require('pg'); const pool = new Pool();
const app = express();
app.post('/users', async (req, res) => {
  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [req.body.email]);
  if (existing.rows.length) return res.status(409).json({ error: 'taken' });
  const r = await pool.query('${insert}', [req.body.email]);
  res.status(201).json(r.rows[0]);
});`,
    });
    expect(rules(mini(files("INSERT INTO users (email) VALUES ($1) RETURNING *")))).toContain("check-then-insert");
    expect(rules(mini(files("INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO NOTHING RETURNING *")))).not.toContain("check-then-insert");
  });

  it("redis-check-then-act: EXISTS then DEL on the same key, not a single DEL", () => {
    const files = (body: string) => ({
      "package.json": JSON.stringify({ dependencies: { express: "4", ioredis: "5" } }),
      "app.js": `const express = require('express'); const Redis = require('ioredis'); const redis = new Redis();
const app = express();
app.post('/redeem', async (req, res) => { ${body} res.send('ok'); });`,
    });
    expect(rules(mini(files("if (!(await redis.exists(`code:${req.body.code}`))) return res.sendStatus(401); await redis.del(`code:${req.body.code}`);")))).toContain("redis-check-then-act");
    expect(rules(mini(files("if ((await redis.del(`code:${req.body.code}`)) !== 1) return res.sendStatus(401);")))).not.toContain("redis-check-then-act");
  });

  it("websocket-no-backplane: quiet when socket.io has an adapter", () => {
    const files = (adapter: string) => ({
      "package.json": JSON.stringify({ dependencies: { express: "4", "socket.io": "4" } }),
      "app.js": `const http = require('http'); const express = require('express'); const { Server } = require('socket.io');
const app = express(); const server = http.createServer(app); const io = new Server(server);${adapter}
app.post('/notify', (req, res) => { io.emit('ping', {}); res.send('ok'); });`,
    });
    expect(rules(mini(files("")))).toContain("websocket-no-backplane");
    expect(rules(mini(files("\nio.adapter(createAdapter(pub, sub));")))).not.toContain("websocket-no-backplane");
  });
});
