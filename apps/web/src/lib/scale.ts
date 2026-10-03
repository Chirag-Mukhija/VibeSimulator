import type { TraceSpec } from "@vibesim/spec";
import { simulateFlow, type FlowSimResult, type Load, type WhatIf } from "@vibesim/sim";

export interface ScaleRequest {
  id: number;
  spec?: TraceSpec;
  flowId: string;
  load: Load;
  changes: WhatIf;
  baseline: WhatIf;
  /** Multipliers of the current load for the curve. */
  curve: number[];
  axis: "rps" | "users";
}

export interface ScaleResponse {
  id: number;
  base: FlowSimResult;
  changed?: FlowSimResult;
  curve: { x: number; base: number; changed?: number }[];
  error?: string;
}

const same = (a: WhatIf, b: WhatIf) => JSON.stringify(a) === JSON.stringify(b);

/** Today vs. with-changes, plus p95 across load levels. Runs in the worker, or inline as a fallback. */
export function runScale(spec: TraceSpec, req: ScaleRequest): ScaleResponse {
  try {
    const hasChanges = !same(req.changes, req.baseline);
    const base = simulateFlow(spec, req.flowId, req.load, req.baseline, 1);
    const changed = hasChanges ? simulateFlow(spec, req.flowId, req.load, req.changes, 1) : undefined;
    const curve = req.curve.map((m, i) => {
      const load: Load = req.axis === "users"
        ? { ...req.load, users: Math.max(1, Math.round(req.load.users * m)) }
        : { ...req.load, requestsPerSec: Math.max(0.5, req.load.requestsPerSec * m) };
      return {
        x: req.axis === "users" ? load.users : load.requestsPerSec,
        base: simulateFlow(spec, req.flowId, load, req.baseline, 20 + i).p95,
        changed: hasChanges ? simulateFlow(spec, req.flowId, load, req.changes, 20 + i).p95 : undefined,
      };
    });
    return { id: req.id, base, changed, curve };
  } catch (e) {
    return { id: req.id, error: (e as Error).message } as ScaleResponse;
  }
}
