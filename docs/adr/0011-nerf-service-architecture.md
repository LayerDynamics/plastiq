# ADR 0011 — `services/nerf/` : a modular MLX NeRF / radiance-field service

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-22-nerf-service.md`
**Tier:** T2 (self-hosted Python) · **Source idea:** nerfstudio (Apache-2.0) · **Framework:** MLX (Apple Silicon)

## Context

`Expanse.md` identified photogrammetry (posed images → mesh) as a net-new capability. M7 shipped the
*surface-reconstruction half* (point cloud → MLX SDF → mesh) in `services/capture/`. `services/nerf/`
is the **fuller, modular radiance-field service**: posed *images* → a trained field → mesh, modeled on
nerfstudio's well-factored architecture so the pieces (encodings, samplers, renderers, fields, models)
are independently testable and composable.

## Decision

Build a **self-contained MLX** NeRF service mirroring nerfstudio's module layout.

- **License / provenance:** nerfstudio is **Apache-2.0** (`ref/nerfstudio/LICENSE`). We reuse its
  *architecture/idea* (the module decomposition: `field_components` / `model_components` / `fields` /
  `models` / `data` / `engine` / `exporter`), not its code — it is **CUDA-only** (tiny-cuda-nn,
  PyTorch) and won't run on Apple Silicon. Every component is **own MLX code** (`mlx.core`/`mlx.nn`).
- **MLX-native, M4 Max** (binding directive, memory [[mlx-m4max-ml-milestones]]): fields, encoders,
  samplers, renderers, the Trainer — all MLX. numpy only at boundaries (transforms.json parse, image
  I/O, `skimage` marching-cubes, GLB export). **Deterministic via explicit MLX keys** (`mx.random.key`).
- **Two models:** a **VanillaNeRF** (density+color, volume rendering; frequency encoding, then a
  multiresolution hash-grid upgrade) and a **NeuS/VolSDF SDF surface** model (watertight zero-level-set
  mesh — the cleanest input to reconstruct→B-rep, with an eikonal loss). Density NeRF first (testable
  core), then the SDF model.
- **SfM is NOT built — deferred to COLMAP.** Camera poses are ingested via a `transforms.json`
  (nerfstudio/Blender convention). The training tests are driven by a **synthetic-pose fixture**
  (analytic render of a known sphere/cube from N poses), so the MLX training is real + reproducible
  without COLMAP. (Mirrors M6/M7's deferral of SfM for the same reason.)
- **Reuse the established seams:** the MLX + FastAPI submit→poll + GLB→`MeshDoc`→reconstruct patterns
  from `services/capture/`; the MLX pinhole ray math from `services/capture/app/geometry.py`.
- **Full app integration (this time):** unlike the capture service, `services/nerf/` ships a browser
  client (`apps/plastiq/src/ai/nerf.ts`, mirroring `reconstruct.ts`) wired into the existing
  "Convert to CAD" reconstruct path — **reachable from the running app, not a tested island** (the gap
  the Expanse integration ledger flagged).

## Consequences

- New `services/nerf/` (modular `app/*`, tests, `environment.yml` with `pip: mlx`, `pyproject.toml`,
  README); `apps/plastiq/src/ai/nerf.ts` + a `nerfBaseURL` setting; `SPEC-11`.
- Strict TDD with **real MLX training asserted on the M4 Max** (PSNR improves; SDF mesh roughly correct)
  — no stubs. Deterministic. License-clean (own MLX implementation; nerfstudio Apache-2.0 idea credit).

## Honest scope

The demo trains on synthetic scenes (and any real `transforms.json` you provide). Quality on real
captures depends on pose accuracy (COLMAP) and training budget; organic scenes reconstruct to organic
meshes (the same NFR-4 caveat reconstruct carries). General high-fidelity captures want longer training
than the CI-time tests run — documented, not faked.
