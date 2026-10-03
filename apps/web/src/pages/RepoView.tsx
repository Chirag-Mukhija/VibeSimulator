import { useEffect, useMemo, useState } from "react";
import type { Flow, TraceSpec } from "@vibesim/spec";
import { buildModel, type Model } from "../lib/model.ts";
import { getLocalTrace, loadGalleryIndex, loadGalleryTrace, type GalleryEntry } from "../lib/data.ts";
import { navigate, type Route } from "../lib/router.ts";
import { FlowList } from "../components/FlowList.tsx";
import { FlowStage } from "../components/FlowStage.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { SystemMap } from "../components/SystemMap.tsx";
import { FindingsView } from "../components/FindingsView.tsx";
import { DeepDive } from "../components/DeepDive.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { OverviewView } from "../components/OverviewView.tsx";
import { ScaleView } from "../components/ScaleView.tsx";
import { buildOverview } from "../lib/summary.ts";
import { Icon } from "../components/ui.tsx";
import { setCurrentRepo } from "../lib/session.ts";

type Tab = "overview" | "flows" | "map" | "findings" | "scale";

export function RepoView({ route, id }: { route: Route; id: string }) {
  const [spec, setSpec] = useState<TraceSpec | undefined>(id === "local" ? getLocalTrace() : undefined);
  const [entry, setEntry] = useState<GalleryEntry | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    if (id === "local") {
      if (!getLocalTrace()) setError("No trace is open in this tab. Drop a vibesim.trace.json on the home page.");
      return;
    }
    let cancelled = false;
    loadGalleryTrace(id).then((s) => !cancelled && setSpec(s)).catch((e: Error) => !cancelled && setError(e.message));
    loadGalleryIndex().then((list) => !cancelled && setEntry(list.find((g) => g.id === id)));
    return () => { cancelled = true; };
  }, [id]);
  const model = useMemo(() => (spec ? buildModel(spec) : undefined), [spec]);
  useEffect(() => {
    if (model) setCurrentRepo(id, entry?.title ?? model.spec.meta.repo.name, model);
  }, [model, entry, id]);

  const tab = (route.query.get("tab") as Tab) || "overview";
  const tourStop = route.query.get("tour");
  const flowId = route.query.get("flow") ?? undefined;
  const sel = route.query.get("sel") ?? undefined;
  const [selection, setSelection] = useState<string | undefined>(sel);
  const [conceptId, setConceptId] = useState<string | undefined>();
  const [focusEdge, setFocusEdge] = useState<string | undefined>(sel);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  const set = (q: Record<string, string | undefined>) => {
    navigate(["repo", id], { tab, flow: flowId, ...q }, true);
  };

  // Default to the most interesting flow: one with a high finding, else the first.
  useEffect(() => {
    if (!model || flowId || tab !== "flows") return;
    // Most informative first: the worst finding on the path, then the most hops.
    const rank = { high: 3, medium: 2, low: 1, info: 0 } as const;
    const worst = [...model.spec.flows].sort((a, b) => {
      const sa = rank[model.flowSeverity.get(a.id) ?? "info"];
      const sb = rank[model.flowSeverity.get(b.id) ?? "info"];
      return sb - sa || b.steps.length - a.steps.length;
    })[0];
    const walk = entry?.walkthrough?.find((w) => w.flow && model.flows.has(w.flow))?.flow;
    const pick = walk ?? worst?.id;
    if (pick) set({ flow: pick });
  }, [model, flowId, tab, entry]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <>
        <TopBar />
        <div className="page"><div className="card"><h3>Couldn't open this trace</h3><p className="error-box">{error}</p><a href="#/">Back to home</a></div></div>
      </>
    );
  }
  if (!model) return (<><TopBar /><div className="page faint">Loading trace…</div></>);

  const flow = flowId ? model.flows.get(flowId) : undefined;
  // Scale defaults to the flow you were looking at, else the busiest request.
  const scaleFlowId = flowId ?? defaultScaleFlow(model);
  const select = (ref: string) => {
    setSelection(ref);
    setInspectorOpen(true);
  };
  const showFlow = (fid: string, ref: string) => {
    setFocusEdge(model.edges.has(ref) ? ref : undefined);
    setSelection(ref);
    navigate(["repo", id], { tab: "flows", flow: fid }, false);
  };
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of model.spec.findings) if (f.severity in counts) counts[f.severity as keyof typeof counts]++;

  return (
    <>
      <TopBar
        title={entry?.title ?? model.spec.meta.repo.name}
        subtitle={`${model.spec.meta.stats.routes ?? 0} routes · ${model.spec.flows.length} flows · ${model.spec.meta.stats.filesAnalyzed ?? "?"} files`}
        left={<button className="btn icon ghost mobile-only" onClick={() => setSidebarOpen(!sidebarOpen)} aria-label="Flows"><Icon name="menu" /></button>}
      >
        <div className="tabs" role="tablist" ref={(el) => el?.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" })}>
          {(["overview", "flows", "map", "findings", "scale"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => set({ tab: t })} data-testid={`tab-${t}`}>
              {t === "overview" ? "Overview" : t === "flows" ? "Flows" : t === "map" ? "Map" : t === "scale" ? "Scale" : "Findings"}
              {t === "findings" && model.spec.findings.length > 0 && (
                <span className="row" style={{ gap: 3 }}>
                  {counts.high > 0 && <span className="sev high" />}
                  <span className="faint" style={{ fontSize: 11.5 }}>{model.spec.findings.length}</span>
                </span>
              )}
            </button>
          ))}
        </div>
      </TopBar>
      <div className={`workspace${tab === "findings" || tab === "scale" ? " wide" : ""}${tab === "map" ? " map" : ""}${tab === "overview" ? " solo" : ""}`}>
        <aside className={`sidebar panel${sidebarOpen ? " open" : ""}`} hidden={tab === "map" || tab === "overview"}>
          <FlowList model={model} activeFlow={tab === "flows" || tab === "scale" ? scaleFlowId ?? flowId : undefined} onOpen={(fid) => {
            setSidebarOpen(false);
            setFocusEdge(undefined);
            navigate(["repo", id], { tab: tab === "scale" ? "scale" : "flows", flow: fid }, false);
          }} />
        </aside>
        <main className="stage">
          {tab === "flows" && (flow
            ? <FlowStage key={flow.id} model={model} flow={flow} selected={selection} focusEdge={focusEdge} onSelect={(ref, explicit) => {
              setSelection(ref);
              if (explicit) setInspectorOpen(true);
            }} />
            : <div className="empty">Pick a flow on the left.</div>)}
          {tab === "map" && <SystemMap model={model} selected={selection} onSelect={select} />}
          {tab === "findings" && <FindingsView model={model} onShowFlow={showFlow} onOpenConcept={setConceptId} />}
          {tab === "scale" && scaleFlowId && model.flows.get(scaleFlowId) && <ScaleView model={model} flow={model.flows.get(scaleFlowId)!} />}
          {tab === "overview" && (
            <OverviewView model={model} entry={entry} onOpenConcept={setConceptId} onTab={(t) => set({ tab: t })}
              onOpenFlow={(fid) => {
                const stops = tourFlows(model, entry);
                const i = stops.indexOf(fid);
                setFocusEdge(undefined);
                navigate(["repo", id], { tab: "flows", flow: fid, tour: i >= 0 ? String(i) : undefined }, false);
              }} />
          )}
          {tab === "flows" && tourStop !== null && flow && (
            <TourBar stops={tourFlows(model, entry)} index={Number(tourStop)} labelOf={(fid) => model.flows.get(fid)?.label ?? fid}
              onGo={(i, fid) => navigate(["repo", id], { tab: "flows", flow: fid, tour: String(i) }, false)}
              onExit={() => navigate(["repo", id], { tab: "overview" }, false)} />
          )}
        </main>
        {tab !== "findings" && tab !== "overview" && (
          <aside className={`inspector panel${inspectorOpen ? " open" : ""}`}>
            <div className="row mobile-only" style={{ justifyContent: "flex-end", padding: "8px 8px 0" }}>
              <button className="btn icon ghost" onClick={() => setInspectorOpen(false)} aria-label="Close details"><Icon name="close" /></button>
            </div>
            <Inspector model={model} selection={selection} onOpenConcept={setConceptId} onShowFlow={showFlow} />
          </aside>
        )}
      </div>
      {conceptId && <DeepDive id={conceptId} onClose={() => setConceptId(undefined)} onOpen={setConceptId} />}
    </>
  );
}

