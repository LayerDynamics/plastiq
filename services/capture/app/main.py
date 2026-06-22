"""Plastiq capture service (FastAPI) — oriented point cloud → mesh (GLB), via the MLX neural SDF.

POST /capture {points, normals}  → { id, state }          (submit a job)
GET  /jobs/{id}/status           → { id, state, error? }
GET  /jobs/{id}/result           → { glb_base64, vertices, faces }   (when completed)
GET  /health                     → { status }

Mirrors services/reconstruct's submit→poll contract so the browser client reuses the same polling
shape: the produced GLB is imported as a MeshDoc, then reconstructed to an editable B-rep. The MLX
fit runs on Apple Silicon (the M4 Max). See docs/adr/0007.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import os

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .completion_mlx import CompletionNet, fit_completion
from .jobs import JobState, JobStore
from .pipeline import complete_partial, reconstruct_surface

app = FastAPI(title="plastiq-capture", version="0.1.0")

_origins_env = os.environ.get("CAPTURE_CORS_ORIGINS", "*")
_origins = ["*"] if _origins_env.strip() == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])

store = JobStore()


class CaptureBody(BaseModel):
    """An oriented point cloud: Nx3 points + Nx3 unit normals (from a depth scan or SfM/MVS)."""

    points: list[list[float]]
    normals: list[list[float]]
    iters: int = 600
    grid_res: int = 64


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "plastiq-capture"}


@app.post("/capture", response_model=JobView)
async def submit_capture(body: CaptureBody) -> JobView:
    pts = np.asarray(body.points, dtype=np.float32)
    nrm = np.asarray(body.normals, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 3 or pts.shape != nrm.shape:
        raise HTTPException(status_code=400, detail="points and normals must both be Nx3 and the same length")
    if len(pts) < 16:
        raise HTTPException(status_code=400, detail="need at least 16 points")

    async def work() -> dict:
        # MLX fit + marching cubes is CPU/GPU-bound → run off the event loop.
        res = await asyncio.to_thread(
            reconstruct_surface, pts, nrm, iters=body.iters, grid_res=body.grid_res
        )
        return {
            "glb_base64": base64.b64encode(res.to_glb()).decode("ascii"),
            "vertices": res.vertices,
            "faces": res.faces,
        }

    job = await store.submit(work)
    return JobView(id=job.id, state=job.state.value)


class CompleteBody(BaseModel):
    """A PARTIAL point cloud (a scan with holes) to complete into a full mesh (M8)."""
    pts = np.asarray(body.points, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise HTTPException(status_code=400, detail="points must be Nx3")
    if not np.isfinite(pts).all():
        raise HTTPException(status_code=400, detail="points must contain only finite values")


@functools.lru_cache(maxsize=1)
def _completion_model() -> CompletionNet:
    """The trained completion network. Loads `CAPTURE_COMPLETION_CHECKPOINT` if set (train it on a
    real dataset for general objects); otherwise trains the synthetic demo completer once and caches
    it. `CAPTURE_COMPLETION_ITERS` tunes the demo training length."""
    import mlx.core as mx

    ckpt = os.environ.get("CAPTURE_COMPLETION_CHECKPOINT")
    if ckpt:
        net = CompletionNet()
        net.load_weights(ckpt)
        mx.eval(net.parameters())
        return net
    return fit_completion(iters=int(os.environ.get("CAPTURE_COMPLETION_ITERS", "500")), seed=0)


@app.post("/complete", response_model=JobView)
async def submit_complete(body: CompleteBody) -> JobView:
    pts = np.asarray(body.points, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 3:
        raise HTTPException(status_code=400, detail="points must be Nx3")
    if len(pts) < 16:
        raise HTTPException(status_code=400, detail="need at least 16 points")

    async def work() -> dict:
        net = await asyncio.to_thread(_completion_model)
        res = await asyncio.to_thread(complete_partial, net, pts, grid_res=body.grid_res)
        return {
            "glb_base64": base64.b64encode(res.to_glb()).decode("ascii"),
            "vertices": res.vertices,
            "faces": res.faces,
        }

    job = await store.submit(work)
    return JobView(id=job.id, state=job.state.value)


@app.get("/jobs/{job_id}/status", response_model=JobView)
def job_status(job_id: str) -> JobView:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="no such job")
    return JobView(id=job.id, state=job.state.value, error=job.error)


@app.get("/jobs/{job_id}/result")
def job_result(job_id: str) -> dict:
    job = store.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="no such job")
    if job.state == JobState.failed:
        raise HTTPException(status_code=500, detail=job.error or "capture failed")
    if job.state != JobState.completed or job.result is None:
        raise HTTPException(status_code=409, detail=f"job not complete (state: {job.state.value})")
    return job.result
