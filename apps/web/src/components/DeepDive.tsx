import { useEffect } from "react";
import { CATEGORY_LABELS, concept, page } from "@vibesim/catalog";
import { SimLab } from "./SimLab.tsx";
import { href } from "../lib/router.ts";
import { Icon } from "./ui.tsx";

/** Level 2 of the drill-down: the concept behind a node, with a link to its Learn page. */
export function DeepDive({ id, onClose, onOpen }: { id: string; onClose(): void; onOpen(id: string): void }) {
  const c = concept(id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!c) return null;
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={c.title} data-testid="deep-dive">
        <div className="row">
          <span className="chip">{CATEGORY_LABELS[c.category]}</span>
          <span className="grow" />
          <button className="btn icon ghost" onClick={onClose} aria-label="Close"><Icon name="close" /></button>
        </div>
        <h2 style={{ fontSize: 22 }}>{c.title}</h2>
        <p style={{ margin: 0, fontSize: 15, color: "var(--text-dim)" }}>{c.summary}</p>
        {c.full && page(c.id) ? (
          <>
            <SimLab key={c.id} sim={page(c.id)!.sim} compact />
            <a className="btn" href={href(["learn", c.id])} style={{ justifySelf: "start" }}><Icon name="book" />Read the full page</a>
          </>
        ) : (
          <p className="faint" style={{ margin: 0 }}>A full page with a simulation is not written for this concept yet.</p>
        )}
        {c.related.length > 0 && (
          <div className="insp-section">
            <span className="insp-label">Related</span>
            <div className="row wrap">
              {c.related.map((r) => concept(r)).filter((r) => r !== undefined).map((r) => (
                <button key={r.id} className="chip" onClick={() => onOpen(r.id)}>{r.title}</button>
              ))}
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
