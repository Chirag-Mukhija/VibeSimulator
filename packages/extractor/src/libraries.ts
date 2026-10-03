import { Node, type CallExpression, type NewExpression } from "ts-morph";
import type { Handle, HandleType, LibraryHooks, Resolver, Value } from "./values.ts";
import { isFunctionLike, pick, UNKNOWN } from "./values.ts";
import { summarizeSql } from "./sql.ts";
import { checkQuery } from "./sqlschema.ts";

type Protocol = "in-process" | "http" | "ws" | "sse" | "sql" | "mongodb" | "redis" | "amqp" | "smtp" | "unknown";
type Lifecycle = "none" | "new-per-request" | "pooled" | "held" | "keep-alive" | "persistent" | "unknown";

/** Where an I/O operation lands. Resolved to a node by the graph builder. */
export type Target =
  | { type: "resource"; handle: Handle }
  | { type: "topic"; channel: string; broker: string }
  | { type: "queue"; name: string; broker: string }
  | { type: "external"; service: string; host?: string }
  | { type: "compute"; name: string; pool: "libuv-threadpool" | "event-loop" }
  | { type: "ws"; server?: Handle; url?: string }
  | { type: "sse"; url: string }
  | { type: "url"; method: string; url: string; template: boolean; envBase?: string };

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
  "@octokit/rest": { paths: ["Octokit"], service: "GitHub API", host: "api.github.com" },
  lastfm: { paths: ["LastFmNode"], service: "Last.fm API", host: "ws.audioscrobbler.com" },
  "@huggingface/inference": { paths: ["HfInference", "InferenceClient"], service: "Hugging Face Inference API", host: "router.huggingface.co" },
  "@langchain/groq": { paths: ["ChatGroq"], service: "Groq API (through LangChain)", host: "api.groq.com" },
  "@langchain/openai": { paths: ["ChatOpenAI", "OpenAIEmbeddings"], service: "OpenAI API (through LangChain)", host: "api.openai.com" },
  "@lob/lob-typescript-sdk": { paths: ["LettersApi", "ZipLookupsApi"], service: "Lob API", host: "api.lob.com" },
  googleapis: { paths: ["google.drive", "google.sheets", "google.calendar", "google.gmail", "google.youtube"], service: "Google APIs (googleapis)", host: "www.googleapis.com" },
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
  { pkg: "mongoose", path: "model", type: "mongoose-model", data: (r, call) => ({ model: stringArg(r, call, 0), schema: call.getArguments()[1] }) },
  { pkg: "bullmq", path: "Queue", type: "bull-queue", isNew: true, data: (r, call) => ({ name: stringArg(r, call, 0) ?? "queue" }) },
  { pkg: "bull", path: "", type: "bull-queue", data: (r, call) => ({ name: stringArg(r, call, 0) ?? "queue" }) },
  { pkg: "axios", path: "create", type: "http-client", data: (r, call) => ({ baseURL: stringOption(r, call, "baseURL") ?? "", timeout: numberOption(r, call, "timeout") }) },
  { pkg: "@supabase/supabase-js", path: "createClient", type: "supabase" },
  { pkg: "drizzle-orm", path: "drizzle", type: "drizzle" },
  { pkg: "@supabase/ssr", path: "createServerClient", type: "supabase" },
  { pkg: "@supabase/ssr", path: "createBrowserClient", type: "supabase" },
  ...["createRouteHandlerClient", "createServerComponentClient", "createClientComponentClient", "createServerActionClient", "createMiddlewareClient"].map((p) => ({
    pkg: "@supabase/auth-helpers-nextjs", path: p, type: "supabase" as const,
  })),
  ...Object.entries(SDKS).flatMap(([pkg, s]) =>
    s.paths.map((p) => ({
      pkg, path: p, type: "sdk-client" as const,
      data: (r: Resolver, call: CallExpression | NewExpression) => ({ service: s.service, host: s.host, protocol: s.protocol ?? "http", pool: booleanOption(r, call, "pool") === true }),
    })),
  ),
  // The native MongoDB driver; `new MongoClient(uri)` inside a handler means a new connection pool per request.
  { pkg: "mongodb", path: "MongoClient", type: "mongo-client", isNew: true, data: (_r, call) => ({ perRequest: insideFunction(call) }) },
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
    // new Order({...}): an unsaved Mongoose document.
    if (isNew && callee.kind === "handle" && callee.handle.type === "mongoose-model") {
      return r.handle(key(call), () => mk("mongoose-doc", "mongoose", call, { model: callee.handle }, callee.handle.root));
    }
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
    if (creator.type === "drizzle") {
      // drizzle(pool): queries run on the client it was given.
      const client = pick(r.value(call.getArguments()[0]), "handle")?.handle;
      const spec = (callee as { spec?: string }).spec ?? "";
      const engine = /mysql/.test(spec) ? "mysql" : /sqlite|libsql|d1|expo/.test(spec) ? "sqlite" : "postgres";
      return r.handle(key(call), () => mk("drizzle", "drizzle-orm", call, { engine, client }, client?.root));
    }
    return r.handle(key(call), () => mk(creator.type, (callee as { pkg: string }).pkg, call, creator.data?.(r, call) ?? {}));
  },

  callMember(r, handle, path, call) {
    const method = path[path.length - 1];
    // Order.findById(id) -> a document (or query); .select()/.populate() keep it.
    if (handle.type === "mongoose-model" && path.length === 1 && MONGOOSE_QUERIES.has(method ?? "")) {
      return { kind: "handle", handle: r.handle(`${key(handle.created)}#doc`, () => mk("mongoose-doc", "mongoose", handle.created, { model: handle }, handle.root)) };
    }
    if (handle.type === "mongoose-doc" && path.length === 1 && MONGOOSE_CHAIN.has(method ?? "")) return { kind: "handle", handle };
    // Router().use(a).use(b), app.get(...).post(...): Express methods return the same app/router.
    if ((handle.type === "express-app" || handle.type === "express-router") && path.length === 1 && (method === "use" || HTTP_METHODS.has(method ?? ""))) {
      return { kind: "handle", handle };
    }
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
    // userSchema.methods.matchPassword / userSchema.statics.findByEmail: user code, not a query.
    if ((handle.type === "mongoose-doc" || handle.type === "mongoose-model") && path.length === 1) {
      const model = handle.type === "mongoose-doc" ? (handle.data.model as Handle) : handle;
      const fn = schemaFunction(r, model, handle.type === "mongoose-doc" ? "methods" : "statics", path[0]!);
      if (fn) return fn;
    }
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

const MONGOOSE_QUERIES = new Set([
  "find", "findOne", "findById", "create", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "findByIdAndDelete",
  "insertMany", "aggregate", "where",
]);
const MONGOOSE_CHAIN = new Set(["select", "populate", "lean", "sort", "limit", "skip", "exec", "where", "equals", "in", "gt", "lt"]);
const MONGOOSE_DOC_WRITES = new Set(["save", "deleteOne", "updateOne", "remove"]);

/** schema.methods.X = fn / schema.statics.X = fn for the schema a model was built from. */
function schemaFunction(r: Resolver, model: Handle, kind: "methods" | "statics", name: string): Value | undefined {
  const schemaNode = model.data.schema as Node | undefined;
  if (!schemaNode) return undefined;
  const schemaDecl = Node.isIdentifier(schemaNode) ? r.declarationOf(schemaNode) : undefined;
  if (!schemaDecl) return undefined;
  for (const file of r.repo.files) {
    let found: Value | undefined;
    file.forEachDescendant((n, t) => {
      if (found) return;
      if (!Node.isBinaryExpression(n) || n.getOperatorToken().getText() !== "=") return;
      const left = n.getLeft();
      if (!Node.isPropertyAccessExpression(left) || left.getName() !== name) return;
      const mid = left.getExpression();
      if (!Node.isPropertyAccessExpression(mid) || mid.getName() !== kind) return;
      const base = mid.getExpression();
      if (Node.isIdentifier(base) && r.declarationOf(base) === schemaDecl) {
        found = r.value(n.getRight());
        t.stop();
      }
    });
    if (found && found.kind === "function") return found;
  }
  return undefined;
}

/** A middleware produced by a package we have no model for, e.g. express-jwt's `jwt({...})`. */
export function libraryMiddleware(r: Resolver, call: Node, pkg: string, path: string[]): Handle {
  const name = [pkg, ...path.filter((p) => p !== "default")].join(".");
  return r.handle(key(call), () => mk("express-middleware", pkg, call, { name }));
}

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
      // No SQL is sent: the pool hands over an idle connection (or opens one, or waits for one).
      if (method === "connect") return { ...dbOp(h, "none", "borrow a connection from the pool and keep it", "in-process"), props: { checkout: true } };
      return undefined;
    case "pg-pooled-client":
      // Every statement goes over the one connection this code checked out (what makes a transaction work).
      if (method === "query") return sqlOp(r, h, args, "held");
      if (method === "release") return { ...dbOp(h, "none", "give the connection back to the pool", "in-process"), props: { release: true } };
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
      const keyHint = displayValue(r.value(args[0]));
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
      if (path.length === 2 && !path[0]!.startsWith("$")) {
        const op = dbOp(h, "pooled", `${method} ${path[0]}`, "sql");
        if (method === "findMany") op.props = { statement: "SELECT", unbounded: !objectHasProp(r, args[0], "take"), scoped: objectHasProp(r, args[0], "where") };
        return op;
      }
      if (path.length === 1 && path[0]!.startsWith("$") && /query|execute|transaction/i.test(path[0]!)) return dbOp(h, "pooled", path[0]!, "sql");
      return undefined;
    }
    case "mongoose-model":
      if (path.length === 1) {
        const op = dbOp(h, "pooled", `${method} ${String(h.data.model ?? "")}`.trim(), "mongodb");
        if (method === "find") op.props = { statement: "SELECT", unbounded: !chainCall(call, "limit"), scoped: !!args[0] && !isEmptyObject(args[0]) };
        return op;
      }
      return undefined;
    case "drizzle": {
      const verb = path[0]!;
      const lc: Lifecycle = "pooled";
      if (path.length === 1 && (verb === "select" || verb === "selectDistinct")) {
        const from = chainCall(call, "from");
        const op = dbOp(h, lc, `select ${from?.getArguments()[0]?.getText() ?? ""}`.trim());
        op.props = { statement: "SELECT", unbounded: !chainCall(call, "limit"), scoped: !!chainCall(call, "where") };
        return op;
      }
      if (path.length === 1 && (verb === "insert" || verb === "update" || verb === "delete")) {
        return dbOp(h, lc, `${verb} ${call.getArguments()[0]?.getText() ?? ""}`.trim());
      }
      if (path.length === 3 && verb === "query") return dbOp(h, lc, `${path[2]} ${path[1]}`);
      if (path.length === 1 && (verb === "execute" || verb === "transaction")) return dbOp(h, lc, verb);
      return undefined;
    }
    case "mongoose-doc":
      if (path.length === 1 && MONGOOSE_DOC_WRITES.has(method)) {
        const model = (h.data.model as Handle | undefined)?.data.model;
        return dbOp(h, "pooled", `${method} ${String(model ?? "document")}`.trim(), "mongodb");
      }
      return undefined;
    case "bull-queue":
      if (method === "add" || method === "addBulk") {
        const name = String(h.data.name ?? "queue");
        return { target: { type: "queue", name, broker: "redis" }, protocol: "redis", lifecycle: "persistent", mode: "async", label: `enqueue job on "${name}"`, props: {} };
      }
      return undefined;
    case "http-client":
      if (HTTP_METHODS.has(method) || method === "request") {
        const op = urlOp(r, call, args, method === "request" ? "GET" : method.toUpperCase(), String(h.data.baseURL ?? ""));
        if (h.data.timeout !== undefined) op.props.timeout = true;
        return op;
      }
      return undefined;
    case "sdk-client": {
      if (path.length === 0 || method === "on" || (h.data.service === "Stripe API" && path[0] === "webhooks")) return undefined;
      const protocol = (h.data.protocol as Protocol) ?? "http";
      // nodemailer without `pool: true` opens a new SMTP connection for every message.
      const lifecycle: Lifecycle = protocol === "smtp" && !h.data.pool ? "new-per-request" : "pooled";
      return {
        target: { type: "external", service: String(h.data.service), host: String(h.data.host) }, protocol, lifecycle, mode: "sync",
        label: path.join("."), props: { timeout: "sdk-default", ...(protocol === "http" ? { scheme: "https" } : {}) },
      };
    }
    case "mongo-client": {
      const lc: Lifecycle = h.data.perRequest ? "new-per-request" : "pooled";
      if (method === "connect") return dbOp(h, lc, h.data.perRequest ? "open a new MongoDB connection (TCP, TLS, authentication)" : "connect to MongoDB", "mongodb");
      if (method === "close") return dbOp(h, lc, "close the connection", "mongodb");
      if (MONGO_DRIVER_OPS.has(method)) {
        const coll = collectionName(r, call);
        return { ...dbOp(h, lc, `${method}${coll ? " " + coll : ""}`, "mongodb"), props: {} };
      }
      return undefined;
    }
    case "supabase": {
      if (path.length === 1 && method === "from") {
        const table = stringArg(r, call, 0) ?? "table";
        const chain = chainMethods(call);
        const verb = chain.find((m) => SUPABASE_DB_METHODS.includes(m)) ?? "query";
        const bounded = chain.some((m) => ["limit", "range", "single", "maybeSingle"].includes(m));
        const scoped = chain.some((m) => ["eq", "in", "match", "filter", "neq", "gt", "lt", "gte", "lte", "is"].includes(m));
        return {
          target: { type: "external", service: "Supabase (Postgres over REST)", host: "supabase.co" }, protocol: "http", lifecycle: "pooled", mode: "sync", label: `${verb} ${table}`,
          props: { table, timeout: "sdk-default", ...(verb === "select" ? { statement: "SELECT", unbounded: !bounded, scoped } : {}) },
        };
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
  const value = r.value(args[0]);
  const text = stringValue(value);
  const shown = displayValue(value);
  const sql = text ? summarizeSql(text) : undefined;
  if (!sql) return { ...dbOp(h, lifecycle, "query"), props: {} };
  // Check the WHERE clause against the repo's own schema when the table is known.
  const table = sql.table ? r.repo.sqlSchema.get(sql.table) : undefined;
  const facts = table && !sql.hasJoin && (sql.op === "SELECT" || sql.op === "UPDATE" || sql.op === "DELETE") ? checkQuery(table, sql.whereColumns) : undefined;
  const singleRow = sql.singleRow || !!facts?.uniqueLookup;
  return {
    ...dbOp(h, lifecycle, sql.label),
    props: {
      sql: (shown ? summarizeSql(shown)?.text : undefined) ?? sql.text, statement: sql.op, table: sql.table, hasLimit: sql.hasLimit, aggregate: sql.aggregate, singleRow,
      ...(sql.op === "SELECT" ? { unbounded: !sql.hasLimit && !sql.aggregate && !singleRow, scoped: /\bWHERE\b/i.test(sql.text) } : {}),
      ...(facts ? { schemaChecked: true } : {}),
      ...(facts?.unindexed.length ? { missingIndex: facts.unindexed } : {}),
    },
  };
}

function urlOp(r: Resolver, _call: Node, args: Node[], method: string, base = ""): Op {
  const v = r.value(args[0]);
  // A URL picked from a table at runtime (`config[provider].url`): one of several hosts, not the first.
  if (v.kind === "choice") {
    const urls = v.options.filter((o) => o.kind === "string").map((o) => (o as { value: string }).value);
    const hosts = [...new Set(urls.map((u) => /^https?:\/\/([^/{}?]+)/.exec(u)?.[1]).filter((h): h is string => !!h))];
    if (hosts.length > 1) {
      return {
        target: { type: "external", service: `one of ${hosts.length} services (picked at runtime)`, host: hosts.join(", ") },
        protocol: "http", lifecycle: "pooled", mode: "sync", label: `${method} one of: ${hosts.slice(0, 4).join(", ")}${hosts.length > 4 ? `, +${hosts.length - 4} more` : ""}`,
        props: { timeout: hasTimeout(r, args), hosts, scheme: "https" },
      };
    }
  }
  // `fetch(makeURL('https://api.example.com/v1/x', params))`: a local URL builder given a literal base.
  if (v.kind !== "string" && args[0]) {
    const origin = r.originOf(args[0]);
    if (Node.isCallExpression(origin)) {
      const baseArg = origin.getArguments()[0];
      const literal = baseArg ? stringValue(r.value(baseArg)) : undefined;
      if (literal && /^https?:\/\//.test(literal)) return urlOp(r, _call, [baseArg!, ...args.slice(1)], method, base);
    }
  }
  const s = pick(v, "string");
  const url = base + (s?.value ?? "{}");
  const shown = base + (s?.display ?? s?.value ?? "<url>");
  const env = args[0] ? leadingEnvVar(r, args[0]) : undefined;
  const scheme = /^(https?):/.exec(url)?.[1];
  return {
    target: { type: "url", method, url, template: !s || s.template, ...(env ? { envBase: env } : {}) },
    protocol: "http", lifecycle: "pooled", mode: "sync", label: `${method} ${env ? shown.replace(/^<[^>]*>/, `\${${env}}`) : shown}`,
    props: { timeout: hasTimeout(r, args), ...(scheme ? { scheme } : {}) },
  };
}

/** `${PAYPAL_API_URL}/v1/...` -> "PAYPAL_API_URL" when the URL starts with an environment variable. */
function leadingEnvVar(r: Resolver, arg: Node): string | undefined {
  const origin = r.originOf(arg);
  let first: Node | undefined;
  if (Node.isTemplateExpression(origin) && origin.getHead().getLiteralText() === "") first = origin.getTemplateSpans()[0]?.getExpression();
  else if (Node.isBinaryExpression(origin) && origin.getOperatorToken().getText() === "+") first = origin.getLeft();
  if (!first) return undefined;
  return envVarName(r, first, 0);
}

function envVarName(r: Resolver, node: Node, depth: number): string | undefined {
  if (depth > 6) return undefined;
  const text = node.getText().replace(/\s/g, "");
  const direct = /^process\.env\.(\w+)$|^process\.env\[["'](\w+)["']\]$|^import\.meta\.env\.(\w+)$/.exec(text);
  if (direct) return direct[1] ?? direct[2] ?? direct[3];
  if (Node.isIdentifier(node)) {
    const d = r.declarationOf(node);
    if (d && Node.isBindingElement(d)) {
      const owner = d.getParent()?.getParent();
      if (owner && Node.isVariableDeclaration(owner) && /^(process\.env|import\.meta\.env)$/.test(owner.getInitializer()?.getText() ?? "")) {
        return (d.getPropertyNameNode() ?? d.getNameNode()).getText();
      }
    }
    if (d && Node.isVariableDeclaration(d) && d.getInitializer()) {
      const init = d.getInitializer()!;
      const inner = Node.isBinaryExpression(init) ? init.getLeft() : init;
      return envVarName(r, inner, depth + 1);
    }
  }
  if (Node.isPropertyAccessExpression(node)) {
    // config.apiUrl where config = { apiUrl: process.env.API_URL }
    const origin = r.originOf(node);
    if (origin !== node) return envVarName(r, Node.isBinaryExpression(origin) ? origin.getLeft() : origin, depth + 1);
  }
  return undefined;
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

/** Like stringValue, but unknown parts are named (`refresh:<userId>:<jti>`) rather than {}. */
export function displayValue(v: Value): string | undefined {
  const s = pick(v, "string");
  return s ? s.display ?? s.value : undefined;
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

function objectHasProp(r: Resolver, node: Node | undefined, name: string): boolean {
  if (!node) return false;
  const v = r.value(node);
  if (v.kind !== "object") return false;
  return ((v.node as any).getProperties() as Node[]).some((p) => (Node.isPropertyAssignment(p) || Node.isShorthandPropertyAssignment(p)) && p.getName() === name);
}

function isEmptyObject(node: Node): boolean {
  return Node.isObjectLiteralExpression(node) && node.getProperties().length === 0;
}

function insideFunction(node: Node): boolean {
  return node.getAncestors().some((a) => isFunctionLike(a));
}

/** The call to `name` later in a fluent chain: db.select().from(users) -> the `.from(users)` call. */
function chainCall(call: CallExpression | NewExpression, name: string): CallExpression | undefined {
  let cur: Node = call;
  for (;;) {
    const parent = cur.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent) || parent.getExpression() !== cur) return undefined;
    const grand = parent.getParent();
    if (!grand || !Node.isCallExpression(grand) || grand.getExpression() !== parent) return undefined;
    if (parent.getName() === name) return grand;
    cur = grand;
  }
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

const MONGO_DRIVER_OPS = new Set(["find", "findOne", "insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "aggregate", "countDocuments", "bulkWrite", "replaceOne", "findOneAndUpdate", "createIndex", "createSearchIndex", "listSearchIndexes"]);

/** `client.db(x).collection('docs').find()` -> "docs". */
function collectionName(r: Resolver, call: CallExpression | NewExpression): string | undefined {
  let cur: Node = call.getExpression();
  while (Node.isPropertyAccessExpression(cur) || Node.isCallExpression(cur)) {
    if (Node.isCallExpression(cur)) {
      const e = cur.getExpression();
      if (Node.isPropertyAccessExpression(e) && e.getName() === "collection") return stringValue(r.value(cur.getArguments()[0]));
      cur = e;
    } else cur = cur.getExpression();
  }
  return undefined;
}

function booleanOption(r: Resolver, call: CallExpression | NewExpression, name: string): boolean | undefined {
  const opts = r.value(call.getArguments()[0]);
  if (opts.kind !== "object") return undefined;
  const prop = (opts.node as any).getProperty?.(name);
  const init = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
  return init ? init.getText() === "true" : undefined;
}
