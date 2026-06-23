"""CB1.2 — prove the upstream CAD Score pipeline runs (and discriminates) here.

The official ground truth is private, so we cannot score our own generations
locally. But the vendored repo ships four self-contained fixtures
(``tests/fixtures/jig_metric/test_{1..4}``) — each a ground-truth solid plus a
``correct`` candidate and several deliberately ``broken_*`` ones, with authored
interface sub-volumes. Running the real ``evaluate_result`` over them proves two
things end-to-end in *our* environment:

1. the full pipeline (validity gate -> rigid alignment -> shape similarity ->
   interface match -> topology match -> CAD Score) executes against real OCCT +
   VTK on this machine, and
2. it *discriminates*: the correct candidate outscores every broken one.

``evaluate_result(result_dir, gt_dir)`` expects ``gt_dir/ground_truth.step``
(plus any ``jig_*__*__*.step`` sub-volumes) and a candidate at
``result_dir/output.step``. The fixtures store the GT as ``gt.step`` and the
candidates under ``candidates/``, so we stage matching directories in a temp
area before scoring.

CLI::

    python -m cadbench_harness score-fixtures
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from cadgenbench.eval.evaluate import evaluate_result

from .paths import jig_fixtures


def _stage_gt(test_dir: Path, dest: Path) -> Path:
    """Lay out a GT directory the scorer understands: ``ground_truth.step`` +
    the fixture's interface sub-volumes."""
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copy(test_dir / "gt.step", dest / "ground_truth.step")
    for jig in sorted(test_dir.glob("jig_*__*__*.step")):
        shutil.copy(jig, dest / jig.name)
    return dest


def _score_candidate(candidate_step: Path, gt_dir: Path, work: Path) -> dict:
    """Stage one candidate as ``output.step`` and return its ``result.json``."""
    result_dir = work / candidate_step.stem
    result_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy(candidate_step, result_dir / "output.step")
    evaluate_result(result_dir, gt_dir)
    return json.loads((result_dir / "result.json").read_text())


def score_fixture(test_dir: Path, work: Path) -> dict[str, dict]:
    """Score every candidate of one ``test_*`` fixture against its GT.

    Returns ``{candidate_stem: result_json}``. The ``correct`` candidate must be
    present (it is the discrimination baseline).
    """
    gt_dir = _stage_gt(test_dir, work / "_gt")
    # Exclude ``*_aligned.step`` artifacts that a prior run of the upstream test
    # suite may have written beside the real candidates (the vendored repo is a
    # separate, gitignored checkout; its tests dirty their own fixtures dir).
    candidates = sorted(
        c
        for c in (test_dir / "candidates").glob("*.step")
        if not c.stem.endswith("_aligned")
    )
    if not any(c.stem == "correct" for c in candidates):
        raise FileNotFoundError(f"{test_dir} has no candidates/correct.step")
    return {
        c.stem: _score_candidate(c, gt_dir, work) for c in candidates
    }


# --- GPU-memory monitoring ------------------------------------------------
#
# Each candidate's shape phase renders a 120-frame turntable WebP (for the
# report gallery) through VTK -> the macOS Metal backend. ``pl.close()`` frees
# the VTK render window per frame, but on Apple Silicon the Metal command-buffer
# pool is NOT reclaimed within a long-lived process: it grows until the GPU runs
# out of unified memory. The driver then prints these async error lines to
# stderr — VTK never raises on them, so the render silently corrupts and the
# render window eventually becomes "not current" (RenderWindowUnavailable).
# We detect exhaustion by scanning a scoring subprocess's stderr for them.
GPU_OOM_SIGNATURES: tuple[str, ...] = (
    "kIOGPUCommandBufferCallbackErrorOutOfMemory",
    "Insufficient Memory",
    "command buffer completion error",
    "RenderWindowUnavailable",
    "Render window is not current",
)


def detect_gpu_pressure(stderr_text: str) -> list[str]:
    """Return the GPU-out-of-memory signatures present in *stderr_text* (empty
    when the render ran clean). Used to flag a scoring run whose renders may be
    degraded by Metal memory exhaustion."""
    return [s for s in GPU_OOM_SIGNATURES if s in stderr_text]


# A fixture scores several candidates, each doing alignment + a 120-frame
# turntable render; ~40s is typical, so 15 min is generous slack before we call
# the subprocess hung.
FIXTURE_TIMEOUT_S = 900


