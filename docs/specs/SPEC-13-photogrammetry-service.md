# SPEC-13 — Photogrammetry service (`services/photogrammetry/`, SfM + MVS front-end)

**Status:** Draft (P0 not started — `services/photogrammetry` is the empty scaffold this spec fills)
**Date:** 2026-07-04
**Owner:** LayerDynamics
**ADR:** [`docs/adr/0013`](../adr/0013-photogrammetry-service-architecture.md) (authored in P0.1)
**Plan:** [`docs/plans/2026-07-04-photogrammetry-service.md`](../plans/2026-07-04-photogrammetry-service.md) (authored 2026-07-04, alongside this spec)
**Framework:** MLX (Apple Silicon / M4 Max) for the dense raster math; numpy/scipy for the sparse solvers
**Source ideas:** kornia (Apache-2.0 — the multi-view-geometry algorithms, ported with attribution);
nerfstudio `ns-process-data` (Apache-2.0 — the `transforms.json` emitter shape + COLMAP stage
sequence); Photogrammetry-examples (CC BY-SA docs / GPLv3 scripts — openMVG→MVE/openMVS stage
sequence + capture datasets, **ideas and local test inputs only, no code**); Photogrammetry-Guide
(no license — tool-landscape facts only); Hartley & Zisserman *Multiple View Geometry*; Nistér 2004;
Schönberger & Frahm *COLMAP* 2016 (algorithm literature)
**Depends on:** SPEC-11 (`services/nerf` — the posed-photos consumer, changed in lockstep per FR-9),
SPEC-10 (`services/capture` — the oriented-point-cloud consumer), SPEC-7 (reconstruct — the mesh→B-rep
tail of both legs), `@plastiq/capture` (its PLY parser reads this service's dense output)

---

## 0. One-sentence thesis

A self-hosted **Structure-from-Motion + Multi-View-Stereo** service: **unposed photos → camera poses
(`transforms.json`) + a sparse cloud + a dense oriented point cloud** — the front-end half of
photogrammetry that SPEC-10/ADR-0007 twice deferred as "COLMAP's job, not built here", built
first-party so the full **photos → CAD** chain (photogrammetry → nerf *or* capture → reconstruct)
runs end-to-end inside Plastiq with no external tools.

## 1. Problem & context

`services/photogrammetry` exists today as **empty scaffolding**: 0-byte `pyproject.toml` / `README.md`
/ `.dockerignore` / `.gitignore` and empty `app/` / `tests/` dirs (created 2026-07-03). No prior spec,
ADR, plan, or README line defines it — `docs/specs/UnfinishedFable.md` §P3/10-M1 records it as
"unstarted, unspecced work … blocked on a user decision (build the SfM service vs leave as intentional
scaffold)". **This spec is that decision, in the build direction** (user, 2026-07-04). The dated
scope-reversal notes UnfinishedFable §11(4) requires were added **alongside this spec** (2026-07-04)
to SPEC-10 (intro + §capture), ADR-0007 (§Honest scope), ADR-0006 (revisit criterion fired),
UnfinishedFable's 10-M1 rows, and the root README (services tree + scaffold note).

**The gap it fills.** Both capture paths ingest *already-solved* geometry and say so:

1. `services/nerf` (:8002) requires a `transforms.json` — "SfM is out of scope (COLMAP)" (SPEC-11
   FR-3; `services/nerf/app/data_processing/dataparser.py:1-2`). The panel's `NerfCaptureSection`
   makes the **user** supply that file (`GenerationPanel.tsx` §NerfCaptureSection).
2. `services/capture` (:8001) requires an oriented point cloud or a single depth map — "the
   photos→points step (SfM/MVS) is COLMAP's job, upstream" (`services/capture/app/sdf_mlx.py:9-10`;
   SPEC-10 §capture "Honest scope").

Nothing in the repo produces camera poses or point clouds from raw photos. ADR-0006 deliberately
deferred the SfM solvers with an explicit revisit criterion — *"if Plastiq ever hand-rolls SfM
(instead of COLMAP/MLX), port the 5-point solver then"* (`docs/adr/0006-kornia-geometry-lifts.md:38`)
— and the Expanse audit bookmarked kornia's Nistér/solver/fisheye pieces as *"only relevant if a
photogrammetry/SfM front-end ever exists"* (`docs/audits/Expanse.md:358-368`). That front-end is this
service; the revisit criterion has fired.

**A latent consumer defect this spec resolves (FR-9).** `services/nerf` consumes
`frames[].transform_matrix` as camera-to-world with **+z-forward (OpenCV) camera axes** — ray
directions are `[(u−cx)/fx, (v−cy)/fy, 1]` rotated by the c2w rotation
(`app/data_processing/rays.py:3-4,21`), `parse_transforms` applies **no axis conversion**
(`dataparser.py:49`; `engine/pipeline.py:77-83`), and the test fixture builds "+z forward convention,
matching rays.py" poses (`tests/synthetic.py:16`). Real nerfstudio/COLMAP `transforms.json` files are
**−z-forward (OpenGL/Blender)** — fed through today's panel they would train garbage (rays pointing
away from the scene, images vertically mirrored). The shipped E2E never exposed this because it uses
the service's own +z synthetic fixture. Since this service is the component that *produces* these
files, the user decided (2026-07-04, D-4): emit the **standard nerfstudio convention** and fix the
nerf parser in lockstep.

**Why the ref/ guides ground this spec.** The three vendored photogrammetry references
(`ref/Photogrammetry-Guide`, `ref/OpenSpace-Photogrammetry-Guide`, `ref/Photogrammetry-examples`)
were vendored after the 2026-06-21 Expanse audit and had no verdict; §11's ledger is their first
assessment. `Photogrammetry-examples` is the load-bearing one: a real, runnable
openMVG → MVE/openMVS pipeline whose stage sequence (features → essential-matrix-filtered matching →
global SfM/BA → dense depth → fusion) is the classical shape §5 follows, with empirical capture
datasets (14–144 photos per object) that become the P7 identity-gate fixtures.

## 2. Locked decisions (user, 2026-07-04)

