import type { Chart } from "@vibesim/catalog";

const fmtNum = (v: number) => (v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(1) : v.toFixed(2));

export function ChartView({ chart }: { chart: Chart }) {
  if (chart.type === "bars") return <Bars chart={chart} />;
  if (chart.type === "lines") return <Lines chart={chart} />;
  return <Waterfall chart={chart} />;
}

function Bars({ chart }: { chart: Extract<Chart, { type: "bars" }> }) {
  const max = Math.max(...chart.bars.map((b) => b.value), 1e-9);
  return (
    <figure className="chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <div style={{ display: "grid", gap: 6 }}>
        {chart.bars.map((b) => (
          <div key={b.label} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 38%) 1fr auto", gap: 10, alignItems: "center", fontSize: 12.5 }}>
            <span className="ellipsis" style={{ color: b.highlight ? "var(--text)" : "var(--text-dim)", fontWeight: b.highlight ? 600 : 400 }} title={b.label}>{b.label}</span>
            <div style={{ height: 14, background: "var(--bg-elev-2)", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ width: `${Math.max(1.5, (b.value / max) * 100)}%`, height: "100%", borderRadius: 4, background: b.note ? "var(--sev-high)" : b.highlight ? "var(--accent)" : "var(--border-strong)", transition: "width 0.35s" }} />
            </div>
            <span className="mono" style={{ fontSize: 11.5, minWidth: 72, textAlign: "right", color: b.note ? "var(--sev-high)" : "var(--text-dim)" }}>
              {fmtNum(b.value)} {chart.unit}{b.note ? ` · ${b.note}` : ""}
            </span>
          </div>
        ))}
      </div>
    </figure>
  );
}

function Lines({ chart }: { chart: Extract<Chart, { type: "lines" }> }) {
  const W = 560;
  const H = 180;
  const P = { l: 44, r: 12, t: 10, b: 28 };
  const pts = chart.series.flatMap((s) => s.points);
  const maxX = Math.max(...pts.map((p) => p[0]), 1);
  const maxY = Math.max(...pts.map((p) => p[1]), 1);
  const x = (v: number) => P.l + (v / maxX) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / maxY) * (H - P.t - P.b);
  const ticks = [0, 0.5, 1].map((f) => Math.round(maxY * f));
  return (
    <figure className="chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, display: "block" }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={P.l} x2={W - P.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
            <text x={P.l - 6} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--text-faint)">{t.toLocaleString("en-US")}</text>
          </g>
        ))}
        {chart.series.map((s) => (
          <path key={s.label} fill="none" stroke="var(--accent)" strokeWidth={2} d={s.points.map((p, i) => `${i ? "L" : "M"}${x(p[0])},${y(p[1])}`).join(" ")} />
        ))}
        <text x={W - P.r} y={H - 6} textAnchor="end" fontSize="10.5" fill="var(--text-faint)">{chart.xLabel}</text>
        <text x={P.l} y={H - 6} fontSize="10.5" fill="var(--text-faint)">0</text>
      </svg>
    </figure>
  );
}

const SEG_COLOR: Record<string, string> = { network: "var(--k-entry)", server: "var(--k-code)" };

function Waterfall({ chart }: { chart: Extract<Chart, { type: "waterfall" }> }) {
  const max = Math.max(...chart.rows.flatMap((r) => r.segments.map((s) => s.start + s.duration)), 1);
  return (
    <figure className="chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <div style={{ display: "grid", gap: 12 }}>
        {chart.rows.map((row) => {
          const total = row.segments.reduce((a, s) => Math.max(a, s.start + s.duration), 0);
          return (
            <div key={row.label} style={{ display: "grid", gap: 4 }}>
              <div className="row" style={{ fontSize: 12.5, justifyContent: "space-between" }}><b>{row.label}</b><span className="mono faint">{fmtNum(total)} ms</span></div>
              <div style={{ position: "relative", height: 22, background: "var(--bg-elev-2)", borderRadius: 4 }}>
                {row.segments.map((s) => (
                  <div key={s.label} title={`${s.label}: ${fmtNum(s.duration)} ms`} style={{
                    position: "absolute", left: `${(s.start / max) * 100}%`, width: `${Math.max(0.6, (s.duration / max) * 100)}%`, top: 3, bottom: 3,
                    background: SEG_COLOR[s.kind] ?? "var(--accent)", borderRadius: 3, opacity: 0.85, borderRight: "1px solid var(--bg)",
                  }} />
                ))}
              </div>
              <div className="row wrap faint" style={{ fontSize: 11.5, gap: 10 }}>
                {row.segments.map((s) => <span key={s.label}><span className="kind-dot" style={{ background: SEG_COLOR[s.kind] ?? "var(--accent)", marginRight: 4 }} />{s.label} {fmtNum(s.duration)} ms</span>)}
              </div>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
