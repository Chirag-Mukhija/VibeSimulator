import { mkdirSync, writeFileSync } from "node:fs";
import { traceSpecJsonSchema } from "../src/json-schema.ts";

const out = new URL("../schema/trace-spec.v1.schema.json", import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, JSON.stringify(traceSpecJsonSchema(), null, 2) + "\n");
console.log(`wrote ${out.pathname}`);
