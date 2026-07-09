"""Plastiq mesh→B-rep reconstruction service (FastAPI).

POST   /reconstruct {glb_base64, method?} → { id, state }     (submit a job)
GET    /jobs/{id}/status                  → { id, state, error? }
GET    /jobs/{id}/result                  → { step, report }   (when completed)
DELETE /jobs/{id}                         → 204                (drop/cancel a job record)
GET    /health                            → { status }

The browser sends a mesh document's inline base64 GLB; the service reconstructs a B-rep
and returns STEP text the client imports via the existing importStep. The submit→poll
shape mirrors the fal mesh-gen queue the client already speaks.
"""

from __future__ import annotations

import asyncio
import base64
import logging

import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .jobs import JobState, JobStore
from .logging_setup import setup_logging
from .pipeline import reconstruct

setup_logging()
logger = logging.getLogger(__name__)

app = FastAPI(title="plastiq-reconstruct", version="0.1.0")

# The browser client (apps/plastiq) calls this service cross-origin, so it must send CORS
# headers. Default permissive for local/self-hosted dev (the service holds no secrets);
# override with RECONSTRUCT_CORS_ORIGINS (comma-separated) to lock it down.
_origins_env = os.environ.get("RECONSTRUCT_CORS_ORIGINS", "*")
_origins = ["*"] if _origins_env.strip() == "*" else [o.strip() for o in _origins_env.split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Bound concurrent reconstructions (OCCT work is CPU-bound) — same pattern as services/nerf's
# NERF_MAX_CONCURRENT_JOBS. Submits beyond the cap are rejected with 429 so load sheds early.
_MAX_CONCURRENT = int(os.environ.get("RECONSTRUCT_MAX_CONCURRENT_JOBS", "2"))
# A hung non-terminal job is force-failed after this long, so it stops counting against the
# concurrency cap and becomes evictable like any other terminal job.
_RUNNING_TTL = float(os.environ.get("RECONSTRUCT_RUNNING_JOB_TTL_SECONDS", "1800"))

store = JobStore(running_ttl_seconds=_RUNNING_TTL)

# Startup config summary (env-derived, no secrets) — one line an operator can grep for.
logger.info(
    "plastiq-reconstruct configured: cors_origins=%s (RECONSTRUCT_CORS_ORIGINS), "
    "max_concurrent_jobs=%d (RECONSTRUCT_MAX_CONCURRENT_JOBS), "
    "running_job_ttl=%gs (RECONSTRUCT_RUNNING_JOB_TTL_SECONDS)",
    _origins,
    _MAX_CONCURRENT,
    _RUNNING_TTL,
)


class SubmitBody(BaseModel):
    """A base64-encoded GLB (the MeshDoc stores the model inline as base64)."""

    glb_base64: str
    file_type: str = "glb"
    # SPEC-7 FR-11: requested reconstruction method — "auto" (analytic routes → fitted fallback;
    # default), "fitted", or "faceted". Unknown values are rejected with 422 by validation.
    method: Literal["auto", "fitted", "faceted"] = "auto"


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "plastiq-reconstruct"}


@app.post("/reconstruct", response_model=JobView)
async def submit_reconstruction(body: SubmitBody) -> JobView:
    if store.running_count() >= _MAX_CONCURRENT:
        logger.warning(
            "rejected /reconstruct submit: %d jobs already in flight (cap %d)",
            store.running_count(),
            _MAX_CONCURRENT,
        )
        raise HTTPException(status_code=429, detail="too many reconstruction jobs in flight; retry shortly")
    try:
        data = base64.b64decode(body.glb_base64, validate=True)
    except Exception as e:  # noqa: BLE001
        logger.warning("rejected /reconstruct submit: invalid base64 GLB (%s)", e)
        raise HTTPException(status_code=400, detail=f"invalid base64 GLB: {e}") from e
    if not data:
        logger.warning("rejected /reconstruct submit: empty GLB payload")
        raise HTTPException(status_code=400, detail="empty GLB payload")

    file_type = body.file_type
    method = body.method

    async def work() -> dict:
        # OCCT reconstruction is CPU-bound → run off the event loop.
        result = await asyncio.to_thread(reconstruct, data, file_type, method=method)
        return result.to_dict()

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
        raise HTTPException(status_code=500, detail=job.error or "reconstruction failed")
    if job.state != JobState.completed or job.result is None:
        raise HTTPException(status_code=409, detail=f"job not complete (state: {job.state.value})")
    return job.result


@app.delete("/jobs/{job_id}", status_code=204)
def cancel_job(job_id: str) -> Response:
    """Drop a job record (client cancel/cleanup). An in-flight worker thread cannot be force-killed,
    so its eventual result is simply discarded; status/result for this id return 404 afterwards."""
    if store.remove(job_id) is None:
        raise HTTPException(status_code=404, detail="no such job")
    return Response(status_code=204)
