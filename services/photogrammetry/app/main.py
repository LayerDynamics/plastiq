"""Plastiq photogrammetry service (FastAPI) — unposed photos → poses + point clouds, via submit→poll.

POST /solve { images, names?, matching?, dense?, undistort?, max_features?, seed?,
              sparse_max_dim? } → { id, state }
GET  /jobs/{id}/status → { id, state, error? }
GET  /jobs/{id}/result → { transforms_json, images_undistorted, sparse_ply_base64,
                           dense_ply_base64, report }  (200 completed; 409 not yet; 500 failed; 404)
DELETE /jobs/{id}      → 204 (dropped) | 404
GET  /health           → { status, service }

The exact wire contract is frozen in SPEC-13 §6.1 (the ``@plastiq/photogrammetry`` browser client is
written to it); it mirrors services/reconstruct/capture/nerf/nurbs so the browser reuses one
submit→poll client. The SfM + MLX MVS solve is minutes-long and CPU/GPU-bound, so it runs off the
event loop via ``asyncio.to_thread``.

Dependency-injected pipeline (the §6.1 seam). The heavy solve is a ``solve_fn`` handed to
:func:`create_app` — the HTTP shell is built and tested **independently** of the SfM/MVS stack.
``solve_fn(payload: dict) -> {"transforms_json", "images_undistorted", "sparse_ply_base64",
"dense_ply_base64", "report"}`` is called for each accepted /solve job; ``payload`` is the validated
request body (``model_dump``). :func:`create_app` therefore has **no import-time dependency** on
``app.pipeline`` (which pulls MLX/opencv-free-but-heavy numpy/scipy) — tests inject their own
``solve_fn`` for the shell/auth/validation paths, and the module graph stays light enough that the CI
row (NFR-4) exercises the validation paths without MLX. For ``uvicorn app.main:app`` a module-level
``app`` is wired to :func:`_load_pipeline_solve`, whose heavy imports are **lazy** (inside the worker),
so the shell serves /health and accepts /solve even in a fastapi-only env and a solve that raises
fails gracefully (job ``failed`` → 500) rather than breaking the module at import.

Auth mirrors SPEC-13 §6.1 / nerf: if ``PHOTOGRAMMETRY_API_KEY`` is set, ``POST /solve`` and ``DELETE``
require ``Authorization: Bearer <key>`` (401 otherwise, constant-time compare, key read per-request);
unset ⇒ open (the self-hosted dev default). ``PHOTOGRAMMETRY_CORS_ORIGINS`` (default ``*``) and
``PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS`` (default 1 — solves are heavy) are read in :func:`create_app`.
See docs/specs/SPEC-13-photogrammetry-service.md and docs/adr/0013.
"""

from __future__ import annotations

import logging
import os
import secrets
from typing import Callable, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, model_validator

from .jobs import JobState, JobStore
from .logging_setup import setup_logging

setup_logging()
logger = logging.getLogger(__name__)

# Input caps — a single (possibly unauthenticated) /solve must not exhaust memory. ``images`` count is
# a pydantic Field bound; MAX_IMAGE_BASE64 bounds each base64 image string. As with the sibling
# services this is NOT a raw request-body cap (pydantic rejects only after Starlette buffers the whole
# body); true raw body-byte capping belongs at the ASGI/proxy layer.
MAX_IMAGES = 300  # SPEC-13 §6.1 upper bound on the photo count
MIN_IMAGES = 3  # SfM needs at least a few overlapping views
MAX_IMAGE_BASE64 = 48 * 1024 * 1024  # ~48 MiB of base64 text per image (≈36 MiB decoded) — DoS cap

# The solve seam: payload dict (validated /solve body) → the §6.1 result dict.
SolveFn = Callable[[dict], dict]


def _api_key() -> str | None:
    """The bearer key guarding the mutating endpoints. Read from the environment per-request (not at
    import), so the key can be set/rotated without re-importing the app (and tests can monkeypatch it)."""
    return os.environ.get("PHOTOGRAMMETRY_API_KEY")


