"""CB1.3 — the CAD-validity gate, runnable on any candidate STEP.

Mirrors the ``sanity_check_submission.py`` helper shipped with the input
dataset: it runs ``cadgenbench.common.validity.analyze_step`` — the exact gate
the grading pipeline uses to decide whether ``cad_score = 0``. A candidate that
fails here will score zero no matter how close its geometry is, so this is the
first thing to run on a freshly generated ``output.step``.

CLI::

    python -m cadbench_harness sanity path/to/output.step
"""
from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path

from cadgenbench.common.mesh import deflection_for_bbox
from cadgenbench.common.validity import analyze_step


@dataclass(frozen=True)
class SanityReport:
    """Flat, JSON-friendly view of the validity gate for one STEP."""

    path: Path
    is_valid: bool
    is_watertight: bool
    solid_count: int
    shell_count: int
    face_count: int
    volume: float
    bbox: tuple[float, float, float]
    deflection_mm: float
    errors: tuple[str, ...]

    def format(self) -> str:
        if self.is_valid:
            x, y, z = self.bbox
            return (
                f"PASS  {self.path.name}: is_valid=True watertight=True\n"
                f"      solids={self.solid_count} shells={self.shell_count} "
                f"faces={self.face_count}\n"
                f"      volume={self.volume:.2f}  bbox={x:.2f}x{y:.2f}x{z:.2f}  "
                f"defl_used={self.deflection_mm:.4f} mm"
            )
        lines = [
            f"FAIL  {self.path.name}: is_valid=False  "
            f"watertight={self.is_watertight}",
        ]
        for err in self.errors[:10]:
            lines.append(f"      - {err}")
        if len(self.errors) > 10:
            lines.append(f"      ... and {len(self.errors) - 10} more")
        return "\n".join(lines)


def check_step(step: Path) -> SanityReport:
    """Run the validity gate on *step* and return a structured report.

    Raises FileNotFoundError if the file is missing. A STEP that fails to load
    is reported as ``is_valid=False`` with the loader error captured, matching
    how the grader treats an unreadable candidate (it scores zero, it does not
    crash the run).
    """
    step = Path(step)
    if not step.exists():
        raise FileNotFoundError(f"candidate STEP not found: {step}")
    try:
        analysis = analyze_step(step)
    except Exception as exc:  # loader/parse failure == invalid candidate
        return SanityReport(
            path=step,
            is_valid=False,
            is_watertight=False,
            solid_count=0,
            shell_count=0,
            face_count=0,
            volume=0.0,
            bbox=(0.0, 0.0, 0.0),
            deflection_mm=0.0,
            errors=(f"STEP load failed: {exc}",),
        )
    val, m = analysis.validation, analysis.measurements
    bb = m.bounding_box
    return SanityReport(
        path=step,
        is_valid=bool(val.is_valid),
        is_watertight=bool(val.is_watertight),
        solid_count=int(m.solid_count),
        shell_count=int(m.shell_count),
        face_count=int(m.face_count),
        volume=float(m.volume),
        bbox=(float(bb.size_x), float(bb.size_y), float(bb.size_z)),
        deflection_mm=float(deflection_for_bbox(bb.diagonal)),
        errors=tuple(val.topology_errors),
    )


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "sanity", help="Run the CAD-validity gate on one candidate STEP.",
    )
    p.add_argument("step", type=Path, help="Path to the candidate STEP file.")
    p.add_argument(
        "--quiet", action="store_true",
        help="On pass, exit silently; on fail, still print the reason.",
    )
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    report = check_step(args.step)
    if report.is_valid:
        if not args.quiet:
            print(report.format())
        return 0
    print(report.format())
    return 1
