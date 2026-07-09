# SPEC-12 — NURBS surface-fitting service (`services/nurbs/`, MLX)

**Status:** Shipped (U0–U9 done — the service is implemented, the U7 watertight-blob gate passed, and the 356-test `plastiq-nurbs` suite is green; U10 reconstruct delegation DONE 2026-07-05 — env-gated, live-verified, the delegated NURBS face survives the mixed solid, closing SPEC-7 §D-3; U11 docs reconciled)
**Date:** 2026-07-04
**Owner:** LayerDynamics
**ADR:** [`docs/adr/0012`](../adr/0012-nurbs-service-architecture.md) (authored in U0.1)
**Plan:** `docs/plans/2026-07-04-nurbs-service.md`
**Framework:** MLX (Apple Silicon / M4 Max)
**Source ideas:** Piegl & Tiller *The NURBS Book* (algorithms); NURBS-Diff (BSD-3 — differentiable-fitting
recipe); ParSeNet SplineNet (architecture only); Point2CAD (CC-BY-NC — ideas only, no code); NURBGen
(no license — JSON-schema shape only, no code); StepForge (Apache-2.0 — SCD metric + OCCT subprocess
isolation)
**Depends on:** SPEC-7 (reconstruct — the pipeline whose freeform gap this fills), `@plastiq/cad`
(`importStep`), SPEC-6 (the creative path that produces the mesh documents this service consumes)

---

## 0. One-sentence thesis

A self-hosted, **modular MLX** NURBS service: a triangle mesh's smooth/organic regions → real
B-spline surfaces via deterministic least-squares fitting + differentiable (gradient) refinement →
a validated NURBS-surface JSON + a B-rep **STEP** the app imports as editable CAD — closing the one
gap SPEC-7's deterministic OCCT path documents as fundamental: a closed region "can't be one filled
patch (a whole organic blob stays faceted — a fundamental limit)"
(`services/reconstruct/app/freeform.py:14-17`).

## 1. Problem & context

At authoring time `services/nurbs` was **empty scaffolding**: a one-line README (`# plastiq-nurbs —
modular MLX Nurbs`), 0-byte `pyproject.toml`/`.dockerignore`/`.gitignore`, and empty `app/`/`tests/`
dirs (root `README.md` marked it "reserved for future work"). No prior spec, ADR, plan, or Expanse
milestone defined it — this spec is its definition. It has since been implemented per the milestones
below (U0–U9 shipped; the U7 gate passed); the empty-scaffold description above is the historical
starting point, not the current state.

**The gap it fills.** SPEC-7's reconstruct service turns meshes into analytic B-rep solids, but its
freeform stage is single-patch `BRepOffsetAPI_MakeFilling` with two documented fundamental limits
(`freeform.py:14-17`, SPEC-7 §8 R6.5, Risk R-3 "organic meshes reconstruct poorly"):

1. **A closed region (no boundary loop — a whole organic blob) cannot be one filled patch** — it
   stays per-triangle faceted. SPEC-6/NeRF/capture produce exactly such organic meshes.
2. `MakeFilling` offers no controllable global fit (interior-point ladder, C0 rim only) and no
   multi-patch decomposition.

**Why this doesn't duplicate existing subsystems.** The Expanse audit marked NURBGen "T3,
ALREADY-COVERED" (`docs/audits/Expanse.md:183-197`) because (a) reconstruct "already does freeform
BSpline fitting" and (b) SPEC-6 owns text→CAD generation. Both remain true and untouched:
this service is **not** generation (SPEC-6 keeps that identity), and it is **not** a NURBGen port
(NURBGen fits nothing — it is an LLM emitting NURBS JSON). What it owns is the thing neither has:
**data-driven surface fitting** — approximating scattered mesh geometry with B-spline patches by
least squares + gradient refinement, including the closed/organic topology `MakeFilling`
fundamentally cannot fill. This resolves the "already-covered" verdict the same way the NeRF
service's reversal did (`docs/plans/2026-06-22-nerf-service.md:186-187`): build own-MLX, name the
differentiator.

**Why MLX, why from scratch.** The ref/ survey found **no vendored repo implements NURBS math** —
NURBGen and StepForge delegate everything to OCCT (`geomconvert.SurfaceToBSplineSurface`,
`BRepBuilderAPI_NurbsConvert`), CADmium delegates to the truck kernel, and none does point/mesh→
surface fitting. The core is therefore written fresh in `mlx.core`/`mlx.nn` from the literature
(the M4-Max MLX mandate that produced capture/nerf), with geomdl (MIT) and OCCT as test oracles.

## 2. Locked decisions (user, 2026-07-04)

