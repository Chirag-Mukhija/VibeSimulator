#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeRepo, applyReview, explainPrompt, GENERATOR_VERSION, parseNotes, reviewPrompt } from "@vibesim/extractor";
import { validateTraceSpec } from "@vibesim/spec";

const USAGE = `vibesim ${GENERATOR_VERSION}

Usage:
  vibesim analyze <repo-dir> [-o out.json] [--name repo-name] [--compact] [--no-source]
  vibesim explain <repo-dir> [-t trace.json] [-o out.json] [--model name] [--no-verify]
  vibesim explain <repo-dir> [-t trace.json] --print-prompt
  vibesim explain <repo-dir> [-t trace.json] --answer answer.json

analyze reads the repository locally (nothing is uploaded) and writes a trace
file you can open in the vibeSimulator web app. The trace includes a few lines
of code around each hop so the viewer can show them; --no-source leaves code out.

explain is optional. It runs Claude Code (\`claude -p\`, your account) in the
repo with read-only tools (Read, Grep, Glob) and adds AI notes to the trace: a
plain-language summary per flow, and insights the rules don't cover. A second,
fresh pass then checks every note against the code and fixes or drops what it
can't confirm (--no-verify skips it). Every citation is checked against the
repo; ones that point nowhere are dropped. The viewer labels these notes as
AI-written. Without Claude Code, --print-prompt prints the prompt to paste into
any AI chat, and --answer reads its reply.`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o" },
      trace: { type: "string", short: "t" },
      name: { type: "string" },
      model: { type: "string" },
      answer: { type: "string" },
      "print-prompt": { type: "boolean", default: false },
      "no-verify": { type: "boolean", default: false },
      compact: { type: "boolean", default: false },
      "no-source": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, dir] = positionals;
  if (!values.help && command === "explain" && dir) return explain(path.resolve(dir), values);
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

interface ExplainOptions { out?: string; trace?: string; model?: string; answer?: string; "print-prompt"?: boolean; "no-verify"?: boolean; compact?: boolean }

/** One headless Claude Code run in the repo with read-only tools; returns its final answer and the model used. */
function askClaude(root: string, prompt: string, model?: string): { answer: string; model?: string } {
  const args = ["-p", "--output-format", "json", "--allowedTools", "Read", "Grep", "Glob", "--max-turns", "80", ...(model ? ["--model", model] : [])];
  const run = spawnSync("claude", args, { cwd: root, input: prompt, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  if (run.error && (run.error as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("Claude Code (the `claude` command) is not installed. Install it, or use --print-prompt and --answer with any AI chat.");
  }
  if (run.error) throw run.error;
  let envelope: { result?: string; is_error?: boolean; modelUsage?: Record<string, unknown> };
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    throw new Error(`Claude Code did not answer as expected.\n${run.stderr || run.stdout}`.trim());
  }
  if (envelope.is_error) throw new Error(`Claude Code failed: ${envelope.result ?? "unknown error"}${/auth|log ?in/i.test(String(envelope.result)) ? "\nRun \`claude\` once and log in, then try again." : ""}`);
  return { answer: envelope.result ?? "", model: model ?? Object.keys(envelope.modelUsage ?? {})[0] };
}

function explain(root: string, o: ExplainOptions): number {
  const tracePath = path.resolve(o.trace ?? "vibesim.trace.json");
  const checked = validateTraceSpec(JSON.parse(readFileSync(tracePath, "utf8")));
  if (!checked.ok) throw new Error(`${tracePath} is not a valid trace:\n${checked.issues.join("\n")}`);
  const spec = checked.spec;
  const prompt = explainPrompt(spec);
  if (o["print-prompt"]) {
    console.log(prompt);
    return 0;
  }
  let answer: string;
  let tool = "pasted answer";
  let model = o.model;
  const started = Date.now();
  if (o.answer) {
    answer = readFileSync(path.resolve(o.answer), "utf8");
  } else {
    console.log("Asking Claude Code to read the repo (read-only tools; this takes a few minutes)...");
    const first = askClaude(root, prompt, o.model);
    answer = first.answer;
    tool = "Claude Code (claude -p, read-only tools)";
    model = first.model;
  }
  const report = parseNotes(answer, spec, root, { tool, ...(model ? { model } : {}), generatedAt: new Date().toISOString() });
  let notes = report.notes;
  if (!o.answer && !o["no-verify"] && (notes.flows.length || notes.insights.length)) {
    console.log("Checking every note against the code in a fresh session...");
    const review = applyReview(notes, askClaude(root, reviewPrompt(notes), o.model).answer);
    const summary = `${review.fixed.length} corrected, ${review.dropped.length} dropped${review.unreviewed ? `, ${review.unreviewed} not reviewed` : ""}`;
    notes = { ...review.notes, generator: { ...review.notes.generator, reviewed: `A second Claude Code pass checked each note against the code: ${summary}.` } };
    console.log(`  review: ${review.kept} confirmed, ${summary}`);
    for (const d of review.dropped) console.log(`  dropped ${d}`);
  }
  const result = validateTraceSpec({ ...spec, notes });
  if (!result.ok) throw new Error(`The notes don't fit the trace:\n${result.issues.join("\n")}`);
  const out = path.resolve(o.out ?? tracePath);
  writeFileSync(out, JSON.stringify(result.spec, null, o.compact ? 0 : 2) + "\n");
  console.log(`Added ${notes.flows.length} flow summaries and ${notes.insights.length} insights${o.answer ? "" : ` in ${Math.round((Date.now() - started) / 1000)} s`}`);
  if (report.droppedCitations.length) console.log(`  dropped ${report.droppedCitations.length} citations that point at no real line: ${report.droppedCitations.slice(0, 5).join(", ")}${report.droppedCitations.length > 5 ? ", ..." : ""}`);
  if (report.droppedItems.length) console.log(`  dropped ${report.droppedItems.join(", ")}`);
  console.log(`Wrote ${path.relative(process.cwd(), out) || out}`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
}