def _score_fixture_isolated(
    test_dir: Path, timeout: float = FIXTURE_TIMEOUT_S,
) -> dict[str, dict]:
    """Score one fixture in a dedicated subprocess and return its results dict.

    This is how we *account for* the GPU-memory leak: a fresh interpreter per
    fixture means the OS tears down the entire VTK/Metal context — and every
    byte of GPU memory the turntable renders accumulated — when the process
    exits, so scoring many fixtures never exhausts the GPU. It is also how we
    *monitor* it: the child's stderr is captured and scanned for
    {@link GPU_OOM_SIGNATURES}; a non-zero exit (incl. a signal kill from a hard
    OOM) and any pressure signature are surfaced loudly instead of crashing the
    whole run with a cryptic VTK error.
    """
    with tempfile.TemporaryDirectory(prefix="cadbench_iso_") as tmp:
        out_path = Path(tmp) / "result.json"
        try:
            proc = subprocess.run(
                [sys.executable, "-m", "cadbench_harness.score_fixtures",
                 str(test_dir), str(out_path)],
                capture_output=True, text=True, timeout=timeout, check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(
                f"scoring fixture {test_dir.name} did not finish within "
                f"{timeout:.0f}s; the renderer likely deadlocked under GPU-memory "
                f"pressure",
            ) from exc

        pressure = detect_gpu_pressure(proc.stderr or "")
        if proc.returncode != 0 or not out_path.exists():
            detail = (
                f"; GPU-memory pressure detected ({', '.join(pressure)})"
                if pressure else ""
            )
            raise RuntimeError(
                f"scoring fixture {test_dir.name} failed in subprocess "
                f"(exit={proc.returncode}){detail}\n"
                f"--- stderr tail ---\n{(proc.stderr or '')[-2000:]}",
            )
        if pressure:
            # Exited 0 but the GPU driver still reported memory exhaustion: the
            # CAD Score is mesh-derived (chamfer / IoU / topology), not
            # pixel-derived, so the score is still valid, but the report renders
            # may be degraded — surface it rather than hide it.
            print(
                f"[gpu] fixture {test_dir.name}: GPU-memory pressure during render "
                f"(scores valid, report renders may be degraded): "
                f"{', '.join(pressure)}",
                file=sys.stderr,
            )
        return json.loads(out_path.read_text())


def evaluate_all() -> tuple[list[dict], bool]:
    """Score all bundled fixtures. Returns ``(rows, discriminates)``.

    ``rows`` is one dict per (fixture, candidate) with its CAD Score and status.
    ``discriminates`` is True iff, for every fixture, ``correct`` strictly
    outscores each ``broken_*`` — the property that makes the metric meaningful.

    Each fixture is scored in its own subprocess ({@link _score_fixture_isolated})
    so the VTK/Metal GPU context is reclaimed between fixtures; scoring all of
    them in one process exhausts GPU memory on Apple Silicon.
    """
    rows: list[dict] = []
    discriminates = True
    for test_dir in jig_fixtures():
        results = _score_fixture_isolated(test_dir)
        correct_score = float(results["correct"].get("cad_score", 0.0))
        for stem, data in sorted(results.items()):
            score = float(data.get("cad_score", 0.0))
            is_broken = stem.startswith("broken")
            outranked = is_broken and score >= correct_score
            if outranked:
                discriminates = False
            rows.append(
                {
                    "fixture": test_dir.name,
                    "candidate": stem,
                    "cad_score": round(score, 4),
                    "status": data.get("status"),
                    "interface": (data.get("interface_metrics") or {}).get(
                        "score"
                    ),
                    "topology": (data.get("topology_metrics") or {}).get(
                        "score"
                    ),
                    "shape": (data.get("gt_metrics") or {}).get(
                        "shape_similarity_score"
                    ),
                    "broken_outranks_correct": outranked,
                }
            )
    return rows, discriminates


def _print_table(rows: list[dict]) -> None:
    hdr = f"{'fixture':8} {'candidate':24} {'status':8} {'cad':>6} {'shape':>6} {'iface':>6} {'topo':>6}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows:
        def fmt(v: object) -> str:
            return f"{v:.3f}" if isinstance(v, (int, float)) else "  -  "

        flag = "  <-- broken outranks correct!" if r["broken_outranks_correct"] else ""
        print(
            f"{r['fixture']:8} {r['candidate']:24} {str(r['status']):8} "
            f"{fmt(r['cad_score']):>6} {fmt(r['shape']):>6} "
            f"{fmt(r['interface']):>6} {fmt(r['topology']):>6}{flag}"
        )


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "score-fixtures",
        help="Prove the scorer runs + discriminates on the bundled GT fixtures.",
    )
    p.add_argument(
        "--json", action="store_true", help="Emit the rows as JSON instead of a table.",
    )
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    rows, discriminates = evaluate_all()
    if args.json:
        print(json.dumps({"rows": rows, "discriminates": discriminates}, indent=2))
    else:
        _print_table(rows)
        print()
        print(
            "RESULT: scorer "
            + ("DISCRIMINATES (correct > broken everywhere) ✓" if discriminates
               else "FAILED to discriminate — a broken candidate tied/beat correct ✗")
        )
    return 0 if discriminates else 1


def _score_one_worker(test_dir: Path, out_path: Path) -> None:
    """Per-fixture subprocess body (see {@link _score_fixture_isolated}).

    Scores one fixture in this fresh interpreter and writes the results dict to
    *out_path* as JSON. An uncaught exception aborts with a non-zero exit and a
    traceback on stderr; a hard GPU OOM kills this process with a signal — both
    are detected by the parent. We write to a file (not stdout) so the parent's
    JSON parse is immune to any stray stdout from the scorer.
    """
    with tempfile.TemporaryDirectory(prefix="cadbench_fx_") as tmp:
        results = score_fixture(test_dir, Path(tmp))
    out_path.write_text(json.dumps(results))


if __name__ == "__main__":
    # Worker mode: ``python -m cadbench_harness.score_fixtures <test_dir> <out_json>``.
    # Invoked only by _score_fixture_isolated; not part of the public CLI.
    _score_one_worker(Path(sys.argv[1]), Path(sys.argv[2]))
