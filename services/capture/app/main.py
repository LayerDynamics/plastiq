"""Plastiq capture service (FastAPI) — oriented point cloud → mesh (GLB), via the MLX neural SDF.

POST /points-from-depth {depth, fx, fy, cx, cy} → { points, normals }   (sync: depth scan → /capture cloud)
POST /capture {points, normals}  → { id, state }          (submit a job)
POST /complete {points}          → { id, state }          (submit a shape-completion job, M8)
GET  /jobs/{id}/status           → { id, state, error? }
GET  /jobs/{id}/result           → { glb_base64, vertices, faces }   (when completed)
DELETE /jobs/{id}                → 204 / 404               (cancel/cleanup a job record)
GET  /health                     → { status }

Mirrors services/reconstruct's submit→poll contract so the browser client reuses the same polling
shape: the produced GLB is imported as a MeshDoc, then reconstructed to an editable B-rep. The MLX
fit runs on Apple Silicon (the M4 Max). See docs/adr/0007.
"""

from __future__ import annotations

import asyncio
import base64
import functools
import logging
import os
import secrets

import numpy as np
from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .completion_mlx import CompletionNet, fit_completion
from .geometry import PinholeCamera, depth_to_normals, unproject_depth
from .jobs import JobState, JobStore
from .logging_setup import setup_logging
from .pipeline import complete_partial_job, reconstruct_surface_job

setup_logging()
logger = logging.getLogger(__name__)

# Input cap — a single unauthenticated submit must not be able to exhaust memory/compute. The MLX
# SDF fit evaluates f and ∇f on EVERY point each iteration (app/sdf_mlx.py fit_sdf), so cost and
# activation memory scale linearly with N; 200k points ≈ a few GB peak through the 256×4 MLP —
# comfortably within the M4 Max, far beyond any real scan the browser sends. Override with
# CAPTURE_MAX_POINTS (like CAPTURE_COMPLETION_ITERS / CAPTURE_COMPLETION_CHECKPOINT below).
MAX_POINTS = int(os.environ.get("CAPTURE_MAX_POINTS", "200000"))

# Concurrency cap — the per-request cap above bounds ONE submit, but each accepted job runs a full
# MLX fit on a worker thread, so N parallel unauthenticated submits would otherwise each start one.
# Submits beyond the cap get 429 (retry after a poll). Same pattern as services/nerf.
_MAX_CONCURRENT = int(os.environ.get("CAPTURE_MAX_CONCURRENT_JOBS", "2"))

app = FastAPI(title="plastiq-capture", version="0.1.0")

_origins_env = os.environ.get("CAPTURE_CORS_ORIGINS", "*")
_origins = ["*"] if _origins_env.strip() == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=_origins, allow_methods=["*"], allow_headers=["*"])

store = JobStore()


def _api_key() -> str | None:
    """Optional bearer key (CAPTURE_API_KEY). Read per-request so tests can monkeypatch."""
    return os.environ.get("CAPTURE_API_KEY")


def require_auth(authorization: str | None = Header(default=None)) -> None:
    """If CAPTURE_API_KEY is set, require Authorization: Bearer <key> on mutating routes (T36)."""
    key = _api_key()
    if not key:
        return
    expected = f"Bearer {key}"
    if authorization is None or not secrets.compare_digest(
        authorization.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="missing or invalid API key")


# Startup config summary (env-derived, no secrets) — one line an operator can grep for.
logger.info(
    "plastiq-capture configured: cors_origins=%s (CAPTURE_CORS_ORIGINS), auth=%s (CAPTURE_API_KEY), "
    "max_points=%d (CAPTURE_MAX_POINTS), max_concurrent_jobs=%d (CAPTURE_MAX_CONCURRENT_JOBS), "
    "completion_checkpoint=%s (CAPTURE_COMPLETION_CHECKPOINT)",
    _origins,
    "bearer" if _api_key() else "open (dev)",
    MAX_POINTS,
    _MAX_CONCURRENT,
    "set" if os.environ.get("CAPTURE_COMPLETION_CHECKPOINT") else "unset (synthetic demo completer)",
)


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
    return {
        "status": "ok",
        "service": "plastiq-capture",
        # True when /complete uses synthetic demo weights (T24/M2 honesty).
        "completion_demo_weights": _completion_using_demo_weights(),
    }


