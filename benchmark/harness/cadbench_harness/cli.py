"""``cadbench-harness`` console entry — dispatches to the subcommands.

Each subcommand module exposes ``add_subparser(subparsers)`` registering a
``handler(args) -> int``. Registered commands: ``score-fixtures``, ``sanity``,
``run``, ``validate``, ``package``, ``score``.
"""
from __future__ import annotations

import argparse
import sys

from . import package, render, run_bench, sanity, score, score_fixtures, validate


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cadbench-harness",
        description="cad-studio harness for the CADGenBench scorer + our models.",
    )
    subparsers = parser.add_subparsers(dest="command")
    score_fixtures.add_subparser(subparsers)
    sanity.add_subparser(subparsers)
    run_bench.add_subparser(subparsers)
    validate.add_subparser(subparsers)
    package.add_subparser(subparsers)
    score.add_subparser(subparsers)
    render.add_subparser(subparsers)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not hasattr(args, "handler"):
        parser.print_help()
        return 0
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
