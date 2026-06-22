# Plan — `services/nerf/` : a modular MLX NeRF / radiance-field service

**Date:** 2026-06-22
**Source idea:** nerfstudio (Apache-2.0) — architecture/idea only; **own MLX code** (the CUDA repo won't
run on Apple Silicon). Memory: [[mlx-m4max-ml-milestones]].
**Execution:** inline sequential · **strict TDD** (a failing test seen red before any code, every task) ·
**REAL MLX training asserted on the M4 Max** (no stubs/fakes) · deterministic by explicit MLX keys ·
one ADR per major decision + `SPEC-11`, docs kept current.
**Commit:** conventional commits, one per sub-milestone at green — **ask before committing**.
**Decisions locked** (this session): both models (density NeRF **then** SDF surface) · frequency encoding
**then** hash-grid · **full app integration** (FastAPI service + `nerf.ts` browser client + wire into the
MeshDoc→reconstruct path — not a tested island) · strict TDD with real-but-tiny training.

## Goal

A self-contained, modular **MLX** radiance-field service modeled on nerfstudio's architecture: posed
images → a trained MLX field → an exported mesh that flows into Plastiq's existing **MeshDoc →
reconstruct (mesh→B-rep)** path. Two models — a NeRF (density+color, volume rendering) and a NeuS/VolSDF
**SDF surface** model (watertight mesh). Trains on the **M4 Max**; reuses the MLX + FastAPI submit→poll +
GLB→MeshDoc patterns the **capture service** (`services/capture/`, M7/M8) established.

## Grounding (verified this session)

- **nerfstudio modules we mirror** (`ref/nerfstudio/nerfstudio/`): `field_components/`
  (`encodings.py`, `mlp.py`, `field_heads.py`, `activations.py`), `model_components/`
  (`ray_samplers.py`, `renderers.py`, `losses.py`, `ray_generators.py`), `fields/`
  (`vanilla_nerf_field.py`, `nerfacto_field.py`, `sdf_field.py`), `models/` (`vanilla_nerf.py`,
  `instant_ngp.py`, `neus.py`, `base_surface_model.py`), `data/`, `engine/`, `exporter/`.
  The requested layout maps onto these (the user's `generators/` = nerfstudio's `ray_samplers`).
- **Capture service to mirror** (`services/capture/`): `app/{geometry,sdf_mlx,completion_mlx,pipeline,
  jobs,main}.py`, `environment.yml` (conda-forge + `pip: mlx`), submit→poll `main.py`, GLB output →
  existing `MeshDoc`→reconstruct. `app/geometry.py` is the **MLX pinhole camera + ray math** (reuse it).
- **MLX patterns proven here** (M7/M8): `nn.Module` fields, `nn.value_and_grad` + `optim.Adam` training
  loops, `mx.random.key`/`split` for deterministic sampling, `skimage.measure.marching_cubes` on a field
  grid (numpy boundary), GLB via trimesh. Real training on the M4 Max in seconds for tiny scenes.
- **MLX is installed** (0.31, arm64) in the build env; `mlx.nn` / `mlx.optimizers` available.

## Licensing & MLX rule

- **nerfstudio = Apache-2.0** (`ref/nerfstudio/LICENSE`) — architecture/idea credit only; **no source
  copied**, our own MLX implementation. Attribution in the ADR/README.
- **MLX-native, not a port** (binding directive): every model/field/encoder/renderer/sampler is MLX
  (`mlx.core`/`mlx.nn`). numpy appears only at the unavoidable boundaries (transforms.json parsing,
  image I/O, `skimage` marching-cubes, GLB export). Deterministic via explicit MLX keys.

## Honest prerequisites / scope

- **SfM (photos → camera poses) is NOT built** — it stays COLMAP's job, ingested via a
  `transforms.json` (the nerfstudio/Blender convention). The training tests are driven by a
  **synthetic-pose fixture** (render a known sphere/textured cube from N synthetic camera poses), so
  the MLX training is real and reproducible without COLMAP.