class DepthBody(BaseModel):
    """A depth scan: an (H, W) z-depth map + pinhole intrinsics (camera frame, +z forward, M6 /
    docs/adr/0006). Every pixel must carry a valid depth — crop or fill sensor holes upstream:
    app/geometry.py estimates normals from the depth map's spatial gradients, so a hole would poison
    its neighbours' normals (masked gradients are deliberately outside geometry.py's scope)."""

    depth: list[list[float]]
    fx: float
    fy: float
    cx: float
    cy: float


@app.post("/points-from-depth")
def points_from_depth(body: DepthBody) -> dict:
    """Unproject a depth scan into the oriented point cloud `/capture` consumes: pinhole unprojection
    + gradient-cross-product normals (app/geometry.py, kornia-ported, MLX). Synchronous, no job —
    unlike the SDF/completion fits this is a fixed handful of vectorized ops over H·W pixels (no
    training iterations), milliseconds even at the point cap, so submit→poll would be pure overhead.
    FastAPI runs this sync `def` in its worker threadpool, off the event loop. The response
    `{ points, normals }` (each H·W×3, row-major over (v, u)) is exactly `/capture`'s input shape."""
    if sum(len(row) for row in body.depth) > MAX_POINTS:  # cheap pre-parse cap, like /capture's
        logger.warning(
            "rejected /points-from-depth: %d pixels exceeds the %d cap",
            sum(len(row) for row in body.depth),
            MAX_POINTS,
        )
        raise HTTPException(
            status_code=422,
            detail=f"too many depth pixels ({sum(len(row) for row in body.depth)} > {MAX_POINTS})",
        )
    try:
        d = np.asarray(body.depth, dtype=np.float32)
    except ValueError:
        logger.warning("rejected /points-from-depth: ragged depth rows")
        raise HTTPException(status_code=400, detail="depth rows must all have the same length") from None
    if d.ndim != 2 or d.shape[0] < 2 or d.shape[1] < 2:
        logger.warning("rejected /points-from-depth: depth is not an (H>=2, W>=2) map")
        raise HTTPException(status_code=400, detail="depth must be a 2-D (H, W) map with H >= 2 and W >= 2")
    if not np.isfinite(d).all():
        logger.warning("rejected /points-from-depth: non-finite values in depth")
        raise HTTPException(status_code=400, detail="depth must contain only finite values")
    if (d <= 0.0).any():
        logger.warning("rejected /points-from-depth: non-positive depth values")
        raise HTTPException(
            status_code=400,
            detail="depth must be strictly positive everywhere (crop or fill sensor holes upstream)",
        )
    intrinsics = (body.fx, body.fy, body.cx, body.cy)
    if not all(np.isfinite(k) for k in intrinsics) or body.fx <= 0.0 or body.fy <= 0.0:
        logger.warning("rejected /points-from-depth: degenerate intrinsics %s", intrinsics)
        raise HTTPException(status_code=400, detail="intrinsics must be finite with fx > 0 and fy > 0")

    cam = PinholeCamera(fx=body.fx, fy=body.fy, cx=body.cx, cy=body.cy)
    pts = np.asarray(unproject_depth(d, cam), dtype=np.float32).reshape(-1, 3)
    nrm = np.asarray(depth_to_normals(d, cam), dtype=np.float32).reshape(-1, 3)
    logger.info("points-from-depth: unprojected a %dx%d depth map into %d oriented points", *d.shape, len(pts))
    return {"points": pts.tolist(), "normals": nrm.tolist()}