def require_auth(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: enforce the bearer key on mutating endpoints when the key env is set."""
    key = _api_key()
    if not key:
        return  # unset ⇒ open (dev default)
    expected = f"Bearer {key}"
    # Constant-time comparison (no timing side-channel on the key); bytes so non-ASCII input can't raise.
    if authorization is None or not secrets.compare_digest(
        authorization.encode("utf-8"), expected.encode("utf-8")
    ):
        raise HTTPException(status_code=401, detail="missing or invalid API key")


class SolveBody(BaseModel):
    """A photogrammetry solve job (SPEC-13 §6.1). ``images`` are base64 JPEG/PNG; the rest are the
    solve knobs with their frozen §6.1 bounds. The shell does not decode the images — that is the
    injected pipeline's job; only their count and per-image size are capped."""

    images: list[str] = Field(..., min_length=MIN_IMAGES, max_length=MAX_IMAGES)
    names: list[str] | None = None  # parallel filenames; server names frame_%05d.jpg when absent
    matching: Literal["exhaustive", "sequential"] = "exhaustive"
    dense: bool = True
    undistort: bool = True
    max_features: int = Field(4096, ge=512, le=16384)
    seed: int = Field(0, ge=0)
    # T39: downscale for sparse SfM while dense MVS keeps full-res (ComparativeDeepDive: sparse
    # thresholds are pixel-absolute and tuned ~640px; full-res sparse can collapse registration).
    # None ⇒ no downscale (both stages run at native resolution). Dense always uses the original
    # uploads when sparse_max_dim is set (pipeline dense_images=full).
    sparse_max_dim: int | None = Field(None, ge=256, le=4096)

    @model_validator(mode="after")
    def _check(self) -> "SolveBody":
        if self.names is not None and len(self.names) != len(self.images):
            raise ValueError(
                f"names length ({len(self.names)}) must match images length ({len(self.images)})"
            )
        for i, img in enumerate(self.images):
            if len(img) > MAX_IMAGE_BASE64:
                raise ValueError(f"image {i} exceeds the {MAX_IMAGE_BASE64}-byte base64 cap")
        return self


class JobView(BaseModel):
    id: str
    state: str
    error: str | None = None


def _load_pipeline_solve(payload: dict) -> dict:
    """Production ``solve_fn`` for ``uvicorn app.main:app``: decode → solve → the §6.1 result dict.

    Decodes the base64 photos (PIL → RGB numpy), runs :func:`app.pipeline.solve` (sparse SfM + optional
    dense MLX MVS), and base64-encodes the emitted PLYs. The heavy modules (``app.pipeline`` →
    ``app.core``/``app.mvs`` → MLX/numpy/scipy) are imported **lazily** so this module keeps no
    import-time dependency on the solve stack: the HTTP shell is up (/health, /solve submission) in a
    fastapi-only env, and a genuinely-missing piece fails as a job ``failed`` → 500 rather than
    breaking at import.
    """
    try:
        import base64  # noqa: PLC0415
        import io  # noqa: PLC0415

        import numpy as np  # noqa: PLC0415
        from PIL import Image  # noqa: PLC0415

        from app import pipeline  # noqa: PLC0415 — deliberately lazy (pulls the numpy/MLX solve stack)
    except ImportError as e:
        raise RuntimeError(
            "photogrammetry solve pipeline is unavailable: the SfM/MVS stack "
            "(app.pipeline → app.core/app.mvs → numpy/scipy/MLX/pillow) failed to import. The HTTP "
            "shell is up — /health works and /solve accepts jobs — but a solve cannot run until the "
            "solve dependencies are installed."
        ) from e

    images = []
    exif_sources = []  # the raw uploaded bytes → EXIF focal prior (or the no-EXIF fallback in exif.py)
    for b64 in payload["images"]:
        raw = base64.b64decode(b64)
        exif_sources.append(raw)
        images.append(np.asarray(Image.open(io.BytesIO(raw)).convert("RGB")))

    # T39: sparse_max_dim → register at reduced res, densify at full native resolution.
    sparse_max_dim = payload.get("sparse_max_dim")
    sparse_images = images
    dense_images = None
    if sparse_max_dim is not None:
        sparse_images = []
        for im in images:
            h, w = im.shape[:2]
            longest = max(h, w)
            if longest > sparse_max_dim:
                scale = sparse_max_dim / float(longest)
                new_w = max(1, int(round(w * scale)))
                new_h = max(1, int(round(h * scale)))
                pil = Image.fromarray(im).resize((new_w, new_h), Image.Resampling.BILINEAR)
                sparse_images.append(np.asarray(pil))
            else:
                sparse_images.append(im)
        # Only pass dense_images when we actually downscaled at least one frame (otherwise densify
        # at the same resolution as sparse — same as the historical path).
        if any(s.shape[:2] != f.shape[:2] for s, f in zip(sparse_images, images)):
            dense_images = images

    result = pipeline.solve(
        sparse_images,
        exif_images=exif_sources,
        dense=payload.get("dense", True),
        matching=payload.get("matching", "exhaustive"),
        max_features=payload.get("max_features", 4096),
        seed=payload.get("seed", 0),
        image_names=payload.get("names"),
        undistort=payload.get("undistort", True),
        dense_images=dense_images,
    )

    def _b64(text: str) -> str:
        return base64.b64encode(text.encode("utf-8")).decode("ascii")

    return {
        "transforms_json": result.transforms_json,
        "images_undistorted": result.images_undistorted,
        "sparse_ply_base64": _b64(result.sparse_ply),
        "dense_ply_base64": _b64(result.dense_ply) if result.dense_ply is not None else None,
        "report": result.report,
    }


def create_app(solve_fn: SolveFn) -> FastAPI:
    """Build the photogrammetry service ASGI app around an injected solve callable.

    ``solve_fn(payload) -> {...§6.1 result...}`` does the heavy photos→poses+clouds work; it runs off
    the event loop (``asyncio.to_thread``). The app owns its own :class:`~app.jobs.JobStore`.
    ``PHOTOGRAMMETRY_CORS_ORIGINS`` and ``PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS`` are read here (per app),
    so a test can ``setenv`` then build; the auth key is read per-request in :func:`require_auth`.
    """
    import asyncio  # noqa: PLC0415 — only needed when an app is actually built

    origins_env = os.environ.get("PHOTOGRAMMETRY_CORS_ORIGINS", "*")
    origins = (
        ["*"]
        if origins_env.strip() == "*"
        else [o.strip() for o in origins_env.split(",") if o.strip()]
    )
    _max_raw = os.environ.get("PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS", "1")
    try:
        # Floor at 1: a 0/negative cap would make every /solve 429 and silently wedge the service.
        max_concurrent = max(1, int(_max_raw))
    except ValueError as exc:
        raise RuntimeError(
            f"PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS must be an integer (got {_max_raw!r})"
        ) from exc

    app = FastAPI(title="plastiq-photogrammetry", version="0.1.0")
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"]
    )
    store = JobStore()

    # Startup config summary (env-derived; the key itself is NEVER logged) — one line to grep for.
    logger.info(
        "plastiq-photogrammetry configured: cors_origins=%s (PHOTOGRAMMETRY_CORS_ORIGINS), "
        "auth=%s (PHOTOGRAMMETRY_API_KEY), max_concurrent_jobs=%d "
        "(PHOTOGRAMMETRY_MAX_CONCURRENT_JOBS), caps: images=%d..%d, image_base64=%d bytes",
        origins,
        "bearer" if _api_key() else "open (dev)",
        max_concurrent,
        MIN_IMAGES,
        MAX_IMAGES,
        MAX_IMAGE_BASE64,
    )

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "service": "plastiq-photogrammetry"}

    @app.post("/solve", response_model=JobView)
    async def submit_solve(body: SolveBody, _: None = Depends(require_auth)) -> JobView:
        if store.running_count() >= max_concurrent:
            logger.warning(
                "rejected /solve submit: %d jobs already in flight (cap %d)",
                store.running_count(),
                max_concurrent,
            )
            raise HTTPException(
                status_code=429, detail="too many solve jobs in flight; retry shortly"
            )

        payload = body.model_dump()

        async def work() -> dict:
            # SfM + MLX MVS is CPU/GPU-bound and minutes-long → run off the event loop.
            return await asyncio.to_thread(solve_fn, payload)

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
            raise HTTPException(status_code=500, detail=job.error or "solve failed")
        if job.state != JobState.completed or job.result is None:
            raise HTTPException(status_code=409, detail=f"job not complete (state: {job.state.value})")
        return job.result

    @app.delete("/jobs/{job_id}", status_code=204)
    def cancel_job(job_id: str, _: None = Depends(require_auth)) -> Response:
        """Drop a job record (SPEC-13 §6.1: in-flight worker's result discarded). 204 if it existed,
        else 404; status/result for this id return 404 afterwards."""
        if store.remove(job_id) is None:
            raise HTTPException(status_code=404, detail="no such job")
        return Response(status_code=204)

    return app


# Module-level app for ``uvicorn app.main:app`` — wired to the (lazily imported) production pipeline.
app = create_app(_load_pipeline_solve)