- **Real-but-tiny training in tests**: low-res, few views, few hundred iters (seconds on the M4 Max);
  assert **PSNR improves** + the exported mesh is **roughly correct**. Full-quality configs are
  documented, not run in CI. No faked/stub training results (no-stub mandate).

---

# Milestones (MLX core first, then service, then app wiring)

## N0 — Scaffold + ADRs + SPEC + utils
- [ ] **N0.1** Create the tree: `services/nerf/app/{data_processing,engine,exporters,field_components,
      fields,generators,model_components,models,utils}/__init__.py`, `tests/`, `.dockerignore`,
      `.gitignore` (mirror capture: `__pycache__/`, `.pytest_cache/`), `environment.yml` (conda-forge +
      `pip: mlx`; numpy/trimesh/scikit-image/fastapi/uvicorn/pydantic/httpx/pytest — mirror capture),
      `pyproject.toml`, `README.md`.
- [ ] **N0.2 — ADR + SPEC.** `docs/adr/0011-nerf-service-architecture.md` (modular MLX NeRF; nerfstudio
      Apache-2.0 idea-only; SfM deferred to COLMAP; both models). `docs/specs/SPEC-11-nerf-service.md`.
- [ ] **N0.3 — TDD utils.** `app/utils/`: `seeding.py` (deterministic MLX key derivation), `config.py`
      (typed dataclass configs), `math.py` (safe-norm, etc.). Tests: same seed → identical keys/draws.

## N1 — field_components (MLX nn building blocks)
- [ ] **N1.1 — TDD FrequencyEncoding** (`field_components/encodings.py`): sinusoidal positional encoding
      `[x, sin(2^k x), cos(2^k x)…]`. Test: output dim = in·(1+2L); known values for L=1.
- [ ] **N1.2 — TDD MLP + heads** (`mlp.py`, `field_heads.py`, `activations.py`): an MLX `nn.Module` MLP;
      density head (softplus/relu → ≥0) + RGB head (sigmoid → [0,1]). Tests: forward shapes; density ≥ 0;
      rgb ∈ [0,1].

## N2 — generators (ray samplers)
- [ ] **N2.1 — TDD UniformSampler** (`generators/ray_samplers.py`): N samples along each ray between
      near/far. Test: monotonically increasing t, within [near,far], correct shape.
- [ ] **N2.2 — TDD PDFSampler** (importance/hierarchical): resample from a weight distribution. Test:
      samples concentrate where weights are high (deterministic key).

## N3 — model_components (renderers + losses)
- [ ] **N3.1 — TDD volumetric renderer** (`model_components/renderers.py`): densities+colors+deltas →
      RGB / accumulation / depth via the standard alpha-compositing. Test: a single opaque sample → its
      colour; empty densities → background; accumulation ∈ [0,1].
- [ ] **N3.2 — TDD losses** (`losses.py`): MSE photometric; eikonal (`‖∇f‖→1`, for SDF). Test: zero loss
      on equal images; eikonal zero on a unit-gradient field.

## N4 — fields (the radiance field)
- [ ] **N4.1 — TDD NeRFField** (`fields/vanilla_nerf_field.py`): encode position+direction → MLP →
      (density, rgb), composed from N1. Test: forward shapes; density ≥ 0; deterministic.

## N5 — data_processing (pose/ray ingestion + synthetic fixture)
- [ ] **N5.1 — TDD transforms.json parser** (`data_processing/dataparser.py`): parse a nerfstudio/Blender
      `transforms.json` → typed `DataparserOutputs` (intrinsics + per-image c2w poses + image paths).
      Test: a fixture transforms.json parses to the right cameras/poses.
- [ ] **N5.2 — TDD ray generation** (`data_processing/rays.py`, reusing capture `geometry.py` MLX pinhole):
      per-pixel ray origins+directions in world space from a camera pose. Test: centre pixel ray points
      down the camera axis; corner rays diverge correctly.
