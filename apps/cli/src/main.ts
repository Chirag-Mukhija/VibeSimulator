#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeRepo, GENERATOR_VERSION } from "@vibesim/extractor";

const USAGE = `vibesim ${GENERATOR_VERSION}

Usage:
  vibesim analyze <repo-dir> [-o out.json] [--name repo-name] [--compact] [--no-source]

Reads the repository locally (nothing is uploaded) and writes a trace file
you can open in the vibeSimulator web app. The trace includes a few lines of
code around each hop so the viewer can show them; --no-source leaves code out.`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      name: { type: "string" },
      compact: { type: "boolean", default: false },
      "no-source": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, dir] = positionals;
  if (values.help || command !== "analyze" || !dir) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }
  const root = path.resolve(dir);
  const started = Date.now();
  const spec = analyzeRepo(root, { repoName: values.name ?? path.basename(root), includeSource: !values["no-source"] });
  const out = path.resolve(values.out ?? "vibesim.trace.json");
  writeFileSync(out, JSON.stringify(spec, null, values.compact ? 0 : 2) + "\n");

  const count = (kind: string) => spec.nodes.filter((n) => n.kind === kind).length;
  const resources = spec.nodes.filter((n) => ["database", "cache", "queue", "topic", "external-api", "compute"].includes(n.kind));
  console.log(`Analyzed ${spec.meta.stats.filesAnalyzed} files in ${Date.now() - started} ms`);
  console.log(`  ${count("route")} routes, ${spec.flows.length} flows, ${spec.edges.length} hops`);
  if (spec.services.length) console.log(`  services: ${spec.services.map((s) => s.label).join(", ")}`);
  if (resources.length) console.log(`  talks to: ${resources.map((n) => n.label).join(", ")}`);
  console.log(`  unresolved: ${spec.gaps.length}${spec.gaps.length ? " (shown as dashed hops; nothing is guessed)" : ""}`);
  console.log(`Wrote ${path.relative(process.cwd(), out) || out}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
}