| # | Decision | Rationale / consequence |
|---|---|---|
| D-1 | **Own MVG core, oracle-tested.** The multi-view-geometry pipeline is written fresh (kornia-attributed algorithm ports + the literature); **no COLMAP/pycolmap/torch at runtime**. OpenCV (conda-forge) is a **test-only oracle** (the geomdl role in SPEC-12); pycolmap is an optional, `importorskip`-gated local diagnostic for the P7 gate, not pinned in the env. | House pattern (SPEC-11/12 own-implementation ethos); triggers ADR-0006's revisit clause honestly. Cost: incremental-SfM robustness is the make-or-break → hard identity gate at P7 (R-1). |
| D-2 | **Dense MVS is required in v1.** Both consumer legs must work for v1 exit: poses → nerf *and* dense oriented cloud → capture. | User picked the larger scope explicitly. Dense = MLX plane-sweep depth + multi-view fusion (§5.5), sequenced after the P7 sparse gate. |
| D-3 | **Classical, weight-free features.** Scale-space DoG/Harris detection + SIFT-class descriptors + mutual-NN/Lowe-ratio matching. No learned detectors/matchers, no downloaded checkpoints. | Deterministic, license-clean, CI-testable on CPU; matches the repo's no-shipped-weights stance. Weaker on textureless/reflective parts — stated in NFR-5, not hidden. |
| D-4 | **Emit standard nerfstudio/OpenGL `transforms.json`; fix `services/nerf` in lockstep** (FR-9): the dataparser gains the OpenGL→internal(+z) flip at load and its synthetic fixtures move to OpenGL poses; SPEC-11 gets a dated additive note. | Fixes the latent external-file hazard for **all** `transforms.json` sources, keeps full nerfstudio-ecosystem interop. The alternative (emit +z, stay nonstandard) was rejected. |
| D-5 | **Normalization is baked into the emitted poses/points** (up-orient, center, scale — recorded in `applied_transform` + `report.normalization`), unlike nerfstudio, which normalizes loader-side (`ref/nerfstudio/.../colmap_dataparser.py:66-70,315-326`). | Our consumer has a **fixed scene radius** — `_SCENE_RADIUS = 1.5`, marching-cubes over `[−1.6, 1.6]³` (`services/nerf/app/engine/pipeline.py:28,119`; `exporters/mesh_exporter.py:43`) — so the producer must pre-normalize or meshes clip. Divergence-by-design, documented. |
| D-6 | **Undistort by default.** The service self-calibrates Brown-Conrady `k1,k2,p1,p2` in bundle adjustment, then returns **undistorted frames** and a zero-distortion `transforms.json`. | `services/nerf` ignores distortion fields entirely (`dataparser.py:30-49` reads only `fl_x/fl_y/cx/cy/w/h`), so handing it raw wide-angle frames silently degrades training. `undistort:false` keeps the coefficients on the wire for external consumers. |
| D-7 | **v1 ships the browser client**: net-new `packages/photogrammetry` (`@plastiq/photogrammetry`) + app wiring + a GenerationPanel section with hand-offs into **both** existing legs (NeRF-train and dense-cloud→capture). | SPEC-12 D-4 / SPEC-10 §browser-client precedent: reachable from the running app, never a tested island. |
| D-8 | **Port :8004, env `plastiq-photogrammetry`**, fifth entry in `scripts/dev-services.sh` (whose four-service header comment, the `justfile` §services comments/ports, and README's services text P0 updates). | Continues the registry: reconstruct :8000, capture :8001, nerf :8002, nurbs :8003. |
| D-9 | **Two-tier numerics:** float32 **MLX GPU** for dense raster math (Gaussian pyramids, gradient stacks, descriptor batches, plane-sweep cost volumes); float64 **numpy/scipy CPU** for the sparse/combinatorial solvers (RANSAC model fits, triangulation, bundle adjustment via `scipy.optimize.least_squares` with an analytic `jac_sparsity`). | There is no neural model here, so the MLX mandate (memory `mlx-m4max-ml-milestones`) binds the *heavy math*, not a training loop; sparse LM is a CPU/float64 problem (SPEC-12 D-9 spirit). |
| D-10 | **Deterministic by seed.** All RANSAC sampling uses one explicit `np.random.Generator(seed)` (request `seed`, default 0); fixed iteration budgets, fixed traversal/tie-break order; no wall-clock anywhere in results. | Same input + same seed + same machine/MLX version → same poses/clouds within float tolerance (NFR-1; capture/nerf seed precedent). |

## 3. Functional requirements

- **FR-1 (own core)** The MVG core (§5.2 `core/`, `mvs/`) is written fresh with kornia attribution
  (Apache-2.0) and **no runtime dependency on COLMAP, pycolmap, torch, or kornia itself**. Oracle
  parity tests: OpenCV `SIFT_create`/`findEssentialMat`/`recoverPose`/`solvePnP`/`triangulatePoints`
  as test-only oracles, plus exact synthetic-scene fixtures (known poses → projected points → solver
  must recover them to tolerance).
- **FR-2 (sparse SfM)** Unposed photos (3..`PHOTOGRAMMETRY_MAX_IMAGES`, default 300 — the panel's
  existing `MAX_CAPTURE_IMAGES` cap, `GenerationPanel.tsx:468`) → registered camera poses + a sparse
  3D point cloud + **self-calibrated shared intrinsics** (`f, cx, cy, k1, k2, p1, p2`; focal prior
  from EXIF — the 35mm-equivalent tag directly, else the real `FocalLength(mm)` ÷ a sensor width
  looked up from the camera model in `exif.py`'s openMVG-derived sensor-width DB (needed for the
  Canon-IXUS gate datasets, which carry no 35mm-equiv tag) — else the `1.2·max(w,h)` wide fallback).
  Images that fail to register are **reported by name** (`report.unregistered_names`), never silently
  dropped.
- **FR-3 (emitter)** The result carries a `transforms.json` string in the **nerfstudio convention**
  (§6.2): the `colmap_to_json` field set (`w,h,fl_x,fl_y,cx,cy,k1,k2,p1,p2,camera_model,frames[],
  applied_transform` — `ref/nerfstudio/nerfstudio/process_data/colmap_utils.py:390-494`), OpenGL
  camera axes, normalization baked per D-5. A contract test feeds the emitted JSON through the real
  `services/nerf` `parse_transforms` and asserts intrinsics/pose round-trip.
