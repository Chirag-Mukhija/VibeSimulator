/** What a Learn-page simulation exposes to the UI. Pure data, no rendering. */

export type Knob =
  | { type: "slider"; id: string; label: string; min: number; max: number; step?: number; log?: boolean; unit?: string }
  | { type: "select"; id: string; label: string; options: { value: string; label: string }[] };

export type Params = Record<string, number | string>;

export interface Metric {
  label: string;
  value: number;
  /** How to print the value. */
  format: "int" | "ms" | "pct" | "mb" | "rps" | "x" | "s" | "count";
  tone?: "good" | "bad" | "neutral";
  hint?: string;
}

export type Chart =
  | { type: "bars"; title: string; unit: string; bars: { label: string; value: number; highlight?: boolean; note?: string }[] }
  | { type: "lines"; title: string; xLabel: string; yLabel: string; series: { label: string; points: [number, number][] }[] }
  | { type: "waterfall"; title: string; rows: { label: string; segments: { label: string; start: number; duration: number; kind: string }[] }[] };

export interface SimResult {
  metrics: Metric[];
  charts: Chart[];
  /** One or two sentences on what happened, shown only when the reader asks. */
  verdict: string;
}

export interface Prediction {
  question: string;
  options: { id: string; label: string }[];
  answer: string;
}

export interface SimDef {
  id: string;
  title: string;
  knobs: Knob[];
  defaults: Params;
  /** Ask before running: the reader commits to a guess, then sees the result. */
  predict?(params: Params, result: SimResult): Prediction;
  run(params: Params, seed?: number): SimResult;
  /** Model card: what the numbers assume. */
  assumptions: string[];
}

export const num = (p: Params, id: string) => Number(p[id]);
export const str = (p: Params, id: string) => String(p[id]);

/** Picks the option bucket closest (on a log scale) to an actual value. */
export function bucket(value: number, options: { id: string; at: number }[]): string {
  let best = options[0]!;
  for (const o of options) {
    if (Math.abs(Math.log((value + 1e-9) / o.at)) < Math.abs(Math.log((value + 1e-9) / best.at))) best = o;
  }
  return best.id;
}
