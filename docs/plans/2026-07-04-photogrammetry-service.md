# Plan — `services/photogrammetry/` : the SfM + MVS front-end service (SPEC-13)

**Date:** 2026-07-04
**Spec:** `docs/specs/SPEC-13-photogrammetry-service.md` (identity + scope decisions locked by the
user 2026-07-04: own MVG core / dense MVS in v1 / classical weight-free features / standard-OpenGL
emission + nerf lockstep fix) ·
**ADR:** `docs/adr/0013-photogrammetry-service-architecture.md` — authored in P0.1
**Source ideas:** kornia (Apache-2.0 — MVG algorithm ports with attribution); nerfstudio
`ns-process-data` (Apache-2.0 — `transforms.json` emitter shape); Photogrammetry-examples
(CC BY-SA docs / GPLv3 scripts — stage sequence + gate datasets, **ideas and local test inputs only,
no code**); Hartley & Zisserman; Nistér 2004; Lowe 2004; Schönberger & Frahm 2016; Collins 1996.
Memory: [[photogrammetry-service-spec]], [[mlx-m4max-ml-milestones]],
[[empty-scaffold-files-are-intentional]].
**Execution:** **subagent per task + two-stage review** (user, this session) — one fresh subagent per
task briefed with SPEC-13 + this plan + the task's oracle expectations; after each task (1) the owner
reads the full diff and independently verifies red→green + suite state, (2) an independent review
agent reviews the task's files; findings fixed before the next task. Owner is responsible for every
line (CLAUDE.md sub-agent rules); tasks run in **dependency-ordered waves of up to 3 parallel
agents** (user, this session) — every wave's tasks have provably disjoint file assignments, and the
owner verifies each wave (diff read + suite run + review agents) before the next wave launches.
**Test discipline:** **strict TDD** (user, this session) — every task's failing test written and seen
red before implementation code; subagent reports must show the red run; owner re-runs green.
**Commit:** conventional commits, one per **sub-milestone at green** — **ask before committing**
(user, this session).
**Decisions locked (SPEC-13 D-1..D-10):** own MVG core, OpenCV test-only oracle, no COLMAP/pycolmap/
torch at runtime · dense MVS required in v1 · classical weight-free features · standard nerfstudio/
OpenGL emission + FR-9 nerf lockstep fix · normalization baked into emitted poses (fixed nerf scene
radius) · undistort by default · `@plastiq/photogrammetry` client + panel in v1 · port :8004, env
`plastiq-photogrammetry` · two-tier numerics (f32 MLX GPU raster / f64 numpy-scipy CPU solvers) ·
deterministic by seed (one `np.random.Generator(seed)`, fixed budgets).

## Goal

A self-contained **SfM + MVS** service: unposed photos → classical features/matching → seeded-MSAC
Nistér two-view geometry → incremental mapping with sparse-LM bundle adjustment (self-calibrated
Brown-Conrady intrinsics) → normalized scene → **`transforms.json`** (nerfstudio/OpenGL convention)
+ sparse PLY + **MLX plane-sweep dense oriented point cloud** — feeding both existing legs:
`services/nerf` `/train` (after the FR-9 lockstep parser fix) and `services/capture` `/capture` →
"Convert to CAD". Port **:8004**; wire contract frozen in SPEC-13 §6.1; milestones P0–P12 with the
**P7 real-photo sparse gate** before dense/service/client investment.

## Grounding (verified this session, file:line read directly)

- **SPEC-13** (authored this session): pipeline §5.1, modules §5.2, numerics §5.3, methods §5.4/§5.5,
  wire contract §6.1, emission contract §6.2, milestones P0–P12, risks §9.
- **The consumer defect FR-9 fixes**: `services/nerf/app/data_processing/rays.py:3-4,21` (+z-forward
  ray math), `dataparser.py:49` + `engine/pipeline.py:77-83` (no axis conversion),
  `tests/synthetic.py:16` ("+z forward convention, matching rays.py") — a real nerfstudio/COLMAP
  (−z OpenGL) `transforms.json` trains garbage today.
- **The fixed scene radius D-5 designs for**: `services/nerf/app/engine/pipeline.py:28`
  (`_SCENE_RADIUS = 1.5`), `:119` (`grid_bound = _SCENE_RADIUS + 0.1`),
  `exporters/mesh_exporter.py:43` (`bound = 1.6`).
