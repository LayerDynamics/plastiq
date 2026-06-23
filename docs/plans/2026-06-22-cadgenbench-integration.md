# Plan — Integrate **CADGenBench** as an evaluation harness for our CAD-generation models

**Date:** 2026-06-22
**Subject under test:** Plastiq's **parametric AI generation** path (text/image → `CadDocument`
→ OCCT build → `exportStep`). This is the only one of our models whose I/O matches the benchmark's
*description → 3D STEP* contract. (`services/reconstruct` is mesh→B-rep — wrong input modality —
so it is **not** a benchmark subject.)
**Benchmark:** `benchmark/cadgenbench/` — a **vendored clone** of `github.com/huggingface/cadgenbench`,
**gitignored** (`.gitignore:25`) and a separate upstream git repo. Treat it as a **black-box scoring
tool**; never edit it. All integration code lives in **our** committed tree.
**Data source (this session):** the user's private HF **bucket** `LayerDynamics/cadgenbench-data-bucket`
is **mounted** at `./local` via `hf-mount` (NFS daemon, pid recorded by `hf-mount status`). It mirrors
the **public inputs** — **81 fixtures** (49 generation `101–150`, 32 editing `201–250`). It holds
**inputs only**; there is **no ground truth** in it.
**Scoring reality (verified):** the official ground truth (`HuggingAI4Engineering/cadgenbench-data-gt`)
is **private and unreachable** for this account (`LayerDynamics`, orgs: `mlx-community` only — not in
`HuggingAI4Engineering`). So a real **CAD Score can only come from the leaderboard Space**. Locally we
can: prove the scorer on bundled GT fixtures, generate candidates, run the **validity gate** (no GT),
package a `submission.zip`, and submit. The harness is **GT-aware**: if access is later granted it scores
locally with zero code change (env-var driven).
**Provider for runs:** a **local OpenAI-compatible server** (`mlx_lm.server` / `mlx-vlm` for vision /
`llama-server`) driven through our existing `openaiCompatible.ts` adapter — **zero API cost**,
Apple-Silicon-native (M4 Max).
**Execution:** inline sequential. **Commit:** one per milestone at green — **ask before committing**.
**Hard gates:** pause before any **git commit** and before any **outward-facing Space upload**.

## Goal

A repeatable, committed harness that drives **our** parametric generation model over the 81 CADGenBench
fixtures and scores the result — locally where geometry allows (validity gate + the bundled GT fixtures),
and via the leaderboard Space for the headline CAD Score. The byproduct is a real **app capability**:
a **headless text/image→STEP generation core** extracted from Plastiq, so the agent that today only runs
in the browser can run in Node/CI.

## Grounding (verified this session, with file:line)

- **Scoring seam:** `benchmark/cadgenbench/src/cadgenbench/eval/evaluate.py:140` `evaluate_result(result_dir, gt_dir)`
  → writes `result.json` with `cad_score`; `:434` `evaluate_candidate_only(candidate_step, result_dir)` →
  validity + renders, **no GT needed**. CLI: `benchmark/cadgenbench/src/cadgenbench/cli.py:39` (`cadgenbench evaluate|baseline|report`).
- **Validity gate:** `benchmark/cadgenbench/src/cadgenbench/common/validity.py` `analyze_step` (used by the
  shipped `./local/sanity_check_submission.py`). Same gate that decides `cad_score = 0`.
- **Submission contract:** `benchmark/cadgenbench/docs/benchmark/submission.md` — one `output.step`
  (or mesh `output.{stl,obj,off,3mf,ply}`) per `results/<run>/<id>/`; root `meta.json`.
- **Fixture/data resolution:** `benchmark/cadgenbench/src/cadgenbench/common/paths.py` — `CADGENBENCH_DATA_REPO`
  / `CADGENBENCH_DATA_GT_REPO` (HF snapshot) → `CADGENBENCH_DATA_DIR` (local `inputs/`+`gt/`) → `./data/`.
- **Bundled GT fixtures (local, no HF):** `benchmark/cadgenbench/tests/fixtures/jig_metric/test_{1..4}/`
  each has `gt.step` + `candidates/{correct,broken_*}.step` → a self-contained way to prove the scorer ranks
  correct > broken.
