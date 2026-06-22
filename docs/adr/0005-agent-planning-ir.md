# ADR 0005 — Agent decomposition-graph planning-IR (Graph-CAD idea)

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M5
**Tier:** T1 (agent orchestration, browser) · **Source idea:** Graph-CAD (NO license → idea only; independent design)

## Context

`Expanse.md` found Graph-CAD's one transferable sliver: emit a **hierarchical decomposition graph as a
planning IR *before* generating geometry**, to cut long-horizon error on complex multi-part objects.
Graph-CAD itself is a text→Blender-`bpy` LLM with **no license** — so this is an *independent* design,
not a port of its DSL or code. Plastiq's agent (`apps/plastiq/src/ai/agentRunner.ts`) today goes
straight from prompt → `build_part`; on a complex assembly it can lose track of structure across turns.

## Decision

Add an optional **`plan_part`** tool: a no-side-effect "thinking" step where the agent commits to a
decomposition graph, schema-validated, *before* `build_part`.

- **Planning IR (`apps/plastiq/src/ai/planning.ts`, our own schema):** a flat node list + relation
  edges (a graph), zod-validated.
  - `node` = `{ id, part (description), parent? }` — hierarchy via `parent`.
  - `relation` = `{ from, to, kind }`, `kind ∈ { aligned, attached, coaxial, offset, pattern,
    symmetric, contains }` — the spatial/constraint edges.
  - **`validatePlan(input)`** enforces **referential integrity** (every `parent`/`from`/`to` names an
    existing node) and **acyclic hierarchy** — so the IR is a real, well-formed graph, not free text.
- **`plan_part` tool** (`tools/toolDefs.ts`): validates the plan via `validatePlan`; on success returns
  a short confirmation (and records the plan via an injected `onPlan` dep, so the trace/UX can show it);
  on failure returns the error so the model fixes the structure. No geometry side effects.
- **Optional, not mandatory.** The prompt instructs the agent to call `plan_part` **first for complex /
  multi-part objects**, then `build_part` referencing the node ids — but a simple part (a cube) skips
  it. This keeps simple cases fast while giving complex cases a structured spine. The step cap (12)
  still bounds the loop; `plan_part` is one cheap turn.

## Consequences

- New `apps/plastiq/src/ai/planning.ts` + tests; `plan_part` added to `toolDefs()` / `buildAgentTools`
  (with an optional `onPlan` dep); a prompt addendum; an agentRunner orchestration test (scripted
  provider: plan → build → answer).
- Deterministic (pure validation); no new dependency (zod already present). License-clean (own schema).
- `SPEC-9 §planning-ir` + `Expanse.md` Graph-CAD item updated.
