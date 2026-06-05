# Plastiq

**Plastiq** is an interactive, parametric, Onshape-class **CAD editor that runs
entirely in the browser** — no server. Sketch a 2D profile, build an ordered
feature history (extrude / revolve / cut / loft / sweep / fillet / chamfer /
shell / draft / pattern / mirror / boolean), select faces/edges/vertices in 3D,
assemble component instances with mates and joints, persist projects to an
in-browser SQLite store with crash recovery, and **simulate the result under
gravity in a real physics engine** — all client-side.

## Architecture

Plastiq is a pnpm workspace of one app and two owned packages:

```text
apps/cad-studio   React + Zustand + Tailwind + three.js editor (the front end)
packages/cad      @plastiq/cad — the parametric CAD kernel
packages/sim      @plastiq/sim — the pluggable physics layer
e2e/cad-studio    no-mock Playwright end-to-end tests
```

- **`@plastiq/cad`** — a parametric B-rep kernel built directly on
  [`opencascade.js`](https://ocjs.org) (full OCCT compiled to WebAssembly). It
  owns geometry, ~18 feature operations, tagged tessellation with persistent
  face/edge references, STEP/IGES/glTF interchange, a 2D sketch constraint solver
  backed by [`@salusoft89/planegcs`](https://www.npmjs.com/package/@salusoft89/planegcs)
  (FreeCAD PlaneGCS, wasm), a first-party 3D assembly-mate solver, and
  assembly→sim lowering. Runs in the browser (in a Web Worker) and headless under
  Node.
- **`@plastiq/sim`** — one `PhysicsEngine` interface with three interchangeable
  backends, selectable at runtime:
  [Rapier](https://rapier.rs/), [ammo.js](https://github.com/kripken/ammo.js)
  (Bullet), and [cannon-es](https://pmndrs.github.io/cannon-es/). It spawns the
  kernel's `SimManifest` and steps it under gravity. Each body's collider is the
  part's **convex hull**, computed from its real tessellation (exact for convex
  parts; concave dynamics would need convex decomposition, a future step).

The editor uses React + Zustand + Tailwind + three.js, with `@plastiq/cad`
running in a Web Worker (the OCCT wasm stays in the worker chunk) and the sketch
solver on the main thread.

## Scripts

```sh
pnpm install                              # install the workspace
pnpm -C apps/cad-studio run dev           # Vite dev server
pnpm -C apps/cad-studio run build         # tsc --noEmit + production build
pnpm exec vitest run                      # unit/integration suite (real OCCT + wasm)
pnpm exec playwright test                 # no-mock browser E2E (served on :4177)
pnpm -r run typecheck                     # type-check every package + the app
```

A [`justfile`](justfile) wraps the common recipes (`just test`, `just e2e`,
`just build`, …).

## Bundle size / the OCCT trim

The shipped OCCT wasm is the full prebuilt `opencascade.js` (~14 MB gzip). A
trimmed build containing only the OCCT symbols the kernel uses is wired but
deferred: see [`packages/cad/occt.build.yml`](packages/cad/occt.build.yml) and
[`packages/cad/scripts/build-occt.md`](packages/cad/scripts/build-occt.md)
(`just cad-occt`).
