import { Node, type CallExpression } from "ts-morph";
import { HTTP_METHODS, stringValue } from "./libraries.ts";
import { isErrorHandler, functionName } from "./functions.ts";
import { isFunctionLike, pick, type FunctionLike, type Handle, type Resolver } from "./values.ts";
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
    list.push({ call, method, path: routePath, args: call.getArguments() });
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
    let args = flatten(reg.args);
    if (reg.method === "use") {
      let mount = "/";
      const first = args[0] ? r.value(args[0]) : undefined;
      if (first && first.kind === "string") {
        mount = first.value;
        args = args.slice(1);
      }
      const at = joinUrlPath(prefix, mount);
      for (const arg of args) {
        const sub = pick(r.value(arg), "handle")?.handle;
        if (sub && (sub.type === "express-router" || sub.type === "express-app") && regs.has(sub)) {
          walk(r, regs, app, sub, at, stack, out, visiting);
          continue;
        }
        const el = element(r, arg, reg.call);
        if (el) stack.push({ element: el, prefix: at });
      }
      continue;
    }
    let routePath = reg.path;
    if (routePath === undefined) {
      const first = args[0] ? r.value(args[0]) : undefined;
      if (!first || first.kind !== "string") continue;
      routePath = first.value;
      args = args.slice(1);
    }
    const full = joinUrlPath(prefix, routePath);
    const chain: ChainElement[] = stack.filter((s) => matches(s.prefix, full)).map((s) => s.element);
    for (const arg of args) {
      const el = element(r, arg, reg.call);
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
function element(r: Resolver, arg: Node, registeredAt: CallExpression): ChainElement | undefined {
  // asyncHandler(controller.fn): a user wrapper that returns a function.
  if (Node.isCallExpression(arg)) {
    const wrapper = pick(r.value(arg.getExpression()), "function");
    const inner = arg.getArguments()[0];
    if (wrapper && inner && pick(r.returnValue(wrapper.node), "function")) {
      const fn = pick(r.value(inner), "function");
      if (fn) return { kind: "fn", fn: fn.node, node: arg, registeredAt, wrappedBy: functionName(wrapper.node) };
    }
  }
  const v = r.value(arg);
  const fn = pick(v, "function");
  if (fn && isFunctionLike(fn.node)) {
    if (isErrorHandler(fn.node)) return undefined;
    return { kind: "fn", fn: fn.node, node: arg, registeredAt };
  }
  const handle = pick(v, "handle")?.handle;
  if (handle?.type === "express-middleware") return { kind: "lib", handle, node: arg, registeredAt };
  if (handle) return undefined;
  return { kind: "unknown", node: arg, registeredAt };
}
