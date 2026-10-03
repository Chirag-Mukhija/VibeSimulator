import { Node, type CallExpression, type NewExpression } from "ts-morph";
import type { Handle, HandleType, LibraryHooks, Resolver, Value } from "./values.ts";
import { isFunctionLike, pick, UNKNOWN } from "./values.ts";
import { summarizeSql } from "./sql.ts";

type Protocol = "in-process" | "http" | "ws" | "sse" | "sql" | "mongodb" | "redis" | "amqp" | "smtp" | "unknown";
type Lifecycle = "none" | "new-per-request" | "pooled" | "persistent" | "unknown";

/** Where an I/O operation lands. Resolved to a node by the graph builder. */
export type Target =
  | { type: "resource"; handle: Handle }
  | { type: "topic"; channel: string; broker: string }
  | { type: "queue"; name: string; broker: string }
  | { type: "external"; service: string; host?: string }
  | { type: "compute"; name: string; pool: "libuv-threadpool" | "event-loop" }
  | { type: "ws"; server?: Handle; url?: string }
  | { type: "sse"; url: string }
  | { type: "url"; method: string; url: string; template: boolean };

export interface Op {
  target: Target;
  protocol: Protocol;
  lifecycle: Lifecycle;
  mode: "sync" | "async";
  label: string;
  /** connect: opens a channel to the target; push: server sends over an open channel. */
  role?: "connect" | "push";
  props: Record<string, unknown>;
}

// ------------------------------------------------------------------ creators

interface Creator {
  pkg: string;
  path: string;
  type: HandleType;
  /** undefined: either call or `new`. */
  isNew?: boolean;
  data?: (r: Resolver, call: CallExpression | NewExpression) => Record<string, unknown>;
}

const MIDDLEWARE_PACKAGES: Record<string, string> = {
  helmet: "helmet",
  cors: "cors",
  morgan: "morgan",
  "cookie-parser": "cookie-parser",
  compression: "compression",
  "express-session": "express-session",
  "express-rate-limit": "express-rate-limit",
  hpp: "hpp",
  "express-mongo-sanitize": "express-mongo-sanitize",
  "xss-clean": "xss-clean",
  "connect-timeout": "connect-timeout",
};

const SDKS: Record<string, { paths: string[]; service: string; host: string; protocol?: Protocol }> = {
  stripe: { paths: ["", "Stripe"], service: "Stripe API", host: "api.stripe.com" },
  openai: { paths: ["", "OpenAI"], service: "OpenAI API", host: "api.openai.com" },
  "@anthropic-ai/sdk": { paths: ["", "Anthropic"], service: "Anthropic API", host: "api.anthropic.com" },
  "@google/generative-ai": { paths: ["GoogleGenerativeAI"], service: "Gemini API", host: "generativelanguage.googleapis.com" },
  resend: { paths: ["Resend"], service: "Resend API", host: "api.resend.com" },
  twilio: { paths: [""], service: "Twilio API", host: "api.twilio.com" },
  nodemailer: { paths: ["createTransport"], service: "SMTP server", host: "smtp", protocol: "smtp" },
};

