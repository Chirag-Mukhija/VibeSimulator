import { z } from "zod";

/**
 * Trace Spec v1: the contract between the extractor (producer) and the
 * viewer, findings engine and simulator (consumers).
 *
 * Core rule: nothing appears without proof. Every node and edge cites at
 * least one code location, and states whether a parser verified it, an LLM
 * or a human inferred it, or nobody could resolve it.
 */

export const SCHEMA_VERSION = "1";

export const NODE_KINDS = [
  // Triggers: where a flow starts.
  "client", // any HTTP caller, used when the repo has no frontend code for a route
  "ui-event", // click/submit/page-load handler in frontend code
  "timer", // setInterval, setTimeout loop, cron
  // Infrastructure in front of the code.
  "proxy", // reverse proxy / load balancer (nginx)
  // Server entry points.
  "route", // HTTP route
  "ws-endpoint",
  "sse-endpoint",
  // Code units.
  "middleware",
  "handler",
  "service",
  "worker", // queue consumer / job handler
  // Resources.
  "database",
  "cache", // key-value store (Redis used for keys, sorted sets, sessions)
  "queue",
  "topic", // pub/sub channel
  "external-api",
  "compute", // CPU-heavy library work (bcrypt, image resize) and where it runs
  // Could not be classified; always paired with confidence "unresolved".
  "unknown",
] as const;

/** Deployable units: which process a flow runs in. */
export const SERVICE_KINDS = ["http-server", "worker", "frontend", "proxy", "datastore"] as const;

export const PROTOCOLS = [
  "in-process", // plain function call, no network hop
  "http",
  "ws",
  "sse",
  "grpc",
  "sql",
  "mongodb",
  "redis",
  "amqp",
  "kafka",
  "smtp",
  "unknown",
] as const;

/** How the connection behind an edge lives. */
export const LIFECYCLES = [
  "none", // in-process call, no connection
  "new-per-request", // opened and closed for each use
  "pooled", // borrowed from a pool (DB pool, HTTP keep-alive agent)
  "persistent", // one long-lived connection (WebSocket, Redis subscriber)
  "unknown",
] as const;

/** sync: caller waits for the result. async: fire-and-forget, enqueue, publish, push. */
export const MODES = ["sync", "async"] as const;

export const CONFIDENCES = ["verified", "inferred", "unresolved"] as const;
export const SOURCES = ["parser", "llm", "manual"] as const;
export const SEVERITIES = ["info", "low", "medium", "high"] as const;

/** Stable identifier, conventionally `kind:slug`, e.g. `route:POST:/api/orders`. */
export const Id = z.string().min(1).regex(/^\S+$/, "ids must not contain whitespace");

/** Kebab-case slug, e.g. `long-polling`. Used for concept and rule ids. */
export const Slug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "must be a kebab-case slug");

export const RepoPath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !/^[A-Za-z]:/.test(p) &&
      !p.split("/").includes(".."),
    "must be a repo-relative POSIX path",
  );

export const Evidence = z
  .strictObject({
    file: RepoPath,
    line: z.int().positive(),
    endLine: z.int().positive().optional(),
    snippet: z.string().max(500).optional(),
    /** Surrounding source lines, so a viewer can show the code without the repo. */
    context: z
      .strictObject({
        startLine: z.int().positive(),
        lines: z.array(z.string().max(400)).max(24),
      })
      .optional(),
  })
  .refine((e) => e.endLine === undefined || e.endLine >= e.line, {
    message: "endLine must be >= line",
    path: ["endLine"],
  });

const Props = z.record(z.string(), z.unknown()).default({});

const provenance = {
  evidence: z.array(Evidence).min(1),
  confidence: z.enum(CONFIDENCES),
  source: z.enum(SOURCES).default("parser"),
  concepts: z.array(Slug).default([]),
  props: Props,
};

type Provenance = { confidence: (typeof CONFIDENCES)[number]; source: (typeof SOURCES)[number] };

