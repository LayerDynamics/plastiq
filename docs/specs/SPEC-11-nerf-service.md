# SPEC-11 — NeRF / radiance-field service (`services/nerf/`, MLX)

**Status:** In progress (N0) · **Date:** 2026-06-22
**ADR:** [`docs/adr/0011`](../adr/0011-nerf-service-architecture.md) · **Plan:** `docs/plans/2026-06-22-nerf-service.md`
**Framework:** MLX (Apple Silicon / M4 Max) · **Source idea:** nerfstudio (Apache-2.0, architecture only)

## 1. Goal

A self-hosted, **modular MLX** radiance-field service: posed images (`transforms.json` + frames) → a
trained NeRF or SDF field → an exported mesh that feeds Plastiq's existing `MeshDoc` → reconstruct
(mesh→B-rep) path. Mirrors nerfstudio's module decomposition so encodings, samplers, renderers, fields,
and models are independently testable.

## 2. Components (`services/nerf/app/`)

| Module | Responsibility |
|---|---|
| `field_components/` | `FrequencyEncoding`, `HashGridEncoding`, `MLP`, density/RGB `field_heads`, activations (`mlx.nn`) |
| `generators/` | ray samplers: `UniformSampler`, `PDFSampler` (importance) |
| `model_components/` | volumetric `renderers` (RGB / accumulation / depth), `losses` (MSE photometric, eikonal) |
| `fields/` | `NeRFField` (density+color), `SDFField` (NeuS/VolSDF) — composed from `field_components` |
| `models/` | `VanillaNeRF` (+ hash-grid), `NeuS` surface model — field + sampler + renderer + loss |
| `data_processing/` | `transforms.json` parser → `DataparserOutputs`; MLX ray generation (reuses capture pinhole) |
| `engine/` | `Trainer` (MLX Adam + `value_and_grad` loop); submit→poll `jobs` |
| `exporters/` | density/SDF grid → `marching_cubes` mesh → GLB / point cloud |
| `utils/` | config, deterministic MLX seeding, math |

## 3. Functional requirements

- **FR-1** Field/encoder/sampler/renderer/model code is **MLX** (`mlx.core`/`mlx.nn`); numpy only at I/O
  boundaries (parse, image load, marching-cubes, GLB). Deterministic via explicit MLX keys.
- **FR-2** Two models: **VanillaNeRF** (density+color, volume render) and **NeuS/VolSDF** (SDF surface).
- **FR-3** `transforms.json` ingestion (nerfstudio/Blender convention); **SfM is out of scope** (COLMAP).
- **FR-4** A synthetic-pose fixture (analytic render of a known shape) drives reproducible training tests.
- **FR-5** Exporter produces a GLB consumable by the existing `MeshDoc` → reconstruct path.
- **FR-6** FastAPI **submit→poll** (`/train` → poll → mesh GLB), mirroring reconstruct/capture.
- **FR-7** Browser client `apps/plastiq/src/ai/nerf.ts` (submit→poll → `MeshDoc`) wired into "Convert to
  CAD" with a `nerfBaseURL` setting — **reachable from the running app** (not a tested island).

## 4. Non-functional

- **NFR-1 Deterministic** — same seed → same field/mesh (explicit MLX keys), tests reproducible.
- **NFR-2 Real training, no stubs** — training tests assert genuine PSNR / mesh improvement from a real
  M4-Max run; full-quality configs documented, not run in CI.
- **NFR-3 Honest scope** — pose accuracy (COLMAP) and training budget bound quality; organic scenes →
  organic meshes (the NFR-4 reconstruct caveat).

## 5. Status

N0 (scaffold + ADR + this spec + `utils`) in progress; see the plan for the N1–N12 milestone breakdown
and the cross-cutting completion gate. This section is updated as milestones land.
