// Dumps every user-facing statement the viewer shows for a trace, as Markdown,
// so a reviewer can check each one against the source code.
//   node scripts/dump-text.ts <gallery-id | path/to/trace.json> [out.md]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateTraceSpec } from "@vibesim/spec";
import { buildModel, buildTimeline } from "../src/lib/model.ts";
import { edgeFlags, edgeSentence, kindInfo, lifecycleInfo, protocolInfo } from "../src/lib/explain.ts";
import { buildOverview } from "../src/lib/summary.ts";
import { GALLERY } from "./gallery.config.ts";

const [arg, out] = process.argv.slice(2);
if (!arg) {
  console.error("usage: node scripts/dump-text.ts <gallery-id | trace.json> [out.md]");
  process.exit(1);
}
const file = arg.endsWith(".json") ? arg : path.join(import.meta.dirname, "../public/gallery", `${arg}.trace.json`);
const result = validateTraceSpec(JSON.parse(readFileSync(file, "utf8")));
if (!result.ok) throw new Error(result.issues.join("\n"));
const spec = result.spec;
const model = buildModel(spec);
const entry = GALLERY.find((g) => g.id === arg);
const lines: string[] = [];
const say = (s = "") => lines.push(s);
const ev = (e: { file: string; line: number; snippet?: string }) => `\`${e.file}:${e.line}\`${e.snippet ? ` — \`${e.snippet.slice(0, 160)}\`` : ""}`;

say(`# What the viewer says about ${entry?.title ?? spec.meta.repo.name}`);
say();
const o = buildOverview(model);
say("## Overview tab");
if (entry) say(`Tagline: ${entry.tagline}`);
say(`Headline: ${o.headline}`);
say();
say("What it's made of:");
for (const m of o.madeOf) say(`- ${m}`);
say();
say("How work comes in:");
for (const m of o.entry) say(`- ${m}`);
say();
say("Busiest paths:");
for (const b of o.busiest) say(`- ${b.text}`);
say();
say("Patterns this code uses:");
for (const p of o.patterns) say(`- ${p.concept}: ${p.text}`);
say();
say("Talking points:");
for (const t of o.talkingPoints) say(`- ${t}`);
say();
say("Guided tour:");
for (const [i, t] of (entry?.walkthrough ?? o.tour.map((x) => ({ title: x.title, body: x.body, flow: x.flow }))).entries()) say(`${i + 1}. **${t.title}** (${t.flow}): ${t.body}`);
say();

say("## Boxes (nodes)");
for (const n of spec.nodes) {
  const info = kindInfo(n.kind);
  const p = n.props;
  const facts: string[] = [];
  if (typeof p.method === "string") facts.push(`Route: ${p.method} ${String(p.path)}`);
  if (typeof p.engine === "string") facts.push(`Engine: ${p.engine}`);
  if (typeof p.library === "string") facts.push(`Library: ${p.library}`);
  if (typeof p.poolMax === "number") facts.push(`Pool size: ${p.poolMax}${p.poolMaxDefault ? " (library default)" : ""}`);
  if (typeof p.intervalMs === "number") facts.push(`Interval: ${p.intervalMs} ms${p.loop ? " (reschedules itself)" : ""}`);
  if (typeof p.channel === "string") facts.push(`Channel: ${p.channel}`);
  if (typeof p.pool === "string") facts.push(`Runs on: ${p.pool}`);
  if (typeof p.host === "string") facts.push(`Host: ${p.host}`);
  if (typeof p.rateLimit === "string") facts.push(`Rate limit: ${p.rateLimit}`);
  if (Array.isArray(p.mutatesModuleState)) facts.push(`Module state: ${(p.mutatesModuleState as string[]).join(", ")}`);
  say(`- **${n.label}** [${info.title}, id \`${n.id}\`, ${n.confidence}] ${ev(n.evidence[0]!)}${facts.length ? `; ${facts.join("; ")}` : ""}`);
}
say();

say("## Flows (each hop as the Flows tab captions it)");
for (const f of spec.flows) {
  const tl = buildTimeline(model, f, { collapseLibraryMiddleware: false });
  say(`### ${f.label}  \`${f.id}\``);
  say(`Entry: ${model.nodes.get(f.entry)!.label}. ${f.steps.length} hops.`);
  let i = 0;
  for (const item of tl.items) {
    i++;
    if (item.kind === "return") {
      const label = (id: string) => model.nodes.get(id)?.label ?? id;
      say(`${i}. ↩ ${label(item.to)} gets the result back from ${label(item.from)}.`);
      continue;
    }
    const e = item.edge;
    const from = model.nodes.get(e.from)!;
    const to = model.nodes.get(e.to)!;
    const flags = edgeFlags(e).map((x) => x.title);
    say(`${i}. ${edgeSentence(e, from, to)}`);
    say(`   - ${protocolInfo(e.protocol).label} · ${lifecycleInfo(e.lifecycle).label} · ${e.mode === "sync" ? "waits" : "doesn't wait"}${e.label ? ` · op: ${e.label}` : ""}${flags.length ? ` · ${flags.join("; ")}` : ""}${e.confidence !== "verified" ? ` · ${e.confidence}` : ""}`);
    say(`   - evidence: ${ev(e.evidence[0]!)}`);
    if (typeof e.props.sql === "string") say(`   - SQL: \`${e.props.sql.replace(/\s+/g, " ").slice(0, 300)}\`${Array.isArray(e.props.missingIndex) ? ` (says no index covers ${(e.props.missingIndex as string[]).join(", ")})` : ""}`);
  }
  say();
}

say("## Findings");
for (const f of spec.findings) {
  say(`### [${f.severity}] ${f.title}  (${f.rule})`);
  say(f.consequence);
  if (f.fix) say(`Fix: ${f.fix}`);
  say(`Evidence: ${f.evidence.map(ev).join("; ")}`);
  say();
}

say("## Unresolved");
for (const g of spec.gaps) say(`- ${g.reason} ${ev(g.evidence[0]!)}`);
if (!spec.gaps.length) say("None.");

const text = lines.join("\n") + "\n";
if (out) writeFileSync(out, text);
else process.stdout.write(text);
