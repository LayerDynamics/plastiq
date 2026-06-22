# SPEC-10 — Capture & completion (MLX on Apple Silicon)

**Status:** In progress (M7 shipped) · **Date:** 2026-06-22
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M7/§M8 · **Framework:** MLX (Apple Silicon / M4 Max)

Two optional self-hosted Python services that turn raw 3D input into a mesh Plastiq can reconstruct to
B-rep. Both are written in **MLX** — the upstream repos (nerfstudio/sdfstudio for M7, DLR-RM
shape-completion for M8) are **CUDA-only** and do not run on Apple Silicon, so these are self-contained
MLX implementations trainable on the user's M4 Max (memory `mlx-m4max-ml-milestones`), not ports.

## §capture — MLX neural-SDF surface reconstruction (M7 · shipped)

**ADR:** [`docs/adr/0007-photogrammetry-capture.md`](../adr/0007-photogrammetry-capture.md) · **Service:** `services/capture/`

Turns an **oriented point cloud** (points + per-pixel normals, from a depth scan via
`app/geometry.py` (M6) or an external SfM/MVS like COLMAP) into a **watertight mesh**.

- **`app/sdf_mlx.py`** — an IGR-style Softplus SDF MLP (geometric init → correct inside/outside sign at
  init), fit to the points with surface (`f≈0`), normal-alignment (`∇f ≈ n`), and eikonal (`|∇f|≈1`,
  via `mx.grad`) losses; **`extract_mesh`** marching-cubes the zero level-set. **Real MLX training on
  the M4 Max** (a sphere fits + extracts in ~6 s; asserted in `tests/test_sdf_mlx.py`). Deterministic
  by seed.
- **`app/pipeline.py`** — `reconstruct_surface(points, normals) → mesh` (+ GLB export).
- **`app/main.py`** — FastAPI **submit→poll** (`POST /capture {points, normals}` → poll →
  `{glb_base64, vertices, faces}`), mirroring `services/reconstruct`. The submit→poll job contract is
  tested live (`tests/test_jobs.py`); the full HTTP path (`tests/test_api.py`) gates on `fastapi`+`mlx`.
- **Import path:** the produced GLB is a standard mesh → imported via Plastiq's existing `MeshDoc`
  path → the existing **"Convert to CAD"** reconstruct (mesh→B-rep). No new browser code; the realistic
  workflow is **external capture** (phone/LiDAR/COLMAP → point cloud → capture service → GLB → Plastiq).
- **Env:** `services/capture/environment.yml` (conda-forge + `pip: mlx`).

**Honest scope:** this is the *surface-reconstruction* half (points → mesh). The **photos → posed point
cloud** step (SfM/MVS) is COLMAP's / a depth sensor's job, not built here (ADR 0007) — and a full
multi-view *radiance* field is unnecessary for a points/depth → surface path.

## §completion — shape completion ("Complete Scan / Fill Gaps") (M8 · shipped)

**ADR:** [`docs/adr/0008-shape-completion-service.md`](../adr/0008-shape-completion-service.md) · **Service:** `services/capture/` (`/complete`)

Completes a **partial** point cloud (a scan with holes) into a full watertight mesh.

- **`app/completion_mlx.py`** — a conditional occupancy network (PointNet encoder + occupancy decoder),
  trained with logits-BCE on (partial, query, full-occupancy) triples; `complete` marching-cubes the
  predicted occupancy. **Real MLX training on the M4 Max** — the test asserts the completion fills the
  missing hemisphere a partial top-only scan never saw (`tests/test_completion_mlx.py`, ~2 s).
  Deterministic by seed; checkpoints via `CompletionNet.load_weights`.
- **`/complete` endpoint** (submit→poll) on the capture service; a lazily-trained-or-loaded cached
  model (`CAPTURE_COMPLETION_CHECKPOINT` for a real-dataset checkpoint, else the synthetic demo).
- **Lives in the capture service, not reconstruct** — it is ML/non-deterministic and must stay out of
  the deterministic mesh→B-rep path (NFR-2). Output GLB → existing `MeshDoc` → reconstruct.

**Honest scope:** the demo completes the family it trained on (spheres). General objects need a
ShapeNet-style partial/full training set + a loaded checkpoint (the upstream repo ships no weights
either). Completion quality is class-dependent.
