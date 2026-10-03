import { z } from "zod";
import { TraceSpec } from "./schema.ts";

export const JSON_SCHEMA_ID = "urn:vibesimulator:trace-spec:v1";

/**
 * JSON Schema for editors and non-TypeScript tools. Describes the input
 * shape (defaults make fields optional). Cross-reference rules live only in
 * the zod schema, so validateTraceSpec remains the source of truth.
 */
export function traceSpecJsonSchema() {
  return {
    ...z.toJSONSchema(TraceSpec, { io: "input", target: "draft-2020-12" }),
    $id: JSON_SCHEMA_ID,
    title: "vibeSimulator Trace Spec v1",
  };
}
