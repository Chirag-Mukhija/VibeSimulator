import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIDENCES, LIFECYCLES, traceSpecJsonSchema, validateTraceSpec } from "../src/index.ts";

const fixturesDir = new URL("../fixtures/", import.meta.url);
const fixtures = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".trace.json"))
  .map((name) => ({ name, json: JSON.parse(readFileSync(new URL(name, fixturesDir), "utf8")) }));

const evidence = [{ file: "src/app.ts", line: 1 }];

/** Deliberately loose: tests build invalid specs on purpose. */
interface Spec {
  schemaVersion: string;
  meta: unknown;
  nodes: { id: string; kind: string; confidence: string; evidence: unknown[]; [key: string]: unknown }[];
  edges: { id: string; to: string; lifecycle: string; confidence: string; [key: string]: unknown }[];
  flows: { id: string; entry: string; steps: { edge: string }[]; [key: string]: unknown }[];
  findings: unknown[];
  gaps: unknown[];
}

/** Smallest spec that exercises every collection. Tests break it one rule at a time. */
function minimalSpec(): Spec {
  return {
    schemaVersion: "1",
    meta: {
      generatedAt: "2026-10-03T00:00:00Z",
      generator: { name: "test", version: "0" },
      repo: { name: "tiny" },
    },
    nodes: [
      { id: "route:a", kind: "route", label: "GET /a", evidence, confidence: "verified" },
      { id: "handler:a", kind: "handler", label: "a", evidence, confidence: "verified" },
      { id: "db:main", kind: "database", label: "db", evidence, confidence: "verified" },
    ],
    edges: [
      { id: "e:1", from: "route:a", to: "handler:a", protocol: "in-process", lifecycle: "none", mode: "sync", evidence, confidence: "verified" },
      { id: "e:2", from: "handler:a", to: "db:main", protocol: "sql", lifecycle: "pooled", mode: "sync", evidence, confidence: "verified" },
    ],
    flows: [{ id: "flow:a", label: "a", entry: "route:a", steps: [{ edge: "e:1" }, { edge: "e:2" }] }],
    findings: [],
    gaps: [],
  };
}

function issuesFor(mutate: (spec: Spec) => void): string[] {
  const spec = minimalSpec();
  mutate(spec);
  const result = validateTraceSpec(spec);
  return result.ok ? [] : result.issues;
}

