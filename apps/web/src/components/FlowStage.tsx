import { useEffect, useMemo, useRef, useState } from "react";
import type { Flow } from "@vibesim/spec";
import type { Model, TimelineItem } from "../lib/model.ts";
import { buildTimeline } from "../lib/model.ts";
import { buildScene, type Scene } from "../lib/scene.ts";
import { eventCaption, eventTitle } from "../lib/describe.ts";
import { edgeFlags, edgeSentence } from "../lib/explain.ts";
import { pathCounts } from "../lib/summary.ts";
import { SequenceDiagram } from "./SequenceDiagram.tsx";
import { EventList, PacketTopology } from "./PacketView.tsx";
import { Icon, KindChip } from "./ui.tsx";

export interface ActiveEvent {
  scene: Scene;
  index: number;
}

interface Props {
  model: Model;
  flow: Flow;
  selected?: string;
  /** Edge to jump to when the flow opens (from "show in flow"). */
  focusEdge?: string;
  /** `explicit` is true when the user clicked, false when playback moved on. */
  onSelect(id: string, explicit?: boolean): void;
  /** The devices view reports the event being shown, for the details panel. */
  onEvent?(event: ActiveEvent | undefined): void;
}

type View = "devices" | "timeline";
type Pace = "slow" | "normal" | "fast";
const PACE: Record<Pace, number> = { slow: 1.6, normal: 1, fast: 0.5 };

function usePref<T extends string>(key: string, initial: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      return saved && allowed.includes(saved) ? saved : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // not persisted; fine
    }
  };
  return [value, set];
}

/** Long enough to read: about 240 ms per word, between 1.8 and 7 seconds. */
function readingMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(7000, Math.max(1800, words * 240));
}

interface Cursor {
  index: number;
  /** travel: the packet is moving; hold: it has arrived and the caption is being read. */
  phase: "travel" | "hold";
  progress: number;
}

