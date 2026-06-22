"""CB1.2 tests — the scorer runs end-to-end and discriminates correct vs broken.

These exercise the real ``evaluate_result`` (OCCT + VTK), so they are not free;
they are the proof that the CAD Score pipeline works in our environment. The
fast single-fixture test runs by default; the all-fixtures test is marked slow.
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from cadbench_harness.paths import jig_fixtures
from cadbench_harness.score_fixtures import evaluate_all, score_fixture


def test_first_fixture_correct_outscores_broken() -> None:
    """On test_1, the correct candidate beats every broken one, and the broken
    ones are accepted geometry (valid) yet score lower — i.e. the metric, not
    the validity gate, is doing the discrimination."""
    test_dir = jig_fixtures()[0]
    with tempfile.TemporaryDirectory(prefix="cadbench_test_") as tmp:
        results = score_fixture(test_dir, Path(tmp))

    correct = results["correct"]
    assert correct["status"] == "valid"
    correct_score = correct["cad_score"]
    assert correct_score > 0.0

    broken = {k: v for k, v in results.items() if k.startswith("broken")}
    assert broken, "fixture has no broken candidates to discriminate against"
    for name, data in broken.items():
        assert data["cad_score"] < correct_score, (
            f"{name} (cad_score={data['cad_score']}) did not score below "
            f"correct (cad_score={correct_score})"
        )


@pytest.mark.slow
def test_all_fixtures_discriminate() -> None:
    rows, discriminates = evaluate_all()
    assert rows
    offenders = [r for r in rows if r["broken_outranks_correct"]]
    assert discriminates, f"a broken candidate tied/beat correct: {offenders}"
