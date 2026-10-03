import { Node, type CallExpression } from "ts-morph";
import { HTTP_METHODS, stringValue, libraryMiddleware } from "./libraries.ts";
import { isErrorHandler, functionName } from "./functions.ts";
import { isFunctionLike, pick, ITERATION_METHODS, calleeMethodName, type FunctionLike, type Handle, type Resolver, type Value } from "./values.ts";
import { joinUrlPath } from "./util.ts";

export interface ChainElement {
  kind: "fn" | "lib" | "unknown";
  fn?: FunctionLike;
  handle?: Handle;
  /** The argument expression in the registration call. */
  node: Node;
  /** The `use`/route call (or Next.js handler declaration) that put this element in the chain. */
  registeredAt: Node;
  wrappedBy?: string;
  /** `auth('manageUsers')`: middleware built by a factory call; shown with its call text. */
  factoryCall?: string;
}

export interface Route {
  method: string;
  path: string;
  chain: ChainElement[];
  registeredAt: Node;
  /** Where the app lives (Express app creation, or the Next.js route file), for service lookup. */
  app: Node;
  framework: "express" | "next";
  /** Next.js server-component page rather than an API handler. */
  page?: boolean;
}

interface Registration {
  call: CallExpression;
  method: string; // "use" or an HTTP method
  path?: string;
  args: Node[];
  /** Per-argument values when the call runs once per element of an array (routes.forEach(...)). */
  values?: Value[];
}

/** Routes of every Express app, with the full middleware chain each one runs. */
export function extractExpressRoutes(r: Resolver): Route[] {
  const regs = new Map<Handle, Registration[]>();
  for (const call of r.calls()) {
    if (!Node.isCallExpression(call)) continue;
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (method !== "use" && !HTTP_METHODS.has(method)) continue;
    let recvNode = callee.getExpression();
    let routePath: string | undefined;
    // router.route('/x').get(h).post(h2)
    while (Node.isCallExpression(recvNode)) {
      const inner = recvNode.getExpression();
      if (!Node.isPropertyAccessExpression(inner)) break;
      if (inner.getName() === "route") {
        routePath = stringValue(r.value(recvNode.getArguments()[0]));
        recvNode = inner.getExpression();
        break;
      }
      if (HTTP_METHODS.has(inner.getName())) recvNode = inner.getExpression();
      else break;
    }
    const handle = pick(r.value(recvNode), "handle")?.handle;
    if (!handle || (handle.type !== "express-app" && handle.type !== "express-router")) continue;
    const list = regs.get(handle) ?? [];
    const perElement = iterationBindings(r, call);
    if (perElement) for (const values of perElement) list.push({ call, method, path: routePath, args: call.getArguments(), values });
    else list.push({ call, method, path: routePath, args: call.getArguments() });
    regs.set(handle, list);
  }
  for (const list of regs.values()) {
    list.sort((a, b) => a.call.getSourceFile().getFilePath().localeCompare(b.call.getSourceFile().getFilePath()) || a.call.getStart() - b.call.getStart());
  }

  const routes: Route[] = [];
  const apps = [...regs.keys()].filter((h) => h.type === "express-app");
  for (const app of apps) walk(r, regs, app, app, "", [], routes, new Set());
  return routes;
}

interface StackEntry {
  element: ChainElement;
  prefix: string;
}

function walk(
  r: Resolver,
  regs: Map<Handle, Registration[]>,
  app: Handle,
  handle: Handle,
  prefix: string,
  inherited: StackEntry[],
  out: Route[],
  visiting: Set<Handle>,
) {
  if (visiting.has(handle)) return;
  visiting.add(handle);
  const stack = [...inherited];
  for (const reg of regs.get(handle) ?? []) {
    let args = reg.values ? reg.args : flatten(reg.args);
    const valueAt = (i: number) => reg.values?.[i] ?? r.value(args[i]);
    let offset = 0;
    if (reg.method === "use") {
      let mount = "/";
      const first = args[0] ? valueAt(0) : undefined;
      if (first && first.kind === "string") {
        mount = first.value;
        offset = 1;
      }
      const at = joinUrlPath(prefix, mount);
      for (let i = offset; i < args.length; i++) {
        const v = valueAt(i);
        const sub = pick(v, "handle")?.handle;
        if (sub && (sub.type === "express-router" || sub.type === "express-app") && regs.has(sub)) {
          walk(r, regs, app, sub, at, stack, out, visiting);
          continue;
        }
        const el = element(r, args[i]!, reg.call, reg.values ? v : undefined);
        if (el) stack.push({ element: el, prefix: at });
      }
      continue;
    }
    let routePath = reg.path;
    if (routePath === undefined) {
      const first = args[0] ? valueAt(0) : undefined;
      if (!first || first.kind !== "string") continue;
      routePath = first.value;
      offset = 1;
    }
    const full = joinUrlPath(prefix, routePath);
    const chain: ChainElement[] = stack.filter((s) => matches(s.prefix, full)).map((s) => s.element);
    for (let i = offset; i < args.length; i++) {
      const el = element(r, args[i]!, reg.call, reg.values ? valueAt(i) : undefined);
      if (el) chain.push(el);
    }
    const methods = reg.method === "all" ? ["ALL"] : [reg.method.toUpperCase()];
    for (const m of methods) out.push({ method: m, path: full, chain, registeredAt: reg.call, app: app.created, framework: "express" });
  }
  visiting.delete(handle);
}

