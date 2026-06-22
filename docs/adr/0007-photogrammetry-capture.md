# ADR 0007 — Capture: MLX neural-SDF surface reconstruction (photogrammetry, Apple Silicon)

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M7
**Tier:** T2 (self-hosted Python) · **Source idea:** nerfstudio/sdfstudio (Apache-2.0) · **Framework:** MLX (Apple Silicon)

## Context

`Expanse.md` flagged photogrammetry (real-object capture → mesh) as the one net-new capability in the
neural-3D batch. The upstream tools (nerfstudio/sdfstudio) are **CUDA-only** (tiny-cuda-nn, custom CUDA
kernels, PyTorch3D) and **will not run on Apple Silicon**. Per the user directive (see memory
`mlx-m4max-ml-milestones`), the model + training are written in **MLX**, trainable on the **M4 Max** —
a self-contained implementation, not a port of those repos.

## Decision

Build the **surface-reconstruction half** of photogrammetry as an MLX neural SDF, in the capture
service (`services/capture/`).

- **`app/sdf_mlx.py` — an MLX SIREN SDF fit to an oriented point cloud** (points + per-point normals,
  exactly what M6's `depth_to_normals` produces). Trained with the standard implicit-geometric losses
  (IGR / Gropp et al.): surface (`f≈0` on points), normal-alignment (`∇f ≈ normal`), and eikonal
  (`|∇f|≈1` on random samples — via `mx.grad`). Then **`extract_mesh`** marching-cubes the zero
  level-set (skimage) → a watertight mesh. Deterministic given a seed.
- **`app/main.py` — FastAPI submit→poll** (`/capture` → poll → mesh), mirroring `services/reconstruct`'s
  contract, so the client reuses the same polling shape. Ingests a point cloud (or a depth map +
  intrinsics, unprojected via M6) → returns a mesh.
- **Import path (JS):** the produced mesh feeds the existing `MeshDoc` → reconstruct (mesh→B-rep) path —
  capture → SDF mesh → editable B-rep.
- **Env:** `services/capture/environment.yml` pins MLX + numpy + trimesh + scikit-image; tested on the
  M4 Max (mlx 0.31, arm64).

## Honest scope — what is and isn't built

- **Built + trainable here:** points/depth + normals → MLX SDF → watertight mesh. The MLX training runs
  and is asserted on a synthetic sphere (real training on the M4 Max, not a stub).
- **Not built (no consumer / out of scope):** the **photos → posed-point-cloud** front end (SfM/MVS).
  That is **COLMAP's** job (or a phone depth sensor / LiDAR) — documented as the upstream step. A neural
  *radiance* field (multi-view RGB volume rendering) is heavier and unnecessary for a points/depth →
  surface path; the SDF-from-points approach is the right fit and reuses M6. (Mirrors M6's deferral of
  the SfM camera solvers for the same reason.)

## Consequences

- `services/capture/app/{sdf_mlx,main}.py` + tests (MLX training asserted on a sphere; service contract
  with a mocked/real fit). New `environment.yml`. JS import path reuses `mesh/importGltf`.
- Deterministic given a seed; license-clean (own MLX implementation, Apache-2.0 idea credit).
- `docs/specs/SPEC-10-capture-and-completion.md` §capture + `Expanse.md` M7 item updated.
