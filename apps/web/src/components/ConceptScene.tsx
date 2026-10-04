import { useEffect, useMemo, useRef, useState } from "react";
import type { ConceptScene, Frame, SceneBox, SceneParams, SceneRun, Token } from "@vibesim/catalog";
import { NodeIcon } from "./ui.tsx";
import { Icon } from "./ui.tsx";

const BOX_ICON: Record<string, string> = {
  users: "laptop", browser: "ui-event", proxy: "proxy", balancer: "proxy", server: "server", app: "server", database: "database",
  cache: "cache", queue: "queue", channel: "topic", worker: "worker", thread: "compute", dns: "external-api",
};
const BOX_COLOR: Record<string, string> = {
  users: "var(--k-actor)", browser: "var(--k-actor)", proxy: "var(--k-edge)", balancer: "var(--k-edge)", server: "var(--k-code)", app: "var(--k-code)",
  database: "var(--k-database)", cache: "var(--k-cache)", queue: "var(--k-messaging)", channel: "var(--k-messaging)", worker: "var(--k-code)", thread: "var(--k-compute)", dns: "var(--k-external)",
};
const TOKEN_COLOR: Record<Token["kind"], string> = {
  request: "var(--k-entry)", reply: "var(--good)", push: "var(--k-messaging)", empty: "var(--text-faint)", error: "var(--sev-high)", handshake: "var(--k-external)",
};

interface Curve { p0: [number, number]; c1: [number, number]; c2: [number, number]; p3: [number, number] }

function curveBetween(a: SceneBox, b: SceneBox): Curve {
  const ac: [number, number] = [a.x + a.w / 2, a.y + a.h / 2];
  const bc: [number, number] = [b.x + b.w / 2, b.y + b.h / 2];
  if (Math.abs(bc[0] - ac[0]) >= Math.abs(bc[1] - ac[1])) {
    const right = bc[0] > ac[0];
    const p0: [number, number] = [right ? a.x + a.w : a.x, ac[1]];
    const p3: [number, number] = [right ? b.x : b.x + b.w, bc[1]];
    const reach = Math.abs(p3[0] - p0[0]) / 2;
    return { p0, c1: [p0[0] + (right ? reach : -reach), p0[1]], c2: [p3[0] - (right ? reach : -reach), p3[1]], p3 };
  }
  const down = bc[1] > ac[1];
  const p0: [number, number] = [ac[0], down ? a.y + a.h : a.y];
  const p3: [number, number] = [bc[0], down ? b.y : b.y + b.h];
  const reach = Math.abs(p3[1] - p0[1]) / 2;
  return { p0, c1: [p0[0], p0[1] + (down ? reach : -reach)], c2: [p3[0], p3[1] - (down ? reach : -reach)], p3 };
}

function at(c: Curve, t: number): [number, number] {
  const u = 1 - t;
  const f = (i: 0 | 1) => u * u * u * c.p0[i] + 3 * u * u * t * c.c1[i] + 3 * u * t * t * c.c2[i] + t * t * t * c.p3[i];
  return [f(0), f(1)];
}

