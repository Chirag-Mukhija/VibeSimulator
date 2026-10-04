import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AiNotes, Evidence, TraceSpec } from "@vibesim/spec";
import { truncate } from "./util.ts";

/**
 * The optional LLM tier. An LLM (Claude Code, headless, read-only tools) reads the repo after the parser has,
 * and writes what static analysis cannot: a plain-language summary per flow and insights no rule covers.
 * We never trust its citations blindly: each must point at a real line of a real file in the repo, or it is
 * dropped, and an insight left with no valid citation is dropped with it.
 */

/** Flows to summarize: the ones that cross the most process boundaries, up to `max`. */
export function flowsToExplain(spec: TraceSpec, max = 15): TraceSpec["flows"] {
  const edges = new Map(spec.edges.map((e) => [e.id, e]));
  const network = (f: TraceSpec["flows"][number]) => f.steps.filter((s) => edges.get(s.edge)?.protocol !== "in-process").length;
  return [...spec.flows].sort((a, b) => network(b) - network(a)).slice(0, max);
}

/** The prompt: the flows we extracted (so the LLM builds on them), and our findings (so it doesn't repeat them). */
export function explainPrompt(spec: TraceSpec, max = 15): string {
  const nodes = new Map(spec.nodes.map((n) => [n.id, n]));
  const edges = new Map(spec.edges.map((e) => [e.id, e]));
  const flowText = flowsToExplain(spec, max).map((f) => {
    const hops = f.steps.map((s) => {
      const e = edges.get(s.edge)!;
      const ev = e.evidence[0]!;
      return `    ${nodes.get(e.from)!.label} -> ${nodes.get(e.to)!.label}${e.label ? ` [${e.label}]` : ""} (${e.protocol}) @ ${ev.file}:${ev.line}`;
    }).join("\n");
    return `- ${f.id} "${f.label}"\n${hops}`;
  }).join("\n");
  const findings = spec.findings.map((f) => `- ${f.title}`).join("\n") || "- (none)";
  return `You are reviewing the backend repository in the current directory to help a developer who is new to it understand how it works, well enough to explain it in an interview.

vibeSimulator has already extracted these request flows by static analysis (each hop with the line that makes it):
${flowText}

It already reports these findings (do not repeat them):
${findings}

Add what static analysis cannot:
1. For each flow listed above, a plain-language summary of 2-4 sentences: what the request does from start to finish, the important outcomes (status codes, what is written where), and anything surprising. Write for a developer new to the code.
2. Up to 8 insights about this codebase that are NOT in the findings above: correctness bugs, race conditions, data that can get out of sync, scaling limits, surprising behaviour, security issues, or design decisions an interviewer would ask about.

Rules:
- Every statement must be true for this code. Read the relevant code before you claim anything. If you are not sure, leave it out.
- Cite evidence as path:line for every insight and for every specific claim in a summary.
- Be concrete and short. No generic advice.

Answer with only a JSON object, no prose around it, in exactly this shape:
{"flows":[{"id":"<flow id>","summary":"<2-4 sentences>","evidence":["path:line"]}],"insights":[{"title":"<short>","explanation":"<2-4 sentences>","severity":"high|medium|low","evidence":["path:line"]}]}`;
}

export interface NotesReport {
  notes: AiNotes;
  /** Citations dropped because the file or line does not exist. */
  droppedCitations: string[];
  /** Insights dropped for having no valid citation, and summaries for an unknown flow. */
  droppedItems: string[];
}

const SEVERITY = new Set(["info", "low", "medium", "high"]);

