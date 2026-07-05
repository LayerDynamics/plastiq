# plastiq-photogrammetry — first-party SfM + MVS front-end

A self-hosted service that turns **unposed photos** into **camera poses** (a nerfstudio/Blender
`transforms.json`), a **sparse point cloud**, and a **dense oriented point cloud** — the
Structure-from-Motion + Multi-View-Stereo front-end that SPEC-10/ADR-0007 twice deferred as "COLMAP's
job, not built here". Built first-party so the full **photos → CAD** chain runs inside Plastiq with no
external tools: this service feeds both [`services/nerf`](../nerf) (`transforms.json` → trained field
→ mesh) and [`services/capture`](../capture) (dense oriented cloud → watertight mesh), each of which
flows into the existing "Convert to CAD" (mesh → B-rep) path.

The multi-view-geometry core is written fresh from the literature (kornia's algorithms, Apache-2.0,
ported with attribution) — **no COLMAP/pycolmap/torch at runtime**. The dense MVS raster math runs in
**MLX** on the **M4 Max**; the sparse solvers run on **numpy/scipy** (float64). See
[`docs/adr/0013`](../../docs/adr/0013-photogrammetry-service-architecture.md),
[SPEC-13](../../docs/specs/SPEC-13-photogrammetry-service.md), and the plan
[`docs/plans/2026-07-04-photogrammetry-service.md`](../../docs/plans/2026-07-04-photogrammetry-service.md).

## Pipeline

```text
app/exif.py            EXIF focal / 35mm-equiv → px intrinsics prior (pillow)
app/core/features.py   scale-space DoG detector + root-SIFT descriptor (MLX pyramids)
app/core/match.py      mutual-NN + Lowe-ratio matching, exhaustive / sequential schedules (MLX)
app/core/epipolar.py   normalized 8-point F, Nistér 5-point E, pose decomposition + cheirality, Sampson
app/core/ransac.py     seeded MSAC (E / F / PnP), adaptive stop, local-optimization refit
app/core/pnp.py        DLT-PnP + LM reprojection refinement (view registration)
app/core/triangulate.py two-view DLT triangulation + cheirality / reprojection / parallax gates
app/core/ba.py         sparse-LM bundle adjustment (scipy least_squares + analytic jac_sparsity)
app/core/distortion.py Brown-Conrady distort / undistort (points + images)
app/mvs/plane_sweep.py MLX plane-sweep stereo: ZNCC cost volumes → depth + normals
app/mvs/fusion.py      multi-view consistency fusion → dense oriented point cloud
app/sfm.py             incremental mapper: tracks → init pair → register / triangulate / BA
app/normalize.py       up-orient / center / scale similarity (baked into emitted poses)
app/emit.py            transforms.json (nerfstudio/OpenGL) + ASCII PLY writers
app/pipeline.py        solve(payload) → result (the service entrypoint)
app/jobs.py            in-memory JobStore (submit → poll), TTL + max-count eviction
app/main.py            FastAPI submit → poll (:8004), auth / CORS / concurrency caps
```

## API (submit → poll, mirrors capture/nerf/nurbs)

The frozen wire contract is [SPEC-13 §6.1](../../docs/specs/SPEC-13-photogrammetry-service.md); the
`@plastiq/photogrammetry` browser client is written to it.

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/health` | `{ status, service }` |
| `POST` | `/solve` | `{ images, names?, matching?, dense?, undistort?, max_features?, seed? }` → `{ id, state }` |
| `GET` | `/jobs/{id}/status` | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET` | `/jobs/{id}/result` | `{ transforms_json, images_undistorted?, sparse_ply_base64, dense_ply_base64?, report }` |
| `DELETE` | `/jobs/{id}` | `204` — job dropped (cancel/cleanup; an in-flight worker's result is discarded); `404` unknown id |

`PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS` defaults to **1** (one SfM+MVS job is the heaviest workload in
the service fleet); submits beyond it get `429`. `PHOTOGRAMMETRY_API_KEY`, when set, requires
`Authorization: Bearer <key>` on `POST /solve` + `DELETE /jobs/{id}` (unset ⇒ open dev default).

## Browser client (`@plastiq/photogrammetry`)

The TS side is its own workspace package [`packages/photogrammetry`](../../packages/photogrammetry)
(`@plastiq/photogrammetry`): `solvePhotos(input, opts)` submits a `/solve` job, polls, and returns
`{ transformsJson, imagesUndistorted?, sparsePly, densePly?, report }`. `apps/plastiq` wires it via
`src/ai/photogrammetry.ts` and a **`PhotoSolveSection`** panel with two hand-offs — prefill the
NeRF "Capture from photos" section with the emitted `transforms.json` + undistorted images, and route
the dense cloud into the point-cloud → mesh capture flow. Base URL configured by the
`photogrammetryBaseURL` setting.

## Run locally (Apple Silicon)

One command (repo root) starts **all five** Plastiq services — reconstruct :8000, capture :8001,
nerf :8002, nurbs :8003, photogrammetry :8004 — creating any missing conda env from its
`environment.yml` first:

```bash
just services          # scripts/dev-services.sh; `just services-stop` frees stray listeners
```

Or run just this service manually:

```bash
mamba env create -f environment.yml          # conda-forge + pip mlx
mamba run -n plastiq-photogrammetry uvicorn app.main:app --port 8004
```

Job lifecycle and rejected submits are logged via Python `logging` (INFO default —
`PHOTOGRAMMETRY_LOG_LEVEL` overrides); the startup line summarizes the CORS/auth/cap config without
ever printing the API key.

## Test

```bash
mamba run -n plastiq-photogrammetry python -m pytest -q
```

Strict TDD: OpenCV-oracle parity for every geometry primitive (features, essential/fundamental, PnP,
triangulation, undistortion), exact synthetic-scene recovery for the mapper, a cross-service contract
test that parses the emitted `transforms.json` through the real `services/nerf` parser, and **real
M4-Max asserts** — the sparse identity gate registers real photographs and the dense stage drives the
live capture service to a real mesh. OpenCV is a **test-only oracle** (never imported by `app/`);
`ref/Photogrammetry-examples` gate datasets are skip-if-absent local fixtures.

## Scope (honest)

- **Scale is up to similarity** — SfM recovers no metric millimetres; the scene is normalized and the
  report records the map, but real-world dimensions are set by the user in CAD.
- **Classical features degrade** on textureless/reflective/thin mechanical parts; the report's
  registration counts + `unregistered_names` expose it. Learned features are a named v2 upgrade path.
- **Pinhole + Brown-Conrady only** — fisheye/equirectangular inputs are out of scope.
- **Deploy is out of scope** — MLX requires Apple-Silicon Metal; local-only like capture/nerf/nurbs.
