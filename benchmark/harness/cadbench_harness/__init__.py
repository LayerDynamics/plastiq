"""cadbench_harness — cad-studio's integration harness for CADGenBench.

This package is *our* committed code. It treats the vendored, gitignored
``benchmark/cadgenbench`` checkout (upstream ``github.com/huggingface/cadgenbench``)
as a black-box scoring tool and never edits it. Responsibilities:

- prove the upstream scorer runs in our environment (``score_fixtures``),
- run the same CAD-validity gate the grader uses on any candidate (``sanity``),
- drive our parametric generation model over the CADGenBench input fixtures
  (mounted at ``<repo>/local``) and score / package the results
  (``run_bench``, ``validate``, ``package``, ``score`` — added per milestone).

Run everything inside the dedicated ``cadgenbench`` (Python 3.12) environment:

    mamba run -n cadgenbench python -m cadbench_harness <subcommand>
"""
from __future__ import annotations

__all__ = [
    "paths", "sanity", "score_fixtures", "run_bench", "validate", "package", "score", "cli",
]
