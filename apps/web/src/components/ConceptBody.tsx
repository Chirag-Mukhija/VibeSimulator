import { concept, page, sceneFor } from "@vibesim/catalog";
import { currentRepo } from "../lib/session.ts";
import { flowsTouching } from "../lib/model.ts";
import { href } from "../lib/router.ts";
import { SimLab } from "./SimLab.tsx";
import { ConceptSceneView } from "./ConceptScene.tsx";
import { NodeIcon, nodeColor } from "./ui.tsx";

/**
 * Everything about one concept, shared by the Learn page and the drawer: the animated scene,
 * the explanation, where it shows up in the repo being viewed, and the calibrated numbers.
 */
export function ConceptBody({ id, compact = false, onOpen }: { id: string; compact?: boolean; onOpen?(id: string): void }) {
  const c = concept(id);
  const p = page(id);
  const scene = sceneFor(id);
  if (!c) return null;
  return (
    <>
      {scene && <ConceptSceneView key={scene.id} scene={scene} compact={compact} />}
      {p ? (
        <>
          <section className="learn-section">
            <h2>The problem it solves</h2>
            <p>{p.problem}</p>
          </section>
          <section className="learn-section">
            <h2>How it works</h2>
            {p.how.map((t) => <p key={t}>{t}</p>)}
            {p.code && (
              <div style={{ display: "grid", gap: 6 }}>
                <span className="muted" style={{ fontSize: 13 }}>{p.code.caption}</span>
                <div className="code"><pre style={{ padding: "10px 12px" }}>{p.code.text}</pre></div>
              </div>
            )}
          </section>
          <section className="learn-section">
            <h2>When it breaks</h2>
            <ul>{p.breaks.map((b) => <li key={b}>{b}</li>)}</ul>
          </section>
        </>
      ) : (
        <p className="faint" style={{ margin: 0 }}>A full page is not written for this concept yet.</p>
      )}
      <InYourRepo id={id} />
      {p && (compact ? (
        <details className="measure">
          <summary>Measure it: the calibrated simulation (numbers, predict then run)</summary>
          <SimLab key={c.id} sim={p.sim} compact />
        </details>
      ) : (
        <section className="learn-section">
          <h2>Measure it</h2>
          <p>The scene above shows the mechanism. This simulation puts numbers on it, using CPU and memory costs measured on a real Node server.</p>
          <SimLab sim={p.sim} />
        </section>
      ))}
      {c.related.length > 0 && (
        <section className="learn-section">
          <h2>Related</h2>
          <div className="row wrap">
            {c.related.map((r) => concept(r)).filter((r) => r !== undefined).map((r) => (
              onOpen
                ? <button key={r.id} className="chip" onClick={() => onOpen(r.id)}>{r.title}</button>
                : <a key={r.id} className="chip" href={href(["learn", r.id])}>{r.title}</a>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** Where this concept shows up in the repo the reader last opened. */
export function InYourRepo({ id }: { id: string }) {
  const repo = currentRepo();
  if (!repo) return null;
  const { model } = repo;
  const nodes = model.spec.nodes.filter((n) => n.concepts.includes(id));
  const edges = model.spec.edges.filter((e) => e.concepts.includes(id));
  const findings = model.spec.findings.filter((f) => f.concept === id);
  if (!nodes.length && !edges.length && !findings.length) {
    return (
      <section className="learn-section">
        <h2>In {repo.title}</h2>
        <p className="faint">Nothing in this repo uses it directly.</p>
      </section>
    );
  }
  return (
    <section className="learn-section" data-testid="in-your-repo">
      <h2>In {repo.title}</h2>
      <div style={{ display: "grid", gap: 8 }}>
        {nodes.slice(0, 6).map((n) => {
          const flow = flowsTouching(model, n.id)[0];
          return (
            <a key={n.id} className="card" style={{ padding: "10px 12px" }} href={flow ? href(["repo", repo.id], { tab: "flows", flow: flow.id, sel: n.id }) : href(["repo", repo.id])}>
              <span className="row"><NodeIcon kind={n.kind} color={nodeColor(n)} /><b>{n.label}</b><span className="faint mono" style={{ fontSize: 12 }}>{n.evidence[0]!.file}:{n.evidence[0]!.line}</span></span>
            </a>
          );
        })}
        {findings.map((f) => {
          const flow = f.refs.map((r) => flowsTouching(model, r)[0]).find(Boolean);
          return (
            <a key={f.id} className={`finding ${f.severity}`} href={flow ? href(["repo", repo.id], { tab: "flows", flow: flow.id, sel: f.refs[0] }) : href(["repo", repo.id], { tab: "findings" })}>
              <span className="finding-title">{f.title}</span>
              <span className="faint mono" style={{ fontSize: 12 }}>{f.evidence[0]!.file}:{f.evidence[0]!.line}</span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