- **The dense-leg contract**: `services/capture/app/main.py:43` (`MAX_POINTS = 200000`, env
  `CAPTURE_MAX_POINTS`), `:71-74` (`{points: Nx3, normals: Nx3}` body);
  `packages/capture/src/types.ts:14` (`MIN_POINTS = 16`); `packages/capture/src/pointcloud.ts`
  (ASCII-PLY parser by header property position — reads `nx/ny/nz`, skips colors).
- **Panel bound + seams**: `apps/plastiq/src/ai/GenerationPanel.tsx:468` (`MAX_CAPTURE_IMAGES = 300`),
  `:504-608` (`NerfCaptureSection` — transforms + images paired by filename, health pre-check,
  abortable submit); `apps/plastiq/src/ai/settings.ts:25-43` (per-service baseURL/apiKey fields).
- **Ports/registry**: `scripts/dev-services.sh:19-27` (tuples `name:env:dir:port`; :8000–:8003 taken,
  **:8004 free**; header says "four Plastiq Python services"), `justfile:80-92` ("four services",
  ports `:8000/:8001/:8002/:8003`).
- **CI stance**: `.github/workflows/ci.yml:98-135` — MLX training services run only MLX-free tests in
  CI (capture/nerf: `tests/test_jobs.py`); Metal absent on GH macOS runners, `mlx[cpu]` fatally
  crashes the training suites on Linux. The photogrammetry row follows the same pattern (NFR-4).
- **kornia port sources** (all line-verified this session): `essential.py:45` `run_5point`, `:394`
  `null_to_Nister_solution`, `:447/:588/:614` decompose/motion/choose-solution;
  `solvers/polynomial_solver.py:1898` `determinant_to_polynomial`; `fundamental.py:158/:260`
  7/8-point; `triangulation.py:59`; `ransac.py:42`; `calibration/pnp.py:59`;
  `calibration/distort.py:78` + `undistort.py:34`; `_metrics.py:139` Sampson. **kornia has no
  ICP/Umeyama/BA** (`geometry/pointcloud.py` = PLY I/O only) — BA is scipy, Umeyama is a test util.
- **Emitter shape source**: `ref/nerfstudio/nerfstudio/process_data/colmap_utils.py:390-494`
  (`colmap_to_json`; the `c2w[0:3, 1:3] *= -1` flip at `:446`), `:671-715` (`create_ply_from_colmap`
  applies `applied_transform` to points). sdfstudio's legacy `[1,0,2,3]` permutation is **not**
  followed.
- **Gate datasets** (`ref/Photogrammetry-examples`, local-only — `ref/` is gitignored): Stone_Mask
  (14 JPGs), Gorsedd_Stone (48), Pear (143, full 360°); openMVG→MVE/openMVS stage sequence in
  `run_MVG.sh:23-67`, `run_MVE.sh:47-48`, `run_MVS.sh:50-61`.
- **Scaffold state**: `services/photogrammetry/{pyproject.toml,README.md,.dockerignore,.gitignore}`
  all 0-byte; `app/`+`tests/` empty (created 2026-07-03). **Fill, never delete**
  ([[empty-scaffold-files-are-intentional]]).

## Licensing & numerics rules (binding)

- **Ports**: kornia + nerfstudio are Apache-2.0 — reimplement with attribution recorded in ADR-0013 +
  the service README. **Zero code/prose copying** from `Photogrammetry-examples` (GPLv3 scripts /
  CC BY-SA assets — stage-sequence ideas + locally-run test inputs only, never redistributed) and
  from the unlicensed guides (facts only).
- **OpenCV is a test-only oracle** — never imported by `app/` code (grep-able: no `import cv2` in
  `app/`); pycolmap is an optional `importorskip`-gated P7 diagnostic, **not pinned in
  `environment.yml`**.
- **Two-tier numerics (D-9)**: MLX f32 GPU for pyramids/descriptor-distances/plane-sweep volumes;
  numpy/scipy f64 CPU for RANSAC fits, triangulation, PnP, BA. Gather+matmul only in MLX hot paths
  (scatter is non-deterministic); one `np.random.Generator(PCG64(seed))` for all sampling (D-10).
- **Import hygiene for CI (NFR-4)**: `emit.py`, `normalize.py`, `exif.py`, `jobs.py` must be
  importable **without MLX** (numpy/pillow only) so the CI row can run `tests/test_jobs.py
  tests/test_emit.py`; MLX imports live in `core/features.py`, `core/match.py`, `mvs/*` and are
  reached only through `pipeline.py`.

