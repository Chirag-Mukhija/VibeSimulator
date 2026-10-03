import { describe, expect, it } from "vitest";
import { CONCEPTS, concept } from "../src/index.ts";
import { RULES } from "../../findings/src/index.ts";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("concept catalog", () => {
  it("has unique ids, valid related links and 12 full concepts", () => {
    const ids = CONCEPTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CONCEPTS) for (const r of c.related) expect(concept(r), `${c.id} -> ${r}`).toBeDefined();
    expect(CONCEPTS.filter((c) => c.full)).toHaveLength(12);
  });

  it("covers every concept the findings rules and extractor link to", () => {
    const sources = [
      readFileSync(path.resolve(here, "../../findings/src/rules.ts"), "utf8"),
      ...readdirSync(path.resolve(here, "../../extractor/src")).map((f) => readFileSync(path.resolve(here, "../../extractor/src", f), "utf8")),
    ].join("\n");
    const linked = new Set([...sources.matchAll(/concepts?:\s*\[?\s*"([a-z-]+)"/g)].map((m) => m[1]!));
    expect(RULES.length).toBeGreaterThan(5);
    for (const id of linked) expect(concept(id), id).toBeDefined();
  });
});