/** A concept's animated scene: plain controls, boxes and envelopes, counters and a running log. */
export function ConceptSceneView({ scene, compact = false }: { scene: ConceptScene; compact?: boolean }) {
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const [params, setParams] = useState<SceneParams>(scene.defaults);
  const [playing, setPlaying] = useState(!reduced);
  const [speed, setSpeed] = useState(1);
  const [visible, setVisible] = useState(true);
  const [frame, setFrame] = useState<Frame>();
  const run = useRef<SceneRun | undefined>(undefined);
  const holder = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const layout = useMemo(() => scene.layout(params), [scene, params]);
  const boxes = useMemo(() => new Map(layout.boxes.map((b) => [b.id, b])), [layout]);
  const curves = useMemo(() => new Map(layout.links.map((l) => [l.id, curveBetween(boxes.get(l.from)!, boxes.get(l.to)!)])), [layout, boxes]);

  useEffect(() => {
    run.current = scene.start(params, 1);
    setFrame(run.current.tick(0));
  }, [scene, params]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    // Don't animate what nobody can see.
    const io = new IntersectionObserver(([e]) => setVisible(!!e?.isIntersecting));
    io.observe(el);
    return () => {
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!playing || !visible) return;
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(100, t - last);
      last = t;
      if (run.current) setFrame(run.current.tick(dt * speed));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, visible, speed]);

  const scale = width ? Math.min(1, width / scene.width) : 1;
  const set = (patch: SceneParams) => setParams({ ...params, ...patch });

  return (
    <section className={`cscene${compact ? " compact" : ""}`} data-testid="concept-scene">
      <div className="cscene-head">
        <h3>{scene.title}</h3>
        <p className="muted">{scene.intro}</p>
      </div>
      <div className="cscene-controls">
        {scene.controls.map((c) => (
          <label key={c.id} className="cscene-control">
            <span className="faint">{c.label}</span>
            {c.type === "choice" ? (
              <span className="seg small">
                {c.options.map((o) => <button key={o.value} type="button" className={params[c.id] === o.value ? "on" : ""} onClick={() => set({ [c.id]: o.value })}>{o.label}</button>)}
              </span>
            ) : c.type === "toggle" ? (
              <input type="checkbox" checked={params[c.id] === true} onChange={(e) => set({ [c.id]: e.target.checked })} />
            ) : (
              <span className="stepper">
                <button type="button" onClick={() => set({ [c.id]: Math.max(c.min, Number(params[c.id]) - 1) })} disabled={Number(params[c.id]) <= c.min} aria-label={`Fewer ${c.label}`}>−</button>
                <b>{String(params[c.id])}</b>
                <button type="button" onClick={() => set({ [c.id]: Math.min(c.max, Number(params[c.id]) + 1) })} disabled={Number(params[c.id]) >= c.max} aria-label={`More ${c.label}`}>+</button>
              </span>
            )}
          </label>
        ))}
        <span className="grow" />
        <button className="btn small icon" onClick={() => setParams({ ...params })} title="Start over" aria-label="Start over"><Icon name="restart" /></button>
        <button className="btn small" onClick={() => setPlaying(!playing)} data-testid="scene-play"><Icon name={playing ? "pause" : "play"} />{playing ? "Pause" : "Play"}</button>
        <select className="btn small" value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
        </select>
      </div>
      <div className="cscene-stage" ref={holder}>
        <div className="cscene-sizer" style={{ width: scene.width * scale, height: scene.height * scale }}>
          <div className="cscene-canvas" style={{ width: scene.width, height: scene.height, transform: `scale(${scale})` }}>
            <svg width={scene.width} height={scene.height} className="cscene-links" aria-hidden="true">
              {layout.links.map((l) => {
                const c = curves.get(l.id)!;
                return <path key={l.id} d={`M${c.p0} C${c.c1} ${c.c2} ${c.p3}`} fill="none" stroke="var(--border-strong)" strokeWidth={l.persistent ? 3 : 1.6} />;
              })}
              {frame?.tokens.map((t) => {
                const c = curves.get(t.link);
                if (!c) return null;
                const [x, y] = at(c, t.reverse ? 1 - t.t : t.t);
                const color = TOKEN_COLOR[t.kind];
                const hollow = t.kind === "reply" || t.kind === "empty";
                const small = t.kind === "handshake";
                return (
                  <g key={t.id} transform={`translate(${x - (small ? 7 : 10)},${y - (small ? 5 : 7)})`}>
                    <rect width={small ? 14 : 20} height={small ? 10 : 14} rx={2} fill={hollow ? "var(--bg-elev)" : color} stroke={color} strokeWidth={1.8} />
                    {!small && <path d={hollow ? "M4 7.5l4 3.5L16 3.5" : "M1.5 2l8.5 6 8.5-6"} fill="none" stroke={hollow ? color : "var(--bg-elev)"} strokeWidth={1.6} strokeLinecap="round" />}
                  </g>
                );
              })}
            </svg>
            {layout.links.filter((l) => l.label).map((l) => {
              const [x, y] = at(curves.get(l.id)!, 0.5);
              return <span key={l.id} className="link-label" style={{ left: x, top: y }}>{l.label}</span>;
            })}
            {layout.boxes.map((b) => {
              const st = frame?.boxes[b.id] ?? {};
              return (
                <div key={b.id} className={`cbox tone-${st.tone ?? "none"}`} style={{ left: b.x, top: b.y, width: b.w, height: b.h, ["--dev-color" as string]: BOX_COLOR[b.kind] }}>
                  <div className="cbox-head">
                    <NodeIcon kind={BOX_ICON[b.kind] ?? "server"} size={16} color={BOX_COLOR[b.kind]} />
                    <span className="cbox-name"><b className="ellipsis">{b.label}</b>{b.detail && <span className="ellipsis">{b.detail}</span>}</span>
                  </div>
                  {st.slots && (
                    <div className="cbox-slots" title={`${st.slots.busy} of ${st.slots.total} in use`}>
                      {Array.from({ length: st.slots.total }, (_, i) => <span key={i} className={i < st.slots!.busy ? "busy" : ""} />)}
                      {st.slots.label && <em>{st.slots.busy}/{st.slots.total} {st.slots.label}</em>}
                    </div>
                  )}
                  {(st.queue ?? 0) > 0 && (
                    <div className="cbox-queue" title={`${st.queue} waiting`}>
                      {Array.from({ length: Math.min(12, st.queue!) }, (_, i) => <span key={i} />)}
                      {st.queue! > 12 && <em>+{st.queue! - 12}</em>}
                    </div>
                  )}
                  {st.note && <div className="cbox-note ellipsis">{st.note}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {frame && (
        <div className="cscene-counters">
          {frame.counters.map((c) => (
            <div key={c.label} className={`metric ${c.tone ?? ""}`}>
              <span className="metric-value">{c.value}</span>
              <span className="metric-label">{c.label}</span>
            </div>
          ))}
        </div>
      )}
      {frame && frame.log.length > 0 && (
        <ol className="cscene-log" aria-live="polite">
          {frame.log.slice(-3).map((line, i, all) => <li key={`${line}-${i}`} className={i === all.length - 1 ? "latest" : ""}>{line}</li>)}
        </ol>
      )}
      {scene.tryThis.length > 0 && (
        <div className="cscene-try">
          <span className="insp-label">Try this</span>
          {scene.tryThis.map((t) => (
            <button key={t.text} className="try-item" onClick={() => setParams({ ...scene.defaults, ...t.params })}>{t.text}</button>
          ))}
        </div>
      )}
    </section>
  );
}
