# plastiq-capture — MLX neural-SDF surface reconstruction

Optional self-hosted service that turns an **oriented point cloud** (points + normals — from a depth
scan or an external SfM/MVS like COLMAP) into a **watertight mesh**, which Plastiq imports as a
`MeshDoc` and reconstructs to an editable B-rep. The neural SDF is written in **MLX** and trains on
**Apple Silicon** (the M4 Max) — see [`docs/adr/0007`](../../docs/adr/0007-photogrammetry-capture.md)
and [SPEC-10](../../docs/specs/SPEC-10-capture-and-completion.md).

## What it does

`points + normals` → fit a Softplus/IGR SDF (`app/sdf_mlx.py`, MLX; surface + normal + eikonal losses,
geometric init) → marching-cubes the zero level-set → GLB. Deterministic by seed.

## API (submit → poll, mirrors the reconstruct service)

| Method | Path | Body / result |
|---|---|---|
| `GET`  | `/health` | `{ status, service }` |
| `POST` | `/capture` | `{ points: [[x,y,z]…], normals: [[x,y,z]…], iters?, grid_res? }` → `{ id, state }` |
| `POST` | `/complete` | `{ points: [[x,y,z]…], grid_res? }` → `{ id, state }` — **shape completion** (M8): a partial scan → full mesh |
| `POST` | `/points-from-depth` | `{ depth: [[d…]…], fx, fy, cx, cy }` → `{ points, normals }` — **synchronous**: a depth scan → the oriented cloud `/capture` consumes |
| `GET`  | `/jobs/{id}/status` | `{ id, state, error? }` |
| `GET`  | `/jobs/{id}/result` | `{ glb_base64, vertices, faces }` when completed |
| `DELETE` | `/jobs/{id}` | `204` (job record dropped — cancel/cleanup) / `404` if unknown |

Two capabilities, both MLX: **capture** (`/capture`, oriented point cloud → SDF mesh) and **shape
completion** (`/complete`, a partial scan → full mesh via a conditional occupancy network —
`app/completion_mlx.py`, M8 / [`docs/adr/0008`](../../docs/adr/0008-shape-completion-service.md)). The
completion model is trained on a synthetic family by default; set `CAPTURE_COMPLETION_CHECKPOINT` to a
checkpoint trained on real meshes for general objects — `app/train_completion.py` (below) produces one.
A raw **depth scan** (a phone/LiDAR depth frame + pinhole intrinsics) becomes the oriented cloud via
`/points-from-depth` (`app/geometry.py` — kornia-ported pinhole unprojection + gradient-cross-product
normals, in MLX; M6 / [`docs/adr/0006`](../../docs/adr/0006-kornia-geometry-lifts.md)). It responds
synchronously (a few vectorized ops per pixel, no training loop), and every pixel must carry a valid
positive depth — crop or fill sensor holes upstream, since normals come from the map's gradients.

Point clouds are capped at **200 000 points** per submit (422 above it; `CAPTURE_MAX_POINTS`
overrides) — the MLX fit evaluates every point each iteration, so the cap bounds one request's
memory/compute. Depth maps share the same budget (H·W pixels ≤ the cap, since each pixel becomes a
point). Concurrent jobs are capped too (**2** in flight; 429 above it;
`CAPTURE_MAX_CONCURRENT_JOBS` overrides), since each accepted job runs a full MLX fit on a worker
thread.

## Train the completion model (real meshes → checkpoint)

`python -m app.train_completion` trains `CompletionNet` on a directory of **watertight meshes** (any
format trimesh reads): partial scans are surface samples culled against a random view direction
(hemisphere-style masking of the real geometry), occupancy labels come from trimesh containment
queries — then saves the weights via `save_weights` for `CAPTURE_COMPLETION_CHECKPOINT`:

```bash
mamba run -n plastiq-capture python -m app.train_completion ./meshes \
    --checkpoint completion.safetensors --iters 2000 --seed 0
# resume a longer run from a saved checkpoint, saving every 500 iters:
mamba run -n plastiq-capture python -m app.train_completion ./meshes \
    --checkpoint completion.safetensors --resume completion.safetensors --iters 4000 --save-every 500

CAPTURE_COMPLETION_CHECKPOINT=completion.safetensors \
    mamba run -n plastiq-capture uvicorn app.main:app --port 8001
```

Deterministic by `--seed`; `--samples/--batch/--n-partial/--n-query/--lr` tune the dataset and
optimizer (defaults in `python -m app.train_completion --help`).

## Run locally (Apple Silicon)

`pnpm dev` starts the editor with all five supervised services. For a service-only session,
the repo-root command below starts reconstruct :8000, capture :8001, nerf :8002, nurbs :8003,
and photogrammetry :8004, creating missing conda environments and requiring every health gate:

```bash
just services          # `just services-stop` stops only supervisor-owned processes
```

Or run just this service manually:

```bash
mamba env create -f environment.yml          # conda-forge + pip mlx
mamba run -n plastiq-capture uvicorn app.main:app --port 8001
```

Job lifecycle (submit/start/complete/fail + duration) and rejected submits are logged via
Python `logging` (INFO default — `CAPTURE_LOG_LEVEL` overrides). Terminal jobs are evicted by
TTL + a max-count cap (`app/jobs.py`), so the in-memory store stays bounded between restarts.

## Test (real MLX training on the M4 Max)

```bash
mamba run -n plastiq-capture python -m pytest -q
```

Covers (no mocks): `app/geometry.py` depth→points/normals; the **MLX SDF fit + marching cubes on a
sphere** (`test_sdf_mlx.py`, `test_pipeline.py` — real training, ~6 s); the submit→poll job contract
+ bounded-store eviction (`test_jobs.py`); the full ASGI `/capture` flow incl. the point-count cap
422, the concurrent-job cap 429, `DELETE /jobs/{id}`, and the `/points-from-depth` depth-scan path —
a synthetic sphere depth map unprojects to on-sphere points with outward normals and feeds `/capture`
end-to-end (`test_api.py`, gated on `fastapi`+`mlx`);
and the completion-training CLI — real-geometry dataset triples, checkpoint save→load round-trip,
resume, the `CAPTURE_COMPLETION_CHECKPOINT` serving branch, and a tiny train run whose loss must
decrease (`test_train_completion.py`).

## Scope

This is the **surface-reconstruction** half (points → mesh). The **photos → posed point cloud** step
(SfM/MVS) is COLMAP's / a depth sensor's job, upstream and not built here. The realistic workflow:
phone/LiDAR/COLMAP → point cloud → this service → GLB → import to Plastiq → Convert to CAD.
