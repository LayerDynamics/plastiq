# Plan — Plastiq: independent CAD editor by REPLACING the @mechx deps

**Date:** 2026-06-05 (revised — pivots from "vendor mechx" to "replace mechx")
**Source findings:** `CADStudio.md` (repo root)

> ## ⚠ Course correction
> The first version of this plan **vendored** (copied) `@mechx/cad` + `@mechx/sim`
> from the monorepo and relabeled them `@plastiq/*`. That was wrong: the
> instruction was to **replace** them because the mechx source will be
> **unavailable**. Copying mechx code is the opposite of replacing it. This
> revision rebuilds both dependencies on **third-party libraries** instead. The
> M0 scaffold carries over; the **vendored mechx kernel/sim (M1) is removed**.

**Goal:** ship Plastiq — the standalone browser CAD editor — with `@mechx/cad`
and `@mechx/sim` **replaced** by independent implementations built on public
libraries, so the repo carries **zero mechx code**.

---

## Locked decisions

| # | Decision | Detail |
|---|----------|--------|
| 1 | **Replace, do not vendor** | No mechx source in the repo. The copied `packages/cad` + `packages/sim` from the old M1 are deleted. |
| 2 | **Geometry → `opencascade.js` (direct)** | `@plastiq/cad` is a NEW kernel built directly on OCCT/opencascade.js bindings. |
| 3 | **Sketch solver → `planegcs`** | FreeCAD's geometric constraint solver (wasm npm pkg) backs `solveSketch`. |
| 4 | **Mate solver → first-party** | `solveMates` (3D assembly mates) written from scratch under `@plastiq/cad`. |
| 5 | **Physics → pluggable adapter, 3 backends** | `@plastiq/sim` exposes one `PhysicsEngine` interface with **Rapier (`@dimforge/rapier3d`)**, **ammo.js (Bullet)**, and **cannon-es** adapters, selectable at runtime. |
| 6 | **App import specifiers stay `@plastiq/*`** | The contract names stay; only the package *contents* are new (built, not copied). |
| 7 | **Brand: Plastiq** | (unchanged from prior plan) |
| 8 | **Toolchain: vite@8 + vitest@4** | (already installed; build is green) |
| 9 | **git: commit per milestone on `main`** | Standing approval; no push. |

---

## Reality check — magnitude

This is **not a rewire; it is building a parametric CAD kernel + a physics layer
from scratch.** `@plastiq/cad` must re-provide the entire bespoke API the app
imports (enumerated below) on top of raw OCCT + planegcs + custom mate math:
primitives, ~16 feature operations, tagged tessellation with persistent
`EdgeRef`/`FaceRef`, STEP/IGES/glTF I/O, a constraint-solver bridge, a 3D mate
solver, and assembly→physics lowering. `@plastiq/sim` must provide a 3-backend
physics layer matching the app's `initSim`/`PredictionSim` usage. Per the no-stub
rule, every piece ships as real, working code — so this spans many milestones and
substantial implementation. No shortcuts, no placeholders.

**Test consequence:** the 412 green tests currently include the copied mechx
kernel/sim tests. When that code is removed, those tests go with it. The new
kernel needs its **own** test suite written against the new implementation. The
app's own tests (`apps/cad-studio/src/**`) stay and are the regression anchor.

---

## The replacement contract (what `@plastiq/cad` + `@plastiq/sim` MUST export)

Extracted from the app's actual imports (evidence: `apps/cad-studio/src/worker/{rebuild,lower,geometry.worker,bridge,protocol}.ts`, `store/store.ts`, `sketch/{model,sketchStore}.ts`, `assembly/model.ts`, `viewport/dressup.ts`, `sim/simulator.ts`).

**`@plastiq/cad` — engine & types:** `initOcct`, `Occt`, `Solid`, `mm`, `planeXY`, `offsetPlane`, `DatumPlane`
**Primitives:** `makeBox`, `makeBoxAt`
**Feature ops:** `extrude`, `extrudeToFace`, `revolve`, `cut`, `fillet`, `chamfer`, `shell`, `draft`, `loft`, `sweep`, `linearPattern`, `circularPattern`, `mirror`, `union`, `subtract`, `intersect`, `translate`, `rotate`, `Sketch`, `SpinePath`, `resolveEdgeDirection`
**Tessellation/selection:** `tessellateTagged`, `TaggedMesh`, `TessellateOptions`, `FaceGroup`, `EdgeRef`, `FaceRef`
**I/O:** `exportStep`, `exportIges`, `exportGltf`, `importStep`
**Sketch solver:** `solveSketch`, `SolveResult`, `Constraint` (aliased `SolverConstraint`), `SolverPoint`
**Assembly:** `solveMates`, `MateSolveResult`, `Mate`, `MateRef`, `ComponentPose`, `JointKind`
**Lowering / sim-manifest:** `Component`, `defaultLibrary`, `exportForSim`, `isLowerable`, `lowerJoints`, `makeBody`, `makeJoint`, `massProperties`, `JointBinding`, `SimManifest`, `isSimManifest`

**`@plastiq/sim`:** `initSim`, `PredictionSim` (+ `InputSample` used by tests) — re-shaped over the pluggable `PhysicsEngine`.

> The app also defines its OWN `SimManifest`/lowering expectations in
> `worker/protocol.ts` + `worker/lower.ts`. Since the physics engine is being
> replaced, the manifest format is now **ours to define** — `lowerAssembly`
> targets the new `@plastiq/sim` spawn format, not the old Rust manifest.

---

## Milestones

### R0 — Carry-over (already done)
- [x] M0 scaffold (workspace, tooling, vite@8, git). **Keep.**