- **FR-4 (undistortion)** `undistort` (default `true`): Brown-Conrady undistortion of the registered
  frames (`core/distortion.py`, iterative inverse); the result's `images_undistorted` is parallel to
  `frames[]`, the emitted intrinsics are the post-undistortion `K`, and distortion fields are zeroed.
  `undistort:false` emits the calibrated coefficients instead and omits `images_undistorted`.
- **FR-5 (dense MVS — v1, D-2)** `dense` (default `true`): MLX plane-sweep stereo per registered view
  + multi-view geometric-consistency fusion (§5.5) → a **dense oriented point cloud** (points +
  per-point unit normals), voxel-downsampled to ≤ `PHOTOGRAMMETRY_MAX_DENSE_POINTS` (default 200 000
  — capture's `MAX_POINTS`, `services/capture/app/main.py:43`), exported as ASCII PLY with
  `nx/ny/nz` — **parseable by the existing `@plastiq/capture` PLY parser**
  (`packages/capture/src/pointcloud.ts`) so the capture leg needs zero new parsing.
- **FR-6 (service)** FastAPI **submit→poll** on **:8004** (`POST /solve` → poll →
  `{ transforms_json, images_undistorted?, sparse_ply_base64, dense_ply_base64?, report }`),
  mirroring the reconstruct/capture/nerf/nurbs contract (§6.1); registered in
  `scripts/dev-services.sh` + `justfile` + README (four services → five).
- **FR-7 (client + panel)** Browser client is its own workspace package **`@plastiq/photogrammetry`**
  (`packages/photogrammetry`, net-new, mirroring `packages/nerf` file-for-file): `solvePhotos()`
  submit→poll with `signal`/`pollIntervalMs`/`maxPolls`/`fetchImpl`/`delay`/`onJob`/`apiKey` options
  and a `cancelJob` export. `apps/plastiq` adds `photogrammetryBaseURL`/`photogrammetryApiKey`
  settings (panel fields `settings-photogrammetry-url`/`settings-photogrammetry-key`),
  `src/ai/photogrammetry.ts`, and a **`PhotoSolveSection`** in the Generation panel (testid
  `photo-solve`): photos-only input (no transforms.json asked of the user), `GET /health` pre-check
  with the `serviceUnreachableMessage` hint, abortable submit→poll with Cancel → `DELETE /jobs/{id}`,
  and on success **two hand-offs**: (a) prefill `NerfCaptureSection` with the emitted
  `transforms.json` + the undistorted images (filename pairing holds — `frames[].file_path` basenames
  are the upload names); (b) route the dense cloud into the existing capture flow
  (`meshFromPointCloud`) → `MeshDoc` → "Convert to CAD". **Reachable from the running app.**
- **FR-8 (report)** The `report` exposes `{ images_total, images_registered, unregistered_names,
  sparse_points, dense_points, mean_reprojection_error_px, mean_track_length, camera: { model, w, h,
  fl_x, fl_y, cx, cy, k1, k2, p1, p2 }, normalization: { applied_transform, scale }, matching, seed,
  dense, undistorted }` so the client/UX can show solve quality honestly (SPEC-12 FR-9 precedent).
- **FR-9 (nerf lockstep fix)** `services/nerf`'s `parse_transforms` gains the standard OpenGL→internal
  conversion (`c2w[0:3, 1:3] *= −1` — flip the camera y/z axis columns) so `rays.py`'s +z math consumes OpenGL
  files correctly; `tests/synthetic.py` `look_at` emits OpenGL poses (forward = −z) so the suite
  stays self-consistent; SPEC-11 §5/FR-3 get a dated 2026-07-04-style additive note. The nerf suite
  (63 tests) must stay green.
  **Landed 2026-07-04 (P8.1).** The flip is in `dataparser.py` (guarded for empty `frames`);
  `look_at` emits textbook OpenGL (forward = −z, +y up) and the fixture renders/returns the internal
  form via a new `opengl_to_internal` helper; the SPEC-11 §5/FR-3 dated note is added; the FR-9
  regression is `services/nerf/tests/test_opengl_convention.py` (a canonical OpenGL pose → center ray
  now aims at the scene — red on the pre-fix parser). Full nerf suite **65 green** (the prior 63 + 2).
- **FR-10 (auth/caps)** `PHOTOGRAMMETRY_API_KEY` bearer auth on `POST /solve` + `DELETE /jobs/{id}`
  (unset ⇒ open dev default; constant-time compare — the SPEC-11 §5 auth model verbatim),
  `PHOTOGRAMMETRY_CORS_ORIGINS`, `PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS` (**default 1** — one SfM+MVS
  job is the heaviest workload in the fleet; submits beyond it get 429), pydantic input caps
  (image count 3..`PHOTOGRAMMETRY_MAX_IMAGES`, per-image byte cap), startup config log that never
  prints the key.

## 4. Non-functional requirements

- **NFR-1 Deterministic** — seeded RANSAC + fixed budgets (D-10): same input + seed + machine/MLX
  version → the same poses/clouds within float tolerance. Tests assert tolerances, not bitwise
  equality (BLAS/GPU reduction order is not bitwise-stable — stated honestly, SPEC-12 NFR-1 wording).
- **NFR-2 Real solves, no stubs** — the P7 gate and P9 dense tests run on **real photographs**
  (`ref/Photogrammetry-examples` datasets, local skip-if-absent fixtures — `ref/` is gitignored) and
  assert genuine registration/reprojection/coverage numbers from real M4-Max runs; CI keeps the
  synthetic-fixture suites (§8 CI stance).
- **NFR-3 Numerics policy (D-9)** — float32 MLX GPU for pyramids/descriptors/cost-volumes; float64
  numpy/scipy CPU for RANSAC fits, triangulation, and sparse-LM bundle adjustment. Known MLX
  constraints designed around, not discovered later: no `searchsorted`, non-deterministic scatter
  (gather+matmul formulations), `linalg` on the CPU stream (SPEC-12 §5.3 precedent).
- **NFR-4 Local-first** — conda env, no egress, no telemetry, no downloaded weights or vocab trees;
  **deploy is out of scope** (MLX is Apple-Silicon-only — the capture/nerf/nurbs stance;
  `.dockerignore` filled for parity, no Dockerfile in v1). CI runs the MLX-free subset only
  (`tests/test_jobs.py tests/test_emit.py` — `emit.py`/`normalize.py`/`exif.py`/`jobs.py` are
  numpy-only by design), matching the capture/nerf matrix rows (`.github/workflows/ci.yml:111-135`).
- **NFR-5 Honest scope** — (a) **Scale is not metric**: SfM recovers geometry up to similarity; the
  emitted scene is normalized (D-5) and `report.normalization.scale` records the solver→emitted map,
  but **real-world millimetres are unrecoverable without references** — the user scales in CAD, and
  the panel copy says so. (b) Classical features degrade on textureless/reflective/thin parts
  (D-3) — the report's registration counts expose it; capture guidance (photo count/overlap, from the
  `Photogrammetry-examples` datasets: 14 photos for a relief, ~50 for a statue, ~140 for full 360°
  objects) ships as panel help copy. (c) Organic/appearance-driven output feeds the freeform path —
  the SPEC-7 R-3 caveat applies downstream.