function matches(prefix: string, full: string): boolean {
  return prefix === "/" || full === prefix || full.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

function flatten(args: Node[]): Node[] {
  return args.flatMap((a) => (Node.isArrayLiteralExpression(a) ? flatten(a.getElements()) : [a]));
}

/** One chain element; error handlers (4 params) are left out of the request path. */
function element(r: Resolver, arg: Node, registeredAt: CallExpression, bound?: Value): ChainElement | undefined {
  if (!bound) {
    const origin = r.originOf(arg);
    if (Node.isCallExpression(origin)) {
      const calleeValue = r.value(origin.getExpression());
      const wrapper = pick(calleeValue, "function");
      const inner = origin.getArguments()[0];
      const innerFn = inner ? pick(r.value(inner), "function") : undefined;
      // asyncHandler(controller.fn) / catchAsync(async (req, res) => ...): unwrap to the real handler.
      if (wrapper && innerFn && pick(r.returnValue(wrapper.node), "function")) {
        return { kind: "fn", fn: innerFn.node, node: arg, registeredAt, wrappedBy: functionName(wrapper.node) };
      }
      // auth('manageUsers'), validate(schema): a user factory that returns the middleware.
      const produced = wrapper ? pick(r.returnValue(wrapper.node), "function") : undefined;
      if (produced && !innerFn) {
        if (isErrorHandler(produced.node)) return undefined;
        return { kind: "fn", fn: produced.node, node: arg, registeredAt, factoryCall: origin.getText().replace(/\s+/g, " ").slice(0, 60) };
      }
      if (calleeValue.kind === "external" && innerFn) {
        return { kind: "fn", fn: innerFn.node, node: arg, registeredAt, wrappedBy: [calleeValue.pkg, ...calleeValue.path].join(".") };
      }
    }
  }
  const v = bound ?? r.value(arg);
  const fn = pick(v, "function");
  if (fn && isFunctionLike(fn.node)) {
    if (isErrorHandler(fn.node)) return undefined;
    return { kind: "fn", fn: fn.node, node: arg, registeredAt };
  }
  const handle = pick(v, "handle")?.handle;
  if (handle?.type === "express-middleware") return { kind: "lib", handle, node: arg, registeredAt };
  if (handle) return undefined;
  const result = pick(v, "result");
  if (result) return { kind: "lib", handle: libraryMiddleware(r, result.call, result.pkg, result.path), node: arg, registeredAt };
  const ext = pick(v, "external");
  if (ext) return { kind: "lib", handle: libraryMiddleware(r, arg, ext.pkg, ext.path), node: arg, registeredAt };
  if (v.kind === "string") return undefined;
  return { kind: "unknown", node: arg, registeredAt };
}

/**
 * `routes.forEach((route) => router.use(route.path, route.route))`: one set of
 * argument values per array element, so paths and routers stay paired.
 */
function iterationBindings(r: Resolver, call: CallExpression): Value[][] | undefined {
  const fn = call.getFirstAncestor((a) => isFunctionLike(a));
  if (!fn || !isFunctionLike(fn)) return undefined;
  const iter = fn.getParent();
  if (!iter || !Node.isCallExpression(iter) || !iter.getArguments().includes(fn as any)) return undefined;
  const method = calleeMethodName(iter);
  if (!method || !ITERATION_METHODS.has(method)) return undefined;
  const param = fn.getParameters()[0];
  if (!param || !Node.isParameterDeclaration(param)) return undefined;
  const pname = param.getName();
  const recv = (iter.getExpression() as any).getExpression?.() as Node | undefined;
  if (!recv) return undefined;
  const arr = r.originOf(recv);
  if (!Node.isArrayLiteralExpression(arr)) return undefined;
  const args = call.getArguments();
  if (!args.some((a) => Node.isPropertyAccessExpression(a) && a.getExpression().getText() === pname)) return undefined;
  return arr.getElements().map((el) => {
    const obj = r.value(el);
    return args.map((a) =>
      Node.isPropertyAccessExpression(a) && a.getExpression().getText() === pname ? r.member(obj, a.getName()) : r.value(a),
    );
  });
}
