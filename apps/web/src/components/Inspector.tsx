import { Fragment, useState } from "react";
import type { Finding, TraceEdge, TraceNode } from "@vibesim/spec";
import { concept } from "@vibesim/catalog";
import type { Model } from "../lib/model.ts";
import { flowsTouching } from "../lib/model.ts";
import { edgeFlags, edgeSentence, kindInfo, lifecycleInfo, protocolInfo } from "../lib/explain.ts";
import { chosenResponse, eventCaption, eventFacts, eventTitle } from "../lib/describe.ts";
import type { ActiveEvent } from "./FlowStage.tsx";
import { CodeBlock } from "./CodeBlock.tsx";
import { KindChip, NodeIcon, nodeColor } from "./ui.tsx";

interface Props {
  model: Model;
  selection?: string;
  /** The step the devices view is showing; takes over the panel unless a box was clicked. */
  event?: ActiveEvent;
  onOpenConcept(id: string): void;
  onShowFlow(flowId: string, ref: string): void;
}

export function Inspector({ model, selection, event, onOpenConcept, onShowFlow }: Props) {
  const ev = event?.scene.events[event.index];
  if (event && ev && (!selection || selection === ev.edge.id)) {
    return <EventView model={model} event={event} onOpenConcept={onOpenConcept} onShowFlow={onShowFlow} />;
  }
  if (!selection) {
    return (
      <div className="empty">
        <strong style={{ color: "var(--text)" }}>Click any arrow or box</strong>
        <span>Arrows are hops (a function call, a query, an HTTP request). Boxes are the things involved. You'll see what each one is, the code that proves it, and what can go wrong.</span>
      </div>
    );
  }
  const edge = model.edges.get(selection);
  if (edge) return <EdgeView model={model} edge={edge} onOpenConcept={onOpenConcept} onShowFlow={onShowFlow} />;
  const node = model.nodes.get(selection);
  if (node) return <NodeView model={model} node={node} onOpenConcept={onOpenConcept} onShowFlow={onShowFlow} />;
  return <div className="empty">Nothing selected.</div>;
}

const KIND_TEXT: Record<string, string> = { request: "Request", send: "One-way message", reply: "Reply", ack: "Acknowledgement", response: "Response", local: "Function call" };

/** One step of a flow, like Packet Tracer's PDU details: what travels, over what, and why. */
function EventView({ model, event, onOpenConcept, onShowFlow }: { model: Model; event: ActiveEvent } & Pick<Props, "onOpenConcept" | "onShowFlow">) {
  const { scene, index } = event;
  const ev = scene.events[index]!;
  const edge = ev.edge;
  const to = model.nodes.get(edge.to)!;
  const findings = [...(model.findingsByRef.get(edge.id) ?? []), ...(ev.kind === "request" || ev.kind === "local" ? model.findingsByRef.get(edge.to) ?? [] : [])];
  const unique = findings.filter((f, i) => findings.findIndex((x) => x.id === f.id) === i);
  const concepts = [...new Set([...edge.concepts, ...to.concepts, ...unique.flatMap((f) => (f.concept ? [f.concept] : []))])];
  const response = ev.kind === "response" ? chosenResponse(model, scene, ev) : undefined;
  const responder = ev.from.stage ? model.nodes.get(ev.from.stage) : undefined;
  return (
    <div className="insp" data-testid="inspector">
      <div className="insp-section">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip accent">Step {index + 1} of {scene.events.length}</span>
          <span className={`ev-kind ev-${ev.kind}`}>{KIND_TEXT[ev.kind]}</span>
        </div>
        <h3 style={{ wordBreak: "break-word" }}>{eventTitle(model, scene, ev)}</h3>
        <p style={{ margin: 0, color: "var(--text-dim)" }}>{eventCaption(model, scene, ev)}</p>
      </div>
      <dl className="facts">
        {eventFacts(model, scene, ev).map((f) => (
          <Fragment key={f.label}><dt>{f.label}</dt><dd className={f.mono ? "mono" : undefined} style={f.mono ? { wordBreak: "break-word" } : undefined}>{f.value}</dd></Fragment>
        ))}
      </dl>
      {ev.kind === "response" && response && responder ? (
        <div className="insp-section">
          <span className="insp-label">Where it answers</span>
          <span className="mono" style={{ fontSize: 12.5 }}>{String(responder.props.file ?? responder.evidence[0]?.file)}:{response.line}</span>
        </div>
      ) : (
        edge.evidence[0] && (
          <div className="insp-section">
            <span className="insp-label">{ev.kind === "reply" || ev.kind === "ack" ? "The call this answers" : "The code that does it"}</span>
            <CodeBlock evidence={edge.evidence[0]} />
          </div>
        )
      )}
      <FindingsBlock findings={unique} onOpenConcept={onOpenConcept} />
      <ConceptChips ids={concepts} onOpenConcept={onOpenConcept} />
      <OtherFlows model={model} id={edge.id} onShowFlow={onShowFlow} />
    </div>
  );
}

