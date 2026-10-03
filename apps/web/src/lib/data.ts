import { validateTraceSpec, type TraceSpec } from "@vibesim/spec";

export interface GalleryEntry {
  id: string;
  title: string;
  tagline: string;
  repoUrl: string;
  author: string;
  license?: string;
  stack: string[];
  /** Short notes shown on the repo page: where to start, what to look for. */
  walkthrough?: { title: string; body: string; flow?: string }[];
  stats: { routes: number; flows: number; findings: number; high: number };
}

const LOCAL_KEY = "vibesim:local-trace";
let localTrace: TraceSpec | undefined;

export async function loadGalleryIndex(): Promise<GalleryEntry[]> {
  const res = await fetch("gallery/index.json");
  if (!res.ok) return [];
  return (await res.json()) as GalleryEntry[];
}

export async function loadGalleryTrace(id: string): Promise<TraceSpec> {
  const res = await fetch(`gallery/${encodeURIComponent(id)}.trace.json`);
  if (!res.ok) throw new Error(`Could not load the "${id}" trace (${res.status}).`);
  return parse(await res.json());
}

/** Validates an untrusted trace (a dropped file). Throws with readable issues. */
export function parse(json: unknown): TraceSpec {
  const result = validateTraceSpec(json);
  if (!result.ok) {
    throw new Error(`This file is not a valid vibeSimulator trace:\n${result.issues.slice(0, 6).join("\n")}`);
  }
  return result.spec;
}

export async function readTraceFile(file: File): Promise<TraceSpec> {
  if (file.size > 60_000_000) throw new Error("That file is over 60 MB, which is larger than any trace should be.");
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    throw new Error("That file is not JSON. Run `vibesim analyze <repo>` and open the vibesim.trace.json it writes.");
  }
  const spec = parse(json);
  setLocalTrace(spec);
  return spec;
}

export function setLocalTrace(spec: TraceSpec) {
  localTrace = spec;
  try {
    sessionStorage.setItem(LOCAL_KEY, JSON.stringify(spec));
  } catch {
    // Too large or storage blocked: the trace stays in memory for this tab.
  }
}

export function getLocalTrace(): TraceSpec | undefined {
  if (localTrace) return localTrace;
  try {
    const raw = sessionStorage.getItem(LOCAL_KEY);
    if (raw) localTrace = parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
  return localTrace;
}
