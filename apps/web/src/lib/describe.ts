import type { TraceEdge, TraceNode } from "@vibesim/spec";
import type { Model } from "./model.ts";
import { branchKey, type Device, type Scene, type SceneEvent } from "./scene.ts";

/**
 * Words for the devices view. Everything here is built from facts in the trace plus fixed
 * explanations of well-known things (Express middleware, Redis commands, SQL statements);
 * nothing is generated at runtime and nothing is guessed: when a fact isn't in the trace,
 * the sentence leaves it out.
 */

// ------------------------------------------------------------------ fixed explanations

/** What well-known middleware does, keyed by the library name the extractor records. */
const MIDDLEWARE: Record<string, string> = {
  "express.json": "parses a JSON request body into req.body. It only reads the body when the request says Content-Type: application/json; otherwise it passes the request straight on.",
  "express.urlencoded": "parses an HTML form submission (application/x-www-form-urlencoded) into req.body.",
  "express.static": "serves files from a folder (CSS, images, scripts). If the URL matches a file, it answers right here and the request goes no further; otherwise it passes the request on.",
  compression: "compresses the response (gzip or deflate) if the client accepts it: a little CPU to save bandwidth.",
  helmet: "sets security headers on the response (Content-Security-Policy, X-Frame-Options and others).",
  cors: "adds CORS headers so pages on other origins may call this API, and answers the browser's preflight OPTIONS requests.",
  "cookie-parser": "parses the Cookie header into req.cookies.",
  morgan: "logs one line per request (method, path, status, time) when the response finishes.",
  "express-session": "reads the session cookie and loads that session from the session store into req.session; after the response it saves the session again if it changed.",
  "passport.initialize": "sets up Passport for this request (req.login, req.logout, req.isAuthenticated).",
  "passport.session": "restores the logged-in user from the session: it calls deserializeUser, which loads the user record, and puts it on req.user.",
  "passport.authenticate": "runs a login strategy: checks a password, or handles an OAuth redirect or callback, and logs the user in on success.",
  "passport.authorize": "runs an OAuth strategy to link another provider's account to the user who is already logged in.",
  lusca: "is security middleware; here it checks a CSRF token on requests that change data and refuses the request if the token is missing or wrong.",
  "lusca.xframe": "sets X-Frame-Options so other sites can't show this page inside a frame (clickjacking protection).",
  "lusca.xssProtection": "sets the X-XSS-Protection header, which only older browsers use.",
  "express-rate-limit": "counts requests per client (by IP address unless configured otherwise) in a time window and answers 429 Too Many Requests over the limit.",
  errorhandler: "turns errors into a detailed error page. It is meant for development only.",
};

const REDIS: Record<string, { does: string; returns: string }> = {
  GET: { does: "reads the value stored under a key", returns: "the value, or nil if the key doesn't exist" },
  SET: { does: "stores a value under a key, replacing any old one (often with an expiry)", returns: "OK" },
  SETEX: { does: "stores a value under a key with an expiry in seconds", returns: "OK" },
  DEL: { does: "deletes the key", returns: "how many keys were deleted" },
  EXISTS: { does: "checks whether the key exists", returns: "1 if it exists, 0 if not" },
  INCR: { does: "adds one to a counter, atomically, so two clients can't both read the old value", returns: "the new count" },
  EXPIRE: { does: "makes the key delete itself after a number of seconds", returns: "1 if the timeout was set" },
  ZADD: { does: "adds a member to a sorted set with a score; Redis keeps the set ordered by score", returns: "how many new members were added" },
  ZRANGEBYSCORE: { does: "reads the members of a sorted set whose score falls in a range", returns: "the matching members, lowest score first" },
  ZREM: { does: "removes a member from a sorted set", returns: "how many members were removed" },
  ZPOPMIN: { does: "removes and returns the member with the lowest score", returns: "that member and its score" },
  HSET: { does: "sets fields in a hash (a small map stored under one key)", returns: "how many fields were added" },
  HGET: { does: "reads one field of a hash", returns: "the value, or nil" },
  HGETALL: { does: "reads every field of a hash", returns: "all fields and values" },
  LPUSH: { does: "pushes a value onto the front of a list", returns: "the new length of the list" },
  RPUSH: { does: "pushes a value onto the end of a list", returns: "the new length of the list" },
  BRPOP: { does: "takes a value from the end of a list, waiting until one is there", returns: "the value" },
  SADD: { does: "adds a member to a set", returns: "how many members were new" },
  SMEMBERS: { does: "reads every member of a set", returns: "the members" },
  PUBLISH: { does: "sends a message to every connection subscribed to the channel. Redis doesn't store it: a subscriber that isn't connected right now never sees it", returns: "how many subscribers received it" },
  MGET: { does: "reads several keys in one round trip", returns: "their values" },
};

