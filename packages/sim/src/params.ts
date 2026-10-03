import measured from "./params.json" with { type: "json" };

/**
 * Parameters measured on real servers by calibration/run.ts. Everything the
 * simulations claim about memory and CPU for realtime delivery comes from here.
 */
export interface Calibration {
  measuredOn: string;
  node: string;
  measuredAt: string;
  baselineRssMB: number;
  memoryPerConnectionKB: { ws: number; sse: number; longpoll: number };
  cpuPerRequestUs: number;
  cpuBusyBaseFraction: number;
  cpuPerWsMessageUs: number;
  validation: { what: string; unit: string; measured: number; predicted: number; error: number }[];
  pass: boolean;
}

export const CALIBRATION = measured as Calibration;
