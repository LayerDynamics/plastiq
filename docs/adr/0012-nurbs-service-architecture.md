# ADR 0012 — `services/nurbs/` : a modular MLX NURBS surface-fitting service

**Status:** Accepted · **Date:** 2026-07-04 · **Plan:** `docs/plans/2026-07-04-nurbs-service.md`
**Tier:** T2 (self-hosted Python) · **Source idea:** Piegl & Tiller *The NURBS Book* (algorithms); NURBS-Diff (BSD-3); ParSeNet (architecture only); Point2CAD (CC-BY-NC, ideas only); NURBGen (no license, schema shape only); StepForge (Apache-2.0) · **Framework:** MLX (Apple Silicon)

## Context

At authoring time (before the same wave's U0.2 scaffold fill), `services/nurbs` existed only as
undefined empty scaffolding — a one-line README, 0-byte
`pyproject.toml`/`.gitignore`/`.dockerignore`, empty `app/`/`tests/` dirs — with no prior spec, ADR,
plan, or Expanse milestone defining it (SPEC-12 §1). SPEC-12 is its definition; this ADR records the
architecture decisions SPEC-12 §2 locked (D-1..D-10, user, 2026-07-04).

The gap it fills: SPEC-7's reconstruct service turns meshes into analytic B-rep solids, but its
freeform stage is single-patch `BRepOffsetAPI_MakeFilling` with a documented **fundamental** limit —
a closed region has no boundary loop, so it "can't be one filled patch (a whole organic blob stays
faceted — a fundamental limit)" (`services/reconstruct/app/freeform.py:14-17`) — and no controllable
global fit or multi-patch decomposition (SPEC-12 §1). SPEC-6/NeRF/capture produce exactly such
organic meshes.

The Expanse audit marked NURBGen "T3, ALREADY-COVERED" (`docs/audits/Expanse.md:183-197`) because
reconstruct already does freeform BSpline fitting and SPEC-6 owns text→CAD generation. Both remain
true and untouched. What neither subsystem has — the differentiator that resolves that verdict, the
same way the NeRF service's reversal did — is **data-driven surface fitting**: approximating
scattered mesh geometry with B-spline patches by least squares + gradient refinement, including the
closed/organic topology `MakeFilling` fundamentally cannot fill (SPEC-12 §1, D-3).

## Decision

Build a self-hosted, **modular MLX** NURBS surface-fitting service per SPEC-12: GLB mesh →
uv-parameterization → LSQ fit → gradient refinement → validated NURBS-surface JSON → OCCT → STEP.

- **Identity: mesh→NURBS surface fitting (D-1).** *Not* text→CAD generation — SPEC-6 owns that
  identity; *not* a NURBGen port — NURBGen fits nothing (it is an LLM emitting NURBS JSON,
  `Expanse.md:185-187`). This service owns all data-driven NURBS fitting in the repo. Reconstruct
  keeps mechanical parts; nurbs takes smooth/organic (D-3).
- **Own modular MLX core, written fresh from Piegl & Tiller (D-2).** The ref/ survey found no
  liftable NURBS math anywhere — NURBGen and StepForge delegate all geometry to OCCT, CADmium to the
  truck kernel, and none does point/mesh→surface fitting (SPEC-12 §1). Basis/eval/knots/fitting are
  `mlx.core`/`mlx.nn` (FR-1, modules §5.2); numpy/scipy only at I/O boundaries; geomdl (MIT) and
  scipy/OCCT serve as test oracles.
