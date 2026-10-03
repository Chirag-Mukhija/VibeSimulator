import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Node, SyntaxKind, type CallExpression, type NewExpression, type SourceFile } from "ts-morph";
import { validateTraceSpec, type TraceSpec } from "@vibesim/spec";
import { runFindings } from "@vibesim/findings";
import { loadRepo, relPath, isInlineScript, type Repo } from "./project.ts";
import { Resolver, isFunctionLike, pick, type FunctionLike, type Handle, type Value } from "./values.ts";
import { hooks, classifyOp, stringValue, numericValue, type Op, type Target } from "./libraries.ts";
import { callSites, forwardedCall, functionKeyName, functionName, moduleLabel, enclosingFunction, type CallSite } from "./functions.ts";
import { extractExpressRoutes, type Route, type ChainElement } from "./express.ts";
import { readInfra, type Infra } from "./infra.ts";
import { extractNextRoutes, isNextApp } from "./nextjs.ts";
import { redundantIndexes } from "./sqlschema.ts";
import { shortHash, truncate } from "./util.ts";

export const GENERATOR_VERSION = "0.1.0";

export interface AnalyzeOptions {
  repoName?: string;
  now?: Date;
  /** Embed a few lines of source around each evidence location (default true). */
  includeSource?: boolean;
}

type Owner = FunctionLike | SourceFile;

type Step =
  | { kind: "op"; op: Op; site: CallSite }
  | { kind: "call"; fn: FunctionLike; site: CallSite; rpc?: boolean }
  /** Calls a function received as a parameter; resolved per caller when expanded in a flow. */
  | { kind: "param"; index: number; fns: FunctionLike[]; site: CallSite }
  | { kind: "dispatch"; fns: FunctionLike[]; site: CallSite }
  | { kind: "unresolved"; site: CallSite; reason: string };

interface Ev { file: string; line: number; endLine?: number; snippet?: string; context?: { startLine: number; lines: string[] } }
interface NodeOut {
  id: string; kind: string; label: string; evidence: Ev[]; confidence: "verified" | "inferred" | "unresolved";
  concepts: string[]; props: Record<string, unknown>;
}
interface EdgeOut {
  id: string; from: string; to: string; protocol: string; lifecycle: string; mode: "sync" | "async"; label?: string;
  evidence: Ev[]; confidence: "verified" | "inferred" | "unresolved"; concepts: string[]; props: Record<string, unknown>;
}
interface FlowOut { id: string; label: string; entry: string; service?: string; steps: { edge: string; note?: string }[] }

interface EdgeOpts {
  protocol: string; lifecycle: string; mode: "sync" | "async"; label?: string; at: Node | Ev;
  props?: Record<string, unknown>; confidence?: EdgeOut["confidence"]; role?: string; concepts?: string[];
}

const FN_KIND_RANK: Record<string, number> = { service: 0, worker: 1, middleware: 2, handler: 2 };
const RESOURCE_TYPES = new Set(["pg-pool", "pg-client", "mysql", "redis-client", "prisma", "mongoose-model", "drizzle"]);

/** Analyzes a repository and returns a validated Trace Spec. */
export function analyzeRepo(root: string, options: AnalyzeOptions = {}): TraceSpec {
  const repo = loadRepo(root);
  return new Analyzer(repo, options).run();
}

class Analyzer {
  readonly r: Resolver;
  readonly infra: Infra;
  private nodes = new Map<string, NodeOut>();
  private edges = new Map<string, EdgeOut>();
  private flows: FlowOut[] = [];
  private gaps: { id: string; refs: string[]; reason: string; evidence: Ev[] }[] = [];
  private services: { id: string; kind: string; label: string; evidence: Ev[]; props: Record<string, unknown> }[] = [];
  private steps = new Map<Owner, Step[]>();
  private sig = new Map<Owner, boolean>();
  private routes: Route[] = [];
  private resourceIds = new Map<Handle, string>();
  private wsIds = new Map<Handle, string>();
  private wsAccept = new Map<string, { fn: FunctionLike; at: Node }[]>();
  private wsDeliver = new Map<string, { fn: FunctionLike; at: Node }[]>();
  private wsHasClient = new Set<string>();
  private fileServices = new Map<string, string>();
  private clientFiles = new Set<SourceFile>();
  private next = false;

  readonly repo: Repo;
  readonly options: AnalyzeOptions;

  constructor(repo: Repo, options: AnalyzeOptions) {
    this.repo = repo;
    this.options = options;
    this.r = new Resolver(repo, hooks);
    this.infra = readInfra(repo);
  }

  run(): TraceSpec {
    this.next = isNextApp(this.repo);
    // Resolve every call once so all handles exist before ids are assigned.
    for (const c of this.r.calls()) this.r.value(c);
    for (const f of this.repo.files) if (this.isClientFile(f)) this.clientFiles.add(f);
    this.assignResourceIds();
    this.routes = [...extractExpressRoutes(this.r), ...extractNextRoutes(this.r, this.repo)];
    this.buildServices();
    this.collectWebSockets();

    this.routeFlows();
    this.webSocketFlows();
    this.subscriptionFlows();
    this.consumerFlows();
    this.timerFlows();
    this.frontendFlows();

    return this.finish();
  }

  // ------------------------------------------------------------- evidence

  ev(node: Node): Ev {
    const file = relPath(this.repo, node.getSourceFile());
    const line = node.getStartLineNumber();
    return this.evAt(file, line);
  }

  evAt(file: string, line: number): Ev {
    if (!this.repo.lines.has(file)) {
      try {
        this.repo.lines.set(file, readFileSync(path.join(this.repo.root, file), "utf8").split("\n"));
      } catch {
        this.repo.lines.set(file, []);
      }
    }
    const lines = this.repo.lines.get(file) ?? [];
    const text = lines[line - 1]?.trim();
    const ev: Ev = text ? { file, line, snippet: truncate(text, 200) } : { file, line };
    if (this.options.includeSource !== false && lines.length) {
      const start = Math.max(1, line - 4);
      const end = Math.min(lines.length, line + 5);
      ev.context = { startLine: start, lines: lines.slice(start - 1, end).map((l) => truncate(l.replace(/\t/g, "  "), 400)) };
    }
    return ev;
  }

  // ---------------------------------------------------------------- nodes

  private addNode(n: Omit<NodeOut, "concepts" | "props" | "confidence"> & Partial<NodeOut>): string {
    const existing = this.nodes.get(n.id);
    if (existing) {
      if ((FN_KIND_RANK[n.kind] ?? -1) > (FN_KIND_RANK[existing.kind] ?? 99)) existing.kind = n.kind;
      return n.id;
    }
    this.nodes.set(n.id, { confidence: "verified", concepts: [], props: {}, ...n });
    return n.id;
  }

  private fnId(fn: FunctionLike): string {
    return `fn:${relPath(this.repo, fn.getSourceFile())}#${functionKeyName(fn)}`;
  }