## 5. Architecture

### 5.1 Pipeline

```text
images (+ names, base64)
  → exif.intrinsics_prior     EXIF focal (35mm-equiv → px: f·max(w,h)/36) else 1.2·max(w,h); cx,cy = center
  → core.features             scale-space DoG detection + orientation + SIFT descriptor (MLX pyramids)
  → core.match                mutual-NN + Lowe ratio; pairs: exhaustive, or sequential window (ordered sets)
  → core.epipolar + ransac    seeded MSAC: Nistér 5-point essential (deg-10 poly) scored by Sampson
                              distance; E → (R,t) with cheirality-checked solution selection
  → sfm.init_pair             best pair by inliers × triangulation-angle
  → sfm.incremental loop      register next view (DLT-PnP RANSAC on 2D↔3D) → triangulate new tracks
                              (DLT + reprojection/parallax gates) → local BA → periodic global BA
                              (scipy sparse LM; shared intrinsics f,cx,cy,k1,k2,p1,p2 refined)
  → sfm.filter                min track length 3, max reprojection 4px, min triangulation angle 1.5°
  → normalize                 up-orient (mean camera-up → +z), center (sparse-point median), scale
                              (90th-pct point radius → 1.0, inside nerf's 1.5 scene radius); the
                              similarity is recorded as applied_transform + report scale (D-5)
  → core.distortion           undistort registered frames; K → post-undistortion K (D-6)
  → emit                      transforms.json (§6.2, OpenGL c2w) + sparse ASCII PLY (xyz + rgb)
  → mvs.plane_sweep (dense)   per view: K=4 neighbors by baseline angle; 96 fronto-parallel depth
                              hypotheses spanning the view's sparse depth range; 5×5 ZNCC cost
                              (MLX GPU); WTA + parabolic subpixel refine; depth→normals (gradient
                              cross-product — the ADR-0006 math, reimplemented in-service like
                              nerf's ray convention, no import of services/capture)
  → mvs.fusion (dense)        multi-view consistency (reprojected |Δd|/d < 1%, ≥ 2 views agree) →
                              unproject to world → voxel-grid downsample ≤ 200k → oriented cloud
  → result                    { transforms_json, images_undistorted?, sparse_ply, dense_ply, report }
```

### 5.2 Modules (`services/photogrammetry/app/`)

| Module | Responsibility |
|---|---|
| `core/features.py` | scale-space (Gaussian pyramid + DoG extrema, Harris rejection) keypoints, dominant orientation, 128-d SIFT-class descriptor; MLX GPU pyramids/gradients, numpy keypoint bookkeeping; `max_features` cap per image |
| `core/match.py` | descriptor matching: MLX matmul distance matrices → mutual-NN + Lowe ratio (0.8); pair schedules (exhaustive / sequential window 8) |
| `core/epipolar.py` | normalized 8-point fundamental, **Nistér 5-point essential** (nullspace → Gauss-Jordan elimination → degree-10 polynomial → companion-matrix roots), `E → (R,t)` decomposition + cheirality selection, Sampson distance (ports: `ref/kornia/kornia/geometry/epipolar/essential.py:45,394,447,588,614`, `solvers/polynomial_solver.py:1898`, `epipolar/_metrics.py:139`, `fundamental.py:158,260` — Apache-2.0, attributed) |
| `core/ransac.py` | seeded MSAC loop for E/F/PnP models: minimal-sample batches, inlier scoring, adaptive early stop by confidence, best-model local-optimization refit (shape: `ref/kornia/kornia/geometry/ransac.py:42-406`) |
| `core/pnp.py` | DLT-PnP (≥ 6 correspondences; `ref/kornia/kornia/geometry/calibration/pnp.py:59`) + LM reprojection refinement — view registration |
| `core/triangulate.py` | two-view DLT triangulation (`ref/kornia/.../triangulation.py:59`) + cheirality/reprojection/parallax gates |
| `core/ba.py` | sparse bundle adjustment: `scipy.optimize.least_squares(method="trf", jac_sparsity=CSR)` over poses (angle-axis), points, shared intrinsics + Brown-Conrady; float64, robust Huber loss |
| `core/distortion.py` | Brown-Conrady distort/undistort for points (iterative inverse) and images (inverse-map bilinear resample) (math refs: `ref/kornia/kornia/geometry/calibration/{distort,undistort}.py:78,34`) |
| `mvs/plane_sweep.py` | MLX plane-sweep stereo: homography-warped neighbor stacks over depth hypotheses, 5×5 ZNCC cost volumes, WTA + parabolic refine, depth→normals |
| `mvs/fusion.py` | multi-view geometric-consistency filter, world-frame fusion, deterministic voxel-grid downsample → oriented cloud |
| `exif.py` | EXIF focal/size prior (pillow), 35mm-equivalent conversion, sane fallbacks |
| `sfm.py` | the incremental mapper (§5.1 loop): init-pair selection, register→triangulate→BA schedule, track/point filters, registration bookkeeping |
| `normalize.py` | up-orient/center/scale similarity + `applied_transform` bookkeeping (D-5) |
| `emit.py` | `transforms.json` emitter (§6.2) + ASCII PLY writers (sparse `x y z r g b`; dense `x y z nx ny nz r g b`) |
| `pipeline.py` | orchestration: `solve(payload) → result` (§5.1); the service entrypoint |
| `jobs.py` | in-memory `JobStore` — `{queued, running, completed, failed}`, TTL + max-count eviction, `running_count()` cap (capture/nurbs `app/jobs.py` shape) |
| `main.py` | FastAPI submit→poll (§6.1): auth, CORS, concurrency 429, pydantic caps, `asyncio.to_thread` worker, startup config log (never prints the key) |
| `logging_setup.py` | `PHOTOGRAMMETRY_LOG_LEVEL` logger setup (nerf pattern: single handler, idempotent) |

