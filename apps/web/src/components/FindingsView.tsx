import { useState } from "react";
import type { Model, Severity } from "../lib/model.ts";
import { flowsTouching } from "../lib/model.ts";
import { FindingCard } from "./Inspector.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { AiInsights } from "./AiNotes.tsx";

const LEVELS: Severity[] = ["high", "medium", "low"];

export function FindingsView({ model, onShowFlow, onOpenConcept }: { model: Model; onShowFlow(flowId: string, ref: string): void; onOpenConcept(id: string): void }) {
  const [level, setLevel] = useState<Severity | "all">("all");
  const [openCode, setOpenCode] = useState<string | undefined>();
  const all = model.spec.findings;
  const shown = level === "all" ? all : all.filter((f) => f.severity === level);
  return (
    <div className="map-wrap">
      <div className="findings-page" data-testid="findings">
        <div>
          <h2 style={{ fontSize: 18 }}>What breaks at scale</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Detected from the code with fixed rules, no AI guessing. Each one links to the line that causes it.
          </p>
        </div>
        <div className="filter-row">
          <button className={`chip${level === "all" ? " accent" : ""}`} onClick={() => setLevel("all")}>All {all.length}</button>
          {LEVELS.map((l) => {
            const n = all.filter((f) => f.severity === l).length;
            return n ? (
              <button key={l} className={`chip${level === l ? " accent" : ""}`} onClick={() => setLevel(l)}>
                <span className={`sev ${l}`} />{l} {n}
              </button>
            ) : null;
          })}
        </div>
        {!shown.length && <div className="empty">No findings{level === "all" ? " in this repo. Nice." : ` at ${level} severity.`}</div>}
        {shown.map((f) => {
          const flow = f.refs.map((r) => flowsTouching(model, r)[0]).find(Boolean);
          return (
            <div key={f.id} style={{ display: "grid", gap: 6 }}>
              <FindingCard
                finding={f}
                onOpenConcept={onOpenConcept}
                extra={<>
                  {flow && <button className="btn small" onClick={() => onShowFlow(flow.id, f.refs[0]!)}>Show in flow</button>}
                  <button className="btn small ghost" onClick={() => setOpenCode(openCode === f.id ? undefined : f.id)}>
                    {openCode === f.id ? "Hide code" : `${f.evidence[0]!.file}:${f.evidence[0]!.line}`}
                  </button>
                </>}
              />
              {openCode === f.id && <CodeBlock evidence={f.evidence[0]!} />}
            </div>
          );
        })}
        {model.spec.notes && <AiInsights notes={model.spec.notes} />}
      </div>
    </div>
  );
}