  private fnNode(fn: FunctionLike, kind: string, label?: string, forceLabel = false): string {
    const name = functionName(fn);
    const id = this.fnId(fn);
    return this.addNode({
      id, kind,
      label: label && (forceLabel || !name) ? label : `${moduleLabel(fn.getSourceFile())}.${name ?? `anonymous@${fn.getStartLineNumber()}`}`,
      evidence: [this.ev(fn)],
      props: {
        file: relPath(this.repo, fn.getSourceFile()), name: name ?? null, line: fn.getStartLineNumber(),
        ...(this.clientFiles.has(fn.getSourceFile()) ? { browser: true } : moduleStateProps(this.r, fn)),
      },
    });
  }

  private routeNode(route: Route): string {
    return this.addNode({
      id: `route:${route.method}:${route.path}`, kind: "route", label: `${route.method} ${route.path}`,
      evidence: [this.ev(route.registeredAt)], concepts: ["http-request-lifecycle"],
      props: { method: route.method, path: route.path },
    });
  }

  private libMiddlewareNode(h: Handle): string {
    const name = String(h.data.name ?? h.lib);
    const ev = this.ev(h.created);
    const concepts = name === "express-rate-limit" ? ["rate-limiting"] : [];
    return this.addNode({
      id: `mw:${name}@${ev.file}:${ev.line}`, kind: "middleware", label: name, evidence: [ev], concepts,
      props: { library: name, builtin: true },
    });
  }

  private clientNode(): string {
    const first = this.routes[0]?.registeredAt;
    return this.addNode({
      id: "client:http", kind: "client", label: "HTTP client (browser, app, curl)",
      evidence: [first ? this.ev(first) : this.evAt("package.json", 1)],
      props: {},
    });
  }

  private unknownNode(at: Node, reason: string): string {
    const ev = this.ev(at);
    const id = `unknown:${ev.file}:${ev.line}`;
    this.addNode({ id, kind: "unknown", label: truncate(at.getText().split("\n")[0]!, 60), evidence: [ev], confidence: "unresolved", props: { reason } });
    return id;
  }

  private assignResourceIds() {
    const roots = this.r.allHandles().filter((h) => h.root === h && RESOURCE_TYPES.has(h.type));
    const provider = prismaProvider(this.repo.root);
    const byEngine = new Map<string, Handle[]>();
    for (const h of roots) {
      const engine = h.type === "prisma" ? provider : engineOf(h);
      byEngine.set(engine, [...(byEngine.get(engine) ?? []), h]);
    }
    for (const [engine, all] of byEngine) {
      // ORMs with one shared connection (every Mongoose model, every PrismaClient) are one database.
      const shared = all.filter((h) => h.type === "mongoose-model" || h.type === "prisma");
      const handles = [...all.filter((h) => !shared.includes(h)), ...shared.slice(0, 1)];
      for (const h of handles) {
        const ev = this.ev(h.created);
        const isCache = engine === "redis";
        const base = isCache ? `cache:${engine}` : `db:${engine}`;
        const id = handles.length === 1 ? base : `${base}@${ev.file}:${ev.line}`;
        this.resourceIds.set(h, id);
        if (shared.includes(h)) for (const other of shared) this.resourceIds.set(other, id);
        const poolMax = h.data.poolMax as number | undefined;
        const tables = (engine === "postgres" || engine === "mysql") && h.type !== "prisma" ? this.tablesProp() : undefined;
        const lib = h.lib;
        this.nodes.set(id, {
          id, kind: isCache ? "cache" : "database", evidence: [ev], confidence: "verified",
          label: isCache ? `Redis (${lib === "redis" ? "node-redis" : lib})` : `${engineLabel(engine)} (${lib === "@prisma/client" ? "Prisma" : lib}${poolMax ? `, pool max ${poolMax}` : ""})`,
          concepts: h.type === "pg-pool" || h.type === "prisma" ? ["connection-pooling"] : [],
          props: { engine, library: lib, ...(poolMax ? { poolMax, poolMaxDefault: h.data.poolMaxDefault } : {}), ...(tables ? { tables } : {}) },
        });
      }
    }
  }

  /** Tables, keys and indexes read from .sql files, for the database node's inspector. */
  private tablesProp(): Record<string, unknown> | undefined {
    if (!this.repo.sqlSchema.size) return undefined;
    const out: Record<string, unknown> = {};
    for (const [name, t] of this.repo.sqlSchema) {
      out[name] = {
        columns: t.columns, file: t.file, line: t.line,
        indexes: t.indexes.map((i) => ({ name: i.name, columns: i.columns, unique: i.unique, source: i.source, file: i.file, line: i.line })),
        redundant: redundantIndexes(t).map((x) => ({ index: x.index.name, coveredBy: x.coveredBy.name, file: x.index.file, line: x.index.line })),
      };
    }
    return out;
  }

  // ---------------------------------------------------------------- edges

  private addEdge(from: string, to: string, o: EdgeOpts): string {
    const ev = o.at instanceof Node ? this.ev(o.at) : o.at;
    const id = `e:${shortHash(`${from}|${to}|${ev.file}:${ev.line}|${o.role ?? ""}`)}`;
    if (!this.edges.has(id)) {
      this.edges.set(id, {
        id, from, to, protocol: o.protocol, lifecycle: o.lifecycle, mode: o.mode, ...(o.label ? { label: o.label } : {}),
        evidence: [ev], confidence: o.confidence ?? "verified", concepts: o.concepts ?? [],
        props: { ...(o.role ? { role: o.role } : {}), ...(o.props ?? {}) },
      });
    }
    return id;
  }

  private inProcess(from: string, to: string, at: Node, props: Record<string, unknown> = {}, label?: string): string {
    return this.addEdge(from, to, { protocol: "in-process", lifecycle: "none", mode: "sync", at, props, label });
  }

  // ---------------------------------------------------------- call graph

  private stepsOf(owner: Owner): Step[] {
    const cached = this.steps.get(owner);
    if (cached) return cached;
    const out: Step[] = [];
    this.steps.set(owner, out);
    for (const site of callSites(owner)) {
      const op = classifyOp(this.r, site.call);
      if (op) {
        out.push({ kind: "op", op, site });
        continue;
      }
      if (!Node.isCallExpression(site.call)) continue;
      const calleeNode = site.call.getExpression();
      const v = this.r.value(calleeNode);
      const fns = functionsOf(v).filter((f) => this.isUserCode(f));
      const paramIndex = isFunctionLike(owner) ? ownParamIndex(this.r, owner, calleeNode) : -1;
      if (paramIndex >= 0) {
        if (fns.length) out.push({ kind: "param", index: paramIndex, fns, site });
        continue;
      }
      if (fns.length === 1 && v.kind === "function") {
        // Only plumbing around a resource client is inlined (db.query -> pool.query);
        // named wrappers around libraries (hashPassword -> bcrypt) stay visible.
        const fw = forwardedCall(fns[0]!);
        const fwOp = fw && this.r.value(fw.getExpression()).kind === "member" ? classifyOp(this.r, fw, site.call.getArguments()) : undefined;
        if (fwOp && fw) out.push({ kind: "op", op: { ...fwOp, props: { ...fwOp.props, via: this.ev(fw) } }, site });
        else out.push({ kind: "call", fn: fns[0]!, site, rpc: this.isServerActionCall(owner, fns[0]!) });
      } else if (fns.length >= 1) {
        out.push({ kind: "dispatch", fns, site });
      } else if (v.kind === "unknown" && isDynamicCallee(this.r, calleeNode)) {
        out.push({ kind: "unresolved", site, reason: "The function is picked at runtime (dynamic lookup), so the parser cannot tell what runs." });
      }
    }
    return out;
  }