function EdgeView({ model, edge, onOpenConcept, onShowFlow }: { model: Model; edge: TraceEdge } & Pick<Props, "onOpenConcept" | "onShowFlow">) {
  const from = model.nodes.get(edge.from)!;
  const to = model.nodes.get(edge.to)!;
  const findings = model.findingsByRef.get(edge.id) ?? [];
  const proto = protocolInfo(edge.protocol);
  const lc = lifecycleInfo(edge.lifecycle);
  const flags = edgeFlags(edge);
  const concepts = [...new Set([...edge.concepts, ...to.concepts, ...findings.flatMap((f) => (f.concept ? [f.concept] : []))])];
  return (
    <div className="insp" data-testid="inspector">
      <div className="insp-section">
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="chip accent">{proto.label === "call" ? "function call" : proto.label}</span>
          <span className="chip">{lc.label}</span>
          <span className="chip">{edge.mode === "sync" ? "waits" : "doesn't wait"}</span>
          {edge.confidence !== "verified" && <span className="chip" style={{ color: "var(--sev-medium)" }}>{edge.confidence}</span>}
        </div>
        <h3 className="row" style={{ gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
          <span style={{ color: nodeColor(from) }}>{from.label}</span>
          <span className="faint">→</span>
          <span style={{ color: nodeColor(to) }}>{to.label}</span>
        </h3>
        <p style={{ margin: 0, color: "var(--text-dim)" }}>{edgeSentence(edge, from, to)}</p>
      </div>
      {edge.confidence === "unresolved" && (
        <div className="fix">
          The parser couldn't tell what runs here, so this hop is shown dashed instead of guessed.
          {model.spec.gaps.find((g) => g.refs.includes(edge.id))?.reason ? ` ${model.spec.gaps.find((g) => g.refs.includes(edge.id))!.reason}` : ""}
        </div>
      )}
      <dl className="facts">
        <dt>Protocol</dt><dd>{proto.blurb}</dd>
        <dt>Connection</dt><dd>{lc.blurb}</dd>
        {edge.label && <><dt>Operation</dt><dd className="mono" style={{ wordBreak: "break-word" }}>{edge.label}</dd></>}
        {flags.length > 0 && <><dt>Notes</dt><dd>{flags.map((f) => f.title).join(". ")}.</dd></>}
        {typeof edge.props.wrappedBy === "string" && <><dt>Wrapped by</dt><dd className="mono">{edge.props.wrappedBy}</dd></>}
      </dl>
      {typeof edge.props.sql === "string" && (
        <div className="insp-section">
          <span className="insp-label">SQL</span>
          <div className="code"><pre style={{ padding: "8px 10px", whiteSpace: "pre-wrap" }}>{edge.props.sql}</pre></div>
          {Array.isArray(edge.props.missingIndex) && <span className="sev-text medium" style={{ fontSize: 13 }}>No index covers {edge.props.missingIndex.join(", ")} in this repo's schema.</span>}
        </div>
      )}
      {edge.evidence.map((ev, i) => (
        <div className="insp-section" key={i}>
          <span className="insp-label">{i === 0 ? "Proof in the code" : "Also"}</span>
          <CodeBlock evidence={ev} />
          {typeof edge.props.via === "object" && edge.props.via !== null && (
            <span className="faint" style={{ fontSize: 12.5 }}>
              Through a thin wrapper at <span className="mono">{(edge.props.via as { file: string; line: number }).file}:{(edge.props.via as { file: string; line: number }).line}</span>.
            </span>
          )}
        </div>
      ))}
      <FindingsBlock findings={findings} onOpenConcept={onOpenConcept} />
      <ConceptChips ids={concepts} onOpenConcept={onOpenConcept} />
      <OtherFlows model={model} id={edge.id} onShowFlow={onShowFlow} />
    </div>
  );
}

function NodeView({ model, node, onOpenConcept, onShowFlow }: { model: Model; node: TraceNode } & Pick<Props, "onOpenConcept" | "onShowFlow">) {
  const info = kindInfo(node.kind);
  const findings = model.findingsByRef.get(node.id) ?? [];
  const tables = node.props.tables as Record<string, TableProp> | undefined;
  const concepts = [...new Set([...node.concepts, ...findings.flatMap((f) => (f.concept ? [f.concept] : []))])];
  const p = node.props;
  return (
    <div className="insp" data-testid="inspector">
      <div className="insp-section">
        <div className="row"><KindChip node={node} />{node.confidence !== "verified" && <span className="chip" style={{ color: "var(--sev-medium)" }}>{node.confidence}</span>}</div>
        <h3 className="row" style={{ gap: 8 }}><NodeIcon kind={node.kind} size={18} color={nodeColor(node)} />{node.label}</h3>
        <p style={{ margin: 0, color: "var(--text-dim)" }}>{info.blurb}</p>
      </div>
      <dl className="facts">
        {typeof p.method === "string" && <><dt>Route</dt><dd className="mono">{p.method} {String(p.path)}</dd></>}
        {typeof p.engine === "string" && <><dt>Engine</dt><dd>{p.engine}</dd></>}
        {typeof p.library === "string" && <><dt>Library</dt><dd className="mono">{p.library}</dd></>}
        {typeof p.poolMax === "number" && <><dt>Pool size</dt><dd>{p.poolMax} connections{p.poolMaxDefault ? " (the library default; nothing set in code)" : ""}</dd></>}
        {typeof p.intervalMs === "number" && <><dt>Interval</dt><dd>{p.intervalMs} ms{p.loop ? " (reschedules itself)" : ""}</dd></>}
        {typeof p.channel === "string" && <><dt>Channel</dt><dd className="mono">{p.channel}</dd></>}
        {typeof p.pool === "string" && <><dt>Runs on</dt><dd>{p.pool === "event-loop" ? "the main thread (blocks other requests)" : "libuv's background thread pool (4 threads by default)"}</dd></>}
        {typeof p.host === "string" && <><dt>Host</dt><dd className="mono">{p.host}</dd></>}
        {Array.isArray(p.upstreams) && p.upstreams.length > 0 && <><dt>Forwards to</dt><dd className="mono">{(p.upstreams as string[]).join(", ")}</dd></>}
        {typeof p.rateLimit === "string" && <><dt>Rate limit</dt><dd>{p.rateLimit} per client IP</dd></>}
        {Array.isArray(p.mutatesModuleState) && <><dt>Module state</dt><dd className="mono">{(p.mutatesModuleState as string[]).join(", ")}</dd></>}
        {p.backplane === true && <><dt>Backplane</dt><dd>Yes, messages fan out across instances.</dd></>}
      </dl>
      {node.evidence[0] && (
        <div className="insp-section">
          <span className="insp-label">Defined at</span>
          <CodeBlock evidence={node.evidence[0]} />
        </div>
      )}
      {tables && <Tables tables={tables} />}
      <FindingsBlock findings={findings} onOpenConcept={onOpenConcept} />
      <ConceptChips ids={concepts} onOpenConcept={onOpenConcept} />
      <OtherFlows model={model} id={node.id} onShowFlow={onShowFlow} />
    </div>
  );
}

interface TableProp {
  columns: string[];
  indexes: { name: string; columns: string[]; unique: boolean; source: string }[];
  redundant: { index: string; coveredBy: string }[];
}

function Tables({ tables }: { tables: Record<string, TableProp> }) {
  const [open, setOpen] = useState(false);
  const names = Object.keys(tables);
  return (
    <div className="insp-section">
      <span className="insp-label">Tables and indexes ({names.length}, from the repo's .sql files)</span>
      {(open ? names : names.slice(0, 4)).map((name) => {
        const t = tables[name]!;
        return (
          <div key={name} style={{ fontSize: 12.5, display: "grid", gap: 3 }}>
            <span className="mono" style={{ fontWeight: 600 }}>{name}</span>
            {t.indexes.map((i) => (
              <span key={i.name} className="mono faint" style={{ paddingLeft: 10 }}>
                {i.unique ? "unique " : ""}({i.columns.join(", ")}){i.source !== "index" ? ` · ${i.source}` : ` · ${i.name}`}
                {t.redundant.some((r) => r.index === i.name) && <span className="sev-text low"> · redundant</span>}
              </span>
            ))}
          </div>
        );
      })}
      {names.length > 4 && <button className="btn small ghost" onClick={() => setOpen(!open)}>{open ? "Show fewer" : `Show all ${names.length}`}</button>}
    </div>
  );
}

export function FindingCard({ finding, onOpenConcept, extra }: { finding: Finding; onOpenConcept?(id: string): void; extra?: React.ReactNode }) {
  const [showFix, setShowFix] = useState(false);
  const c = finding.concept ? concept(finding.concept) : undefined;
  return (
    <div className={`finding ${finding.severity}`} data-testid="finding">
      <div className="row" style={{ alignItems: "flex-start" }}>
        <span className={`sev ${finding.severity}`} style={{ marginTop: 6 }} />
        <span className="finding-title grow">{finding.title}</span>
        <span className={`sev-text ${finding.severity}`} style={{ fontSize: 11.5, textTransform: "uppercase", fontWeight: 600 }}>{finding.severity}</span>
      </div>
      <p>{finding.consequence}</p>
      <div className="row wrap">
        {finding.fix && <button className="btn small" onClick={() => setShowFix(!showFix)}>{showFix ? "Hide fix" : "How to fix"}</button>}
        {c && onOpenConcept && <button className="chip" onClick={() => onOpenConcept(c.id)}>Learn: {c.title}</button>}
        {extra}
      </div>
      {showFix && finding.fix && <div className="fix">{finding.fix}</div>}
    </div>
  );
}

function FindingsBlock({ findings, onOpenConcept }: { findings: Finding[]; onOpenConcept(id: string): void }) {
  if (!findings.length) return null;
  return (
    <div className="insp-section">
      <span className="insp-label">What breaks at scale</span>
      {findings.map((f) => <FindingCard key={f.id} finding={f} onOpenConcept={onOpenConcept} />)}
    </div>
  );
}

function ConceptChips({ ids, onOpenConcept }: { ids: string[]; onOpenConcept(id: string): void }) {
  const known = ids.map((id) => concept(id)).filter((c) => c !== undefined);
  if (!known.length) return null;
  return (
    <div className="insp-section">
      <span className="insp-label">Go deeper</span>
      <div className="row wrap">
        {known.map((c) => <button key={c.id} className="chip accent" onClick={() => onOpenConcept(c.id)}>{c.title} →</button>)}
      </div>
    </div>
  );
}

function OtherFlows({ model, id, onShowFlow }: { model: Model; id: string; onShowFlow: Props["onShowFlow"] }) {
  const flows = flowsTouching(model, id);
  if (flows.length < 2) return null;
  return (
    <div className="insp-section">
      <span className="insp-label">Also used by {flows.length} flows</span>
      <div className="row wrap">
        {flows.slice(0, 12).map((f) => <button key={f.id} className="chip" onClick={() => onShowFlow(f.id, id)}>{f.label}</button>)}
        {flows.length > 12 && <span className="faint">+{flows.length - 12} more</span>}
      </div>
    </div>
  );
}
