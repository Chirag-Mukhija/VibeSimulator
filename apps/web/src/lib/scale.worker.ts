/// <reference lib="webworker" />
import type { TraceSpec } from "@vibesim/spec";
import { runScale, type ScaleRequest } from "./scale.ts";

let spec: TraceSpec | undefined;

self.onmessage = (event: MessageEvent<ScaleRequest>) => {
  if (event.data.spec) spec = event.data.spec;
  if (spec) self.postMessage(runScale(spec, event.data));
};
