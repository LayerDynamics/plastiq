# Plan — Rewrite the Plastiq 3D viewport in react-three-fiber

**Date:** 2026-06-06
**Branch line:** `feat/r3f-viewport` (staged PRs; each keeps `main` green)
**Origin:** user request — "implement the missing gizmos" → escalated to a full
react-three-fiber rewrite of the viewport, with all 8 gizmos built from scratch.

---

## What the viewport IS (the thing being rewritten)

Plastiq's viewport is the **interactive 3D stage of a parametric CAD editor**: it
renders the OCCT-built part (tagged faces/edges/vertices), lets the user **pick**
sub-entities, **transform** the body, **measure**, **section**, **explode** an
assembly, **sketch "normal-to" a datum/face**, and **watch a physics simulation** —
all over a Z-up orbit camera with a clickable view cube. Today every pixel of that
is one imperative class, `apps/plastiq/src/viewport/SceneController.ts` (~940 lines),
which owns the `WebGLRenderer`, camera, `OrbitControls`, `TransformControls`,
`ViewHelper`, lighting, grid, the part mesh, the assembly instance layer, the GPU
color-id pick target, and the per-frame render loop. React (`Viewport.tsx`) is a
thin bridge that news up the controller and pushes Zustand store changes into it
via ~24 imperative setters.

**Goal:** replace that imperative controller with a **declarative r3f `<Canvas>`
scene graph**, re-earning every capability, and build **8 gizmos** as first-class
r3f components in `apps/plastiq/src/three/gizmos/`. End state: `SceneController.ts`
is deleted; the viewport is r3f; gizmos render and interact.

---

## Locked decisions (from planning Q&A)

| # | Decision | Detail |
|---|----------|--------|
| 1 | **Full swap, no dual path** | No runtime feature flag, no long-lived coexistence. The r3f viewport *becomes* the viewport; `SceneController` is deleted once parity lands. |
| 2 | **Rewrite the E2Es to r3f seams** | The ~20 viewport Playwright specs are redesigned around r3f-idiomatic seams (not the legacy `__plastiqScene`/`materialIndex` shapes). Each capability's spec is rewritten as that capability ports. |
| 3 | **Stack: fiber + drei** | Add `@react-three/fiber` and `@react-three/drei` (OrbitControls, Line2, Html, Grid, GizmoHelper). `three@0.184` stays. |
| 4 | **Keep BOTH pick paths** | r3f pointer/raycast events for ergonomic picking AND a ported GPU color-id render-target path (NFR-4) for dense/ambiguous meshes. |
| 5 | **Gizmos visible-first** | Sequence the store-backed, immediately-visible gizmos (origin triad, datum plane, object-center) early so "where are the gizmos" gets answered before the long-tail capabilities. |
| 6 | **Green main every PR** | Even under "full swap", the migration is delivered as staged PRs; no PR merges a broken viewport. |

---

## The migration contract (what r3f must re-provide)

`Viewport.tsx` drives these **SceneController public methods** — every one must have
an r3f equivalent (declarative prop/store-driven, not an imperative setter):

`setMesh` · `setInstances` · `setInstancePickHandler` · `setInstancePoses` ·
`setSimulation` · `setPlacement` · `setSection` · `setSketchView` ·
`findInterferences` · `showGizmo` · `setTransformMode` · `setTransformHandler` ·
`setMeasureHandler` · `setMeasuring` · `setSelectionMode` · `setPicks` ·
`setPickHandler` · `setBoxSelectHandler` · `gpuPickFace` · `captureThumbnail` ·
`standardView` · `setViewDirection` · `fitToView` · `dispose`

**Capabilities behind them:** part-mesh render (tagged faces/edges/vertices) ·
assembly instance layer (InstancedMesh) · raycast + GPU color-id face picking ·
rubber-band box select · selection highlight (material slots) · transform gizmo +
FR-11 placement write-back · view cube / orientation (FR-12) · measure tool (FR-13) ·
section clip plane (B-4) · exploded view · S2 sketch ortho "normal-to" camera +
transparent overlay · simulation drive (M6.1, the `__plastiqSimulate` manual seam) ·
thumbnail capture (M5.3) · HiDPI sizing.

**Test seams today (to be redesigned, decision #2):** `__plastiqScene` (`.builtPart`
with `mesh.geometry.groups[].materialIndex` + `mesh.userData.faceIds`, `.fitToView()`),
`__plastiqGpuPick`, `__plastiqSimulate`, `__plastiqLower`, `#viewport-root canvas`.
New seams will expose the same *facts* (selected entities, built face ids, sim
poses, lowering) through r3f-friendly hooks the rewritten specs assert on.

---

## Stages (each = one or more PRs, main green)

### R0 — Foundation: r3f Canvas at core render parity
- Add `@react-three/fiber` + `@react-three/drei` (pinned).
- New `apps/plastiq/src/three/`: `Viewport3D.tsx` (the `<Canvas>`), `Scene.tsx`
  (camera Z-up, drei `<OrbitControls>`, lighting, grid), `Part.tsx` (renders the
  worker's `TransferMesh`: faces/edges/vertices with the tagged `faceIds`/material
  groups), `useViewportStore` glue.
- Mount `Viewport3D` in `Viewport.tsx` **in place of** SceneController for the
  render path; keep SceneController only for not-yet-ported capabilities during
  the branch (removed at R7). Preserve `#viewport-root canvas` + HiDPI sizing.