const SQL_RESULT: Record<string, string> = {
  SELECT: "the matching rows",
  INSERT: "confirmation that the row was written",
  UPDATE: "how many rows changed",
  DELETE: "how many rows were deleted",
  BEGIN: "confirmation: the transaction is open",
  COMMIT: "confirmation: the changes are now permanent and visible to everyone",
  ROLLBACK: "confirmation: everything since BEGIN was undone",
};

// ------------------------------------------------------------------ helpers

const fileLine = (e: { evidence: { file: string; line: number }[] }) => (e.evidence[0] ? `${e.evidence[0].file}:${e.evidence[0].line}` : "");
const fnName = (n: TraceNode) => n.label.replace(/\s*\(.*\)$/, "");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function deviceName(d: Device | undefined): string {
  if (!d) return "?";
  if (d.kind === "process") return `the ${d.label} process`;
  if (d.kind === "browser") return "the browser";
  if (d.kind === "client") return "the client";
  return d.label;
}

function redisCommand(edge: TraceEdge): string | undefined {
  const cmd = (typeof edge.props.command === "string" ? edge.props.command : String(edge.label ?? "").split(" ")[0])?.toUpperCase();
  return cmd && /^[A-Z]+$/.test(cmd) ? cmd : undefined;
}

/** "Only when `status` is set", "only when `exhausted` is false", "only on error", and loop/parallel notes. */
export function conditionNote(edge: TraceEdge): string | undefined {
  const p = edge.props;
  if (p.errorPath) return "Only runs when something above it failed (it's in a catch block).";
  if (typeof p.condition === "string") {
    return p.branch === "else"
      ? `Only runs when \`${p.condition}\` is false; when it's true, the other branch runs instead.`
      : `Only runs when \`${p.condition}\` is true.`;
  }
  if (p.conditional) return "Only runs when a condition in the code holds.";
  return undefined;
}

function repeatNote(edge: TraceEdge, to: TraceNode, network: boolean): string | undefined {
  const p = edge.props;
  if (p.inLoop) {
    if (p.loopExitsEarly) return "It sits in a loop that usually stops at the first match, so it often runs once or twice.";
    if (to.kind === "ws-endpoint" || p.role === "push") return "It runs once per connected socket, so the work grows with the number of open dashboards.";
    return network ? "It sits in a loop, so it runs once per item: ten items mean ten round trips." : "It sits in a loop, so it runs once per item.";
  }
  if (p.parallel) return "It runs at the same time as the calls next to it (Promise.all), so they cost one wait, not several.";
  return undefined;
}

// ------------------------------------------------------------------ titles

/** Short text for the event list. */
export function eventTitle(model: Model, scene: Scene, ev: SceneEvent): string {
  const e = ev.edge;
  const from = (edge: TraceEdge) => model.nodes.get(edge.from)!;
  const to = model.nodes.get(e.to)!;
  switch (ev.kind) {
    case "response":
      return `response${model.nodes.get(e.to)?.kind === "route" ? ` to ${to.label}` : ""}`;
    case "reply":
      return replyTitle(e, to);
    case "ack":
      return "Redis confirms";
    case "local": {
      if (e.props.checkout) return "borrows a pool connection";
      if (e.props.release) return "returns the connection";
      if (e.props.sleep) return e.label ?? "waits on purpose";
      const stage = ev.to.stage?.startsWith("__library") ? "library middleware" : fnName(to);
      if (to.kind === "compute") return e.label ?? to.label;
      if (to.kind === "middleware") return `runs ${stage}`;
      if (to.kind === "handler") return from(e).kind === "route" || from(e).kind === "middleware" ? "runs the handler" : `runs ${fnName(to)}`;
      if (to.kind === "external-api") return e.label ?? to.label;
      if (to.kind === "ws-endpoint") return "writes to the sockets";
      return `calls ${stage}`;
    }
    default: {
      if (e.props.role === "deliver") return to.kind === "handler" && scene.devices.find((d) => d.id === ev.to.device)?.kind === "browser" ? "WebSocket message arrives" : "message delivered";
      if (e.props.role === "connect") return "opens a WebSocket";
      return e.label ?? (to.kind === "route" ? to.label : `calls ${fnName(to)}`);
    }
  }
}

