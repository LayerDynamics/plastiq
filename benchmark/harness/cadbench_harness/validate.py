"""CB4.1 — validate a run's candidates against the CAD-validity gate.

For every ``runs/<run>/<id>/output.step`` this runs the same gate the grader uses
(``analyze_step`` via :func:`cadbench_harness.sanity.check_step`) and reports a
per-fixture + aggregate summary. Validity is the hard gate: an invalid candidate
scores zero on the leaderboard no matter how close its geometry, so this is the
go/no-go check before packaging a submission.

The harness's parametric path emits STEP, so the BREP gate applies. A mesh
candidate (``output.stl`` etc.) would be held to the *mesh* gate instead; those are
flagged here as ``mesh`` rather than run through the BREP analyzer.

CLI::

    python -m cadbench_harness validate <run_name>
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .paths import RUNS_DIR
from .sanity import check_step

_STEP_NAMES = ("output.step", "output.stp")
_MESH_NAMES = ("output.stl", "output.obj", "output.off", "output.3mf", "output.ply")


def _candidate(fixture_dir: Path) -> tuple[Path | None, str]:
    """Return ``(path, kind)`` for a fixture's candidate; kind ∈ step|mesh|none."""
    for name in _STEP_NAMES:
        p = fixture_dir / name
        if p.exists():
            return p, "step"
    for name in _MESH_NAMES:
        p = fixture_dir / name
        if p.exists():
            return p, "mesh"
    return None, "none"


def validate_run(run_name: str) -> dict:
    """Validate every candidate in ``runs/<run_name>`` and return a report dict."""
    run_dir = RUNS_DIR / run_name
    if not run_dir.exists():
        raise FileNotFoundError(f"no run at {run_dir}")

    rows: list[dict] = []
    for d in sorted(
        (p for p in run_dir.iterdir() if p.is_dir() and p.name.isdigit()),
        key=lambda p: int(p.name),
    ):
        cand, kind = _candidate(d)
        if kind == "none":
            rows.append({"id": d.name, "status": "missing", "valid": False})
            continue
        if kind == "mesh":
            # The BREP gate doesn't apply; the grader runs the mesh gate. Report
            # presence honestly rather than mislabel it valid/invalid.
            rows.append({"id": d.name, "status": "mesh", "valid": None, "candidate": cand.name})
            continue
        rep = check_step(cand)
        rows.append({
            "id": d.name,
            "status": "valid" if rep.is_valid else "invalid",
            "valid": rep.is_valid,
            "volume": round(rep.volume, 2),
            "bbox": [round(v, 2) for v in rep.bbox],
            "faces": rep.face_count,
        })

    counts: dict[str, int] = {}
    for r in rows:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    report = {"run": run_name, "counts": counts, "rows": rows}
    (run_dir / "validation.json").write_text(json.dumps(report, indent=2))
    return report


def _print_table(report: dict) -> None:
    hdr = f"{'id':6} {'status':8} {'valid':6} {'volume':>12} {'bbox':>24}"
    print(hdr)
    print("-" * len(hdr))
    for r in report["rows"]:
        bbox = "x".join(str(v) for v in r["bbox"]) if "bbox" in r else ""
        vol = f"{r['volume']:.2f}" if "volume" in r else ""
        print(f"{r['id']:6} {r['status']:8} {str(r['valid']):6} {vol:>12} {bbox:>24}")
    print()
    print("counts:", json.dumps(report["counts"]))


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "validate", help="Run the CAD-validity gate over a run's candidates.",
    )
    p.add_argument("run_name", help="A run under runs/.")
    p.add_argument("--json", action="store_true", help="Emit the report as JSON.")
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    report = validate_run(args.run_name)
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        _print_table(report)
    # Exit non-zero only if there is not a single valid candidate to submit.
    return 0 if report["counts"].get("valid", 0) > 0 else 1