const CREATORS: Creator[] = [
  { pkg: "express", path: "", type: "express-app", isNew: false },
  { pkg: "express", path: "Router", type: "express-router" },
  ...["json", "urlencoded", "static", "raw", "text"].map((p) => ({
    pkg: "express", path: p, type: "express-middleware" as const, data: () => ({ name: `express.${p}` }),
  })),
  ...["json", "urlencoded"].map((p) => ({
    pkg: "body-parser", path: p, type: "express-middleware" as const, data: () => ({ name: `body-parser.${p}` }),
  })),
  ...Object.entries(MIDDLEWARE_PACKAGES).flatMap(([pkg, name]) =>
    ["", "rateLimit", "default"].map((p) => ({ pkg, path: p, type: "express-middleware" as const, data: () => ({ name }) })),
  ),
  { pkg: "http", path: "createServer", type: "http-server" },
  { pkg: "https", path: "createServer", type: "http-server" },
  {
    pkg: "pg", path: "Pool", type: "pg-pool", isNew: true,
    data: (r, call) => ({ poolMax: numberOption(r, call, "max") ?? 10, poolMaxDefault: numberOption(r, call, "max") === undefined }),
  },
  { pkg: "pg", path: "Client", type: "pg-client", isNew: true, data: (_r, call) => ({ perRequest: insideFunction(call) }) },
  { pkg: "mysql2", path: "createPool", type: "mysql", data: () => ({ pooled: true }) },
  { pkg: "mysql2", path: "createConnection", type: "mysql", data: (_r, call) => ({ pooled: false, perRequest: insideFunction(call) }) },
  { pkg: "redis", path: "createClient", type: "redis-client" },
  { pkg: "ioredis", path: "", type: "redis-client", isNew: true },
  { pkg: "ioredis", path: "Redis", type: "redis-client", isNew: true },
  { pkg: "ioredis", path: "Cluster", type: "redis-client", isNew: true },
  { pkg: "ws", path: "WebSocketServer", type: "ws-server", isNew: true, data: (r, call) => ({ path: stringOption(r, call, "path") ?? "/" }) },
  { pkg: "ws", path: "Server", type: "ws-server", isNew: true, data: (r, call) => ({ path: stringOption(r, call, "path") ?? "/" }) },
  { pkg: "socket.io", path: "Server", type: "sio-server" },
  { pkg: "socket.io", path: "", type: "sio-server" },
  { pkg: "@aws-sdk/client-s3", path: "S3Client", type: "s3-client", isNew: true },
  { pkg: "@prisma/client", path: "PrismaClient", type: "prisma", isNew: true },
  { pkg: "mongoose", path: "model", type: "mongoose-model", data: (r, call) => ({ model: stringArg(r, call, 0) }) },
  { pkg: "bullmq", path: "Queue", type: "bull-queue", isNew: true, data: (r, call) => ({ name: stringArg(r, call, 0) ?? "queue" }) },
  { pkg: "bull", path: "", type: "bull-queue", data: (r, call) => ({ name: stringArg(r, call, 0) ?? "queue" }) },
  { pkg: "axios", path: "create", type: "http-client", data: (r, call) => ({ baseURL: stringOption(r, call, "baseURL") ?? "" }) },
  { pkg: "@supabase/supabase-js", path: "createClient", type: "supabase" },
  ...Object.entries(SDKS).flatMap(([pkg, s]) =>
    s.paths.map((p) => ({ pkg, path: p, type: "sdk-client" as const, data: () => ({ service: s.service, host: s.host, protocol: s.protocol ?? "http" }) })),
  ),
];

/** express.json etc. look like members of the app factory, so match on exact path. */
function findCreator(callee: Value, isNew: boolean): Creator | undefined {
  if (callee.kind !== "external") return undefined;
  const p = callee.path.join(".");
  return CREATORS.find((c) => c.pkg === callee.pkg && c.path === p && (c.isNew === undefined || c.isNew === isNew));
}

// --------------------------------------------------------------------- hooks

export const hooks: LibraryHooks = {
  create(r, call, callee, isNew) {
    if (callee.kind === "global" && isNew) {
      const name = callee.path.join(".");
      if (name === "WebSocket") {
        return r.handle(key(call), () => mk("browser-ws", "browser", call, { url: urlArg(r, call) }));
      }
      if (name === "EventSource") {
        return r.handle(key(call), () => mk("event-source", "browser", call, { url: urlArg(r, call) }));
      }
      return undefined;
    }
    const creator = findCreator(callee, isNew);
    if (!creator) return undefined;
    return r.handle(key(call), () => mk(creator.type, (callee as { pkg: string }).pkg, call, creator.data?.(r, call) ?? {}));
  },

  callMember(r, handle, path, call) {
    const method = path[path.length - 1];
    // io.to(room).emit(...): broadcast operators return the same server.
    if ((handle.type === "sio-server" || handle.type === "sio-socket") && ["to", "in", "of", "except", "volatile", "compress", "timeout", "broadcast"].includes(method ?? "")) {
      return { kind: "handle", handle };
    }
    if (handle.type === "pg-pool" && method === "connect") {
      return { kind: "handle", handle: r.handle(key(call), () => mk("pg-pooled-client", handle.lib, call, {}, handle.root)) };
    }
    if (handle.type === "redis-client" && (method === "duplicate" || method === "connect" || method === "multi" || method === "pipeline")) {
      if (method === "connect" || path.length !== 1) return { kind: "handle", handle };
      return { kind: "handle", handle: r.handle(key(call), () => mk("redis-client", handle.lib, call, { duplicateOf: handle }, handle.root)) };
    }
    return undefined;
  },

  member(r, handle, path) {
    if (handle.type === "ws-server" && path[0] === "clients" && path[1] === "[element]") {
      return { kind: "handle", handle: socketOf(r, handle) };
    }
    return undefined;
  },

  callbackParam(r, call, callee, _fnIndex, paramIndex) {
    if (callee.kind !== "member") return undefined;
    const method = callee.path[callee.path.length - 1];
    const event = stringArg(r, call, 0);
    const h = callee.handle;
    if ((h.type === "ws-server" || h.type === "sio-server") && method === "on" && event === "connection" && paramIndex === 0) {
      return { kind: "handle", handle: socketOf(r, h) };
    }
    const isExpress = h.type === "express-app" || h.type === "express-router";
    if (isExpress && (HTTP_METHODS.has(method ?? "") || method === "use")) {
      if (paramIndex === 0) return { kind: "handle", handle: r.handle("express-req", () => mk("express-req", "express", call, {})) };
      if (paramIndex === 1) return { kind: "handle", handle: r.handle("express-res", () => mk("express-res", "express", call, {})) };
    }
    return undefined;
  },
};

