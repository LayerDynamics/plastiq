# @plastiq/cad

The MechX **parametric CAD modeling kernel** (SPEC-4) — a TypeScript package
built on [`opencascade.js`](https://ocjs.org) (full OpenCASCADE compiled to
WebAssembly). It is the authoring front-end for the MechX physics simulator:
users model exact solid parts (sketch → feature history) and assemblies (mates +
joints) here, and the kernel exports geometry + mass properties + lowered joints
that the Rust `crates/cad` ingestion bridge feeds into `crates/sim`.

- **Spec:** [`docs/specs/SPEC-4-cad-modeling-kernel.md`](../../docs/specs/SPEC-4-cad-modeling-kernel.md)
- **Plan:** [`docs/plans/2026-06-02-spec4-cad-modeling-kernel.md`](../../docs/plans/2026-06-02-spec4-cad-modeling-kernel.md)

## Layout

- `src/oc/` — `opencascade.js` engine init (single-threaded, deterministic) + handle-lifetime (`OcArena`).
- `src/math/`, `src/unit/` — f64 geometry math + SI unit conversion.
- `src/environment/` — origin, datum planes, construction geometry.
- `src/sketch/` — 2D parametric sketches + the variational constraint solver.
- `src/solid/`, `src/mesh/` — B-rep solid wrapper + tessellation.
- `src/action/` — feature operations (extrude, revolve, cut, boolean, fillet, chamfer, shell, offset, loft, sweep, draft, transform, copy, selection).
- `src/hierarchy/` — component/body.
- `src/material/` — material library/presets/manager.
- `src/assembly/` — geometric mates + the 3D mate solver, joints, rigid/contact/motion-link/relationship.
- `src/model/` — the parametric feature-history engine + serialization.
- `src/lower/` — mass properties, shape lowering, and the **SimManifest** export (the CAD→sim contract).
- `src/io/` — STEP/IGES/glTF interchange.

## Scripts

- `pnpm run typecheck` — `tsc --noEmit`.
- `pnpm run build` — `tsc` → `dist/`.
- Tests: `pnpm exec vitest run packages/cad` (unit/integration); `pnpm exec playwright test` (browser E2E).

The numeric basis is **f64 + SI** (matching `crates/sim`); `opencascade.js` runs
**single-threaded** for same-engine reproducibility (SPEC-4 NFR-2).

## In-browser editor + the sim loop

`apps/client/cad-editor.html` mounts the kernel in the Babylon client (FR-32):
model a part in real browser OCCT → render its tessellation as a Babylon mesh →
**Simulate** exports the [`SimManifest`](src/lower/manifest.ts) and drops the
part in the _same_ authoritative `mechx_sim`, in-browser, via
`@plastiq/sim`'s `spawnManifest` binding (`crates/sim-wasm` reusing the
`crates/cad` bridge). The whole loop — model → export → sim, and
model → STEP round-trip → reload → sim — is covered by strict, no-mock browser
E2Es (`e2e/cad/*`, `e2e/cad-editor.spec.ts`).

## Status

SPEC-4 milestones M0–M5 are implemented and green: sketches + the variational
constraint solver; the full feature set (extrude/revolve/cut/boolean/fillet/
chamfer/shell/offset/loft/sweep/draft/transform/pattern) with persistent
topological naming; the 3D assembly-mate solver, joints, and assembly→sim
lowering (validated against the closed-form four-bar); materials; STEP/IGES/glTF
interchange; reproducible JSON model serialization; and the in-browser editor.

> **V1 gaps (recorded):** ball/prismatic/cylindrical/planar joints have no
> `mechx_sim` equivalent yet (Q8) — a slider-crank needs a sim-side prismatic
> joint (the four-bar is the V1 mechanism). Multi-hull convex decomposition for
> concave bodies is a noted follow-on (R6; V1 lowers a single hull).
