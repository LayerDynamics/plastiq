"""CB3.2 tests — fixture parsing + command construction (pure, no subprocess).

These run against the real mounted input fixtures when present, and against a
synthetic fixture dir otherwise, so they verify the harness logic without a model
or network.
"""
from __future__ import annotations

from pathlib import Path

from cadbench_harness.run_bench import (
    RunConfig,
    build_command,
    load_fixture,
)


def _write_generation_fixture(d: Path) -> Path:
    fx = d / "101"
    fx.mkdir(parents=True)
    (fx / "description.yaml").write_text(
        "description: Reproduce the geometry from the drawing.\n"
        "input_files:\n  - input.png\ninput_type: text+image\n"
    )
    (fx / "input.png").write_bytes(b"\x89PNG\r\n\x1a\n")  # header bytes; not parsed here
    return fx


def _write_editing_fixture(d: Path) -> Path:
    fx = d / "224"
    fx.mkdir(parents=True)
    (fx / "description.yaml").write_text(
        "description: Remove the groove.\n"
        "task_type: editing\ninput_files:\n  - input.step\ninput_type: text+step\n"
    )
    (fx / "input.step").write_text("ISO-10303-21;\n")
    (fx / "edit_description.txt").write_text("Remove the internal groove.\n")
    return fx


def test_load_generation_fixture_defaults_task_type(tmp_path: Path) -> None:
    fx = load_fixture(_write_generation_fixture(tmp_path))
    assert fx.id == "101"
    assert fx.task_type == "generation"  # absent in YAML -> defaults to generation
    assert fx.is_editing is False
    assert fx.input_type == "text+image"
    assert [p.name for p in fx.images] == ["input.png"]
    assert fx.input_step is None
    assert fx.edit_text is None


def test_load_editing_fixture(tmp_path: Path) -> None:
    fx = load_fixture(_write_editing_fixture(tmp_path))
    assert fx.task_type == "editing"
    assert fx.is_editing is True
    assert fx.input_step is not None and fx.input_step.name == "input.step"
    assert fx.edit_text == "Remove the internal groove."
    assert fx.images == ()


def test_build_command_generation_with_vision(tmp_path: Path) -> None:
    fx = load_fixture(_write_generation_fixture(tmp_path))
    cfg = RunConfig(model="m", base_url="http://x/v1", vision=True, max_steps=8)
    cmd = build_command(fx, tmp_path / "out.step", cfg)
    assert "--model" in cmd and "m" in cmd
    assert "--vision" in cmd
    assert "--image" in cmd
    assert "--desc" in cmd
    assert "--max-steps" in cmd and "8" in cmd
    # generation must not carry editing flags
    assert "--input-step" not in cmd and "--edit" not in cmd


def test_build_command_two_stage_caption(tmp_path: Path) -> None:
    fx = load_fixture(_write_generation_fixture(tmp_path))
    cfg = RunConfig(
        model="gen", caption_base_url="http://localhost:8081/v1", caption_model="vlm",
    )
    cmd = build_command(fx, tmp_path / "out.step", cfg)
    # images are passed (the captioner handles them) even though the tool model
    # isn't --vision; the caption endpoint + model are forwarded.
    assert "--image" in cmd
    assert "--vision" not in cmd
    assert "--caption-base-url" in cmd and "http://localhost:8081/v1" in cmd
    assert "--caption-model" in cmd and "vlm" in cmd


def test_build_command_generation_no_vision_drops_images(tmp_path: Path) -> None:
    fx = load_fixture(_write_generation_fixture(tmp_path))
    cmd = build_command(fx, tmp_path / "out.step", RunConfig(model="m", vision=False))
    assert "--vision" not in cmd
    assert "--image" not in cmd


def test_build_command_editing(tmp_path: Path) -> None:
    fx = load_fixture(_write_editing_fixture(tmp_path))
    cmd = build_command(fx, tmp_path / "out.step", RunConfig(model="m"))
    assert "--input-step" in cmd
    assert "--edit" in cmd
    i = cmd.index("--edit")
    assert cmd[i + 1] == "Remove the internal groove."
    assert "--vision" not in cmd
