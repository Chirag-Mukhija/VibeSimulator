import { useEffect, useMemo, useRef, useState } from "react";
import type { Flow } from "@vibesim/spec";
import { DEFAULT_LOAD, FLOW_ASSUMPTIONS, NO_CHANGES, type FlowSimResult, type Load, type WhatIf } from "@vibesim/sim";
import type { Model } from "../lib/model.ts";
import { runScale, type ScaleRequest, type ScaleResponse } from "../lib/scale.ts";
import { formatMetric } from "./SimLab.tsx";

const CURVE = [0.25, 0.5, 1, 2, 4, 8];

/** What the flow contains decides which knobs and what-ifs make sense. */
function capabilities(model: Model, flow: Flow) {
  const edges = flow.steps.map((s) => model.edges.get(s.edge)!);
  const entry = model.nodes.get(flow.entry)!;
  const to = (e: (typeof edges)[number]) => model.nodes.get(e.to)!;
  return {
    polling: entry.kind === "timer" && entry.props.browser === true,
    intervalMs: typeof entry.props.intervalMs === "number" ? entry.props.intervalMs : 5000,
    reads: edges.some((e) => to(e).kind === "database" && (e.props.statement === "SELECT" || /^(find|select|count)/i.test(String(e.label ?? "")))),
    external: edges.some((e) => to(e).kind === "external-api" && e.protocol !== "in-process" && e.mode === "sync"),
    loops: edges.some((e) => e.props.inLoop && (to(e).kind === "database" || to(e).kind === "cache" || ["service", "handler"].includes(to(e).kind))),
    scans: edges.some((e) => Array.isArray(e.props.missingIndex) || (e.props.aggregate === true && !/\bWHERE\b/i.test(String(e.props.sql ?? "")))),
    pushes: edges.some((e) => e.props.role === "push"),
    database: edges.some((e) => to(e).kind === "database"),
  };
}