function replyTitle(e: TraceEdge, to: TraceNode): string {
  if (e.protocol === "sql") {
    const st = String(e.props.statement ?? "");
    if (st === "SELECT") return e.props.aggregate ? (/COUNT/i.test(String(e.props.sql ?? "")) ? "count" : "result") : e.props.singleRow ? "row (or none)" : "rows";
    if (st === "INSERT") return /RETURNING/i.test(String(e.props.sql ?? "")) ? "the new row" : "row written";
    return st ? `${st} done` : "result";
  }
  if (e.protocol === "redis") return "reply";
  if (e.protocol === "mongodb") return "document(s)";
  if (to.kind === "external-api") return e.protocol === "smtp" ? "mail accepted" : "API response";
  return "result";
}

// ------------------------------------------------------------------ captions

/** The full explanation of one event, two to four sentences. */
export function eventCaption(model: Model, scene: Scene, ev: SceneEvent): string {
  const e = ev.edge;
  const from = model.nodes.get(e.from)!;
  const to = model.nodes.get(e.to)!;
  const dev = (id: string) => scene.devices.find((d) => d.id === id);
  const parts: string[] = [];
  const add = (s: string | undefined) => s && parts.push(s);

  switch (ev.kind) {
    case "local":
      add(localSentence(e, from, to, ev));
      break;
    case "request":
    case "send":
      add(networkSentence(model, e, from, to, dev(ev.from.device), dev(ev.to.device), ev.kind === "request"));
      break;
    case "reply":
      add(replySentence(model, e, to));
      break;
    case "ack":
      add(`Redis replies at once with how many subscribers got the message. ${fnName(from)} doesn't wait for any of them to finish handling it.`);
      break;
    case "response": {
      const source = dev(ev.from.device);
      const target = dev(ev.to.device);
      const r = chosenResponse(model, scene, ev);
      const what = r ? responseText(r) : "the response (status code, headers, body)";
      if (source?.kind === "proxy") add(`${source.label} passes the response back to ${deviceName(target)}. The request is complete.`);
      else if (target?.kind === "proxy") add(`The handler sends ${what} back to ${target.label}, on the connection the request came in on.`);
      else add(`The handler sends ${what} back to ${deviceName(target)} on the same connection. The request is complete.`);
      if (r && source?.kind !== "proxy") {
        const others = otherResponses(model, ev, r);
        if (others) add(others);
      }
      break;
    }
  }
  if (ev.kind === "local" || ev.kind === "request" || ev.kind === "send") {
    add(conditionNote(e));
    add(repeatNote(e, to, ev.kind !== "local"));
  }
  return parts.join(" ");
}

/** A response a handler can send, as the extractor records it. */
interface ResponseSite {
  status?: number;
  statusText: string;
  kind: string;
  body?: string;
  line: number;
  path: { condition: string; branch: "then" | "else"; guard?: boolean }[];
  errorPath: boolean;
}

const STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 204: "No Content", 301: "Moved", 302: "Found (redirect)", 304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict", 422: "Unprocessable", 429: "Too Many Requests", 500: "Internal Server Error", 503: "Service Unavailable" };

