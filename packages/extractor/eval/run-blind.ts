// Scores the extractor on blind samples: third-party repos labeled before the
// extractor was run on them. Clones each repo at a pinned commit into a cache.
// Usage: pnpm --filter @vibesim/extractor eval:blind
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { analyzeRepo } from "../src/index.ts";
import { keyString, readTruth, score } from "./score.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const blindDir = path.join(here, "blind");
const cache = process.env.VIBESIM_CACHE ?? path.join(os.tmpdir(), "vibesim-blind");
mkdirSync(cache, { recursive: true });
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

for (const file of readdirSync(blindDir).filter((f) => f.endsWith(".truth.txt"))) {
  const truth = readTruth(path.join(blindDir, file));
  if (!truth.repo) throw new Error(`${file}: missing repo line`);
  const dir = path.join(cache, path.basename(truth.repo.url));
  if (!existsSync(dir)) {
    execFileSync("git", ["clone", "-q", truth.repo.url, dir], { stdio: "inherit" });
  }
  execFileSync("git", ["-C", dir, "checkout", "-q", truth.repo.commit], { stdio: "inherit" });
  const spec = analyzeRepo(dir, { now: new Date(0) });
  const s = score(truth.edges, spec, truth.scope);
  console.log(`\n${file.replace(/\.truth\.txt$/, "")} @ ${truth.repo.commit}  (scope: ${truth.scope.length} flows)`);
  console.log(`  precision ${pct(s.precision)} (${s.matched}/${s.extracted})   recall ${pct(s.recall)} (${s.matched}/${s.truth})`);
  if (s.missing.length) console.log(`  missing:\n${s.missing.map((e) => "    - " + keyString(e)).join("\n")}`);
  if (s.extra.length) console.log(`  extra:\n${s.extra.map((e) => "    + " + keyString(e)).join("\n")}`);
}
