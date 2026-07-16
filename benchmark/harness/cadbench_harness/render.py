"""Render a candidate STEP to PNG views for visual inspection.

Wraps ``cadgenbench.common.viewer.render_step`` so any generated ``output.step``
can be eyeballed (iso / top / front / right) — the fastest way to catch geometry
bugs the validity gate can't (a hole in the wrong place, a feature at a corner,
a missing pocket).

CLI::

    python -m cadbench_harness render path/to/output.step -o some/dir
"""
from __future__ import annotations

import argparse
from pathlib import Path


def render_to(step: Path, outdir: Path, views: list[str] | None = None) -> list[Path]:
    """Render *step* to ``<outdir>/<view>.png`` and return the written paths."""
    from cadgenbench.common.viewer import render_step

    step = Path(step)
    if not step.exists():
        raise FileNotFoundError(f"STEP not found: {step}")
    outdir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for img in render_step(str(step), views):
        p = outdir / f"{img.name}.png"
        p.write_bytes(img.data)
        written.append(p)
    return written


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "render", help="Render a candidate STEP to PNG views for visual inspection.",
    )
    p.add_argument("step", type=Path, help="Path to the STEP file.")
    p.add_argument("-o", "--outdir", type=Path, default=None,
                   help="Output dir (default: <step>_renders next to the file).")
    p.add_argument("--views", nargs="*", default=None,
                   help="Camera presets (default: iso top front right).")
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    outdir = args.outdir or args.step.parent / f"{args.step.stem}_renders"
    for p in render_to(args.step, outdir, args.views):
        print(p)
    return 0
