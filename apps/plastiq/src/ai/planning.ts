// M5 — decomposition-graph planning IR for the AI agent (Graph-CAD idea; our own schema, no port).
// A flat node list (hierarchy via `parent`) + relation edges = a graph the agent commits to BEFORE
// build_part, to cut long-horizon error on complex multi-part objects. validatePlan enforces the
// schema, referential integrity, and an acyclic hierarchy so the IR is a real, well-formed graph.
// See docs/adr/0005.

import { z } from "zod";

/** The spatial/constraint relation kinds an edge can carry. */
export const RELATION_KINDS = [
  "aligned",
  "attached",
  "coaxial",
  "offset",
  "pattern",
  "symmetric",
  "contains",
] as const;

const planNodeSchema = z.object({
  id: z.string().min(1),
  /** A short description of the sub-part this node represents. */
  part: z.string().min(1),
  /** The id of the containing node (the decomposition hierarchy). */
  parent: z.string().min(1).optional(),
});

const planRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(RELATION_KINDS),
});

export const planSchema = z.object({
  nodes: z.array(planNodeSchema).min(1),
  relations: z.array(planRelationSchema).default([]),
});

export type PlanNode = z.infer<typeof planNodeSchema>;
export type PlanRelation = z.infer<typeof planRelationSchema>;
export type PlanGraph = z.infer<typeof planSchema>;

export type ValidatePlanResult = { ok: true; plan: PlanGraph } | { ok: false; error: string };

/** Validate untrusted/AI-authored input into a well-formed decomposition graph: schema + referential
 * integrity (every parent/relation endpoint names a real node) + acyclic hierarchy. */
export function validatePlan(input: unknown): ValidatePlanResult {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) {
    const error = parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`).join("; ");
    return { ok: false, error: error || "invalid plan" };
  }
  const plan = parsed.data;

  // unique ids
  const ids = new Set<string>();
  for (const n of plan.nodes) {
    if (ids.has(n.id)) return { ok: false, error: `duplicate node id "${n.id}"` };
    ids.add(n.id);
  }

  // referential integrity
  for (const n of plan.nodes) {
    if (n.parent !== undefined && !ids.has(n.parent)) {
      return { ok: false, error: `node "${n.id}" has an unknown parent "${n.parent}"` };
    }
  }
  for (const r of plan.relations) {
    if (!ids.has(r.from)) return { ok: false, error: `relation references an unknown node "${r.from}"` };
    if (!ids.has(r.to)) return { ok: false, error: `relation references an unknown node "${r.to}"` };
  }

  // acyclic parent hierarchy
  const parentOf = new Map(plan.nodes.map((n) => [n.id, n.parent]));
  for (const start of ids) {
    const seen = new Set<string>();
    let cur: string | undefined = start;
    while (cur !== undefined) {
      if (seen.has(cur)) return { ok: false, error: `cycle in the parent hierarchy at "${cur}"` };
      seen.add(cur);
      cur = parentOf.get(cur);
    }
  }

  return { ok: true, plan };
}

/** A compact one-line summary of a plan graph (for the tool result / trace). */
export function summarizePlan(plan: PlanGraph): string {
  const roots = plan.nodes.filter((n) => !n.parent).map((n) => n.id);
  return `plan accepted: ${plan.nodes.length} node(s), ${plan.relations.length} relation(s); roots: ${roots.join(", ") || "—"}`;
}
