# ADR 0006 — kornia geometry lifts: depth→points/normals (camera math for capture)

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M6
**Tier:** T2 (self-hosted Python) · **Source:** kornia (Apache-2.0; port with attribution)

## Context

`Expanse.md` found kornia's classical geometry useful only once a capture/depth front-end exists. With
M7 (photogrammetry/capture) now in scope, that front-end is being built — so M6 is its **camera +
depth math**: unproject a depth map to a 3D point cloud and estimate per-pixel surface normals (the
pieces a depth/scan capture path needs to feed `services/reconstruct`).

## Decision

Port kornia's **`depth_to_3d` + `depth_to_normals`** math to **MLX** (`mlx.core`, Apple Silicon —
consistent with the rest of the capture service's models, M7/M8), plus a small pinhole camera model,
into the capture service (`services/capture/app/geometry.py`). Apache-2.0, attribution recorded. The
functions return `mlx.core` arrays; `np.gradient` and `cross` are hand-rolled in MLX.

- **`unproject_depth(depth, K)`** — per-pixel `(u,v,d) → camera-frame xyz` via the pinhole model
  (`x=(u−cx)/fx·d`, `y=(v−cy)/fy·d`, `z=d`), vectorized.
- **`depth_to_normals(depth, K)`** — normals from the unprojected point grid via the cross product of
  spatial gradients (`∂P/∂u × ∂P/∂v`), normalized and sign-oriented toward the camera. Deterministic.
- **`PinholeCamera`** intrinsics helper (`fx, fy, cx, cy`) — `K`, project/unproject.

## Honest scope — what we deliberately do NOT build (no consumer)

The plan also listed **Nister 5-point relative pose** and **Kannala-Brandt fisheye**. We **do not** build
them, for the same evidence-based reason M3/M1.5 were re-scoped:

- **Nister 5-point is an SfM pose solver.** M7 does **not** hand-roll SfM — camera poses come from
  **COLMAP** (or are learned by the MLX field). There is no consumer for a 5-point essential-matrix
  solver here; implementing one (a 10th-degree-polynomial / Gröbner-basis algorithm) would be
  research-grade effort for code nothing calls — textbook over-engineering.
- **Kannala-Brandt fisheye** is a niche distortion model; standard captures are pinhole/Brown-Conrady,
  and COLMAP handles distortion in its own pipeline. Deferred.

Revisit criteria: if Plastiq ever hand-rolls SfM (instead of COLMAP/MLX), port the 5-point solver then.

**Revisit criterion fired (2026-07-04):** [SPEC-13](../specs/SPEC-13-photogrammetry-service.md)
commits to a first-party SfM front-end (`services/photogrammetry`); the Nistér 5-point port is planned
there (SPEC-13 P2). The Kannala-Brandt fisheye deferral stands (SPEC-13 §10 keeps it out of scope).

## Consequences

- New `services/capture/app/geometry.py` (**MLX**; no OCC, no torch, no numpy in the module) + tests —
  also seeds the M7 capture service directory. Deterministic.
- `Expanse.md` kornia item updated; the SfM-solver deferral recorded here and in M7's ADR.

## Wiring status

**Wired and live (as of 2026-07-04).** The capture service exposes `POST /points-from-depth
{depth, fx, fy, cx, cy} → {points, normals}` (`services/capture/app/main.py`), the depth-scan
ingestion endpoint this ADR was built for: it constructs a `PinholeCamera` from the intrinsics and
calls `unproject_depth` + `depth_to_normals` to turn a phone/LiDAR depth frame into the oriented point
cloud `POST /capture` consumes. It runs **synchronously** (a fixed handful of vectorized ops over H·W
pixels, no training loop), and is end-to-end tested feeding `/capture`
(`tests/test_api.py::test_points_from_depth_sphere_feeds_capture_end_to_end`, plus validation-400 and
pixel-cap-422 tests). M7's `/capture` still also accepts an already-oriented cloud directly (e.g. from
COLMAP), so `depth_to_normals` is one of two ways to produce that input, not the only one.