function responseText(r: ResponseSite): string {
  const code = r.status ? `${r.status} ${STATUS_TEXT[r.status] ?? ""}`.trim() : r.statusText;
  switch (r.kind) {
    case "redirect": return `a ${code} redirect to ${r.body ?? "another page"}`;
    case "render": return `${code} with the rendered page ${r.body ?? ""}`.trim();
    case "file": return `${code} with a file (${r.body ?? "from disk"})`;
    case "end": return `${code} with no body`;
    case "error": return "the error to the error handler";
    default: return `${code} with ${r.body ? `\`${r.body}\`` : "a body"}`;
  }
}

/** The response the handler sends on the branches currently being played. */
export function chosenResponse(model: Model, scene: Scene, ev: SceneEvent): ResponseSite | undefined {
  const node = ev.from.stage ? model.nodes.get(ev.from.stage) : undefined;
  const list = (node?.props.responses as ResponseSite[] | undefined)?.filter((r) => !r.errorPath && r.kind !== "error");
  if (!list?.length) return undefined;
  const fits = (r: ResponseSite) => r.path.every((b) => {
    const branch = scene.branches.find((x) => x.key === branchKey(node!.id, b.condition));
    return branch ? branch.chosen === b.branch : b.guard ? b.branch === "else" : b.branch === "then";
  });
  return list.find(fits) ?? list[list.length - 1];
}

/** "Otherwise it can answer 400 or 404": the other outcomes of this handler. */
function otherResponses(model: Model, ev: SceneEvent, chosen: ResponseSite): string | undefined {
  const node = ev.from.stage ? model.nodes.get(ev.from.stage) : undefined;
  const all = (node?.props.responses as ResponseSite[] | undefined) ?? [];
  const codes = [...new Set(all.filter((r) => r !== chosen && r.statusText !== chosen.statusText && r.kind !== "error").map((r) => r.status ? String(r.status) : r.statusText))];
  const toHandler = all.some((r) => r.kind === "error");
  if (!codes.length && !toHandler) return undefined;
  const parts = [codes.length ? `it can also answer ${codes.slice(0, 4).join(", ")}` : "", toHandler ? "pass errors to the error handler" : ""].filter(Boolean);
  return `On other branches ${parts.join(" or ")}.`;
}

function localSentence(e: TraceEdge, from: TraceNode, to: TraceNode, ev: SceneEvent): string {
  const at = fileLine(e);
  if (e.props.checkout) {
    const n = typeof to.props.poolMax === "number" ? to.props.poolMax : undefined;
    return `${fnName(from)} borrows one connection from the pool${n ? ` (${n} at most)` : ""} and keeps it for the statements that follow. No SQL is sent: an idle connection is handed over, a new one is opened if the pool isn't full, and if all are busy it waits. A transaction only works if every statement runs on this one connection.`;
  }
  if (e.props.release) return `${fnName(from)} gives the connection back to the pool (it's in a finally block, so this happens whether the transaction committed or rolled back). Forgetting this would leak one of the pool's connections for good.`;
  if (e.props.sleep) {
    const ms = typeof e.props.sleepMs === "number" ? e.props.sleepMs : undefined;
    const how = ms !== undefined ? `${ms >= 1000 ? `${+(ms / 1000).toFixed(1)} seconds` : `${ms} ms`}` : "a while";
    const repeat = e.props.inLoop ? " It's inside a loop, so it can happen more than once." : "";
    return `${fnName(from)} deliberately waits ${how} (a setTimeout wrapped in a promise, ${at}) before going on. The process stays free to serve other requests, but this request, and whoever is waiting for its response, is held up the whole time.${repeat}`;
  }
  if (to.kind === "middleware") {
    const lib = typeof to.props.library === "string" ? to.props.library : undefined;
    if (ev.to.stage?.startsWith("__library")) return `Library middleware runs before your code: ${lib && MIDDLEWARE[lib] ? `${lib} ${MIDDLEWARE[lib]}` : `${to.label} runs.`}`;
    if (lib && MIDDLEWARE[lib]) return `${lib} ${MIDDLEWARE[lib]}`;
    if (to.props.library === "express-rate-limit") {
      const limit = typeof to.props.max === "number" && typeof to.props.windowMs === "number" ? ` (${to.props.max} per ${formatMs(to.props.windowMs)})` : "";
      return `The rate limiter ${fnName(to)}${limit} counts this request for the client's IP. Over the limit it answers 429 Too Many Requests and the handler never runs. One counter per IP is shared by every route that uses this limiter.`;
    }
    return `Your middleware ${fnName(to)} runs (${fileLine(to)}). It either calls next() to pass the request on, or answers right away (for example with 401 or 403).`;
  }
  if (/deserializeUser/.test(to.label)) return `Passport calls deserializeUser (${fileLine(to)}): it turns the user id stored in the session into the full user record, which becomes req.user.`;
  if (/strategy verify callback/.test(to.label)) return `Passport runs the strategy's verify callback (${fileLine(to)}): it finds or creates the user and tells Passport whether the login succeeded.`;
  if (to.kind === "handler") {
    if (from.kind === "route" || from.kind === "middleware") return `Express runs the route's handler (${fileLine(to)}). This is where the work for this request happens.`;
    if (from.kind === "timer") return `The timer fires and ${fnName(to)} runs (${fileLine(to)}).`;
    if (from.kind === "ui-event") return `${fnName(to)} runs in the browser (${fileLine(to)}).`;
    return `${fnName(from)} runs ${fnName(to)} (${fileLine(to)}).`;
  }
  if (to.kind === "compute") {
    const cost = typeof e.props.cost === "number" ? e.props.cost : undefined;
    const algo = /argon2/.test(String(to.props.library ?? e.label)) ? "Argon2" : "bcrypt";
    const what = /compare|verify/.test(String(e.label)) ? `checks the password against the stored hash with ${algo}` : `hashes the password with ${algo}${cost ? ` at work factor ${cost}` : ""}`;
    const ms = cost ? ` (about ${Math.round(65 * 2 ** (cost - 10))} ms of CPU)` : "";
    return to.props.pool === "event-loop"
      ? `${fnName(from)} ${what}${ms} on the main thread: until it finishes, this process can't serve any other request.`
      : `${fnName(from)} ${what}${ms}. It runs on libuv's thread pool (4 threads by default), so other requests keep being served, but only 4 hashes run at a time per process.`;
  }
  if (to.kind === "external-api") {
    if (e.props.presign) return `${fnName(from)} signs an upload URL with the AWS credentials, locally: no network call happens here. The browser will upload the file straight to S3 with that URL, so the bytes never pass through this server.`;
    return `${fnName(from)} prepares a request for ${to.label} locally (${e.label ?? "no network call yet"}).`;
  }
  if (to.kind === "ws-endpoint") return `${fnName(from)} writes the message into each open WebSocket held by this process. There's no reply to wait for.`;
  if (from.kind === "timer") return `The timer fires and ${fnName(to)} runs (${fileLine(to)}).`;
  if (from.kind === "ui-event") return `When this happens in the page, ${fnName(to)} runs (${fileLine(to)}).`;
  const notAwaited = e.props.notAwaited ? " without waiting for it to finish" : "";
  const dispatch = e.props.dispatch ? `, one of ${String(e.props.candidates ?? "several")} handlers chosen at runtime` : "";
  const memory = (key: string) => (Array.isArray(to.props[key]) ? (to.props[key] as string[]).map((x) => `\`${x}\``).join(", ") : "");
  const writes = memory("mutatesModuleState");
  const reads = memory("readsModuleState");
  const state = writes
    ? ` It updates ${writes}, kept in this process's memory: no network call, but each running instance has its own copy and a restart empties it.`
    : reads ? ` It reads ${reads}, kept in this process's memory: no network call, and it only knows what this instance has seen since it started.` : "";
  return `${fnName(from)} calls ${fnName(to)}${notAwaited}${dispatch} (${at}).${state}`;
}

