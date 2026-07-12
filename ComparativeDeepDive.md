# Comparative Deep Dive: How `ref/**` Achieves Its Outcomes vs Our `services/**`

**Date:** 2026-07-11
**Scope:** Photogrammetry/SfM · NeRF+NeuS surface · MVS · point-cloud→mesh completion · mesh→CAD/NURBS
**Method:** Direct source reading of the vendored reference codebases in `ref/` and our services in `services/`. Every claim is cited `file:line`. No runtime assumptions.

---

## 1. Executive Summary

Two theses explain nearly every quality gap between the reference codebases and ours:

1. **Learned priors vs. classical geometry.** The reference repos overwhelmingly reach their results with **models trained on large datasets** — occupancy networks (`shape-completion`), vector-quantized transformers (`ShapeFormer`), hashgrid-NeRF with proposal sampling (`nerfstudio`), learnable-variance NeuS (`sdfstudio`), and LLMs that emit STEP/OpenSCAD (`StepForge`, `CADAM`). Our services are **deterministic classical geometry** — OpenCASCADE B-rep, least-squares NURBS, scipy sparse-LM bundle adjustment, per-cloud IGR SDF fitting. Classical needs no training, runs anywhere, and is deterministic; its ceiling on ambiguous/photometric inputs is lower.

2. **"Geometry handed" vs. "geometry solved."** Our pipeline is strong exactly where the geometry is *handed to it* and weak where it must be *solved from images*. `capture` (oriented cloud → mesh) uses the **same IGR SDF recipe** as sdfstudio and **works** (`services/capture/app/sdf_mlx.py:63`). Our `nerf` (images → surface) **collapses/diverges** because solving geometry from photometry needs the production machinery — learnable annealed β, proposal sampling, weight-norm, LR scheduling, background/mask models — that `sdfstudio`/`nerfstudio` have and we do not.

The most important single finding: **our NeuS is not "almost there, one tweak away." It is missing five independent, load-bearing mechanisms that the reference NeuS treats as mandatory.** They are enumerated in §4.

---

## 2. Domain: Structure-from-Motion (SfM)

### What kornia provides
`kornia` is a **primitives library**, not a pipeline. It ships the exact two-view/robust-estimation building blocks:
- Essential-matrix / 5-point: `ref/kornia/kornia/geometry/epipolar/essential.py`, polynomial root-finding `ref/kornia/kornia/geometry/solvers/polynomial_solver.py`
- Robust estimation: `ref/kornia/kornia/geometry/ransac.py` (`class RANSAC`)
- PnP: `ref/kornia/kornia/geometry/calibration/pnp.py`
- Triangulation: `ref/kornia/kornia/geometry/epipolar/triangulation.py`

### What kornia does NOT provide
A grep for bundle adjustment / Levenberg-Marquardt / incremental mapping across `ref/kornia/kornia/` returns **nothing**. kornia has no global optimizer, no incremental mapper, no track graph.

### What we do
Our `services/photogrammetry` implements the **full pipeline that kornia stops short of**:
- Own-MVG primitives (kornia-attributed ports): `app/core/ransac.py` (`ransac_essential`, `ransac_fundamental`, `ransac_pnp`)
- **Incremental mapper** with two-view init, PnP registration, triangulation, track union-find: `app/sfm.py` (`reconstruct`, `verify_pair_matches`, `select_init_pairs`, `_seed_from_pair`)
- **Sparse-LM bundle adjustment** via scipy: `app/core/ba.py` (`run_bundle_adjustment`, with `ftol/xtol/gtol` convergence tolerances added this session)
- Geometric verification (RANSAC-fundamental per pair) before track building — the COLMAP step: `app/sfm.py:verify_pair_matches`

### Load-bearing difference
**We are ahead of kornia here, not behind.** The comparison target for our SfM is **COLMAP** (not kornia): a full incremental mapper + global BA + geometric verification. Our mapper reaches that shape (it registered Gorsedd 48/48 @ 0.316px, Stone_Mask 12/14 @ 0.323px, Monstree 41/41 @ 0.604px). The one production gap vs COLMAP is **robustness tuning breadth** — COLMAP's thresholds are relative/adaptive across resolutions; ours are pixel-absolute and tuned for ~640px (which is why naive 1600px sparse collapsed 12/14→6/14, and why the decoupled sparse-at-640 / dense-at-1600 path was the fix — see the `solve(dense_images=…)` change in `services/photogrammetry/app/pipeline.py`).

---

## 3. Domain: Dense MVS

### Reference approach
Classical MVS (COLMAP/OpenMVS-style) uses PatchMatch stereo with **slanted-plane** hypotheses propagated stochastically. `nerfstudio`/`sdfstudio` skip explicit MVS entirely — they get density/depth from the neural field.

