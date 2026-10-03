// Scores the extractor against hand-labeled ground truth.
// Usage: pnpm --filter @vibesim/extractor eval [--verbose]
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { analyzeRepo } from "../src/index.ts";
import { keyString, parseTruth, score, type Score } from "./score.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repos = path.resolve(here, "../../../fixtures/repos");
const truthDir = path.join(here, "truth");
const verbose = process.argv.includes("--verbose");

export const GATE = { precision: 0.9, recall: 0.85 };

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
let total = { truth: 0, extracted: 0, matched: 0 };
const results: [string, Score][] = [];

for (const file of readdirSync(truthDir).filter((f) => f.endsWith(".truth.txt")).sort()) {
  const name = file.replace(/\.truth\.txt$/, "");
  const started = Date.now();
  const spec = analyzeRepo(path.join(repos, name), { repoName: name, now: new Date(0) });
  const s = score(parseTruth(path.join(truthDir, file)), spec);
  results.push([name, s]);
  total = { truth: total.truth + s.truth, extracted: total.extracted + s.extracted, matched: total.matched + s.matched };
  console.log(`\n${name}  (${Date.now() - started} ms, ${spec.flows.length} flows, ${s.unresolved} unresolved)`);
  console.log(`  precision ${pct(s.precision)} (${s.matched}/${s.extracted})   recall ${pct(s.recall)} (${s.matched}/${s.truth})`);
  for (const [c, v] of Object.entries(s.byCategory)) {
    if (v.truth || v.extracted) console.log(`    ${c.padEnd(8)} truth ${String(v.truth).padStart(4)}  extracted ${String(v.extracted).padStart(4)}  matched ${String(v.matched).padStart(4)}`);
  }
  const limit = verbose ? Infinity : 15;
  if (s.missing.length) console.log(`  missing (${s.missing.length}):\n${s.missing.slice(0, limit).map((e) => "    - " + keyString(e)).join("\n")}`);
  if (s.extra.length) console.log(`  extra (${s.extra.length}):\n${s.extra.slice(0, limit).map((e) => "    + " + keyString(e)).join("\n")}`);
}

const precision = total.extracted ? total.matched / total.extracted : 1;
const recall = total.truth ? total.matched / total.truth : 1;
// Every repo must pass on its own, so large repos cannot hide a broken stack.
const failing = results.filter(([, s]) => s.precision < GATE.precision || s.recall < GATE.recall).map(([n]) => n);
const pass = failing.length === 0;
console.log(`\nOVERALL  precision ${pct(precision)}  recall ${pct(recall)}  (gate per repo: precision >= ${pct(GATE.precision)}, recall >= ${pct(GATE.recall)})  ${pass ? "PASS" : `FAIL: ${failing.join(", ")}`}`);
process.exitCode = pass ? 0 : 1;
