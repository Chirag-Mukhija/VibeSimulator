import { useState } from "react";
import type { AiNotes, Evidence } from "@vibesim/spec";
import { CodeBlock } from "./CodeBlock.tsx";

/** Marks text an LLM wrote, so it is never mistaken for what the parser proved. */
export function AiBadge() {
  return <span className="ai-badge" title="Written by an AI that read the code, not by the parser">AI</span>;
}

function provenance(notes: AiNotes): string {
  const who = /claude/i.test(notes.generator.tool) ? "Claude" : "an AI";
  return `Written by ${who} after reading the code, not detected by the parser.${notes.generator.reviewed ? ` ${notes.generator.reviewed}` : " Each note cites the lines it is based on; check them before relying on it."}`;
}

/** The lines a note cites, each one a button that opens the code. */
function Citations({ evidence, id }: { evidence: Evidence[]; id: string }) {
  const [open, setOpen] = useState<number>();
  if (!evidence.length) return null;
  return (
    <>
      <div className="row wrap ai-cites">
        {evidence.map((e, i) => (
          <button key={`${id}-${i}`} className={`btn small ghost${open === i ? " on" : ""}`} onClick={() => setOpen(open === i ? undefined : i)}>
            {e.file}:{e.line}
          </button>
        ))}
      </div>
      {open !== undefined && evidence[open] && <CodeBlock evidence={evidence[open]!} />}
    </>
  );
}

/** Bugs, risks and design points from the AI review, below what the rules found. */
export function AiInsights({ notes }: { notes: AiNotes }) {
  if (!notes.insights.length) return null;
  return (
    <section className="card ai-notes" data-testid="ai-insights">
      <h3>From an AI code review <AiBadge /></h3>
      <p className="faint ai-provenance">{provenance(notes)}</p>
      {notes.insights.map((n, i) => (
        <article key={i} className="ai-insight" data-testid="ai-insight">
          <div className="row"><span className={`sev ${n.severity}`} title={`${n.severity} severity`} /><b className="grow">{n.title}</b></div>
          <p>{n.explanation}</p>
          <Citations evidence={n.evidence} id={`insight-${i}`} />
        </article>
      ))}
    </section>
  );
}

/**
 * "What this request does", start to finish: the AI summary for one flow, if there is one. Two lines until the
 * reader asks for more, so the flow's scene keeps its room.
 */
export function AiFlowSummary({ notes, flowId }: { notes?: AiNotes; flowId: string }) {
  const [more, setMore] = useState(false);
  const [sources, setSources] = useState(false);
  const note = notes?.flows.find((f) => f.flow === flowId);
  if (!notes || !note) return null;
  return (
    <div className={`ai-summary${more ? " open" : ""}`} data-testid="ai-summary">
      <p>
        <span className="ai-summary-label">What this request does <AiBadge /></span>
        {note.summary}
      </p>
      <div className="row wrap ai-summary-actions">
        <button className="linklike" onClick={() => setMore(!more)} aria-expanded={more}>{more ? "Less" : "More"}</button>
        {more && note.evidence.length > 0 && (
          <button className="linklike" onClick={() => setSources(!sources)} aria-expanded={sources}>{sources ? "Hide sources" : `Sources (${note.evidence.length})`}</button>
        )}
        {more && <span className="faint ai-provenance">{provenance(notes)}</span>}
      </div>
      {more && sources && <Citations evidence={note.evidence} id={`flow-${flowId}`} />}
    </div>
  );
}
