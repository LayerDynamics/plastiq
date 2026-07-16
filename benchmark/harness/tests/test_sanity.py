"""CB1.3 tests — the validity gate accepts good geometry and rejects junk."""
from __future__ import annotations

from pathlib import Path

import pytest

from cadbench_harness.paths import jig_fixtures
from cadbench_harness.sanity import check_step


def test_ground_truth_passes_gate() -> None:
    """Every bundled fixture's ground truth is a valid, watertight solid."""
    fixtures = jig_fixtures()
    assert fixtures, "no jig_metric fixtures found"
    for test_dir in fixtures:
        report = check_step(test_dir / "gt.step")
        assert report.is_valid, f"{test_dir.name}/gt.step failed the gate"
        assert report.is_watertight
        assert report.solid_count >= 1
        assert report.volume > 0.0


def test_correct_candidate_passes_gate() -> None:
    report = check_step(jig_fixtures()[0] / "candidates" / "correct.step")
    assert report.is_valid


def test_missing_file_raises() -> None:
    with pytest.raises(FileNotFoundError):
        check_step(Path("/nonexistent/output.step"))


def test_corrupt_step_is_invalid_not_crash(tmp_path: Path) -> None:
    """A non-STEP file is reported invalid (score-zero), never an exception."""
    junk = tmp_path / "output.step"
    junk.write_text("this is not a STEP file\n")
    report = check_step(junk)
    assert report.is_valid is False
    assert report.errors  # a reason was captured