- **Our generation core (already injection-shaped):** `apps/plastiq/src/ai/runGeneration.ts:41`
  `runGeneration({provider, input, tools, currentDoc, ...})` → `apps/plastiq/src/ai/agentRunner.ts:50`
  `runAgent` (pure loop; source comment: *"extracting it keeps the cockpit logic CI-testable with a fake
  provider (no model, no browser)"*). Tools: `apps/plastiq/src/ai/tools/buildPart.ts:52` `buildPart(input, deps)`.
- **Browser coupling = the tool `deps` only:** apply via store `apps/plastiq/src/store/store.ts:688`
  `loadDocument`, build via global `__plastiqBuild`, export via `__plastiqExport`
  (`apps/plastiq/src/three/Viewport.tsx`). The kernel is Node-clean: `packages/cad/src/io/index.ts:20`
  `exportStep`, `:41` `importStep`; `rebuildDocument`/`initOcct`/`makeBox` are imported from `@plastiq/cad`
  by `apps/plastiq/src/worker/rebuild.test.ts` (runs in Node today).
- **Providers:** `apps/plastiq/src/ai/providers/openaiCompatible.ts` (configurable `baseURL` → local
  mlx-lm/llama.cpp), `apps/plastiq/src/ai/providers/anthropic.ts`. Interface
  `apps/plastiq/src/ai/providers/types.ts:68` `ChatProvider`.
- **Env:** Python `3.12.13` (`/opt/homebrew/bin/python3.12`) + `mamba` available; cadgenbench needs `>=3.12`
  (`benchmark/cadgenbench/pyproject.toml:11`). Our services pin `3.11`, so cadgenbench gets its **own**
  env — no conflict.

## Honest scope / caveats (no stubs, stated up front)

- **Generation fixtures are `text+image`** (`./local/101/description.yaml` → `input_files: [input.png]`,
  `input_type: text+image`; the drawing carries the spec). Faithful generation therefore needs a
  **vision-capable** local model (`mlx-vlm`, e.g. Qwen2.5-VL) — a text-only `mlx_lm`/`llama.cpp` model will
  see no drawing and score poorly. The harness supports both; quality is gated on the served model.
- **Editing fidelity is bounded by the kernel.** Our parametric path imports `input.step` as one opaque
  `importStep` feature (`apps/plastiq/src/ai/tools/schema.ts` / `reconstruct.ts:112`); the agent can add
  features on top but cannot rewrite the imported solid's internals. Editing tasks that require modifying
  interior geometry are answerable only approximately. Stated, not hidden.
- **No local CAD Score for our candidates** until GT access is granted — by construction (private GT). The
  harness gives validity locally and the real score via the Space. CB4 documents the access request.

---

# Milestones

## CB0 — Data source + scoring env (free · local · no LLM · no app change · no commit)
- [x] **CB0.1 — Bucket mounted + ignored.** `LayerDynamics/cadgenbench-data-bucket` mounted at `./local`
      via `hf-mount start bucket … ./local` (NFS daemon). `local/` added to `.gitignore`. It is the
      **inputs mirror** (81 fixtures, no GT). Unmount: `hf-mount stop $(pwd)/local`.
- [x] **CB0.2 — cadgenbench env.** py3.12 mamba env `cadgenbench`; `pip install -e
      benchmark/cadgenbench[baseline,dev]` (build123d 0.11, cadquery-ocp 7.9.3, open3d 0.19, pyvista/vtk
      9.6, litellm 1.89). `cadgenbench --help` works; all heavy imports OK.
- [x] **CB0.3 — Prove the upstream tool runs here.** `pytest benchmark/cadgenbench/tests/eval -q` →
      **146 passed** (full scorer green on the M4 Max). Known: 5 `tests/common` failures for
      *corrupted/empty* STEP files — build123d-0.11 raises a different error type than the upstream negative
      tests expect; irrelevant to scoring valid candidates (our `sanity.py` handles that case gracefully).

## CB1 — Prove the scorer end-to-end in OUR harness (free · no LLM) — DONE
- [x] **CB1.1 — Committed harness tree.** `benchmark/harness/` — `cadbench_harness/` package (`paths`,
      `sanity`, `score_fixtures`, `cli`, `__main__`), `pyproject.toml` (console entry `cadbench-harness`),
      `.gitignore` (`runs/`, `results/`, `*.zip`), `README.md`, `tests/`.
- [x] **CB1.2 — `score_fixtures` proof.** `evaluate_result` over all four `jig_metric/test_*` fixtures →
      every `correct` = **1.000**, every `broken_*` strictly lower (interface axis discriminates).
      **DISCRIMINATES ✓.** Robust against upstream-test `*_aligned.step` pollution. Each fixture is
      scored in its own subprocess (`_score_fixture_isolated`) so the VTK→Metal turntable renders don't
      exhaust unified GPU memory across fixtures on Apple Silicon; the child's stderr is monitored for
      the Metal OOM signatures (`detect_gpu_pressure`). Full suite green: **24 passed** (incl. both slow).
- [x] **CB1.3 — `sanity` gate.** `cadbench_harness sanity <step>` over `analyze_step`; reports
      valid/watertight/solids/volume/bbox; catches loader failures as invalid (never crashes). Tests green
      (`pytest benchmark/harness/tests -m "not slow"` → 5 passed).

## CB2 — Make Plastiq benchmarkable: headless text/image→STEP core (app change · TS) — DONE
- [x] **CB2.1 — Node geometry seam.** `apps/plastiq/src/headless/nodeBuild.ts` — `createHeadlessSession()`
      wires `buildAgentTools` with Node deps: probe/inspect via `rebuildTagged` (`@plastiq/cad` + real OCCT),
      `apply` captures the doc, `toStep()` = `rebuildDocument` → `exportStep`. The Node twin of
      `ai/agentTurn.ts`'s `buildTurnTools` — same probe/apply contract, no worker/store/globals.
      `seedFromStep()` makes the editing seed (`importStep`).
- [x] **CB2.2 — `plastiq-gen` CLI.** `apps/plastiq/src/headless/{generate,cli}.ts` — `generatePart()` runs
      the **real** `runGeneration`→`runAgent` loop with a Node session; the CLI takes `--model`,
      `--desc/--desc-file`, `--image` (vision), `--input-step` + `--edit/--edit-file` (editing),
      `--base-url`/`--api-key`/`--vision`, `-o output.step`. Runs in Node via `tsx`
      (`apps/plastiq` script `gen`). Python harness parses `description.yaml` and invokes it per sample.
      Generation feeds `input.png` as a vision part; editing seeds `importStep(input.step)`.
- [x] **CB2.3 — CI-safe test (scripted provider).** `apps/plastiq/src/headless/generate.test.ts` — a
      no-network `ChatProvider` drives `build_part`→`answer_user`; asserts a valid, **re-importable** STEP
      (box volume 6e-6 m³), the `hasGeometry:false`/`missing` path, and the `seedFromStep` round-trip.
      **3 passed**; typecheck clean; `cli.ts` excluded from coverage (entry IO).

## CB3 — Local model serving + candidate generation over the 81 fixtures (free · local LLM) — DONE
- [x] **CB3.1 — `serve-model` helper.** `benchmark/harness/serve-model.sh {mlx-lm|mlx-vlm|llama} <model>
      [port]` — local OpenAI-compatible `/v1` (zero cost, M4-Max-native). Verified: `mlx_lm server` came up
      and served `/v1/models` + chat requests. Installed locally: `mlx_lm` 0.31/0.28, `mlx_vlm` 0.3.9,
      `llama-server`.
- [x] **CB3.2 — `run_bench` harness.** `cadbench-harness run <name>` iterates `./local/<id>/`, parses
      `description.yaml`, dispatches `plastiq-gen` per fixture → `runs/<name>/<id>/output.step` + per-fixture
      `plastiq-gen.log` + `manifest.json`. Parallel (`--workers`), resume-safe (skips valid candidates),
      `--limit`/`--only`. Pure parse/command-build unit-tested (5 tests).
- [x] **CB3.3 — Live smoke.** Ran `plastiq-gen` and `cadbench-harness run` against a live local
      `mlx_lm.server` (cached `Qwen2.5-0.5B-Instruct-4bit`): the full chain (server → CLI → agent → tool loop
      → honest `missing`) runs end-to-end and writes a manifest. **Found + fixed a real bug:** under tsx's
      pure ESM the OCCT/planegcs glue needs CJS `__dirname`/`require` — added an idempotent shim in
      `nodeBuild.ts` (Vitest injects them, which masked it). **Honest findings:** small local models
      (0.5–16B) call `answer_user` instead of `build_part`, so they produce no geometry — a *model* limit,
      not a harness defect (a capable/vision model is the user's to supply); and an editing fixture's
      `input.step` rides into the edit context, ballooning the prompt to ~644K tokens — impractical for a
      local model (beyond the noted editing-fidelity caveat). The full 81-fixture run is left for the user to
      launch with their chosen model.

## CB4 — Validate + package + submit + GT access (Space scoring) — DONE
- [x] **CB4.1 — `validate`.** `cadbench-harness validate <run>` runs the validity gate (`check_step`) over a
      run → per-fixture `valid`/`invalid`/`missing` + volume/bbox/faces, `validation.json` + table. Verified
      on the live `smoke` run (2 missing) and on a staged real-solid candidate (valid).
- [x] **CB4.2 — `package`.** `cadbench-harness package <run> --submitter --name --agree -o <zip>` delegates
      to `cadgenbench baseline package` (our run layout matches its `<fixture>/output.*` contract), so the zip
      + `meta.json` match the Space validator exactly. Test builds a real zip with `meta.json` + `224/output.step`.
- [x] **CB4.3 — `SUBMIT.md`.** `benchmark/harness/SUBMIT.md` — generate→validate→package→upload steps; **how to
      request the private GT** (discussion / org request at `HuggingAI4Engineering`, cite intended use) and the
      `CADGENBENCH_DATA_GT_REPO` + `HF_TOKEN` (or `CADGENBENCH_DATA_DIR`) wiring for local scoring once granted.
- [x] **CB4.4 — `score` (GT-gated).** `cadbench-harness score <run>` runs full `evaluate_result` per fixture
      when `data_gt_dir()` resolves, else the validity-only fallback with submit guidance. Verified: GT-less
      fallback on `smoke`; same code path scores locally the day GT access lands. (3 CB4 tests green.)

## CB5 — Docs · task runner · CI posture · memory — DONE
- [x] **CB5.1 — Docs.** `benchmark/harness/README.md` rewritten as the full guide (setup → mount → serve →
      run → validate → score → package → submit + honest caveats + CI posture); root `README.md` gained a
      **Benchmarking (CADGenBench)** section pointing at the harness + this plan. **Expanse.md intentionally
      not touched** — it documents the 21 external *integration* repos; CADGenBench is an external *evaluation*
      benchmark, a distinct concern, so a row there would misrepresent it.
- [x] **CB5.2 — `just bench-*`.** justfile recipes `bench-mount`, `bench-fixtures`, `bench-serve`,
      `bench-run`, `bench-test` — explicitly local/manual, headered as **NOT push-CI**.
- [x] **CB5.3 — Memory.** `cadgenbench-integration` project memory written (+ MEMORY.md pointer): subject =
      parametric gen, local mlx serving, bucket = inputs mirror at `./local`, GT private/Space-only,
      harness GT-aware. Links [[ai-generation-spec]], [[mlx-m4max-ml-milestones]].

## CI posture (explicit)
The harness is **local/manual** and is **not** added to `.github/workflows/ci.yml` (it needs the mounted
bucket, the `cadgenbench` py3.12 env, and a local model). The app's headless **unit** test
(`apps/plastiq/src/headless/generate.test.ts`, no network) DOES run in the existing Vitest CI.

---

# CB6 — Hardening: make the three caveats correct & practical

The CB0–CB5 harness is proven at the *plumbing* level (scorer, headless core, validate/package/score) but on
**stand-in geometry** — no real-model generation has scored yet. Three concrete defects/gaps stand between
"plumbing proven" and "we actually evaluate our model". Each is evidence-grounded below with the fix.

## CB6.1 — Editing path: stop dumping raw STEP into the prompt (the ~644K-token bug) — DONE
**Fixed + verified (incl. the round-trip the first cut missed).** `editContext.ts` digests each
`importStep` feature (drops `data.step`, keeps `{bytes, faces, solids}` + note; 16K ceiling); non-import
docs round-trip unchanged. **Round-trip fix (from local-code-review):** dropping `step` made a re-emitted
edit doc fail the `data.step` schema gate (`schema.ts:118`) → it would loop to the cap. `tools/toolDefs.ts`
`reconcileImportSteps` now restores each imported body's STEP bytes by feature id in the `build_part`
handler before validation, so an edit of an imported solid validates and builds. Regression tests prove the
digested doc fails the schema but round-trips after reconcile. End-to-end: editing fixture 224 finishes in
**seconds** (server processed ~6 prompt chunks, not 268K/644K) and exports a **valid** solid (watertight,
127 faces, 75590 mm³). 8 editContext+reconcile tests green; typecheck + lint clean. (A no-op edit still
re-exports the input solid — a valid, benchmark-honest low-scoring candidate: CADGenBench renormalizes the
edit shape axis against the no-op baseline, so it is not score-inflating.)
<details><summary>original analysis</summary>
**Root cause (confirmed):** `apps/plastiq/src/ai/editContext.ts:17,23` does
`JSON.stringify(toAuthoringDoc(currentDoc))` into the system prompt. For an imported STEP the doc is one
`importStep` feature whose `data.step` is the **entire STEP file text** (`tools/schema.ts:118`,
passed through verbatim by `convData` `tools/schema.ts:213-214`). So editing a seeded part embeds the whole
file → ~644K tokens for fixture 224. This hurts the **browser app too** (editing any imported STEP bloats
Claude's context), not just the headless harness.
- **Fix.** Never put raw STEP text in model context. Add a summarizer that, for each `importStep` feature,
  replaces `data.step` with a measured **digest** — `{ solids, faces, bbox_mm, volume_mm3 }` (read off the
  kernel body we already build) plus a one-line "imported solid; edit by adding features on top". Wire it
  into `editContext()` (browser) and the headless seed path (`headless/generate.ts` / `nodeBuild.seedFromStep`).
  Add a hard edit-context size ceiling with an explicit truncation note as a backstop.
- **Verify.** Re-run fixture 224 headless → system prompt is a few KB, model responds in seconds; the
  exported `output.step` (edited or no-op) passes the validity gate. Unit test asserts `editContext` of an
  importStep doc contains no `ISO-10303` payload and is < a few KB.
- **Effort:** ~2–3 h. **This is a real correctness fix, not just a harness convenience.**
</details>

## CB6.2 — Generation: get a real model to call `build_part` (not `answer_user`)
**Status: ACHIEVED — a real local model produced a valid generation candidate that scored CAD Score 1.0.**
- **CB6.2.2 (DONE).** Optional `tool_choice` end-to-end: `ToolChoice` type (`providers/types.ts`), mapped in
  the adapter (`openaiCompatible.ts` `toOpenAIToolChoice`), threaded as `firstTool` through `agentRunner`
  (turn-1 only) → `runGeneration` → `generate` → `plastiq-gen --first-tool` and `cadbench-harness run
  --first-tool`. Unit-tested (mapping + turn-1-only forcing).
- **CB6.2.1 (DONE — real candidate produced via llama.cpp).** Investigation first found the MLX servers can't
  drive tool-calling (`mlx_lm.server` ignores `tool_choice`; `mlx_vlm.server` has **no** tools support), so
  switched to **llama.cpp `llama-server`** (Qwen2.5-7B-Instruct GGUF; `--jinja` honors request tools). Two
  more real blockers found + fixed: (1) llama.cpp **400s on the zod `$ref`/`$defs`** in our `build_part`
  schema when building its grammar — fixed with `grammarSafeToolDefs`/`dereferenceSchema` in `nodeBuild.ts`,
  which **inlines** the refs (gathering nested `$defs`) so the schema is grammar-safe *and* keeps the
  concrete field shapes; (2) collapsing to a bare object lost field guidance → the model emitted
  `length/width/height` not `dx/dy/dz` — the inline fix restores it. **Result:** Qwen2.5-7B then produced a
  valid, watertight box solid (`applied:true`), which scored **CAD Score 1.0** vs a self-authored GT (see
  CB6.3). 3 grammar-safe + applied-flag tests green. **Still open:** the 81 *benchmark* generation fixtures
  are `text+image`; a vision run needs a vision GGUF (`--mmproj`, e.g. Qwen2.5-VL) — the same pipeline, a
  heavier model the user supplies. `serve-model.sh`/README updated.
- **CB6.2.3 (DONE — two-stage vision pipeline).** Researched: vision + tool-calling don't coexist in one
  local model (Qwen2.5-VL's chat template has no tool tokens; `mlx_vlm.server` has no tools API; llama.cpp
  `--mmproj`+`--jinja` is undocumented). Solution = **decouple perception from authoring**: a VLM captions
  the drawing → text, then the proven tool model generates from that text. Implemented `captionImages` +
  `resolveInput` in `generate.ts` and `--caption-base-url`/`--caption-model` in `cli.ts` + `cadbench-harness
  run`; mlx_vlm needs torchvision (avoided), so the captioner is also **llama.cpp** (`Qwen2.5-VL-3B` GGUF +
  auto `--mmproj`). **Verified on real fixture 101:** the captioner described the part and Qwen2.5-7B emitted
  a multi-feature `build_part` (box + fillet via `convexEdges` + holes) — it failed only on a schema-usage
  slip (`cut` without an upstream `sketch`), a model/prompt matter, not a pipeline one. 7 headless + 21
  harness tests green. The architecture is proven; candidate quality on complex parts scales with model size.

**Root cause:** the prompt already forbids prose-only answers (`ai/prompt.ts:12-13,48`) and the adapter sends
tools (`ai/providers/openaiCompatible.ts:188-197`) — but it sends **no `tool_choice`**, so weak models default
to `answer_user`, and generation fixtures are `text+image` (the drawing carries the spec), so a text-only
model is blind. Ordered fixes:
1. **Serve a vision model** — `Qwen3-VL-8B-Instruct-8bit` (cached) via `serve-model.sh mlx-vlm …`, run one
   *generation* fixture with `--vision`. This is the primary fix; generation needs to *see* the drawing.
2. **Optional tool-forcing in the provider.** Add `tool_choice` to `ChatStreamRequest` + `OpenAICompatConfig`
   (and a `plastiq-gen --require-tools` / `--first-tool build_part` flag) so weak models are forced off
   `answer_user` on turn 1. Pure addition to `openaiCompatible.ts:188`; unit-test the request mapping.
3. **(Lower priority)** a one-shot `build_part` example in the prompt + re-prompt a turn-1 `answer_user`.
- **Verify.** One generation fixture → a real `build_part` → `output.step` passes the gate (the first
  genuinely model-produced candidate). **Effort:** (1) ~30 min, (2) ~1–2 h.

## CB6.3 — Local CAD Score: get ground truth (today it's Space-only) — DONE (loop proven; GT is user-supplied)
**The local-scoring loop is proven and the request is drafted.** Verified `score` runs the full
`evaluate_result` against a **self-owned local GT** (set `CADGENBENCH_DATA_DIR` to an `inputs/`+`gt/` tree):
a correct candidate scores **1.0**, a broken one strictly lower — the only test that exercises
`score.score_run`'s `scored: True` branch (`tests/test_score_local_gt.py`, green; plus a live run printing
`mean CAD Score: 1.0`). So the day GT lands — official (request access) **or** self-authored — scoring goes
local with zero code change. `SUBMIT.md` now carries a ready-to-send GT-access message and the self-owned
mini-GT layout. **Full real-model loop proven:** authored a 60×40×8 GT via the kernel, generated a candidate
with **Qwen2.5-7B (llama.cpp)**, and scored it **CAD Score 1.0** end-to-end — a real model, real geometry,
real local score. A reusable `authorStep` helper (`headless/nodeBuild.ts`) builds a GT solid from a feature
document (no model) — used to author a **plate + 10 mm hole** GT (box→sketch→cut); the local model's
candidate (built it 10 mm thick vs the GT's 8 mm) scored **CAD Score 0.68**, the metric correctly giving
partial credit for a real geometric error. So the gen→score loop is proven across a perfect part (1.0) and a
flawed one (0.68). Authoring GT for the real *benchmark* drawings is genuine CAD work (the user's), so no
official-set numbers are claimed — only that the machinery is correct and proven on self-owned parts.

**Root cause:** `cadgenbench.common.paths.data_gt_dir` resolves GT only via `CADGENBENCH_DATA_GT_REPO`
(HF read access + `HF_TOKEN`) or `CADGENBENCH_DATA_DIR/gt` — neither is satisfied (GT private, account not in
the org). The harness is already GT-aware (`score.py`), so both fixes are zero-code-change to scoring:
1. **Request official GT access** (the request itself is the work; `SUBMIT.md` has the steps). On grant, set
   `CADGENBENCH_DATA_GT_REPO` + `HF_TOKEN` → `score` runs `evaluate_result` locally. I can draft the request.
2. **Self-owned mini-GT** (independent of the private set): author ground-truth STEPs for a small subset by
   solving those fixtures in Plastiq/CAD, lay them out as `inputs/<id>/` + `gt/<id>/ground_truth.step` (the
   bucket is read-write — store them there via `hf buckets sync`), and point `CADGENBENCH_DATA_DIR` at it.
   Yields **real local CAD Scores** on our own set, fully under our control (the jig fixtures already prove
   the scorer; this extends it to real parts). **Effort:** authoring is real CAD work — start with 3–5 simple
   fixtures.

**Recommended order:** CB6.1 (correctness bug, contained) → CB6.2.1 (serve vision model, get the first real
candidate) → CB6.2.2 (tool-forcing) → CB6.3 (GT). CB6.1 + CB6.2.1 together flip the headline from "plumbing
proven" to "evaluated a real Plastiq generation".