### What we do
`services/photogrammetry/app/mvs/plane_sweep.py` implements a **two-stage plane-sweep**: a fronto-parallel ZNCC seed (`_WINDOW=3`, `_N_HYPOTHESES=96`) plus a **deterministic slant-corrected refinement** (`_REFINE_WINDOW`, `_REFINE_CANDS=11`, `_REFINE_SPAN=0.04`) — a deterministic analogue of PatchMatch's slanted-plane step, with no RNG (`plane_sweep.py:7-19`). Fusion enforces multi-view geometric consistency: `app/mvs/fusion.py:110` (`fuse`, `min_views`, `rel_depth_tol`, `normal_dot`).

### Load-bearing difference
Ours is a **legitimate, deterministic classical MVS**. The quality levers are exactly the two knobs this session exposed: **resolution** (dense res is independent of sparse res — extrinsics are resolution-free, only K scales) and **`min_views`** (2 favors density, 3 favors cleanliness). The reference "advantage" is not a better MVS — it's that neural methods sidestep MVS's slant/occlusion failure modes by regularizing geometry globally. Our MVS is fine; it's downstream fusion strictness (`min_views=3` on a turntable) that starved Monstree, not the sweep.

---

## 4. Domain: NeRF + NeuS Surface — the core gap

This is where the reference codebases are decisively ahead, and the reasons are concrete.

### 4.1 Geometric initialization — WE HAVE THIS
Both sides initialize the SDF MLP so it represents a signed sphere at step 0 (IGR/SAL init):
- **sdfstudio:** `ref/sdfstudio/nerfstudio/fields/sdf_field.py:292-310` — last layer `mean=-√π/√dim`, `bias=+0.8` (`inside_outside=True`, `bias=0.8` at `:140-144`).
- **Ours:** `services/nerf/app/fields/sdf_field.py:51-59` — last-layer SDF row `√π/√in_dim`, `bias[0]=-radius`.

Confirmed empirically: our field is a proper sphere at init (diagnostic: `SDF @ INIT min=-0.828, frac_neg=0.061`). **This is not the problem.**

### 4.2 The five mechanisms we are MISSING

| # | Mechanism | Reference (`sdfstudio`/`nerfstudio`) | Ours | Consequence of absence |
|---|-----------|--------------------------------------|------|------------------------|
| 1 | **Learnable, annealed density sharpness** | `LaplaceDensity(init_val=beta_init)` **learnable** + `SingleVarianceNetwork(init_val=beta_init)` NeuS 's' — annealed by training (`sdf_field.py:318,323`) | **Fixed** `laplace_beta=0.2` (`services/nerf/app/models/neus.py:27`) | Surface band never sharpens; the field can't tighten onto the object |
| 2 | **weight_norm on every layer** | `nn.utils.weight_norm(lin)` on all linears (`sdf_field.py:312`) | none | Unstable optimization magnitude; contributes to divergence |
| 3 | **Proposal / error-bounded sampling** | `ProposalNetworkSampler` — 2-stage, `num_proposal_samples_per_ray=(64,)` → `num_nerf_samples_per_ray=32`, density-guided (`ref/nerfstudio/nerfstudio/model_components/ray_samplers.py:522-541`) | `UniformSampler(48)` + optional PDF (`services/nerf/app/models/base_surface_model.py:33`) | Samples wasted in empty space; surface under-sampled |
| 4 | **LR schedule + warmup + grad handling** | `ExponentialDecayScheduler`, warmup, grad scaling | **Fixed** `Adam(lr=5e-3)`, no schedule/warmup/clipping (`services/nerf/app/engine/trainer.py:29-65`) | Early divergence (our diag: SDF exploded to +9–14 with the mask term) |
| 5 | **Background / scene model** | NeRF++ background model + `SceneContraction` for the far field (`ref/nerfstudio/...`) | none — empty rays render **black** (`services/nerf/app/model_components/renderers.py:25`, `rgb = Σw·c`, no bg term) | White-background synthetic targets mismatch → PSNR collapses; and the model can "explain away" the object as empty background |

### 4.3 Why ours collapses AND diverges (the observed oscillation)
- **Without a mask/background term:** the photometric loss finds it *cheaper to make the surface empty* than to reconstruct it — the SDF drifts all-positive (diag: `min +0.207, frac_negative 0.0`), and marching cubes finds no zero-crossing. More iterations made it **worse** (1500 iters `min −0.013` → 4000 iters `min +0.207`), i.e., the loss is actively *removing* the surface.
- **With a silhouette/mask term (added, then reverted):** the extra gradient — atop a fixed β, no weight-norm, no LR schedule, no grad clip — **diverges** (SDF → +9–14).

