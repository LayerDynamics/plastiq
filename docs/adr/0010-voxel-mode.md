# ADR 0010 — Voxel-editing mode: ray-pick + occupancy-grid core (voxel-editor idea)

**Status:** Accepted; full mode SHIPPED 2026-07-03 (see Amendment) · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M10
**Tier:** T1 (browser, deterministic) · **Source idea:** voxel-editor (Apache-2.0; idea, our own TS)

## Context

`Expanse.md` flagged the `voxel-editor` repo as **NET-NEW but paradigm-mismatched** — a dense-voxel
editor is orthogonal to Plastiq's parametric B-rep core — with the genuinely liftable parts being the
**dense occupancy grid + 6-neighbor surface culling + screen-ray → cell pick** techniques (a few
hundred lines, reimplementable in TS). A full voxel *product mode* is a new direction, low priority.

## Decision

Build the **liftable core** (the algorithms) cleanly and tested, plus a `VoxelDoc` document type; scope
the full three.js editing UI honestly as a follow-on.

- **`apps/plastiq/src/voxel/grid.ts` — `VoxelGrid`:** a dense occupancy grid (typed array) with
  `set`/`get`, `addBox`/`eraseBox`, **`visibleCells`** (6-neighbor surface cull — a voxel with all 6
  neighbours occupied is hidden, matching voxel-editor's `visible() = neighbours != 6`), `count`, and
  **`toMesh`** (the exposed faces of occupied voxels → a triangle mesh). Deterministic.
- **`apps/plastiq/src/voxel/pick.ts` — ray-pick:** `rayVoxelHit` (DDA voxel traversal → first occupied
  cell + the hit face normal, so a click can **add** an adjacent voxel or **erase** the hit one) and
  `rayWorkPlaneCell` (ray ∩ a work plane → the grid cell, for placing on an empty plane). Deterministic.
- **`VoxelDoc`** (store type, `kind:"voxel"`) — an opt-in document gated like `MeshDoc` (B-rep ops
  don't apply). Its `toMesh` output → a `MeshDoc` → the existing **reconstruct** (mesh→B-rep) path, so a
  voxel sculpt can become an editable solid.

## Honest scope (as of 2026-06-22 — superseded, see Amendment)

- **Built + tested:** the grid + cull + ray-pick + voxels→mesh algorithms (the actual Expanse finding),
  and the `VoxelDoc` type. Pure TS, deterministic.
- **Deferred at the time (follow-on):** the full three.js voxel rendering + mouse-driven editing UI +
  mode shell wiring — then judged a substantial UI surface for a low-priority *new product direction*.

## Consequences

- New `apps/plastiq/src/voxel/{grid,pick}.ts` + tests; a `VoxelDoc` type. `SPEC-9 §voxel` + `Expanse.md`
  voxel item updated. No new dependency; deterministic.

## Amendment — full voxel-sculpt mode wired (2026-07-03)

**User product decision** (2026-07-03): ship the full editing mode now, superseding this ADR's
deferral. What shipped, all on the liftable core above:

- **Document + persistence:** `VoxelDoc` joined the `PersistedDoc` union (`store/types.ts`).
  `persistence/projectsStore.ts` routes `kind:"voxel"` end-to-end: open (into
  `voxel/voxelStore.ts`, the live-document authority, parallel to `activeMeshDoc`), save/save-as
  (kind-aware `liveDocument()`), debounced autosave, viewport thumbnails, and crash recovery — a
  voxel snapshot rides the existing recovery machinery in a `CadDocument` envelope
  (`{features:[], params:{}, voxel}` — `toRecoveryDoc`/`voxelOfRecoveryDoc`), so
  `persistence/recovery.ts` needed no changes.
- **Mode shell:** a new `"sculpt"` `Workspace` (switcher + ribbon `sculpt` tab set: New Sculpt /
  Add / Erase / Convert to CAD / Export GLB / Undo / Redo), a live SCULPT indicator in the top bar
  and sidebar. Opening a voxel project auto-enters Sculpt; opening any other document leaves it.
  New Sculpt starts a 32³ grid at 2 mm centred on the ground plane (`defaultVoxelDoc`).
- **Editing:** `three/VoxelSculpt.tsx` renders the grid's exposed-face surface mesh (one geometry,
  one draw call — the same tested mesh the handoff exports) with a work-volume box + hover cell
  preview. LEFT-click sculpts via `rayVoxelHit`/`rayWorkPlaneCell` (add on the hit face's empty
  neighbour, erase the hit voxel, ⌥/Alt inverts, empty-space add lands on the ground plane);
  drag-to-paint ships for both tools (add strokes pick against the stroke-start grid so they lay
  one layer; erase strokes re-pick live so they carve); orbit moves to RIGHT-rotate/MIDDLE-pan in
  this mode. Undo/redo history lives in `voxelStore` (100 snapshots, stroke-folded), routed from
  the shared undo/redo actions and ⌘/Ctrl-Z while sculpting.
- **Gating (FR-18):** `actions/registry.ts` `voxelMode()` parallels `meshMode()` — every B-rep/
  parametric action is disabled-not-hidden while a sculpt is open (allowlist discipline); the
  voxel-legal set (tools, surface-mesh GLB export, Convert-to-CAD) stays live.
- **Handoff:** "Convert to CAD" stages the sculpt's surface mesh as a `MeshDoc` (minimal spec-valid
  GLB, `voxel/glb.ts`; `source.mode:"voxel"`) into `activeMeshDoc`, so the EXISTING
  GenerationPanel `MeshConvertSection` → reconstruct (mesh→B-rep) path runs unmodified — exactly
  the `toMesh → MeshDoc → reconstruct` route this ADR designed.