Scaffolding (P0): `pyproject.toml` (`plastiq-photogrammetry`, `requires-python >= 3.11`, pytest/ruff
blocks — nerf's shape), `environment.yml` (`name: plastiq-photogrammetry`, conda-forge:
`python=3.11 numpy scipy pillow opencv fastapi uvicorn pydantic httpx pytest pip`; pip: `mlx` —
`opencv` is the **test-only oracle**, the geomdl role), `.gitignore`/`.dockerignore` (nurbs's
contents), README in the nerf format.

### 5.3 Numerics policy (designed-in)

- **Sparse solvers are float64 CPU** (numpy/scipy): RANSAC minimal fits, triangulation, PnP, and the
  BA normal-equation work inside `least_squares`. BA Jacobian sparsity is analytic
  (2 residuals/observation × the 6-pose + 3-point + 7-intrinsics blocks it touches) — the standard
  scipy large-scale-BA formulation; Huber loss for outlier robustness.
- **Dense raster math is float32 MLX GPU**: Gaussian pyramids, DoG stacks, gradient/orientation maps,
  descriptor distance matmuls, plane-sweep warps + ZNCC volumes. One `mx.eval()` per stage; no Python
  control flow on array scalars in hot loops; gather+matmul only (scatter is non-deterministic).
- **RNG**: exactly one `np.random.Generator(PCG64(seed))` threaded through RANSAC; MLX ops used here
  are RNG-free. No `time`/wall-clock in any result field.

### 5.4 Sparse method (the algorithms, by the book)

1. **Features** — Lowe's scale-space recipe (DoG pyramid, 3σ interval extrema, edge/contrast
   rejection via the Harris/Hessian ratio, dominant gradient orientation, 4×4×8 descriptor grid,
   root-SIFT normalization). Quality bar: repeatability + match-inlier parity with OpenCV SIFT on
   the synthetic fixture and one real pair (P1 tests).
