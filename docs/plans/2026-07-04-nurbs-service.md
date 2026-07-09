# Plan — `services/nurbs/` : the modular MLX NURBS surface-fitting service (SPEC-12)

**Date:** 2026-07-04
**Spec:** `docs/specs/SPEC-12-nurbs-service.md` (identity decisions locked by the user 2026-07-04) ·
**ADR:** `docs/adr/0012-nurbs-service-architecture.md` — authored in U0.1
**Source ideas:** Piegl & Tiller *The NURBS Book* (algorithms, by number); NURBS-Diff (BSD-3 —
differentiable-fitting recipe); ParSeNet (architecture only); Point2CAD (CC-BY-NC — ideas only);
NURBGen (no license — JSON-schema shape only); StepForge (Apache-2.0 — SCD + subprocess isolation).
Memory: [[nurbs-service-spec]], [[mlx-m4max-ml-milestones]].
**Execution:** **subagent per task + two-stage review** (user, this session) — one fresh subagent per
task briefed with SPEC-12 + this plan + the task's oracle expectations; after each task (1) the owner
reads the full diff and independently verifies red→green + suite state, (2) an independent review agent
reviews the task's files; findings fixed before the next task. Owner is responsible for every line
(CLAUDE.md sub-agent rules); tasks run in **dependency-ordered waves of up to 5 parallel agents**
(user directive 2026-07-04, superseding the original sequential mode) — every wave's tasks have
provably disjoint file assignments, and the owner verifies each wave (diff read + suite run +
review agents) before the next wave launches. True dependencies bound many waves below 5.
**Test discipline:** **strict TDD** — every task's failing test written and seen red before
implementation code; subagent reports must show the red run; owner re-runs green.
**Commit:** conventional commits, one per **sub-milestone at green** — **ask before committing**.
**Decisions locked (SPEC-12 D-1..D-10):** mesh→NURBS fitting identity · own MLX core from the
literature · direct app path v1 (:8003) + reconstruct delegation in U10 · `@plastiq/nurbs` client in
v1 · in-service OCCT (one conda env) · NURBGen-shaped JSON with real validation (compact knots on the
wire, flat internally) · degree-3 clamped non-rational defaults, export degree ≤ 8 · two-precision
policy (f32 GPU gradient / f64 CPU solves) · **no RNG anywhere**.

## Goal

A self-contained, modular **MLX** NURBS service: GLB mesh → uv-parameterization → deterministic
least-squares B-spline fitting + differentiable Chamfer/fairness refinement → validated NURBS-surface
JSON → OCCT `Geom_BSplineSurface` → **STEP** → the app's existing `stepToImportDocument` →
`importStep` path. Closes SPEC-7's documented fundamental gap: a closed organic region "can't be one
filled patch (a whole organic blob stays faceted — a fundamental limit)"
(`services/reconstruct/app/freeform.py:14-17`). Port **:8003**; wire contract frozen in SPEC-12 §6.1.

## Grounding (verified this session)

- **SPEC-12** (this session): modules table §5.2, fitting method §5.4, wire contract §6.1, JSON
  invariants §6.2, milestones U0–U10, U7 gate.
- **The gap** (`services/reconstruct/app/freeform.py:1-18`, read directly): `MakeFilling` single-patch,
  C0 rim, interior-point ladder; closed regions and the sagitta case are the honest open limits.
- **Service conventions** (`services/nerf/` read + SPEC-11): `environment.yml` (conda-forge +
  `pip: mlx`), `app/main.py` auth/CORS/caps/`asyncio.to_thread`, `logging_setup.py`, `JobStore`
  (`{queued,running,completed,failed}`, TTL 1800s + max 64, `running_count()`), real
  `httpx.ASGITransport` API tests, `pytest.importorskip` gating.
- **Ports** (`scripts/dev-services.sh:19-24`, `justfile:80-91`, read directly): reconstruct :8000,
  capture :8001, nerf :8002 — registry tuples `name:env:dir:port`; **:8003 is free**; both files'
  "three services" comments must become "four" when nurbs registers.
- **Scaffold state**: `services/nurbs/{pyproject.toml,.dockerignore,.gitignore}` are 0-byte,
  `README.md` is the one-line title, `app/`+`tests/` empty dirs. **Fill, never delete**
  ([[empty-scaffold-files-are-intentional]]).
