import { useMemo, useState } from "react";
import type { Model } from "../lib/model.ts";
import { SevDot } from "./ui.tsx";

interface Props {
  model: Model;
  activeFlow?: string;
  onOpen(flowId: string): void;
}

export function FlowList({ model, activeFlow, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return model.groups;
    return model.groups
      .map((g) => ({ ...g, flows: g.flows.filter((f) => f.label.toLowerCase().includes(q)) }))
      .filter((g) => g.flows.length);
  }, [model, query]);
  return (
    <>
      <div className="sidebar-head">
        <input className="input" placeholder={`Search ${model.spec.flows.length} flows`} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search flows" />
      </div>
      <nav className="flow-groups" aria-label="Flows">
        {groups.map((g) => (
          <div key={g.id}>
            <div className="group-label" title={g.hint}><span>{g.label}</span><span>{g.flows.length}</span></div>
            {g.flows.map((f) => {
              const m = /^(GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS|HEAD) (.+)$/.exec(f.label);
              return (
                <button key={f.id} className={`flow-item${f.id === activeFlow ? " active" : ""}`} onClick={() => onOpen(f.id)} data-testid="flow-item">
                  <SevDot severity={model.flowSeverity.get(f.id)} />
                  {m ? <><span className={`method ${m[1]}`}>{m[1]}</span><span className="ellipsis">{m[2]}</span></> : <span className="ellipsis">{f.label}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && <div className="empty">No flows match “{query}”.</div>}
      </nav>
    </>
  );
}
