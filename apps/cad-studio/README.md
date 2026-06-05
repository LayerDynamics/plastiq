# @plastiq/cad-studio

The **Plastiq** CAD editor front end — an interactive, parametric, in-browser CAD
editor (React + Zustand + Tailwind + three.js) on the
[`@plastiq/cad`](../../packages/cad) kernel, with the
[`@plastiq/sim`](../../packages/sim) physics layer for in-editor simulation.

See the [repository README](../../README.md) for the architecture overview.

## What it does

- **Modelling** — sketch → extrude (blind / two-sided / up-to-a-picked-face /
  along a picked edge) / revolve / cut; loft through stacked sections and sweep
  along a path; fillet / chamfer / shell / draft on picked edges/faces (persisted
  as kernel `EdgeRef`/`FaceRef` so they survive rebuilds); boolean against a
  modelled body; pattern / mirror / baked transform; an ordered, editable feature
  tree with reorder, rollback, suppress, and per-feature error badges.
- **Sketcher** — a 2D overlay on a datum plane with the full constraint + dimension
  set wired to the kernel's planegcs-backed variational solver, with a live DOF
  counter and three-state (under/well/over-constrained) feedback.
- **Typed 3D interaction** — hover/click selection of faces/edges/vertices (ray
  picking with a GPU colour-id fallback), rubber-band box select, transform gizmos
  that write back a parametric placement, a clickable view cube, and a measure tool.
- **Assemblies** — insert component instances, mate them (the kernel 3D mate
  solver positions them), articulated joints with a live motion-preview drive.
- **Persistence** — an in-browser SQLite project store (sql.js → IndexedDB) with
  new/open/save/save-as/rename/delete, debounced autosave, byte-identical reload,
  and crash recovery of unsaved work.
- **Simulate & interchange** — drop/run the model in the real `@plastiq/sim`
  physics engine, plus glTF / STEP / IGES export and STEP import.

## Scripts

```sh
pnpm -C apps/cad-studio run dev      # Vite dev server
pnpm -C apps/cad-studio run build    # tsc --noEmit + production build
pnpm exec vitest run                 # unit/integration suite (from the repo root)
pnpm exec playwright test            # no-mock E2E (served on :4177)
```
