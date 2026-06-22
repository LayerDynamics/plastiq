# cadbench-harness

cad-studio's integration harness for **CADGenBench** — it drives our parametric
generation model over the benchmark's fixtures and scores the result with the
upstream CAD Score pipeline.

This directory is **our committed code**. The scorer it calls lives in the
sibling `benchmark/cadgenbench/` checkout, which is a **vendored clone of
`github.com/huggingface/cadgenbench`**, is **gitignored**, and is treated as a
black box — never edit it.

Plan + milestones: [`docs/plans/2026-06-22-cadgenbench-integration.md`](../../docs/plans/2026-06-22-cadgenbench-integration.md).

## Setup (once)

```bash
# Python 3.12 env with the scorer + baseline + dev extras
mamba create -y -n cadgenbench python=3.12
mamba run -n cadgenbench pip install -e "benchmark/cadgenbench[baseline,dev]"
# this harness
mamba run -n cadgenbench pip install -e benchmark/harness
```

Verify the scorer runs on this machine (the eval suite must be green; 5 failures
in `tests/common` for *corrupted/empty* STEP files are a known build123d-0.11
version sensitivity in upstream negative tests and do not affect scoring):

```bash
mamba run -n cadgenbench python -m pytest benchmark/cadgenbench/tests/eval -q
```

## Input data

The 81 benchmark input fixtures (49 generation `101–150`, 32 editing `201–250`)
are served from the private HF bucket `LayerDynamics/cadgenbench-data-bucket`,
mounted locally:

```bash
hf-mount start bucket LayerDynamics/cadgenbench-data-bucket ./local   # mount at <repo>/local
hf-mount status                                                        # list mounts
hf-mount stop "$(pwd)/local"                                           # unmount
```

The bucket holds **inputs only** — the ground truth is private and not in it, so
local CAD Scores for our own generations are not possible; see the plan's CB4
for the Space-submission path and the ground-truth access request.

## Subject under test

The benchmark scores *description → 3D STEP*, so the subject is Plastiq's
**parametric AI generation** (text/image → `CadDocument` → `exportStep`), run
headlessly by `plastiq-gen` (`apps/plastiq/src/headless/`). `services/reconstruct`
(mesh → B-rep) is a different input modality and is **not** a benchmark subject.

## End-to-end workflow

```bash
# 0. mount the inputs (once) — see above

# 1. serve a local model (zero cost, Apple-Silicon native). The agent drives the
#    model via OpenAI tool calls, so the server MUST support function-calling.
#    VERIFIED: mlx_lm.server passes tools but ignores tool_choice; mlx_vlm.server
#    has NO tools support (can't drive the agent). For reliable tool-calling — and
#    for generation, which needs VISION (the drawing) — use llama.cpp with a
#    tool-capable + vision (--mmproj) GGUF, or a cloud provider. mlx-lm is fine for
#    the editing path / experimentation.
./benchmark/harness/serve-model.sh llama <tool+vision-gguf-repo> 8080   # tool-calling + vision
#   experiment-only: serve-model.sh mlx-lm mlx-community/Qwen2.5-7B-Instruct-4bit

# 2. generate candidates over the fixtures -> runs/<name>/<id>/output.step
mamba run -n cadgenbench python -m cadbench_harness run myrun \
    --model <model> --base-url http://localhost:8080/v1 \
    --vision --first-tool build_part --workers 2
#   smoke first: add --limit 2  (or --only 101 102)
#   --first-tool build_part forces the tool on turn 1 (needs a tool_choice-honoring
#   server like llama.cpp; no-op on mlx_lm.server)

# 3. validate (the hard cad_score=0 gate) before submitting
mamba run -n cadgenbench python -m cadbench_harness validate myrun

# 4. score: full CAD Score if GT is reachable, else validity + submit guidance
mamba run -n cadgenbench python -m cadbench_harness score myrun

# 5. package a leaderboard submission zip (delegates to cadgenbench baseline package)
mamba run -n cadgenbench python -m cadbench_harness package myrun \
    --submitter "You" --name "plastiq parametric v1" --agree -o myrun.zip
```

Upload `myrun.zip` on the Space's **Submit** tab; see [`SUBMIT.md`](SUBMIT.md) for
that and for requesting private ground-truth access (which flips `score` to local
CAD Scores with no code change).

### Standalone checks

```bash
# prove the scorer runs + discriminates on the bundled GT fixtures
mamba run -n cadgenbench python -m cadbench_harness score-fixtures
# run the validity gate on any single candidate STEP
mamba run -n cadgenbench python -m cadbench_harness sanity path/to/output.step
```

## Honest caveats (verified)

- **Generation works with llama.cpp — VERIFIED end-to-end.** Use `llama-server`
  (honors request `tools`/`tool_choice` via `--jinja`) with a tool-capable GGUF
  (e.g. `bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M`). The headless path sends a
  **grammar-safe** (dereferenced) `build_part` schema — llama.cpp 400s on the zod
  `$ref`/`$defs` otherwise. A text-specified part then produced a valid box that
  scored **CAD Score 1.0** vs a self-authored GT. **Still gated:** the 81 *benchmark*
  generation fixtures are `text+image`, so they need a **vision** GGUF (`--mmproj`,
  e.g. Qwen2.5-VL) — same pipeline, heavier model. **MLX servers can't do this:**
  `mlx_lm.server` ignores `tool_choice` and `mlx_vlm.server` has no tools support.
- **Editing prompt blow-up — FIXED.** `editContext` digests an imported `input.step`
  instead of embedding it (was ~644K tokens); the dropped STEP is restored by id when
  the model re-emits the doc (`tools/toolDefs.ts` `reconcileImportSteps`). The editing
  path runs in seconds and yields a valid candidate (proven on fixture 224). Editing
  *fidelity* is still bounded: the imported STEP is one opaque body the agent adds to.
- **Local CAD Score works with your own GT.** Against the private official GT it's
  unreachable (validity-only + Space). But point `CADGENBENCH_DATA_DIR` at a
  self-owned `inputs/`+`gt/` tree and `score` produces real CAD Scores (verified:
  1.0 for a correct candidate). See `SUBMIT.md`.

## Tests

```bash
mamba run -n cadgenbench python -m pytest benchmark/harness/tests -q            # fast
mamba run -n cadgenbench python -m pytest benchmark/harness/tests -q -m slow    # all fixtures
# the headless generation core is covered by the app's Vitest suite:
pnpm exec vitest run apps/plastiq/src/headless/
```

Not wired into push-CI: the harness needs the mounted bucket, the `cadgenbench`
env, and a local model — all local/manual. The app's headless **unit** test
(`generate.test.ts`, no network) does run in CI.