- **MLX constraints** (researched + cited in SPEC-12 §5.3): no `linalg.lstsq`; linalg LAPACK ops
  CPU-stream-only; float64 CPU-only; no `searchsorted`; scatter non-deterministic → gather+matmul.
  MLX 0.31 arm64 proven in the nerf/capture envs.
- **Oracles**: geomdl (MIT, pip — cites the same Piegl & Tiller algorithm numbers), scipy
  `BSpline`/`NdBSpline` (non-rational), OCCT `Geom_BSplineSurface` D0/D1 (boundary ground truth).
- **Client precedent** (`packages/nerf/` + SPEC-11 FR-7/N11): package shape, submit→poll client,
  snake→camel mapping, `apps/plastiq/src/ai/nerf.ts` adapter, settings fields, structural
  reachability, coverage barrel-exclude.

## Licensing & MLX rule

- **Zero code copying** from NURBGen (no license), Point2CAD (CC-BY-NC), ParSeNet; NURBS-Diff (BSD-3)
  and StepForge (Apache-2.0) patterns may be reimplemented with attribution in ADR-0012/README.
- **MLX-native, not a port** (binding directive): basis/eval/fitting are `mlx.core`/`mlx.nn`;
  numpy/scipy only at boundaries (GLB parse, sparse harmonic solve, OCCT hand-off). geomdl is a
  **test-only oracle** — never imported by `app/` code.

## Honest prerequisites / scope

- **`pythonocc-core` + `mlx` in ONE env is new** (reconstruct has OCCT, nerf/capture have MLX, nobody
  has both). U0.3 proves the combined env **before any code**. If conda cannot solve it, STOP and
  re-plan (options: pin versions; move OCCT fully behind the spawn-subprocess boundary with its own
  env) — do not silently deliver a broken env.
- **Fitting quality is bounded by parameterization** (harmonic-map distortion on elongated regions)
  and by the no-knot-optimization scope; the accuracy gate + faceted fallback (FR-5) keep every
  result a valid STEP. Genus ≥ 1 rejected with a clear error. Sharp features smooth — mechanical
  meshes stay reconstruct's job (NFR-5).
- **Real-but-small fitting in tests**: small control nets (≈16×16), few hundred refine iters —
  seconds on the M4 Max; asserts are genuine Chamfer/deviation improvements (no stubs, NFR-2).
  Full-quality configs documented, not run in CI.

---

# Milestones (MLX core → fitting → OCCT → gate → service → client → delegation → docs)

