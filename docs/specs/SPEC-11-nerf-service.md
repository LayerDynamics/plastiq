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
- **FR-7** Browser client is its own workspace package **`@plastiq/nerf`** (`packages/nerf`, sibling of
  `@plastiq/cad`/`@plastiq/sim`): `trainNerf()` submit→poll → `{ glb, report }`. `apps/plastiq` maps the
  GLB into a `MeshDoc` and wires it into "Convert to CAD" with a `nerfBaseURL` setting — **reachable from
  the running app** (not a tested island).

## 4. Non-functional

- **NFR-1 Deterministic** — same seed → same field/mesh (explicit MLX keys), tests reproducible.
- **NFR-2 Real training, no stubs** — training tests assert genuine PSNR / mesh improvement from a real
  M4-Max run; full-quality configs documented, not run in CI.
- **NFR-3 Honest scope** — pose accuracy (COLMAP) and training budget bound quality; organic scenes →
  organic meshes (the NFR-4 reconstruct caveat).

## 5. Service wire contract (the API N10 implements, `@plastiq/nerf` consumes)

The browser client (`packages/nerf`, N11) was written before the server (N10); this is the frozen
contract both honor. It mirrors `services/capture` exactly (same `/jobs/{id}/…` polling, same
`glb_base64`/`vertices`/`faces` result keys) so the client reuses the established submit→poll shape.

| Method & path | Request | Response |
|---|---|---|
| `POST /train` | `{ transforms_json: string, images: string[], iters?: int, method?: "nerf"\|"neus", grid_res?: int }` | `{ id: string, state: string }` |
| `GET /jobs/{id}/status` | — | `{ id, state, error? }` — `state ∈ {queued, running, completed, failed}` |
| `GET /jobs/{id}/result` | — | `{ glb_base64: string, vertices: int, faces: int, psnr: float, method: string, iters: int }` (200 when completed; 409 if not; 500 if failed; 404 unknown id) |
| `GET /health` | — | `{ status, service }` |

`transforms_json` is the stringified `transforms.json`; `images` are base64 PNG/JPEG parallel to its
frames. The client maps the result to `{ glb: glb_base64, report: { method, iters, psnr, vertices,
faces } }`; the app then wraps `glb` as a `MeshDoc`. **N10 must not diverge from this table** without
updating the client + this spec together.

## 6. Status

N0–N7 shipped (scaffold + ADR + this spec + MLX field/encoder/sampler/renderer/model + real
train-on-synthetic + hash-grid). N8 (NeuS/VolSDF) in progress. The `@plastiq/nerf` workspace package
(N11 client + types, this contract) is built and green (6 tests) **ahead of** its server (N10) and app
wiring (N11.3) — until the app imports it, it is a **tested island** in the integration ledger. See the
plan for the N1–N12 breakdown and the cross-cutting completion gate. Updated as milestones land.
