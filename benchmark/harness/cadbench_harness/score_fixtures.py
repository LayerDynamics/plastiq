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


def evaluate_all() -> tuple[list[dict], bool]:
    """Score all bundled fixtures. Returns ``(rows, discriminates)``.

    ``rows`` is one dict per (fixture, candidate) with its CAD Score and status.
    ``discriminates`` is True iff, for every fixture, ``correct`` strictly
    outscores each ``broken_*`` — the property that makes the metric meaningful.
    """
    rows: list[dict] = []
    discriminates = True
    with tempfile.TemporaryDirectory(prefix="cadbench_fixtures_") as tmp:
        tmp_root = Path(tmp)
        for test_dir in jig_fixtures():
            results = score_fixture(test_dir, tmp_root / test_dir.name)
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