## U0 — ADR + scaffold fill + the combined env (proves D-6 before any code)
- [x] **U0.1 — ADR-0012** ✅ authored, Status: Accepted (`docs/adr/0012-nurbs-service-architecture.md`, ADR-0011's header format):
      identity/differentiator (fitting, not generation; resolves the Expanse "already-covered"
      verdict), license ledger, two-precision policy, subprocess-isolated OCCT, port :8003, no-RNG
      determinism. Tier T2 (self-hosted Python) · Framework MLX.
- [x] **U0.2 — Fill the scaffold** ✅ scaffold filled + root README tree line/note updated (0-byte files get content; nothing deleted): `pyproject.toml`
      (`plastiq-nurbs`, `requires-python >= 3.11`, pytest `testpaths=["tests"]` `addopts="-q"`
      `pythonpath=["."]`, ruff `line-length=110` — nerf+reconstruct shape), `environment.yml`
      (`name: plastiq-nurbs`; conda-forge: `python=3.11 numpy scipy trimesh pythonocc-core fastapi
      uvicorn pydantic httpx pytest pip`; `pip: [mlx, geomdl]`), `.gitignore`/`.dockerignore` (nerf
      contents), `README.md` (nerf format: SPEC-12/ADR-0012 links, architecture map, §6.1 API table,
      run/test sections, honest scope), `app/__init__.py` + `app/core/__init__.py` +
      `tests/__init__.py`. **Same change:** root `README.md` — remove `services/nurbs` from the
      empty-scaffolding note (`README.md:50-51`) and add the tree line
      `services/nurbs   optional MLX NURBS surface-fitting service (SPEC-12)`.
- [x] **U0.3 — Env + registry.** ✅ combined env solves (mlx + geomdl + OCCT importable together); `nurbs:plastiq-nurbs:services/nurbs:8003` registered in `scripts/dev-services.sh` + justfile. Create the env (`mamba env create -f environment.yml`); prove
      `import mlx.core`, `import geomdl`, `from OCC.Core.Geom import Geom_BSplineSurface`, and a
      1-line MLX op **in the same interpreter**. Register
      `nurbs:plastiq-nurbs:services/nurbs:8003` in `scripts/dev-services.sh` + update its and the
      `justfile`'s "three services" comments to four (ports list `:8000/:8001/:8002/:8003`).
      `just services` brings all four up (`/health`-gated) — verified live.

## U1 — MLX basis + eval core (oracle parity)
- [x] **U1.1 — TDD `core/basis.py`** ✅ geomdl/scipy basis parity green: `find_span` (vectorized comparison-sum + clip — no
      `searchsorted`), `basis_funs` (A2.2, batched), `ders_basis_funs` (A2.3, k ≤ 2). Tests (red
      first): parity vs geomdl `helpers.find_span/basis_function/basis_function_ders` and scipy
      `BSpline.design_matrix` on fixed hand-written parameter sets + degrees 2/3/5; partition of
      unity; clamped-end values; f64-CPU tol 1e-10, f32-GPU sanity tol 1e-4.
- [x] **U1.2 — TDD `core/eval.py`** ✅ geomdl + exact-rational-cylinder + design-matrix parity green: non-rational surface point (A3.5), rational (A4.3, homogeneous +
      perspective divide), first derivatives (A3.6/A4.4 order 1), and the **design-matrix builder**
      (per-point span gather → dense `B` → eval = `B @ P`). Tests: parity vs geomdl
      `Surface.evaluate_single`/derivatives; an **exact rational quarter-cylinder** (known weights)
      matches the analytic cylinder to 1e-10; `NdBSpline` parity (non-rational); design-matrix eval
      ≡ direct eval.

## U2 — knots, parameterization, schema
- [x] **U2.1 — TDD `core/knots.py`** ✅ geomdl insertion parity + compact↔flat round-trips + eval-invariant refinement green: clamped uniform vectors, averaging placement (Eqs. 9.68/9.69),
      **compact(OCCT)↔flat(textbook) conversion**, insertion (A5.1/A5.3), refinement (A5.4/A5.5).
      Tests: geomdl `insert_knot` parity; conversion round-trips; insertion/refinement leave the
      evaluated surface invariant (eval parity at fixed samples, 1e-10).
- [x] **U2.2 — TDD `core/params.py`** ✅ monotone params + projection recovers (u,v) to 1e-8, beats dense baseline off-surface: chord-length (Eq. 9.5) + centripetal (Eq. 9.6)
      parameterization; Newton point projection (§6.1, grid-seeded, both convergence criteria).
      Tests: monotone params in [0,1]; projecting on-surface points recovers (u,v) to 1e-8;
      off-surface points beat a dense-sampling baseline distance.
- [x] **U2.3 — TDD `app/schema.py`** ✅ valid-fixture matrix passes; every §6.2 invariant violation rejected with its specific error: pydantic surface model + every §6.2 invariant. Tests: a
      valid-fixture matrix and one fixture per violated invariant (knot/mult length mismatch,
      non-increasing knots, knot-count law, unclamped ends, interior mult > degree, ragged poles,
      non-positive weights, degree bounds) → each rejected with its specific error.

## U3 — least-squares fitting (f64, CPU stream)
- [x] **U3.1 — TDD gridded LSQ** ✅ endpoint-exact, max dev < 1e-3 at 16×16, deviation shrinks with net size (A9.6/A9.7 separable path): fit `z = sin(x)·cos(y)` grid samples;
      asserts: endpoint interpolation exact; max deviation < 1e-3 at 16×16; deviation shrinks
      monotonically with control-net size (8→12→16 on a 16×16 sample grid; the net dims must
      satisfy nu ≤ Nu, so growth stops at the grid resolution — corrected from an earlier
      "8→16→24" that violated that constraint).
- [x] **U3.2 — TDD scattered LSQ with fairness + rim constraints** ✅ hemisphere/saddle hit targets, Cholesky-stable, pinned rims to 1e-9, λ>0 reduces Laplacian energy (`core/fit_lsq.py`):
      `(BᵀB + λLᵀL)P = BᵀQ`, control-net Laplacian `L`, boundary rows pinned by elimination to
      given rim curves. Tests: hemisphere-patch + saddle scattered fits hit max/rms deviation
      targets; the normal matrix Cholesky-factors (conditioning via knot placement); pinned rims
      reproduce the boundary curve to 1e-9; λ=0 vs λ>0 — fairness reduces control-net Laplacian
      energy on sparse data without breaking the deviation target.

## U4 — mesh ingestion + harmonic parameterization
- [x] **U4.1 — TDD `app/meshio.py`** ✅ dome→open, blob→closed, torus→NFR-5 reject: GLB load (trimesh, scenes concatenated — reconstruct pattern),
      boundary-loop extraction, Euler-characteristic genus check, mode auto-detect. Fixtures
      (checked-in, tiny, generated by a committed script): `dome.glb` (open disk), `blob.glb`
      (closed genus-0), `torus.glb` (genus 1). Tests: dome→open, blob→closed, torus→rejected with
      the NFR-5 error.
- [x] **U4.2 — TDD `app/param.py` (harmonic disk map)** ✅ boundary lands on square in order, no flipped uv triangles on dome.glb, deterministic: cotangent-Laplacian harmonic map to the
      unit square (boundary chord-length onto the perimeter, corners at cumulative quarters), scipy
      sparse solve. Tests: boundary lands on the square perimeter in order; no flipped uv triangles
      on `dome.glb`; deterministic (two runs identical).

## U5 — losses + differentiable refinement (REAL M4-Max fitting) ⭐
- [x] **U5.1 — TDD `core/losses.py`** ✅ chunked≡unchunked Chamfer, deviation via U2.2 projection, SCD scale-invariant: chunked bidirectional Chamfer (chunked ≡ unchunked test),
      rms/max deviation (via U2.2 projection), SCD (StepForge Eqs. 1–3; scale-invariance test).
- [x] **U5.2 — TDD `core/fit_grad.py`** ✅ real M4-Max run: refined Chamfer beats LSQ init, deterministic, no `mx.random` in `app/`, `iters=0` ⇒ init: Adam (`mlx.optimizers`) on `mx.value_and_grad` over control
      points, `mx.compile`d step, fairness term, alternating parameter-correction rounds,
      best-iterate-wins, `iters=0` ⇒ returns init. **Real M4-Max test:** on a noisy-dome fixture
      the refined Chamfer strictly improves on the LSQ init; deterministic across two runs; no RNG
      anywhere (grep-able: no `mx.random` in `app/`).

## U6 — OCCT boundary (JSON → STEP, isolated)
- [x] **U6.1 — TDD `app/occ_step.py` build** ✅ MLX-vs-OCCT D0/D1 parity 1e-9, STEP re-imports same face count, schema-invalid never reaches OCCT: schema JSON → `Geom_BSplineSurface` (compact knots
      direct) → `BRepBuilderAPI_MakeFace` → STEP text (`STEPControl_AsIs`, raw metre coords — SPEC-7
      D-4 convention). Tests: **MLX-vs-OCCT D0/D1 parity** on a sample grid (1e-9); STEP re-imports
      (`STEPControl_Reader`) with the same face count; a schema-invalid payload never reaches OCCT.
- [x] **U6.2 — TDD subprocess isolation** ✅ hard-crash worker → clean Python-level failure, pool + caller survive, next conversion succeeds (in `app/occ_pool.py`) *(re-scoped 2026-07-04 during execution: the pool lives
      in its own module `app/occ_pool.py` — a generic spawn-context crash-isolated worker pool that
      U6.1's `occ_step.py` consumes — so U6.2 runs independently of U6.1 with disjoint files; the
      SPEC-12 §5.2 table gains the `occ_pool.py` row in the same change)*: OCCT conversion runs in
      a spawn-context worker pool (StepForge pattern). Test: a worker that hard-crashes
      (`os.abort()` behind a test-only hook routed through the same pool path) yields a clean
      Python-level failure — the pool and caller survive; a subsequent good conversion succeeds.
- [x] **U6.3 — TDD open-mode pipeline (no HTTP)** ✅ dome.glb full chain → single-patch STEP; rim dev < 1e-6, FR-9 report populated (`app/pipeline.py`; **same change:** add the
      `pipeline.py` row to SPEC-12 §5.2's module table): `dome.glb` → meshio → param → LSQ →
      refine → schema → STEP single patch. Asserts: rim interpolates the mesh boundary polyline
      (max rim deviation < 1e-6 — the FR-3 sewability property); interior max deviation under the
      default `fidelity_tol`; report fields (FR-9) populated.

## U7 — closed mode: the watertight-blob GATE ⭐
- [x] **U7.1 — TDD cube-map charts** ✅ 6 zero-flip disk charts, every boundary edge shared by exactly 2 charts, junction-pinned harmonic map, correct-or-raise repair (`app/param.py` extension): partition `blob.glb` faces by
      dominant normal into 6 charts; per-chart harmonic map; extract **shared boundary polylines**.
      Tests: every face in exactly one chart; every chart-boundary edge shared by exactly 2 charts
      with identical polylines; charts are disk-topology.
      *Impl note:* the raw dominant-normal partition + harmonic map alone leaves flipped/zero-area
      uv "ears" (staircase faces on chart boundaries), so a deterministic chart-repair pass —
      minor-component merge, majority smoothing, junction dissolution — was added ahead of the
      harmonic map. It is **correct-or-raise**: it emits only zero-defect, zero-flip disk charts or
      raises `ValueError` (backstopped by a 32-iteration cap; convergence is not otherwise proven).
      This is a deviation from the partition + harmonic-map-only sketch above.
      *Impl note (U7.1-rev):* each chart's uv is the **junction-pinned** harmonic map
      (`harmonic_disk_map_pinned`), NOT the open-mode quarter-arc-length placement. The four uv-square
      corners are pinned to the chart's **four junction vertices** so every shared boundary polyline
      (a junction-to-junction arc) maps onto **exactly one uv side** — this is what makes U7.2's
      whole-side rim pinning (`fit_scattered`'s `u0`/`u1`/`v0`/`v1`) watertight by construction, and
      it requires all charts to share a uniform `(n, n)` control grid + degree along their seams.
      It therefore requires **4-valent charts** (exactly 4 junctions per chart, as `blob.glb`'s
      4-regular cube graph is): a non-4-valent chart, or one whose pinned map still flips (a straight
      junction-to-junction ear collapsing onto one side — the square is convex but not *strictly*
      convex), raises `UnsupportedTopologyError` → faceted fallback (FR-5). The repair's flip gate
      still checks the quarter-arc map (intermediate label states aren't 4-valent), so `cube_map_charts`
      re-checks the emitted pinned map's flip-freeness once.
- [x] **U7.2 — TDD shared boundary-curve fitting** ✅ adjacent patches coincide < 1e-9 along the shared line — watertight by construction: fit each shared polyline ONCE (endpoint-
      interpolating curve LSQ, A9.6); adjacent patches take the curve's control points as their
      pinned rim rows (compatible degree/knots along the shared edge). Test: two adjacent fitted
      patches evaluate identically along the shared parameter line (< 1e-9) — watertight **by
      construction**, not by sew tolerance (SPEC-7 D-3's sagitta lesson).
- [x] **U7.3 — TDD the GATE — watertight all-NURBS solid ✅ PASSED**: 6 patches → faces →
      `Sewing(1e-6)` → `MakeSolid` → `OrientClosedSolid`; asserts `NbFreeEdges()==0`,
      `BRepCheck_Analyzer.IsValid()`, positive volume within tolerance of the mesh volume; STEP
      re-imports as a closed solid. **RESULT:** `fit_closed(blob.glb)` → `is_solid=True`,
      `is_valid=True`, `free_edges=0`, volume 4.38 vs mesh 4.25 (+3.1%), 6 `B_SPLINE_SURFACE_WITH_KNOTS`
      faces, 1 closed solid on re-import; holds at grid 8/12/16. Landed in `app/pipeline_closed.py` +
      `occ_step.surfaces_json_to_solid_step`. Gate passed — no re-plan needed.
- [x] **U7.4 — TDD accuracy gate + faceted fallback** ✅ forced-tiny-tol patch → faceted faces, assembled STEP stays valid, `fitted_patches`/`faceted_patches` counted truthfully (in `app/faceted.py`) (FR-5, in `pipeline.py`): per-patch
      `max_deviation` vs `fidelity_tol`; a failing patch (forced via an artificially tiny tol in the
      test) falls back to per-triangle faceted faces; the assembled STEP stays valid; report counts
      `fitted_patches`/`faceted_patches` truthfully.

## U8 — FastAPI service (submit→poll, the frozen §6.1 contract)
- [x] **U8.1 — TDD `app/jobs.py`** ✅ states, TTL + max-count eviction, `running_count()`, unknown-id → None: `JobStore` mirroring capture/reconstruct (states, TTL + max-count
      eviction, `running_count()`); asyncio tests (complete-with-result, failure captures error,
      unknown id → None, eviction).
- [x] **U8.2 — TDD `app/main.py` + `app/logging_setup.py`** ✅ real `httpx.ASGITransport` submit→poll→result for dome+blob (no mocks), bearer auth/CORS/caps/409/404, key never logged: SPEC-12 §6.1 verbatim (`POST /fit`
      params + bounds, status/result/delete/health, 200/409/500/404), `NURBS_API_KEY` bearer
      (401 tests; unset ⇒ open), `NURBS_CORS_ORIGINS`, `NURBS_MAX_CONCURRENT_JOBS`, pydantic input
      caps, `asyncio.to_thread`, startup config log that never prints the key. **Real
      submit→poll→result API tests** (`httpx.ASGITransport`, no mocks): `dome.glb` (open) and
      `blob.glb` (closed) end-to-end → `{ step, surfaces, report }`; auth + validation + 409/404
      paths. `just services` brings nurbs up alongside the other three — verified live.

## U9 — `@plastiq/nurbs` + app wiring (REACHABLE — not a tested island)
- [x] **U9.1 — Package scaffold** ✅ `@plastiq/nurbs` picked up by the pnpm `packages/*` workspace, coverage barrel-excluded: `packages/nurbs/{package.json (@plastiq/nurbs), tsconfig.json,
      src/index.ts}` mirroring `packages/nerf`; pnpm `packages/*` workspace picks it up; root vitest
      coverage barrel-exclude (N11.1 precedent).
- [x] **U9.2 — TDD client** ✅ submit→poll, `DEFAULT_BASE_URL = "http://localhost:8003"`, snake→camel report map, Bearer on every request; vitest + typecheck green (`src/{types,client}.ts`): `fitNurbs(input, opts)` submit→poll per §6.1;
      `DEFAULT_BASE_URL = "http://localhost:8003"`; snake→camel result mapping; Bearer on every
      request when `apiKey` set; `NurbsOptions` mirrors `NerfOptions`. Vitest scripted-fetch tests
      (submit→poll→result, failure, timeout, auth header) + `typecheck` green.
- [x] **U9.3 — App wiring** ✅ `apps/plastiq/src/ai/nurbs.ts` adapter, `nurbsBaseURL`/`nurbsApiKey` settings + `settings-nurbs-key` panel field, GenerationPanel action; app tsc + suites green: `apps/plastiq/src/ai/nurbs.ts` adapter (`fitMeshToCad` → STEP →
      existing `stepToImportDocument` → `importStep` feature); `nurbsBaseURL`/`nurbsApiKey` settings
      (+ SettingsPanel field `settings-nurbs-key`); GenerationPanel action alongside "Convert to
      CAD" labeled for smooth/organic meshes. Unit tests mock `fitNurbs` (structural reachability —
      the reconstruct/nerf precedent); app `tsc` + suites green.
- [x] **U9.4 — Browser E2E** ✅ recorded live run: mesh doc → NURBS action → live :8003 → STEP → kernel `importStep` (real OCCT-WASM) → rendered B-rep, `faceCount > 0` on blob.glb (job ~1.74s); skips cleanly when :8003 unreachable (`e2e/plastiq/nurbs.spec.ts`): open a mesh doc → NURBS action → live
      service → STEP → kernel `importStep` (real OCCT-WASM) → rendered B-rep (`faceCount > 0`);
      skips when :8003 unreachable (`reconstruct.spec.ts` precedent). Run it live once and record
      the result in the plan.

## U10 — reconstruct delegation (env-gated, FR-10)
- [ ] **U10.1 — TDD delegation in `services/reconstruct`** ⏸️ **DEFERRED** (not done) — blocked on cross-session safety: `services/reconstruct` currently has ~26 uncommitted files from a concurrent session (incl. `freeform.py`/`fitted.py` that this delegation must edit); env-gated behind `RECONSTRUCT_NURBS_URL` (unset ⇒ current `MakeFilling` unchanged). Resumes when that session commits or on explicit authorization: when `RECONSTRUCT_NURBS_URL` is set, the
      freeform stage offers each single-loop non-planar region to the nurbs service and builds the
      region's face **from the returned §6.2 surfaces JSON locally** (reconstruct already has OCCT —
      no STEP splicing), same mesh-polyline boundary ⇒ sews with neighbours (FR-3 property);
      httpx with timeout; **unset/unreachable/failed ⇒ existing `MakeFilling` path, byte-for-byte
      unchanged** (regression tests both ways). **Same change:** SPEC-7 §4.2/FR-5 note the optional
      delegation; SPEC-12 FR-10/U10 status updated.
- [ ] **U10.2 — Live integration test** ⏸️ **DEFERRED** (not done, with U10.1) (keyed like `RECONSTRUCT_URL` tests): nurbs service up →
      reconstruct fits a domed box with delegation on → freeform face sourced from the fit, solid
      still valid; reconstruct's own 93-test suite green with the env var unset.

## U11 — docs reconciliation (the N12 pattern)
- [x] **U11.1** ✅ (this task, 2026-07-04) — SPEC-12 + ADR-0012 + this plan + root `README.md` + `services/nurbs/README.md` + memory reconciled to shipped state; U0–U9 marked done with real results, U10 deferred; closed-mode 17-key report superset documented; 356-test `plastiq-nurbs` suite green. **Deferred within U11.1 (outside this subtask's permitted files, so not applied):** the `docs/audits/Expanse.md` B3 cross-ref noting SPEC-12 built the fitting capability the audit called absent. Reconcile everything to shipped state: SPEC-12 milestone table + any drifted §5/§6
      details; `services/nurbs/README.md` final API/result fields; root README tree; ADR-0012
      consequences; `docs/audits/Expanse.md` B3 (NURBGen) gets a cross-ref that SPEC-12 built the
      *fitting* capability the audit noted was absent (the verdict itself stands); memory
      [[nurbs-service-spec]] updated to DONE with final test tallies. Re-read every touched doc and
      confirm it reads true (CLAUDE.md).

---

## Cross-cutting completion gate (every task, every milestone)

1. **Strict TDD honored** — the failing test existed and was seen red before code; the subagent's
   report must include the red evidence; the owner re-runs it green.
2. **Two-stage review** — (a) owner reads the full diff and verifies claims against the actual
   code/output (never trust a subagent's summary); (b) independent review agent on the task's files;
   findings fixed before the next task starts.
3. **Real MLX fitting, no stubs** — U5/U7 asserts are genuine improvements from real M4-Max runs.
4. **Suites green, zero regressions** — `services/nurbs` pytest (plastiq-nurbs env) every task; plus
   per-milestone: reconstruct pytest (93) when U10 touches it, `vitest`/`tsc`/`just typecheck`/
   `just lint` when U9 touches TS; full sweep at U11.
5. **Deterministic** — no RNG in `app/`; identical runs → identical JSON within tolerance (tested).
6. **Docs current in the same change** — SPEC-12 milestone statuses flip as they ship; any module/
   contract drift lands in SPEC-12 in the same commit (CLAUDE.md doc-accuracy rule).
7. **Commit per sub-milestone at green** — conventional message — **after asking**.
8. **Subagent hygiene** — one task per agent; disjoint files or worktree isolation for any parallel
   dispatch; the owner owns every line.

## Sequencing rationale

basis → eval → knots/params/schema (U1–U2) is the oracle-verified numerical floor; LSQ (U3) then
ingestion/parameterization (U4) make fitting real on meshes; gradient refinement (U5) is the MLX
headline on that proven floor; the OCCT boundary (U6) turns fits into STEP; **U7 is the gate** — the
watertight organic blob is the service's reason to exist, so it must pass before the service (U8),
client (U9), and delegation (U10) investments. U0.3 front-loads the one environmental unknown
(OCCT+MLX in one env). Docs last (U11), current throughout (gate #6).
