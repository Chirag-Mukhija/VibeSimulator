// Analyzes the gallery repos and writes static traces for the site.
// Usage: pnpm --filter @vibesim/web gallery
// Cloned repos are cached in $VIBESIM_CACHE (default: the OS temp folder).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "@vibesim/extractor";
import { GALLERY } from "./gallery.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const out = path.resolve(here, "../public/gallery");
const cache = process.env.VIBESIM_CACHE ?? path.join(os.tmpdir(), "vibesim-gallery");
mkdirSync(out, { recursive: true });
mkdirSync(cache, { recursive: true });

function source(g: (typeof GALLERY)[number]): string {
  if (g.path) return path.join(root, g.path);
  if (!g.clone) throw new Error(`${g.id}: needs a path or a clone`);
  const dir = path.join(cache, g.id);
  if (!existsSync(dir)) execFileSync("git", ["clone", "-q", g.clone.url, dir], { stdio: "inherit" });
  execFileSync("git", ["-C", dir, "checkout", "-q", g.clone.commit], { stdio: "inherit" });
  return dir;
}

const index = [];
for (const g of GALLERY) {
  const spec = analyzeRepo(source(g), { repoName: g.title, now: new Date("2026-10-03T00:00:00Z") });
  const missing = (g.walkthrough ?? []).filter((w) => w.flow && !spec.flows.some((f) => f.id === w.flow));
  if (missing.length) throw new Error(`${g.id}: tour stops point at flows that don't exist: ${missing.map((m) => m.flow).join(", ")}`);
  writeFileSync(path.join(out, `${g.id}.trace.json`), JSON.stringify(spec));
  const { path: _p, clone: _c, ...meta } = g;
  index.push({
    ...meta,
    stats: {
      routes: spec.meta.stats.routes ?? 0,
      flows: spec.flows.length,
      findings: spec.findings.length,
      high: spec.findings.filter((f) => f.severity === "high").length,
    },
  });
  console.log(`${g.id}: ${spec.flows.length} flows, ${spec.findings.length} findings`);
}
writeFileSync(path.join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