## Honest prerequisites / scope

- **The P7 gate must actually run locally** — the `ref/Photogrammetry-examples` fixtures are
  skip-if-absent so CI stays green, but the gate itself is only passed by a real local run on the
  M4 Max with the datasets present. A skipped gate is NOT a passed gate.
- **Incremental-SfM robustness is the plan's central risk (R-1)** — COLMAP embodies years of
  hardening. The gate sits at P7, *before* dense MVS (P9), service (P10), and client (P11)
  investment. Gate fails ⇒ **stop and re-plan** (options: better init-pair heuristics, guided
  matching, track-merge repair, pycolmap-diagnosed divergence) — never silently lower the bar.
- **Wall-clock honesty**: a 50-photo solve (features + exhaustive matching + BA + dense sweep) is
  minutes on the M4 Max, not seconds; the README documents measured times at P12; the panel's
  abortable submit + `DELETE /jobs/{id}` (Cancel) is the UX answer.
- **Scale is up-to-similarity** (NFR-5a) — no metric millimetres; the panel copy and README say so.
- **Env risk is low** (unlike nurbs's OCCT+MLX combination): conda-forge
  `numpy scipy pillow opencv fastapi uvicorn pydantic httpx pytest` + `pip: mlx` are all
  individually proven in the sibling envs; P0.3 still proves the combined env before any code.
- **Real-but-small in tests**: synthetic fixtures are tiny (≈8 views, ≈64×64–128×128 px, hundreds of
  features) — seconds per suite; asserts are genuine recoveries/improvements (NFR-2), full-quality
  configs documented, not run in CI.

---

# Milestones (scaffold → geometry floor → mapper → gate → nerf fix → dense → service → client → E2E)

**Wave key:** tasks in the same wave (≤ 3 agents, disjoint files) are marked `〔wave n〕` within each
milestone; unmarked tasks are sequential. Milestones themselves are strictly ordered.

## P0 — ADR + scaffold fill + env + registry (fifth service)
- [ ] **P0.1 — ADR-0013** (`docs/adr/0013-photogrammetry-service-architecture.md`, ADR-0011/0012's
      header format): identity (first-party SfM+MVS front-end; the ADR-0006 revisit criterion fired),
      the four locked user decisions + D-5..D-10, license ledger (kornia/nerfstudio Apache-2.0
      ports; GPLv3/CC BY-SA ideas-only; unlicensed guides facts-only; OpenCV/pycolmap test/diagnostic
      only), the FR-9 lockstep rationale (the +z/OpenGL defect, file:line), two-tier numerics,
      port :8004. Tier T2 (self-hosted Python) · Framework MLX + numpy/scipy.
- [ ] **P0.2 — Fill the scaffold** (0-byte files get content; nothing deleted): `pyproject.toml`
      (`plastiq-photogrammetry`, `requires-python >= 3.11`, pytest `testpaths=["tests"]`
      `addopts="-q"` `pythonpath=["."]`, ruff `line-length=110` — nerf's shape), `environment.yml`
      (`name: plastiq-photogrammetry`; conda-forge: `python=3.11 numpy scipy pillow opencv fastapi
      uvicorn pydantic httpx pytest pip`; `pip: [mlx]`; comment marking `opencv` as the test-only
      oracle), `.gitignore`/`.dockerignore` (nurbs's contents incl. the `!tests/fixtures/*` allow),
      `README.md` (nerf format: SPEC-13/ADR-0013 links, §5.1 pipeline map, §6.1 API table, run/test
      sections, honest scope incl. up-to-similarity scale + wall-clock note), `app/__init__.py` +
      `app/core/__init__.py` + `app/mvs/__init__.py` + `tests/__init__.py`.
- [ ] **P0.3 — Env + registry.** Create the env (`mamba env create -f environment.yml`); prove
      `import mlx.core`, `import cv2`, `import scipy.optimize`, `from PIL import Image` and a 1-line
      MLX op **in the same interpreter**. Register
      `photogrammetry:plastiq-photogrammetry:services/photogrammetry:8004` in
      `scripts/dev-services.sh` (+ its "four Plastiq Python services" header comment → five, port
      list line), update the `justfile` §services comments/ports (`:8000/:8001/:8002/:8003/:8004`)
      and its `services-stop` comment, and the root README's `just services` line (four → five).
      `just services` brings all five up (`/health`-gated for the four implemented ones;
      photogrammetry's uvicorn target lands at P10 — the registry entry is added here but commented
      with a "lands P10" marker so `dev-services.sh` stays green, flipped live in P10.2). Verified
      by running `just services` and `just services-stop`.

## P1 — synthetic fixture + EXIF prior + features (the detector/descriptor floor)
- [ ] **P1.1 — TDD `tests/synthetic.py` (fixture generator) + `app/exif.py`**: a committed
      generator producing a procedurally-textured scene (noise-textured plane + box, numpy
      rasterization with z-buffer) rendered from N known poses with known pinhole K (and optional
      known Brown-Conrady distortion) → `(images, K, w2c poses, depth maps, visibility)` — the
      ground-truth bed for P1–P6/P9. `exif.py`: EXIF focal read (pillow), 35mm-equiv → px
      (`f·max(w,h)/36`), `1.2·max(w,h)` fallback, principal point at center. Tests (red first):
      fixture reprojection self-consistency (a rendered point's depth/pixel round-trips); EXIF on a
      crafted JPEG with `FocalLengthIn35mmFilm`; fallback path; degenerate-size errors.
- [ ] **P1.2 — TDD `core/features.py` detector**: Gaussian pyramid + DoG extrema (3σ intervals),
      contrast + Harris/Hessian edge rejection, subpixel interpolation, dominant orientation — MLX
      pyramids/gradients, numpy bookkeeping, `max_features` cap. Tests: ≥ 100 keypoints on the
      synthetic texture; **repeatability** — warp the image by a known homography, ≥ 50% of
      keypoints reproject onto a detected keypoint within 2px; determinism (two runs identical).
- [ ] **P1.3 — TDD `core/features.py` descriptor**: 4×4×8 gradient-histogram descriptor,
      trilinear binning, root-SIFT normalization (MLX batched patch extraction). Tests: matching the
      synthetic pair by mutual-NN recovers ≥ 70% ground-truth correspondences (fixture visibility
      oracle); **OpenCV-oracle parity** — on the same pair, our detector+descriptor's verified-inlier
      match count reaches ≥ 60% of `cv2.SIFT_create()`'s under the same ratio test; real-pair
      smoke on `ref/Photogrammetry-examples/Stone_Mask` (skip-if-absent): ≥ 200 ratio-test matches.

## P2 — matching + two-view geometry (the Nistér core)
- [ ] **P2.1 — TDD `core/match.py`** 〔wave 1〕: MLX matmul distance matrices (descriptors are
      L2-normalized → dot-product distances), mutual-NN + Lowe ratio 0.8, exhaustive and
      sequential-window-8 pair schedules. Tests: planted-descriptor recovery; ratio test rejects
      planted ambiguous matches; schedule tests (pair counts for N images, window edges);
      determinism.
- [ ] **P2.2 — TDD `core/epipolar.py` — 8-point + Sampson** 〔wave 1〕: Hartley-normalized 8-point
      fundamental, Sampson distance. Tests: noise-free synthetic correspondences → F recovered
      (algebraic residual < 1e-9, all Sampson < 1e-6); Sampson matches an independent numpy
      formula on random data; **OpenCV parity** `cv2.findFundamentalMat(FM_8POINT)` to tolerance.
- [ ] **P2.3 — TDD `core/epipolar.py` — Nistér 5-point + pose**: 5×9 nullspace, the ten cubic
      constraints (kornia's `multiply_deg_*_poly` expansion tables reimplemented), Gauss-Jordan
      reduction, degree-10 polynomial (`determinant_to_polynomial` tables), companion-matrix real
      roots, candidate E assembly; `decompose_essential` + cheirality-checked `(R,t)` selection
      (triangulate inliers, most-points-in-front). Tests: for 20 fixed-seed synthetic camera pairs,
      noise-free 5-point sets → some candidate E matches ground truth (‖E−Ê‖ < 1e-6 up to
      sign/scale); chosen `(R,t)` matches ground truth (rotation angle < 0.1°, translation
      direction < 0.5°); **OpenCV parity** on noisy sets (`cv2.findEssentialMat` +
      `cv2.recoverPose` — same inlier pose within 1°).

## P3 — robust estimation (RANSAC, PnP, triangulation)
- [ ] **P3.1 — TDD `core/ransac.py`** 〔wave 1〕: seeded MSAC for E/F/PnP model kinds — minimal-sample
      batches from the one `Generator`, Sampson (E/F) / reprojection (PnP) scoring, adaptive
      early-stop by inlier-ratio confidence, best-model local-optimization refit on inliers. Tests:
      30% gross outliers on synthetic E/F/PnP problems → recovered inlier set ⊇ 95% of planted
      inliers, 0 planted outliers; identical results across two runs (same seed) and different
      results allowed across seeds; budget respected.
- [ ] **P3.2 — TDD `core/pnp.py`** 〔wave 1〕: DLT-PnP (≥ 6 pts, normalized), collinear/coplanar
      degeneracy detection, LM reprojection refinement (scipy). Tests: exact recovery noise-free;
      noisy → refined reprojection strictly below DLT's; coplanar config → clear error (not a wrong
      pose). (Integration under the P3.1 RANSAC wrapper is asserted in P5's mapper tests — P3.2's
      own tests stay self-contained so the P3 wave's files remain disjoint.)
- [ ] **P3.3 — TDD `core/triangulate.py`** 〔wave 1〕: two-view DLT (eigh solver), cheirality gate,
      reprojection gate, parallax-angle gate. Tests: exact triangulation noise-free (< 1e-8);
      behind-camera points rejected; low-parallax pairs rejected at the 1.5° gate; batch API
      shape/determinism.

## P4 — bundle adjustment (the f64 sparse-LM floor)
- [ ] **P4.1 — TDD `core/ba.py` residuals + sparsity**: angle-axis pose parameterization,
      Brown-Conrady projection residuals (2 per observation), shared-intrinsics block
      `(f, cx, cy, k1, k2, p1, p2)`, analytic `jac_sparsity` (CSR). Tests: residuals at ground truth
      = 0; the sparsity pattern equals the finite-difference nonzero pattern on a tiny 3-cam/10-pt
      problem; parameter packing round-trips.
- [ ] **P4.2 — TDD `core/ba.py` optimization**: `scipy.optimize.least_squares(method="trf",
      loss="huber", jac_sparsity=…)`, options for fixed-vs-free intrinsics (free after 8 registered
      views — §5.4-3), capped iterations. Tests: noisy synthetic scene (0.5px noise, perturbed poses)
      → mean reprojection < 0.5px and intrinsics recovered within 2%; planted 5% outlier
      observations do not break convergence (Huber); deterministic; local-BA subset mode (only newest
      views free) converges.

## P5 — the incremental mapper (sparse SfM end-to-end)
- [ ] **P5.1 — TDD `app/sfm.py` tracks + init**: union-find track building across pair matches
      (consistency: one feature per image per track, conflicting merges dropped), init-pair selection
      (inliers × median triangulation angle). Tests: planted multi-view tracks recovered;
      conflicting-match tracks rejected; on the synthetic scene the chosen init pair is one of the
      wide-baseline pairs (oracle set).
- [ ] **P5.2 — TDD `app/sfm.py` mapper loop + filters + `tests/umeyama.py`**: register-next-view
      (most visible tracks → P3 PnP-RANSAC → LM), triangulate new tracks (P3.3 gates), local BA per
      registration, global BA every 5 + final (P4), the §5.4-4 filters (track ≥ 3, reproj ≤ 4px,
      angle ≥ 1.5°), registration bookkeeping (`unregistered_names`). Test util: Umeyama similarity
      alignment (written fresh — kornia has none). Tests: the 8-view synthetic scene registers 8/8;
      Umeyama-aligned camera-center RMSE < 1% of scene diameter; point cloud non-degenerate
      (> 80% of planted structure triangulated); a deliberately-broken image (pure noise appended)
      lands in `unregistered_names` without sinking the rest; deterministic by seed.

## P6 — normalization, undistortion, emission (the producer contracts)
- [ ] **P6.1 — TDD `app/normalize.py`** 〔wave 1〕: mean-camera-up → +z orientation, sparse-point
      median centering, 90th-percentile-radius → 1.0 scaling; the similarity recorded as
      `applied_transform` (3×4) + `scale`. Tests: normalized cloud properties (median ≈ 0, p90
      radius ≈ 1, mean up ≈ +z); applying the recorded inverse recovers solver-frame coordinates
      (< 1e-10); poses and points transformed consistently (reprojection invariant).
- [ ] **P6.2 — TDD `core/distortion.py`** 〔wave 1〕: Brown-Conrady distort/undistort for points
      (iterative inverse, convergence-capped) and images (inverse-map bilinear resample, MLX or
      numpy — CPU is fine at ≤ 300 frames), post-undistortion K. Tests: distort→undistort point
      round-trip < 1e-6 px across the field; **OpenCV parity** — `cv2.undistortPoints` and
      `cv2.undistort` (image, PSNR > 40dB vs ours) on the synthetic distorted fixture; zero-coeff
      no-op.
- [ ] **P6.3 — TDD `app/emit.py` + the consumer contract test**: §6.2 emitter (field set, OpenCV→
      OpenGL flip `c2w[0:3,1:3] *= −1`, shared intrinsics, `applied_transform`, zeroed distortion
      when undistorted, `frames[].file_path = ./images/<name>`), ASCII-PLY writers (sparse
      `x y z r g b`; dense `x y z nx ny nz r g b`). Tests: emitted JSON parses through the **real**
      `services/nerf` `parse_transforms` (sys.path import of the sibling service, documented in the
      test) — fx/fy/cx/cy/w/h + per-frame c2w round-trip; PLY writers round-trip through a tiny
      in-test reader (header property positions match `packages/capture/src/pointcloud.ts`'s
      documented expectations); a committed `tests/fixtures/dense_sample.ply` is emitted for P11's
      vitest cross-parse. `emit.py`/`normalize.py`/`exif.py` import MLX-free (test asserts no `mlx`
      in their import chain — the NFR-4 CI seam).

## P7 — the sparse identity GATE ⭐ (real photos, local M4 Max)
- [ ] **P7.1 — TDD the gate** (`tests/test_gate_real.py`, skip-if-absent on
      `ref/Photogrammetry-examples`): full sparse pipeline (P1→P6 composed in `app/pipeline.py`,
      sparse half) on **Stone_Mask (14)** and **Gorsedd_Stone (48)**: ≥ 85% of images registered,
      mean reprojection ≤ 1.5px, mean track length ≥ 3, emitted transforms.json + sparse PLY
      well-formed. **The gate passes only on a real local run** — record the measured numbers in
      this plan and SPEC-13 §8 when run. **Gate fails ⇒ STOP and re-plan before P8+.**
- [ ] **P7.2 — pycolmap diagnostic (optional, importorskip)**: side-by-side pose comparison on the
      gate datasets (camera-center deltas after Umeyama alignment, registration counts) — a
      diagnosis aid recorded in the task report, **not** an assert gate; pycolmap installed ad-hoc,
      never added to `environment.yml`.

## P8 — FR-9: the nerf lockstep fix (one change, three files + spec note)
- [ ] **P8.1 — TDD the OpenGL→internal flip**: failing test first — feed an OpenGL-convention
      `transforms.json` (P6.3 emitter output) through `services/nerf` `parse_transforms` +
      `generate_rays` and assert the center ray aims at the scene (fails today);
      then `dataparser.py` applies `c2w[0:3, 1:3] *= −1` at parse, `tests/synthetic.py` `look_at`
      emits OpenGL poses (forward = −z), existing assertions updated to the new convention.
      **Same change:** SPEC-11 §5/FR-3 dated additive note (2026-07-04 style); SPEC-13 §1/FR-9
      status. Full nerf suite (63) green in the `plastiq-nerf` env — owner-verified run.

## P9 — dense MVS (D-2: required for v1) ⭐
- [ ] **P9.1 — TDD `mvs/plane_sweep.py`**: neighbor selection (K=4 by baseline angle), 96
      fronto-parallel hypotheses over the view's sparse depth range ±20%, homography-warped
      neighbor stacks, 5×5 ZNCC cost (MLX GPU), WTA + parabolic refine, depth→normals
      (gradient cross-product, sign toward camera). Tests: on the synthetic scene, ≥ 70% of
      textured pixels within 1% depth error (fixture depth-map oracle); median normal·truth > 0.9;
      deterministic; MLX path exercised (importorskip-gated on Apple Silicon).
- [ ] **P9.2 — TDD `mvs/fusion.py`**: multi-view consistency (≥ 2 views, |Δd|/d < 1%, normal
      dot > 0.7), world unprojection (normalized frame), deterministic voxel-grid downsample to
      ≤ `PHOTOGRAMMETRY_MAX_DENSE_POINTS` (200k default). Tests: planted-bad-depth pixels killed;
      consistent pixels survive; cap enforced exactly; voxel keys deterministic; fused cloud's
      points lie on the synthetic surfaces (median distance < 1% of scene diameter).
- [ ] **P9.3 — Real M4-Max dense run + capture hand-off** (skip-if-absent + service-gated):
      the gate dataset through sparse+dense → ≥ 50 000 fused oriented points; the dense PLY POSTed
      to a live `services/capture` `/capture` (:8001) → real mesh (`faces > 100`). Measured
      wall-clock + point counts recorded in this plan + the service README.

## P10 — the FastAPI service (frozen §6.1 contract)
- [ ] **P10.1 — TDD `app/jobs.py`**: `JobStore` mirroring capture/nurbs (states
      `{queued,running,completed,failed}`, TTL + max-count eviction, `running_count()`). Asyncio
      tests: complete-with-result, failure captures error, unknown id, eviction, running-count.
      MLX-free import (the CI row runs this file).
- [ ] **P10.2 — TDD `app/main.py` + `app/logging_setup.py`**: SPEC-13 §6.1 verbatim (`POST /solve`
      params/bounds incl. `names` length validation, status/result/delete/health,
      200/400/409/422/404/500), `PHOTOGRAMMETRY_API_KEY` bearer (constant-time, per-request read;
      401 tests; unset ⇒ open), `PHOTOGRAMMETRY_CORS_ORIGINS`, `PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS`
      default **1** → 429, per-image byte + count caps, `asyncio.to_thread` worker, lazy pipeline
      import (main.py imports `pipeline` inside the worker so the module graph stays MLX-free for
      validation-path tests), startup config log (never the key). **Real submit→poll→result API
      test** (`httpx.ASGITransport`, no mocks): a tiny synthetic photo set end-to-end →
      `{transforms_json, sparse_ply_base64, dense_ply_base64, report}`; auth/429/validation/409/404
      paths. Flip the P0.3 registry entry live: `just services` brings all **five** up — verified.
- [ ] **P10.3 — CI matrix row** (`.github/workflows/ci.yml`): `service: photogrammetry` with
      `pytest-args: tests/test_jobs.py tests/test_emit.py`; the job comment block gains the
      photogrammetry line (same Metal/mlx-cpu rationale). CI dry-run: those two files pass in a
      fresh env without MLX (locally simulated via `python -m pytest tests/test_jobs.py
      tests/test_emit.py` in a no-mlx venv).

## P11 — `@plastiq/photogrammetry` + app wiring (REACHABLE — not a tested island)
- [ ] **P11.1 — TDD the client package** (`packages/photogrammetry/{package.json, tsconfig.json,
      src/{index,types,client}.ts}`, mirroring `packages/nerf` file-for-file; pnpm workspace +
      coverage barrel-exclude): `solvePhotos(input, opts)` submit→poll per §6.1, `cancelJob`,
      `DEFAULT_BASE_URL = "http://localhost:8004"`, snake→camel mapping, Bearer on every request
      when keyed, `onJob` callback. Vitest scripted-fetch tests (submit→poll→result, failed job,
      poll timeout, 429 surface, auth header, cancel-on-204-and-404) + **the P6.3
      `dense_sample.ply` fixture parsed by the real `@plastiq/capture` `parsePointCloudFile`**
      (the cross-package contract, in vitest) + `typecheck` green.
- [ ] **P11.2 — App wiring**: `photogrammetryBaseURL`/`photogrammetryApiKey` settings
      (`src/ai/settings.ts` + SettingsPanel fields `settings-photogrammetry-url`/`-key`),
      `src/ai/photogrammetry.ts` adapter, **`PhotoSolveSection`** in the GenerationPanel (testid
      `photo-solve`): photos-only picker (`MAX_CAPTURE_IMAGES` reused), `GET /health` pre-check +
      `serviceUnreachableMessage("photogrammetry", …)`, abortable submit→poll, Cancel → DELETE,
      capture-guidance copy (photo counts from NFR-5b), and the two success hand-offs — (a)
      prefill `NerfCaptureSection` (transforms + undistorted images, filename pairing), (b) dense
      cloud → `meshFromPointCloud` → `MeshDoc` → Convert-to-CAD. RTL unit tests mirroring
      `GenerationPanel.capture.test.tsx` (mock `solvePhotos`; both hand-offs asserted; error/cancel
      paths); SettingsPanel tests (default/prefill/persist/clear — the capture-url suite's shape);
      app `tsc` + full vitest suites green.

## P12 — browser E2E + docs reconciliation (the U11 pattern)
- [ ] **P12.1 — Browser E2E** (`e2e/plastiq/photogrammetry.spec.ts`, service-gated on :8004
      `/health` — `nerf.spec.ts` precedent): a small committed photo fixture (synthetic-scene JPEGs,
      generated by the P1.1 generator via a committed script — not ref/ assets) → `PhotoSolveSection`
      → live solve → dense hand-off → live capture service → mesh renders (`meshBodyCount() > 0`)
      and the panel reaches Convert-to-CAD; the nerf-prefill leg asserted to the prefilled-section
      state (transforms + images populated). **Run live on the M4 Max** (photogrammetry + capture
      services up) and record the result here + SPEC-13 §8.
- [ ] **P12.2 — Docs reconciliation**: SPEC-13 milestone statuses + any drifted §5/§6 details;
      `services/photogrammetry/README.md` final API/report fields + measured wall-clocks; root
      README (five-service text final); ADR-0013 consequences; memory
      [[photogrammetry-service-spec]] updated (gate numbers, final test tallies). Re-read every
      touched doc and confirm it reads true (CLAUDE.md doc-accuracy rule). Full sweep: photogrammetry
      pytest (env), nerf (63), capture (43), reconstruct (93), nurbs, app vitest + `tsc` +
      `just lint` — zero regressions.

---

## Cross-cutting completion gate (every task, every milestone)

1. **Strict TDD honored** — the failing test existed and was seen red before code; the subagent's
   report must include the red evidence; the owner re-runs it green.
2. **Two-stage review** — (a) owner reads the full diff and verifies claims against the actual
   code/output (never trust a subagent's summary); (b) independent review agent on the task's files;
   findings fixed before the next task starts.
3. **Waves of ≤ 3** — parallel tasks only within a marked wave, provably disjoint files; the owner
   verifies each wave (diff read + suite run + review agents) before launching the next.
4. **Real solves, no stubs** — P7/P9 asserts are genuine registrations/reconstructions from real
   M4-Max runs on real photos; synthetic asserts are exact-recovery, not smoke.
5. **Suites green, zero regressions** — `services/photogrammetry` pytest every task; plus
   per-milestone: nerf (63) at P8, capture at P9.3, `vitest`/`tsc`/`just lint` when P11 touches TS;
   full sweep at P12.2.
6. **Deterministic** — one seeded `Generator`; no `mx.random`/`np.random.seed` globals in `app/`
   (grep-able); identical runs → identical results within tolerance (tested).
7. **Docs current in the same change** — SPEC-13 milestone statuses flip as they ship; any
   module/contract drift lands in SPEC-13 in the same commit (CLAUDE.md doc-accuracy rule).
8. **Commit per sub-milestone at green** — conventional message — **after asking**.
9. **License hygiene** — no `import cv2`/`pycolmap` in `app/`; no code from GPLv3/CC BY-SA/unlicensed
   ref/ repos; kornia/nerfstudio attribution present in ADR-0013 + README (checked at review).

## Sequencing rationale

The synthetic fixture (P1.1) is the oracle bed everything sparse stands on; features → matching →
two-view (P1–P2) → robust estimation (P3) → BA (P4) build the numerical floor bottom-up, each
oracle-verified before the next consumes it; the mapper (P5) composes them and is proven on ground
truth before any real photo; normalization/undistortion/emission (P6) pin the producer contracts —
including the cross-service `parse_transforms` proof — *before* the gate judges quality. **P7 is the
gate**: real-photo sparse SfM is the service's reason to exist and its biggest risk (R-1), so it must
pass before the nerf lockstep change (P8, kept small and separate for lockstep discipline), the dense
investment (P9, required for v1 per D-2), the service (P10), the client (P11), and the E2E (P12).
P0.3 front-loads the (low) env unknown; the CI-importable seam (`emit`/`jobs` MLX-free) is designed
in at P6/P10, not retrofitted. Docs last (P12.2), current throughout (gate #7).
