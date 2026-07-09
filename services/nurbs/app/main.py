"""Plastiq NURBS service (FastAPI) — GLB mesh → fitted B-spline surfaces → STEP, via submit→poll.

POST /fit  { glb_base64, mode?, degree?, grid?, iters?, fidelity_tol? } → { id, state }   (submit)
GET  /jobs/{id}/status                                                  → { id, state, error? }
GET  /jobs/{id}/result → { step, surfaces, report }  (200 completed; 409 not yet complete —
                                                      queued/running/completed-null; 500 failed; 404)
DELETE /jobs/{id}                                                       → 204 (dropped) | 404
GET  /health                                                           → { status, service }

The exact wire contract is frozen in SPEC-12 §6.1 (the ``@plastiq/nurbs`` browser client is written
to it); it mirrors services/capture/reconstruct/nerf so the browser reuses one submit→poll client.
Fitting (MLX + OCCT) is CPU/GPU-bound and runs off the event loop via ``asyncio.to_thread``.

Dependency-injected pipeline (the §6.1 seam). The heavy mesh→fit work is a ``fit_fn`` handed to
:func:`create_app` — the HTTP shell is built and tested **independently** of the fitting stack.
``fit_fn(payload: dict) -> {"step", "surfaces", "report"}`` is called for each accepted /fit job;
``payload`` is the validated request body (``model_dump``). :func:`create_app` therefore has **no
import-time dependency** on ``app.pipeline`` (tests inject their own ``fit_fn``).

For ``uvicorn app.main:app`` a module-level ``app`` is provided, wired to :func:`_load_pipeline_fit`
— the production dispatcher that decodes the GLB, resolves the mode against the mesh topology
(``meshio.detect_mode``), and routes open → :func:`app.pipeline.fit_open` / closed →
:func:`app.pipeline_closed.fit_closed`. Its heavy imports are **lazy** (inside the function), so
the shell serves /health and accepts /fit even in a fastapi-only env, and a fit that raises
(unsupported topology, a missing dep) fails gracefully (job ``failed`` → 500) rather than breaking
the module at import. See :func:`_load_pipeline_fit`.

Auth mirrors SPEC-11 §5 / nerf: if ``NURBS_API_KEY`` is set, ``POST /fit`` and ``DELETE`` require
``Authorization: Bearer <key>`` (401 otherwise); unset ⇒ open (the self-hosted dev default).
``NURBS_CORS_ORIGINS`` (default ``*``) and ``NURBS_MAX_CONCURRENT_JOBS`` (default 2) tune the app and
are read in :func:`create_app`. See docs/specs/SPEC-12-nurbs-service.md and docs/adr/0012.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
from typing import Callable, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .jobs import JobState, JobStore
from .logging_setup import setup_logging

setup_logging()
logger = logging.getLogger(__name__)

# Input caps — a single (possibly unauthenticated) /fit must not exhaust memory. The mesh caps are
# pydantic Field(...) bounds on FitBody; MAX_GLB_BASE64 bounds the accepted glb_base64 field size.
# It is NOT a raw request-body cap: pydantic's str max_length rejects only AFTER Starlette has
# buffered and parsed the whole body, so true raw body-byte capping belongs at the ASGI/proxy layer
# (uvicorn/reverse proxy). The GLB itself is decoded by the injected pipeline, not the shell.
MAX_GLB_BASE64 = 256 * 1024 * 1024  # ~256 MiB of base64 text (≈192 MiB of GLB) — a generous DoS cap

# The fitting seam: payload dict (validated /fit body) → { "step", "surfaces", "report" }.
FitFn = Callable[[dict], dict]


def _api_key() -> str | None:
    """The bearer key guarding the mutating endpoints. Read from the environment per-request (not at
    import), so the key can be set/rotated without re-importing the app (and tests can monkeypatch it)."""
    return os.environ.get("NURBS_API_KEY")


def require_auth(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: enforce the bearer key on mutating endpoints when NURBS_API_KEY is set."""
    key = _api_key()
    if not key:
        return  # unset ⇒ open (dev default)
    expected = f"Bearer {key}"
    # Constant-time comparison (no timing side-channel on the key); bytes so non-ASCII input can't raise.
    if authorization is None or not secrets.compare_digest(
        authorization.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="missing or invalid API key")