- [ ] **N5.3 — Synthetic scene fixture** (`tests/synthetic.py`): render a known textured sphere/cube from
      N analytic camera poses → (images, poses, intrinsics). Pure geometry (analytic ray–sphere/box hit +
      shading), no training — the reproducible ground truth the training tests fit. Test: renders are
      non-trivial + deterministic.

## N6 — engine + density NeRF model + TRAIN ON SYNTHETIC (real MLX training, M4 Max) ⭐
- [ ] **N6.1 — TDD Trainer** (`engine/trainer.py`): MLX `optim.Adam`, `nn.value_and_grad`, ray-batch
      training loop, deterministic. Test: one step decreases the loss on a fixed batch.
- [ ] **N6.2 — TDD VanillaNeRF model** (`models/vanilla_nerf.py`): ties field (N4) + sampler (N2) +
      renderer (N3) + MSE loss → a render-rays-and-composite forward. Test: rendered shape matches; a
      forward runs.
- [ ] **N6.3 — TDD train-on-synthetic (the headline).** Train the NeRF on the N5.3 synthetic scene for a
      few hundred iters → assert **PSNR(rendered, gt) improves by a real margin** vs init, on held-out
      pixels; deterministic by seed. **Real MLX training on the M4 Max** — no stub.

## N7 — hash-grid encoding (instant-NGP upgrade)
- [ ] **N7.1 — TDD multiresolution hash encoding** (`field_components/encodings.py::HashGridEncoding`):
      MLX hashing + trilinear interp over L resolution levels. Test: output shape = L·F; deterministic;
      distinct inputs → distinct features.
- [ ] **N7.2 — TDD NeRF-with-hashgrid converges.** Swap the encoding into the NeRF; train on the synthetic
      scene → reaches a target PSNR in fewer iters than frequency (or at least trains). Real training.

## N8 — SDF / NeuS surface model ✅
- [x] **N8.1 — SDFField** (`fields/sdf_field.py`): **raw** 3D position → SDF + geometry feature, with the
      IGR geometric init proven in capture `sdf_mlx.py` (raw coords, not positional-encoded — the init
      formula assumes raw `x`); a colour head turns (feature, encoded view dir) → RGB. `sdf()` exposes the
      scalar field for `mx.grad`. Tests: forward shapes, inside/outside sign, finite non-zero gradient.
- [x] **N8.2 — VolSDF model** (`models/neus.py` `VolSDFModel`, `models/base_surface_model.py`): shipped the
      **VolSDF** Laplace-CDF SDF→density transform (the NeuS/VolSDF family; SPEC-11 FR-2) + the existing
      `volumetric_render` + eikonal via `render_loss` (second-order `mx.grad`-in-loss, capture pattern).
      Tests: density ≥ 0, peaks at surface (1/2β), monotone inside→surface→outside.
- [x] **N8.3 — REAL train surface-on-synthetic → mesh.** Trained VolSDF on synthetic sphere views on the
      M4 Max: held-out PSNR **7.43 → 21.55 dB (+14.1)** (appearance learned through the SDF→density→render
      path), and the eikonal-regularized field marching-cubes to a clean **1866-vert, mean-radius-1.034**
      sphere. 28/28 nerf tests green (cadling env: mlx + skimage).

## N9 — exporters (field → mesh → GLB) ✅
- [x] **N9.1 — marching-cubes exporter** (`exporters/mesh_exporter.py`): `marching_cubes_field` evaluates
      any scalar field on a `res³` grid (MLX, batched) → `skimage.measure.marching_cubes` → world-unit
      verts/faces; `extract_sdf_mesh` (SDF zero level-set) + `extract_density_mesh` (NeRF density iso, zero-
      dir query) cover both field kinds. Tests: analytic unit-sphere SDF + density iso → mean radius ≈ 1;
      a real `SDFField` extracts a non-empty unit-scaled mesh.
