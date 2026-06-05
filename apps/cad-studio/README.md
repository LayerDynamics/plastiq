# @mechx/cad-studio

**MechX CAD Studio** (SPEC-5) — an interactive, parametric, Onshape-class CAD
editor that runs entirely in the browser, built on the
[`@mechx/cad`](../../packages/cad) kernel (`opencascade.js`). Sketch a profile,
build a feature history, select faces/edges/vertices, dress up with
fillets/chamfers/shells, assemble instances with mates and joints, save to a
local project store, and **simulate the result in the real `mechx_sim`** — all
client-side, no server.

This is the authoring **front-end**; the geometry/solver/lowering engine is
`@mechx/cad` (SPEC-4). It is a **separate app** from the Babylon sim-viewer
client (ADR-0002): CAD Studio uses **React + Zustand + Tailwind + three.js**
([ADR-0013](../../docs/adr/0013-typed-3d-selection-and-placement.md)), with
`@mechx/cad` running in a Web Worker.

- **Spec:** [`docs/specs/SPEC-5-cad-editor-ui.md`](../../docs/specs/SPEC-5-cad-editor-ui.md)
- **ADR:** [`0013-typed-3d-selection-and-placement`](../../docs/adr/0013-typed-3d-selection-and-placement.md)
- **Kernel:** [`@mechx/cad`](../../packages/cad) (SPEC-4 / [ADR-0012](../../docs/adr/0012-typescript-cad-kernel-on-opencascadejs.md))

## What it does (M0–M6)

- **Modelling** — sketch → extrude (blind / two-sided / up-to-a-picked-face /
  along a picked edge) / revolve / cut; **loft** through stacked sections and
  **sweep** along a path; fillet / chamfer / shell / draft on **picked**
  edges/faces (persisted as kernel `EdgeRef`/`FaceRef` so they survive rebuilds);
  boolean against an inline primitive **or a second modelled body**; pattern /
  mirror / baked transform; an ordered, editable feature tree with reorder,
  rollback, suppress, per-feature error badges, and a right-click context menu
  (edit / suppress / roll back / delete).
- **Sketcher** — a 2D SVG overlay on a datum plane: line / rectangle (corner or
  centre) / circle (centre or 3-point) / arc (3-point or centre) / polygon /
  slot / spline / point; live inference + snapping (endpoint / origin / grid /
  midpoint / centre, with H/V/parallel/perpendicular/tangent glyphs); the full
  constraint set (coincident, H/V, parallel, perpendicular, equal-length,
  concentric, tangent, point-on-object, symmetric, midpoint, fix) and dimensions
  (distance, horizontal/vertical distance, radius, diameter, angle — with
  driving→driven auto-demote when a dimension would over-constrain) wired to the
  kernel's variational solver, with a live DOF counter and three-state
  (under/well/over-constrained) feedback; drag an under-constrained point to
  re-solve live.
- **Typed 3D interaction** — hover/click selection of faces/edges/vertices (ray
  picking with a **GPU colour-id** fallback) plus **rubber-band box select**;
  transform gizmos that write back a **parametric** placement, a clickable **view
  cube** (faces→ortho, edges, corner→iso) + standard views + fit, and a measure
  tool. Repeated assembly solids render via one `InstancedMesh`.
- **Assemblies** — insert component instances, mate them (the kernel 3D mate
  solver positions them, with DOF/verdict surfaced), articulated joints with a
  live motion-preview drive.
- **Persistence** — an in-browser **SQLite** project store (sql.js, persisted to
  IndexedDB): new/open/save/save-as/rename/delete with thumbnails, debounced
  autosave, byte-identical save→reload→reopen, and **crash recovery** of unsaved
  (even untitled) work from the last autosave snapshot.
- **Simulate & interchange** — drop/run the model in the in-browser `mechx_sim`
  (live animation, clean return-to-edit), and glTF / STEP / IGES export + STEP
  import as a base body.
- **Accessibility** — keyboard shortcuts (undo/redo, Esc, 1–4 selection modes; a
  keyboard-operable feature tree: ↑/↓ select, Delete, F2/Enter rename), ARIA
  landmarks/roles, and a visible focus ring.

## Architecture (the load-bearing seams)

- **Typed-selection keystone** — the worker tessellates a solid into one mesh
  with **per-face render groups** + per-edge lines + per-vertex points, each
  tagged with its kernel id and persistent ref signature. A raycast triangle →
  group → `faceId`; highlight is a material-slot swap (no re-tessellation). See
  ADR-0013.
- **Persist the graph, derive the geometry** — the document stores the
  parametric feature tree, sketch constraint graph, body placements, assembly
  mate graph; geometry is always re-derived. Reproducible (NFR-2), undoable, and
  reloadable.
- **Solve on the main thread** — `solveSketch` and `solveMates` are pure TS, so
  constraint/mate solving runs inline for live interaction; OCCT geometry builds
  and assembly→sim lowering go through the Web Worker (the OCCT wasm stays in the
  worker chunk).
- **Reuse the kernel's sim path** — `lowerAssembly` maps instances → a
  `Component` hierarchy and runs the existing `exportForSim` + `lowerJoints`; it
  does not author a manifest format.

## Scripts & gate

From the repo root:

```sh
pnpm -C apps/cad-studio run dev          # Vite dev server
pnpm -C apps/cad-studio run build        # tsc --noEmit + production build
pnpm -C apps/cad-studio exec vitest run  # unit tests (kernel-worker round-trips, pure logic)
pnpm exec eslint apps/cad-studio/src --max-warnings 0
npx playwright test --project=cad-studio # strict no-mock E2Es (served on :4177)
```

The `cad-studio` Playwright project covers the headline flow of each milestone
end-to-end with no mocks: render a solid, pick-a-face-highlights, sketch → finish
→ extrude, feature-tree rollback/suppress, mate two parts → lower → real Rust
sim, save → reload → byte-identical, and simulate (drop under gravity → return to
edit).

> Build artifacts: `packages/cad/dist` (the worker imports the built kernel —
> rebuild with `pnpm -C packages/cad run build` after kernel edits) and
> `packages/sim/src/pkg` (the WASM sim — `just wasm`).
