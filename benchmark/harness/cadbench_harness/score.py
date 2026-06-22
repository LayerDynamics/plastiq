"""CB4.4 — score a run against ground truth *when it is available*, else fall back.

The official ground truth is private, so by default this cannot produce a CAD
Score locally; it validates the candidates and points at the Space (the same path
CB4.1 takes). The moment a ground-truth source becomes resolvable — set
``CADGENBENCH_DATA_GT_REPO`` (a Hub dataset you can read) and ``HF_TOKEN``, or
``CADGENBENCH_DATA_DIR`` (a local ``inputs/`` + ``gt/`` tree) — the SAME command
runs the full ``evaluate_result`` per fixture and prints real CAD Scores. No code
change the day access lands; see SUBMIT.md for how to request it.

CLI::

    python -m cadbench_harness score <run_name>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .paths import RUNS_DIR
from .validate import validate_run


def resolve_gt_root() -> Path | None:
    """The ground-truth fixtures root if resolvable (env-gated), else None.

    ``cadgenbench.common.paths.data_gt_dir`` resolves a Hub snapshot
    (``CADGENBENCH_DATA_GT_REPO`` + ``HF_TOKEN``) or a local ``<dir>/gt`` tree,
    and raises when neither is configured. We treat any failure as "no GT" so the
    caller falls back to validity-only.
    """
    try:
        from cadgenbench.common.paths import data_gt_dir

        root = Path(data_gt_dir())
        return root if root.exists() else None
    except Exception:
        return None


def score_run(run_name: str) -> dict:
    """Full CAD Score per fixture when GT resolves; else validity-only fallback."""
    run_dir = RUNS_DIR / run_name
    if not run_dir.exists():
        raise FileNotFoundError(f"no run at {run_dir}")

    gt_root = resolve_gt_root()
    if gt_root is None:
        report = validate_run(run_name)
        report["scored"] = False
        report["reason"] = (
            "ground truth not available (private). Candidates were validated only; "
            "submit the packaged zip to the leaderboard Space for the CAD Score. "
            "To score locally, grant this account read access to the GT and set "
            "CADGENBENCH_DATA_GT_REPO + HF_TOKEN (see SUBMIT.md)."
        )
        (run_dir / "score.json").write_text(json.dumps(report, indent=2))
        return report

    from cadgenbench.eval.evaluate import evaluate_result

    rows: list[dict] = []
    for d in sorted(
        (p for p in run_dir.iterdir() if p.is_dir() and p.name.isdigit()),
        key=lambda p: int(p.name),
    ):
        gt_dir = gt_root / d.name
        if not (gt_dir / "ground_truth.step").exists():
            rows.append({"id": d.name, "cad_score": None, "status": "no-gt"})
            continue
        evaluate_result(d, gt_dir)
        data = json.loads((d / "result.json").read_text())
        rows.append({
            "id": d.name,
            "cad_score": data.get("cad_score"),
            "status": data.get("status"),
        })

    scored = [r for r in rows if isinstance(r["cad_score"], (int, float))]
    # None (not 0.0) when nothing scored, so "no fixtures matched GT" is not
    # confused with "a genuine all-zero run".
    mean = sum(r["cad_score"] for r in scored) / len(scored) if scored else None
    report = {
        "run": run_name,
        "scored": True,
        "gt_root": str(gt_root),
        "mean_cad_score": round(mean, 4) if mean is not None else None,
        "n_scored": len(scored),
        "rows": rows,
    }
    (run_dir / "score.json").write_text(json.dumps(report, indent=2))
    return report


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "score",
        help="CAD Score a run against GT if available, else validate + point to the Space.",
    )
    p.add_argument("run_name", help="A run under runs/.")
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    report = score_run(args.run_name)
    if report.get("scored"):
        print(f"mean CAD Score: {report['mean_cad_score']}  (n={report['n_scored']})")
        for r in report["rows"]:
            print(f"  {r['id']:6} {str(r['status']):8} {r['cad_score']}")
    else:
        print("Not scored locally — ground truth unavailable.")
        print(f"  {report['reason']}")
        print(f"  validity counts: {json.dumps(report['counts'])}")
    return 0