| # | Decision | Rationale / consequence |
|---|---|---|
| D-1 | **Identity: mesh→NURBS surface fitting.** Not text→CAD generation (SPEC-6 owns it), not a NURBGen port (NURBGen fits nothing — `Expanse.md:185-187`). | The service owns all data-driven NURBS fitting in the repo. |
| D-2 | **Own modular MLX core, written fresh from the literature.** | No liftable NURBS math exists in ref/ (survey verdict); Piegl & Tiller algorithm numbers are the normative reference (§5.4). |
| D-3 | **Differentiator vs reconstruct:** differentiable fitting where the deterministic OCCT path is fundamentally limited (closed regions, controllable accuracy, multi-patch). Reconstruct keeps mechanical parts; nurbs takes smooth/organic. | Resolves the Expanse "already-covered" verdict honestly. |
| D-4 | **v1 ships the browser client**: net-new `packages/nurbs` (`@plastiq/nurbs`) + app wiring — no reserved dir exists (`packages/recon` = *reconstruct*, not nurbs). | Mirrors `@plastiq/nerf` exactly; reachable from the running app, not a tested island. |
| D-5 | **Integration: direct app path in v1 (:8003); reconstruct delegation is a later milestone (U10), env-gated.** | "Both — direct v1, delegate later." Proves the service end-to-end before coupling services. |
| D-6 | **In-service OCCT** (`pythonocc-core` conda + pip `mlx`, one env) — GLB in → STEP out, self-contained. | Same env pattern as reconstruct+nerf combined; OCCT isolated behind `occ_step.py` with subprocess isolation (StepForge pattern, Apache-2.0). |
| D-7 | **JSON contract: NURBGen-shaped schema with real validation** (§6.2) — compact (unique+multiplicity) knots on the wire, flat (textbook) knots internally, `core/knots.py` converts. | NURBGen has no schema validation at all; we enforce the knot laws ourselves. The compact-vs-flat mismatch is the documented interop footgun. |
| D-8 | **Defaults: degree 3, clamped, non-periodic, non-rational** (weights omitted ⇒ 1.0); export bound degree ≤ 8 (OCCT hard max 25, CAD-interop favors ≤ 8). | Satisfies both the `Geom_BSplineSurface` constructor and STEP `b_spline_surface_with_knots` WHERE rules with zero conversion. |
| D-9 | **Two-precision policy:** float32 on GPU for the gradient loop; float64 on the CPU stream (MLX linalg / numpy) for LSQ solves + final validation. | MLX: float64 is CPU-only; `mlx.core.linalg` has no `lstsq` and runs LAPACK on CPU — normal equations + Cholesky (§5.3). |
| D-10 | **No RNG anywhere.** LSQ initialization (not NURBS-Diff's random init), fixed iteration budgets, fixed traversal order. | Determinism by construction (NFR-1), matching reconstruct's NFR-2 spirit — no seed machinery to maintain. |

## 3. Functional requirements

- **FR-1** The NURBS core (basis, evaluation, derivatives, knot ops, fitting) is **MLX**
  (`mlx.core`/`mlx.nn`); numpy/scipy only at I/O boundaries (GLB parse, sparse harmonic solve, OCCT
  hand-off). Parity tests against geomdl (MIT) and scipy oracles for basis values, surface points,
  derivatives, and knot insertion (float64 CPU, tol ≤ 1e-6).
- **FR-2** Fitting = **deterministic LSQ init** (scattered-data least squares with fairness, §5.4)
  + **optional gradient refinement** (`iters` request param; `0` ⇒ pure LSQ). `fit_grad.refine` keeps
  its best iterate by its own Chamfer objective; the **pipeline** then reports/returns whichever of
  {LSQ init, refined} is better on the projection deviation the FR-9 report and the FR-5 gate consume
  (best-of-init-or-refined) — so the returned fit is **never worse than the LSQ init on the reported
  metric**. (fit_grad's Chamfer best-iterate alone does not guarantee this on the projection metric —
  the pipeline-level comparison does; `app/pipeline.py`.) Refinement can hold chosen control-net
  boundary rows **fixed** — a `freeze` mask over the `{u0, u1, v0, v1}` rim edges (or a
  `fit_scattered` `rim` dict, which passes straight through), applied by zeroing those rows' gradient
  each Adam step (`core/fit_grad.py`) — so refining a patch's interior never moves a rim off its
  shared fitted boundary curve, preserving the FR-3/FR-4 sewability the closed-mode gate depends on.
- **FR-3 (open mode)** A disk-topology mesh/region with one boundary loop → **one patch** whose rim
  interpolates the region's boundary polyline (so it sews with faceted/planar neighbours — the same
  coincident-boundary property `freeform.py` relies on, making U10 delegation possible).
