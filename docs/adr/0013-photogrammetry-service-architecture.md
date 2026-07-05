# ADR 0013 — `services/photogrammetry/` : a first-party SfM + MVS front-end service

**Status:** Accepted · **Date:** 2026-07-04 · **Plan:** `docs/plans/2026-07-04-photogrammetry-service.md`
**Tier:** T2 (self-hosted Python) · **Source ideas:** kornia (Apache-2.0 — MVG algorithms, ported with attribution); nerfstudio `ns-process-data` (Apache-2.0 — `transforms.json` emitter shape); Photogrammetry-examples (CC BY-SA docs / GPLv3 scripts — stage sequence + gate datasets, ideas & local inputs only); Hartley & Zisserman; Nistér 2004; Lowe 2004; Schönberger & Frahm 2016; Collins 1996 · **Framework:** MLX (Apple Silicon) for the dense raster math; numpy/scipy for the sparse solvers

## Context

At authoring time (before the same milestone's P0.2 scaffold fill), `services/photogrammetry` existed
only as undefined empty scaffolding — 0-byte `pyproject.toml`/`README.md`/`.gitignore`/`.dockerignore`,
empty `app/`/`tests/` dirs (created 2026-07-03) — with no prior spec, ADR, plan, or Expanse milestone
defining it (`docs/specs/UnfinishedFable.md` §P3/10-M1). SPEC-13 is its definition; this ADR records
the architecture decisions SPEC-13 §2 locked (D-1..D-10, user, 2026-07-04).

The gap it fills: both real-world-capture legs ingest *already-solved* geometry and say so.
`services/nerf` (:8002) requires a `transforms.json` — "SfM is out of scope (COLMAP)" (SPEC-11 FR-3;
`services/nerf/app/data_processing/dataparser.py:1-2`), and `services/capture` (:8001) requires an
oriented point cloud or a single depth map — "the photos→points step (SfM/MVS) is COLMAP's job,
upstream" (`services/capture/app/sdf_mlx.py:9-10`). Nothing in the repo turns raw photos into camera
poses or point clouds. ADR-0006 deferred the SfM solvers with an explicit revisit criterion — *"if
Plastiq ever hand-rolls SfM (instead of COLMAP/MLX), port the 5-point solver then"*
(`docs/adr/0006-kornia-geometry-lifts.md:38`) — and the Expanse audit bookmarked kornia's
Nistér/solver/fisheye pieces as *"only relevant if a photogrammetry/SfM front-end ever exists"*
(`docs/audits/Expanse.md:358-368`). That front-end is this service; the revisit criterion has fired.

## Decision

Build a self-hosted **Structure-from-Motion + Multi-View-Stereo** service per SPEC-13: unposed photos
→ classical features/matching → seeded-MSAC two-view geometry → incremental mapping with sparse-LM
bundle adjustment (self-calibrated intrinsics) → normalized scene → `transforms.json` (nerfstudio/
OpenGL) + sparse PLY + MLX plane-sweep **dense oriented point cloud** — feeding both existing legs.

- **Own MVG core, oracle-tested (D-1).** The multi-view-geometry pipeline is written fresh (kornia-
  attributed algorithm ports + the literature); **no COLMAP/pycolmap/torch/kornia at runtime**.
  OpenCV (conda-forge) is a **test-only oracle** (the geomdl role in SPEC-12, never imported by
  `app/`); pycolmap is an optional `importorskip`-gated P7 diagnostic, **not pinned in
  `environment.yml`**. This triggers ADR-0006's revisit clause honestly.
- **Dense MVS required in v1 (D-2).** Both consumer legs must work at v1 exit: poses → nerf *and* a
  dense oriented cloud → capture. Dense = MLX plane-sweep depth (fronto-parallel hypotheses, ZNCC
  cost volumes) + multi-view geometric-consistency fusion (SPEC-13 §5.5), sequenced after the P7
  sparse gate.
- **Classical, weight-free features (D-3).** Scale-space DoG/Harris detection + root-SIFT descriptors
  + mutual-NN/Lowe-ratio matching — deterministic, license-clean, CI-testable on CPU, no downloaded
  checkpoints. Weaker on textureless/reflective parts (NFR-5); learned features are a named v2 path.
- **Emit standard nerfstudio/OpenGL `transforms.json`; fix `services/nerf` in lockstep (D-4, FR-9).**
  `services/nerf` today consumes `transform_matrix` as **+z-forward (OpenCV) camera axes** with **no
  conversion** (`app/data_processing/rays.py:3-4,21`, `dataparser.py:49`, `engine/pipeline.py:77-83`;
  its fixture `tests/synthetic.py:16` matches), so a real nerfstudio/COLMAP (−z OpenGL) file fed to
  today's panel trains garbage. Since this service *produces* those files, it emits the standard
  OpenGL convention and `services/nerf`'s parser gains the OpenGL→internal flip
  (`c2w[0:3, 1:3] *= −1`) in the same lockstep change (P8, SPEC-11 dated note). Fixes the latent
  hazard for **all** `transforms.json` sources.
- **Normalization baked into the emitted poses/points (D-5).** Unlike nerfstudio, which normalizes
  loader-side (`ref/nerfstudio/.../colmap_dataparser.py:66-70,315-326`), the producer up-orients
  (mean camera-up → +z), centers (sparse-point median), and scales (90th-pct radius → 1.0) before
  emitting, recording the similarity in `applied_transform` + `report.normalization`. Required
  because the nerf consumer has a **fixed scene radius** (`_SCENE_RADIUS = 1.5`, marching-cubes over
  `[−1.6, 1.6]³`; `services/nerf/app/engine/pipeline.py:28,119`) — an un-normalized scene clips.
- **Undistort by default (D-6).** The service self-calibrates Brown-Conrady `k1,k2,p1,p2` in bundle
  adjustment, then returns undistorted frames + a zero-distortion `transforms.json` (`services/nerf`
  reads only `fl_x/fl_y/cx/cy/w/h`, `dataparser.py:30-49`, so raw wide-angle frames silently degrade
  training). `undistort:false` keeps the coefficients on the wire for external consumers.
- **Two-tier numerics (D-9, §5.3).** float32 **MLX GPU** for dense raster math (Gaussian pyramids,
  gradient stacks, descriptor-distance matmuls, plane-sweep ZNCC cost volumes); float64 **numpy/scipy
  CPU** for the sparse/combinatorial solvers (RANSAC minimal fits, triangulation, PnP, bundle
  adjustment via `scipy.optimize.least_squares` + analytic `jac_sparsity`). There is no neural model
  here, so the MLX mandate (memory `mlx-m4max-ml-milestones`) binds the *heavy math*, not a training
  loop; sparse LM is a CPU/float64 problem. MLX hot paths use gather+matmul only (scatter is
  non-deterministic). CI-import seam: `emit.py`/`normalize.py`/`exif.py`/`jobs.py` are numpy/pillow-
  only so the MLX-free CI row can run them (NFR-4).
- **Deterministic by seed (D-10).** All RANSAC sampling uses one explicit `np.random.Generator(seed)`
  (request `seed`, default 0); fixed iteration budgets, fixed traversal/tie-break order; no wall-clock
  in any result field. Same input + seed + machine/MLX version → same poses/clouds within float
  tolerance (NFR-1); asserts are tolerance-based, not bitwise (BLAS/GPU reductions are not
  bitwise-stable — stated honestly).
- **Service surface: FastAPI submit→poll on :8004 (FR-6), wire contract frozen in SPEC-13 §6.1**
  (`POST /solve` → poll → `{ transforms_json, images_undistorted?, sparse_ply_base64,
  dense_ply_base64?, report }`, mirroring reconstruct/capture/nerf/nurbs).
  `PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS` default **1** (one SfM+MVS job is the heaviest workload in the
  fleet). P10 must not diverge from that table without updating the client + spec together.
- **Integration: `@plastiq/photogrammetry` client + panel in v1 (D-7).** Net-new
  `packages/photogrammetry` (mirroring `packages/nerf`) plus app wiring
  (`apps/plastiq/src/ai/photogrammetry.ts`, settings, a GenerationPanel `PhotoSolveSection`) with two
  success hand-offs — prefill `NerfCaptureSection` with the emitted `transforms.json` + undistorted
  images, and route the dense cloud into the existing capture flow → `MeshDoc` → "Convert to CAD".
  **Reachable from the running app, not a tested island.**
- **License ledger (R-7):** kornia (**Apache-2.0**) + nerfstudio (**Apache-2.0**) — algorithm/shape
  ports reimplemented with attribution here + in the README. Photogrammetry-examples — **GPLv3
  scripts / CC BY-SA assets: stage-sequence ideas + locally-run test inputs only, zero code/asset
  copying** (`ref/` is gitignored — datasets are skip-if-absent fixtures, never redistributed).
  Photogrammetry-Guide / OpenSpace-Photogrammetry-Guide — **no LICENSE → all rights reserved: facts
  only, no prose reuse**. OpenCV — **test-only oracle, never imported by `app/`**. pycolmap —
  optional local diagnostic, never in `environment.yml`. sdfstudio's legacy `[1,0,2,3]` world
  permutation is explicitly **not** followed (nerfstudio-modern is authoritative).

## Consequences

- New `services/photogrammetry/` filled per SPEC-13 (modular `app/core/*` + `app/mvs/*` +
  `sfm.py`/`normalize.py`/`emit.py`/`exif.py`/`jobs.py`/`main.py`, tests, `environment.yml`,
  `pyproject.toml`, README); net-new `packages/photogrammetry`;
  `apps/plastiq/src/ai/photogrammetry.ts` + settings + `PhotoSolveSection`;
  `photogrammetry:plastiq-photogrammetry:services/photogrammetry:8004` registered in
  `scripts/dev-services.sh` + `justfile` (four services become five). A lockstep change to
  `services/nerf` (the FR-9 OpenGL flip + fixture) lands at P8 with a SPEC-11 dated note.
- **Incremental-SfM robustness is the make-or-break** (R-1) — COLMAP embodies years of hardening we
  do not have. **P7 is the gate**: real photos (`ref/Photogrammetry-examples` datasets) must register
  ≥ 85% with mean reprojection ≤ 1.5px, or work stops and re-plans before the dense (P9), service
  (P10), and client (P11) investment. Failures are honest `failed` jobs carrying the registration
  report — never a fake pose set.
- Strict TDD with oracle-parity suites (OpenCV `findEssentialMat`/`recoverPose`/`solvePnP`/
  `triangulatePoints`/`undistort`) + exact synthetic-scene recovery + a cross-service
  `parse_transforms` contract test + **real M4-Max asserts** (P7 sparse gate, P9 dense run into the
  live capture service) — no stubs (NFR-2). License-clean per the ledger above.

## Honest scope

- **Scale is up to similarity** (NFR-5a) — SfM recovers no metric millimetres; the scene is
  normalized (D-5) and `report.normalization.scale` records the map, but real-world dimensions are
  the user's to set in CAD, and the panel copy says so.
- **Classical features degrade on textureless/reflective/thin mechanical parts** (D-3, R-3) — the
  report's registration counts + `unregistered_names` expose it; capture-guidance copy (photo
  counts/overlap, from the `Photogrammetry-examples` datasets) ships in the panel. Organic/
  appearance-driven output feeds the freeform path (the SPEC-7 R-3 caveat, downstream).
- **Pinhole + Brown-Conrady only** — fisheye (Kannala-Brandt) and equirectangular inputs are out of
  scope; the ADR-0006 fisheye deferral stands (§10).
- **Deploy is out of scope**: MLX requires Apple-Silicon Metal — local-only like capture/nerf/nurbs
  (NFR-4); `.dockerignore` is filled for parity but no Dockerfile ships in v1. CI runs only the
  MLX-free subset (`tests/test_jobs.py tests/test_emit.py`), matching the capture/nerf rows.