Both failure modes are direct consequences of the missing mechanisms in §4.2. The reference NeuS treats **all five as mandatory**; they are not optional tuning.

### 4.4 The decisive caveat: masks don't generalize
`sdfstudio` object reconstructions and the nerf-synthetic dataset both rely on **per-image object masks** (silhouettes). The nerf-synthetic PNGs ship an alpha channel; **real photos of an arbitrary object do not.** So a masked NeuS is a *synthetic-benchmark demo* on its own; on maskless real captures the other four mechanisms (below) still help, but the mask term simply doesn't fire.

### 4.5 UPDATE (2026-07-11) — four of the five are now implemented; lego converges
Four of §4.2's mechanisms have since been built into `services/nerf` (opt-in; defaults reproduce the
old behaviour, so the 65 existing nerf tests stay green):
1. **Learnable, annealed β** — `VolSDFModel(learnable_beta=True)` parameterizes β in log-space (β_min + eᵂ), trained/annealed by the optimizer (`services/nerf/app/models/neus.py`).
4. **LR schedule + warmup + gradient clipping** — `Trainer.train(grad_clip=, warmup_frac=, lr_final_frac=)`: linear warmup → cosine decay + `optim.clip_grad_norm` (`services/nerf/app/engine/trainer.py`).
5. **Background compositing** — `NerfConfig.background`; `rgb = Σw·c + (1−Σw)·bg` in both models (`base_surface_model.py`, `vanilla_nerf.py`). Plus the **silhouette-mask loss** (`mask_weight`, 4-channel targets).

Mechanism **2 (weight_norm)** and **3 (proposal sampling)** are still NOT implemented. Even so, on the
nerf-synthetic `lego` (100 views + Blender poses) the collapse/divergence is **fixed**: PSNR **9.4 → 20.8**
(9.4 broken → 19.5 with the stability mechanisms → **20.8** once learnable β actually anneals — see the
`_log_beta`→`log_beta` note below), the SDF forms a real zero-crossing (was empty → marching-cubes crash),
and it extracts a **watertight ~30k-vert mesh** with a recognizable chassis, recessed cab, and articulated
arm + bucket. Regression-tested (`tests/test_surface.py` N8.4: learnable-β annealing, background
compositing, silhouette-mask loss). Remaining softness (no tread/stud detail) is the low-capacity ceiling
(64-wide MLP, 400px) + the missing proposal sampler — an adoption/scale step, not a convergence bug.

> **MLX gotcha (verified against `mlx/nn/layers/base.py:236`):** `Module`'s `valid_child_filter` is
> `isinstance(value, (dict, list, mx.array)) and not key.startswith("_")` — so an `mx.array` attribute
> named with a leading underscore is **silently excluded from `parameters()`** and never trains. The
> learnable β was initially `self._log_beta` (inert; β frozen). Renaming to `self.log_beta` registered
> it; β now anneals 0.3 → ~0.12 during training (+~1.3 dB on lego).

---

## 5. Domain: Point-cloud → Mesh (shape completion) — where we are actually strong

### Reference approaches (all learned)
- **`shape-completion`:** trained **occupancy networks** — supervision is packed occupancy bits / TSDF (`ref/shape-completion/dataset/src/fields.py:94-116`, `np.unpackbits(occupancies)`, `occ_from_sdf`). A network predicts inside/outside, then marching cubes. Needs a trained prior over shapes.
- **`ShapeFormer`:** **VQDIF** (vector-quantized deep implicit) + an **autoregressive transformer** (`ref/ShapeFormer/core_code/shapeformer/shapeformer.py`, `vqdif.yaml`) — completes partial clouds by *generating* plausible geometry from a learned codebook.

### What we do — and why it works
`services/capture/app/sdf_mlx.py` fits an **IGR Softplus SDF** to the oriented cloud with the classic three losses — surface (`f≈0`), normal-alignment (`∇f≈n`), eikonal (`|∇f|≈1`) — geometric init, then marching cubes (`sdf_mlx.py:4-6, 26, 63-96`; `fit_sdf(..., iters=600, lam_eikonal=0.1)`). **This is the same IGR recipe (Gropp et al.) that underlies sdfstudio's SDF field** — and it produced the recognizable carved-stone mesh (56.8k verts / 113k faces, watertight).

### Load-bearing difference
`capture` works where `nerf` fails **because the geometry is handed to it as an oriented cloud** — no photometric ambiguity, no need for masks, no per-scene training. The reference completion nets add value only for **filling unseen regions** (a learned shape prior); for a well-covered 360° capture, our prior-free IGR fit is competitive and needs zero training data. **This is the production-quality, any-object path in this repo.**

---

## 6. Domain: Mesh → CAD / B-rep / NURBS — a different problem than the ML repos solve

