import { Node, type SourceFile } from "ts-morph";
import { relPath, type Repo } from "./project.ts";
import { isFunctionLike, pick, type FunctionLike, type Resolver } from "./values.ts";
import type { Route } from "./express.ts";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const APP_ROUTE = /^(?:src\/)?app\/(?:(.+)\/)?route\.[cm]?[jt]sx?$/;
const APP_PAGE = /^(?:src\/)?app\/(?:(.+)\/)?page\.[jt]sx?$/;
const PAGES_API = /^(?:src\/)?pages\/api\/(.+)\.[cm]?[jt]sx?$/;

export function isNextApp(repo: Repo): boolean {
  const deps = { ...(repo.packageJson?.dependencies ?? {}), ...(repo.packageJson?.devDependencies ?? {}) };
  return "next" in deps;
}

/** App Router route handlers, async server-component pages and Pages Router API routes. */
export function extractNextRoutes(r: Resolver, repo: Repo): Route[] {
  if (!isNextApp(repo)) return [];
  const routes: Route[] = [];
  for (const file of repo.files) {
    const rel = relPath(repo, file);
    let m: RegExpExecArray | null;
    if ((m = APP_ROUTE.exec(rel))) {
      const path = toUrlPath(m[1] ?? "");
      for (const method of METHODS) {
        const fn = exported(r, file, method);
        if (fn) routes.push(route(method, path, fn, file));
      }
    } else if ((m = APP_PAGE.exec(rel))) {
      const fn = exported(r, file, "default");
      // Only async server components do work on the server per request.
      if (fn && (fn as any).isAsync?.()) routes.push({ ...route("GET", toUrlPath(m[1] ?? ""), fn, file), page: true });
    } else if ((m = PAGES_API.exec(rel))) {
      const fn = exported(r, file, "default");
      if (fn) routes.push(route("ALL", toUrlPath(`api/${m[1]!.replace(/(^|\/)index$/, "")}`), fn, file));
    }
  }
  return routes;
}

function route(method: string, path: string, fn: FunctionLike, file: SourceFile): Route {
  return {
    method, path, framework: "next", registeredAt: fn, app: file,
    chain: [{ kind: "fn", fn, node: fn, registeredAt: fn }],
  };
}

function exported(r: Resolver, file: SourceFile, name: string): FunctionLike | undefined {
  const entry = r.moduleExports(file).named.get(name);
  if (!entry?.node) return undefined;
  const node = entry.node;
  if (isFunctionLike(node)) return node;
  const v = Node.isVariableDeclaration(node) ? r.declaration(node) : r.value(node);
  return pick(v, "function")?.node;
}

/** "api/posts/[id]" -> "/api/posts/:id"; route groups and parallel slots are dropped. */
export function toUrlPath(dir: string): string {
  const segs = dir.split("/").filter(Boolean).flatMap((s) => {
    if (/^\(.*\)$/.test(s) || s.startsWith("@")) return [];
    const catchAll = /^\[\[?\.\.\.(.+?)\]?\]$/.exec(s);
    if (catchAll) return [`:${catchAll[1]}*`];
    const dyn = /^\[(.+)\]$/.exec(s);
    return [dyn ? `:${dyn[1]}` : s];
  });
  return "/" + segs.join("/");
}