/** Plays a list of steps: each one travels, then holds for reading. Next/Back step without playing. */
function usePlayback(count: number, timing: (i: number) => { travel: number; hold: number }, resetKey: string) {
  const [cursor, setCursor] = useState<Cursor>({ index: 0, phase: "travel", progress: 0 });
  const [playing, setPlaying] = useState(false);
  const [stepping, setStepping] = useState(false);
  const ref = useRef(cursor);
  ref.current = cursor;
  const timingRef = useRef(timing);
  timingRef.current = timing;

  useEffect(() => {
    setCursor({ index: 0, phase: "travel", progress: 0 });
    setPlaying(false);
    setStepping(false);
  }, [resetKey]);

  useEffect(() => {
    if (!playing && !stepping) return;
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(64, t - last);
      last = t;
      let { index, phase, progress } = ref.current;
      const { travel, hold } = timingRef.current(index);
      if (phase === "travel") {
        progress += dt / travel;
        if (progress >= 1) {
          phase = "hold";
          progress = 0;
          if (!playing) {
            // A single step: arrive and wait for the reader.
            const next = { index, phase, progress };
            ref.current = next;
            setCursor(next);
            setStepping(false);
            return;
          }
        }
      } else {
        progress += dt / hold;
        if (progress >= 1) {
          if (index >= count - 1) {
            const end = { index, phase: "hold" as const, progress: 1 };
            ref.current = end;
            setCursor(end);
            setPlaying(false);
            return;
          }
          index += 1;
          phase = "travel";
          progress = 0;
        }
      }
      const next = { index, phase, progress };
      ref.current = next;
      setCursor(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, stepping, count]);

  const done = !playing && cursor.index >= count - 1 && cursor.phase === "hold" && cursor.progress >= 1;
  return {
    cursor,
    playing,
    done,
    /** Where the packet is along the current step. */
    travel: cursor.phase === "travel" ? cursor.progress : 1,
    toggle() {
      if (done) {
        setCursor({ index: 0, phase: "travel", progress: 0 });
        setPlaying(true);
      } else setPlaying(!playing);
    },
    next() {
      setPlaying(false);
      if (cursor.phase === "travel") {
        // At the very start, animate this step; mid-travel, finish it.
        if (cursor.progress === 0 && !stepping) setStepping(true);
        else {
          setStepping(false);
          setCursor({ ...cursor, phase: "hold", progress: 0 });
        }
        return;
      }
      if (cursor.index >= count - 1) return;
      setCursor({ index: cursor.index + 1, phase: "travel", progress: 0 });
      setStepping(true);
    },
    back() {
      setPlaying(false);
      setStepping(false);
      setCursor({ index: Math.max(0, cursor.index - (cursor.phase === "hold" ? 1 : 1)), phase: "hold", progress: 0 });
    },
    jump(i: number) {
      setPlaying(false);
      setStepping(false);
      setCursor({ index: Math.max(0, Math.min(count - 1, i)), phase: "hold", progress: 0 });
    },
    restart() {
      setCursor({ index: 0, phase: "travel", progress: 0 });
      setPlaying(true);
    },
  };
}

export function FlowStage({ model, flow, selected, focusEdge, onSelect, onEvent }: Props) {
  const [view, setView] = usePref<View>("vibesim:flow-view", "devices", ["devices", "timeline"]);
  const [pace, setPace] = usePref<Pace>("vibesim:pace", "normal", ["slow", "normal", "fast"]);
  const [group, setGroup] = useState(true);
  const [choices, setChoices] = useState<Record<string, "then" | "else">>({});
  const [showErrors, setShowErrors] = useState(false);
  useEffect(() => {
    setChoices({});
    setShowErrors(false);
  }, [flow.id]);

  const scene = useMemo(() => buildScene(model, flow, { groupLibraryMiddleware: group, choices, showErrors }), [model, flow, group, choices, showErrors]);
  const timeline = useMemo(() => buildTimeline(model, flow, { collapseLibraryMiddleware: group }), [model, flow, group]);

  const entry = model.nodes.get(flow.entry)!;
  const service = model.spec.services.find((s) => s.id === flow.service);
  const counts = useMemo(() => pathCounts(model, flow), [model, flow]);
  const flowFindings = new Set(flow.steps.flatMap((s) => {
    const e = model.edges.get(s.edge)!;
    return [...(model.findingsByRef.get(e.id) ?? []), ...(model.findingsByRef.get(e.to) ?? [])].map((f) => f.id);
  }));

  return (
    <>
      <div className="stage-head">
        <div className="stage-title">
          <h2 data-testid="flow-title">{flow.label}</h2>
          <KindChip node={entry} />
          {service && <span className="chip">{service.label}</span>}
        </div>
        <div className="row wrap muted" style={{ fontSize: 12.5, gap: 14 }}>
          <span><b style={{ color: "var(--text)" }}>{flow.steps.length}</b> hops in the code</span>
          <span>
            main path: <b style={{ color: "var(--text)" }}>{counts.roundTrips}</b> network round trip{counts.roundTrips === 1 ? "" : "s"}
            {counts.messages > 0 && <> and <b style={{ color: "var(--text)" }}>{counts.messages}</b> one-way message{counts.messages === 1 ? "" : "s"}</>}
            {counts.byProtocol.length > 0 && <span className="faint"> ({counts.byProtocol.map(([l, n]) => `${n} ${l}`).join(", ")})</span>}
          </span>
          {flowFindings.size > 0 && <span className="sev-text medium">{flowFindings.size} finding{flowFindings.size === 1 ? "" : "s"} on this path</span>}
        </div>
      </div>
      {view === "devices" ? (
        <DevicesBody key={flow.id} model={model} scene={scene} focusEdge={focusEdge} selected={selected} onSelect={onSelect} onEvent={onEvent}
          pace={pace} controls={{ view, setView, pace, setPace, group, setGroup, choices, setChoices, showErrors, setShowErrors }} />
      ) : (
        <TimelineBody key={flow.id} model={model} timeline={timeline} focusEdge={focusEdge} selected={selected} onSelect={onSelect} onEvent={onEvent}
          pace={pace} controls={{ view, setView, pace, setPace, group, setGroup, choices, setChoices, showErrors, setShowErrors }} scene={scene} />
      )}
    </>
  );
}

interface Controls {
  view: View;
  setView(v: View): void;
  pace: Pace;
  setPace(p: Pace): void;
  group: boolean;
  setGroup(g: boolean): void;
  choices: Record<string, "then" | "else">;
  setChoices(c: Record<string, "then" | "else">): void;
  showErrors: boolean;
  setShowErrors(v: boolean): void;
}

function ControlBar({ playback, total, controls, scene, hint }: { playback: ReturnType<typeof usePlayback>; total: number; controls: Controls; scene: Scene; hint?: string }) {
  const { cursor, playing, done } = playback;
  // Space plays and pauses, arrows step, unless the reader is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(t.tagName) && e.key === " ") return;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      if (e.key === " ") {
        e.preventDefault();
        playback.toggle();
      } else if (e.key === "ArrowRight") playback.next();
      else if (e.key === "ArrowLeft") playback.back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="controls stage-controls">
      <button className="btn small icon" onClick={playback.restart} title="Play from the start" aria-label="Restart"><Icon name="restart" /></button>
      <button className="btn small icon" onClick={playback.back} disabled={cursor.index === 0} title="Previous step (←)" aria-label="Previous step"><Icon name="back" /></button>
      <button className="btn small primary play-btn" data-testid="play" onClick={playback.toggle} title="Play or pause (Space)">
        <Icon name={playing ? "pause" : "play"} />{playing ? "Pause" : done ? "Replay" : "Play"}
        {playing && cursor.phase === "hold" && <span className="hold-bar" style={{ width: `${Math.round(cursor.progress * 100)}%` }} />}
      </button>
      <button className="btn small icon" data-testid="next" onClick={playback.next} disabled={cursor.index >= total - 1 && cursor.phase === "hold"} title="Next step (→)" aria-label="Next step"><Icon name="step" /></button>
      <span className="progress">{Math.min(cursor.index + 1, total)} / {total}</span>
      <span className="sep" />
      <label className="toggle" title="How long each step stays on screen">
        Pace
        <select className="btn small" value={controls.pace} onChange={(e) => controls.setPace(e.target.value as Pace)} aria-label="Playback pace">
          <option value="slow">Slow</option>
          <option value="normal">Normal</option>
          <option value="fast">Fast</option>
        </select>
      </label>
      <div className="seg" role="tablist" aria-label="View">
        <button role="tab" aria-selected={controls.view === "devices"} className={controls.view === "devices" ? "on" : ""} onClick={() => controls.setView("devices")} data-testid="view-devices">Devices</button>
        <button role="tab" aria-selected={controls.view === "timeline"} className={controls.view === "timeline" ? "on" : ""} onClick={() => controls.setView("timeline")} data-testid="view-timeline">Timeline</button>
      </div>
      <BranchMenu scene={scene} controls={controls} />
      <label className="toggle" title="Show built-in middleware (helmet, cors, body parsers) as one row">
        <input type="checkbox" checked={controls.group} onChange={(e) => controls.setGroup(e.target.checked)} />
        Group library middleware
      </label>
      {hint && <span className="faint hide-sm" style={{ fontSize: 12 }}>{hint}</span>}
    </div>
  );
}

