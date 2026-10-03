import type { z } from "zod";
import { TraceSpec } from "./schema.ts";

export type ValidationResult =
  | { ok: true; spec: TraceSpec }
  | { ok: false; issues: string[] };

/** Parses untrusted input (e.g. a dropped tracer.json) into a TraceSpec. Never throws. */
export function validateTraceSpec(input: unknown): ValidationResult {
  const result = TraceSpec.safeParse(input);
  if (result.success) return { ok: true, spec: result.data };
  return { ok: false, issues: result.error.issues.map(formatIssue) };
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path
    .map((part, i) => (typeof part === "number" ? `[${part}]` : `${i === 0 ? "" : "."}${String(part)}`))
    .join("");
  return path ? `${path}: ${issue.message}` : issue.message;
}
