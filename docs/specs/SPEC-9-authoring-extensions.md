# SPEC-9 — Authoring extensions (declarative assembly + BOM; agent planning-IR; voxel mode)

**Status:** Shipped (M4 + M5 + M10; a multi-part-geometry library remains a future follow-on) ·
**Date:** 2026-06-22 (reconciled 2026-07-04)
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
    { "part": "plate", "fixed": true },
    { "part": "bolt", "name": "bolt-1", "location": { "position": [10, 0, 0] } },
    { "part": "bracket-sub", "location": { "axis": [0, 0, 1], "angle": 90 } }
  ],
  "subAssemblies": {
    "bracket-sub": { "links": [ { "part": "bolt" }, { "part": "bolt" } ] }
  },
  "mates": [
    { "kind": "coincident", "a": { "instance": 0, "point": [0, 0, 0.01] }, "b": { "instance": 1 } },
    { "kind": "distance", "a": { "instance": 1 }, "b": { "instance": 2 }, "value": 0.05 }
  ],
  "joints": [
    { "kind": "revolute", "parent": 0, "child": 1, "origin": [0.01, 0, 0], "axis": [0, 0, 1],
      "limits": { "lower": -1.5, "upper": 1.5 } }
  ]
}
```

- `AssyLocation` = `{ position?, axis?, angle? (deg) }` — a rigid placement.
- `AssyLink` = `{ part, location?, name?, fixed? }` — `part` names a leaf part OR a `subAssemblies`
  key (recursive); `fixed` grounds every instance the link expands to (a fixed sub-assembly link
  anchors its whole sub-tree).
- `AssyMate` = `{ kind, a, b, value? }` and `AssyJoint` = `{ kind, parent, child, origin, axis,
  limits? }` (§2.11.3) — the constraint graph. Instance references are **indexes into the FLATTENED
  instance list** in document (depth-first) order — for a flat document, simply the link index.
  `value` is required for the valued mate kinds (`distance`: metres, `angle`: radians).
- **`parseAssy(input)`** validates untrusted/AI-authored JSON into a typed `AssyDoc` (throws with a
  descriptive message), including **sub-assembly reference-cycle detection** (`assertAcyclic`): a
  cyclic document that could never realize as written fails at parse time, named by its cycle path
  (e.g. `a -> b -> a`), rather than silently degrading to a surprising leaf part. Mates/joints are
  fully validated too (kinds, non-negative integer indexes, `[x,y,z]` shapes, non-zero joint axes,
  numeric limits, valued-mate `value`).
- **`realizeAssembly(doc)`** flattens it into the interactive `AssemblyModel`
  (`apps/plastiq/src/assembly/model.ts`), composing each sub-assembly placement with its children
  (`worldPos = parentPos + quatRotate(parentQ, childPos)`, `worldQ = parentQ ∘ childQ`); cycle-guarded,
  deterministic instance ids. It realizes the document's mates/joints (index → minted id; bounds
  validated here, where the final instance count is known) and applies `fixed` flags — and when NO
  link declares `fixed`, it grounds the FIRST instance (matching `addInstance`'s convention) so an
  imported assembly simulates anchored instead of free-falling (§2.11.3).
- **`deriveBOM(doc)`** rolls up leaf-part occurrence counts (sub-assemblies expanded), sorted by part.
  Rendered by **`BomPanel.tsx`**.
- **`assemblyToAssy(model)`** exports an interactively-built assembly back to a flat `.assy`.
  Round-trip scope is the **whole assembly** (§2.11.3): each instance's `part`/`name`/placement plus
  its `fixed` flag, and the full mate/joint graph with instance ids mapped to link indexes. A
  mate/joint referencing an instance the model does not contain throws (named by mate/joint id)
  rather than silently emitting a broken document. Sub-assembly *structure* is still not recovered —
  a flat link list is emitted.

**Wired into the app (M4.5).** Both directions are reachable in the product, not just in tests:
`actions/registry.ts` exposes `import-assy` / `export-assy` actions. The **read** side is
`importAssyText(name, text)` (parse → realize → `loadAssemblyModel` into the live `AssemblyModel`;
any bad-JSON/schema/cycle error surfaces on the status line and leaves the store untouched) and
`importAssyFromDisk` (a `.assy`/`.json` file picker); the **write** side is `exportAssyFromStore`
(downloads `assemblyToAssy(...)`). `AssemblyTree.tsx` surfaces both as the header **Import .assy**
button (`data-testid="import-assy"`) and the **Export .assy** button (`data-testid="export-assy"`).
Since `import-assy` is a registered runnable `ActionDef` and `importAssyText` is an exported command,
a declarative `.assy` can enter the live assembly either from a human's button click or programmatically
through the shared action surface — no longer a tested island with zero callers.

`ComponentInstance` gained `part?` (the BOM key; defaults to `name`). **Honest scope:** Plastiq has no
multi-part geometry library yet, so `part` is a name — instances carry it for the BOM/display; binding
a name to distinct geometry is a future multi-part-library milestone (the format, BOM, and
import/export round-trip are complete).

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
- **`plan_part` tool** (`tools/toolDefs.ts`): validates via `validatePlan`, records the plan, returns
  `summarizePlan` (or the error so the model fixes the structure). No geometry side effects. Listed
  first; the prompt (`ai/prompt.ts`) tells the agent to call it first **for complex objects only** —
  a simple part skips it. Bounded by the existing step cap (12).
- **The plan is recorded, not write-only.** `buildTurnTools` (`ai/agentTurn.ts`) wires the `onPlan`
  sink into **both** production runners. In the browser it appends a **`kind:"plan"`** entry to the
  per-project conversation trace (`ai/conversation.ts`) carrying the FULL validated `PlanGraph`
  (persisted untruncated, unlike the 200-char tool-call/result summaries), then invokes the optional
  live-UI `onPlan` — which `GenerationPanel.tsx` uses to render the committed plan as a structured,
  untruncated view (`formatPlanGraph`). The headless runner (`headless/nodeBuild.ts`) wires its own
  `onPlan` that captures the plan into the session report (exposed via `plan()` — the twin of the
  browser's trace entry; the headless path keeps no conversation trace). Either way the validated plan
  reaches the user and the record, not just the model's own turn context.
- **Tests:** `apps/plastiq/src/ai/planning.unit.test.ts` (validation: refs, cycles, dup ids, bad
  kinds) + `tools/toolDefs.unit.test.ts` (def present, dispatch, and a `runAgent` orchestration test:
  plan → build → answer).

## §voxel — voxel-sculpt mode (M10 · shipped)

**ADR:** [`docs/adr/0010-voxel-mode.md`](../adr/0010-voxel-mode.md) · **Source idea:** voxel-editor (Apache-2.0; own TS)

The full voxel-sculpt mode, built on the liftable voxel-editor algorithms
(`apps/plastiq/src/voxel/` + `apps/plastiq/src/three/VoxelSculpt.tsx`):

- **`grid.ts` — `VoxelGrid`:** dense occupancy (typed array) with `addBox`/`eraseBox`; **`visibleCells`**
  (6-neighbour surface cull — `visible() = occupiedNeighbours != 6`); **`toMesh`** (exposed voxel
  faces → triangle mesh); `toIndices` (compact persistence).
- **`pick.ts` — ray-pick:** `rayVoxelHit` (Amanatides–Woo DDA → first occupied cell + entered-face
  normal, so a click adds `cell+normal` or erases `cell`); `rayWorkPlaneCell` (ray ∩ work-plane → cell).
- **`doc.ts` + `VoxelDoc` (store/types.ts):** `gridToDoc` / `docToGrid` (grid ↔ compact doc — the
  occupied cells' linear indices), `voxelDocToMesh` → the existing reconstruct (mesh→B-rep) path, and
  `defaultVoxelDoc` (a fresh 32³ grid at 2 mm). Pure TS, deterministic.
- **`voxelStore.ts` — the live sculpt authority:** `useVoxelStore` holds the open `VoxelDoc` (parallel
  to `activeMeshDoc`); `sculptTarget` maps a ray to the cell to add/erase (via `rayVoxelHit` /
  `rayWorkPlaneCell`); undo/redo history lives here (100 stroke-folded snapshots).
- **`glb.ts` — the handoff wrapper:** `voxelMeshToGlb` / `voxelMeshToGlbBase64` pack the surface mesh
  into a minimal spec-valid GLB so Convert-to-CAD can stage it as a `MeshDoc`.
- **`three/VoxelSculpt.tsx` — the editing UI:** renders the grid's exposed-face surface (one geometry,
  one draw call — the same tested mesh the handoff exports) with a work-volume box + hover-cell
  preview; LEFT-click sculpts (add on the hit face's empty neighbour, erase the hit voxel, ⌥/Alt
  inverts, empty-space add lands on the ground plane), drag-to-paint ships for both tools, and orbit
  moves to RIGHT-rotate/MIDDLE-pan in this mode.

**Shipped as a full mode (ADR 0010 amendment · commit `0883c96` · 2026-07-03).** The three.js
rendering, mouse-driven editing, and mode-shell wiring that ADR 0010 originally deferred all shipped:
`VoxelDoc` is now a full member of `PersistedDoc` (`store/types.ts`), and `persistence/projectsStore.ts`
routes `kind:"voxel"` end-to-end — open, save / save-as, debounced autosave, viewport thumbnails, and
crash recovery (a voxel snapshot rides the existing recovery machinery inside a `CadDocument` envelope,
so `persistence/recovery.ts` needed no change). A new `"sculpt"` `Workspace` + `VOXEL_ACTIONS`
(`actions/registry.ts`: New Sculpt / Add / Erase / Convert to CAD / Export GLB / Undo / Redo) gate
every B-rep/parametric action off while a sculpt is open (disabled-not-hidden; `voxelMode()` parallels
`meshMode()`). Convert-to-CAD stages the surface mesh as a `MeshDoc` into `activeMeshDoc`, so the
existing `MeshConvertSection` → reconstruct path runs unmodified. **Tests:** the voxel surface is
covered across the core (`voxel/{grid,pick,doc,glb}.test.ts`), the store (`voxel/voxelStore.test.ts`),
persistence (`persistence/projectsStore.voxel` / `.voxelAutosave` + `persistence/voxelDoc.roundtrip.test.ts`),
the sculpt UI (`three/VoxelSculpt.test.tsx`), and the action registry (`actions/registry.voxel.test.ts`).