- **Deterministic fitting, no RNG anywhere (D-10, FR-2, §5.4).** Deterministic scattered-data LSQ
  initialization (with Laplacian fairness and boundary-interpolation constraints) + optional
  differentiable refinement minimizing bidirectional Chamfer + fairness via `mx.value_and_grad`
  (NURBS-Diff's recipe minus its random init), fixed iteration budgets, fixed traversal order,
  best-iterate-wins — determinism by construction (NFR-1), no seed machinery.
- **Two-precision policy (D-9, §5.3).** float32 on GPU (`mx.compile`d) for the gradient loop;
  float64 on the CPU stream for LSQ solves and final validation — designed around MLX's constraints:
  `mlx.core.linalg` has no `lstsq` (normal equations + Cholesky instead), linalg is CPU-stream-only,
  and float64 is CPU-only.
- **In-service OCCT with subprocess isolation (D-6).** `pythonocc-core` (conda) + pip `mlx` in one
  conda env `plastiq-nurbs` — GLB in → STEP out, self-contained. OCCT is isolated behind
  `occ_step.py` and runs in a **spawn-context subprocess** (StepForge pattern, Apache-2.0), so a
  native segfault is a failed job, never a dead service (§7, R-4).
- **Service surface: FastAPI submit→poll on :8003 (FR-7), wire contract frozen in SPEC-12 §6.1**
  (`POST /fit` → poll → `{ step, surfaces, report }`, mirroring reconstruct/capture/nerf). U8 must
  not diverge from that table without updating the client + spec together.
- **JSON contract: NURBGen-shaped schema with real validation (D-7, §6.2).** NURBGen has no schema
  validation; `schema.py` enforces the knot laws, grid dims, weights, and degree bounds before OCCT
  ever sees the data. **Compact** (unique+multiplicity) knots on the wire, **flat** (textbook) knots
  internally, `core/knots.py` converts — the documented interop footgun, named.
- **Defaults (D-8): degree 3, clamped, non-periodic, non-rational** (weights omitted ⇒ 1.0); export
  degree bound ≤ 8 (OCCT's hard max is 25; CAD interop favors ≤ 8) — satisfying both the
  `Geom_BSplineSurface` constructor and the STEP `b_spline_surface_with_knots` WHERE rules with zero
  conversion.
- **Integration: direct app path in v1; delegation later (D-4, D-5).** v1 ships the browser client —
  net-new `packages/nurbs` (`@plastiq/nurbs`, mirroring `packages/nerf`) plus app wiring
  (`apps/plastiq/src/ai/nurbs.ts`, settings, GenerationPanel action → `stepToImportDocument` →
  `importStep`) — **reachable from the running app, not a tested island**. Reconstruct delegation is
  deferred to milestone U10, env-gated behind `RECONSTRUCT_NURBS_URL` (unset ⇒ reconstruct's current
  `MakeFilling` behaviour, unchanged; FR-10), and gated on U7 proving fitting quality.
- **License ledger (R-7):** NURBGen — **no LICENSE → all rights reserved: JSON-schema shape only,
  zero code**. Point2CAD — **CC-BY-NC: ideas only**. ParSeNet — **architecture only**. NURBS-Diff
  (**BSD-3**) and StepForge (**Apache-2.0**) — patterns reimplemented with attribution. geomdl
  (**MIT**) — **test-only oracle, never imported by `app/` code**.

## Consequences

- New `services/nurbs/` filled per SPEC-12 (modular `app/core/*` + `param.py`/`meshio.py`/
  `schema.py`/`occ_step.py`/`jobs.py`/`main.py`, tests, `environment.yml`, `pyproject.toml`,
  README); net-new `packages/nurbs`; `apps/plastiq/src/ai/nurbs.ts` + `nurbsBaseURL`/`nurbsApiKey`
  settings; `nurbs:plastiq-nurbs:services/nurbs:8003` registered in `scripts/dev-services.sh` +
  `justfile` (three services become four).
- **Watertightness rides on shared fitted boundary curves, interpolated by construction**
  (constrained LSQ rims) — not sew-by-tolerance (R-1, the make-or-break risk). **U7 was its gate**:
  a genus-0 blob had to become a sewn watertight NURBS solid with closure verified, or work stopped
  and re-planned before U8+ (SPEC-12 §8). **The gate passed** — `fit_closed(blob.glb)` yields
  `is_solid`/`is_valid`/`free_edges == 0`, so U8+ proceeded.
- Strict TDD with oracle-parity suites (geomdl, scipy, OCCT D0/D1 round-trip) and **real M4-Max
  fitting asserts** — refinement beats its LSQ init, fitted beats faceted (NFR-2), no stubs. A
  per-patch accuracy gate falls back to faceted faces, so the service always returns a valid STEP
  (FR-5). License-clean per the ledger above.
- **Shipped (SPEC-12 U0–U9, docs reconciled 2026-07-05):** the service is implemented and the U7
  gate passed; `app.main` serves the §6.1 contract on :8003, the `@plastiq/nurbs` client + app
  wiring are in place, and the `plastiq-nurbs` pytest suite is green (356 tests). Reconstruct
  delegation (U10, FR-10) is **deferred** — env-gated behind `RECONSTRUCT_NURBS_URL`, pending
  cross-session safety on the concurrently-edited `services/reconstruct`.

## Honest scope

- **Genus ≥ 1 inputs are rejected** with a clear error — only disk-topology (open) and genus-0
  closed meshes in v1 (NFR-5, §10).
- **NURBS smooths**: sharp-edged mechanical parts belong to reconstruct's analytic path; the
  report's `max_deviation` exposes rounding of sharp features, and the client labels faceted
  fallbacks (NFR-5, R-5). U10 delegation makes routing automatic later.
- **Fitting quality is bounded by parameterization** (harmonic-map distortion on elongated or
  high-curvature regions) and by the no-knot-optimization scope — capacity comes from grid
  refinement, not knot/weight optimization (R-3, §5.4, §10).
- **Deploy is out of scope**: MLX requires Apple-Silicon Metal — local-only like capture/nerf
  (NFR-4); `.dockerignore` is filled for parity but no Dockerfile ships in v1.
