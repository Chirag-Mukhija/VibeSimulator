import { readFileSync } from "node:fs";
import type { TraceSpec } from "@vibesim/spec";

/** One expected or extracted edge: from -> to, proven at file:line. */
export interface EdgeKey {
  from: string;
  to: string;
  at: string;
}

export function keyString(e: EdgeKey): string {
  return `${e.from} -> ${e.to} @ ${e.at}`;
}

/** Normalizes the truth notation to extractor ids. */
function norm(id: string): string {
  const t = id.trim();
  if (t === "client") return "client:http";
  if (t === "redis") return "cache:redis";
  const route = /^route:([A-Z]+) (.+)$/.exec(t);
  if (route) return `route:${route[1]}:${route[2]}`;
  return t;
}

export function parseTruth(path: string): EdgeKey[] {
  const vars: Record<string, string> = {};
  const edges: EdgeKey[] = [];
  let proxy: { node: string; clientAt: string; routeAt: string } | undefined;
  const lines = readFileSync(path, "utf8").split("\n");
  for (const [i, raw] of lines.entries()) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/\$([A-Z_]+)/g, (m, n: string) => vars[n] ?? m);
    const fail = (msg: string) => new Error(`${path}:${i + 1}: ${msg}\n  ${raw}`);
    let m: RegExpExecArray | null;
    if ((m = /^let (\w+) = (.*)$/.exec(line))) {
      vars[m[1]!] = m[2]!;
    } else if ((m = /^proxy (\S+) client@(\S+) route@(\S+)$/.exec(line))) {
      proxy = { node: m[1]!, clientAt: m[2]!, routeAt: m[3]! };
      edges.push({ from: "client:http", to: proxy.node, at: proxy.clientAt });
    } else if ((m = /^route ([A-Z]+) (\S+) @ (\S+)$/.exec(line))) {
      const to = `route:${m[1]}:${m[2]}`;
      edges.push(proxy ? { from: proxy.node, to, at: proxy.routeAt } : { from: "client:http", to, at: m[3]! });
    } else if ((m = /^chain ([A-Z]+) (\S+) = (.+)$/.exec(line))) {
      let prev = `route:${m[1]}:${m[2]}`;
      for (const part of m[3]!.split(" > ")) {
        const pm = /^(.+) @ (\S+)$/.exec(part.trim());
        if (!pm) throw fail(`bad chain element "${part}"`);
        const node = norm(pm[1]!);
        edges.push({ from: prev, to: node, at: pm[2]! });
        prev = node;
      }
    } else if ((m = /^edge (.+) -> (.+) @ (\S+)$/.exec(line))) {
      edges.push({ from: norm(m[1]!), to: norm(m[2]!), at: m[3]! });
    } else {
      throw fail("unrecognized line");
    }
  }
  return dedupe(edges);
}

export function extractedEdges(spec: TraceSpec): { verified: EdgeKey[]; unresolved: number } {
  const verified: EdgeKey[] = [];
  let unresolved = 0;
  for (const e of spec.edges) {
    if (e.confidence === "unresolved") {
      unresolved++;
      continue;
    }
    const ev = e.evidence[0]!;
    verified.push({ from: e.from, to: e.to, at: `${ev.file}:${ev.line}` });
  }
  return { verified: dedupe(verified), unresolved };
}

export type Category = "entry" | "chain" | "call" | "io" | "trigger";

export function category(e: EdgeKey): Category {
  if (e.from.startsWith("client:") || e.from.startsWith("proxy:")) return "entry";
  if (/^(timer|topic|ui|ws|queue):/.test(e.from)) return "trigger";
  if (/^(db|cache|topic|ext|compute|ws|queue|route|unknown):/.test(e.to)) return e.to.startsWith("route:") && !e.from.startsWith("fn:") ? "entry" : "io";
  if (e.from.startsWith("route:") || e.from.startsWith("mw:") || e.to.startsWith("mw:")) return "chain";
  return "call";
}

export interface Score {
  truth: number;
  extracted: number;
  matched: number;
  precision: number;
  recall: number;
  missing: EdgeKey[];
  extra: EdgeKey[];
  unresolved: number;
  byCategory: Record<Category, { truth: number; extracted: number; matched: number }>;
}

export function score(truth: EdgeKey[], spec: TraceSpec): Score {
  const { verified, unresolved } = extractedEdges(spec);
  const t = new Set(truth.map(keyString));
  const x = new Set(verified.map(keyString));
  const missing = truth.filter((e) => !x.has(keyString(e)));
  const extra = verified.filter((e) => !t.has(keyString(e)));
  const matched = truth.length - missing.length;
  const byCategory = {} as Score["byCategory"];
  for (const c of ["entry", "chain", "call", "io", "trigger"] as Category[]) {
    const tc = truth.filter((e) => category(e) === c);
    const xc = verified.filter((e) => category(e) === c);
    byCategory[c] = { truth: tc.length, extracted: xc.length, matched: tc.filter((e) => x.has(keyString(e))).length };
  }
  return {
    truth: truth.length,
    extracted: verified.length,
    matched,
    precision: verified.length ? matched / verified.length : 1,
    recall: truth.length ? matched / truth.length : 1,
    missing,
    extra,
    unresolved,
    byCategory,
  };
}

function dedupe(edges: EdgeKey[]): EdgeKey[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = keyString(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