function networkSentence(model: Model, e: TraceEdge, from: TraceNode, to: TraceNode, fromDev: Device | undefined, toDev: Device | undefined, waits: boolean): string {
  const role = e.props.role;
  const waitText = waits ? "and waits for the answer" : "and doesn't wait for an answer";
  if (role === "deliver") {
    if (toDev?.kind === "browser") return `The message arrives over the open WebSocket and the page's handler runs (${fileLine(to)}). The browser didn't ask for it: the server pushed it.`;
    return `Redis pushes the message to every connection subscribed to this channel. Here, ${deviceName(toDev)}'s subscriber runs its callback (${fileLine(to)}).`;
  }
  if (role === "connect") return `The page opens a WebSocket to the server: one HTTP request that upgrades into a connection that stays open, so either side can send messages at any time.`;
  if (role === "push") return `${fnName(from)} writes the message into the open WebSocket. No new connection and no reply.`;

  if (to.kind === "route" || toDev?.kind === "proxy") {
    const who = fromDev?.kind === "browser" ? "The page" : fromDev?.kind === "proxy" ? fromDev.label : fromDev?.kind === "client" ? "The client" : cap(deviceName(fromDev));
    const what = e.label ?? to.label;
    if (fromDev?.kind === "proxy") {
      const rl = typeof fromDev.node?.props.rateLimit === "string" ? ` After its rate limit (${fromDev.node.props.rateLimit} per client IP) lets it through,` : "";
      return `${rl ? rl.trim() : ""}${rl ? " it" : `${fromDev.label}`} forwards the request to ${deviceName(toDev)} (proxy_pass), and waits for the app's answer. Express matches ${what} to the route registered at ${fileLine(to)}.`.trim();
    }
    if (toDev?.kind === "proxy") return `${who} sends ${what} over HTTP. It reaches ${toDev.label} first, which sits in front of the app.`;
    const reuse = fromDev?.kind === "browser" || fromDev?.kind === "client" ? " It reuses an open keep-alive connection if one exists; otherwise it opens a new TCP (and TLS) connection first." : "";
    return `${who} sends ${what} over HTTP to ${deviceName(toDev)} ${waitText}.${reuse} Express matches it to the route registered at ${fileLine(to)}.`;
  }
  if (typeof e.props.sessionStore === "string") {
    return e.props.afterResponse
      ? `As the response finishes, express-session writes the session back to ${to.label.replace(/\s*\(.*\)$/, "")}: the whole session if it changed (a login, a flash message), or just a new expiry time if it didn't. The response isn't complete until this write is.`
      : `express-session reads the cookie and loads this visitor's session from ${to.label.replace(/\s*\(.*\)$/, "")} by its id. A first visit with no cookie skips this and starts an empty session in memory.`;
  }
  if (e.props.oauth === "token") return `Passport sends the authorization code from the callback URL to the provider's token endpoint and waits for an access token. This is a server-to-server HTTPS call; the browser never sees the token.`;
  if (e.props.oauth === "profile") return `With that token, Passport asks the provider for the user's profile (id, name, email) and waits for it.`;
  if (to.kind === "database") {
    if (e.protocol === "sql") return `${fnName(from)} ${sqlSentence(e, to)} ${connectionSentence(e, to)}`.trim();
    return `${fnName(from)} sends a MongoDB command${e.label ? ` (${e.label})` : ""} ${waitText}. ${connectionSentence(e, to)}`.trim();
  }
  if (to.kind === "cache") {
    const cmd = redisCommand(e);
    const info = cmd ? REDIS[cmd] : undefined;
    return `${fnName(from)} sends ${e.label ?? "a command"} to Redis ${waitText}.${info ? ` ${cap(info.does)}.` : ""} It goes over the connection the client keeps open, so there's no handshake.`;
  }
  if (to.kind === "topic") {
    const info = REDIS.PUBLISH!;
    return `${fnName(from)} sends ${e.label ?? "PUBLISH"} to Redis. ${cap(info.does)}.`;
  }
  if (to.kind === "queue") return `${fnName(from)} adds a job to the queue ${to.label} (stored in Redis) and moves on. A worker process picks it up later; the user doesn't wait for it.`;
  if (to.kind === "external-api") {
    if (e.protocol === "smtp") return `${fnName(from)} hands the email to the SMTP server ${waitText}. The request takes as long as the mail server does.`;
    const timeout = e.props.timeout === false ? " No timeout is set, so if that service hangs, this request hangs with it." : e.props.timeout === true ? " A timeout is set, so a hung service can't hold this request forever." : "";
    return `${fnName(from)} calls ${to.label}${e.label ? ` (${e.label.replace(/\?.*$/, "")})` : ""} over the internet ${waitText}. That service's speed and uptime become part of this request's.${timeout}`;
  }
  if (to.kind === "unknown") return `${fnName(from)} calls something the parser couldn't identify (it's decided at runtime), so this hop is shown dashed rather than guessed.`;
  return `${fnName(from)} talks to ${to.label}${e.label ? ` (${e.label})` : ""} ${waitText}.`;
}