- **FR-4 (closed mode)** A closed genus-0 mesh → **six patches** on a cube-map uv layout sharing
  **fitted boundary curves** (patches interpolate the shared curves by construction), sewn →
  `MakeSolid` → `OrientClosedSolid`, with closure **verified, never assumed**
  (`NbFreeEdges()==0`, `BRepCheck_Analyzer.IsValid()`, positive volume — reconstruct FR-7's checks).
  Each chart's uv map pins the four square corners at the chart's **four junction vertices**
  (where ≥ 3 charts meet), so every shared boundary polyline maps onto **exactly one uv side** on
  both incident charts; combined with a **uniform `(n, n)` control grid + degree shared across all
  charts**, that lets `fit_scattered` pin a whole rim side (`u0`/`u1`/`v0`/`v1`) to the shared
  fitted curve — watertight by construction (R-1). This requires **4-valent charts** (`blob.glb` is
  the 4-regular cube graph); a chart with ≠ 4 junctions, or whose pinned map flips, falls back to
  faceted (FR-5).
- **FR-5** A per-patch accuracy gate (report `max_deviation` vs `fidelity_tol`); any patch or
  assembly that fails fitting/closure falls back to **faceted** faces — the service always returns
  a valid STEP, nothing is dropped (reconstruct D-5/FR-8 precedent).
- **FR-6** The result carries the **validated NURBS-surface JSON** (§6.2) alongside the STEP; schema
  invariants are enforced in `schema.py` *before* OCCT ever sees the data.
- **FR-7** FastAPI **submit→poll** on **:8003** (`POST /fit` → poll → `{ step, surfaces, report }`),
  mirroring reconstruct/capture/nerf (§6.1); registered in `scripts/dev-services.sh` + `justfile`
  (whose "three services" comments U0 updates to four).
- **FR-8** Browser client is its own workspace package **`@plastiq/nurbs`** (`packages/nurbs`,
  net-new, mirroring `packages/nerf`): `fitNurbs()` submit→poll → `{ step, surfaces, report }`.
  `apps/plastiq` adds `src/ai/nurbs.ts`, maps the STEP via the existing `stepToImportDocument` →
  kernel `importStep`, adds `nurbsBaseURL`/`nurbsApiKey` settings (panel field `settings-nurbs-key`),
  and exposes a GenerationPanel action alongside "Convert to CAD" — **reachable from the running
  app** (SPEC-11 FR-7 precedent).
- **FR-9** The **open-mode** `report` exposes these **15 keys** — `{ patches, fitted_patches,
  faceted_patches, control_points, degree_u, degree_v, iters, chamfer, scd, rms_deviation,
  max_deviation, fidelity_tol, is_solid, is_valid, mode }` — so the client/UX can show fidelity
  honestly (reconstruct FR-9 precedent; SCD = Scaled Chamfer Distance, StepForge Eqs. 1–3, already
  ported once in `docs/adr/0001`). `control_points` is the total control points in the fitted net
  (nu × nv), a single integer.
  **Closed mode returns a 17-key superset** (`app/pipeline_closed.py`): the same 15 keys **plus**
  `free_edges` (integer; `0` ⇔ watertight, from `Sewing.NbFreeEdges`) and `volume` (float; GProp
  metres³ after outward orientation). The `@plastiq/nurbs` client (`NurbsReport` /
  `NurbsReportWire`, `packages/nurbs/src/{types,client}.ts`) maps only the **15 common keys** —
  `free_edges`/`volume` travel on the closed-mode result JSON but are **not** typed or surfaced by
  the client today.
- **FR-10 (U10 — DONE & live-verified; the delegated NURBS face SURVIVES the mixed solid; landed
  2026-07-05, env-gated)** Reconstruct delegation: `services/reconstruct`'s freeform stage optionally
  offloads a single-loop non-planar region to this service's `/fit` (open mode, `iters=0`) when
  `RECONSTRUCT_NURBS_URL` is set; unset ⇒ current `MakeFilling` behaviour, **byte-for-byte unchanged**
  (proven: full reconstruct suite green with the env unset — 133 passed / 4 live-skipped). Implemented
  as `services/reconstruct/app/nurbs_delegate.py` (`delegate_region_face` — submesh→GLB→`/fit`
  submit→poll→result) plus a ~3-line additive hook in `freeform.py`'s `freeform_region_face`.
  **Face construction (U10-D3, the SPEC-7 §4.3 p-curve route):** reconstruct reuses the fitted NURBS
  *surface* (`BRep_Tool.Surface` of the returned STEP) but rebuilds the face **boundary** from the
  region's mesh polyline — one straight 3D edge per rim segment, byte-identical to the faceted/planar
  neighbour's shared edges, each carrying a degree-1 p-curve on the surface (`UpdateEdge` →
  `MakeFace(surface, wire)` → `SameParameter` → `ShapeFix_Face`, validity-gated). So the delegated
  face is **edge-coincident** with its neighbours (not merely point-coincident), and it **sews**:
  `fitted_shape` keeps the freeform-enhanced solid. **Live-verified (U10.2/U10-D3):** on a domed part
  the delegated NURBS face survives sewing — `is_solid=True, is_valid=True, freeform_faces=1,
  free_edges=0`, volume within 2.6% of the mesh; rim point-coincidence ~7.8e-10, interior error
  ~3.7e-7. Attribution confirmed decisively — with the local `MakeFilling` builder disabled, a
  freeform face still survives, so it is provably the delegated one. **This closes SPEC-7's §D-3
  surface-intersection/sagitta tail for reconstruct's delegated freeform regions.** **Fail-safe:** any
  failure (unset/unreachable/failed/timeout/unbuildable-or-invalid face) → `None` → `MakeFilling`,
  never raising. Tests: `tests/test_nurbs_delegate.py` (10, injected-fake HTTP) +
  `tests/test_nurbs_delegate_live.py` (5, live survival). (`docs/specs/SPEC-7` r4 revision + §4.2/FR-5/
  §4.3/§D-3/R6.5 delegation notes ADDED 2026-07-05, cross-referencing this FR.)

## 4. Non-functional requirements

- **NFR-1 Deterministic** — no RNG (D-10): same input + same code + same machine/MLX version → the
  same JSON/STEP within float tolerance. Tests assert tolerances, not bitwise equality (float32 GPU
  reduction order is not bitwise-stable across MLX versions — stated honestly, not hidden).