2. **Two-view geometry** — Nistér 2004 five-point: nullspace of the 5×9 epipolar design, the ten
   third-order constraint polynomials, Gauss-Jordan reduction, the degree-10 univariate polynomial
   (kornia's `determinant_to_polynomial` tables), real roots via the companion matrix, candidate E
   matrices scored by Sampson distance inside MSAC; `motion_from_essential`-style cheirality
   disambiguation (triangulate inliers, pick the (R,t) with the most points in front of both views).
3. **Incremental mapping** — COLMAP-shaped (Schönberger 2016) but minimal: best init pair
   (inliers × median triangulation angle), then repeatedly (a) pick the unregistered view seeing the
   most triangulated tracks, (b) DLT-PnP RANSAC + LM refine, (c) triangulate its new tracks with
   parallax/reprojection gates, (d) local BA on the newest views, (e) global BA every N=5
   registrations and once at the end (intrinsics free after 8 registered views — self-calibration).
4. **Filters** — track length ≥ 3 for the final cloud (matching the sparse-depth min-visibility
   spirit of `create_sfm_depth`), reprojection ≤ 4px during mapping (≤ 1.5px mean at the gate),
   triangulation angle ≥ 1.5°.
5. **Normalization (D-5)** — mean camera-up → +z (nerfstudio's `"up"` orientation method), center at
   the sparse-point median, scale so the 90th-percentile point radius is 1.0; the **forward**
   similarity (solver world → normalized world) is recorded as `applied_transform` (+ `scale` in the
   report), so solver-frame coordinates are recoverable by applying its inverse — matching §6.2's
   `applied_transform` definition.

### 5.5 Dense method (MVS)

Plane-sweep stereo (Collins 1996 lineage; the `Photogrammetry-examples` `dmrecon`/`DensifyPointCloud`
stage, reimplemented): for each registered reference view, warp K=4 baseline-angle-selected neighbor
views over 96 fronto-parallel depth hypotheses spanning that view's sparse depth range (from its
visible tracks, padded ±20%); 5×5 ZNCC photometric cost aggregated across neighbors (MLX GPU); WTA
depth + parabolic subpixel refinement; per-view normals from the unprojected depth-grid gradient
cross-product (the ADR-0006 `depth_to_normals` math, reimplemented in-service — the nerf precedent of
sharing a *convention*, not an import). Fusion: a depth pixel survives iff ≥ 2 other views reproject
to a relative depth gap < 1% and its normal agrees (dot > 0.7) with the consensus; survivors
unproject to the normalized world frame, then a deterministic voxel-grid downsample caps the cloud at
`PHOTOGRAMMETRY_MAX_DENSE_POINTS`. Output: points + unit normals (+ mean RGB), the exact
`{points, normals}` shape `POST /capture` consumes (`services/capture/app/main.py:71-74`).

## 6. Data contracts

### 6.1 Service wire contract (frozen — the API P10 implements, `@plastiq/photogrammetry` consumes)

Mirrors capture/nerf/nurbs exactly (same `/jobs/{id}/…` polling shape).

| Method & path | Request | Response |
|---|---|---|
| `POST /solve` | `{ images: string[] (base64 JPEG/PNG, 3..300), names?: string[] (parallel filenames; server names `frame_%05d.jpg` when absent), matching?: "exhaustive"\|"sequential" (default "exhaustive"), dense?: bool (default true), undistort?: bool (default true), max_features?: int (default 4096, 512..16384), seed?: int (default 0) }` | `{ id, state, error: null }` (a `JobView`; 200); **429** over `PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS` (default 1); 400/422 on malformed/out-of-bounds input (incl. `names` length mismatch) |
| `GET /jobs/{id}/status` | — | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET /jobs/{id}/result` | — | `{ transforms_json: string, images_undistorted: string[] \| null, sparse_ply_base64: string, dense_ply_base64: string \| null, report: Report (FR-8) }` (200 when completed; 409 if not; 500 if failed; 404 unknown id) |
| `DELETE /jobs/{id}` | — | 204 (job dropped; in-flight worker's result discarded); 404 unknown id |
| `GET /health` | — | `{ status, service }` |

**Auth (FR-10).** `PHOTOGRAMMETRY_API_KEY` set ⇒ `POST /solve` + `DELETE /jobs/{id}` require
`Authorization: Bearer <key>`, 401 without (constant-time compare, key read per-request); unset ⇒
open (dev default). The client sends the header on every request when a key is configured
(`PhotogrammetryOptions.apiKey` ← persisted `photogrammetryApiKey` setting) — the SPEC-11 §5 model.

**Client.** `packages/photogrammetry` (`@plastiq/photogrammetry`, net-new, mirroring `packages/nerf`
file-for-file): `solvePhotos(input, opts)` → POST → poll → result; `cancelJob(id, opts)`;
`DEFAULT_BASE_URL = "http://localhost:8004"`; snake_case wire → camelCase (`transformsJson`,
`imagesUndistorted`, `sparsePly`, `densePly`, `report`); types decoupled from the app's doc model.
**P10 must not diverge from this table** without updating the client + this spec together.

### 6.2 `transforms.json` emission (the FR-3 contract)

Field set and axis convention follow nerfstudio's `colmap_to_json`
(`ref/nerfstudio/nerfstudio/process_data/colmap_utils.py:390-494` — Apache-2.0 shape reference):

```jsonc
{
  "w": 1920, "h": 1080,
  "fl_x": 1657.2, "fl_y": 1657.2, "cx": 960.0, "cy": 540.0,
  "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,        // zeroed when undistort:true (D-6)
  "camera_model": "OPENCV",
  "frames": [
    { "file_path": "./images/IMG_0001.jpg",            // basename = the uploaded name (panel pairing)
      "transform_matrix": [[...4×4...]],                // camera-to-world, OpenGL axes (D-4)
      "reproj_error_px": 0.83 }                          // additive; consumers ignore unknown keys
  ],
  "applied_transform": [[...3×4...]]                     // solver world → emitted (normalized) world (D-5)
}
```

- **Camera axes:** internal solver poses are OpenCV `w2c [R|t]`; emission is
  `c2w = inv(w2c)` then `c2w[0:3, 1:3] *= −1` (the flip at `colmap_utils.py:446`) → OpenGL
  (−z forward, +y up). No `[0,2,1,3]` world permutation is needed — nerfstudio applies it to repair
  COLMAP's arbitrary world orientation, and `normalize.py` (D-5) already produces a +z-up world; the
  normalization similarity is what `applied_transform` records.
- **Intrinsics:** shared, single camera (top-level fields) — matching both the panel flow (one
  device) and `services/nerf`'s single-intrinsics parser (`dataparser.py:30-46`). Per-frame
  intrinsics are out of scope (§10).
- **`ply_file_path` is deliberately omitted** — nerfstudio uses it to reference a sibling file on
  disk; over this wire the points ride as `sparse_ply_base64`/`dense_ply_base64` result fields.
- **Consumer proof:** a pytest contract test parses the emitted string with the real
  `services/nerf` `parse_transforms` and asserts fx/fy/cx/cy/w/h and per-frame c2w survive; after
  FR-9, `generate_rays` on the parsed poses must aim the center pixel at the scene (the
  `test_data_processing.py:21-22` assertion shape).

### 6.3 Point-cloud PLY

ASCII PLY, little-endian floats as text (the format `packages/capture/src/pointcloud.ts` parses by
header property position): sparse = `x y z red green blue`; dense = `x y z nx ny nz red green blue`.
Both live in the **normalized** (emitted) world frame so points and poses stay aligned — the
`create_ply_from_colmap` invariant (`colmap_utils.py:671-715`).

## 7. Boundaries & failure modes

| From | To | Mechanism | Failure handling |
|---|---|---|---|
| browser `photogrammetry.ts` | service | HTTPS submit+poll (`photogrammetryBaseURL`, self-host) | HTTP 4xx/5xx detail surfaced; `maxPolls` timeout; failed job → message; Cancel → DELETE |
| service | SfM core | in-proc (`asyncio.to_thread`) | solver exceptions → job `failed` with a stage-tagged message; < 3 registered views or degenerate init → `failed` with the registration report embedded (never a fake result) |
| service | MVS | in-proc, after sparse succeeds | per-view sweep failure → that view skipped (logged, counted); zero fused points → `dense_ply_base64: null` + `report.dense_points: 0`, sparse result still returned |
| result `transforms_json` | `services/nerf` `/train` | panel hand-off (FR-7a) | FR-9 parser conversion; nerf-side validation errors surface in its panel section as today |
| result dense PLY | `services/capture` `/capture` | panel hand-off (FR-7b) via `@plastiq/capture` parser | existing client validation (`MIN_POINTS = 16` floor, 200k cap) applies unchanged |
| `services/nerf` fixtures | FR-9 flip | lockstep change | nerf suite green is the P8 exit condition (landed 2026-07-04: **65** green, prior 63 + 2 FR-9 tests); SPEC-11 dated note added in the same change |

## 8. Milestones

Prefix **P** (photogrammetry). P7 is the identity gate, like SPEC-12's U7 and SPEC-7's R6.4a.

| Milestone | Scope | Status |
|---|---|---|
| **P0** | ADR-0013 + scaffold fill (`pyproject.toml`, `environment.yml`, `.gitignore`/`.dockerignore`, README — nerf format; the plan doc already exists — header); register `photogrammetry:plastiq-photogrammetry:services/photogrammetry:8004` in `scripts/dev-services.sh` (+ its "four services" header comment → five), `justfile` §services comments/ports (:8000–:8004), and the root README's `just services` line (four services → five). (The dated scope-reversal notes in SPEC-10/ADR-0007/ADR-0006/UnfinishedFable and the README tree entry already landed with this spec, 2026-07-04 — §1.) Conda env created, `mlx` importable | ⬜ |
| **P1** | `core/features.py` + `exif.py`: scale-space SIFT-class detector/descriptor (MLX pyramids); repeatability + OpenCV-oracle match-parity tests on the synthetic fixture and one real pair | ⬜ |
| **P2** | `core/match.py` + `core/epipolar.py`: matching, 8-point F, **Nistér 5-point E** + degree-10 solver, decomposition + cheirality, Sampson — exact synthetic-scene recovery tests + OpenCV `findEssentialMat`/`recoverPose` oracle parity | ⬜ |
| **P3** | `core/ransac.py` + `core/pnp.py` + `core/triangulate.py`: seeded MSAC (E/F/PnP), DLT-PnP + refine, gated DLT triangulation; outlier-contaminated synthetic tests (30% gross outliers → correct model) | ⬜ |
| **P4** | `core/ba.py`: sparse-LM bundle adjustment with shared-intrinsics + Brown-Conrady self-calibration; noisy synthetic scene converges (mean reprojection < 0.5px, intrinsics recovered within 2%) | ⬜ |
| **P5** | `sfm.py` incremental mapper end-to-end on the synthetic multi-view fixture: all views registered, poses match ground truth up to similarity (Umeyama-aligned RMSE < 1%) | ⬜ |
| **P6** | `normalize.py` + `core/distortion.py` + `emit.py`: normalization similarity + `applied_transform`, undistortion round-trip, §6.2 emitter + PLY writers; the **`parse_transforms` contract test** against real `services/nerf` code | ⬜ |
| **P7** | **Sparse identity gate (GATE):** real photos — `ref/Photogrammetry-examples` Stone_Mask (14) and Gorsedd_Stone (48), local skip-if-absent fixtures — solve with ≥ 85% of images registered, mean reprojection ≤ 1.5px, mean track length ≥ 3. Diagnosis tooling: optional `importorskip`-gated pycolmap comparison. **Gate fails ⇒ stop and re-plan before P8+** | ⬜ |
| **P8** | **FR-9 nerf lockstep:** OpenGL→internal flip in `services/nerf/app/data_processing/dataparser.py`, fixtures to OpenGL `look_at`, SPEC-11 dated note; nerf suite green | ✅ 2026-07-04 — **P8.1 landed** (self-contained nerf-service change): `parse_transforms` applies `c2w[0:3,1:3]*=−1`, `look_at` emits OpenGL (+`opengl_to_internal`), SPEC-11 §5/FR-3 dated note, new `tests/test_opengl_convention.py`; **65** nerf tests green (prior 63 + 2) |
| **P9** | `mvs/plane_sweep.py` + `mvs/fusion.py` (D-2): MLX cost volumes, depth+normals, consistency fusion; **real M4-Max test on the gate dataset**: ≥ 50k fused oriented points, and the cloud drives `services/capture` `POST /capture` locally to a real mesh (`faces > 100`) | ⬜ |
| **P10** | FastAPI service (`jobs.py`, `main.py`, `logging_setup.py`) per §6.1 + real submit→poll→result API test (`httpx.ASGITransport`, no mocks) + auth/CORS/429/caps tests; CI matrix row (MLX-free subset per NFR-4) | ⬜ |
| **P11** | `@plastiq/photogrammetry` + `apps/plastiq` wiring (settings, `src/ai/photogrammetry.ts`, `PhotoSolveSection` with both hand-offs, capture-guidance copy); unit tests mirroring the nerf/capture panel suites | ⬜ |
| **P12** | Browser E2E `e2e/plastiq/photogrammetry.spec.ts`, service-gated on `/health` (the `nerf.spec.ts` precedent): photo fixture → solve → dense hand-off → capture → mesh renders in the viewport; the photos→nerf-prefill leg asserted to the prefilled-section state (full nerf training stays a local, knob-minimized run). Full local chain run green on the M4 Max recorded here | ⬜ |

**Exit criteria (v1, per D-2):** a real photo set → (a) a `transforms.json` that trains
`services/nerf` (small knobs) into a mesh in the running app, **and** (b) a dense oriented cloud that
`services/capture` turns into a watertight mesh — both through the panel; P7 gate passed; oracle +
contract suites green; zero regressions in the reconstruct (93), capture (43), nerf (63), nurbs, and
plastiq suites.

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R-1 | **Incremental-SfM robustness** — the make-or-break: drift, bad init pairs, degenerate/planar scenes, self-calibration divergence. COLMAP embodies years of hardening we do not have. | Hard P7 gate on real photos before any service/client investment; pycolmap as an offline diagnostic oracle; conservative gates (§5.4-4); failures are honest `failed` jobs carrying the registration report — never a fake pose set. |
| R-2 | **BA scale/wall-clock** — 300 images × 4k features can reach ~10⁶ observations; scipy LM is CPU-bound. | Analytic `jac_sparsity`, Huber loss, local-BA-first schedule with periodic global passes, capped iterations; `PHOTOGRAMMETRY_MAX_IMAGES`/`max_features` caps; wall-clock documented in the README, not hidden. |
| R-3 | **Textureless / reflective mechanical parts** defeat classical features (D-3). | NFR-5 honesty: registration counts + unregistered names in the report; capture-guidance panel copy (photo counts/overlap from the `Photogrammetry-examples` datasets); learned features are a named v2 option (§10), not silently absent. |
| R-4 | **MVS noise/quality** — ZNCC plane-sweep is the classical baseline, below PatchMatch-class quality. | ≥ 2-view geometric consistency + normal agreement before fusion; the capture SDF (IGR losses) tolerates noisy oriented clouds by design; voxel downsample bounds memory; `dense_points: 0` is a valid honest outcome (§7). |
| R-5 | **Convention drift** across producer/consumers (the exact hazard §1 documents). | §6.2 frozen; the `parse_transforms` contract test runs in this service's suite against real nerf code; FR-9 lands as one lockstep change with the SPEC-11 note; e2e chain test (P12). |
| R-6 | **Payload weight** — ≤ 300 base64 images up and (undistorted) back down. | Mirrors the shipped nerf panel bound (`MAX_CAPTURE_IMAGES = 300`, one POST body); pydantic byte caps; `undistort:false` skips the echo; documented limits in README + panel copy. |
| R-7 | **License hygiene** — GPLv3 scripts and CC BY-SA assets in `ref/Photogrammetry-examples`; unlicensed guide prose. | **Zero code/prose copying** from those repos: stage-sequence ideas + locally-run test inputs only (`ref/` is gitignored — datasets are skip-if-absent fixtures, never redistributed); ports come from Apache-2.0 kornia/nerfstudio with attribution; OpenCV is a test-only oracle. Recorded here + in ADR-0013. |
| R-8 | **Determinism vs parallel numerics** — BLAS/GPU reductions are not bitwise-stable. | D-10 seeding makes sampling exact; asserts are tolerance-based (NFR-1); the report carries `seed` so any solve is reproducible. |

## 10. Out of scope (v1)

- **Learned features/matchers** (SuperPoint/DISK/LoFTR-class) — named v2 upgrade path for
  low-texture scenes; pulls third-party checkpoint licenses in (D-3 rejection).
- **Fisheye (Kannala-Brandt) and equirectangular inputs** — pinhole + Brown-Conrady only; the
  ADR-0006 fisheye deferral stands (kornia's port target is named there if ever needed).
- **Video ingestion** — frame extraction/blur selection is the caller's job; `matching:"sequential"`
  covers ordered photo sets.
- **Retrieval-based pair selection** (vocab trees / NetVLAD) — unnecessary at ≤ 300 images
  (exhaustive/sequential suffice); also a downloaded-artifact dependency (NFR-4).
- **Metric scale, GPS/geo-registration, markers/scale bars** — geometry is up-to-similarity (NFR-5a).
- **Per-frame/multi-camera intrinsics** — one shared camera per job (§6.2; the nerf parser is
  single-intrinsics).
- **In-service meshing** — meshes belong to the consumers (nerf export, capture SDF, reconstruct).
- **COLMAP interop files** (`cameras.bin`/`sfm_data.json` import/export) — `transforms.json` + PLY
  are the only contracts; note `colmap_parsing_utils.py` carries an extra BSD notice
  (`ref/nerfstudio/nerfstudio/data/utils/colmap_parsing_utils.py:10-39`) if that ever changes.
- **Deploy / hosting / Docker** — MLX is Apple-Silicon-only; local-only like capture/nerf/nurbs
  (NFR-4).

## 11. References & ref/ survey ledger (2026-07-04)

**Vendored repos surveyed for this spec** (first assessment — none covered by `docs/audits/Expanse.md`,
which predates their vendoring):

| ref/ repo | License (verified) | Use here |
|---|---|---|
| `kornia` | Apache-2.0 (`LICENSE`, per-file headers) | **Algorithm ports with attribution** (D-1): 5-point `essential.py:45,394`, degree-10 `polynomial_solver.py:1898`, `fundamental.py:158,260`, `triangulation.py:59`, `ransac.py:42`, `calibration/pnp.py:59`, `calibration/{distort,undistort}.py:78,34`, `_metrics.py:139`; weight-free feature refs `siftdesc.py`, `responses.py`, `scale_space_detector.py`, `matching.py:88-254`. Confirmed: **no ICP/Umeyama/BA in kornia** (`geometry/pointcloud.py` is PLY I/O only) — BA is scipy (§5.3), Umeyama (P5 test metric) is written fresh. |
| `nerfstudio` | Apache-2.0 | **Emitter shape**: `colmap_to_json` field set + axis ops (`process_data/colmap_utils.py:390-494`), `create_ply_from_colmap:671-715`, sparse-depth filters `:497-641`; the 4-stage COLMAP sequence `run_colmap:92-184` as the stage checklist; loader-side normalization contrast (`data/dataparsers/colmap_dataparser.py:66-70,315-326`) → D-5. |
| `sdfstudio` | Apache-2.0 | Divergence warning only: its legacy `colmap_to_json` uses a **different world permutation** (`[1,0,2,3]`) and omits `applied_transform` — explicitly *not* followed; nerfstudio-modern is authoritative (D-4). |
| `Photogrammetry-examples` | CC BY-SA 4.0 (docs/assets) + **GPLv3** (scripts, per-file headers) | **Ideas + local test inputs only, no code** (R-7): the openMVG→MVE/openMVS stage sequence (`run_MVG.sh:23-67`, `run_MVE.sh:47-48`, `run_MVS.sh:50-61`) validates §5's pipeline shape; the Stone_Mask (14) / Gorsedd_Stone (48) / Pear (143, 360°) datasets are the P7/P9 gate fixtures (skip-if-absent; `ref/` is gitignored) and the NFR-5b capture-guidance numbers. |
| `Photogrammetry-Guide` | **No license file** (all-rights-reserved prose) | Facts only: the tool-landscape map (COLMAP/OpenMVG/AliceVision/MicMac/MVE/ODM…) and camera-selection guidance informing panel help copy; no prose reuse. |
| `OpenSpace-Photogrammetry-Guide` | No license file | Stale near-verbatim fork of the above (README differs by one badge line) — **not cited**; use `Photogrammetry-Guide`. |

**Literature:** Hartley & Zisserman, *Multiple View Geometry*, 2nd ed. (DLT, triangulation §12.2,
normalized 8-point, RANSAC); Nistér, *An efficient solution to the five-point relative pose problem*,
PAMI 2004; Lowe, *Distinctive image features from scale-invariant keypoints*, IJCV 2004 (+ root-SIFT,
Arandjelović & Zisserman 2012); Schönberger & Frahm, *Structure-from-Motion Revisited*, CVPR 2016
(incremental mapper shape); Fischler & Bolles 1981 (RANSAC) + Torr & Zisserman 2000 (MSAC); Collins,
*A space-sweep approach to true multi-image matching*, CVPR 1996 (plane sweep); Umeyama 1991
(similarity alignment, test metric); scipy large-scale bundle-adjustment cookbook
(`least_squares` + `jac_sparsity`).

**Repo evidence:** SPEC-10 §capture + ADR-0007 (the deferred front-end, verbatim), ADR-0006:28-38
(the revisit clause), SPEC-11 §5 (service/auth/client template; the FR-9 lockstep target),
SPEC-12 (spec/house-style template, D-9/NFR-1 numerics+determinism precedents),
`services/nerf/app/data_processing/{dataparser,rays}.py` + `engine/pipeline.py:28,77-83,119` (the
consumer contract §1/D-5 cites), `services/capture/app/main.py:43,71-74` (the dense-leg contract),
`packages/capture/src/pointcloud.ts` (the PLY parser FR-5 reuses), `GenerationPanel.tsx:468` (the
300-image bound), `scripts/dev-services.sh` (port registry), `.github/workflows/ci.yml:98-135` (the
CI feasibility stance NFR-4 follows).