function sqlSentence(e: TraceEdge, db: TraceNode): string {
  const st = String(e.props.statement ?? "");
  const table = typeof e.props.table === "string" ? e.props.table : undefined;
  const sql = String(e.props.sql ?? "");
  switch (st) {
    case "SELECT": {
      const how = e.props.aggregate ? `computes ${/COUNT/i.test(sql) ? "a count" : "an aggregate"} over ${table ?? "a table"}` : `reads ${e.props.singleRow ? "one row" : "rows"} from ${table ?? "the database"}`;
      const limit = e.props.singleRow ? " by its key" : e.props.hasLimit ? " (with a LIMIT, so the result stays small)" : e.props.unbounded ? " with no LIMIT: every matching row comes back, however many there are" : "";
      const index = Array.isArray(e.props.missingIndex) ? ` No index in the repo's schema covers ${(e.props.missingIndex as string[]).join(", ")}, so the database has to scan the table.` : "";
      return `${how}${limit}.${index}`;
    }
    case "INSERT":
      return `writes a new row into ${table ?? "a table"}${/RETURNING/i.test(sql) ? " and asks for it back (RETURNING), including values the database fills in, like the id" : ""}.`;
    case "UPDATE":
      return `changes rows in ${table ?? "a table"}${/\bWHERE\b/i.test(sql) ? " that match the WHERE clause" : ": every row, since there's no WHERE"}.`;
    case "DELETE":
      return `deletes rows from ${table ?? "a table"}${/\bWHERE\b/i.test(sql) ? " that match the WHERE clause" : ": every row, since there's no WHERE"}.`;
    case "BEGIN":
      return "starts a transaction on its connection: the statements that follow either all take effect or none do.";
    case "COMMIT":
      return "commits the transaction: everything since BEGIN becomes permanent and visible to other connections at once.";
    case "ROLLBACK":
      return "rolls the transaction back: everything since BEGIN is undone, as if it never happened.";
    default:
      return e.props.checkout ? `checks out a connection from the pool and keeps it for the next statements (needed for a transaction, which must run on one connection).` : e.props.release ? "gives its connection back to the pool." : `sends a query to ${db.label}.`;
  }
}