  /** A function matters if it, or anything it calls, does I/O. */
  private significant(owner: Owner): boolean {
    const known = this.sig.get(owner);
    if (known !== undefined) return known;
    const seen = new Set<Owner>();
    const order: Owner[] = [];
    const discover = (o: Owner) => {
      if (seen.has(o) || this.sig.has(o)) return;
      seen.add(o);
      for (const s of this.stepsOf(o)) {
        if (s.kind === "call") discover(s.fn);
        if (s.kind === "dispatch" || s.kind === "param") s.fns.forEach(discover);
      }
      order.push(o);
    };
    discover(owner);
    const local = new Map<Owner, boolean>();
    const get = (o: Owner) => this.sig.get(o) ?? local.get(o) ?? false;
    for (const o of order) local.set(o, this.stepsOf(o).some((s) => s.kind === "op" || s.kind === "unresolved" || s.kind === "dispatch"));
    for (let changed = true; changed; ) {
      changed = false;
      for (const o of order) {
        if (get(o)) continue;
        if (this.stepsOf(o).some((s) => (s.kind === "call" && get(s.fn)) || (s.kind === "param" && s.fns.some(get)))) {
          local.set(o, true);
          changed = true;
        }
      }
    }
    for (const [o, v] of local) this.sig.set(o, v);
    return this.sig.get(owner) ?? false;
  }

  /** A client component calling a "use server" function crosses the network. */
  private isServerActionCall(owner: Owner, fn: FunctionLike): boolean {
    const ownerFile = Node.isSourceFile(owner) ? owner : owner.getSourceFile();
    return this.next && this.clientFiles.has(ownerFile) && isServerAction(fn);
  }

  private isUserCode(fn: FunctionLike): boolean {
    const sf = fn.getSourceFile();
    return !sf.isDeclarationFile() && !sf.isInNodeModules();
  }

  // ---------------------------------------------------------------- flows

  /** `binding` is the call that entered `owner`, used to resolve callbacks passed as arguments. */
  private expand(flow: FlowState, owner: Owner, nodeId: string, binding?: CallExpression | NewExpression) {
    if (flow.expanded.has(nodeId)) return;
    flow.expanded.add(nodeId);
    for (const step of this.stepsOf(owner)) {
      const ctx = siteProps(step.site);
      if (step.kind === "op") {
        this.expandOp(flow, nodeId, step.op, step.site, ctx);
      } else if (step.kind === "call") {
        if (!this.significant(step.fn)) continue;
        const callee = this.fnNode(step.fn, "service");
        if (step.rpc) {
          flow.push(this.addEdge(nodeId, callee, {
            protocol: "http", lifecycle: "pooled", mode: "sync", at: step.site.call, label: "Server Action: the browser POSTs to the Next.js server",
            props: { ...ctx, serverAction: true },
          }));
        } else {
          flow.push(this.inProcess(nodeId, callee, step.site.call, ctx));
        }
        this.expand(flow, step.fn, callee, step.site.call);
      } else if (step.kind === "param") {
        const arg = binding?.getArguments()[step.index];
        const bound = arg ? functionsOf(this.r.value(arg)).filter((f) => this.isUserCode(f)) : [];
        const fns = (bound.length ? bound : step.fns).filter((f) => this.significant(f));
        for (const fn of fns) {
          const callee = this.fnNode(fn, "service");
          const rpc = this.isServerActionCall(owner, fn);
          const label = fns.length > 1 ? `one of ${fns.length} callbacks, chosen by the caller` : "calls the function it was given";
          flow.push(rpc
            ? this.addEdge(nodeId, callee, { protocol: "http", lifecycle: "pooled", mode: "sync", at: step.site.call, label: "Server Action: the browser POSTs to the Next.js server", props: { ...ctx, serverAction: true } })
            : this.inProcess(nodeId, callee, step.site.call, { ...ctx, callback: true }, label));
          this.expand(flow, fn, callee, step.site.call);
        }
      } else if (step.kind === "dispatch") {
        for (const fn of step.fns) {
          const callee = this.fnNode(fn, "worker");
          flow.push(this.inProcess(nodeId, callee, step.site.call, { ...ctx, dispatch: true, candidates: step.fns.length },
            `one of ${step.fns.length} handlers, chosen at runtime`));
          this.expand(flow, fn, callee);
        }
      } else {
        const unknown = this.unknownNode(step.site.call, step.reason);
        const edge = this.addEdge(nodeId, unknown, { protocol: "unknown", lifecycle: "unknown", mode: "sync", at: step.site.call, confidence: "unresolved", props: ctx });
        flow.push(edge);
        this.addGap([unknown, edge], step.reason, step.site.call);
      }
    }
  }

  private expandOp(flow: FlowState, from: string, op: Op, site: CallSite, ctx: Record<string, unknown>) {
    const props = { ...op.props, ...ctx };
    const t = op.target;
    const base = { protocol: op.protocol, lifecycle: op.lifecycle, mode: op.mode, label: op.label, at: site.call, props, role: op.role };
    if (t.type === "url") {
      const resolved = this.resolveUrl(t.method, t.url);
      if (!resolved.route && t.envBase) {
        // Base URL from an env var and no matching route here: an external service named after the variable.
        const to = this.externalNode(t.envBase.toLowerCase().replace(/_/g, "-"), undefined, site.call, `External API (${t.envBase})`);
        flow.push(this.addEdge(from, to, base));
        return;
      }
      if (resolved.route) {
        const to = this.routeNode(resolved.route);
        flow.push(this.addEdge(from, to, { ...base, label: `${t.method} ${resolved.route.path}` }));
        this.expandRoute(flow, resolved.route);
      } else if (resolved.external) {
        const to = this.externalNode(resolved.external, resolved.external, site.call);
        flow.push(this.addEdge(from, to, base));
      } else if (!this.clientFiles.has(site.call.getSourceFile())) {
        // Server-side fetch needs an absolute URL, so this is certainly an outbound call;
        // only the host is decided at runtime.
        const owner = site.call.getFirstAncestor((a) => isFunctionLike(a)) as FunctionLike | undefined;
        const name = owner ? functionName(owner) : undefined;
        const to = this.externalNode(`runtime-${name ?? "url"}`, undefined, site.call, `External API${name ? ` called by ${name}` : ""} (URL built at runtime)`);
        flow.push(this.addEdge(from, to, { ...base, props: { ...base.props, runtimeUrl: true } }));
      } else {
        const unknown = this.unknownNode(site.call, `No route in this repo matches ${t.method} ${t.url}.`);
        const edge = this.addEdge(from, unknown, { ...base, confidence: "unresolved" });
        flow.push(edge);
        this.addGap([unknown, edge], `No route in this repo matches ${t.method} ${t.url}.`, site.call);
      }
      return;
    }
    if (t.type === "ws") {
      const wsId = t.server ? this.wsIds.get(t.server.root) : this.matchWs(t.url);
      if (!wsId) return;
      flow.push(this.addEdge(from, wsId, base));
      if (op.role === "push") {
        for (const d of this.wsDeliver.get(wsId) ?? []) {
          const to = this.fnNode(d.fn, "handler", "on WebSocket message (browser)");
          flow.push(this.addEdge(wsId, to, { protocol: "ws", lifecycle: "persistent", mode: "async", at: d.at, role: "deliver", label: "message arrives in the browser" }));
          this.expand(flow, d.fn, to);
        }
      } else {
        this.expandAccept(flow, wsId);
      }
      return;
    }
    const to = this.targetNode(t, site.call);
    if (!to) return;
    flow.push(this.addEdge(from, to, base));
  }

