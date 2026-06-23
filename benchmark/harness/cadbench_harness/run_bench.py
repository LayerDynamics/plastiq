"""CB3.2 — generate ``output.step`` candidates over the CADGenBench input fixtures.

For each fixture in the mounted inputs dir (``<repo>/local/<id>``), this reads
``description.yaml``, builds the ``plastiq-gen`` invocation (our headless
parametric agent), runs it against a **local** OpenAI-compatible model
(``mlx_lm.server`` / ``mlx-vlm`` / ``llama-server``), and writes the candidate to
``runs/<run>/<id>/output.step``. Generation fixtures pass the drawing as a vision
image; editing fixtures seed the starting STEP and pass the edit instruction.

The harness is resume-safe: a fixture whose candidate already passes the CAD
validity gate is skipped. Command construction and fixture parsing are pure
functions (unit-tested in ``tests/test_run_bench.py``); the only side effect is the
``plastiq-gen`` subprocess and the file write.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path

import yaml

from .paths import APP_DIR, RUNS_DIR, input_fixtures
from .sanity import check_step

# Default headless-CLI launcher: tsx running the TS entry, from the app dir so its
# node_modules resolve. Overridable for CI / alternate runners.
DEFAULT_GEN_CMD: tuple[str, ...] = ("npx", "tsx", "src/headless/cli.ts")

_MESH_OR_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


@dataclass(frozen=True)
class Fixture:
    """One parsed input fixture (generation or editing)."""

    id: str
    dir: Path
    task_type: str  # "generation" | "editing"
    description: str
    input_type: str  # "text+image" | "text+step"
    images: tuple[Path, ...]
    input_step: Path | None
    edit_text: str | None

    @property
    def is_editing(self) -> bool:
        return self.task_type == "editing"


def load_fixture(fixture_dir: Path) -> Fixture:
    """Parse ``<fixture_dir>/description.yaml`` (+ siblings) into a Fixture.

    ``task_type`` defaults to ``"generation"`` when absent (the generation
    fixtures omit it). Image inputs are resolved relative to the fixture dir.
    """
    fixture_dir = Path(fixture_dir)
    meta = yaml.safe_load((fixture_dir / "description.yaml").read_text()) or {}
    task_type = str(meta.get("task_type", "generation"))
    input_files = [str(f) for f in (meta.get("input_files") or [])]

    images = tuple(
        fixture_dir / f
        for f in input_files
        if Path(f).suffix.lower() in _MESH_OR_IMAGE_EXT
    )
    input_step = next(
        (fixture_dir / f for f in input_files if Path(f).suffix.lower() in {".step", ".stp"}),
        None,
    )
    edit_file = fixture_dir / "edit_description.txt"
    edit_text = edit_file.read_text().strip() if edit_file.exists() else None

    return Fixture(
        id=fixture_dir.name,
        dir=fixture_dir,
        task_type=task_type,
        description=str(meta.get("description", "")).strip(),
        input_type=str(meta.get("input_type", "")),
        images=images,
        input_step=input_step,
        edit_text=edit_text,
    )


@dataclass
class RunConfig:
    model: str
    base_url: str = "http://localhost:8080/v1"
    api_key: str | None = None
    vision: bool = False
    caption_base_url: str | None = None
    caption_model: str | None = None
    caption_api_key: str | None = None
    max_steps: int | None = None
    first_tool: str | None = None
    gen_cmd: tuple[str, ...] = DEFAULT_GEN_CMD
    workers: int = 1
    force: bool = False
    limit: int | None = None
    only: tuple[str, ...] = field(default_factory=tuple)


def build_command(fixture: Fixture, out_path: Path, cfg: RunConfig) -> list[str]:
    """Construct the ``plastiq-gen`` argv for one fixture (pure)."""
    cmd: list[str] = [*cfg.gen_cmd, "--model", cfg.model, "--base-url", cfg.base_url,
                      "--desc", fixture.description, "--out", str(out_path), "--json"]
    if cfg.api_key:
        cmd += ["--api-key", cfg.api_key]
    if cfg.max_steps is not None:
        cmd += ["--max-steps", str(cfg.max_steps)]
    if cfg.first_tool:
        cmd += ["--first-tool", cfg.first_tool]
    if fixture.is_editing:
        if fixture.input_step is not None:
            cmd += ["--input-step", str(fixture.input_step)]
        if fixture.edit_text:
            cmd += ["--edit", fixture.edit_text]
    else:
        # Generation: feed the drawing(s) when the tool model is vision-capable
        # (--vision) OR a separate captioner is configured (two-stage pipeline).
        if (cfg.vision or cfg.caption_base_url) and fixture.images:
            if cfg.vision:
                cmd += ["--vision"]
            for img in fixture.images:
                cmd += ["--image", str(img)]
            if cfg.caption_base_url and cfg.caption_model:
                cmd += ["--caption-base-url", cfg.caption_base_url,
                        "--caption-model", cfg.caption_model]
                if cfg.caption_api_key:
                    cmd += ["--caption-api-key", cfg.caption_api_key]
    return cmd


def _redacted(cmd: list[str]) -> str:
    """The command for logging, with any ``--api-key`` value masked (no secret on disk)."""
    parts = list(cmd)
    for i, a in enumerate(parts):
        if a == "--api-key" and i + 1 < len(parts):
            parts[i + 1] = "***"
    return " ".join(parts)


def parse_summary(stdout: str) -> dict:
    """Extract the plastiq-gen `--json` summary (last JSON object line) from stdout.

    The CLI prints a one-line JSON summary; OCCT/export chatter shares stdout, so we
    scan from the end for the last parseable ``{...}`` line. Returns {} if none.
    """
    for line in reversed(stdout.strip().splitlines()):
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                return json.loads(s)
            except json.JSONDecodeError:
                continue
    return {}


def _candidate_ok(out_path: Path) -> bool:
    """True iff a candidate exists and passes the validity gate (resume check)."""
    if not out_path.exists():
        return False
    try:
        return check_step(out_path).is_valid
    except Exception:
        return False


def run_one(fixture: Fixture, run_dir: Path, cfg: RunConfig) -> dict:
    """Generate (or reuse) one fixture's candidate; return a result record."""
    out_dir = run_dir / fixture.id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "output.step"
    log_path = out_dir / "plastiq-gen.log"

    if not cfg.force and _candidate_ok(out_path):
        return {"id": fixture.id, "task": fixture.task_type, "status": "skipped-valid",
                "out": str(out_path)}

    cmd = build_command(fixture, out_path, cfg)
    proc = subprocess.run(
        cmd, cwd=str(APP_DIR), capture_output=True, text=True,
    )
    log_path.write_text(
        f"$ {_redacted(cmd)}\n\n[exit {proc.returncode}]\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}\n"
    )

    valid = _candidate_ok(out_path)
    summary = parse_summary(proc.stdout)
    return {
        "id": fixture.id,
        "task": fixture.task_type,
        "status": "valid" if valid else ("invalid" if out_path.exists() else "missing"),
        "exit": proc.returncode,
        # For an editing task, applied=False means the model returned the input
        # unchanged (a no-op edit), distinct from a real edit — surfaced for honesty.
        "applied": summary.get("applied"),
        "finish": summary.get("finish"),
        "out": str(out_path) if out_path.exists() else None,
    }