function connectionSentence(e: TraceEdge, db: TraceNode): string {
  if (e.props.checkout || e.props.release) return "";
  if (e.lifecycle === "pooled") {
    const n = typeof db.props.poolMax === "number" ? db.props.poolMax : undefined;
    return `It borrows an already-open connection from the pool${n ? ` (${n} at most${db.props.poolMaxDefault ? ", the library default" : ""})` : ""}, so there's no handshake; if all are busy, it waits for one.`;
  }
  if (e.lifecycle === "held") return "It runs on the connection this code checked out, the same one every statement of the transaction uses.";
  if (e.lifecycle === "persistent") return "It goes over a connection that stays open.";
  if (e.lifecycle === "new-per-request") return "It opens a brand-new connection for this (TCP handshake, authentication) and closes it afterwards.";
  return "";
}

function replySentence(model: Model, e: TraceEdge, to: TraceNode): string {
  if (e.protocol === "sql") {
    const st = String(e.props.statement ?? "");
    let what = SQL_RESULT[st] ?? "the result";
    if (st === "SELECT" && e.props.aggregate) what = /COUNT/i.test(String(e.props.sql ?? "")) ? "the count" : "the computed result";
    else if (st === "SELECT" && e.props.singleRow) what = "the row, or nothing if there isn't one";
    if (st === "INSERT" && /RETURNING/i.test(String(e.props.sql ?? ""))) what = "the new row, with its id";
    if (st === "UPDATE" && /RETURNING/i.test(String(e.props.sql ?? ""))) what = "the changed rows";
    const back = e.lifecycle === "pooled" && !e.props.checkout ? " The connection goes back to the pool for the next query." : "";
    return `${to.label.replace(/\s*\(.*\)$/, "")} sends back ${what}.${back}`;
  }
  if (e.protocol === "redis") {
    const cmd = redisCommand(e);
    return `Redis answers with ${cmd && REDIS[cmd] ? REDIS[cmd]!.returns : "the result"}.`;
  }
  if (e.protocol === "mongodb") return `MongoDB sends back the result${/find(One|ById)/.test(String(e.label)) ? ": the document, or null if there's no match" : ""}.`;
  if (to.kind === "external-api") return e.protocol === "smtp" ? "The mail server accepts the email (delivery to the inbox happens later)." : `${to.label} answers, and the code continues with the response.`;
  void model;
  return "The result comes back.";
}

// ------------------------------------------------------------------ cost