export const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "options", "head"]);

function socketOf(r: Resolver, server: Handle): Handle {
  const type: HandleType = server.type === "sio-server" ? "sio-socket" : "ws-socket";
  return r.handle(`${key(server.created)}#socket`, () => mk(type, server.lib, server.created, { server }, server));
}

function mk(type: HandleType, lib: string, created: Node, data: Record<string, unknown>, root?: Handle): Handle {
  const h: Handle = { type, lib, created, data, root: undefined as unknown as Handle };
  h.root = root ?? h;
  return h;
}

function key(node: Node): string {
  return `${node.getSourceFile().getFilePath()}:${node.getStart()}`;
}

// ----------------------------------------------------------------------- ops

const COMPUTE: Record<string, Record<string, "libuv-threadpool" | "event-loop">> = {
  bcrypt: { hash: "libuv-threadpool", compare: "libuv-threadpool", genSalt: "libuv-threadpool", hashSync: "event-loop", compareSync: "event-loop", genSaltSync: "event-loop" },
  bcryptjs: { hash: "event-loop", compare: "event-loop", hashSync: "event-loop", compareSync: "event-loop" },
  argon2: { hash: "libuv-threadpool", verify: "libuv-threadpool" },
  crypto: { pbkdf2: "libuv-threadpool", scrypt: "libuv-threadpool", pbkdf2Sync: "event-loop", scryptSync: "event-loop" },
  zlib: { gzip: "libuv-threadpool", deflate: "libuv-threadpool", brotliCompress: "libuv-threadpool", gzipSync: "event-loop", deflateSync: "event-loop", brotliCompressSync: "event-loop" },
  sharp: { "": "libuv-threadpool" },
};

const REDIS_NON_OPS = new Set([
  "subscribe", "pSubscribe", "psubscribe", "unsubscribe", "punsubscribe", "on", "once", "off", "connect", "disconnect", "quit",
  "duplicate", "multi", "pipeline", "removeListener", "addListener", "isOpen", "isReady",
]);
const SUPABASE_DB_METHODS = ["select", "insert", "update", "upsert", "delete"];

