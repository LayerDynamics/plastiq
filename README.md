# Plastiq

**Plastiq** is an interactive, parametric, web based **CAD editor that runs
entirely in the browser**. Sketch a 2D profile, build an ordered
feature history (extrude / revolve / cut / loft / sweep / fillet / chamfer /
shell / draft / pattern / mirror / boolean), select faces/edges/vertices in 3D,
assemble component instances with mates and joints, persist projects to an
in-browser SQLite store with crash recovery, and **simulate the result under
gravity in a real physics engine** — all client-side.

It also has **AI generation** (SPEC-6): describe a part in natural language and a
model authors it through a tool-using agent (`build_part` / `inspect_geometry`),
can edit the open part, and runs from a side panel or a ⌘/Ctrl-K command palette.
Providers are bring-your-own — **local Ollama** (no key, offline) or **Anthropic
Claude** — so the editor itself stays serverless; only the model call leaves the
browser, to the endpoint you choose. A creative path turns text/image prompts into
mesh bodies via cloud 3D-gen, and those meshes can be reconstructed into editable
B-rep STEP solids by an **optional, self-hosted** reconstruction service
([`services/reconstruct`](services/reconstruct), Python + pythonOCC — see
[SPEC-7](docs/specs/SPEC-7-mesh-reconstruction.md)).

## Architecture

Plastiq is a pnpm workspace of one app and two owned packages:

```text
apps/plastiq        React + Zustand + Tailwind + three.js editor (the front end)
packages/cad           @plastiq/cad — the parametric CAD kernel
packages/sim           @plastiq/sim — the pluggable physics layer
services/reconstruct   optional Python + pythonOCC mesh→B-rep (STEP) service (SPEC-7)
e2e/plastiq         no-mock Playwright end-to-end tests
```

- **`@plastiq/cad`** — a parametric B-rep kernel built directly on
  [`opencascade.js`](https://ocjs.org) (full OCCT compiled to WebAssembly). It
  owns geometry, ~18 feature operations, tagged tessellation with persistent
  face/edge references, STEP/IGES/glTF interchange, a 2D sketch constraint solver
  backed by [`@salusoft89/planegcs`](https://www.npmjs.com/package/@salusoft89/planegcs)
  (FreeCAD PlaneGCS, wasm), a first-party 3D assembly-mate solver, and
  assembly→sim lowering. Runs in the browser (in a Web Worker) and headless under
  Node.
- **`@plastiq/sim`** — one `PhysicsEngine` interface with four interchangeable
  backends, selectable at runtime:
  [MuJoCo](https://mujoco.org/) (DeepMind, the default — vendored WASM, expresses
  world-axis hinges between arbitrarily-oriented bodies natively),
  [Rapier](https://rapier.rs/), [ammo.js](https://github.com/kripken/ammo.js)
  (Bullet), and [cannon-es](https://pmndrs.github.io/cannon-es/). It spawns the
  kernel's `SimManifest` and steps it under gravity. Each body is a **compound of
  convex-hull colliders**: a convex part is one hull (exact); a concave part is
  split into several convex pieces by [V-HACD](https://github.com/kmammou/v-hacd)
  so the collider tracks the real concave shape instead of bulging across the
  pocket — a multi-piece convex *approximation*, tunable by tolerance, not a
  single bounding hull.

The editor uses React + Zustand + Tailwind + three.js, with `@plastiq/cad`
running in a Web Worker (the OCCT wasm stays in the worker chunk) and the sketch
solver on the main thread.

## Scripts

```sh
pnpm install                              # install the workspace
pnpm -C apps/plastiq run dev           # Vite dev server
pnpm -C apps/plastiq run build         # tsc --noEmit + production build
pnpm exec vitest run                      # unit/integration suite (real OCCT + wasm)
pnpm exec playwright test                 # no-mock browser E2E (served on :4177)
pnpm -r run typecheck                     # type-check every package + the app
```

A [`justfile`](justfile) wraps the common recipes (`just test`, `just e2e`,
`just build`, …).

## Bundle size / the OCCT trim

The shipped OCCT wasm is a **custom trimmed build** of `opencascade.js` containing
bindings for only the OCCT symbols the kernel uses — **~5.6 MB gzip, down from
~13.7 MB gzip** for the full prebuilt build. It lives at
[`packages/cad/vendor/occt/`](packages/cad/vendor/occt/) and is loaded by
`src/oc/init.ts` in both Node and the browser. The symbol list
([`packages/cad/occt.build.yml`](packages/cad/occt.build.yml)) is verified by
running the full test suite against the trimmed wasm — a missing symbol fails loudly
with an embind `UnboundTypeError`. To rebuild it (Docker, ≥12 GB memory):
`just cad-occt` — see
[`packages/cad/vendor/occt/PROVENANCE.md`](packages/cad/vendor/occt/PROVENANCE.md)
and [`packages/cad/scripts/build-occt.md`](packages/cad/scripts/build-occt.md).
The full `opencascade.js` package stays a dependency (API types + rebuild source).
