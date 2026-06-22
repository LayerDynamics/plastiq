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
| `GET`  | `/jobs/{id}/status` | `{ id, state, error? }` |
| `GET`  | `/jobs/{id}/result` | `{ glb_base64, vertices, faces }` when completed |

## Run locally (Apple Silicon)

```bash
mamba env create -f environment.yml          # conda-forge + pip mlx
mamba run -n plastiq-capture uvicorn app.main:app --port 8001
```

## Test (real MLX training on the M4 Max)

```bash
mamba run -n plastiq-capture python -m pytest -q
```

Covers (no mocks): `app/geometry.py` depth→points/normals; the **MLX SDF fit + marching cubes on a
sphere** (`test_sdf_mlx.py`, `test_pipeline.py` — real training, ~6 s); the submit→poll job contract
(`test_jobs.py`); and the full ASGI `/capture` flow (`test_api.py`, gated on `fastapi`+`mlx`).

## Scope

This is the **surface-reconstruction** half (points → mesh). The **photos → posed point cloud** step
(SfM/MVS) is COLMAP's / a depth sensor's job, upstream and not built here. The realistic workflow:
phone/LiDAR/COLMAP → point cloud → this service → GLB → import to Plastiq → Convert to CAD.
