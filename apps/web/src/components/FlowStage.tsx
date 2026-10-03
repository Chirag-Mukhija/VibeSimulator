import { useEffect, useMemo, useRef, useState } from "react";
import type { Flow } from "@vibesim/spec";
import type { Model, TimelineItem } from "../lib/model.ts";
import { buildTimeline } from "../lib/model.ts";
import { edgeFlags, edgeSentence, protocolInfo } from "../lib/explain.ts";
import { SequenceDiagram } from "./SequenceDiagram.tsx";
import { Icon, KindChip } from "./ui.tsx";

interface Props {
  model: Model;
  flow: Flow;
  selected?: string;
  /** Edge to jump to when the flow opens (from "show in flow"). */
  focusEdge?: string;
  /** `explicit` is true when the user clicked, false when playback moved on. */
  onSelect(id: string, explicit?: boolean): void;
}

const SPEEDS = [0.5, 1, 2, 4];

function durationOf(item: TimelineItem): number {
  if (item.kind === "return") return 320;
  return item.edge.protocol === "in-process" ? 520 : 950;
}

export function FlowStage({ model, flow, selected, focusEdge, onSelect }: Props) {
  const [collapse, setCollapse] = useState(true);
  const timeline = useMemo(() => buildTimeline(model, flow, { collapseLibraryMiddleware: collapse }), [model, flow, collapse]);
  const [frame, setFrame] = useState({ index: 0, progress: 0 });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const state = useRef(frame);
  const total = timeline.items.length;

  const jump = (index: number, progress = 1) => {
    const i = Math.max(0, Math.min(total - 1, index));
    state.current = { index: i, progress };
    setFrame(state.current);
    const item = timeline.items[i];
    if (item?.kind === "call") onSelect(item.edge.id);
  };

  // A new flow starts from the top (or at the focused edge) and plays once.
  useEffect(() => {
    const at = focusEdge ? timeline.items.findIndex((it) => it.kind === "call" && it.edge.id === focusEdge) : -1;
    if (at >= 0) {
      jump(at);
      setPlaying(false);
    } else {
      state.current = { index: 0, progress: 0 };
      setFrame(state.current);
      setPlaying(true);
    }
  }, [flow.id, collapse]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    let lastIndex = -1;
    const tick = (t: number) => {
      const dt = Math.min(64, t - last);
      last = t;
      const s = state.current;
      const item = timeline.items[s.index];
      if (!item) {
        setPlaying(false);
        return;
      }
      if (s.index !== lastIndex) {
        lastIndex = s.index;
        if (item.kind === "call") onSelect(item.edge.id);
      }
      let progress = s.progress + dt / (durationOf(item) / speed);
      let index = s.index;
      if (progress >= 1) {
        if (index >= total - 1) {
          state.current = { index, progress: 1 };
          setFrame(state.current);
          setPlaying(false);
          return;
        }
        index += 1;
        progress = 0;
      }
      state.current = { index, progress };
      setFrame(state.current);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, timeline, total]); // eslint-disable-line react-hooks/exhaustive-deps

  const entry = model.nodes.get(flow.entry)!;
  const service = model.spec.services.find((s) => s.id === flow.service);
  const network = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of flow.steps) {
      const e = model.edges.get(s.edge)!;
      if (e.protocol === "in-process") continue;
      const label = protocolInfo(e.protocol).label;
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]);
  }, [model, flow]);
  const networkTotal = network.reduce((a, [, n]) => a + n, 0);
  const flowFindings = new Set(flow.steps.flatMap((s) => {
    const e = model.edges.get(s.edge)!;
    return [...(model.findingsByRef.get(e.id) ?? []), ...(model.findingsByRef.get(e.to) ?? [])].map((f) => f.id);
  }));

  const current = timeline.items[frame.index];
  const done = !playing && frame.index >= total - 1 && frame.progress >= 1;

  return (
    <>
      <div className="stage-head">
        <div className="stage-title">
          <h2 data-testid="flow-title">{flow.label}</h2>
          <KindChip node={entry} />
          {service && <span className="chip">{service.label}</span>}
        </div>
        <div className="row wrap muted" style={{ fontSize: 12.5, gap: 14 }}>
          <span><b style={{ color: "var(--text)" }}>{flow.steps.length}</b> hops</span>
          <span>
            <b style={{ color: "var(--text)" }}>{networkTotal}</b> network round trip{networkTotal === 1 ? "" : "s"}
            {network.length > 0 && <span className="faint"> ({network.map(([l, n]) => `${n} ${l}`).join(", ")})</span>}
          </span>
          {flowFindings.size > 0 && <span className="sev-text medium">{flowFindings.size} finding{flowFindings.size === 1 ? "" : "s"} on this path</span>}
        </div>
        <div className="controls">
          <button className="btn small icon" onClick={() => { jump(0, 0); setPlaying(true); }} title="Restart" aria-label="Restart"><Icon name="restart" /></button>
          <button className="btn small icon" onClick={() => { setPlaying(false); jump(frame.index - 1); }} disabled={frame.index === 0} title="Previous hop" aria-label="Previous hop"><Icon name="back" /></button>
          <button className="btn small primary" data-testid="play" onClick={() => {
            if (done) { jump(0, 0); setPlaying(true); } else setPlaying(!playing);
          }} style={{ minWidth: 82 }}>
            <Icon name={playing ? "pause" : "play"} />{playing ? "Pause" : done ? "Replay" : "Play"}
          </button>
          <button className="btn small icon" data-testid="next" onClick={() => { setPlaying(false); jump(frame.index + 1); }} disabled={frame.index >= total - 1} title="Next hop" aria-label="Next hop"><Icon name="step" /></button>
          <span className="progress">{Math.min(frame.index + 1, total)} / {total}</span>
          <span className="sep" />
          <select className="btn small" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
          <label className="toggle" title="Show built-in middleware (helmet, cors, body parsers) as one lifeline">
            <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} />
            Group library middleware
          </label>
        </div>
      </div>
      <SequenceDiagram
        timeline={timeline}
        active={frame.index}
        progress={frame.progress}
        selected={selected}
        findingsByRef={model.findingsByRef}
        onSelectItem={(i) => {
          setPlaying(false);
          jump(i);
          const item = timeline.items[i];
          if (item?.kind === "call") onSelect(item.edge.id, true);
        }}
        onSelectNode={(id) => { setPlaying(false); onSelect(id, true); }}
      />
      <div className="step-caption" data-testid="caption">
        {current ? (
          <>
            <span className="num">{String(frame.index + 1).padStart(2, "0")}</span>
            <div className="grow" style={{ display: "grid", gap: 3 }}>
              <span>{current.kind === "call"
                ? edgeSentence(current.edge, model.nodes.get(current.edge.from)!, model.nodes.get(current.edge.to)!)
                : `${labelOf(model, timeline, current.to)} gets the result back from ${labelOf(model, timeline, current.from)}.`}</span>
              {current.kind === "call" && edgeFlags(current.edge).length > 0 && (
                <span className="faint" style={{ fontSize: 12.5 }}>{edgeFlags(current.edge).map((f) => f.title).join(" · ")}</span>
              )}
            </div>
          </>
        ) : <span className="faint">This flow has no hops.</span>}
      </div>
    </>
  );
}

function labelOf(model: Model, timeline: ReturnType<typeof buildTimeline>, id: string): string {
  return timeline.participants.find((p) => p.id === id)?.node.label ?? model.nodes.get(id)?.label ?? id;
}
