// Analyzes the gallery repos and writes static traces for the site.
// Usage: pnpm --filter @vibesim/web gallery
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "@vibesim/extractor";
import { GALLERY } from "./gallery.config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const out = path.resolve(here, "../public/gallery");
mkdirSync(out, { recursive: true });

const index = [];
for (const g of GALLERY) {
  const spec = analyzeRepo(path.join(root, g.path), { repoName: g.title, now: new Date("2026-10-03T00:00:00Z") });
  writeFileSync(path.join(out, `${g.id}.trace.json`), JSON.stringify(spec));
  const { path: _p, ...meta } = g;
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
