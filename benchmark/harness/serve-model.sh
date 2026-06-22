#!/usr/bin/env bash
# CB3.1 — start a local OpenAI-compatible model server for the CADGenBench harness.
#
# plastiq-gen / `cadbench-harness run` talk to an OpenAI-compatible /v1 endpoint;
# this script starts one with a local, Apple-Silicon-native runtime so generation
# costs nothing. All three backends expose http://localhost:<port>/v1.
#
# Usage:
#   serve-model.sh mlx-lm  <hf-model> [port]   # text models (editing tasks, text-only gen)
#   serve-model.sh mlx-vlm <hf-model> [port]   # vision models (generation drawings, input.png)
#   serve-model.sh llama   <hf-model> [port]   # llama.cpp (gguf via -hf)
#
# Then point the harness at it:
#   mamba run -n cadgenbench python -m cadbench_harness run smoke \
#     --model <hf-model> --base-url http://localhost:<port>/v1 [--vision] --limit 2
#
# Env: MLX_ENV (conda env carrying mlx_lm / mlx_vlm; default "base").
#
# TOOL-CALLING SUPPORT (verified): the agent drives the model via OpenAI function
# calls. `mlx_lm.server` passes `tools` but IGNORES `tool_choice` (so --first-tool
# has no effect there); `mlx_vlm.server` has NO tools support at all (it cannot drive
# the agent). For reliable tool-calling — and for *generation* (vision drawings) —
# use `llama` (llama.cpp `llama-server`, honors request `tools`/`tool_choice` via
# Jinja templates; `--mmproj` adds vision) with a tool-capable model, or a cloud
# provider. mlx-lm/mlx-vlm are fine for experimentation and the editing path.
#
# Apple-Silicon (M4 Max) model picks:
#   text, mlx (no tool_choice) : mlx-community/Qwen2.5-7B-Instruct-4bit
#   vision, mlx (NO tools)     : mlx-community/Qwen3-VL-8B-Instruct-8bit  (can't tool-call)
#   tool-calling + vision      : a llama.cpp GGUF + its --mmproj projector via `llama`
set -euo pipefail

backend="${1:?backend required: mlx-lm | mlx-vlm | llama}"
model="${2:?model required (HF repo id or local path)}"
port="${3:-8080}"
mlx_env="${MLX_ENV:-base}"

case "$backend" in
  mlx-lm)
    echo "mlx_lm server  model=$model  port=$port  env=$mlx_env"
    exec mamba run -n "$mlx_env" python -m mlx_lm server --model "$model" --port "$port"
    ;;
  mlx-vlm)
    echo "mlx_vlm.server model=$model  port=$port  env=$mlx_env"
    exec mamba run -n "$mlx_env" python -m mlx_vlm.server --model "$model" --port "$port"
    ;;
  llama)
    echo "llama-server   model=$model  port=$port"
    exec llama-server -hf "$model" --port "$port"
    ;;
  *)
    echo "unknown backend: $backend (use mlx-lm | mlx-vlm | llama)" >&2
    exit 2
    ;;
esac
