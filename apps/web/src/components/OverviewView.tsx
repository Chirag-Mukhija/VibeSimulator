import { useMemo, useState } from "react";
import { concept } from "@vibesim/catalog";
import type { Model } from "../lib/model.ts";
import type { GalleryEntry } from "../lib/data.ts";
import { buildOverview } from "../lib/summary.ts";
import { FindingCard } from "./Inspector.tsx";
import { Icon } from "./ui.tsx";

export function OverviewView({ model, entry, onOpenFlow, onOpenConcept, onTab }: {
  model: Model;
  entry?: GalleryEntry;
  onOpenFlow(flowId: string): void;
  onOpenConcept(id: string): void;
  onTab(tab: string): void;
}) {
  const o = useMemo(() => buildOverview(model), [model]);
  const [copied, setCopied] = useState(false);
  const tour = entry?.walkthrough?.filter((w) => w.flow && model.flows.has(w.flow)).map((w) => ({ title: w.title, body: w.body, flow: w.flow! })) ?? o.tour;
  const fixFirst = model.spec.findings.filter((f) => f.severity === "high" || f.severity === "medium").slice(0, 3);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(o.talkingPoints.map((t) => `- ${t}`).join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked; the text is still on screen
    }
  };
  return (
    <div className="map-wrap">
      <div className="overview" data-testid="overview">
        <section className="overview-hero">
          <h2>{entry?.title ?? model.spec.meta.repo.name}</h2>
          {entry && <p className="muted">{entry.tagline}</p>}
          <p className="headline">{o.headline}</p>
          {tour[0] && (
            <button className="btn primary" onClick={() => onOpenFlow(tour[0]!.flow)} data-testid="start-tour" style={{ justifySelf: "start" }}>
              <Icon name="play" />Start the guided tour
            </button>
          )}
          {entry && <span className="faint" style={{ fontSize: 12.5 }}>{entry.author}{entry.license ? ` · ${entry.license}` : ""} · <a href={entry.repoUrl} target="_blank" rel="noreferrer">source <Icon name="external" size={12} /></a></span>}
        </section>

        <div className="overview-grid">
          <div className="overview-col">
            <section className="card">
              <h3>What it's made of</h3>
              <ul className="plain">{o.madeOf.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
            <section className="card">
              <h3>How work comes in</h3>
              <ul className="plain">{o.entry.map((t) => <li key={t}>{t}</li>)}</ul>
              <button className="btn small" onClick={() => onTab("map")} style={{ justifySelf: "start" }}>See it on the map</button>
            </section>
            {o.busiest.length > 0 && (
              <section className="card">
                <h3>Busiest paths</h3>
                <ul className="plain">
                  {o.busiest.map((b) => <li key={b.flow.id}><button className="linklike" onClick={() => onOpenFlow(b.flow.id)}>{b.text}</button></li>)}
                </ul>
              </section>
            )}
            {o.patterns.length > 0 && (
              <section className="card">
                <h3>Patterns this code uses</h3>
                <div className="row wrap">
                  {o.patterns.map((p) => <button key={p.concept} className="chip accent" title={p.text} onClick={() => onOpenConcept(p.concept)}>{conceptTitle(p.concept)} →</button>)}
                </div>
              </section>
            )}
          </div>
          <div className="overview-col">
            {tour.length > 0 && (
              <section className="card">
                <h3>Guided tour</h3>
                <ol className="tour">
                  {tour.map((s, i) => (
                    <li key={s.flow + i}>
                      <button className="tour-stop" onClick={() => onOpenFlow(s.flow)} data-testid="tour-stop">
                        <span className="tour-n">{i + 1}</span>
                        <span className="grow"><b>{s.title}</b><span className="muted">{s.body}</span></span>
                      </button>
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {fixFirst.length > 0 && (
              <section className="card">
                <div className="row"><h3 className="grow">Fix first</h3><button className="btn small ghost" onClick={() => onTab("findings")}>All {model.spec.findings.length}</button></div>
                {fixFirst.map((f) => <FindingCard key={f.id} finding={f} onOpenConcept={onOpenConcept} />)}
              </section>
            )}
            <section className="card">
              <div className="row"><h3 className="grow">Talking points</h3><button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>How you could explain this system in an interview, built from what the code actually does.</p>
              <ul className="plain">{o.talkingPoints.map((t) => <li key={t}>{t}</li>)}</ul>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function conceptTitle(id: string) {
  return concept(id)?.title ?? id;
}