def select_fixtures(cfg: RunConfig) -> list[Fixture]:
    """The fixtures to run, honoring ``--only`` and ``--limit``."""
    dirs = input_fixtures()
    if cfg.only:
        wanted = set(cfg.only)
        dirs = [d for d in dirs if d.name in wanted]
    if cfg.limit is not None:
        dirs = dirs[: cfg.limit]
    return [load_fixture(d) for d in dirs]


def run_bench(cfg: RunConfig, run_name: str) -> dict:
    """Generate candidates for the selected fixtures; write a run manifest."""
    run_dir = RUNS_DIR / run_name
    run_dir.mkdir(parents=True, exist_ok=True)
    fixtures = select_fixtures(cfg)

    results: list[dict] = []
    if cfg.workers > 1:
        with ThreadPoolExecutor(max_workers=cfg.workers) as ex:
            futs = {ex.submit(run_one, fx, run_dir, cfg): fx for fx in fixtures}
            for fut in as_completed(futs):
                results.append(fut.result())
    else:
        for fx in fixtures:
            results.append(run_one(fx, run_dir, cfg))

    results.sort(key=lambda r: int(r["id"]))
    counts: dict[str, int] = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    manifest = {
        "run": run_name,
        "model": cfg.model,
        "base_url": cfg.base_url,
        "counts": counts,
        "results": results,
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    return manifest


def add_subparser(subparsers: argparse._SubParsersAction) -> None:
    p = subparsers.add_parser(
        "run", help="Generate output.step candidates over the input fixtures.",
    )
    p.add_argument("run_name", help="Name for this run (a subdir of runs/).")
    p.add_argument("--model", required=True, help="Model id served by the endpoint.")
    p.add_argument("--base-url", default="http://localhost:8080/v1")
    p.add_argument("--api-key", default=None)
    p.add_argument("--vision", action="store_true", help="Tool model accepts images directly.")
    p.add_argument("--caption-base-url", default=None,
                   help="Vision captioner endpoint (two-stage: caption the drawing, then generate).")
    p.add_argument("--caption-model", default=None, help="Vision captioner model id.")
    p.add_argument("--caption-api-key", default=None)
    p.add_argument("--max-steps", type=int, default=None)
    p.add_argument("--first-tool", default=None,
                   help="Force this tool on turn 1 (e.g. build_part) for weak models.")
    p.add_argument("--workers", type=int, default=1)
    p.add_argument("--force", action="store_true", help="Regenerate even valid candidates.")
    p.add_argument("--limit", type=int, default=None, help="Only the first N fixtures.")
    p.add_argument("--only", nargs="*", default=[], help="Specific fixture ids.")
    p.set_defaults(handler=_run)


def _run(args: argparse.Namespace) -> int:
    cfg = RunConfig(
        model=args.model,
        base_url=args.base_url,
        api_key=args.api_key,
        vision=args.vision,
        caption_base_url=args.caption_base_url,
        caption_model=args.caption_model,
        caption_api_key=args.caption_api_key,
        max_steps=args.max_steps,
        first_tool=args.first_tool,
        workers=args.workers,
        force=args.force,
        limit=args.limit,
        only=tuple(args.only),
    )
    manifest = run_bench(cfg, args.run_name)
    print(json.dumps(manifest["counts"], indent=2))
    print(f"-> {RUNS_DIR / args.run_name}")
    # Non-zero only if nothing was produced at all.
    produced = sum(v for k, v in manifest["counts"].items() if k in {"valid", "skipped-valid"})
    return 0 if produced > 0 else 1


# Re-export a couple of pure helpers for dataclasses.replace ergonomics in tests.
__all__ = ["Fixture", "RunConfig", "load_fixture", "build_command", "run_bench", "dataclasses"]