  private expandAccept(flow: FlowState, wsId: string) {
    for (const a of this.wsAccept.get(wsId) ?? []) {
      const to = this.fnNode(a.fn, "handler", "on WebSocket connection");
      flow.push(this.addEdge(wsId, to, { protocol: "in-process", lifecycle: "none", mode: "sync", at: a.at, role: "accept", label: "server accepts the connection" }));
      this.expand(flow, a.fn, to);
    }
  }

  private expandRoute(flow: FlowState, route: Route) {
    const routeId = this.routeNode(route);
    if (flow.expanded.has(routeId)) return;
    flow.expanded.add(routeId);
    let prev = routeId;
    route.chain.forEach((el, i) => {
      const last = i === route.chain.length - 1;
      const id = this.elementNode(el, last, route);
      flow.push(this.inProcess(prev, id, el.registeredAt, el.wrappedBy ? { wrappedBy: el.wrappedBy } : {}));
      if (el.kind === "fn" && el.fn) this.expand(flow, el.fn, id);
      if (el.kind === "lib" && el.handle) this.libraryEdges(flow, el.handle, id);
      if (el.kind === "unknown") {
        this.addGap([id], "This middleware is not a plain function or a known library, so the parser cannot see what it does.", el.node);
      }
      prev = id;
    });
  }

  private elementNode(el: ChainElement, last: boolean, route: Route): string {
    if (el.kind === "fn" && el.fn) {
      if (el.factoryCall) {
        const factory = el.factoryCall.split("(")[0]!.trim();
        return this.fnNode(el.fn, last ? "handler" : "middleware", `${factory}(…) middleware`, true);
      }
      const label = last ? `${route.method} ${route.path} ${route.page ? "page (server render)" : "handler"}` : "middleware";
      return this.fnNode(el.fn, last ? "handler" : "middleware", label, route.framework === "next");
    }
    if (el.kind === "lib" && el.handle) return this.libMiddlewareNode(el.handle);
    return this.unknownNode(el.node, "Unknown middleware.");
  }

  /** Resources a library middleware uses internally, e.g. a Redis store for rate limits. */
  private libraryEdges(flow: FlowState, h: Handle, mwId: string) {
    const created = h.created;
    if (h.data.name === "passport.session") this.passportSessionEdges(flow, mwId);
    if (!Node.isCallExpression(created)) return;
    if (h.data.name === "express-session") this.sessionStoreEdge(flow, created, mwId);
    for (const arg of created.getArguments()) {
      arg.forEachDescendant((n) => {
        if (!Node.isIdentifier(n)) return;
        const handle = pick(this.r.value(n), "handle")?.handle;
        if (!handle || !RESOURCE_TYPES.has(handle.type)) return;
        const id = this.resourceIds.get(handle.root);
        if (!id) return;
        const at = n.getFirstAncestor((a) => Node.isNewExpression(a)) ?? n;
        const isRedis = handle.type === "redis-client";
        flow.push(this.addEdge(mwId, id, {
          protocol: isRedis ? "redis" : "sql", lifecycle: isRedis ? "persistent" : "pooled", mode: "sync", at,
          label: isRedis ? "keep counters in Redis (shared by every instance)" : "store state in the database",
        }));
      });
    }
  }

  /** express-session with a store: every request reads (and may write) the session there. */
  private sessionStoreEdge(flow: FlowState, call: CallExpression, mwId: string) {
    const opts = this.r.value(call.getArguments()[0]);
    if (opts.kind !== "object") return;
    const prop = (opts.node as any).getProperties().find((p: Node) => Node.isPropertyAssignment(p) && p.getName() === "store") as Node | undefined;
    const init = prop && Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    if (!init) return;
    const origin = this.r.originOf(init);
    const root = Node.isCallExpression(origin) || Node.isNewExpression(origin) ? rootIdentifier(origin.getExpression()) : undefined;
    const pkg = root ? pick(this.r.value(root), "external")?.pkg : undefined;
    const engine = pkg ? SESSION_STORES[pkg] : undefined;
    if (!engine) return;
    const to = this.resourceForEngine(engine, init);
    const isRedis = engine === "redis";
    flow.push(this.addEdge(mwId, to, {
      protocol: isRedis ? "redis" : engine === "mongodb" ? "mongodb" : "sql", lifecycle: isRedis ? "persistent" : "pooled", mode: "sync", at: init,
      label: `load the session from ${engineLabel(engine)} on every request`, props: { sessionStore: pkg },
    }));
  }

  /** passport.session() runs the deserializeUser callback for every request with a session. */
  private passportSessionEdges(flow: FlowState, mwId: string) {
    for (const call of this.r.calls()) {
      if (!Node.isCallExpression(call)) continue;
      const callee = this.r.value(call.getExpression());
      if (callee.kind !== "external" || callee.pkg !== "passport" || callee.path.join(".") !== "deserializeUser") continue;
      const fn = pick(this.r.value(call.getArguments()[0]), "function")?.node;
      if (!fn) continue;
      const handler = this.fnNode(fn, "middleware", "passport deserializeUser");
      flow.push(this.inProcess(mwId, handler, call, {}, "passport loads the user for this session"));
      this.expand(flow, fn, handler);
    }
  }

  /** The resource node for an engine, creating one when no client handle was found. */
  private resourceForEngine(engine: string, at: Node): string {
    for (const [h, id] of this.resourceIds) if ((h.type === "prisma" ? prismaProvider(this.repo.root) : engineOf(h)) === engine) return id;
    const id = engine === "redis" ? "cache:redis" : `db:${engine}`;
    return this.addNode({ id, kind: engine === "redis" ? "cache" : "database", label: engineLabel(engine), evidence: [this.ev(at)], props: { engine } });
  }

  private targetNode(t: Target, at: Node): string | undefined {
    switch (t.type) {
      case "resource":
        return this.resourceIds.get(t.handle.root);
      case "topic":
        return this.addNode({
          id: `topic:${t.channel}`, kind: "topic", label: `${t.broker === "redis" ? "Redis" : t.broker} channel "${t.channel}"`,
          evidence: [this.ev(at)], concepts: ["pub-sub"], props: { channel: t.channel, broker: t.broker },
        });
      case "queue":
        return this.addNode({
          id: `queue:${t.name}`, kind: "queue", label: `queue "${t.name}"`, evidence: [this.ev(at)], concepts: ["message-queue"],
          props: { name: t.name, broker: t.broker },
        });
      case "external":
        return this.externalNode(t.service, t.host, at);
      case "compute":
        return this.addNode({
          id: `compute:${t.name}`, kind: "compute",
          label: `${t.name} (${t.pool === "event-loop" ? "blocks the event loop" : "libuv thread pool"})`,
          evidence: [this.ev(at)], concepts: ["concurrency-models"], props: { library: t.name, pool: t.pool },
        });
      default:
        return undefined;
    }
  }