/** Parses the LLM's answer (the JSON object, possibly wrapped in prose) and checks every citation against the repo. */
export function parseNotes(answer: string, spec: TraceSpec, root: string, generator: AiNotes["generator"]): NotesReport {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The LLM's answer has no JSON object in it.");
  const raw = JSON.parse(answer.slice(start, end + 1)) as { flows?: unknown[]; insights?: unknown[] };
  const droppedCitations: string[] = [];
  const droppedItems: string[] = [];
  const files = new Map<string, string[] | null>();
  const realRoot = realpathSync(root);

  const linesOf = (file: string): string[] | null => {
    if (files.has(file)) return files.get(file)!;
    let lines: string[] | null = null;
    try {
      const full = realpathSync(path.resolve(realRoot, file));
      // Only files inside the repo; never follow a citation out of it.
      if (full.startsWith(realRoot + path.sep)) lines = readFileSync(full, "utf8").split("\n");
    } catch {
      lines = null;
    }
    files.set(file, lines);
    return lines;
  };

  const cite = (value: unknown): Evidence | undefined => {
    const m = typeof value === "string" ? /^\s*`?([^`:\s][^`:]*?):(\d+)(?:-(\d+))?`?\s*$/.exec(value) : null;
    if (!m) {
      droppedCitations.push(String(value));
      return undefined;
    }
    const file = path.posix.normalize(m[1]!.replace(/\\/g, "/").replace(/^\.\//, ""));
    const line = Number(m[2]);
    const endLine = m[3] ? Number(m[3]) : undefined;
    const lines = file.startsWith("../") || path.isAbsolute(file) ? null : linesOf(file);
    if (!lines || line < 1 || line > lines.length || (endLine !== undefined && (endLine < line || endLine > lines.length))) {
      droppedCitations.push(String(value));
      return undefined;
    }
    const text = lines[line - 1]!.trim();
    const from = Math.max(1, line - 3);
    const to = Math.min(lines.length, (endLine ?? line) + 3, from + 23);
    return {
      file, line, ...(endLine && endLine > line ? { endLine } : {}), ...(text ? { snippet: truncate(text, 200) } : {}),
      context: { startLine: from, lines: lines.slice(from - 1, to).map((l) => truncate(l.replace(/\t/g, "  "), 400)) },
    };
  };
  const cites = (list: unknown): Evidence[] => {
    const seen = new Set<string>();
    return (Array.isArray(list) ? list : []).map(cite).filter((e): e is Evidence => {
      if (!e || seen.has(`${e.file}:${e.line}`)) return false;
      seen.add(`${e.file}:${e.line}`);
      return true;
    });
  };

  const flowIds = new Set(spec.flows.map((f) => f.id));
  const flows: AiNotes["flows"] = [];
  for (const item of raw.flows ?? []) {
    const f = item as { id?: unknown; summary?: unknown; evidence?: unknown };
    if (typeof f.id !== "string" || !flowIds.has(f.id) || typeof f.summary !== "string" || !f.summary.trim()) {
      droppedItems.push(`summary for ${String(f.id)}`);
      continue;
    }
    flows.push({ flow: f.id, summary: truncate(f.summary.trim(), 1200), evidence: cites(f.evidence) });
  }
  const insights: AiNotes["insights"] = [];
  for (const item of raw.insights ?? []) {
    const n = item as { title?: unknown; explanation?: unknown; severity?: unknown; evidence?: unknown };
    const evidence = cites(n.evidence);
    if (typeof n.title !== "string" || typeof n.explanation !== "string" || !evidence.length) {
      droppedItems.push(`insight "${String(n.title)}"`);
      continue;
    }
    const severity = SEVERITY.has(String(n.severity)) ? (n.severity as AiNotes["insights"][number]["severity"]) : "low";
    insights.push({ title: truncate(n.title.trim(), 200), explanation: truncate(n.explanation.trim(), 1500), severity, evidence });
  }
  return { notes: { generator, flows, insights }, droppedCitations, droppedItems };
}

/**
 * The second pass: a fresh session checks every note against the code and keeps, fixes or drops it. In our
 * tests an independent check like this caught every wrong or misleading sentence the first pass wrote.
 */
export function reviewPrompt(notes: AiNotes): string {
  const flows = notes.flows.map((f) => ({ flow: f.flow, summary: f.summary, evidence: f.evidence.map((e) => `${e.file}:${e.line}`) }));
  const insights = notes.insights.map((n, i) => ({ n: i, title: n.title, explanation: n.explanation, evidence: n.evidence.map((e) => `${e.file}:${e.line}`) }));
  return `Another AI wrote these notes about the backend repository in the current directory, for a developer who is new to it. Your job is to check them, strictly.

For every flow summary and every insight, split it into its factual claims and verify each one against the code (read the cited lines and whatever else you need). Library and runtime behaviour counts too: check the versions this repo actually uses.

Then give a verdict:
- "keep": every claim is true and nothing would mislead a learner.
- "fix": something is wrong, misleading or overstated (for example "always" where there are exceptions). Rewrite it so every statement is true, keeping what was right. Do not add new claims you have not verified.
- "drop": the main point is wrong, or it cannot be fixed without becoming a different note.

Notes to check:
${JSON.stringify({ flows, insights }, null, 1)}

Answer with only a JSON object, no prose around it, in exactly this shape:
{"flows":[{"flow":"<flow id>","verdict":"keep|fix|drop","summary":"<the corrected summary, only for fix>","reason":"<one sentence>"}],"insights":[{"n":0,"verdict":"keep|fix|drop","title":"<corrected, only for fix>","explanation":"<corrected, only for fix>","reason":"<one sentence>"}]}`;
}

export interface ReviewResult {
  notes: AiNotes;
  kept: number;
  fixed: string[];
  dropped: string[];
  /** Notes the review did not mention; kept as they were. */
  unreviewed: number;
}

/** Applies the review's verdicts. A note the review skipped is kept but counted, so the caller can say so. */
export function applyReview(notes: AiNotes, answer: string): ReviewResult {
  const start = answer.indexOf("{");
  const end = answer.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("The review has no JSON object in it.");
  const raw = JSON.parse(answer.slice(start, end + 1)) as { flows?: unknown[]; insights?: unknown[] };
  type Verdict = { verdict?: unknown; summary?: unknown; title?: unknown; explanation?: unknown; reason?: unknown };
  const byFlow = new Map<string, Verdict>();
  for (const v of raw.flows ?? []) {
    const x = v as Verdict & { flow?: unknown };
    if (typeof x.flow === "string") byFlow.set(x.flow, x);
  }
  const byIndex = new Map<number, Verdict>();
  for (const v of raw.insights ?? []) {
    const x = v as Verdict & { n?: unknown };
    if (typeof x.n === "number") byIndex.set(x.n, x);
  }
  const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  let kept = 0;
  let unreviewed = 0;
  const fixed: string[] = [];
  const dropped: string[] = [];
  const flows: AiNotes["flows"] = [];
  for (const f of notes.flows) {
    const v = byFlow.get(f.flow);
    if (!v) unreviewed++;
    if (v?.verdict === "drop") {
      dropped.push(`summary of ${f.flow}`);
      continue;
    }
    if (v?.verdict === "fix") {
      const summary = text(v.summary);
      if (!summary) {
        dropped.push(`summary of ${f.flow} (fix without text)`);
        continue;
      }
      fixed.push(`summary of ${f.flow}`);
      flows.push({ ...f, summary: truncate(summary, 1200) });
      continue;
    }
    if (v) kept++;
    flows.push(f);
  }
  const insights: AiNotes["insights"] = [];
  notes.insights.forEach((n, i) => {
    const v = byIndex.get(i);
    if (!v) unreviewed++;
    if (v?.verdict === "drop") {
      dropped.push(`insight "${n.title}"`);
      return;
    }
    if (v?.verdict === "fix") {
      const explanation = text(v.explanation);
      if (!explanation) {
        dropped.push(`insight "${n.title}" (fix without text)`);
        return;
      }
      fixed.push(`insight "${n.title}"`);
      insights.push({ ...n, title: truncate(text(v.title) ?? n.title, 200), explanation: truncate(explanation, 1500) });
      return;
    }
    if (v) kept++;
    insights.push(n);
  });
  return { notes: { ...notes, flows, insights }, kept, fixed, dropped, unreviewed };
}