function checkProvenance(value: Provenance, ctx: z.RefinementCtx) {
  const parserOnly = value.confidence === "verified" || value.confidence === "unresolved";
  if (parserOnly && value.source !== "parser") {
    ctx.addIssue({
      code: "custom",
      message: `confidence "${value.confidence}" requires source "parser"`,
      path: ["source"],
    });
  }
  if (value.confidence === "inferred" && value.source === "parser") {
    ctx.addIssue({
      code: "custom",
      message: 'confidence "inferred" requires source "llm" or "manual"',
      path: ["source"],
    });
  }
}

export const TraceNode = z
  .strictObject({
    id: Id,
    kind: z.enum(NODE_KINDS),
    label: z.string().min(1),
    ...provenance,
  })
  .superRefine((node, ctx) => {
    checkProvenance(node, ctx);
    if (node.kind === "unknown" && node.confidence !== "unresolved") {
      ctx.addIssue({
        code: "custom",
        message: 'kind "unknown" requires confidence "unresolved"',
        path: ["confidence"],
      });
    }
  });

/** Directed in the direction the initiating action travels. */
export const TraceEdge = z
  .strictObject({
    id: Id,
    from: Id,
    to: Id,
    protocol: z.enum(PROTOCOLS),
    lifecycle: z.enum(LIFECYCLES),
    mode: z.enum(MODES),
    label: z.string().min(1).optional(),
    ...provenance,
  })
  .superRefine((edge, ctx) => {
    checkProvenance(edge, ctx);
    if ((edge.protocol === "in-process") !== (edge.lifecycle === "none")) {
      ctx.addIssue({
        code: "custom",
        message: 'protocol "in-process" and lifecycle "none" must go together',
        path: ["lifecycle"],
      });
    }
  });

export const FlowStep = z.strictObject({
  edge: Id,
  note: z.string().min(1).optional(),
});

/** One request path: an entry node plus the edges it traverses, in call order. */
export const Flow = z.strictObject({
  id: Id,
  label: z.string().min(1),
  entry: Id,
  /** Process the entry runs in, when known. */
  service: Id.optional(),
  steps: z.array(FlowStep).min(1),
});

export const Service = z.strictObject({
  id: Id,
  kind: z.enum(SERVICE_KINDS),
  label: z.string().min(1),
  evidence: z.array(Evidence).min(1),
  props: Props,
});

export const Finding = z.strictObject({
  id: Id,
  rule: Slug,
  severity: z.enum(SEVERITIES),
  title: z.string().min(1),
  /** What goes wrong as load grows, in plain language. */
  consequence: z.string().min(1),
  /** What to do about it. Shown only when the reader asks. */
  fix: z.string().min(1).optional(),
  concept: Slug.optional(),
  /** Node or edge ids this finding is about. */
  refs: z.array(Id).default([]),
  evidence: z.array(Evidence).min(1),
  /** Numbers behind the consequence, for the viewer and the simulator. */
  data: z.record(z.string(), z.unknown()).default({}),
});

/** Something the parser could not resolve. The only input the optional LLM tier ever sees. */
export const Gap = z.strictObject({
  id: Id,
  /** The unresolved node and edge ids this gap covers. */
  refs: z.array(Id).min(1),
  reason: z.string().min(1),
  evidence: z.array(Evidence).min(1),
});

export const Meta = z.strictObject({
  generatedAt: z.iso.datetime(),
  generator: z.strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  repo: z.strictObject({
    name: z.string().min(1),
    commit: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/, "must be a git commit hash")
      .optional(),
  }),
  frameworks: z.array(z.string().min(1)).default([]),
  /** Counts for display, e.g. filesAnalyzed. */
  stats: z.record(z.string(), z.number()).default({}),
});

export const TraceSpec = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(SCHEMA_VERSION),
    meta: Meta,
    services: z.array(Service).default([]),
    nodes: z.array(TraceNode),
    edges: z.array(TraceEdge).default([]),
    flows: z.array(Flow).default([]),
    findings: z.array(Finding).default([]),
    gaps: z.array(Gap).default([]),
  })
  .superRefine(checkReferences);