- **NFR-2 Real fitting, no stubs** — tests assert genuine Chamfer improvement from real M4-Max runs:
  gradient refinement beats its LSQ init, and the fitted patch beats a faceted baseline on the
  organic fixtures. Full-quality configs documented, not run in CI (nerf NFR-2 pattern).
- **NFR-3 Two-precision policy (D-9)** — basis/eval/losses float32 GPU (`mx.compile`d); LSQ solves
  and final OCCT-tolerance validation float64 on the CPU stream. Known MLX constraints are designed
  around, not discovered later: no `linalg.lstsq` (normal equations + Cholesky), linalg is
  CPU-stream-only, no `searchsorted` (vectorized comparison-sum span lookup), scatter is
  non-deterministic (gather+matmul formulations only).
- **NFR-4 Local-first** — conda env, no egress, no telemetry; **deploy is out of scope** (MLX
  requires Apple-Silicon Metal — same local-only stance as capture/nerf; `.dockerignore` is filled
  for parity but no Dockerfile ships in v1).
- **NFR-5 Honest scope** — NURBS smooths: sharp-edged mechanical parts belong to reconstruct's
  analytic path, and the report's `max_deviation` exposes rounding of sharp features; genus ≥ 1
  inputs are rejected with a clear error (out of scope §10); the client labels faceted fallbacks.

## 5. Architecture

### 5.1 Pipeline

```text
GLB bytes
  → meshio.load_mesh          trimesh; scenes concatenated (reconstruct precedent)
  → meshio.analyze            boundary loops + Euler characteristic → mode auto-detect
  → param.parameterize        open:  harmonic (cotangent-Laplacian) disk → unit square
                              closed: cube-map 6-chart layout + shared boundary polylines
  → core.fit_lsq              per patch: scattered-data LSQ (float64 CPU)
                              boundary-curve interpolation constraints (FR-3/FR-4)
  → core.fit_grad             optional: mx.value_and_grad refine control points
                              (Chamfer + Laplacian fairness, parameter-correction rounds)
  → schema.validate           knot laws, grid dims, weights, degree bounds (§6.2)
  → occ_step                  JSON → Geom_BSplineSurface → faces → sew → solid attempt
                              → verify closure → STEP (subprocess-isolated)
  → result                    { step, surfaces, report } · faceted fallback on any gate failure
```

### 5.2 Modules (`services/nurbs/app/`)