- New r3f test seams (`__plastiqScene` shim or a fresh `__plastiqViewport`).
- **Rewrite** `renders-solid`, `viewport-hidpi`, `layout` specs to the new seams.

### R1 — Picking + highlight (both paths, decision #4)
- r3f pointer events for face/edge/vertex/body pick → store `pick`.
- Ported GPU color-id render target + `gpuPickFace` seam (NFR-4).
- Selection highlight via material slots / instanced color.
- Rewrite `pick-face`, `gpu-pick`, `box-select`, `a11y`(pick parts) specs.

### R2 — Transform gizmo (FR-11) + view cube (FR-12)
- `transform.gizmo.tsx` (drei `<PivotControls>`/`<TransformControls>`) → drag
  commits `upsertPlacement`; `showGizmo`/`setTransformMode` become props.
- `viewCube.gizmo.tsx` (drei `<GizmoHelper>`+`<GizmoViewcube>` or custom) →
  `standardView`/`setViewDirection`; `fitToView`.
- Rewrite the placement / view-cube assertions (within existing specs).

### R3 — Visible store-backed gizmos (the "where are the gizmos" answer)
- `origin.gizmo.tsx` — world axis triad at (0,0,0).
- `plane.gizmo.tsx` — the active datum/sketch plane quad + grid (S1–S3 plane spec).
- `objectCenter.gizmo.tsx` — centroid marker from `store.massProps.com` (B-3).
- New focused E2Es: each renders when its store state is present.

### R4 — Sketch "normal-to" camera + overlay (S2 parity) + construction geometry
- Port the ortho `sketchOrthoFrame` camera into r3f (declarative camera swap while
  sketching); transparent overlay coincidence preserved.
- `constructionGeometry.gizmo.tsx` — render sketch construction entities as dashed
  reference lines (drei `<Line>`), from the sketch store.
- Rewrite `sketch-plane-view`, `sketch-on-face`, `sketch-to-solid` specs.

### R5 — Section + offset + section-analysis gizmos (B-4 parity)
- Port section clip plane (`renderer.clippingPlanes` → r3f material clipping).
- `sectionAnalysis.gizmo.tsx` — section-plane handle + cut readout; drag → `setSection`.
- `offset.gizmo.tsx` — draggable offset handle for sketch-plane / section offset.
- Rewrite `section-view` spec.

### R6 — Assembly: instances, explode, interference, simulation
- Instance layer (InstancedMesh) in r3f; explode transform; `findInterferences`.
- Simulation drive: the `__plastiqSimulate` manual-step seam re-exposed; RAF step.
- Rewrite `exploded-view`, `interference`, `simulate`, `simulate-backends`,
  `assembly-to-sim`, `save-reload`, `recovery`, `feature-tree` specs as needed.

### R7 — Delete SceneController; thumbnail; final parity sweep
- Port `captureThumbnail` (M5.3) to r3f (`gl.domElement` readback).
- **Delete `SceneController.ts`** + its now-dead helpers; remove the legacy bridge.
- Full suite green: typecheck · lint · `test:coverage` · build · all E2Es.

---

## The 8 gizmos (final inventory)

| File | Gizmo | Driven by | Action |
|------|-------|-----------|--------|
| `transform.gizmo.tsx` | Move/rotate handles | selection + `gizmoMode` | drag → `upsertPlacement` (FR-11) |
| `viewCube.gizmo.tsx` | Orientation cube | camera | click → `standardView`/`setViewDirection` (FR-12) |
| `plane.gizmo.tsx` | Datum/sketch plane | sketch plane spec (S1–S3) | visual; click datum → start sketch |
| `origin.gizmo.tsx` | World axis triad | static | visual reference |
| `objectCenter.gizmo.tsx` | Centroid marker | `massProps.com` (B-3) | visual |
| `offset.gizmo.tsx` | Offset drag handle | sketch/section offset | drag → offset value |
| `constructionGeometry.gizmo.tsx` | Construction refs | sketch construction entities | visual (dashed) |
| `sectionAnalysis.gizmo.tsx` | Section plane handle | `section` (B-4) | drag → `setSection` axis/t |

---

## Risks & mitigations

- **Scope is large (multi-PR).** Mitigate with the R0–R7 staging; each PR green.
- **"Full swap" vs green-main tension.** SceneController is kept only on the branch
  until R7 for un-ported capabilities; it is never the *mounted* render path after
  R0, and is deleted at R7. No runtime flag (decision #1).
- **Rewriting E2Es loses the unchanged-spec safety net (decision #2).** Mitigate:
  rewrite each capability's spec *in the same PR* that ports it, asserting the same
  user-facing fact (selected entity, built face count, sim pose), so a regression
  still fails a test.
- **Two pick paths to keep in sync (decision #4).** Single source of truth = the
  store `pick`; both raycast and GPU-id resolve to the same `faceId`.
- **r3f + the existing worker/Zustand architecture.** r3f owns only rendering;
  the worker bridge, sketch solve, and stores are untouched.
- **drei version vs three@0.184.** Pin compatible versions; verify on install.

## Definition of done

- `SceneController.ts` deleted; viewport is r3f (`apps/plastiq/src/three/`).
- All 8 gizmos render and interact, driven by the stores.
- Every capability in the migration contract preserved.
- All viewport E2Es (rewritten to r3f seams) green; typecheck · lint ·
  `test:coverage` (thresholds) · build green.
- Commit-per-stage history on `main`.
