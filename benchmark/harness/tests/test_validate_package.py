"""CB4 tests — validate / score-fallback / package on a staged run.

A real, watertight solid (a bundled jig ``gt.step``) stands in as the candidate so
the *valid* path is exercised deterministically, offline, with no model: validate
reports it valid, the GT-less score falls back with guidance, and package produces
a real submission zip via the canonical packager.
"""
from __future__ import annotations

import argparse
import shutil
import zipfile
from pathlib import Path

from cadbench_harness import package as P
from cadbench_harness import score as S
from cadbench_harness import validate as V
from cadbench_harness.paths import jig_fixtures


def _stage_run(run_root: Path, run_name: str = "r", fixture_id: str = "224") -> Path:
    run_dir = run_root / run_name
    fx = run_dir / fixture_id
    fx.mkdir(parents=True)
    # A bundled GT solid is a genuine valid watertight BREP — a real stand-in
    # candidate, not fabricated data.
    shutil.copy(jig_fixtures()[0] / "gt.step", fx / "output.step")
    return run_dir


def test_validate_reports_valid(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(V, "RUNS_DIR", tmp_path)
    _stage_run(tmp_path)
    report = V.validate_run("r")
    assert report["counts"].get("valid") == 1
    row = report["rows"][0]
    assert row["valid"] is True
    assert row["volume"] > 0
    assert (tmp_path / "r" / "validation.json").exists()


def test_validate_classifies_missing_and_mesh(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(V, "RUNS_DIR", tmp_path)
    run = tmp_path / "r"
    (run / "101").mkdir(parents=True)  # no output.* -> missing
    mesh_dir = run / "102"
    mesh_dir.mkdir(parents=True)
    (mesh_dir / "output.stl").write_bytes(b"solid x\nendsolid x\n")  # mesh -> not BREP-gated
    report = V.validate_run("r")
    by_id = {r["id"]: r for r in report["rows"]}
    assert by_id["101"]["status"] == "missing" and by_id["101"]["valid"] is False
    assert by_id["102"]["status"] == "mesh" and by_id["102"]["valid"] is None
    assert report["counts"].get("missing") == 1 and report["counts"].get("mesh") == 1


def test_score_falls_back_without_gt(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(V, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(S, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(S, "resolve_gt_root", lambda: None)  # force GT-less branch
    _stage_run(tmp_path)
    report = S.score_run("r")
    assert report["scored"] is False
    assert "ground truth not available" in report["reason"]
    assert report["counts"].get("valid") == 1


def test_package_builds_submission_zip(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(P, "RUNS_DIR", tmp_path)
    _stage_run(tmp_path)
    out = tmp_path / "sub.zip"
    args = argparse.Namespace(
        run_name="r", output=out, submitter="tester",
        submission_name="harness test", agent_url=None, notes=None, agree=True,
    )
    rc = P._run(args)
    assert rc == 0
    assert out.exists()
    with zipfile.ZipFile(out) as z:
        names = z.namelist()
        assert "meta.json" in names
        assert any(n.endswith("224/output.step") for n in names)
