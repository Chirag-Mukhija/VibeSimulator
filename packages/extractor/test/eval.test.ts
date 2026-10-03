import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeRepo } from "../src/index.ts";
import { keyString, parseTruth, score } from "../eval/score.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const truthDir = path.join(here, "../eval/truth");
const repos = path.resolve(here, "../../../fixtures/repos");
const truths = readdirSync(truthDir).filter((f) => f.endsWith(".truth.txt")).map((f) => f.replace(/\.truth\.txt$/, ""));

// P1 gate: each repo on its own must reach these numbers.
const GATE = { precision: 0.9, recall: 0.85 };

describe("extractor accuracy against hand-labeled truth", () => {
  it.each(truths)("%s passes the gate", (name) => {
    const spec = analyzeRepo(path.join(repos, name), { repoName: name, now: new Date(0) });
    const s = score(parseTruth(path.join(truthDir, `${name}.truth.txt`)), spec);
    const report = [...s.missing.map((e) => `missing ${keyString(e)}`), ...s.extra.map((e) => `extra ${keyString(e)}`)].join("\n");
    expect(s.precision, report).toBeGreaterThanOrEqual(GATE.precision);
    expect(s.recall, report).toBeGreaterThanOrEqual(GATE.recall);
  }, 30_000);

  it("every emitted edge carries evidence that points at a real line", () => {
    for (const name of truths) {
      const spec = analyzeRepo(path.join(repos, name), { repoName: name, now: new Date(0) });
      for (const e of spec.edges) {
        expect(e.evidence.length).toBeGreaterThan(0);
        expect(e.evidence[0]!.snippet, `${name} ${e.id} ${e.evidence[0]!.file}:${e.evidence[0]!.line}`).toBeTruthy();
      }
    }
  }, 60_000);
});
