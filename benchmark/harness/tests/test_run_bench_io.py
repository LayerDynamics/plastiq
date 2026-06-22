"""CB3 IO tests — run_one's subprocess seam, status classification, resume, redaction,
and select_fixtures filtering. The subprocess is faked (writing a real or no STEP);
classification uses the real validity gate, so these stay honest without a model.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from cadbench_harness import run_bench as RB
from cadbench_harness.paths import jig_fixtures
from cadbench_harness.run_bench import (
    RunConfig,
    parse_summary,
    run_one,
    select_fixtures,
)


def _fixture(root: Path, fid: str = "101", task: str = "generation") -> RB.Fixture:
    fx = root / fid
    fx.mkdir(parents=True)
    (fx / "description.yaml").write_text(
        f"description: a part\ntask_type: {task}\ninput_files: []\n"
    )
    return RB.load_fixture(fx)


class _FakeProc:
    def __init__(self, rc: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode, self.stdout, self.stderr = rc, stdout, stderr


def _out_path(cmd: list[str]) -> Path:
    return Path(cmd[cmd.index("--out") + 1])


def test_parse_summary_picks_last_json_object_line() -> None:
    out = 'Step File Name : /x.step\n{"finish": "answer", "applied": true}\n'
    assert parse_summary(out) == {"finish": "answer", "applied": True}
    assert parse_summary("no json here") == {}


def test_run_one_valid_classifies_and_captures_summary(tmp_path: Path, monkeypatch) -> None:
    fx = _fixture(tmp_path / "in")
    run_dir = tmp_path / "runs" / "r"
    valid_step = jig_fixtures()[0] / "gt.step"  # a real watertight solid

    def fake_run(cmd, cwd=None, capture_output=True, text=True):
        out = _out_path(cmd)
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(valid_step, out)
        return _FakeProc(0, stdout='{"finish":"answer","applied":true,"features":1}\n')

    monkeypatch.setattr(RB.subprocess, "run", fake_run)
    rec = run_one(fx, run_dir, RunConfig(model="m"))
    assert rec["status"] == "valid"
    assert rec["applied"] is True
    assert rec["finish"] == "answer"


def test_run_one_missing_when_no_output(tmp_path: Path, monkeypatch) -> None:
    fx = _fixture(tmp_path / "in")
    run_dir = tmp_path / "runs" / "r"

    def fake_run(cmd, cwd=None, capture_output=True, text=True):
        return _FakeProc(2, stdout="no geometry produced\n")

    monkeypatch.setattr(RB.subprocess, "run", fake_run)
    rec = run_one(fx, run_dir, RunConfig(model="m"))
    assert rec["status"] == "missing"
    assert rec["out"] is None


def test_run_one_redacts_api_key_in_log(tmp_path: Path, monkeypatch) -> None:
    fx = _fixture(tmp_path / "in")
    run_dir = tmp_path / "runs" / "r"

    def fake_run(cmd, cwd=None, capture_output=True, text=True):
        return _FakeProc(2)

    monkeypatch.setattr(RB.subprocess, "run", fake_run)
    run_one(fx, run_dir, RunConfig(model="m", api_key="super-secret-key"))
    log = (run_dir / fx.id / "plastiq-gen.log").read_text()
    assert "super-secret-key" not in log
    assert "--api-key ***" in log


def test_run_one_resume_skips_a_valid_candidate(tmp_path: Path, monkeypatch) -> None:
    fx = _fixture(tmp_path / "in")
    run_dir = tmp_path / "runs" / "r"
    out = run_dir / fx.id / "output.step"
    out.parent.mkdir(parents=True)
    shutil.copy(jig_fixtures()[0] / "gt.step", out)  # already-valid candidate

    def boom(*a, **k):
        raise AssertionError("subprocess must not run when a valid candidate exists")

    monkeypatch.setattr(RB.subprocess, "run", boom)
    rec = run_one(fx, run_dir, RunConfig(model="m"))  # force=False (default)
    assert rec["status"] == "skipped-valid"


def test_select_fixtures_honors_only_and_limit(tmp_path: Path, monkeypatch) -> None:
    root = tmp_path / "in"
    dirs = [_fixture(root, fid).dir for fid in ("101", "102", "150")]
    monkeypatch.setattr(RB, "input_fixtures", lambda: dirs)

    only = select_fixtures(RunConfig(model="m", only=("102",)))
    assert [f.id for f in only] == ["102"]

    limited = select_fixtures(RunConfig(model="m", limit=2))
    assert [f.id for f in limited] == ["101", "102"]