export function ScaleView({ model, flow }: { model: Model; flow: Flow }) {
  const caps = useMemo(() => capabilities(model, flow), [model, flow]);
  const [load, setLoad] = useState<Load>({ ...DEFAULT_LOAD, requestsPerSec: 100 });
  const [changes, setChanges] = useState<WhatIf>(NO_CHANGES);
  const [result, setResult] = useState<ScaleResponse | undefined>();
  const [busy, setBusy] = useState(false);
  const worker = useRef<Worker | undefined>(undefined);
  const sentSpec = useRef(false);
  const seq = useRef(0);
  const lastReq = useRef<ScaleRequest | undefined>(undefined);

  const receive = (res: ScaleResponse) => {
    if (res.id !== seq.current) return; // a newer run is on its way
    setResult(res);
    setBusy(false);
  };

  useEffect(() => {
    sentSpec.current = false;
    // Off the main thread so sliders stay smooth; inline if the host refuses workers.
    try {
      const w = new Worker(new URL("../lib/scale.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (e: MessageEvent<ScaleResponse>) => receive(e.data);
      w.onerror = () => {
        worker.current = undefined;
        w.terminate();
        if (lastReq.current) receive(runScale(model.spec, lastReq.current));
      };
      worker.current = w;
      return () => w.terminate();
    } catch {
      worker.current = undefined;
      return undefined;
    }
  }, [model]);

  useEffect(() => {
    setChanges(NO_CHANGES);
    setResult(undefined);
  }, [flow.id]);

  useEffect(() => {
    setBusy(true);
    const t = window.setTimeout(() => {
      const id = ++seq.current;
      const req: ScaleRequest = {
        id, flowId: flow.id, load, changes, baseline: NO_CHANGES, curve: CURVE, axis: caps.polling ? "users" : "rps",
        ...(sentSpec.current ? {} : { spec: model.spec }),
      };
      sentSpec.current = true;
      lastReq.current = req;
      if (worker.current) worker.current.postMessage(req);
      else receive(runScale(model.spec, req));
    }, 220);
    return () => window.clearTimeout(t);
  }, [model, flow.id, load, changes, caps.polling]);

  const hasChanges = JSON.stringify(changes) !== JSON.stringify(NO_CHANGES);
  const set = (patch: Partial<WhatIf>) => setChanges({ ...changes, ...patch });

  return (
    <div className="map-wrap">
      <div className="scale" data-testid="scale">
        <header style={{ display: "grid", gap: 4 }}>
          <h2 style={{ fontSize: 18 }}>Scale: {flow.label}</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Runs this flow's real hops under load: every query, Redis command, API call and hash from the trace. Turn up the traffic until something gives, then try a fix.
          </p>
        </header>

        <div className="scale-grid">
          <section className="card">
            <h3>Traffic</h3>
            {caps.polling ? (
              <Slider id="users" label={`Users with the page open (polling every ${caps.intervalMs / 1000} s)`} min={100} max={200_000} log value={load.users} onChange={(v) => setLoad({ ...load, users: v })} />
            ) : (
              <Slider id="rps" label="Requests per second" min={1} max={20_000} log value={load.requestsPerSec} onChange={(v) => setLoad({ ...load, requestsPerSec: v })} />
            )}
            {caps.scans && <Slider id="rows" label="Rows in the big tables" min={10_000} max={100_000_000} log value={load.tableRows} onChange={(v) => setLoad({ ...load, tableRows: v })} />}
            {caps.loops && <Slider id="items" label="Items the loops go through" min={1} max={200} value={load.loopItems} onChange={(v) => setLoad({ ...load, loopItems: Math.round(v) })} />}
            {caps.pushes && <Slider id="clients" label="Sockets each push goes to" min={10} max={100_000} log value={load.connectedClients} onChange={(v) => setLoad({ ...load, connectedClients: v })} />}
          </section>

          <section className="card" data-testid="what-ifs">
            <h3>What if…</h3>
            <Slider id="instances" label="App instances behind a load balancer" min={1} max={16} value={changes.instances} onChange={(v) => set({ instances: Math.round(v) })} />
            {caps.reads && (
              <Toggle id="cache" label="Cache database reads in Redis" checked={changes.cacheHitRatio > 0} onChange={(on) => set({ cacheHitRatio: on ? 0.9 : 0 })}>
                {changes.cacheHitRatio > 0 && <Slider id="hit" label="Cache hit ratio" min={10} max={99} value={Math.round(changes.cacheHitRatio * 100)} unit="%" onChange={(v) => set({ cacheHitRatio: v / 100 })} />}
              </Toggle>
            )}
            {caps.external && <Toggle id="queue" label="Move third-party calls to a background queue" checked={changes.queueExternal} onChange={(on) => set({ queueExternal: on })} />}
            {caps.polling && (
              <Toggle id="push" label="Push updates (SSE) instead of polling" checked={changes.pushInsteadOfPoll} onChange={(on) => set({ pushInsteadOfPoll: on })}>
                {changes.pushInsteadOfPoll && <Slider id="updates" label="Updates per second" min={0.1} max={100} log value={load.updatesPerSec} onChange={(v) => setLoad({ ...load, updatesPerSec: v })} />}
              </Toggle>
            )}
            {caps.reads && <Toggle id="replica" label="Send reads to a read replica" checked={changes.readReplica} onChange={(on) => set({ readReplica: on })} />}
            {caps.loops && <Toggle id="batch" label="Batch the queries made inside loops" checked={changes.batchLoops} onChange={(on) => set({ batchLoops: on })} />}
          </section>
        </div>

        {!result ? (
          <div className="card faint">Simulating…</div>
        ) : result.error ? (
          <div className="card error-box">{result.error}</div>
        ) : (
          <div style={{ display: "grid", gap: 16, opacity: busy ? 0.6 : 1, transition: "opacity 0.15s" }} data-testid="scale-result">
            <div className={`compare${result.changed ? " two" : ""}`}>
              <Outcome title={result.changed ? "Today" : "Result"} r={result.base} />
              {result.changed && <Outcome title="With your changes" r={result.changed} against={result.base} />}
            </div>
            {[...result.base.notes, ...(result.changed?.notes ?? [])].filter((x, i, a) => a.indexOf(x) === i).map((n) => <p key={n} className="fix" style={{ margin: 0 }}>{n}</p>)}
            {!hasChanges && result.base.bottleneck && result.base.bottleneck.utilization > 0.85 && (
              <p className="muted" style={{ margin: 0 }}>Try one of the what-ifs above to relieve {result.base.bottleneck.label.replace(/ \(.*\)$/, "")}.</p>
            )}
            <section className="card">
              <h3>Slowest 5% of requests as traffic grows</h3>
              <Curve points={result.curve} unit={caps.polling ? "users" : "req/s"} hasChanged={!!result.changed} />
            </section>
            <div className="scale-grid">
              <section className="card">
                <h3>How busy each part is</h3>
                <UseBars r={result.changed ?? result.base} />
              </section>
              <section className="card">
                <h3>Where a request spends its time</h3>
                <p className="faint" style={{ margin: 0, fontSize: 12 }}>Including time spent waiting in line for a free thread, connection or core.</p>
                <TimeBars r={result.changed ?? result.base} />
              </section>
            </div>
            <details className="assumptions">
              <summary>What this simulation assumes</summary>
              <ul>{FLOW_ASSUMPTIONS.map((a) => <li key={a}>{a}</li>)}</ul>
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

function Outcome({ title, r, against }: { title: string; r: FlowSimResult; against?: FlowSimResult }) {
  const better = (a: number, b?: number) => (b === undefined ? undefined : a < b * 0.9 ? "good" : a > b * 1.1 ? "bad" : undefined);
  const b = r.bottleneck;
  return (
    <section className="card outcome" data-testid="outcome">
      <h3>{title}</h3>
      <div className="metrics">
        <Tile label="Median" value={formatMetric({ value: r.p50, format: "ms" })} tone={better(r.p50, against?.p50)} />
        <Tile label="Slowest 5% (p95)" value={formatMetric({ value: r.p95, format: "ms" })} tone={better(r.p95, against?.p95) ?? (r.p95 > 2000 ? "bad" : undefined)} />
        <Tile label="Requests that failed" value={formatMetric({ value: r.failedPct, format: "pct" })} tone={r.failedPct > 1 ? "bad" : "good"} />
        <Tile label="Arriving" value={formatMetric({ value: r.requestsPerSec, format: "rps" })} />
      </div>
      {b && (
        <p style={{ margin: 0, fontSize: 13.5 }}>
          {b.utilization > 0.9 ? <span className="sev-text high">Bottleneck: </span> : <span className="muted">Busiest: </span>}
          <b>{b.label}</b> at {Math.round(b.utilization * 100)}%{b.waitMs > 1 ? `, requests wait ${formatMetric({ value: b.waitMs, format: "ms" })} for it on average` : ""}.
        </p>
      )}
    </section>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span className="metric-value">{value}</span>
      <span className="metric-label">{label}</span>
    </div>
  );
}

function UseBars({ r }: { r: FlowSimResult }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {r.resources.map((x) => (
        <div key={x.id} className="bar-row">
          <span>{x.label}</span>
          <div className="bar"><div style={{ width: `${Math.max(1.5, Math.min(100, x.utilization * 100))}%`, background: x.utilization > 0.9 ? "var(--sev-high)" : x.utilization > 0.7 ? "var(--sev-medium)" : "var(--accent)" }} /></div>
          <span className="mono">{Math.round(x.utilization * 100)}%</span>
        </div>
      ))}
    </div>
  );
}

function TimeBars({ r }: { r: FlowSimResult }) {
  const max = Math.max(...r.timeBy.map((t) => t.ms), 1e-9);
  if (!r.timeBy.length) return <p className="faint" style={{ margin: 0 }}>Nothing measurable.</p>;
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {r.timeBy.map((t) => (
        <div key={t.label} className="bar-row">
          <span>{t.label}</span>
          <div className="bar"><div style={{ width: `${Math.max(1.5, (t.ms / max) * 100)}%` }} /></div>
          <span className="mono">{formatMetric({ value: t.ms, format: "ms" })}</span>
        </div>
      ))}
    </div>
  );
}

function Curve({ points, unit, hasChanged }: { points: ScaleResponse["curve"]; unit: string; hasChanged: boolean }) {
  const W = 640;
  const H = 210;
  const P = { l: 52, r: 16, t: 12, b: 34 };
  const xs = points.map((p) => p.x);
  const ys = points.flatMap((p) => [p.base, p.changed ?? 0]);
  const minX = Math.log(Math.min(...xs));
  const maxX = Math.log(Math.max(...xs));
  const maxY = Math.max(...ys, 10);
  const x = (v: number) => P.l + ((Math.log(v) - minX) / Math.max(1e-9, maxX - minX)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (Math.min(v, maxY) / maxY) * (H - P.t - P.b);
  const path = (pick: (p: ScaleResponse["curve"][number]) => number | undefined) =>
    points.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(pick(p) ?? 0)}`).join(" ");
  const ticksY = [0, maxY / 2, maxY];
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: "block" }} role="img" aria-label="p95 latency as traffic grows">
        {ticksY.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--text-faint)">{t === 0 ? "0" : formatMetric({ value: t, format: "ms" })}</text>
          </g>
        ))}
        {points.map((p) => (
          <text key={p.x} x={x(p.x)} y={H - 14} textAnchor="middle" fontSize="10.5" fill="var(--text-faint)">{p.x >= 1000 ? `${(p.x / 1000).toFixed(p.x >= 10_000 ? 0 : 1)}k` : Math.round(p.x)}</text>
        ))}
        <text x={W - P.r} y={H - 2} textAnchor="end" fontSize="10.5" fill="var(--text-faint)">{unit}</text>
        <path d={path((p) => p.base)} fill="none" stroke="var(--text-faint)" strokeWidth={2} strokeDasharray={hasChanged ? "5 4" : undefined} />
        {hasChanged && <path d={path((p) => p.changed)} fill="none" stroke="var(--accent)" strokeWidth={2.4} />}
        {points.map((p) => <circle key={`b${p.x}`} cx={x(p.x)} cy={y(p.base)} r={3} fill="var(--text-faint)" />)}
        {hasChanged && points.map((p) => <circle key={`c${p.x}`} cx={x(p.x)} cy={y(p.changed ?? 0)} r={3.4} fill="var(--accent)" />)}
      </svg>
      <div className="row wrap faint" style={{ fontSize: 12, gap: 14 }}>
        <span><span className="kind-dot" style={{ background: "var(--text-faint)", marginRight: 5 }} />Today</span>
        {hasChanged && <span><span className="kind-dot" style={{ background: "var(--accent)", marginRight: 5 }} />With your changes</span>}
        <span>Values above {formatMetric({ value: maxY, format: "ms" })} are clipped to the top.</span>
      </div>
    </div>
  );
}

function Slider({ id, label, min, max, value, onChange, log, unit }: { id: string; label: string; min: number; max: number; value: number; onChange(v: number): void; log?: boolean; unit?: string }) {
  const toS = (v: number) => Math.round((log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min)) * 1000);
  const fromS = (s: number) => {
    const f = s / 1000;
    const v = log ? Math.exp(Math.log(min) + f * (Math.log(max) - Math.log(min))) : min + f * (max - min);
    return Number(v.toPrecision(v >= 100 ? 3 : 2));
  };
  return (
    <label className="knob" htmlFor={`scale-${id}`}>
      <span className="knob-label">{label}<b className="mono">{value >= 1000 ? Math.round(value).toLocaleString("en-US") : Number(value.toFixed(1))}{unit ?? ""}</b></span>
      <input id={`scale-${id}`} type="range" min={0} max={1000} value={toS(value)} onChange={(e) => onChange(fromS(Number(e.target.value)))} />
    </label>
  );
}

function Toggle({ id, label, checked, onChange, children }: { id: string; label: string; checked: boolean; onChange(on: boolean): void; children?: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label className="toggle" htmlFor={`whatif-${id}`} style={{ fontSize: 13.5, color: "var(--text)" }}>
        <input id={`whatif-${id}`} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={`whatif-${id}`} />
        {label}
      </label>
      {children}
    </div>
  );
}