/** Which way each condition goes, and whether error handling is shown. */
function BranchMenu({ scene, controls }: { scene: Scene; controls: Controls }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  if (!scene.branches.length && !scene.errorSteps) return null;
  const set = (key: string, way: "then" | "else") => controls.setChoices({ ...controls.choices, [key]: way });
  return (
    <div className="branch-menu" ref={ref}>
      <button className="btn small" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="branches">
        Branches{scene.branches.length ? ` (${scene.branches.length})` : ""}
      </button>
      {open && (
        <div className="branch-pop" role="dialog" aria-label="Branches in this flow">
          <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>
            Code takes one side of each condition. Pick a side to see that path; steps on the other side are left out.
          </p>
          {scene.branches.map((b) => (
            <div key={b.key} className="branch-row">
              <div className="branch-cond"><code>{b.condition}</code><span className="faint"> in {b.owner}</span></div>
              <div className="seg small">
                {b.guard ? (
                  <>
                    <button className={b.chosen === "else" ? "on" : ""} onClick={() => set(b.key, "else")}>continues</button>
                    <button className={b.chosen === "then" ? "on" : ""} onClick={() => set(b.key, "then")}>exits early</button>
                  </>
                ) : (
                  <>
                    <button className={b.chosen === "then" ? "on" : ""} onClick={() => set(b.key, "then")}>true</button>
                    <button className={b.chosen === "else" ? "on" : ""} onClick={() => set(b.key, "else")}>{b.hasElse ? "false" : "false (skipped)"}</button>
                  </>
                )}
              </div>
            </div>
          ))}
          {scene.errorSteps > 0 && (
            <label className="toggle" style={{ marginTop: 4 }}>
              <input type="checkbox" checked={controls.showErrors} onChange={(e) => controls.setShowErrors(e.target.checked)} />
              Include the {scene.errorSteps} step{scene.errorSteps === 1 ? "" : "s"} that only run when something fails
            </label>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ devices

function DevicesBody({ model, scene, focusEdge, selected, onSelect, onEvent, pace, controls }: {
  model: Model; scene: Scene; focusEdge?: string; selected?: string; onSelect: Props["onSelect"]; onEvent?: Props["onEvent"]; pace: Pace; controls: Controls;
}) {
  const total = scene.events.length;
  const playback = usePlayback(total, (i) => {
    const ev = scene.events[i];
    const factor = PACE[pace];
    if (!ev) return { travel: 1000, hold: 2000 };
    const travel = (ev.kind === "local" ? 650 : ev.kind === "reply" || ev.kind === "ack" ? 900 : 1300) * factor;
    return { travel, hold: readingMs(eventCaption(model, scene, ev)) * factor };
  }, `${scene.events.length}:${scene.events.map((e) => e.edge.id).join(",")}`);
  const { cursor } = playback;

  // "Show in flow" from a finding: start at that hop.
  useEffect(() => {
    if (!focusEdge) return;
    const at = scene.events.findIndex((e) => e.edge.id === focusEdge && e.kind !== "reply");
    if (at >= 0) playback.jump(at);
  }, [focusEdge]); // eslint-disable-line react-hooks/exhaustive-deps

  const ev = scene.events[cursor.index];
  useEffect(() => {
    onEvent?.(ev ? { scene, index: cursor.index } : undefined);
    if (ev) onSelect(ev.edge.id);
  }, [cursor.index, scene]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onEvent?.(undefined), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <ControlBar playback={playback} total={total} controls={controls} scene={scene} hint={!playback.playing && cursor.index === 0 && cursor.phase === "travel" ? "Press Play, or step with → / ←" : undefined} />
      {total === 0 ? (
        <div className="empty">This flow has no steps on the chosen branches. Open Branches to pick another path.</div>
      ) : (
        <>
          <PacketTopology model={model} scene={scene} index={cursor.index} progress={playback.travel} selected={selected}
            onSelectNode={(id) => onSelect(id, true)} />
          {ev && (
            <div className="step-caption" data-testid="caption">
              <span className="num">{String(cursor.index + 1).padStart(2, "0")}</span>
              <div className="grow" style={{ display: "grid", gap: 3 }}>
                <span className="caption-title"><b>{eventTitle(model, scene, ev)}</b></span>
                <span>{eventCaption(model, scene, ev)}</span>
              </div>
            </div>
          )}
          <EventList model={model} scene={scene} index={cursor.index} onJump={(i) => {
            playback.jump(i);
            const e = scene.events[i];
            if (e) onSelect(e.edge.id, true);
          }} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ timeline

function TimelineBody({ model, timeline, focusEdge, selected, onSelect, onEvent, pace, controls, scene }: {
  model: Model; timeline: ReturnType<typeof buildTimeline>; focusEdge?: string; selected?: string; onSelect: Props["onSelect"]; onEvent?: Props["onEvent"];
  pace: Pace; controls: Controls; scene: Scene;
}) {
  const total = timeline.items.length;
  const playback = usePlayback(total, (i) => {
    const item = timeline.items[i];
    const factor = PACE[pace];
    if (!item) return { travel: 1000, hold: 2000 };
    return { travel: (item.kind === "return" ? 600 : item.edge.protocol === "in-process" ? 700 : 1200) * factor, hold: readingMs(captionOf(model, timeline, item)) * factor };
  }, `${total}:${timeline.items.map((i) => i.edge.id).join(",")}`);
  const { cursor } = playback;
  useEffect(() => {
    onEvent?.(undefined);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!focusEdge) return;
    const at = timeline.items.findIndex((it) => it.kind === "call" && it.edge.id === focusEdge);
    if (at >= 0) playback.jump(at);
  }, [focusEdge]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = timeline.items[cursor.index];
  useEffect(() => {
    if (current?.kind === "call") onSelect(current.edge.id);
  }, [cursor.index]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <ControlBar playback={playback} total={total} controls={controls} scene={scene} />
      <SequenceDiagram
        timeline={timeline}
        active={cursor.index}
        progress={playback.travel}
        selected={selected}
        findingsByRef={model.findingsByRef}
        onSelectItem={(i) => {
          playback.jump(i);
          const item = timeline.items[i];
          if (item?.kind === "call") onSelect(item.edge.id, true);
        }}
        onSelectNode={(id) => onSelect(id, true)}
      />
      <div className="step-caption" data-testid="caption">
        {current ? (
          <>
            <span className="num">{String(cursor.index + 1).padStart(2, "0")}</span>
            <div className="grow" style={{ display: "grid", gap: 3 }}>
              <span>{captionOf(model, timeline, current)}</span>
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

function captionOf(model: Model, timeline: ReturnType<typeof buildTimeline>, item: TimelineItem): string {
  if (item.kind === "call") return edgeSentence(item.edge, model.nodes.get(item.edge.from)!, model.nodes.get(item.edge.to)!);
  const label = (id: string) => timeline.participants.find((p) => p.id === id)?.node.label ?? model.nodes.get(id)?.label ?? id;
  if (model.nodes.get(item.edge.to)?.kind === "route") return `The handler's response goes back to ${label(item.to)}; the request is complete.`;
  return `${label(item.to)} gets the result back from ${label(item.from)}.`;
}