/** Classifies a call as an I/O or compute operation, or returns undefined. */
export function classifyOp(r: Resolver, call: CallExpression | NewExpression, labelArgs?: Node[]): Op | undefined {
  const callee = preferConcrete(r.value(call.getExpression()));
  const args = labelArgs ?? call.getArguments();

  if (Node.isNewExpression(call)) {
    const h = pick(r.value(call), "handle")?.handle;
    if (h?.type === "browser-ws") {
      const url = urlArg(r, call);
      return { target: { type: "ws", url }, protocol: "ws", lifecycle: "persistent", mode: "async", label: `open WebSocket ${url ?? ""}`.trim(), role: "connect", props: {} };
    }
    if (h?.type === "event-source") {
      const url = urlArg(r, call) ?? "";
      return { target: { type: "sse", url }, protocol: "sse", lifecycle: "persistent", mode: "async", label: `open EventSource ${url}`.trim(), role: "connect", props: {} };
    }
    return undefined;
  }

  if (callee.kind === "global") {
    const name = callee.path.join(".");
    if (name === "fetch" || name === "window.fetch") return urlOp(r, call, args, fetchMethod(r, args[1]));
    return undefined;
  }

  if (callee.kind === "external") {
    const fn = callee.path.join(".");
    if (callee.pkg === "@aws-sdk/s3-request-presigner" && fn === "getSignedUrl") {
      return {
        target: { type: "external", service: "AWS S3", host: "s3.amazonaws.com" }, protocol: "in-process", lifecycle: "none", mode: "sync",
        label: "sign an upload URL locally (no network call)", props: { presign: true },
      };
    }
    const pool = COMPUTE[callee.pkg]?.[fn];
    if (pool) {
      return {
        target: { type: "compute", name: callee.pkg, pool }, protocol: "in-process", lifecycle: "none", mode: pool === "event-loop" ? "sync" : "async",
        label: `${callee.pkg}${fn ? "." + fn : ""}`, props: { pool, cost: costArg(r, callee.pkg, fn, args) },
      };
    }
    if ((callee.pkg === "axios" || callee.pkg === "node-fetch" || callee.pkg === "undici" || callee.pkg === "got") && callee.path.length <= 1) {
      const m = callee.path[0];
      if (!m || m === "default" || m === "fetch" || m === "request") return urlOp(r, call, args, fetchMethod(r, args[1]));
      if (HTTP_METHODS.has(m)) return urlOp(r, call, args, m.toUpperCase());
    }
    if ((callee.pkg === "http" || callee.pkg === "https") && (fn === "request" || fn === "get")) {
      return urlOp(r, call, args, fn === "get" ? "GET" : "GET");
    }
    if (callee.pkg === "@sendgrid/mail" && fn === "send") {
      return { target: { type: "external", service: "SendGrid API", host: "api.sendgrid.com" }, protocol: "http", lifecycle: "pooled", mode: "sync", label: "send email", props: {} };
    }
    return undefined;
  }

  if (callee.kind !== "member") return undefined;
  const h = callee.handle;
  const path = callee.path;
  const method = path[path.length - 1]!;
  if (method === "then" || method === "catch" || method === "finally") return undefined;

  switch (h.type) {
    case "pg-pool":
      if (method === "query") return sqlOp(r, h, args, "pooled");
      if (method === "connect") return { ...dbOp(h, "pooled", "check out a dedicated connection"), props: { checkout: true } };
      return undefined;
    case "pg-pooled-client":
      if (method === "query") return sqlOp(r, h, args, "pooled");
      if (method === "release") return { ...dbOp(h, "pooled", "release the connection back to the pool"), props: { release: true } };
      return undefined;
    case "pg-client": {
      const lc: Lifecycle = h.data.perRequest ? "new-per-request" : "persistent";
      if (method === "query") return sqlOp(r, h, args, lc);
      if (method === "connect") return dbOp(h, lc, "open a new connection (TCP + auth handshake)");
      if (method === "end") return dbOp(h, lc, "close the connection");
      return undefined;
    }
    case "mysql": {
      const lc: Lifecycle = h.data.pooled ? "pooled" : h.data.perRequest ? "new-per-request" : "persistent";
      if (method === "query" || method === "execute") return sqlOp(r, h, args, lc);
      return undefined;
    }
    case "redis-client": {
      if (REDIS_NON_OPS.has(method) || path.length !== 1) return undefined;
      if (method === "publish") {
        const channel = stringValue(r.value(args[0])) ?? "channel";
        return { target: { type: "topic", channel, broker: "redis" }, protocol: "redis", lifecycle: "persistent", mode: "async", label: `PUBLISH ${channel}`, props: {} };
      }
      const keyHint = stringValue(r.value(args[0]));
      return {
        target: { type: "resource", handle: h.root }, protocol: "redis", lifecycle: "persistent", mode: "sync",
        label: `${method.toUpperCase()}${keyHint ? " " + keyHint : ""}`, props: { command: method },
      };
    }
    case "ws-socket":
    case "sio-socket":
      if (method === "send" || method === "emit") {
        return { target: { type: "ws", server: h.data.server as Handle }, protocol: "ws", lifecycle: "persistent", mode: "async", label: "push message to the socket", role: "push", props: {} };
      }
      return undefined;
    case "sio-server":
      if (method === "emit") {
        return { target: { type: "ws", server: h }, protocol: "ws", lifecycle: "persistent", mode: "async", label: "broadcast to every socket", role: "push", props: {} };
      }
      return undefined;
    case "s3-client":
      if (method === "send") {
        const cmd = args[0] && Node.isNewExpression(args[0]) ? args[0].getExpression().getText().replace(/Command$/, "") : "request";
        return { target: { type: "external", service: "AWS S3", host: "s3.amazonaws.com" }, protocol: "http", lifecycle: "pooled", mode: "sync", label: cmd, props: {} };
      }
      return undefined;
    case "prisma": {
      if (path.length === 2 && !path[0]!.startsWith("$")) return dbOp(h, "pooled", `${method} ${path[0]}`, "sql");
      if (path.length === 1 && path[0]!.startsWith("$") && /query|execute|transaction/i.test(path[0]!)) return dbOp(h, "pooled", path[0]!, "sql");
      return undefined;
    }
    case "mongoose-model":
      if (path.length === 1) return dbOp(h, "pooled", `${method} ${String(h.data.model ?? "")}`.trim(), "mongodb");
      return undefined;
    case "bull-queue":
      if (method === "add" || method === "addBulk") {
        const name = String(h.data.name ?? "queue");
        return { target: { type: "queue", name, broker: "redis" }, protocol: "redis", lifecycle: "persistent", mode: "async", label: `enqueue job on "${name}"`, props: {} };
      }
      return undefined;
    case "http-client":
      if (HTTP_METHODS.has(method) || method === "request") return urlOp(r, call, args, method === "request" ? "GET" : method.toUpperCase(), String(h.data.baseURL ?? ""));
      return undefined;
    case "sdk-client": {
      if (path.length === 0 || method === "on" || (h.data.service === "Stripe API" && path[0] === "webhooks")) return undefined;
      const protocol = (h.data.protocol as Protocol) ?? "http";
      return {
        target: { type: "external", service: String(h.data.service), host: String(h.data.host) }, protocol, lifecycle: "pooled", mode: "sync",
        label: path.join("."), props: {},
      };
    }
    case "supabase": {
      if (path.length === 1 && method === "from") {
        const table = stringArg(r, call, 0) ?? "table";
        const verb = chainMethods(call).find((m) => SUPABASE_DB_METHODS.includes(m)) ?? "query";
        return { target: { type: "external", service: "Supabase (Postgres over REST)", host: "supabase.co" }, protocol: "http", lifecycle: "pooled", mode: "sync", label: `${verb} ${table}`, props: { table } };
      }
      if (path.length === 1 && method === "rpc") {
        return { target: { type: "external", service: "Supabase (Postgres over REST)", host: "supabase.co" }, protocol: "http", lifecycle: "pooled", mode: "sync", label: `rpc ${stringArg(r, call, 0) ?? ""}`.trim(), props: {} };
      }
      if (path.length >= 2 && (path[0] === "auth" || path[0] === "storage")) {
        return { target: { type: "external", service: path[0] === "auth" ? "Supabase Auth" : "Supabase Storage", host: "supabase.co" }, protocol: "http", lifecycle: "pooled", mode: "sync", label: path.slice(1).join("."), props: {} };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** `globalThis.prisma ?? new PrismaClient()`: prefer the option that names a real client. */
function preferConcrete(v: Value): Value {
  if (v.kind !== "choice") return v;
  return v.options.find((o) => o.kind === "member") ?? v.options.find((o) => o.kind === "external") ?? v;
}

function dbOp(h: Handle, lifecycle: Lifecycle, label: string, protocol: Protocol = "sql"): Op {
  return { target: { type: "resource", handle: h.root }, protocol, lifecycle, mode: "sync", label, props: {} };
}

function sqlOp(r: Resolver, h: Handle, args: Node[], lifecycle: Lifecycle): Op {
  const text = stringValue(r.value(args[0]));
  const sql = text ? summarizeSql(text) : undefined;
  return {
    ...dbOp(h, lifecycle, sql?.label ?? "query"),
    props: sql ? { sql: sql.text, statement: sql.op, table: sql.table, hasLimit: sql.hasLimit, aggregate: sql.aggregate, singleRow: sql.singleRow } : {},
  };
}

function urlOp(r: Resolver, _call: Node, args: Node[], method: string, base = ""): Op {
  const v = r.value(args[0]);
  const s = pick(v, "string");
  const url = base + (s?.value ?? "{}");
  return {
    target: { type: "url", method, url, template: !s || s.template || !!base && false },
    protocol: "http", lifecycle: "pooled", mode: "sync", label: `${method} ${url}`,
    props: { timeout: hasTimeout(r, args) },
  };
}

function fetchMethod(r: Resolver, opts: Node | undefined): string {
  if (!opts) return "GET";
  const v = r.value(opts);
  if (v.kind !== "object") return "GET";
  const m = stringValue(r.member(v, "method"));
  return m ? m.toUpperCase() : "GET";
}

function hasTimeout(r: Resolver, args: Node[]): boolean {
  for (const a of args.slice(1)) {
    const v = r.value(a);
    if (v.kind === "object") {
      const text = v.node.getText();
      if (/\b(timeout|signal)\b/.test(text)) return true;
    }
  }
  return false;
}

/** bcrypt.hash(plain, rounds): the work factor, when it is a constant. */
function costArg(r: Resolver, pkg: string, fn: string, args: Node[]): number | undefined {
  if ((pkg === "bcrypt" || pkg === "bcryptjs") && fn.startsWith("hash") && args[1]) return numericValue(r, args[1]);
  return undefined;
}

export function stringValue(v: Value): string | undefined {
  const s = pick(v, "string");
  return s?.value;
}

function stringArg(r: Resolver, call: CallExpression | NewExpression, i: number): string | undefined {
  return stringValue(r.value(call.getArguments()[i]));
}

function urlArg(r: Resolver, call: CallExpression | NewExpression): string | undefined {
  return stringValue(r.value(call.getArguments()[0]));
}

function optionNode(r: Resolver, call: CallExpression | NewExpression, name: string): Node | undefined {
  const opts = call.getArguments()[0];
  if (!opts) return undefined;
  const v = r.value(opts);
  if (v.kind !== "object") return undefined;
  for (const p of (v.node as any).getProperties() as Node[]) {
    if (Node.isPropertyAssignment(p) && p.getName() === name) return p.getInitializer();
  }
  return undefined;
}

function numberOption(r: Resolver, call: CallExpression | NewExpression, name: string): number | undefined {
  const n = optionNode(r, call, name);
  return n ? numericValue(r, n) : undefined;
}

function stringOption(r: Resolver, call: CallExpression | NewExpression, name: string): string | undefined {
  const n = optionNode(r, call, name);
  return n ? stringValue(r.value(n)) : undefined;
}

export function numericValue(r: Resolver, node: Node): number | undefined {
  if (Node.isNumericLiteral(node)) return node.getLiteralValue();
  if (Node.isBinaryExpression(node)) {
    const l = numericValue(r, node.getLeft());
    const rr = numericValue(r, node.getRight());
    if (l === undefined || rr === undefined) return undefined;
    switch (node.getOperatorToken().getText()) {
      case "*": return l * rr;
      case "+": return l + rr;
      case "-": return l - rr;
      case "/": return rr === 0 ? undefined : l / rr;
    }
    return undefined;
  }
  if (Node.isIdentifier(node)) {
    const d = r.declarationOf(node);
    if (d && Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      return init ? numericValue(r, init) : undefined;
    }
  }
  if (Node.isParenthesizedExpression(node)) return numericValue(r, node.getExpression());
  return undefined;
}

function insideFunction(node: Node): boolean {
  return node.getAncestors().some((a) => isFunctionLike(a));
}

/** Method names called later in a fluent chain: supabase.from('t').select().eq() -> [select, eq]. */
function chainMethods(call: CallExpression | NewExpression): string[] {
  const out: string[] = [];
  let cur: Node = call;
  for (;;) {
    const parent = cur.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur) {
      out.push(parent.getName());
      const grand = parent.getParent();
      if (grand && Node.isCallExpression(grand) && grand.getExpression() === parent) {
        cur = grand;
        continue;
      }
    }
    break;
  }
  return out;
}
