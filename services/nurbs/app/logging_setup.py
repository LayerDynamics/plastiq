"""Structured logging for the NURBS service.

Configures the ``app.*`` logger hierarchy (every module here logs via ``logging.getLogger(__name__)``)
with a single stream handler so service logs interleave cleanly with uvicorn's access log.
Idempotent: calling it again in the same process (or a ``--reload`` re-import) never stacks
duplicate handlers. INFO by default; override with NURBS_LOG_LEVEL (DEBUG/INFO/WARNING/…).

Mirrors ``services/nerf/app/logging_setup.py`` (SPEC-12 §5.2 ``logging_setup.py`` row).
"""

from __future__ import annotations

import logging
import os

_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def setup_logging(*, level_env_var: str = "NURBS_LOG_LEVEL") -> logging.Logger:
    """Configure and return the service's package logger. Safe to call more than once."""
    level_name = os.environ.get(level_env_var, "INFO").upper()
    logger = logging.getLogger("app")
    logger.setLevel(getattr(logging, level_name, logging.INFO))
    if not logger.handlers:  # idempotent — a second call must not double every log line
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter(_FORMAT))
        logger.addHandler(handler)
    logger.propagate = False  # don't re-emit through the root logger (uvicorn configures its own)
    return logger