### R1 — Tear out vendored mechx; stand up replacement skeletons + deps
- [ ] **R1.1** Delete `packages/cad` and `packages/sim` (the copied mechx code) — **destructive, confirm first.**
- [ ] **R1.2** Recreate `packages/cad` (`@plastiq/cad`) and `packages/sim` (`@plastiq/sim`) as empty TS-source packages (`main`/`types` = `src/index.ts`, tsconfig extends root base).
- [ ] **R1.3** Add real deps: `@plastiq/cad` → `opencascade.js`, `planegcs`; `@plastiq/sim` → `@dimforge/rapier3d`, `ammo.js`, `cannon-es`. `pnpm install`. Confirm each resolves and its wasm/types load.
- [ ] **R1.4** Write the **public API contract as a typed `index.ts` surface** (types + function signatures) for `@plastiq/cad`, so the app typechecks against the target shape while implementations land. (Signatures only here are acceptable as a *compile contract*, but every function is implemented for real in R2–R6 before that milestone is marked done — nothing ships half-built.)

### R2 — `@plastiq/cad` geometry core on opencascade.js
- [ ] OCCT init (`initOcct`, `Occt`), `Solid` wrapper + lifecycle (`.delete()` arena discipline), `mm`/units, math, datum planes (`planeXY`, `offsetPlane`, `DatumPlane`), primitives (`makeBox`, `makeBoxAt`). Tests: volumes/bbox.

### R3 — `@plastiq/cad` tessellation + selection refs + I/O
- [ ] `tessellateTagged` → per-face groups + per-edge polylines + per-vertex points, each tagged with persistent `EdgeRef`/`FaceRef` signatures (`TaggedMesh`, `FaceGroup`, `TessellateOptions`); `resolveEdgeDirection`. STEP/IGES/glTF `export*` + `importStep`. Tests: face/edge counts survive a resize (ref persistence).

### R4 — `@plastiq/cad` feature operations on OCCT
- [ ] `extrude`/`extrudeToFace`, `revolve`, `cut`, booleans (`union`/`subtract`/`intersect`), dress-up (`fillet`/`chamfer`/`shell`/`draft`), `loft`/`sweep` (+`SpinePath`), `linearPattern`/`circularPattern`/`mirror`, `translate`/`rotate`, the `Sketch` profile builder. Tests mirror the app's `worker/rebuild.test.ts` cases.

### R5 — `@plastiq/cad` solvers
- [ ] **R5.1** `solveSketch` via **planegcs**: map `SolverPoint`/`Constraint` → planegcs system, solve, return `SolveResult` (points/radii/verdict/DOF). Tests: the sketch suite's constraint cases.
- [ ] **R5.2** First-party `solveMates` (3D): `Mate`/`MateRef`/`ComponentPose`/`JointKind`/`MateSolveResult`. Tests: coincident/concentric/parallel mates converge.

### R6 — `@plastiq/sim` pluggable physics + `@plastiq/cad` lowering
- [ ] **R6.1** `PhysicsEngine` interface (`init`/`spawn`/`step`/`poses`/`snapshot`); adapters for **Rapier**, **ammo.js**, **cannon-es**; `initSim`/`PredictionSim` re-shaped over it with a selectable backend. Tests: each backend drops a body under gravity deterministically (per-engine tolerance where bit-determinism isn't guaranteed).
- [ ] **R6.2** Define the new `SimManifest` format; implement `lowerAssembly`/`exportForSim`/`lowerJoints`/`makeBody`/`makeJoint`/`Component`/`defaultLibrary`/`massProperties`/`isLowerable`/`isSimManifest` targeting it. Tests: app's `worker/lower.test.ts` + `assembly/model.test.ts` equivalents.

### R7 — Rewire app, go green
- [ ] App builds + typechecks against the new packages; `apps/cad-studio` unit tests pass; `vite build` green. Adjust `worker/lower.ts`, `sim/simulator.ts`, `worker/protocol.ts` to the new manifest/engine shapes as needed.

### R8 — Correctness defects (the 7, each with a regression test)
- [ ] Same 7 from CADStudio.md §4–§5 (mate/joint id collision, nextSeq undo, rollback index, assembly re-solve, dress-up feedback, worker timeout, circularPattern button). The CRITICAL id-collision lands first.

### R9 — E2E port + rebrand + OCCT trim pipeline
- [ ] Port the 12 Playwright specs (`:4177`), run no-mock green against the NEW kernel/sim. Rebrand (title, README, storage keys → `plastiq*`, no migration). Wire (not run) the OCCT trim pipeline.

---

## Open risks
- **planegcs API fit** — its constraint vocabulary must cover the app's full set (coincident, H/V, parallel, perp, equal, concentric, tangent, point-on-object, symmetric, midpoint, fix + dimensions). Validate early in R5.1; gaps may need supplementing.
- **Determinism across physics backends** — Rapier can be deterministic; ammo/cannon less so. The pluggable interface must not assume bit-identity; tests use per-engine tolerance.
- **Lowering format churn** — replacing the sim means the manifest is redefined; `worker/protocol.ts` + `lower.ts` change with it (R6.2/R7).
- **Bundle** — opencascade.js full wasm (~14MB gzip) unless the OCCT trim (R9) runs.

## Definition of Done
- Zero mechx code in the repo (`grep -rin mechx` clean except provenance notes).
- `pnpm install` clean; typecheck exit 0; app unit tests green; `vite build` green.
- New `@plastiq/cad` + `@plastiq/sim` test suites pass; 12 E2E specs green (no mocks) against the new implementations.
- All 7 defects fixed with regression tests; commit-per-milestone history on `main`.