The CAD reference repos are **not** doing mesh→B-rep reconstruction; they occupy adjacent problems:

| Repo | What it actually does | Cited |
|------|-----------------------|-------|
| **BRepNet** | Topological **message passing on existing B-reps** (coedge walks) for face **segmentation/classification** — *consumes* B-reps, does not build them | `ref/BRepNet/README.md:1-16` |
| **StepForge** | Fine-tunes **LLMs to generate raw STEP files** (ISO-10303) from text; data from Text2CAD; SFT+GRPO reward = STEP→cloud FPFH+RANSAC+ICP | `ref/StepForge/README.md:15-19,35-39` |
| **CADAM** | **LLM → parametric OpenSCAD** from a plain-language prompt (text-to-CAD) | `ref/CADAM/README.md:65` |
| **NURBGen** | **Learned NURBS generation** (train/infer/export a model) | `ref/NURBGen/src/{train.sh,infer_nurbgen.py,nurbs_representation/export.py}` |

### What we do
`services/reconstruct` and `services/nurbs` do **classical geometric mesh→B-rep**:
- **reconstruct:** analytic-primitive detection → solid-of-revolution → CSG → fitted freeform → per-triangle faceted fallback, all via OpenCASCADE (`app/pipeline.py`, `app/faceted.py:52`, `app/fitted.py`). Nothing learned; nothing is ever dropped (faceted baseline).
- **nurbs:** closed-mode **cube-map charting** → shared-boundary LSQ NURBS-patch fit per chart → watertight 6-patch solid (`app/pipeline_closed.py:223`, `boundary.fit_shared_curves`, `param.cube_map_charts`).

### Load-bearing difference
The ML CAD repos generate/analyze **from priors or language**; we **deterministically convert measured geometry**. Our niche (mesh→editable B-rep/NURBS with verified watertight closure) is one the learned CAD repos don't occupy — but it inherits classical fragility: the cube-map charting **stalls on deeply-concave organic shapes** (hence the charting→faceted graceful-degradation added this session, `pipeline_closed.py`), and per-triangle B-rep of a 113k-face organic mesh is pathological (hence the reconstruct **OCC-subprocess isolation**, `services/reconstruct/app/occ_pool.py` + `reconstruct_isolated`). A learned segmentation prior (BRepNet-style) is what would let us pick smooth patch layouts for organic shapes — the reference repos' real advantage here.

---

## 7. The Cross-Cutting Thesis

| Axis | Reference `ref/**` | Ours `services/**` |
|------|--------------------|--------------------|
| **How outcomes are achieved** | Learned models + large training data (occupancy nets, transformers, hashgrid-NeRF, LLMs) | Deterministic classical geometry (OCCT, LSQ, scipy BA, IGR SDF) |
| **Training required** | Yes (datasets, GPUs, checkpoints) | No — runs cold on any input |
| **Determinism** | Stochastic (sampling, generation) | Deterministic (seeded) |
| **Generalization** | High *within* the trained distribution | Uniform, but lower ceiling on ambiguous/photometric inputs |
| **Where it shines** | Ill-posed/incomplete inputs, generation, unseen-region hallucination | Well-posed measured geometry (clouds, watertight meshes) |
| **Where it breaks** | Out-of-distribution inputs; needs data/compute | Photometric geometry-from-images (NeRF), concave organic charting |

**Practical implication for this repo:** the production, any-object path is **photogrammetry → capture (IGR SDF) → mesh**, optionally → reconstruct/NURBS with the graceful-degradation guards. The neural-surface (NeRF) path is a research component whose reference-grade quality is an *adoption* project (integrate `nerfstudio`/`sdfstudio`), not a from-scratch tuning exercise — the five mechanisms in §4.2 are the shopping list, and the mask dependency in §4.4 is why it can't be the general path.

---

## 8. Open Questions (not answerable from source alone)

1. Would porting sdfstudio's **learnable-β + variance network + weight-norm + proposal sampler** into `services/nerf` close the gap without masks on *real* captures? (Needs a training run to know; the reference code implies yes-for-masked, unknown-for-maskless.)
2. Does `shape-completion`'s learned occupancy prior beat our prior-free IGR fit on *partial* (non-360°) captures like the Stone_Mask relief? (Their premise says yes; unverified here.)
3. Could a BRepNet-style learned face-segmentation replace cube-map charting for concave organic NURBS layout? (Architecturally plausible; not implemented in either codebase for this direction.)

---

*Evidence base: `ref/{kornia,nerfstudio,sdfstudio,shape-completion,ShapeFormer,BRepNet,StepForge,CADAM,NURBGen}` and `services/{photogrammetry,nerf,capture,reconstruct,nurbs}`, read directly. Citations are `path:line` at the time of writing (2026-07-11).*
