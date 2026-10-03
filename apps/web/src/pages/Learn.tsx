import { CATEGORY_LABELS, CONCEPTS, concept, page, type Category } from "@vibesim/catalog";
import { href } from "../lib/router.ts";
import { currentRepo } from "../lib/session.ts";
import { flowsTouching } from "../lib/model.ts";
import { TopBar } from "../components/TopBar.tsx";
import { SimLab } from "../components/SimLab.tsx";
import { NodeIcon, nodeColor } from "../components/ui.tsx";

export function LearnIndex() {
  const categories = Object.keys(CATEGORY_LABELS) as Category[];
  return (
    <>
      <TopBar />
      <div className="page">
        <section className="hero" style={{ paddingBottom: 8 }}>
          <span className="eyebrow">Concepts</span>
          <h1>The ideas behind every arrow</h1>
          <p>Pages marked "simulation" let you change the inputs and watch where it breaks, with memory and CPU numbers measured on a real Node server.</p>
        </section>
        {categories.map((cat) => {
          const list = CONCEPTS.filter((c) => c.category === cat);
          if (!list.length) return null;
          return (
            <section className="section" key={cat}>
              <div className="section-head"><h2>{CATEGORY_LABELS[cat]}</h2><span className="faint">{list.length}</span></div>
              <div className="concept-list">
                {list.map((c) => (
                  <a key={c.id} className="concept-row" href={href(["learn", c.id])} data-testid="concept-card">
                    <b>{c.title}{c.full && <span className="eyebrow" style={{ color: "var(--accent-text)" }}>simulation</span>}</b>
                    <span className="muted">{c.summary}</span>
                  </a>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

export function LearnPage({ id }: { id: string }) {
  const c = concept(id);
  const p = page(id);
  if (!c) {
    return (<><TopBar /><div className="page"><a href="#/learn">← All concepts</a><h1 style={{ marginTop: 20 }}>Unknown concept</h1></div></>);
  }
  return (
    <>
      <TopBar />
      <article className="page learn" data-testid="learn-page">
        <a href="#/learn">← All concepts</a>
        <header className="hero" style={{ paddingBottom: 4 }}>
          <span className="eyebrow">{CATEGORY_LABELS[c.category]}</span>
          <h1>{c.title}</h1>
          <p>{c.summary}</p>
        </header>
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
            <SimLab sim={p.sim} />
            <section className="learn-section">
              <h2>When it breaks</h2>
              <ul>{p.breaks.map((b) => <li key={b}>{b}</li>)}</ul>
            </section>
          </>
        ) : (
          <p className="faint">A full page with a simulation is not written for this concept yet.</p>
        )}
        <InYourRepo id={id} />
        {c.related.length > 0 && (
          <section className="learn-section">
            <h2>Related</h2>
            <div className="row wrap">
              {c.related.map((r) => concept(r)).filter((r) => r !== undefined).map((r) => (
                <a key={r.id} className="chip" href={href(["learn", r.id])}>{r.title}</a>
              ))}
            </div>
          </section>
        )}
      </article>
    </>
  );
}

/** Where this concept shows up in the repo the reader last opened. */
function InYourRepo({ id }: { id: string }) {
  const repo = currentRepo();
  if (!repo) return null;
  const { model } = repo;
  const nodes = model.spec.nodes.filter((n) => n.concepts.includes(id));
  const findings = model.spec.findings.filter((f) => f.concept === id);
  if (!nodes.length && !findings.length) {
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
        {nodes.slice(0, 8).map((n) => {
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
