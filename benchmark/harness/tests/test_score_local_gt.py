"""CB6.3 — the GT-gated local-scoring loop works end-to-end with a self-owned GT.

The official ground truth is private, but `score` is GT-source-agnostic: point
`CADGENBENCH_DATA_DIR` at a local `inputs/` + `gt/` tree (a "self-owned mini-GT")
and it runs the full `evaluate_result` per fixture, producing a real CAD Score.
This test stages such a tree from a bundled jig fixture (real GT + candidates) and
asserts the scored path returns a real, discriminating CAD Score — the day official
GT access lands, the same path scores against it with no change.

This is the only test that exercises `score.score_run`'s `scored: True` branch
(the CB4 tests force the GT-less fallback).
"""
from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from cadbench_harness import score as S
from cadbench_harness.paths import jig_fixtures


def _stage_local_gt(data_dir: Path, fixture_id: str = "501") -> None:
    """Lay out <data_dir>/gt/<id>/{ground_truth.step, jig_*.step} from a jig fixture."""
    src = jig_fixtures()[0]  # test_1: gt.step + jig_1__1__KOR.step + candidates/*
    gt = data_dir / "gt" / fixture_id
    gt.mkdir(parents=True)
    shutil.copy(src / "gt.step", gt / "ground_truth.step")
    for jig in src.glob("jig_*__*__*.step"):
        shutil.copy(jig, gt / jig.name)


def _stage_run(runs_dir: Path, run: str, fixture_id: str, candidate: str) -> None:
    """Put a candidate at runs/<run>/<id>/output.step (a bundled jig candidate)."""
    src = jig_fixtures()[0] / "candidates" / f"{candidate}.step"
    d = runs_dir / run / fixture_id
    d.mkdir(parents=True)
    shutil.copy(src, d / "output.step")


@pytest.mark.slow
def test_local_gt_produces_a_real_discriminating_cad_score(
    tmp_path: Path, monkeypatch
) -> None:
    data_dir = tmp_path / "data"
    runs_dir = tmp_path / "runs"
    fixture_id = "501"
    _stage_local_gt(data_dir, fixture_id)
    # CADGENBENCH_DATA_DIR resolves the GT root to <data_dir>/gt (cadgenbench paths).
    monkeypatch.setenv("CADGENBENCH_DATA_DIR", str(data_dir))
    monkeypatch.delenv("CADGENBENCH_DATA_GT_REPO", raising=False)
    monkeypatch.setattr(S, "RUNS_DIR", runs_dir)

    # The correct candidate scores near 1.0...
    _stage_run(runs_dir, "good", fixture_id, "correct")
    good = S.score_run("good")
    assert good["scored"] is True
    assert good["n_scored"] == 1
    good_score = good["rows"][0]["cad_score"]
    assert good_score is not None and good_score > 0.9

    # ...and a deliberately broken candidate scores strictly lower (real metric).
    _stage_run(runs_dir, "bad", fixture_id, "broken_3_no_hole")
    bad = S.score_run("bad")
    bad_score = bad["rows"][0]["cad_score"]
    assert bad_score is not None and bad_score < good_score
