# SPEC-9 — Authoring extensions (declarative assembly + BOM; agent planning-IR; voxel mode)

**Status:** In progress (M4 shipped) · **Date:** 2026-06-22
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M4/§M5/§M10

This spec collects the T1 (browser, no-server) authoring extensions harvested as *ideas* from the
`ref/` corpus (`Expanse.md`). Each section is independent; they share only the "deterministic, pure
TypeScript, no new dependency" posture.

## §assembly — declarative `.assy` description + auto-BOM (M4 · shipped)

**ADR:** [`docs/adr/0004-declarative-assembly-bom.md`](../adr/0004-declarative-assembly-bom.md) ·
**Source idea:** partcad (Apache-2.0; concept only, our own schema)

A small, dependency-free declarative document a human or the AI agent can write to lay out a multi-part
assembly, plus an automatically-derived bill of materials.

**Schema** (`apps/plastiq/src/assembly/assy.ts`):

```jsonc
{
  "name": "bracket-assembly",
  "links": [
    { "part": "plate" },
    { "part": "bolt", "name": "bolt-1", "location": { "position": [10, 0, 0] } },
    { "part": "bracket-sub", "location": { "axis": [0, 0, 1], "angle": 90 } }
  ],
  "subAssemblies": {
    "bracket-sub": { "links": [ { "part": "bolt" }, { "part": "bolt" } ] }
  }
}
```

- `AssyLocation` = `{ position?, axis?, angle? (deg) }` — a rigid placement.
- `AssyLink` = `{ part, location?, name? }` — `part` names a leaf part OR a `subAssemblies` key (recursive).
- **`parseAssy(input)`** validates untrusted/AI-authored JSON into a typed `AssyDoc` (throws with a
  descriptive message).
- **`realizeAssembly(doc)`** flattens it into the interactive `AssemblyModel`
  (`apps/plastiq/src/assembly/model.ts`), composing each sub-assembly placement with its children
  (`worldPos = parentPos + quatRotate(parentQ, childPos)`, `worldQ = parentQ ∘ childQ`); cycle-guarded,
  deterministic instance ids.
- **`deriveBOM(doc)`** rolls up leaf-part occurrence counts (sub-assemblies expanded), sorted by part.
  Rendered by **`BomPanel.tsx`**.
- **`assemblyToAssy(model)`** exports an interactively-built assembly back to a flat `.assy` (round-trips).

`ComponentInstance` gained `part?` (the BOM key; defaults to `name`). **Honest scope:** Plastiq has no
multi-part geometry library yet, so `part` is a name — instances carry it for the BOM/display; binding
a name to distinct geometry is a future multi-part-library milestone (the format + BOM are complete).

**Tests:** `apps/plastiq/src/assembly/assy.test.ts` (parse/realize/nesting/rotation/BOM/round-trip) +
`BomPanel.test.tsx`.

## §planning-ir — agent decomposition-graph planning-IR (M5 · shipped)

**ADR:** [`docs/adr/0005-agent-planning-ir.md`](../adr/0005-agent-planning-ir.md) · **Source idea:**
Graph-CAD (NO license → independent design)

An optional **`plan_part`** tool: a no-side-effect step where the agent commits to a decomposition
graph (schema-validated) *before* `build_part`, cutting long-horizon error on complex multi-part
objects.

- **Planning IR (`apps/plastiq/src/ai/planning.ts`):** `node = { id, part, parent? }` (hierarchy) +
  `relation = { from, to, kind }`, `kind ∈ { aligned, attached, coaxial, offset, pattern, symmetric,
  contains }`. **`validatePlan`** enforces schema + referential integrity (parent/relation endpoints
  exist) + acyclic hierarchy.
- **`plan_part` tool** (`tools/toolDefs.ts`): validates via `validatePlan`, records the plan via the
  injected `onPlan` dep, returns `summarizePlan` (or the error so the model fixes the structure). No
  geometry side effects. Listed first; the prompt (`ai/prompt.ts`) tells the agent to call it first
  **for complex objects only** — a simple part skips it. Bounded by the existing step cap (12).
- **Tests:** `apps/plastiq/src/ai/planning.unit.test.ts` (validation: refs, cycles, dup ids, bad
  kinds) + `tools/toolDefs.unit.test.ts` (def present, dispatch, and a `runAgent` orchestration test:
  plan → build → answer).

## §voxel — ray-pick voxel-editing core (M10 · core shipped; UI mode deferred)

**ADR:** [`docs/adr/0010-voxel-mode.md`](../adr/0010-voxel-mode.md) · **Source idea:** voxel-editor (Apache-2.0; own TS)

The liftable voxel-editor algorithms, built + tested (`apps/plastiq/src/voxel/`):

- **`grid.ts` — `VoxelGrid`:** dense occupancy (typed array) with `addBox`/`eraseBox`; **`visibleCells`**
  (6-neighbour surface cull — `visible() = occupiedNeighbours != 6`); **`toMesh`** (exposed voxel
  faces → triangle mesh); `toIndices` (compact persistence).
- **`pick.ts` — ray-pick:** `rayVoxelHit` (Amanatides–Woo DDA → first occupied cell + entered-face
  normal, so a click adds `cell+normal` or erases `cell`); `rayWorkPlaneCell` (ray ∩ work-plane → cell).
- **`doc.ts` + `VoxelDoc` (store/types.ts):** grid ↔ compact doc, and `voxelDocToMesh` → the existing
  reconstruct (mesh→B-rep) path. Pure TS, deterministic. **14 tests.**

**Honest scope (ADR 0010):** the full three.js voxel rendering + mouse-driven editing UI + mode-shell
wiring is **deferred** — a large UI surface for a low-priority new product direction. `VoxelDoc` is
defined with converters but is **not yet a member of `PersistedDoc`**; it joins the persisted union +
`projectsStore` open/persist switch when the mode is wired. The algorithms (the review's actual finding)
+ the document model + the mesh handoff are concrete now.
