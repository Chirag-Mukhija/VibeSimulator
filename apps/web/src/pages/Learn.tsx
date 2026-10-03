import { CATEGORY_LABELS, CONCEPTS, concept, type Category } from "@vibesim/catalog";
import { href } from "../lib/router.ts";
import { TopBar } from "../components/TopBar.tsx";

export function LearnIndex() {
  const categories = Object.keys(CATEGORY_LABELS) as Category[];
  return (
    <>
      <TopBar />
      <div className="page">
        <section className="hero" style={{ paddingBottom: 8 }}>
          <h1 style={{ fontSize: 34 }}>Learn</h1>
          <p>The ideas behind every arrow in a flow. Pages marked with a simulation let you change the inputs and watch where it breaks.</p>
        </section>
        {categories.map((cat) => {
          const list = CONCEPTS.filter((c) => c.category === cat);
          if (!list.length) return null;
          return (
            <section className="section" key={cat}>
              <h2>{CATEGORY_LABELS[cat]}</h2>
              <div className="cards">
                {list.map((c) => (
                  <a key={c.id} className="card" href={href(["learn", c.id])}>
                    <div className="row"><h3 className="grow">{c.title}</h3>{c.full && <span className="chip accent">simulation</span>}</div>
                    <p>{c.summary}</p>
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

export function LearnPlaceholder({ id }: { id: string }) {
  const c = concept(id);
  return (
    <>
      <TopBar />
      <div className="page">
        <a href="#/learn">← All concepts</a>
        <section className="hero">
          <h1 style={{ fontSize: 34 }}>{c?.title ?? "Unknown concept"}</h1>
          <p>{c?.summary}</p>
        </section>
      </div>
    </>
  );
}
