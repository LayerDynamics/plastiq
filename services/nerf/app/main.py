"""Plastiq NeRF service (FastAPI) — posed images → trained MLX field → mesh (GLB), via submit→poll.

POST /train  { transforms_json, images, iters?, method?, grid_res?, encoding?, importance_samples? }
                                                                    → { id, state }     (submit a job)
GET  /jobs/{id}/status                                              → { id, state, error? }
GET  /jobs/{id}/result    → { glb_base64, vertices, faces, psnr, method, iters,
                              encoding, importance_samples }             (when completed)
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
import logging
import os
import secrets
from typing import Literal

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel, Field, model_validator

from .engine.jobs import JobState, JobStore
from .engine.pipeline import train_and_export
from .logging_setup import setup_logging

setup_logging()
logger = logging.getLogger(__name__)

# Input caps — a single unauthenticated /train must not be able to exhaust memory/compute.
MAX_IMAGES = 300  # posed views per job (matches the browser UI cap)
MAX_IMAGE_DIM = 4096  # reject any view larger than this on a side
MAX_GRID_RES = 256  # the marching-cubes grid is res^3 — bounds the dense grid allocation
MAX_ITERS = 5000
MAX_IMPORTANCE_SAMPLES = 128  # fine PDF samples per ray — bounds the merged per-ray sample count
Image.MAX_IMAGE_PIXELS = 50_000_000  # PIL raises DecompressionBombError above this (bomb guard)

app = FastAPI(title="plastiq-nerf", version="0.1.0")

_origins_env = os.environ.get("NERF_CORS_ORIGINS", "*")
_origins = ["*"] if _origins_env.strip() == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])

store = JobStore()

# Optional bearer auth: if NERF_API_KEY is set, /train and DELETE require it; unset ⇒ open (dev default,
# matching the self-hosted capture/reconstruct siblings). NERF_CORS_ORIGINS keeps the wildcard dev
# default by the same parity; set both in any non-localhost deployment.
_MAX_CONCURRENT = int(os.environ.get("NERF_MAX_CONCURRENT_JOBS", "2"))


def _api_key() -> str | None:
    """The bearer key guarding the mutating endpoints. Read from the environment per-request (not at
    import), so the key can be set/rotated without re-importing the app (and tests can monkeypatch it)."""
    return os.environ.get("NERF_API_KEY")

# Startup config summary (env-derived; the key itself is NEVER logged) — one line to grep for.
logger.info(
    "plastiq-nerf configured: cors_origins=%s (NERF_CORS_ORIGINS), auth=%s (NERF_API_KEY), "
    "max_concurrent_jobs=%d (NERF_MAX_CONCURRENT_JOBS), caps: images=%d dim=%dpx grid=%d iters=%d "
    "importance=%d",
    _origins,
    "bearer" if _api_key() else "open (dev)",
    _MAX_CONCURRENT,
    MAX_IMAGES,
    MAX_IMAGE_DIM,
    MAX_GRID_RES,
    MAX_ITERS,
    MAX_IMPORTANCE_SAMPLES,
)


def require_auth(authorization: str | None = Header(default=None)) -> None:
    key = _api_key()
    if not key:
        return  # unset ⇒ open (dev default)
    expected = f"Bearer {key}"
    # Constant-time comparison (no timing side-channel on the key); bytes so non-ASCII input can't raise.
    if authorization is None or not secrets.compare_digest(
        authorization.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="missing or invalid API key")


class TrainBody(BaseModel):
    """A NeRF/surface training job: posed views + the camera poses that describe them.

    `transforms_json` is a `transforms.json` (a JSON string or an already-parsed object); `images` are
    base64 PNG/JPEG parallel to its frames. `method` picks the model: `neus` (VolSDF surface, default
    — clean watertight mesh for reconstruct) or `nerf` (density field).

    `encoding` picks the radiance field's position encoding for `method="nerf"`: `frequency` (classic
    NeRF sinusoidal, the default) or `hashgrid` (instant-NGP multiresolution hash grid — fits sharp
    detail faster). The `neus` SDF trunk consumes RAW coordinates by design (its IGR geometric init
    requires them), so there is no position encoding to swap — `hashgrid` with `neus` is rejected
    rather than silently ignored. `importance_samples` adds a fine PDF (hierarchical) sampling pass
    concentrated on the surface, supported by both methods; 0 = coarse-only (default)."""

    transforms_json: str | dict
    images: list[str] = Field(..., max_length=MAX_IMAGES)
    iters: int = Field(500, ge=1, le=MAX_ITERS)
    method: str = "neus"
    grid_res: int = Field(64, ge=16, le=MAX_GRID_RES)
    encoding: Literal["frequency", "hashgrid"] = "frequency"
    importance_samples: int = Field(0, ge=0, le=MAX_IMPORTANCE_SAMPLES)

    @model_validator(mode="after")
    def _hashgrid_requires_nerf(self) -> "TrainBody":
        # Truthful validation (422): the hash grid is the NeRF position encoding; the neus SDF trunk
        # has no position encoding to swap, so accepting the field there would silently ignore it.
        if self.encoding == "hashgrid" and self.method != "nerf":
            raise ValueError(
                "encoding 'hashgrid' requires method 'nerf' — the 'neus' SDF trunk consumes raw "
                "coordinates by design (geometric init), so it has no position encoding to swap"
            )
        return self


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


def _decode_images(images_b64: list[str]) -> np.ndarray:
    """base64 PNG/JPEG list → `(N,H,W,3)` float array in [0,1]. Caps decoded dimensions (with the
    module-level `MAX_IMAGE_PIXELS` decompression-bomb guard) and rejects a malformed/mismatched set."""
    arrs = []
    for i, b in enumerate(images_b64):
        try:
            img = Image.open(io.BytesIO(base64.b64decode(b))).convert("RGB")
        except Exception as e:  # noqa: BLE001 — includes PIL DecompressionBombError
            logger.warning("rejected /train submit: image %d is not a decodable/safe PNG/JPEG (%s)", i, e)
            raise HTTPException(status_code=400, detail=f"image {i} is not a decodable/safe PNG/JPEG: {e}") from e
        if max(img.size) > MAX_IMAGE_DIM:
            logger.warning("rejected /train submit: image %d exceeds %dpx on a side", i, MAX_IMAGE_DIM)
            raise HTTPException(status_code=400, detail=f"image {i} exceeds {MAX_IMAGE_DIM}px on a side")
        arrs.append(np.asarray(img, dtype=np.float32) / 255.0)
    if arrs and any(a.shape != arrs[0].shape for a in arrs):
        logger.warning("rejected /train submit: images do not share one height/width")
        raise HTTPException(status_code=400, detail="all images must share the same height/width")
    return np.asarray(arrs)


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "plastiq-nerf"}


@app.post("/train", response_model=JobView)
async def submit_train(body: TrainBody, _: None = Depends(require_auth)) -> JobView:
    if isinstance(body.transforms_json, str):
        try:
            transforms = json.loads(body.transforms_json)
        except (json.JSONDecodeError, ValueError) as e:
            logger.warning("rejected /train submit: transforms_json is not valid JSON")
            raise HTTPException(status_code=400, detail="transforms_json is not valid JSON") from e
    else:
        transforms = body.transforms_json
    if not isinstance(transforms, dict) or "frames" not in transforms:
        logger.warning("rejected /train submit: transforms_json is not a transforms.json object with frames")
        raise HTTPException(status_code=400, detail="transforms_json must be a transforms.json object with frames")
    if body.method not in ("neus", "nerf"):
        logger.warning("rejected /train submit: unknown method %r", body.method)
        raise HTTPException(status_code=400, detail="method must be 'neus' or 'nerf'")
    if store.running_count() >= _MAX_CONCURRENT:
        logger.warning(
            "rejected /train submit: %d jobs already in flight (cap %d)", store.running_count(), _MAX_CONCURRENT
        )
        raise HTTPException(status_code=429, detail="too many training jobs in flight; retry shortly")
    images = _decode_images(body.images)
    if len(images) != len(transforms["frames"]):
        logger.warning(
            "rejected /train submit: %d images but %d frames", len(images), len(transforms["frames"])
        )
        raise HTTPException(
            status_code=400,
            detail=f"{len(images)} images but {len(transforms['frames'])} frames — they must be parallel",
        )

    async def work() -> dict:
        # MLX training + marching cubes is CPU/GPU-bound → run off the event loop.
        return await asyncio.to_thread(
            train_and_export,
            transforms,
            images,
            method=body.method,
            iters=body.iters,
            grid_res=body.grid_res,
            encoding=body.encoding,
            importance_samples=body.importance_samples,
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


@app.delete("/jobs/{job_id}", status_code=204)
def cancel_job(job_id: str, _: None = Depends(require_auth)) -> Response:
    """Drop a job record (client cancel/cleanup). An in-flight worker thread cannot be force-killed, so
    its eventual result is simply discarded; status/result for this id return 404 afterwards."""
    if store.remove(job_id) is None:
        raise HTTPException(status_code=404, detail="no such job")
    return Response(status_code=204)
