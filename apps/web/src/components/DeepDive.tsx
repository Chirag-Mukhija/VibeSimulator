import { useEffect } from "react";
import { CATEGORY_LABELS, concept } from "@vibesim/catalog";
import { ConceptBody } from "./ConceptBody.tsx";
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
        <ConceptBody id={c.id} compact onOpen={onOpen} />
        {c.full && <a className="btn" href={href(["learn", c.id])} style={{ justifySelf: "start" }}><Icon name="book" />Open as a full page</a>}
      </aside>
    </>
  );
}