describe("fixtures", () => {
  it("found the hand-written fixtures", () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual([
      "notifications-polling.trace.json",
      "orders-checkout.trace.json",
    ]);
  });

  it.each(fixtures)("$name validates", ({ json }) => {
    const result = validateTraceSpec(json);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("together cover every confidence and lifecycle value", () => {
    const elements = fixtures.flatMap(({ json }) => [...json.nodes, ...json.edges]);
    const edges = fixtures.flatMap(({ json }) => json.edges);
    expect(new Set(elements.map((e) => e.confidence))).toEqual(new Set(CONFIDENCES));
    expect(new Set(edges.map((e) => e.lifecycle))).toEqual(new Set(LIFECYCLES));
  });
});

describe("validateTraceSpec", () => {
  it("accepts the minimal spec and applies defaults", () => {
    const spec = minimalSpec();
    const { findings: _f, gaps: _g, ...withoutOptional } = spec;
    const result = validateTraceSpec(withoutOptional);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.findings).toEqual([]);
    expect(result.spec.gaps).toEqual([]);
    expect(result.spec.nodes[0]?.source).toBe("parser");
    expect(result.spec.nodes[0]?.concepts).toEqual([]);
  });

  it("returns issues instead of throwing on garbage", () => {
    for (const input of [null, 42, "tracer", {}, { schemaVersion: "1" }, { ...minimalSpec(), nodes: "x" }]) {
      const result = validateTraceSpec(input);
      expect(result.ok).toBe(false);
    }
  });

  const cases: [string, (s: Spec) => void, string][] = [
    ["wrong schema version", (s) => void (s.schemaVersion = "2"), "schemaVersion"],
    ["typo'd key (strict objects)", (s) => void Object.assign(s.nodes[0]!, { kidn: "route" }), "kidn"],
    ["duplicate id across collections", (s) => void (s.flows[0]!.id = "e:1"), 'duplicate id "e:1"'],
    ["whitespace in id", (s) => void (s.nodes[0]!.id = "route a"), "whitespace"],
    ["edge to a missing node", (s) => void (s.edges[1]!.to = "db:nope"), 'unknown node "db:nope"'],
    ["node without evidence", (s) => void (s.nodes[0]!.evidence = []), "nodes[0].evidence"],
    ["absolute evidence path", (s) => void (s.nodes[0]!.evidence = [{ file: "/etc/passwd", line: 1 }]), "repo-relative"],
    ["evidence path escaping the repo", (s) => void (s.nodes[0]!.evidence = [{ file: "src/../../x.ts", line: 1 }]), "repo-relative"],
    ["endLine before line", (s) => void (s.nodes[0]!.evidence = [{ file: "a.ts", line: 9, endLine: 3 }]), "endLine"],
    ["verified edge claimed by an LLM", (s) => void Object.assign(s.edges[1]!, { source: "llm" }), 'requires source "parser"'],
    ["inferred node with parser source", (s) => void (s.nodes[2]!.confidence = "inferred"), 'requires source "llm" or "manual"'],
    ["unknown kind that claims to be verified", (s) => void (s.nodes[2]!.kind = "unknown"), 'requires confidence "unresolved"'],
    ["in-process edge with a pooled connection", (s) => void (s.edges[0]!.lifecycle = "pooled"), '"in-process" and lifecycle "none"'],
    ["network edge with no lifecycle", (s) => void (s.edges[1]!.lifecycle = "none"), '"in-process" and lifecycle "none"'],
    ["flow entry that does not exist", (s) => void (s.flows[0]!.entry = "route:nope"), 'unknown node "route:nope"'],
    ["flow in an unknown service", (s) => void (s.flows[0]!.service = "svc:nope"), 'unknown service "svc:nope"'],
    ["flow step the walk has not reached", (s) => void s.flows[0]!.steps.reverse(), "has not reached"],
    ["same edge twice in one flow", (s) => void s.flows[0]!.steps.push({ edge: "e:1" }), "appears twice"],
    ["flow step to a missing edge", (s) => void s.flows[0]!.steps.push({ edge: "e:9" }), 'unknown edge "e:9"'],
    [
      "finding that refs a missing element",
      (s) => void s.findings.push({ id: "f:1", rule: "x", severity: "low", title: "t", consequence: "c", refs: ["e:9"], evidence }),
      'unknown node or edge "e:9"',
    ],
    ["unresolved element without a gap", (s) => void (s.edges[1]!.confidence = "unresolved"), "not covered by any gap"],
    [
      "gap covering a verified element",
      (s) => void s.gaps.push({ id: "gap:1", refs: ["e:2"], reason: "r", evidence }),
      "may only cover unresolved",
    ],
  ];

  it.each(cases)("rejects %s", (_name, mutate, expected) => {
    const issues = issuesFor(mutate);
    expect(issues.join("\n")).toContain(expected);
  });

  it("accepts an unresolved element once a gap covers it", () => {
    const issues = issuesFor((s) => {
      s.edges[1]!.confidence = "unresolved";
      s.gaps.push({ id: "gap:1", refs: ["e:2"], reason: "dynamic call", evidence });
    });
    expect(issues).toEqual([]);
  });
});

describe("JSON Schema", () => {
  it("committed schema file matches the zod schema (run `pnpm --filter @vibesim/spec build:schema`)", () => {
    const committed = JSON.parse(readFileSync(new URL("../schema/trace-spec.v1.schema.json", import.meta.url), "utf8"));
    expect(committed).toEqual(traceSpecJsonSchema());
  });
});
