"""Plastiq mesh→B-rep reconstruction service (FastAPI).

POST /reconstruct {glb_base64}  → { id, state }     (submit a job)
GET  /jobs/{id}/status          → { id, state, error? }
GET  /jobs/{id}/result          → { step, report }   (when completed)
GET  /health                    → { status }

The browser sends a mesh document's inline base64 GLB; the service reconstructs a B-rep
and returns STEP text the client imports via the existing importStep. The submit→poll
shape mirrors the fal mesh-gen queue the client already speaks.
"""

from __future__ import annotations

import asyncio
import base64

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .jobs import JobState, JobStore
from .pipeline import reconstruct

app = FastAPI(title="plastiq-reconstruct", version="0.1.0")
store = JobStore()


class SubmitBody(BaseModel):
    """A base64-encoded GLB (the MeshDoc stores the model inline as base64)."""

    glb_base64: str
    file_type: str = "glb"


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


@app.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "plastiq-reconstruct"}


@app.post("/reconstruct", response_model=JobView)
async def submit_reconstruction(body: SubmitBody) -> JobView:
    try:
        data = base64.b64decode(body.glb_base64, validate=True)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid base64 GLB: {e}") from e
    if not data:
        raise HTTPException(status_code=400, detail="empty GLB payload")

    file_type = body.file_type

    async def work() -> dict:
        # OCCT reconstruction is CPU-bound → run off the event loop.
        result = await asyncio.to_thread(reconstruct, data, file_type)
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