class FitBody(BaseModel):
    """A NURBS surface-fitting job (SPEC-12 §6.1). ``glb_base64`` is a base64-encoded GLB mesh; the
    remaining fields are the fit knobs with their frozen §6.1 bounds. ``mode`` auto-detects open
    (disk) vs closed (genus-0) topology unless forced. ``iters`` = 0 ⇒ pure LSQ (no gradient refine).
    The shell does not decode the GLB — that is the injected pipeline's job; only its size is capped.
    """

    glb_base64: str = Field(..., min_length=1, max_length=MAX_GLB_BASE64)
    mode: Literal["auto", "open", "closed"] = "auto"
    degree: int = Field(3, ge=2, le=8)
    grid: int = Field(16, ge=4, le=64)  # control points per direction
    iters: int = Field(200, ge=0, le=2000)  # 0 ⇒ LSQ only
    fidelity_tol: float | None = Field(default=None, gt=0.0)


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


def _load_pipeline_fit(payload: dict) -> dict:
    """Production ``fit_fn`` for ``uvicorn app.main:app``: the mesh→fit dispatcher (SPEC-12 §6.1).

    Decodes ``glb_base64``, resolves the request ``mode`` against the mesh's real topology
    (:func:`app.meshio.detect_mode` — ``"auto"`` auto-detects, an explicit ``"open"``/``"closed"``
    is validated), then routes to the matching pipeline:

    * ``"open"``   → :func:`app.pipeline.fit_open` (one patch on a disk-topology region, FR-3),
    * ``"closed"`` → :func:`app.pipeline_closed.fit_closed` (six shared-rim patches sewn into a
      watertight solid, FR-4),

    returning the unified ``{"step", "surfaces", "report"}`` either way. Both pipelines already
    accept these §6.1 knobs (``degree``/``grid``/``iters``/``fidelity_tol``); the HTTP shell has
    applied the §6.1 bounds via ``FitBody``.

    The heavy modules (``meshio``/``pipeline``/``pipeline_closed`` → MLX/trimesh/OCCT) are imported
    **lazily** so this module keeps **no import-time dependency** on the fitting stack: ``from
    app.main import create_app`` works in a fastapi-only env, /health and /fit submission stay up,
    and a genuinely-missing piece fails gracefully as a job ``failed`` → 500 rather than breaking
    at import. An unsupported mesh (genus ≥ 1, mode mismatch) raises out of ``detect_mode`` and is
    surfaced the same way — a failed job, never a dead service.
    """
    try:
        from app import meshio, pipeline, pipeline_closed  # noqa: PLC0415 — deliberately lazy
    except ImportError as e:
        raise RuntimeError(
            "NURBS fitting pipeline is unavailable: the mesh→fit stack "
            "(app.meshio / app.pipeline / app.pipeline_closed → MLX/trimesh/pythonocc) failed to "
            "import. The HTTP shell is up — /health works and /fit accepts jobs — but a fit cannot "
            "run until the fitting dependencies are installed."
        ) from e

    glb_bytes = base64.b64decode(payload["glb_base64"])
    mesh = meshio.load_mesh(glb_bytes)
    # Resolve mode against the real topology (raises on mismatch / unsupported topology → job fails).
    resolved = meshio.detect_mode(mesh, payload.get("mode", "auto"))
    # The .get() fallbacks below mirror the §6.1 wire defaults (degree 3, grid 16, iters 200). Over
    # HTTP FitBody always populates these, so the fallbacks never fire; they matter only for a
    # directly-built payload (e.g. U10 reconstruct delegation), where iters=0 would have silently
    # forced pure-LSQ instead of the spec'd 200-iter gradient refine.
    if resolved == "open":
        return pipeline.fit_open(
            glb_bytes,
            mode=resolved,
            degree=payload.get("degree", 3),
            grid=payload.get("grid", 16),
            iters=payload.get("iters", 200),
            fidelity_tol=payload.get("fidelity_tol"),
        )
    if resolved == "closed":
        return pipeline_closed.fit_closed(
            glb_bytes,
            degree=payload.get("degree", 3),
            grid=payload.get("grid", 16),
            iters=payload.get("iters", 200),
            fidelity_tol=payload.get("fidelity_tol"),
        )
    # detect_mode only ever returns "open"/"closed" (else it raises); guard against a future mode.
    raise RuntimeError(f"unroutable resolved mode {resolved!r} — expected 'open' or 'closed'")


