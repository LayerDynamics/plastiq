# plastiq-nerf — modular MLX NeRF / radiance-field service

A self-hosted service that turns **posed images** (a nerfstudio/Blender `transforms.json` + frames,
poses from COLMAP) into a trained radiance/SDF field and exports a **mesh** that flows into Plastiq's
existing `MeshDoc` → reconstruct (mesh→B-rep) path. Modeled on
[nerfstudio](https://github.com/nerfstudio-project/nerfstudio)'s architecture (Apache-2.0, **idea
only**) but a self-contained **MLX** implementation — the CUDA repo won't run on Apple Silicon. Trains
on the **M4 Max**. See [`docs/adr/0011`](../../docs/adr/0011-nerf-service-architecture.md) and
[SPEC-11](../../docs/specs/SPEC-11-nerf-service.md). Plan:
[`docs/plans/2026-06-22-nerf-service.md`](../../docs/plans/2026-06-22-nerf-service.md).

## Architecture (mirrors nerfstudio, in MLX)

```text
app/field_components   positional/hash encodings, MLP, density/RGB heads, activations  (mlx.nn)
app/generators         ray samplers (uniform, PDF/importance)
app/model_components    volumetric renderer (RGB/accum/depth), losses (MSE, eikonal)
app/fields             radiance field (NeRF density+color) + SDF field (NeuS/VolSDF)
app/models             full models: VanillaNeRF (+hash-grid), VolSDFModel surface model (neus.py)
app/data_processing    transforms.json parser → DataparserOutputs, MLX ray generation
app/engine             Trainer (MLX Adam + value_and_grad loop), submit→poll jobs
app/exporters          field → marching-cubes mesh → GLB / point cloud
app/utils              config, deterministic MLX seeding, math
```

## Two models

- **VanillaNeRF** — density+color field, volume rendering (novel-view synthesis); marching-cubes the
  density for a mesh. Frequency encoding, then a multiresolution hash-grid (instant-NGP) upgrade.
- **VolSDF** (`VolSDFModel`, the NeuS/VolSDF family) — an SDF field trained from images via the VolSDF
  Laplace SDF→density transform + the eikonal loss; its watertight zero-level-set mesh is the cleanest
  input for reconstruct→B-rep. The **default** `/train` model.

## API (submit → poll, mirrors capture/reconstruct)

The frozen wire contract is [SPEC-11 §5](../../docs/specs/SPEC-11-nerf-service.md); the `@plastiq/nerf`
browser client is written to it. `method` defaults to `neus` (VolSDF surface — the cleanest mesh for
reconstruct).

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/health` | `{ status, service }` |
| `POST` | `/train` | `{ transforms_json, images, iters?, method?, grid_res? }` → `{ id, state }` |
| `GET` | `/jobs/{id}/status` | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET` | `/jobs/{id}/result` | `{ glb_base64, vertices, faces, psnr, method, iters }` when completed |

## Browser client (`@plastiq/nerf`)

The TS side is its own workspace package [`packages/nerf`](../../packages/nerf) (`@plastiq/nerf`, a
sibling of `@plastiq/cad`/`@plastiq/sim`): `trainNerf(input, opts)` submits a `/train` job, polls, and
returns `{ glb, report }`. `apps/plastiq` wires it via `src/ai/nerf.ts` (`captureFromPhotos`) and a
**"Capture from photos"** panel — the produced GLB becomes a `MeshDoc` (`mode: "photos3d"`) that flows
into the existing "Convert to CAD" (mesh → B-rep) path. Base URL configured by the `nerfBaseURL` setting.

## Run locally (Apple Silicon)

One command (repo root) starts **all three** Plastiq services — reconstruct :8000, capture
:8001, nerf :8002 — creating any missing conda env from its `environment.yml` first, with
name-prefixed logs and clean Ctrl-C shutdown:

```bash
just services          # scripts/dev-services.sh; `just services-stop` frees stray listeners
```

Or run just this service manually:

```bash
mamba env create -f environment.yml          # conda-forge + pip mlx
mamba run -n plastiq-nerf uvicorn app.main:app --port 8002
```

Job lifecycle (submit/start/complete/fail + duration) and rejected submits are logged via
Python `logging` (INFO default — `NERF_LOG_LEVEL` overrides); the startup line summarizes the
CORS/auth/cap config without ever printing the API key.

## Test (real MLX training on the M4 Max)

```bash
mamba run -n plastiq-nerf python -m pytest -q
```

Strict TDD: unit tests for encodings / samplers / renderer / field, and **real MLX training on a
synthetic posed-view scene** (a known sphere/cube rendered analytically) asserting PSNR improves + the
exported mesh is roughly correct. Deterministic (explicit MLX keys). The FastAPI HTTP test gates on
`fastapi`+`mlx`.

## Scope

**SfM (photos → camera poses) is NOT built** — it stays COLMAP's job, ingested via `transforms.json`.
The training tests use a synthetic-pose fixture so the MLX training is real and reproducible without
COLMAP. The realistic workflow: capture photos → COLMAP poses → this service → GLB → import to Plastiq →
Convert to CAD.
