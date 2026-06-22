"""Plastiq NeRF service (FastAPI) — posed images → trained MLX field → mesh (GLB), via submit→poll.

POST /train  { transforms_json, images, iters?, method?, grid_res? } → { id, state }   (submit a job)
GET  /jobs/{id}/status                                              → { id, state, error? }
GET  /jobs/{id}/result    → { glb_base64, vertices, faces, psnr, method, iters }  (when completed)
GET  /health                                                       → { status, service }

The exact wire contract is frozen in SPEC-11 §5 (the `@plastiq/nerf` browser client was written to it
first). It mirrors services/capture so the browser reuses one submit→poll client: the produced GLB is
imported as a MeshDoc, then reconstructed into an editable B-rep. Training runs on Apple Silicon (the
M4 Max) via MLX; the heavy work is dispatched off the event loop. SfM (photos → poses) is COLMAP's
job upstream — this service ingests the resulting transforms.json. See docs/adr/0011.
"""

from __future__ import annotations

import asyncio
import base64
import io
import json
import os

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

from .engine.jobs import JobState, JobStore
from .engine.pipeline import train_and_export

app = FastAPI(title="plastiq-nerf", version="0.1.0")

_origins_env = os.environ.get("NERF_CORS_ORIGINS", "*")
_origins = ["*"] if _origins_env.strip() == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])

store = JobStore()


class TrainBody(BaseModel):
    """A NeRF/surface training job: posed views + the camera poses that describe them.

    `transforms_json` is a `transforms.json` (a JSON string or an already-parsed object); `images` are
    base64 PNG/JPEG parallel to its frames. `method` picks the model: `neus` (VolSDF surface, default
    — clean watertight mesh for reconstruct) or `nerf` (density field)."""

    transforms_json: str | dict
    images: list[str]
    iters: int = 500
    method: str = "neus"
    grid_res: int = 64


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


def _decode_images(images_b64: list[str]) -> np.ndarray:
    """base64 PNG/JPEG list → `(N,H,W,3)` float array in [0,1]. Raises on a malformed/mismatched set."""
    arrs = []
    for i, b in enumerate(images_b64):
        try:
            img = Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"image {i} is not a decodable PNG/JPEG: {e}") from e
        arrs.append(np.asarray(img, dtype=np.float32) / 255.0)
    if arrs and any(a.shape != arrs[0].shape for a in arrs):
        raise HTTPException(status_code=400, detail="all images must share the same height/width")
    return np.asarray(arrs)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "plastiq-nerf"}


@app.post("/train", response_model=JobView)
async def submit_train(body: TrainBody) -> JobView:
    transforms = json.loads(body.transforms_json) if isinstance(body.transforms_json, str) else body.transforms_json
    if not isinstance(transforms, dict) or "frames" not in transforms:
        raise HTTPException(status_code=400, detail="transforms_json must be a transforms.json object with frames")
    images = _decode_images(body.images)
    if len(images) != len(transforms["frames"]):
        raise HTTPException(
            status_code=400,
            detail=f"{len(images)} images but {len(transforms['frames'])} frames — they must be parallel",
        )
    if body.method not in ("neus", "nerf"):
        raise HTTPException(status_code=400, detail="method must be 'neus' or 'nerf'")

    async def work() -> dict:
        # MLX training + marching cubes is CPU/GPU-bound → run off the event loop.
        return await asyncio.to_thread(
            train_and_export, transforms, images, method=body.method, iters=body.iters, grid_res=body.grid_res
        )

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
        raise HTTPException(status_code=500, detail=job.error or "training failed")
    if job.state != JobState.completed or job.result is None:
        raise HTTPException(status_code=409, detail=f"job not complete (state: {job.state.value})")
    return job.result
