"""Filesystem anchors shared across the harness.

Everything is derived from this file's location so the harness works regardless
of the caller's working directory. Layout (all under the cad-studio repo root)::

    benchmark/
      cadgenbench/        # vendored upstream scorer (gitignored, never edited)
        tests/fixtures/jig_metric/test_{1..4}/   # bundled GT + candidates
      harness/            # this package (committed)
        runs/             # generated candidates + reports (gitignored)
    local/                # hf-mount of LayerDynamics/cadgenbench-data-bucket
                          # = the 81 CADGenBench input fixtures (no ground truth)
"""
from __future__ import annotations

from pathlib import Path

HARNESS_DIR: Path = Path(__file__).resolve().parent.parent       # benchmark/harness
BENCHMARK_DIR: Path = HARNESS_DIR.parent                          # benchmark
REPO_ROOT: Path = BENCHMARK_DIR.parent                           # cad-studio

VENDORED_CADGENBENCH: Path = BENCHMARK_DIR / "cadgenbench"
JIG_FIXTURES_ROOT: Path = (
    VENDORED_CADGENBENCH / "tests" / "fixtures" / "jig_metric"
)

# The hf-mount of the input bucket. Each top-level entry is a fixture directory
# named by its numeric id (101-150 generation, 201-250 editing).
INPUTS_DIR: Path = REPO_ROOT / "local"

# Where generated candidates and their reports land. One sub-dir per run.
RUNS_DIR: Path = HARNESS_DIR / "runs"

# The Plastiq app dir — the headless `plastiq-gen` CLI runs from here (so its
# node_modules resolve). See apps/plastiq/src/headless/cli.ts.
APP_DIR: Path = REPO_ROOT / "apps" / "plastiq"


def require(path: Path, what: str, hint: str) -> Path:
    """Return *path* if it exists, else raise with an actionable *hint*."""
    if not path.exists():
        raise FileNotFoundError(f"{what} not found at {path}\n  -> {hint}")
    return path


def jig_fixtures() -> list[Path]:
    """The bundled ``test_*`` jig fixtures (GT + candidate variants), sorted."""
    require(
        JIG_FIXTURES_ROOT,
        "bundled jig_metric fixtures",
        "expected the vendored cadgenbench checkout under benchmark/cadgenbench",
    )
    return sorted(d for d in JIG_FIXTURES_ROOT.glob("test_*") if d.is_dir())


def input_fixtures() -> list[Path]:
    """The mounted CADGenBench input fixtures, sorted by numeric id."""
    require(
        INPUTS_DIR,
        "CADGenBench inputs",
        "mount the bucket: hf-mount start bucket "
        "LayerDynamics/cadgenbench-data-bucket ./local",
    )
    return sorted(
        (d for d in INPUTS_DIR.iterdir() if d.is_dir() and d.name.isdigit()),
        key=lambda d: int(d.name),
    )