@app.post("/capture", response_model=JobView, dependencies=[Depends(require_auth)])
async def submit_capture(body: CaptureBody) -> JobView:
    if len(body.points) > MAX_POINTS:
        logger.warning("rejected /capture submit: %d points exceeds the %d cap", len(body.points), MAX_POINTS)
        raise HTTPException(status_code=422, detail=f"too many points ({len(body.points)} > {MAX_POINTS})")
    if store.running_count() >= _MAX_CONCURRENT:
        logger.warning(
            "rejected /capture submit: %d jobs already in flight (cap %d)", store.running_count(), _MAX_CONCURRENT
        )
        raise HTTPException(status_code=429, detail="too many jobs in flight; retry shortly")
    pts = np.asarray(body.points, dtype=np.float32)
    nrm = np.asarray(body.normals, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 3 or pts.shape != nrm.shape:
        logger.warning("rejected /capture submit: points/normals not matching Nx3 arrays")
        raise HTTPException(status_code=400, detail="points and normals must both be Nx3 and the same length")
    if not np.isfinite(pts).all() or not np.isfinite(nrm).all():
        logger.warning("rejected /capture submit: non-finite values in points/normals")
        raise HTTPException(status_code=400, detail="points and normals must contain only finite values")
    if len(pts) < 16:
        logger.warning("rejected /capture submit: only %d points (need at least 16)", len(pts))
        raise HTTPException(status_code=400, detail="need at least 16 points")

    # Process-isolated so DELETE cancel force-kills the MLX worker (P0.2), not only drops the record.
    job = await store.submit_process(
        reconstruct_surface_job,
        args=(pts.tolist(), nrm.tolist()),
        kwargs={"iters": body.iters, "grid_res": body.grid_res},
    )
    return JobView(id=job.id, state=job.state.value)


class CompleteBody(BaseModel):
    """A PARTIAL point cloud (a scan with holes) to complete into a full mesh (M8)."""

    points: list[list[float]]
    grid_res: int = 48


def _completion_using_demo_weights() -> bool:
    """True when `/complete` uses the synthetic sphere-family demo (no checkpoint env)."""
    return not bool(os.environ.get("CAPTURE_COMPLETION_CHECKPOINT"))


@functools.lru_cache(maxsize=1)
def _completion_model() -> CompletionNet:
    """The trained completion network. Loads `CAPTURE_COMPLETION_CHECKPOINT` if set (produce one
    from real meshes with `python -m app.train_completion`); otherwise trains the synthetic demo
    completer once and caches it. `CAPTURE_COMPLETION_ITERS` tunes the demo training length."""
    import mlx.core as mx

    ckpt = os.environ.get("CAPTURE_COMPLETION_CHECKPOINT")
    if ckpt:
        net = CompletionNet()
        net.load_weights(ckpt)
        mx.eval(net.parameters())
        return net
    return fit_completion(iters=int(os.environ.get("CAPTURE_COMPLETION_ITERS", "500")), seed=0)


@app.post("/complete", response_model=JobView, dependencies=[Depends(require_auth)])
async def submit_complete(body: CompleteBody) -> JobView:
    if len(body.points) > MAX_POINTS:
        logger.warning(
            "rejected /complete submit: %d points exceeds the %d cap", len(body.points), MAX_POINTS
        )
        raise HTTPException(status_code=422, detail=f"too many points ({len(body.points)} > {MAX_POINTS})")
    if store.running_count() >= _MAX_CONCURRENT:
        logger.warning(
            "rejected /complete submit: %d jobs already in flight (cap %d)", store.running_count(), _MAX_CONCURRENT
        )
        raise HTTPException(status_code=429, detail="too many jobs in flight; retry shortly")
    pts = np.asarray(body.points, dtype=np.float32)
    if pts.ndim != 2 or pts.shape[1] != 3:
        logger.warning("rejected /complete submit: points not an Nx3 array")
        raise HTTPException(status_code=400, detail="points must be Nx3")
    if not np.isfinite(pts).all():
        logger.warning("rejected /complete submit: non-finite values in points")
        raise HTTPException(status_code=400, detail="points must contain only finite values")
    if len(pts) < 16:
        logger.warning("rejected /complete submit: only %d points (need at least 16)", len(pts))
        raise HTTPException(status_code=400, detail="need at least 16 points")

    # Process-isolated so DELETE cancel force-kills the completion worker (P0.2).
    job = await store.submit_process(
        complete_partial_job,
        args=(pts.tolist(),),
        kwargs={"grid_res": body.grid_res},
    )
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


@app.delete("/jobs/{job_id}", status_code=204, dependencies=[Depends(require_auth)])
def cancel_job(job_id: str) -> Response:
    """Cancel a job: force-stop the worker process (if running) and mark the job cancelled (P0.2).

    In-flight MLX work runs in a spawn child process and is terminated; status returns
    ``failed`` with ``error=cancelled``. A second DELETE removes the terminal record (404 after).
    """
    job = store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    if job.state in (JobState.completed, JobState.failed):
        store.remove(job_id)
        return Response(status_code=204)
    store.cancel(job_id)
    return Response(status_code=204)
