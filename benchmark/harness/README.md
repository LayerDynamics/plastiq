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

# 1. serve local models with llama.cpp (zero cost, Apple-Silicon, torch-free, honors
#    OpenAI tools via --jinja). Vision + tool-calling don't coexist in one local model,
#    so use a TWO-STAGE setup (a VLM captions the drawing -> a tool model generates):
#    - tool/generator (:8080):
llama-server -hf bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M --port 8080 --jinja -c 8192 &
#    - vision captioner (:8081, --mmproj pulled automatically for ggml-org VL repos):
llama-server -hf ggml-org/Qwen2.5-VL-3B-Instruct-GGUF --port 8081 &
#    (mlx_lm.server ignores tool_choice; mlx_vlm.server has NO tools — don't use them
#     to drive the agent. Editing tasks are text+step and need only the generator.)

# 2. generate candidates over the fixtures -> runs/<name>/<id>/output.step
#    The captioner turns each drawing into text, then the generator builds from it.
mamba run -n cadgenbench python -m cadbench_harness run myrun \
    --model bartowski/Qwen2.5-7B-Instruct-GGUF:Q4_K_M --base-url http://localhost:8080/v1 \
    --caption-base-url http://localhost:8081/v1 --caption-model ggml-org/Qwen2.5-VL-3B-Instruct-GGUF \
    --workers 2
#   smoke first: add --limit 2  (or --only 101 102)
#   editing-only (no drawings): drop the --caption-* flags.

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
  (honors request tools via `--jinja`) with a tool-capable GGUF (e.g.
  `Qwen2.5-7B-Instruct`). The headless path sends a **grammar-safe** (dereferenced)
  `build_part` schema — llama.cpp 400s on the zod `$ref`/`$defs` otherwise. A
  text-specified part produced a valid box scoring **CAD Score 1.0** vs a
  self-authored GT.
- **Vision (the benchmark drawings) — solved via a two-stage pipeline.** Vision +
  tool-calling don't coexist in one local model (Qwen2.5-VL's template has no tools;
  `mlx_vlm.server` has no tools API), so a **VLM captions the drawing to text** and
  the **tool model generates from that text** (`--caption-base-url`/`--caption-model`,
  served separately with `--mmproj`). Verified on a real fixture: the captioner
  describes the part and the generator emits a multi-feature `build_part`. Candidate
  *quality* on complex parts is model-bound (a 7B sometimes misorders sketch/cut) —
  swap in larger GGUFs to improve it.
- **Editing prompt blow-up — FIXED.** `editContext` digests an imported `input.step`
  instead of embedding it (was ~644K tokens); the dropped STEP is restored by id when
  the model re-emits the doc (`tools/toolDefs.ts` `reconcileImportSteps`). The editing
  path runs in seconds and yields a valid candidate (proven on fixture 224). Editing
  *fidelity* is still bounded: the imported STEP is one opaque body the agent adds to.
- **Local CAD Score works with your own GT.** Against the private official GT it's
  unreachable (validity-only + Space). But point `CADGENBENCH_DATA_DIR` at a
  self-owned `inputs/`+`gt/` tree and `score` produces real CAD Scores (verified:
  1.0 for a correct candidate). See `SUBMIT.md`.
- **Scoring is GPU-isolated on Apple Silicon.** Each candidate's shape phase renders
  a 120-frame turntable (a report animation; the CAD Score itself is mesh-derived) via
  VTK→Metal. The Metal command-buffer pool is **not** reclaimed within a long-lived
  process, so scoring many fixtures in one process exhausts unified GPU memory
  (`kIOGPUCommandBufferCallbackErrorOutOfMemory`). `score-fixtures` therefore scores
  **each fixture in its own subprocess** (`_score_fixture_isolated`) so the OS reclaims
  the GPU context between fixtures, and **monitors** for the Metal out-of-memory
  signatures on the child's stderr (`detect_gpu_pressure`) — a degraded render is
  surfaced loudly, never hidden. Scores are unaffected (they come from chamfer/IoU/
  topology, not pixels).

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
