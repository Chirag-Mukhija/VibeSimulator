import path from "node:path";

/** FNV-1a, base36. Short stable ids for edges. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/** "auth.service" -> "authService", "paymentController" -> "paymentController". */
export function camelFromBasename(base: string): string {
  const parts = base.split(/[.\-_]+/).filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : p[0]!.toUpperCase() + p.slice(1))).join("");
}

/** Package name from a bare import specifier: "@aws-sdk/client-s3/x" -> "@aws-sdk/client-s3". */
export function packageName(spec: string): string {
  const s = spec.startsWith("node:") ? spec.slice(5) : spec;
  const parts = s.split("/");
  return s.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

export function joinUrlPath(prefix: string, sub: string): string {
  const joined = `${prefix.replace(/\/+$/, "")}/${sub.replace(/^\/+/, "")}`;
  const clean = joined.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  return clean === "" ? "/" : clean;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