/** Flow ids of the guided tour: the curated one for gallery repos, otherwise generated. */
function tourFlows(model: ReturnType<typeof buildModel>, entry?: GalleryEntry): string[] {
  const curated = entry?.walkthrough?.map((w) => w.flow).filter((f): f is string => !!f && model.flows.has(f));
  return curated?.length ? curated : buildOverview(model).tour.map((t) => t.flow);
}

function TourBar({ stops, index, labelOf, onGo, onExit }: { stops: string[]; index: number; labelOf(fid: string): string; onGo(i: number, fid: string): void; onExit(): void }) {
  if (!stops.length || Number.isNaN(index)) return null;
  const next = stops[index + 1];
  const prev = stops[index - 1];
  return (
    <div className="tour-bar" data-testid="tour-bar">
      <span className="chip accent">Tour stop {index + 1} of {stops.length}</span>
      <span className="grow" />
      {prev && <button className="btn small ghost" onClick={() => onGo(index - 1, prev)}>← {labelOf(prev)}</button>}
      {next ? <button className="btn small primary" onClick={() => onGo(index + 1, next)} data-testid="tour-next">Next: {labelOf(next)} →</button>
        : <button className="btn small" onClick={onExit}>Finish the tour</button>}
    </div>
  );
}

/** The request that leans on the backend hardest: most calls to databases, caches, queues and APIs. */
function defaultScaleFlow(model: Model): string | undefined {
  const backend = new Set(["database", "cache", "queue", "topic", "external-api", "compute"]);
  const weight = (f: Flow) => f.steps.filter((s) => backend.has(model.nodes.get(model.edges.get(s.edge)!.to)!.kind)).length;
  const requests = model.spec.flows.filter((f) => model.nodes.get(f.entry)!.kind === "client");
  return [...requests].sort((a, b) => weight(b) - weight(a))[0]?.id ?? model.spec.flows[0]?.id;
}