- [x] **N9.2 — GLB + point-cloud export** (`exporters/glb_exporter.py`): `mesh_to_glb` (trimesh,
      `process=False`, mirrors capture `to_glb`) + `pointcloud_to_glb` (trimesh Scene). Tests: both
      round-trip back through trimesh preserving vertex/face/point counts. 5/5 exporter tests green.

## N10 — FastAPI service (submit→poll)
- [ ] **N10.1 — TDD job contract** (`engine/jobs.py` — mirror capture `jobs.py`): submit→poll state
      machine; live test (no fastapi).
- [ ] **N10.2 — TDD service** (`app/main.py`): `POST /train { transforms_json, images }` → poll →
      `{ glb_base64, … }` (train field → export mesh). Health + status + result. API test gated on
      fastapi+mlx (mirrors capture `test_api.py`).

## N11 — `@plastiq/nerf` workspace package + app wiring (REACHABLE — not a tested island) ⭐
**The TS/browser side is its OWN workspace package `packages/nerf` (`@plastiq/nerf`), a sibling of
`@plastiq/cad` / `@plastiq/sim` — not an app file.** (`packages/nerf` already exists in the workspace,
empty; the workspace globs `packages/*`.)
- [ ] **N11.1 — Package scaffold.** `packages/nerf/{package.json (@plastiq/nerf),tsconfig.json,src/index.ts}`
      mirroring `packages/sim`. Wired into the pnpm workspace + root tsconfig refs as needed.
- [ ] **N11.2 — TDD nerf client** (`packages/nerf/src/client.ts`, mirror `apps/plastiq/src/ai/reconstruct.ts`):
      submit→poll a `/train` job → the produced GLB → a `MeshDoc`-shaped result. Vitest with a scripted fetch.
- [ ] **N11.3 — Wire into the app.** `apps/plastiq` imports `@plastiq/nerf`; the nerf GLB → `MeshDoc` → the
      existing **"Convert to CAD"** reconstruct path; a settings `nerfBaseURL`. Vitest + typecheck. **The
      integration step** — verify a non-test app file imports `@plastiq/nerf` (no orphan).
> Note: the other empty `packages/*` dirs (`data`, `embed`, `recon`, `rl`, `segment`) are the user's
> future scaffolding — OUT OF SCOPE for this plan unless requested.

## N12 — Docs reconciliation
- [ ] **N12.1** Finalize `SPEC-11`; `services/nerf/README.md` (architecture, env, the COLMAP/transforms.json
      front-end caveat, training on the M4 Max); update `Expanse.md` (nerfstudio item → built, with the
      honest wiring status) + the integration ledger.

---

## Cross-cutting completion gate (every milestone)
1. **Strict TDD honored** — each task's failing test existed and was seen red before code.
2. **Real MLX training, no stubs** — training milestones assert a genuine PSNR/mesh improvement from a
   real M4-Max run; no faked numbers.
3. **Suites green, zero regressions** — `services/nerf` pytest (MLX env) + full `vitest` + `just typecheck`
   + `just lint`.
4. **Deterministic** — explicit MLX keys; same seed → same result (tested).
5. **Docs current** — the milestone's ADR/SPEC + README + Expanse updated in the same change (CLAUDE.md).
6. **Commit** at green, conventional message — **after asking**.

## Sequencing rationale
field_components → generators → model_components → field → data/rays → **train density NeRF on synthetic**
(N1–N6) is the buildable, testable MLX core (each layer unit-tested before the model that composes it).
Then hash-grid (N7) and the SDF surface model (N8) are upgrades on that proven core; exporters (N9) and
the FastAPI service (N10) wrap it; and the browser client + wiring (N11) make it **reachable from the app
a user runs** — directly addressing the "tested island" gap from the Expanse milestones. Docs last (N12).
