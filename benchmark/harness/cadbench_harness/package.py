"""CB4.2 — bundle a run into a leaderboard-ready submission zip.

The canonical packager (``cadgenbench baseline package``) already produces the
exact zip layout + ``meta.json`` the leaderboard Space validates against — one
folder per fixture with its ``output.*`` candidate, plus a top-level ``meta.json``
(``submitter_name``, ``submission_name``, ``agent_url``, ``notes``,
``agree_to_publish``). Our run dirs (``runs/<run>/<id>/output.step``) match its
``<fixture>/output.*`` contract, so this command delegates to it rather than
re-implementing — guaranteeing the bundle stays in lockstep with the validator.

CLI::

    python -m cadbench_harness package <run_name> --submitter "Me" --name "v1" --agree
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from .paths import RUNS_DIR


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "package",
        help="Bundle a run into a submission zip (delegates to cadgenbench baseline package).",
    )
    p.add_argument("run_name", help="A run under runs/.")
    p.add_argument("-o", "--output", type=Path, default=None, help="Output zip path.")
    p.add_argument("--submitter", default=None, help="meta.json submitter_name.")
    p.add_argument("--name", dest="submission_name", default=None, help="meta.json submission_name.")
    p.add_argument("--agent-url", default=None, help="meta.json agent_url.")
    p.add_argument("--notes", default=None, help="meta.json notes (<=500 chars).")
    p.add_argument("--agree", action="store_true",
                   help="Set agree_to_publish=true (required before the Space accepts the zip).")
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    run_dir = RUNS_DIR / args.run_name
    if not run_dir.exists():
        raise FileNotFoundError(f"no run at {run_dir}")

    cmd = [sys.executable, "-m", "cadgenbench.cli", "baseline", "package", str(run_dir)]
    if args.output:
        cmd += ["-o", str(args.output)]
    if args.submitter:
        cmd += ["--submitter", args.submitter]
    if args.submission_name:
        cmd += ["--name", args.submission_name]
    if args.agent_url:
        cmd += ["--agent-url", args.agent_url]
    if args.notes:
        cmd += ["--notes", args.notes]
    if args.agree:
        cmd += ["--agree"]

    proc = subprocess.run(cmd)
    if proc.returncode == 0 and not args.agree:
        print(
            "\nNote: agree_to_publish=false (no --agree). The Space won't accept the "
            "zip until you re-run with --agree. See SUBMIT.md.",
        )
    return proc.returncode