def create_app(fit_fn: FitFn) -> FastAPI:
    """Build the NURBS service ASGI app around an injected fitting callable.

    ``fit_fn(payload) -> {"step", "surfaces", "report"}`` does the heavy mesh→fit→STEP work; it runs
    off the event loop (``asyncio.to_thread``). The app owns its own :class:`~app.jobs.JobStore`.
    ``NURBS_CORS_ORIGINS`` and ``NURBS_MAX_CONCURRENT_JOBS`` are read here (per app), so a test can
    ``setenv`` then build; the auth key is read per-request in :func:`require_auth`.
    """
    origins_env = os.environ.get("NURBS_CORS_ORIGINS", "*")
    origins = (
        ["*"]
        if origins_env.strip() == "*"
        else [o.strip() for o in origins_env.split(",") if o.strip()]
    )
    _max_raw = os.environ.get("NURBS_MAX_CONCURRENT_JOBS", "2")
    try:
        # Floor at 1: a 0/negative cap would make every /fit 429 and silently wedge the service.
        max_concurrent = max(1, int(_max_raw))
    except ValueError as exc:
        # Fail LOUDLY (naming the env var) instead of an opaque int() traceback at module import.
        raise RuntimeError(
            f"NURBS_MAX_CONCURRENT_JOBS must be an integer (got {_max_raw!r})"
        ) from exc

    app = FastAPI(title="plastiq-nurbs", version="0.1.0")
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"]
    )
    store = JobStore()

    # Startup config summary (env-derived; the key itself is NEVER logged) — one line to grep for.
    logger.info(
        "plastiq-nurbs configured: cors_origins=%s (NURBS_CORS_ORIGINS), auth=%s (NURBS_API_KEY), "
        "max_concurrent_jobs=%d (NURBS_MAX_CONCURRENT_JOBS), caps: glb_base64=%d bytes",
        origins,
        "bearer" if _api_key() else "open (dev)",
        max_concurrent,
        MAX_GLB_BASE64,
    )

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "plastiq-nurbs"}

    @app.post("/fit", response_model=JobView)
    async def submit_fit(body: FitBody, _: None = Depends(require_auth)) -> JobView:
        if store.running_count() >= max_concurrent:
            logger.warning(
                "rejected /fit submit: %d jobs already in flight (cap %d)",
                store.running_count(),
                max_concurrent,
            )
            raise HTTPException(status_code=429, detail="too many fitting jobs in flight; retry shortly")

        payload = body.model_dump()

        async def work() -> dict:
            # MLX fitting + OCCT STEP conversion is CPU/GPU-bound → run off the event loop.
            return await asyncio.to_thread(fit_fn, payload)

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
            raise HTTPException(status_code=500, detail=job.error or "fitting failed")
        if job.state != JobState.completed or job.result is None:
            raise HTTPException(status_code=409, detail=f"job not complete (state: {job.state.value})")
        return job.result

    @app.delete("/jobs/{job_id}", status_code=204)
    def cancel_job(job_id: str, _: None = Depends(require_auth)) -> Response:
        """Drop a job record (SPEC-12 §6.1: in-flight worker's result discarded). 204 if it existed,
        else 404; status/result for this id return 404 afterwards."""
        if not store.delete(job_id):
            raise HTTPException(status_code=404, detail="no such job")
        return Response(status_code=204)

    return app


# Module-level app for ``uvicorn app.main:app`` — wired to the (lazily imported) production pipeline.
app = create_app(_load_pipeline_fit)