/** A typical cost range for one event, honest about being a rule of thumb. */
export function typicalCost(model: Model, scene: Scene, ev: SceneEvent): string | undefined {
  const e = ev.edge;
  const to = model.nodes.get(e.to)!;
  const fromDev = scene.devices.find((d) => d.id === ev.from.device);
  const toDev = scene.devices.find((d) => d.id === ev.to.device);
  if (ev.kind === "local") {
    if (to.kind === "compute") return typeof e.props.cost === "number" ? `~${Math.round(65 * 2 ** (e.props.cost - 10))} ms` : "~65 ms+";
    return "µs";
  }
  if (ev.kind === "reply" || ev.kind === "ack") return undefined; // counted with the request
  if (ev.kind === "response") return fromDev?.kind === "proxy" || toDev?.kind === "client" || toDev?.kind === "browser" ? "10–100 ms" : "< 1 ms";
  if (e.props.role === "deliver" || e.props.role === "push") return "< 1 ms";
  if (to.kind === "route" || toDev?.kind === "proxy") return fromDev?.kind === "proxy" ? "< 1 ms" : "10–100 ms";
  if (to.kind === "cache" || to.kind === "topic" || to.kind === "queue") return "< 1 ms";
  if (to.kind === "database") {
    if (Array.isArray(e.props.missingIndex) || (e.props.aggregate && !/\bWHERE\b/i.test(String(e.props.sql ?? "")))) return "grows with the table";
    if (e.props.unbounded) return "grows with the rows";
    return "~1 ms";
  }
  if (to.kind === "external-api") {
    const label = `${to.label} ${String(e.label ?? "")}`.toLowerCase();
    if (/openai|anthropic|groq|gemini|chat\/completions/.test(label)) return "1–10 s";
    if (e.protocol === "smtp") return "100 ms–1 s";
    return "100 ms–1 s";
  }
  return undefined;
}

const formatMs = (ms: number) => (ms >= 3_600_000 && ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} min` : ms >= 1000 && ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

// ------------------------------------------------------------------ facts

/** Key facts for the details panel, in the spirit of Packet Tracer's PDU information. */
export function eventFacts(model: Model, scene: Scene, ev: SceneEvent): { label: string; value: string; mono?: boolean }[] {
  const e = ev.edge;
  const to = model.nodes.get(e.to)!;
  const out: { label: string; value: string; mono?: boolean }[] = [];
  const add = (label: string, value: string | undefined, mono = false) => value && out.push({ label, value, mono });
  if (ev.kind === "response") {
    const r = chosenResponse(model, scene, ev);
    add("Status", r ? (r.status ? `${r.status} ${STATUS_TEXT[r.status] ?? ""}`.trim() : r.statusText) : undefined);
    add("Body", r?.body, true);
    return out;
  }
  if (ev.kind === "local") {
    add("Where", `inside ${deviceName(scene.devices.find((d) => d.id === ev.from.device))}`);
    add("Cost", typicalCost(model, scene, ev));
    add("Only if", conditionNote(e)?.replace(/^Only runs when /, "").replace(/\.$/, ""));
    return out;
  }
  const proto = e.props.scheme === "https" ? "HTTPS" : e.protocol === "http" && e.props.scheme === "http" ? "HTTP (unencrypted)" : PROTOCOL_NAMES[e.protocol] ?? e.protocol;
  add("Protocol", proto);
  if (ev.kind === "request" || ev.kind === "send") {
    add("In the packet", typeof e.props.sql === "string" ? String(e.props.sql) : e.label, true);
    add("Connection", LIFECYCLE_NAMES[e.lifecycle]);
    add("Caller", ev.kind === "request" ? (to.kind === "topic" || to.kind === "queue" ? "waits for the broker to accept it, not for whoever handles it" : "waits for the answer") : "doesn't wait");
    add("Only if", conditionNote(e)?.replace(/^Only runs when /, "").replace(/\.$/, ""));
    add("Typical time", typicalCost(model, scene, ev));
  } else {
    add("Coming back", ev.kind === "ack" ? "how many subscribers received it" : replyTitle(e, to));
  }
  return out;
}

const PROTOCOL_NAMES: Record<string, string> = { http: "HTTP", ws: "WebSocket", sse: "Server-Sent Events", sql: "SQL (Postgres wire protocol)", mongodb: "MongoDB wire protocol", redis: "Redis protocol (RESP)", smtp: "SMTP", amqp: "AMQP", unknown: "unknown" };
const LIFECYCLE_NAMES: Record<string, string> = {
  pooled: "borrowed from a pool, returned after", held: "the connection this code checked out (a transaction)", "keep-alive": "the client's keep-alive connection, or a new one",
  persistent: "one long-lived connection", "new-per-request": "a brand-new connection, closed after", none: "none", unknown: "unknown",
};
