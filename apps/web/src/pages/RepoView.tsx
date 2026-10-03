import { useEffect, useMemo, useState } from "react";
import type { TraceSpec } from "@vibesim/spec";
import { buildModel } from "../lib/model.ts";
import { getLocalTrace, loadGalleryIndex, loadGalleryTrace, type GalleryEntry } from "../lib/data.ts";
import { navigate, type Route } from "../lib/router.ts";
import { FlowList } from "../components/FlowList.tsx";
import { FlowStage } from "../components/FlowStage.tsx";
import { Inspector } from "../components/Inspector.tsx";
import { SystemMap } from "../components/SystemMap.tsx";
import { FindingsView } from "../components/FindingsView.tsx";
import { DeepDive } from "../components/DeepDive.tsx";
import { TopBar } from "../components/TopBar.tsx";
import { Icon } from "../components/ui.tsx";

type Tab = "flows" | "map" | "findings";

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

  const tab = (route.query.get("tab") as Tab) || "flows";
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
        <div className="tabs" role="tablist">
          {(["flows", "map", "findings"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => set({ tab: t })} data-testid={`tab-${t}`}>
              {t === "flows" ? "Flows" : t === "map" ? "Map" : "Findings"}
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
      <div className={`workspace${tab === "findings" ? " wide" : ""}${tab === "map" ? " map" : ""}`}>
        <aside className={`sidebar panel${sidebarOpen ? " open" : ""}`} hidden={tab === "map"}>
          <FlowList model={model} activeFlow={tab === "flows" ? flowId : undefined} onOpen={(fid) => {
            setSidebarOpen(false);
            setFocusEdge(undefined);
            navigate(["repo", id], { tab: "flows", flow: fid }, false);
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
          {entry?.walkthrough && tab === "flows" && <Walkthrough entry={entry} onOpen={(fid) => navigate(["repo", id], { tab: "flows", flow: fid }, false)} />}
        </main>
        {tab !== "findings" && (
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

function Walkthrough({ entry, onOpen }: { entry: GalleryEntry; onOpen(flowId: string): void }) {
  const [open, setOpen] = useState(false);
  const items = entry.walkthrough ?? [];
  if (!items.length) return null;
  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg-elev)", padding: "8px 18px" }}>
      <button className="btn small ghost" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} the guided tour ({items.length} stops)</button>
      {open && (
        <ol style={{ margin: "6px 0 4px", paddingLeft: 22, display: "grid", gap: 8, fontSize: 13 }}>
          {items.map((w, i) => (
            <li key={i}>
              <b>{w.title}</b> <span className="muted">{w.body}</span>{" "}
              {w.flow && <button className="chip" onClick={() => onOpen(w.flow!)}>Open</button>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
