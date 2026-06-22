# ADR 0010 — Voxel-editing mode: ray-pick + occupancy-grid core (voxel-editor idea)

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M10
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

## Honest scope

- **Built + tested:** the grid + cull + ray-pick + voxels→mesh algorithms (the actual Expanse finding),
  and the `VoxelDoc` type. Pure TS, deterministic.
- **Not built (follow-on):** the full three.js voxel rendering + mouse-driven editing UI + mode shell
  wiring. That is a substantial UI surface for a low-priority *new product direction*; the value the
  review identified (the liftable algorithms) is delivered, and the document type + mesh handoff make
  the path concrete. Flagged, not stubbed.

## Consequences

- New `apps/plastiq/src/voxel/{grid,pick}.ts` + tests; a `VoxelDoc` type. `SPEC-9 §voxel` + `Expanse.md`
  voxel item updated. No new dependency; deterministic.