export type Evidence = z.infer<typeof Evidence>;
export type TraceNode = z.infer<typeof TraceNode>;
export type TraceEdge = z.infer<typeof TraceEdge>;
export type FlowStep = z.infer<typeof FlowStep>;
export type Flow = z.infer<typeof Flow>;
export type Finding = z.infer<typeof Finding>;
export type Gap = z.infer<typeof Gap>;
export type Service = z.infer<typeof Service>;
export type Meta = z.infer<typeof Meta>;
export type TraceSpec = z.infer<typeof TraceSpec>;
export type TraceSpecInput = z.input<typeof TraceSpec>;

/** Cross-collection rules zod's per-field checks cannot express. */
function checkReferences(spec: TraceSpec, ctx: z.RefinementCtx) {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", message, path });

  // Ids are unique across every collection, so a ref is never ambiguous.
  const seen = new Set<string>();
  const collections = ["services", "nodes", "edges", "flows", "findings", "gaps"] as const;
  for (const name of collections) {
    spec[name].forEach((item, i) => {
      if (seen.has(item.id)) issue([name, i, "id"], `duplicate id "${item.id}"`);
      seen.add(item.id);
    });
  }

  const nodes = new Map(spec.nodes.map((n) => [n.id, n]));
  const edges = new Map(spec.edges.map((e) => [e.id, e]));
  const elementConfidence = (id: string) => (nodes.get(id) ?? edges.get(id))?.confidence;

  spec.edges.forEach((edge, i) => {
    if (!nodes.has(edge.from)) issue(["edges", i, "from"], `unknown node "${edge.from}"`);
    if (!nodes.has(edge.to)) issue(["edges", i, "to"], `unknown node "${edge.to}"`);
  });

  // A flow is a walk from its entry: each step must leave a node the flow has already reached.
  const services = new Set(spec.services.map((s) => s.id));
  spec.flows.forEach((flow, i) => {
    if (flow.service !== undefined && !services.has(flow.service)) {
      issue(["flows", i, "service"], `unknown service "${flow.service}"`);
    }
    if (!nodes.has(flow.entry)) {
      issue(["flows", i, "entry"], `unknown node "${flow.entry}"`);
      return;
    }
    const reached = new Set([flow.entry]);
    const used = new Set<string>();
    flow.steps.forEach((step, j) => {
      const path = ["flows", i, "steps", j, "edge"];
      const edge = edges.get(step.edge);
      if (!edge) return issue(path, `unknown edge "${step.edge}"`);
      if (used.has(step.edge)) return issue(path, `edge "${step.edge}" appears twice in flow`);
      if (!reached.has(edge.from)) {
        return issue(path, `edge "${step.edge}" starts at "${edge.from}", which the flow has not reached`);
      }
      used.add(step.edge);
      reached.add(edge.to);
    });
  });

  spec.findings.forEach((finding, i) => {
    finding.refs.forEach((ref, j) => {
      if (!elementConfidence(ref)) issue(["findings", i, "refs", j], `unknown node or edge "${ref}"`);
    });
  });

  // Gaps and unresolved elements must match one-to-one in both directions.
  const covered = new Set<string>();
  spec.gaps.forEach((gap, i) => {
    gap.refs.forEach((ref, j) => {
      const confidence = elementConfidence(ref);
      if (!confidence) issue(["gaps", i, "refs", j], `unknown node or edge "${ref}"`);
      else if (confidence !== "unresolved") {
        issue(["gaps", i, "refs", j], `"${ref}" is ${confidence}, gaps may only cover unresolved elements`);
      }
      covered.add(ref);
    });
  });
  for (const name of ["nodes", "edges"] as const) {
    spec[name].forEach((item, i) => {
      if (item.confidence === "unresolved" && !covered.has(item.id)) {
        issue([name, i, "confidence"], `unresolved "${item.id}" is not covered by any gap`);
      }
    });
  }
}
