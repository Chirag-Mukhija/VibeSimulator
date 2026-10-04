import { CATEGORY_LABELS, CONCEPTS, concept, sceneFor, type Category } from "@vibesim/catalog";
import { href } from "../lib/router.ts";
import { TopBar } from "../components/TopBar.tsx";
import { ConceptBody } from "../components/ConceptBody.tsx";

export function LearnIndex() {
  const categories = Object.keys(CATEGORY_LABELS) as Category[];
  return (
    <>
      <TopBar />
      <div className="page">
        <section className="hero" style={{ paddingBottom: 8 }}>
          <span className="eyebrow">Concepts</span>
          <h1>The ideas behind every arrow</h1>
          <p>Every concept opens on an animated scene: change the controls and watch requests, queues and connections react. Pages marked "measured" also have a simulation with memory and CPU numbers measured on a real Node server.</p>
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
                    <b>
                      <span>{c.title}</span>
                      <span className="concept-badges">
                        {sceneFor(c.id) && <span className="eyebrow">scene</span>}
                        {c.full && <span className="eyebrow">measured</span>}
                      </span>
                    </b>
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
        <ConceptBody id={id} />
      </article>
    </>
  );
}