| Module | Responsibility |
|---|---|
| `core/basis.py` | A2.1 `FindSpan` (vectorized comparison-sum — MLX has no `searchsorted`), A2.2 `BasisFuns`, A2.3 `DersBasisFuns`; pure `mlx.core` |
| `core/eval.py` | tensor-product surface eval A3.5 / rational A4.3 (homogeneous coords + perspective divide), rational derivatives A4.4, **design-matrix builder** (gather → matmul — evaluation becomes batched matmuls) |
| `core/knots.py` | clamped knot vectors, averaging placement Eqs. 9.68/9.69 (Schoenberg–Whitney ⇒ positive-definite normal equations), insertion A5.1/A5.3, refinement A5.4/A5.5, **compact(OCCT)↔flat(textbook) conversion** |
| `core/params.py` | chord-length / centripetal parameterization (Eqs. 9.4–9.6); Newton point projection/inversion (NURBS Book §6.1) for parameter correction + deviation metrics |
| `core/fit_lsq.py` | scattered-data least squares `(BᵀB + λLᵀL)P = BᵀQ` (control-net Laplacian fairness `L`), boundary/endpoint interpolation constraints; float64, CPU stream, Cholesky |
| `core/fit_grad.py` | `mx.value_and_grad` refinement of control points (Chamfer + fairness), `mx.compile`d step, alternating parameter-correction rounds; fixed budget, best-iterate-wins **by Chamfer** (the pipeline's best-of-init-or-refined on projection deviation is what enforces FR-2's "never worse than init" on the reported metric); grad-target stride-capped for memory, n_grid auto-scales |
| `core/losses.py` | chunked bidirectional Chamfer (O(N·M) memory guarded), RMS/max deviation, SCD (StepForge Eqs. 1–3) |
| `param.py` | mesh uv-parameterization: harmonic map (cotangent Laplacian, scipy sparse — deterministic) for disk regions; cube-map 6-chart layout + shared boundary polylines for closed genus-0 |
| `boundary.py` | closed-mode **shared boundary-curve fitting** (FR-4/R-1, U7.2 — the watertight-by-construction lever): `fit_boundary_curve` (A9.6 endpoint-interpolating curve LSQ on data-independent `clamped_uniform` knots, second-difference fairness so even a 2-vertex mesh edge solves), `fit_shared_curves` (fit each shared polyline once into a `polyline_index → (control_points, knots)` table), `pin_chart_rims` (map a chart's four polylines onto `fit_scattered`'s `u0`/`u1`/`v0`/`v1` rim keys) — both incident patches pull the same table entry, so the shared rim is identical |
| `meshio.py` | GLB loading (trimesh), boundary-loop/genus analysis, mode auto-detection |
| `schema.py` | NURBS-surface JSON model + invariant validation (§6.2) |
| `occ_step.py` | JSON → `Geom_BSplineSurface` → `BRepBuilderAPI_MakeFace` → `Sewing` → solid attempt → verify → STEP. Public seams: `surfaces_to_step`/`surfaces_json_to_step` (open single-face), `surfaces_to_solid_step`/`surfaces_json_to_solid_step` (closed all-NURBS solid) + `assemble_verified_solid` — the single shared sew → `MakeSolid` → `OrientClosedSolid` → verify (`NbFreeEdges==0`/`IsValid`/volume) chain the U7 gate **and** the faceted fallback both reuse — and `build_bspline_surface`. **D0/D1 sample-parity round-trip** (MLX eval vs OCCT eval) as a self-check; OCCT calls subprocess-isolated (native segfaults are recoverable — StepForge pattern) |
| `occ_pool.py` | spawn-context crash-isolated worker runner (StepForge pattern, Apache-2.0): `run_isolated(fn, …)` executes a module-level callable in a fresh spawn process per call — `occ_step.py` runs every OCCT conversion through it so a native segfault/hang is a failed job, never a dead service (§7) |
| `faceted.py` | **FR-5/FR-8 faceted fallback** (U7.4): per-triangle planar OCC faces (`faceted_faces`, reconstruct's `MakePolygon` → `MakeFace` pattern) + `assemble_mixed_solid`/`mixed_solid_worker` — a mixed fitted-NURBS + faceted solid assembled through `occ_pool.run_isolated`, reusing `occ_step.assemble_verified_solid`/`build_bspline_surface` so the sew→verify chain is not duplicated. A patch that misses `fidelity_tol` (or whose fit/schema fails) is replaced, never dropped — the service always returns a valid STEP |
| `pipeline.py` | **open-mode** orchestration (FR-3): GLB → `meshio` → `param` harmonic map → `fit_scattered` (+ optional `fit_grad` refine, FR-2) → `schema` → isolated `occ_step` → STEP + FR-9 report (rms/max via `params.deviation`, chamfer/scd via `core/losses`); `fit_open` is the fitting entrypoint, `fit(payload)` a §6.1 dict adapter exercised by the tests (`main._load_pipeline_fit` base64-decodes and calls `fit_open`/`fit_closed` directly) |
| `pipeline_closed.py` | **closed-mode** orchestration (FR-4, the U7.3 gate): GLB → `meshio` → `param.cube_map_charts` → `boundary.fit_shared_curves`/`pin_chart_rims` → per-chart `fit_scattered` (rims pinned to shared curves) → 6 `schema` surfaces → `occ_step.surfaces_json_to_solid_step` (sew → `MakeSolid` → `OrientClosedSolid` → verify `NbFreeEdges==0`/`IsValid`/volume) → watertight all-NURBS STEP **solid** + FR-9 report; `fit(payload)` adapter mirrors `pipeline.py` |
| `jobs.py` | in-memory `JobStore` — states `{queued, running, completed, failed}`, TTL + max-count eviction, `running_count()` cap (capture/reconstruct `app/jobs.py` shape) |
| `main.py` | FastAPI submit→poll (§6.1): `NURBS_API_KEY` bearer auth (unset ⇒ open dev default), `NURBS_CORS_ORIGINS`, `NURBS_MAX_CONCURRENT_JOBS`, input caps as pydantic bounds, heavy work via `asyncio.to_thread`, startup config log that never prints the key |
| `logging_setup.py` | `NURBS_LOG_LEVEL` logger setup (nerf pattern: single handler, idempotent) |

Scaffolding (U0): `pyproject.toml` (`plastiq-nurbs`, `requires-python >= 3.11`, pytest/ruff blocks —
nerf's shape), `environment.yml` (`name: plastiq-nurbs`, conda-forge: `python=3.11 numpy scipy
trimesh pythonocc-core fastapi uvicorn pydantic httpx pytest pip`; pip: `mlx`, `geomdl` — the MIT
test oracle), `.gitignore`/`.dockerignore` (nerf's contents), README in the nerf format.

### 5.3 Numerics policy (MLX constraints, designed-in)

- **float64 is CPU-only in MLX; `mlx.core.linalg` has no `lstsq` and its LAPACK-backed ops run on
  the CPU stream** → all LSQ solves use explicit normal equations + `cholesky`/`solve` with
  `stream=mx.cpu` at float64 (or numpy — the boundary is `core/fit_lsq.py` either way). Unified
  memory makes the GPU↔CPU mix cheap.
- **No `searchsorted`** → span lookup is `clip(sum(u[:,None] >= knots[None,p:n+1], 1) + p - 1, p, n)`
  — O(m·n) but fused by `mx.compile`.
- **Scatter is non-deterministic with duplicate indices** → the hot path is gather+matmul only
  (design matrix × control points).
- **Lazy eval**: one `mx.eval()` per optimizer step; no Python control flow on array scalars inside
  the loop; `mx.compile` with bucketed shapes (patch grids are fixed per job).

### 5.4 Fitting method (the algorithms, by the book)

1. **Parameterize**: open — harmonic map of the region to the unit square (boundary by chord length,
   Eq. 9.5; centripetal Eq. 9.6 available for clustered data); closed — cube-map charts with shared
   boundary polylines, each chart's harmonic map pinning the four uv-square corners at the chart's
   **four junction vertices** (`harmonic_disk_map_pinned`) so every shared polyline is exactly one uv
   side (the R-1 watertightness lever; requires 4-valent charts + a uniform `(n, n)` grid/degree
   across charts, else faceted fallback per FR-5). (The raw dominant-normal partition + harmonic map
   alone leaves flipped/zero-area uv "ears", so a deterministic **correct-or-raise** chart-repair
   pass — minor-component merge, majority smoothing, junction dissolution — runs first, emitting only
   zero-defect, zero-flip disk charts; the repair gate checks the quarter-arc map, and the emitted
   junction-pinned map's flip-freeness is re-checked once before emission.)
2. **Knots**: clamped, interior knots by averaging (Eqs. 9.68/9.69) so every span contains ≥ 1
   parameter value (positive-definite, banded normal equations).
3. **LSQ init** (per patch): scattered-data least squares on the design matrix from `core/eval` —
   the generalization of A9.6/A9.7 to unstructured (u,v) samples — with Tikhonov/Laplacian fairness
   `λLᵀL` against wrinkling in data-sparse spans, and equality constraints pinning the rim to the
   shared boundary curves (FR-3/FR-4).
4. **Gradient refinement**: minimize `ChamferBidir(S(u,v; P), mesh vertices) + λ_fair·Laplacian(P)`
   over control points `P` via Adam on `mx.value_and_grad` (NURBS-Diff's recipe, BSD-3, minus its
   random init — D-10), alternating with Newton parameter-correction (§6.1) rounds; optional
   Hausdorff term for max-error control; fixed budget, best iterate wins.
5. **Refine capacity, not knots**: if the accuracy gate fails, step the control grid up
   (A5.4/A5.5 knot refinement of the *fitted* surface as warm start) and re-refine — the
   ParSeNet-style coarse→fine schedule — before falling back to faceted (FR-5). Knot/weight
   *optimization* is out of scope (§10).

## 6. Data contracts

### 6.1 Service wire contract (frozen — the API U8 implements, `@plastiq/nurbs` consumes)

Mirrors capture/nerf exactly (same `/jobs/{id}/…` polling shape).

| Method & path | Request | Response |
|---|---|---|
| `POST /fit` | `{ glb_base64: string, mode?: "auto"\|"open"\|"closed", degree?: int (default 3, 2..8), grid?: int (control points per direction, default 16, 4..64), iters?: int (default 200, 0..2000; 0 ⇒ LSQ only), fidelity_tol?: float (> 0) }` | `{ id: string, state: string }` |
| `GET /jobs/{id}/status` | — | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET /jobs/{id}/result` | — | `{ step: string, surfaces: Surfaces (§6.2), report: Report (FR-9) }` (200 when completed; 409 if not; 500 if failed; 404 unknown id) |
| `DELETE /jobs/{id}` | — | 204 (job dropped; in-flight worker's result discarded); 404 unknown id |
| `GET /health` | — | `{ status, service }` |

**Auth.** `NURBS_API_KEY` set ⇒ `POST /fit` + `DELETE /jobs/{id}` require `Authorization: Bearer
<key>`, 401 without; unset ⇒ open (dev default). The client sends the header on every request when
a key is configured (`NurbsOptions.apiKey` ← persisted `nurbsApiKey` setting, panel field
`settings-nurbs-key`) — the SPEC-11 §5 auth model verbatim.

**Client.** `packages/nurbs` (`@plastiq/nurbs`, net-new, mirroring `packages/nerf` file-for-file):
`fitNurbs(input, opts)` → POST → poll → result; `DEFAULT_BASE_URL = "http://localhost:8003"`;
`NurbsOptions = { baseURL?, apiKey?, fetchImpl?, signal?, pollIntervalMs?, maxPolls?, delay?,
onState? }`; snake_case wire → camelCase; types decoupled from the app's doc model (dependency
direction app → package, never reverse). **U8 must not diverge from this table** without updating
the client + this spec together.

### 6.2 NURBS-surface JSON (`surfaces`)

NURBGen-shaped (`ref/NURBGen/src/nurbs_representation/model/Bspline.py` is the shape reference —
schema only, no code), **plus the validation NURBGen lacks**:

```jsonc
{
  "surfaces": [
    {
      "poles":      [[[x, y, z], "..."], "..."],  // num_u × num_v control points, metres (D-4 unit convention of SPEC-7)
      "weights":    [],                            // [] ⇒ non-rational (all 1.0); else num_u × num_v, all > 0
      "u_knots":    [0.0, 0.5, 1.0],               // COMPACT form: unique values, strictly increasing
      "v_knots":    [0.0, 1.0],
      "u_mults":    [4, 1, 4],                     // per-knot multiplicities (parallel to u_knots)
      "v_mults":    [4, 4],
      "u_degree":   3, "v_degree": 3,
      "u_periodic": false, "v_periodic": false
    }
  ]
}
```

Invariants (`schema.py` enforces before OCCT; violations are a job `failed`, never a crash):

1. `len(u_knots) == len(u_mults) >= 2`, knots strictly increasing (likewise v).
2. Non-periodic: `sum(u_mults) == num_poles_u + u_degree + 1` (the knot-count law); ends clamped
   (`mult == degree + 1`); interior `1 <= mult <= degree`.
3. `poles` (and `weights` when present) rectangular `num_u × num_v`; weights strictly positive.
4. `2 <= degree <= 8` on export (OCCT's hard ceiling is 25; interop favors ≤ 8 —
   `GeomAPI_PointsToBSplineSurface`'s own DegMax default).
5. Wire knots are **compact** (OCCT/NURBGen form); the core computes on **flat** (textbook/geomdl)
   vectors; `core/knots.py` converts at the boundary — the silent-breakage footgun, named.

These satisfy both the `Geom_BSplineSurface` constructor and STEP
`b_spline_surface_with_knots`/`rational_b_spline_surface` WHERE rules with zero conversion.

## 7. Boundaries & failure modes

| From | To | Mechanism | Failure handling |
|---|---|---|---|
| browser `nurbs.ts` | service | HTTPS submit+poll (`nurbsBaseURL`, self-host) | HTTP 4xx/5xx detail surfaced; `maxPolls` timeout; failed job → message |
| service | MLX core | in-proc (`asyncio.to_thread`) | fit exceptions → job `failed`; per-patch gate failure → faceted fallback (FR-5) |
| service | OCCT (`occ_step.py`) | **spawn-context subprocess** | native segfault/exception → recoverable → job `failed` or faceted fallback, never a dead service |
| service STEP | kernel `importStep` | STEP text via `data.step` | invalid STEP → rebuild error flagged on the feature (reconstruct precedent) |
| reconstruct (U10) | service `/fit` | HTTP, `RECONSTRUCT_NURBS_URL` env (unset ⇒ off) | unreachable/failed → reconstruct's own `MakeFilling`/faceted path, unchanged |

## 8. Milestones

Prefix **U** (the surface parameter). U7 is the identity gate, like SPEC-7's R6.4a cylinder spike.

| Milestone | Scope | Status |
|---|---|---|
| **U0** | ADR-0012 + scaffold fill: `pyproject.toml`, `environment.yml`, `.gitignore`/`.dockerignore`, README (nerf format); register `nurbs:plastiq-nurbs:services/nurbs:8003` in `scripts/dev-services.sh` + update its and the `justfile`'s "three services" comments; conda env created, `mlx`+`geomdl`+`pythonocc-core` importable | ✅ |
| **U1** | MLX basis/eval core (`core/basis.py`, `core/eval.py`) incl. rational; geomdl + scipy oracle-parity tests | ✅ |
| **U2** | `core/knots.py` + `core/params.py` + `schema.py`: knot ops, compact↔flat, Newton projection, validation invariants | ✅ |
| **U3** | `core/fit_lsq.py`: gridded + scattered LSQ with fairness + boundary constraints on analytic fixtures (hemisphere patch, saddle, wavy grid); float64 CPU; accuracy asserts vs known surfaces | ✅ |
| **U4** | `param.py` + `meshio.py`: harmonic disk parameterization, GLB ingestion, boundary-loop/genus mode detection | ✅ |
| **U5** | `core/fit_grad.py` + `core/losses.py`: `mx.compile`d Chamfer+fairness refinement with parameter correction; **real M4-Max test: refinement beats LSQ init on an organic fixture** (NFR-2) | ✅ |
| **U6** | `occ_step.py`: JSON → `Geom_BSplineSurface` → STEP; MLX-vs-OCCT D0/D1 round-trip parity; subprocess isolation; open-mode single-patch STEP for a domed region | ✅ |
| **U7** | **Closed mode (GATE) — ✅ PASSED.** genus-0 blob → cube-map 6-patch shared-boundary fit → sewn **watertight NURBS solid**, closure verified — the organic case reconstruct documents as impossible. `fit_closed(blob.glb)`: `is_solid=True`, `is_valid=True` (`BRepCheck_Analyzer`), `free_edges=0` (`Sewing.NbFreeEdges`), volume 4.38 vs mesh 4.25 (+3.1%, NURBS smooths coarse facets), re-imports as 1 closed solid / 6 `B_SPLINE_SURFACE_WITH_KNOTS` faces; holds at grid 8/12/16. `app/pipeline_closed.py` + `occ_step.surfaces_json_to_solid_step`. | ✅ |
| **U8** | FastAPI service (`jobs.py`, `main.py`, `logging_setup.py`) per §6.1 + **real submit→poll→result API test** (`httpx.ASGITransport`, no mocks) + auth/CORS/caps tests | ✅ |
| **U9** | `@plastiq/nurbs` + `apps/plastiq/src/ai/nurbs.ts` + settings (`nurbsBaseURL`/`nurbsApiKey`) + GenerationPanel action → `stepToImportDocument` → `importStep`; browser E2E (skips when service unreachable — `reconstruct.spec.ts` precedent) | ✅ |
| **U10.1** | Reconstruct delegation (FR-10): freeform stage → `/fit`, `RECONSTRUCT_NURBS_URL`-gated (`nurbs_delegate.py` + additive `freeform.py` hook); both-ways regression tests; full reconstruct suite green with env unset. | ✅ |
| **U10.2** | Live cross-service test (real nurbs :8003 ← reconstruct, 5 tests): the service fits the region + reconstruct rebuilds a valid face. | ✅ |
| **U10-D3** | Delegated NURBS face SURVIVES the mixed solid: mesh-polyline-boundary p-curve trim → edge-coincident with faceted neighbours → sews. Live: `freeform_faces=1, free_edges=0`, valid solid (attribution confirmed with local MakeFilling disabled). Closes SPEC-7 §D-3 for delegated freeform regions. | ✅ |

**Exit criteria:** a closed organic mesh fixture → a watertight all-NURBS STEP solid that imports
via `importStep` in the running app; oracle-parity suites green; the real API test green; U7 gate
passed; zero regressions in the reconstruct (93), nerf (53), capture, and plastiq suites.

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Multi-patch watertightness** — independently fitted neighbours deviate ≫ the 1e-6 sew tol (SPEC-7 D-3's sagitta lesson, the make-or-break). | Shared **fitted boundary curves interpolated by construction** (constrained LSQ rims), not sew-by-tolerance; U7 gate before service/client investment; faceted fallback (FR-5). |
| R-2 | **MLX numerics** — no `lstsq`, CPU-only linalg, float64 CPU-only, no `searchsorted`, non-deterministic scatter. | Designed in from day one (§5.3, D-9): normal equations + Cholesky on CPU, gather+matmul formulations, knot placement guaranteeing conditioning, fairness regularization. |
| R-3 | **Parameterization distortion** (elongated/high-curvature regions → skewed uv → wrinkled fits). | Centripetal option + parameter-correction rounds + fairness term; capacity ladder (§5.4-5); accuracy gate → fallback. |
| R-4 | **OCCT native crashes** on exotic surface parameters kill the worker. | `schema.py` validates first; OCCT runs subprocess-isolated (StepForge pattern) — a segfault is a failed job, not a dead service. |
| R-5 | **Sharp features get smoothed** — NURBS rounds edges; users feed mechanical parts to the wrong service. | Honest scope (NFR-5): report `max_deviation` exposes it; docs + client copy route mechanical meshes to reconstruct; delegation (U10) makes routing automatic later. |
| R-6 | **Chamfer memory** O(N·M) on dense meshes. | Chunked distance computation (`core/losses.py`); pydantic input caps in `main.py`. |
| R-7 | **License hygiene** — NURBGen has no license; Point2CAD is CC-BY-NC; ParSeNet architecture only. | Schema-shape/ideas only, zero code copying; liftable code limited to Apache-2.0 StepForge patterns + BSD-3 NURBS-Diff recipe; geomdl (MIT) is a test-only dep. Recorded here + in ADR-0012. |

## 10. Out of scope (v1)

- **Text→NURBS generation** — SPEC-6 owns generation. (The §6.2 schema is deliberately
  forward-compatible: a later `POST /build` accepting LLM-emitted surface JSON would reuse
  `schema.py` + `occ_step.py` unchanged, but it is not in this spec's milestones.)
- **Genus ≥ 1** inputs (torus-like) — rejected with a clear error; only disk-topology (open) and
  genus-0 closed meshes in v1.
- **Trimmed-surface fitting** — patches are untrimmed rectangles; trim loops stay topological
  (OCCT faces), per the STEP/OCCT convention. NURBGen's trim-loop JSON fallback is not adopted.
- **Knot/weight optimization** — fixed clamped knots, non-rational default (D-8); capacity comes
  from grid refinement (§5.4-5), not knot optimization (LSPIA/Full-LSPIA noted as future options).
- **Multi-region segmentation** — v1 fits whole meshes (open/closed modes); regions arrive
  pre-segmented via U10 delegation, not via own segmentation.
- **Deploy / hosting / Docker** — MLX is Apple-Silicon-only; local-only like capture/nerf (NFR-4).

## 11. References

- Piegl & Tiller, *The NURBS Book*, 2nd ed. — A2.1–A2.3 (basis), A3.5/A4.3/A4.4 (eval), A5.1–A5.10
  (knot ops/degree), §6.1 (projection), §9.2/9.4 + Eqs. 9.4–9.6, 9.68/9.69, A9.6/A9.7 (fitting).
- NURBS-Diff: arXiv 2104.14547, github.com/anjanadev96/NURBS_Diff (BSD-3) — differentiable fitting
  recipe (Chamfer + Laplacian, control-point gradients). ParSeNet: arXiv 2003.12181 (SplineNet
  architecture, coarse→fine). Point2CAD: arXiv 2312.04962 (CC-BY-NC — fit-then-intersect ideas only).
  LSPIA/Full-LSPIA (future knot/weight optimization option).
- geomdl (NURBS-Python, MIT) — primary algorithm oracle; scipy `BSpline`/`NdBSpline` — non-rational
  oracle; OCCT `Geom_BSplineSurface` + `GeomAPI_PointsToBSplineSurface` — boundary ground truth.
- MLX docs (linalg, lazy eval, compile, transforms, indexing) + issues #1255 (no searchsorted),
  #1238/#847 (CPU-only linalg), #1905 (float64 CPU-only).
- ISO 10303-42 `b_spline_surface_with_knots` / `rational_b_spline_surface` WHERE rules; OCCT refman
  `Geom_BSplineSurface` constructor constraints (MaxDegree 25).
- Repo: SPEC-7 (§D-3 sagitta, FR-7 closure checks, R-3 organic caveat), SPEC-11 (service/client
  template), `services/reconstruct/app/freeform.py:1-18` (the gap, verbatim),
  `docs/audits/Expanse.md:183-197` (NURBGen verdict), `ref/NURBGen/src/nurbs_representation/`
  (schema shape), `ref/StepForge/reward/{scd_reward,step_to_pointcloud}.py` (Apache-2.0 liftables),
  `scripts/dev-services.sh` (port registry).
