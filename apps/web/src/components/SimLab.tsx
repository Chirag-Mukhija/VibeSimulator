import { useEffect, useRef, useState } from "react";
import type { Metric, Params, SimDef, SimResult } from "@vibesim/catalog";
import { ChartView } from "./Charts.tsx";

/** Knobs, a prediction, then the simulated result. Explanations stay hidden until asked for. */
export function SimLab({ sim, compact = false }: { sim: SimDef; compact?: boolean }) {
  const [params, setParams] = useState<Params>(sim.defaults);
  const [result, setResult] = useState<SimResult | undefined>();
  const [guess, setGuess] = useState<string | undefined>();
  const [phase, setPhase] = useState<"predict" | "result">("predict");
  const [why, setWhy] = useState(false);
  const [running, setRunning] = useState(true);
  const first = useRef(true);

  // One debounced run per knob change. In the predict phase the result stays
  // hidden; it only decides which answer is right.
  useEffect(() => {
    setRunning(true);
    const t = window.setTimeout(() => {
      setResult(sim.run(params, 1));
      setRunning(false);
    }, first.current ? 0 : 160);
    first.current = false;
    return () => window.clearTimeout(t);
  }, [sim, params]);

  const prediction = result && sim.predict ? sim.predict(params, result) : undefined;

  const choose = (id: string | undefined) => {
    setGuess(id);
    setPhase("result");
    setWhy(false);
  };

  return (
    <section className={`simlab${compact ? " compact" : ""}`} data-testid="simlab">
      <div className="simlab-head">
        <span className="chip accent">Simulation</span>
        <h3>{sim.title}</h3>
      </div>
      <div className="knobs">
        {sim.knobs.map((k) => (
          <label key={k.id} className="knob">
            <span className="knob-label">
              {k.label}
              <b className="mono">{k.type === "slider" ? formatKnob(Number(params[k.id]), k.unit) : k.options.find((o) => o.value === params[k.id])?.label}</b>
            </span>
            {k.type === "slider" ? (
              <input
                type="range"
                min={0}
                max={1000}
                value={toSlider(Number(params[k.id]), k.min, k.max, k.log)}
                onChange={(e) => setParams({ ...params, [k.id]: fromSlider(Number(e.target.value), k.min, k.max, k.log, k.step) })}
                aria-label={k.label}
              />
            ) : (
              <select className="input" value={String(params[k.id])} onChange={(e) => setParams({ ...params, [k.id]: e.target.value })} aria-label={k.label}>
                {k.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
          </label>
        ))}
      </div>

      {phase === "predict" && sim.predict && !prediction ? (
        <div className="predict faint">Setting up the question…</div>
      ) : phase === "predict" && prediction ? (
        <div className="predict" data-testid="predict">
          <span className="insp-label">Predict first</span>
          <p style={{ margin: 0, fontWeight: 500 }}>{prediction.question}</p>
          <div className="row wrap">
            {prediction.options.map((o) => (
              <button key={o.id} className="btn" onClick={() => choose(o.id)} data-testid="predict-option">{o.label}</button>
            ))}
            <button className="btn ghost small" onClick={() => choose(undefined)}>Skip, just run it</button>
          </div>
        </div>
      ) : phase === "predict" ? (
        <button className="btn primary" onClick={() => choose(undefined)} style={{ justifySelf: "start" }}>Run the simulation</button>
      ) : null}

      {phase === "result" && result && (
        <div className="sim-result" style={{ opacity: running ? 0.55 : 1, transition: "opacity 0.15s" }} data-testid="sim-result">
          {guess && prediction && (
            <div className={`verdict-line ${guess === prediction.answer ? "right" : "wrong"}`} data-testid="guess-result">
              {guess === prediction.answer ? "You called it." : "Not quite."} The simulation says: <b>{prediction.options.find((o) => o.id === prediction.answer)?.label}</b>.
              <button className="btn ghost small" onClick={() => setPhase("predict")}>Predict again</button>
            </div>
          )}
          <div className="metrics">
            {result.metrics.map((m) => <MetricTile key={m.label} m={m} />)}
          </div>
          <div className="charts">
            {result.charts.slice(0, compact ? 1 : undefined).map((c) => <ChartView key={c.title} chart={c} />)}
          </div>
          <div className="row wrap">
            <button className="btn small" onClick={() => setWhy(!why)} data-testid="why">{why ? "Hide the explanation" : "What happened?"}</button>
          </div>
          {why && <p className="fix" style={{ margin: 0 }}>{result.verdict}</p>}
          {!compact && (
            <details className="assumptions">
              <summary>What this simulation assumes</summary>
              <ul>{sim.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

function MetricTile({ m }: { m: Metric }) {
  return (
    <div className={`metric ${m.tone ?? ""}`} title={m.hint}>
      <span className="metric-value">{formatMetric(m)}</span>
      <span className="metric-label">{m.label}</span>
      {m.hint && <span className="metric-hint">{m.hint}</span>}
    </div>
  );
}

export function formatMetric(m: Pick<Metric, "value" | "format">): string {
  const v = m.value;
  switch (m.format) {
    case "ms":
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)} s` : v >= 10 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
    case "s":
      return `${v.toFixed(1)} s`;
    case "pct":
      return v >= 10 || v === 0 ? `${Math.round(v)}%` : `${v.toFixed(1)}%`;
    case "mb":
      return v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : v >= 10 || v === 0 ? `${Math.round(v)} MB` : `${v.toFixed(1)} MB`;
    case "rps":
      return v >= 10 ? `${Math.round(v).toLocaleString("en-US")}/s` : `${v.toFixed(1)}/s`;
    case "x":
      return `${v.toFixed(1)}×`;
    default:
      return Math.round(v).toLocaleString("en-US");
  }
}

function toSlider(v: number, min: number, max: number, log?: boolean): number {
  const f = log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min);
  return Math.round(Math.min(1, Math.max(0, f)) * 1000);
}

function fromSlider(s: number, min: number, max: number, log?: boolean, step?: number): number {
  const f = s / 1000;
  let v = log ? Math.exp(Math.log(min) + f * (Math.log(max) - Math.log(min))) : min + f * (max - min);
  if (step) v = Math.round(v / step) * step;
  else v = Number(v.toPrecision(v >= 100 ? 3 : 2));
  return Math.min(max, Math.max(min, v));
}

function formatKnob(v: number, unit?: string): string {
  const s = v >= 1000 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
  return unit ? `${s} ${unit}` : s;
}
