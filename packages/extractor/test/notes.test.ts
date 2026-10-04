import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateTraceSpec } from "@vibesim/spec";
import { analyzeRepo } from "../src/analyze.ts";
import { applyReview, explainPrompt, parseNotes, reviewPrompt } from "../src/notes.ts";

const root = path.resolve(import.meta.dirname, "../../../fixtures/repos/paytmentgateway");
const spec = analyzeRepo(root, { repoName: "paytmentgateway", now: new Date(0) });
const generator = { tool: "test", generatedAt: "2026-10-04T00:00:00.000Z" };

const answer = (o: unknown) => `Here is my review.\n${JSON.stringify(o)}\nDone.`;

describe("AI notes", () => {
  it("the prompt gives the LLM our flows with evidence, and our findings to avoid repeating", () => {
    const p = explainPrompt(spec);
    expect(p).toContain("flow:route:POST:/payments");
    expect(p).toMatch(/@ src\/[\w/]+\.js:\d+/);
    for (const f of spec.findings) expect(p).toContain(f.title);
  });

  it("keeps citations that point at real lines, with the code around them, and drops the rest", () => {
    const report = parseNotes(answer({
      flows: [
        { id: "flow:route:POST:/payments", summary: "Creates a payment.", evidence: ["src/middleware/auth.js:10", "src/nope.js:3", "src/middleware/auth.js:99999"] },
        { id: "flow:route:GET:/missing", summary: "Not a flow here.", evidence: [] },
      ],
      insights: [
        { title: "Real", explanation: "Cites real code.", severity: "medium", evidence: ["`src/config/db.js:4`", "src/config/db.js:4"] },
        { title: "Invented", explanation: "Cites nothing real.", severity: "high", evidence: ["src/invented.js:1"] },
        { title: "Escapes", explanation: "Points outside the repo.", severity: "high", evidence: ["../job-scheduler/api/server.js:1", "/etc/passwd:1"] },
        { title: "Odd severity", explanation: "Gets low.", severity: "critical", evidence: ["db/schema.sql:13"] },
      ],
    }), spec, root, generator);
    expect(report.notes.flows).toHaveLength(1);
    const cited = report.notes.flows[0]!.evidence;
    expect(cited.map((e) => `${e.file}:${e.line}`)).toEqual(["src/middleware/auth.js:10"]);
    expect(cited[0]!.context!.lines.length).toBeGreaterThan(3);
    expect(report.notes.insights.map((n) => n.title)).toEqual(["Real", "Odd severity"]);
    expect(report.notes.insights[0]!.evidence).toHaveLength(1); // duplicates collapse
    expect(report.notes.insights[1]!.severity).toBe("low");
    expect(report.droppedCitations).toEqual(expect.arrayContaining(["src/nope.js:3", "src/invented.js:1", "/etc/passwd:1"]));
    expect(report.droppedItems).toEqual(expect.arrayContaining(["summary for flow:route:GET:/missing", 'insight "Invented"', 'insight "Escapes"']));
    expect(validateTraceSpec({ ...spec, notes: report.notes }).ok).toBe(true);
  });

  it("the review keeps, fixes and drops notes, and counts what it skipped", () => {
    const { notes } = parseNotes(answer({
      flows: [
        { id: "flow:route:POST:/payments", summary: "Always returns 201.", evidence: ["src/controllers/paymentController.js:19"] },
        { id: "flow:route:GET:/health", summary: "Returns 200.", evidence: [] },
        { id: "flow:route:GET:/payments", summary: "Lists payments.", evidence: [] },
      ],
      insights: [
        { title: "A", explanation: "True.", severity: "low", evidence: ["db/schema.sql:13"] },
        { title: "B", explanation: "False.", severity: "high", evidence: ["db/schema.sql:13"] },
      ],
    }), spec, root, generator);
    expect(reviewPrompt(notes)).toContain("Always returns 201.");
    const r = applyReview(notes, answer({
      flows: [
        { flow: "flow:route:POST:/payments", verdict: "fix", summary: "Returns 201, or 400/401/409/500.", reason: "not always" },
        { flow: "flow:route:GET:/health", verdict: "keep" },
      ],
      insights: [{ n: 0, verdict: "keep" }, { n: 1, verdict: "drop", reason: "wrong" }],
    }));
    expect(r.notes.flows.map((f) => f.summary)).toEqual(["Returns 201, or 400/401/409/500.", "Returns 200.", "Lists payments."]);
    expect(r.notes.insights.map((n) => n.title)).toEqual(["A"]);
    expect(r.kept).toBe(2);
    expect(r.fixed).toHaveLength(1);
    expect(r.dropped).toEqual(['insight "B"']);
    expect(r.unreviewed).toBe(1);
  });
});