  private externalNode(service: string, host: string | undefined, at: Node, label?: string): string {
    const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return this.addNode({ id: `ext:${slug}`, kind: "external-api", label: label ?? service, evidence: [this.ev(at)], props: { host: host ?? null } });
  }

  private resolveUrl(method: string, url: string): { route?: Route; external?: string } {
    const abs = /^(https?):\/\/([^/{}]+)/.exec(url);
    if (abs && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(abs[2]!)) return { external: abs[2] };
    let p = url.replace(/^https?:\/\/[^/]*/, "").replace(/^\{\}(?=\/)/, "");
    p = p.split(/[?#]/)[0] ?? "/";
    if (!p.startsWith("/")) return {};
    const segs = p.split("/").filter(Boolean);
    const candidates = this.routes.filter((r) => r.method === method || r.method === "ALL");
    const match = candidates.find((r) => {
      const rs = r.path.split("/").filter(Boolean);
      return rs.length === segs.length && rs.every((s, i) => s.startsWith(":") || segs[i] === "{}" || segs[i] === s);
    });
    return match ? { route: match } : {};
  }

  private matchWs(url: string | undefined): string | undefined {
    const ids = [...this.wsIds.values()];
    if (ids.length === 0) return undefined;
    const p = (url ?? "").replace(/^wss?:\/\/[^/]*/, "").split(/[?#]/)[0] || "/";
    for (const [h, id] of this.wsIds) if (String(h.data.path ?? "/") === p) return id;
    return ids.length === 1 ? ids[0] : undefined;
  }

  private addGap(refs: string[], reason: string, at: Node) {
    const id = `gap:${shortHash(refs.join("|"))}`;
    if (this.gaps.some((g) => g.id === id)) return;
    this.gaps.push({ id, refs, reason, evidence: [this.ev(at)] });
  }

  // -------------------------------------------------------------- entries

  private routeFlows() {
    const proxy = this.infra.proxies[0];
    let proxyId: string | undefined;
    if (proxy && this.routes.length) {
      proxyId = this.addNode({
        id: `proxy:${proxy.name}`, kind: "proxy", label: `${proxy.name} reverse proxy`,
        evidence: [this.evAt(proxy.proxyPass.file, proxy.proxyPass.line)], concepts: ["load-balancer"],
        props: { upstreams: proxy.upstreams, rateLimit: proxy.rateLimit ?? null },
      });
    }
    for (const route of [...this.routes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))) {
      const flow = new FlowState();
      const client = this.clientNode();
      const routeId = this.routeNode(route);
      if (proxy && proxyId) {
        flow.push(this.addEdge(client, proxyId, { protocol: "http", lifecycle: "pooled", mode: "sync", at: this.evAt(proxy.listen.file, proxy.listen.line), label: "request hits the proxy" }));
        flow.push(this.addEdge(proxyId, routeId, { protocol: "http", lifecycle: "pooled", mode: "sync", at: this.evAt(proxy.proxyPass.file, proxy.proxyPass.line), label: "proxy_pass to the app" }));
      } else {
        flow.push(this.addEdge(client, routeId, { protocol: "http", lifecycle: "pooled", mode: "sync", at: route.registeredAt, label: `${route.method} ${route.path}` }));
      }
      this.expandRoute(flow, route);
      this.addFlow(`flow:route:${route.method}:${route.path}`, `${route.method} ${route.path}${route.page ? " (page)" : ""}`, "client:http", flow, this.serviceOf(route.app));
    }
  }

  private collectWebSockets() {
    const servers = this.r.allHandles().filter((h) => (h.type === "ws-server" || h.type === "sio-server") && h.root === h);
    for (const h of servers) {
      const p = String(h.data.path ?? "/");
      const ev = this.ev(h.created);
      const id = servers.length === 1 || !servers.some((o) => o !== h && String(o.data.path ?? "/") === p) ? `ws:${p}` : `ws:${p}@${ev.file}:${ev.line}`;
      this.wsIds.set(h, id);
      this.addNode({ id, kind: "ws-endpoint", label: `WebSocket ${p}`, evidence: [ev], concepts: ["websocket"], props: { path: p, library: h.lib } });
    }
    for (const call of this.r.calls()) {
      if (!Node.isCallExpression(call)) continue;
      const callee = this.r.value(call.getExpression());
      const event = stringValue(this.r.value(call.getArguments()[0]));
      const fn = pick(this.r.value(call.getArguments()[1]), "function")?.node;
      if (callee.kind === "member" && callee.path.join(".") === "on" && event === "connection" && fn) {
        const id = this.wsIds.get(callee.handle.root);
        if (id) this.wsAccept.set(id, [...(this.wsAccept.get(id) ?? []), { fn, at: call }]);
      }
      if (callee.kind === "member" && callee.handle.type === "browser-ws" && callee.path.join(".") === "addEventListener" && event === "message" && fn) {
        this.addDeliver(callee.handle, fn, call);
      }
    }
    for (const file of this.repo.files) {
      file.forEachDescendant((n) => {
        if (!Node.isBinaryExpression(n) || n.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;
        const left = n.getLeft();
        if (!Node.isPropertyAccessExpression(left) || left.getName() !== "onmessage") return;
        const h = pick(this.r.value(left.getExpression()), "handle")?.handle;
        const fn = pick(this.r.value(n.getRight()), "function")?.node;
        if (h?.type === "browser-ws" && fn) this.addDeliver(h, fn, n);
      });
    }
    // socket.io with an adapter (Redis, Postgres) fans out across instances.
    for (const call of this.r.calls()) {
      if (!Node.isCallExpression(call)) continue;
      const callee = this.r.value(call.getExpression());
      if (callee.kind === "member" && callee.handle.type === "sio-server" && callee.path.join(".") === "adapter") {
        const id = this.wsIds.get(callee.handle.root);
        const node = id ? this.nodes.get(id) : undefined;
        if (node) node.props.backplane = true;
      }
    }
    for (const h of this.r.allHandles()) {
      if (h.type !== "browser-ws") continue;
      const id = this.matchWs(h.data.url as string | undefined);
      if (id) this.wsHasClient.add(id);
    }
  }

  private addDeliver(browserWs: Handle, fn: FunctionLike, at: Node) {
    const id = this.matchWs(browserWs.data.url as string | undefined);
    if (id) this.wsDeliver.set(id, [...(this.wsDeliver.get(id) ?? []), { fn, at }]);
  }

  private webSocketFlows() {
    for (const [h, id] of this.wsIds) {
      if (this.wsHasClient.has(id) || !(this.wsAccept.get(id)?.length)) continue;
      const flow = new FlowState();
      flow.push(this.addEdge(this.clientNode(), id, { protocol: "ws", lifecycle: "persistent", mode: "async", at: h.created, role: "connect", label: "client opens a WebSocket" }));
      this.expandAccept(flow, id);
      this.addFlow(`flow:${id}`, `WebSocket connection ${String(h.data.path ?? "/")}`, "client:http", flow, this.serviceOf(h.created));
    }
  }

  private subscriptionFlows() {
    for (const call of this.r.calls()) {
      if (!Node.isCallExpression(call)) continue;
      const callee = this.r.value(call.getExpression());
      if (callee.kind !== "member" || callee.handle.type !== "redis-client") continue;
      const method = callee.path.join(".");
      if (method !== "subscribe" && method !== "pSubscribe" && method !== "psubscribe") continue;
      const channel = stringValue(this.r.value(call.getArguments()[0]));
      const fn = pick(this.r.value(call.getArguments()[1]), "function")?.node;
      if (!channel || !fn) continue;
      const topic = this.targetNode({ type: "topic", channel, broker: "redis" }, call)!;
      const flow = new FlowState();
      const handler = this.fnNode(fn, "handler", `on "${channel}" message`);
      flow.push(this.addEdge(topic, handler, { protocol: "redis", lifecycle: "persistent", mode: "async", at: call, label: "subscriber receives the message", role: "deliver" }));
      this.expand(flow, fn, handler);
      this.addFlow(`flow:topic:${channel}:${call.getStartLineNumber()}`, `On "${channel}" message`, topic, flow, this.serviceOf(call));
    }
  }

  private timerFlows() {
    for (const call of this.r.calls()) {
      if (!Node.isCallExpression(call)) continue;
      const callee = this.r.value(call.getExpression());
      if (callee.kind !== "global") continue;
      const name = callee.path.join(".");
      if (name !== "setInterval" && name !== "setTimeout" && name !== "window.setInterval") continue;
      const fn = pick(this.r.value(call.getArguments()[0]), "function")?.node;
      if (!fn || !this.isUserCode(fn)) continue;
      const loop = name === "setTimeout";
      if (loop && enclosingFunction(call) !== fn) continue; // only self-rescheduling loops
      if (!this.significant(fn)) continue;
      const msNode = call.getArguments()[1];
      const ms = msNode ? numericValue(this.r, msNode) ?? intervalHint(this.r, msNode) : undefined;
      const ev = this.ev(call);
      const browser = this.clientFiles.has(call.getSourceFile());
      const label = loop
        ? `Loop: ${functionName(fn) ?? "callback"} reschedules itself${ms !== undefined ? ` (${ms} ms when idle)` : ""}`
        : `Every ${ms !== undefined ? formatMs(ms) : "N ms"}${browser ? " (browser)" : ""}`;
      const timer = this.addNode({
        id: `timer:${ev.file}:${ev.line}`, kind: "timer", label, evidence: [ev],
        concepts: browser ? ["short-polling"] : [], props: { intervalMs: ms ?? null, loop, browser },
      });
      const flow = new FlowState();
      const handler = this.fnNode(fn, "handler", "timer callback");
      flow.push(this.inProcess(timer, handler, call, {}, loop ? "runs again after the delay" : "fires on the interval"));
      this.expand(flow, fn, handler);
      this.addFlow(`flow:${timer}`, label, timer, flow, this.serviceOf(call));
    }
  }

  /** Queue consumers: BullMQ `new Worker(name, fn)` and Bull `queue.process(fn)`. */
  private consumerFlows() {
    for (const call of this.r.calls()) {
      let name: string | undefined;
      let fn: FunctionLike | undefined;
      const callee = this.r.value(call.getExpression());
      if (Node.isNewExpression(call) && callee.kind === "external" && callee.pkg === "bullmq" && callee.path.join(".") === "Worker") {
        name = stringValue(this.r.value(call.getArguments()[0]));
        fn = pick(this.r.value(call.getArguments()[1]), "function")?.node;
      } else if (Node.isCallExpression(call) && callee.kind === "member" && callee.handle.type === "bull-queue" && callee.path.join(".") === "process") {
        name = String(callee.handle.data.name ?? "queue");
        fn = [...call.getArguments()].reverse().map((a) => pick(this.r.value(a), "function")?.node).find(Boolean);
      }
      if (!name || !fn) continue;
      const queue = this.targetNode({ type: "queue", name, broker: "redis" }, call)!;
      const flow = new FlowState();
      const worker = this.fnNode(fn, "worker", `"${name}" job processor`);
      flow.push(this.addEdge(queue, worker, { protocol: "redis", lifecycle: "persistent", mode: "async", at: call, role: "deliver", label: "worker picks up the job" }));
      this.expand(flow, fn, worker);
      this.addFlow(`flow:queue:${name}:${call.getStartLineNumber()}`, `Worker: "${name}" jobs`, queue, flow, this.serviceOf(call));
    }
  }

  /** JSX event handlers and useEffect bodies in client components. */
  private componentFlows(file: SourceFile) {
    const rel = relPath(this.repo, file);
    file.forEachDescendant((n) => {
      if (Node.isJsxAttribute(n)) {
        const event = n.getNameNode().getText();
        const init = n.getInitializer();
        if (!/^on[A-Z]/.test(event) || !init || !Node.isJsxExpression(init)) return;
        const fn = pick(this.r.value(init.getExpression()), "function")?.node;
        if (!fn || !this.significant(fn)) return;
        const owner = n.getParent()?.getParent();
        const tag = owner && (Node.isJsxOpeningElement(owner) || Node.isJsxSelfClosingElement(owner)) ? owner.getTagNameNode().getText() : "element";
        const el = owner?.getParent();
        const text = el && Node.isJsxElement(el) ? el.getJsxChildren().map((c) => (Node.isJsxText(c) ? c.getText() : "")).join(" ").replace(/\s+/g, " ").trim() : "";
        const label = `${event} <${tag}>${text ? ` "${truncate(text, 30)}"` : ""}`;
        const ev = this.ev(n);
        const ui = this.addNode({ id: `ui:${ev.file}:${ev.line}`, kind: "ui-event", label, evidence: [ev], props: { event, tag } });
        const flow = new FlowState();
        const handler = this.fnNode(fn, "handler", `${event} handler`);
        flow.push(this.inProcess(ui, handler, n));
        this.expand(flow, fn, handler);
        this.addFlow(`flow:${ui}`, label, ui, flow, this.serviceOf(file));
      } else if (Node.isCallExpression(n)) {
        const callee = this.r.value(n.getExpression());
        const hook = callee.kind === "external" && callee.pkg === "react" ? callee.path.join(".") : undefined;
        if (hook !== "useEffect" && hook !== "useLayoutEffect") return;
        const fn = pick(this.r.value(n.getArguments()[0]), "function")?.node;
        if (!fn || !this.significant(fn)) return;
        const component = n.getFirstAncestor((a) => isFunctionLike(a)) as FunctionLike | undefined;
        const name = component ? functionName(component) ?? "component" : "component";
        const label = `On mount: ${name}`;
        const ev = this.ev(n);
        const ui = this.addNode({ id: `ui:${ev.file}:${ev.line}`, kind: "ui-event", label, evidence: [ev], props: { event: "mount", component: name } });
        const flow = new FlowState();
        const handler = this.fnNode(fn, "handler", `${name} effect`);
        flow.push(this.inProcess(ui, handler, n));
        this.expand(flow, fn, handler);
        this.addFlow(`flow:${ui}`, label, ui, flow, this.serviceOf(file));
      }
    });
    void rel;
  }

  private frontendFlows() {
    for (const file of this.clientFiles) this.componentFlows(file);
    for (const file of this.clientFiles) {
      if (!isInlineScript(file) && file.getStatements().some((s) => Node.isImportDeclaration(s))) continue;
      if (!this.significant(file)) continue;
      const rel = relPath(this.repo, file);
      const firstCall = callSites(file)[0]?.call ?? file.getStatements()[0];
      const ui = this.addNode({
        id: `ui:${rel}#load`, kind: "ui-event", label: `Page load: ${path.basename(rel)}`,
        evidence: [firstCall ? this.ev(firstCall) : this.evAt(rel, 1)], props: { event: "load" },
      });
      const flow = new FlowState();
      this.expand(flow, file, ui);
      this.addFlow(`flow:${ui}`, `Page load: ${path.basename(rel)}`, ui, flow, this.serviceOf(file));
    }
  }

  private addFlow(id: string, label: string, entry: string, flow: FlowState, service?: string) {
    if (flow.steps.length === 0) return;
    let unique = id;
    for (let i = 2; this.flows.some((f) => f.id === unique); i++) unique = `${id}#${i}`;
    this.flows.push({ id: unique, label, entry, ...(service ? { service } : {}), steps: flow.steps.map((edge) => ({ edge })) });
  }

  // ------------------------------------------------------------- services

  private buildServices() {
    const graph = this.moduleGraph();
    for (const p of this.infra.processes) {
      const start = this.repo.byPath.get(path.join(this.repo.root, p.file));
      if (!start) continue;
      const reach = reachable(graph, start);
      const http = this.r.allHandles().some((h) => h.type === "express-app" && reach.has(h.created.getSourceFile()))
        || this.r.allHandles().some((h) => h.type === "http-server" && reach.has(h.created.getSourceFile()));
      const id = `svc:${p.name}`;
      if (this.services.some((s) => s.id === id)) continue;
      this.services.push({ id, kind: http ? "http-server" : "worker", label: `${p.name} (${p.file})`, evidence: [this.evAt(p.evidence.file, p.evidence.line)], props: { entry: p.file } });
      for (const f of reach) {
        const rel = relPath(this.repo, f);
        if (!this.fileServices.has(rel)) this.fileServices.set(rel, id);
      }
    }
    for (const file of this.clientFiles) {
      const rel = relPath(this.repo, file);
      const html = isInlineScript(file);
      const id = html ? `svc:browser:${rel}` : "svc:browser";
      if (!this.services.some((s) => s.id === id)) {
        this.services.push({ id, kind: "frontend", label: html ? `${path.basename(rel)} (browser)` : "Browser (client components)", evidence: [this.evAt(rel, 1)], props: {} });
      }
      this.fileServices.set(rel, id);
    }
    if (this.next) {
      const pkgLine = this.evAt("package.json", 1);
      this.services.push({ id: "svc:next", kind: "http-server", label: "Next.js server", evidence: [pkgLine], props: { framework: "next" } });
      for (const f of this.repo.files) {
        const rel = relPath(this.repo, f);
        if (!this.fileServices.has(rel)) this.fileServices.set(rel, "svc:next");
      }
    }
    for (const d of this.infra.datastores) {
      this.services.push({ id: `svc:${d.name}`, kind: "datastore", label: `${d.name} (${d.image})`, evidence: [this.evAt(d.evidence.file, d.evidence.line)], props: { engine: d.engine } });
    }
    for (const p of this.infra.proxies) {
      this.services.push({ id: `svc:proxy:${p.name}`, kind: "proxy", label: `${p.name}`, evidence: [this.evAt(p.proxyPass.file, p.proxyPass.line)], props: { upstreams: p.upstreams } });
    }
  }

  private serviceOf(node: Node): string | undefined {
    return this.fileServices.get(relPath(this.repo, node.getSourceFile()));
  }

  private moduleGraph(): Map<SourceFile, SourceFile[]> {
    const g = new Map<SourceFile, SourceFile[]>();
    for (const file of this.repo.files) {
      const deps: SourceFile[] = [];
      file.forEachDescendant((n) => {
        let spec: string | undefined;
        if (Node.isCallExpression(n) && n.getExpression().getText() === "require") {
          const a = n.getArguments()[0];
          if (a && Node.isStringLiteral(a)) spec = a.getLiteralText();
        } else if (Node.isImportDeclaration(n) || Node.isExportDeclaration(n)) {
          spec = n.getModuleSpecifierValue();
        }
        if (spec) {
          const target = this.r.resolveModule(spec, file);
          if (target) deps.push(target);
        }
      });
      g.set(file, deps);
    }
    return g;
  }

  // ---------------------------------------------------------------- misc

  private isClientFile(file: SourceFile): boolean {
    if (isInlineScript(file)) return true;
    const text = file.getFullText();
    if (/^\s*["']use client["']/.test(text)) return true;
    if (this.next) return false; // App Router: server components unless marked "use client"
    if (/\.(jsx|tsx)$/.test(file.getFilePath()) && /<[A-Za-z]/.test(text) && !/["']use server["']/.test(text)) return true;
    const rel = relPath(this.repo, file);
    return /(^|\/)(public|static|client|frontend)\//.test(rel) && /\b(document|window)\./.test(text);
  }

  private finish(): TraceSpec {
    const pkg = this.repo.packageJson ?? {};
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const known = ["express", "next", "react", "pg", "mysql2", "@prisma/client", "mongoose", "redis", "ioredis", "ws", "socket.io", "bullmq", "bull", "@aws-sdk/client-s3", "@supabase/supabase-js", "stripe", "openai"];
    const spec = {
      schemaVersion: "1",
      meta: {
        generatedAt: (this.options.now ?? new Date()).toISOString(),
        generator: { name: "vibesim", version: GENERATOR_VERSION },
        repo: { name: this.options.repoName ?? path.basename(this.repo.root) },
        frameworks: known.filter((k) => k in deps),
        stats: {
          filesAnalyzed: this.repo.files.length,
          routes: this.routes.length,
          flows: this.flows.length,
          unresolved: this.gaps.length,
        },
      },
      services: this.services,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
      flows: this.flows,
      findings: [],
      gaps: this.gaps,
    };
    const first = validateTraceSpec(spec);
    if (!first.ok) throw new Error(`extractor produced an invalid spec:\n${first.issues.slice(0, 20).join("\n")}`);
    const findings = runFindings(first.spec);
    const result = validateTraceSpec({ ...first.spec, meta: { ...first.spec.meta, stats: { ...first.spec.meta.stats, findings: findings.length } }, findings });
    if (!result.ok) throw new Error(`findings produced an invalid spec:\n${result.issues.slice(0, 20).join("\n")}`);
    return result.spec;
  }
}

class FlowState {
  steps: string[] = [];
  used = new Set<string>();
  expanded = new Set<string>();
  push(edgeId: string) {
    if (this.used.has(edgeId)) return;
    this.used.add(edgeId);
    this.steps.push(edgeId);
  }
}

function functionsOf(v: Value): FunctionLike[] {
  if (v.kind === "function") return [v.node];
  if (v.kind === "choice") return v.options.flatMap((o) => (o.kind === "function" ? [o.node] : []));
  return [];
}

function isDynamicCallee(r: Resolver, callee: Node): boolean {
  if (Node.isElementAccessExpression(callee)) return true;
  if (Node.isPropertyAccessExpression(callee) && Node.isElementAccessExpression(callee.getExpression())) return true;
  if (Node.isIdentifier(callee)) {
    const d = r.declarationOf(callee);
    if (d && Node.isVariableDeclaration(d)) {
      const init = d.getInitializer();
      return !!init && Node.isElementAccessExpression(init);
    }
  }
  return false;
}

/** Module-level Maps, Sets, arrays, objects or `let` counters this function mutates. */
function moduleStateProps(r: Resolver, fn: FunctionLike): Record<string, unknown> {
  const body = fn.getBody();
  if (!body) return {};
  const names = new Set<string>();
  const moduleLevel = (id: Node): string | undefined => {
    if (!Node.isIdentifier(id)) return undefined;
    const d = r.declarationOf(id);
    if (!d || !Node.isVariableDeclaration(d)) return undefined;
    const stmt = d.getParent()?.getParent();
    if (!stmt || !Node.isVariableStatement(stmt) || !Node.isSourceFile(stmt.getParent())) return undefined;
    const init = d.getInitializer();
    const mutableInit = !init || Node.isNewExpression(init) && /^(Map|Set|WeakMap|Array)$/.test(init.getExpression().getText())
      || Node.isArrayLiteralExpression(init) || Node.isObjectLiteralExpression(init) || Node.isNumericLiteral(init);
    if (!mutableInit) return undefined;
    // Collections of live sockets are per-process by nature.
    if (Node.isNewExpression(init ?? id) || Node.isArrayLiteralExpression(init ?? id)) {
      const el = r.elementOf({ kind: "collection", decl: d });
      if (el.kind === "handle" && /socket|ws/.test(el.handle.type)) return undefined;
    }
    return d.getName();
  };
  body.forEachDescendant((n) => {
    if (Node.isCallExpression(n)) {
      const callee = n.getExpression();
      if (Node.isPropertyAccessExpression(callee) && /^(set|add|push|delete|clear|unshift|splice|pop|shift)$/.test(callee.getName())) {
        const name = moduleLevel(callee.getExpression());
        if (name) names.add(name);
      }
    } else if (Node.isBinaryExpression(n) && /^(=|\+=|-=)$/.test(n.getOperatorToken().getText())) {
      const left = n.getLeft();
      const target = Node.isPropertyAccessExpression(left) || Node.isElementAccessExpression(left) ? left.getExpression() : left;
      const name = moduleLevel(target);
      // `client = createClient()` caches a connection; that is not request state.
      const isHandle = r.value(n.getRight()).kind === "handle";
      if (name && !isHandle && (target !== left || r.declarationOf(target)?.getParent()?.getText().startsWith("let"))) names.add(name);
    } else if (Node.isPostfixUnaryExpression(n) || Node.isPrefixUnaryExpression(n)) {
      const name = moduleLevel(n.getOperand());
      if (name) names.add(name);
    }
  });
  return names.size ? { mutatesModuleState: [...names] } : {};
}

/** Index of `owner`'s own parameter that `callee` names, or -1. */
function ownParamIndex(r: Resolver, owner: FunctionLike, callee: Node): number {
  if (!Node.isIdentifier(callee)) return -1;
  const d = r.declarationOf(callee);
  if (!d || !Node.isParameterDeclaration(d) || d.getParent() !== owner) return -1;
  return owner.getParameters().indexOf(d);
}

function hasUseServer(statements: Node[]): boolean {
  const first = statements[0];
  return !!first && Node.isExpressionStatement(first) && /^["']use server["']$/.test(first.getExpression().getText());
}

function isServerAction(fn: FunctionLike): boolean {
  if (hasUseServer(fn.getSourceFile().getStatements())) return true;
  const body = fn.getBody();
  return !!body && Node.isBlock(body) && hasUseServer(body.getStatements());
}

function siteProps(site: CallSite): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (site.inLoop) p.inLoop = true;
  if (site.inLoop && site.loopExits) p.loopExitsEarly = true;
  if (site.parallel) p.parallel = true;
  if (site.errorPath) p.errorPath = true;
  if (site.conditional) p.conditional = true;
  return p;
}

function engineOf(h: Handle): string {
  switch (h.type) {
    case "pg-pool":
    case "pg-client":
      return "postgres";
    case "mysql":
      return "mysql";
    case "mongoose-model":
      return "mongodb";
    case "redis-client":
      return "redis";
    case "prisma":
      return "prisma";
    case "drizzle":
      return String(h.data.engine ?? "postgres");
    default:
      return h.lib;
  }
}

const SESSION_STORES: Record<string, string> = {
  "connect-mongo": "mongodb",
  "connect-mongodb-session": "mongodb",
  "connect-redis": "redis",
  "connect-pg-simple": "postgres",
  "express-mysql-session": "mysql",
};

function rootIdentifier(expr: Node): Node | undefined {
  let cur: Node = expr;
  while (Node.isPropertyAccessExpression(cur)) cur = cur.getExpression();
  return Node.isIdentifier(cur) ? cur : undefined;
}

function prismaProvider(root: string): string {
  for (const p of ["prisma/schema.prisma", "schema.prisma", "src/prisma/schema.prisma"]) {
    const full = path.join(root, p);
    if (!existsSync(full)) continue;
    const m = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(readFileSync(full, "utf8"));
    if (m) return ({ postgresql: "postgres", postgres: "postgres", mysql: "mysql", sqlite: "sqlite", mongodb: "mongodb", sqlserver: "sqlserver", cockroachdb: "cockroachdb" } as Record<string, string>)[m[1]!] ?? m[1]!;
  }
  return "database";
}

function engineLabel(engine: string): string {
  return ({ postgres: "Postgres", mysql: "MySQL", mongodb: "MongoDB", sqlite: "SQLite", database: "Database" } as Record<string, string>)[engine] ?? engine;
}

function reachable(graph: Map<SourceFile, SourceFile[]>, start: SourceFile): Set<SourceFile> {
  const seen = new Set<SourceFile>([start]);
  const queue = [start];
  while (queue.length) {
    for (const d of graph.get(queue.shift()!) ?? []) {
      if (!seen.has(d)) {
        seen.add(d);
        queue.push(d);
      }
    }
  }
  return seen;
}

/** `worked ? 0 : POLL_INTERVAL_MS` -> the largest constant branch. */
function intervalHint(r: Resolver, node: Node): number | undefined {
  if (Node.isConditionalExpression(node)) {
    const a = numericValue(r, node.getWhenTrue());
    const b = numericValue(r, node.getWhenFalse());
    if (a !== undefined || b !== undefined) return Math.max(a ?? 0, b ?? 0);
  }
  return undefined;
}

function formatMs(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms} ms`;
}

export type { CallExpression, NewExpression };
