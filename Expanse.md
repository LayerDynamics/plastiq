# Expanse — models & workflows we could integrate from the `ref/` corpus

**Date:** 2026-06-21
**Method:** `/lore:deep-code-investigation` — read each `ref/` repo's README, **LICENSE**, and
core model/pipeline source (no claim without a file); cross-checked every "we could add this"
verdict against Plastiq's *actual* code (`services/reconstruct/app/*.py`,
`packages/cad/src/select/predicates.ts`, `apps/plastiq/src/ai/**`) so the recommendations target
real seams, not imagined ones. Five read-only investigation agents covered the 21 named repos in
parallel; this file is the synthesis.

---

## 0. What Plastiq is, and where any of this could land

Plastiq is a **browser-based, parametric, in-browser B-rep CAD editor** on the OCCT/WASM kernel
(`@plastiq/cad`), with a tool-using AI agent and a creative text/image→mesh path. It is not a
research notebook — so the only useful question about 21 ML repos is *"into which shipping seam
does each one land, if any?"* There are exactly three, and **every recommendation below is tagged
with one**:

| Tier | Seam | Constraints | What lives here today |
|---|---|---|---|
| **T1** | Browser / no-server core (`apps/plastiq`, `@plastiq/cad`) | TypeScript or WASM, **deterministic** (NFR-2), serverless | sketch+constraints, ~18 features, STEP/IGES/glTF, geometry-relative selectors |
| **T2** | Optional self-hosted Python service (`services/reconstruct`) | CAN be ML, runs **offline/reproducibly** on the user's box | deterministic mesh→B-rep: primitives / revolution / CSG / cut-cylinder / fitted / faceted |
| **T3** | Cloud creative path (`MeshGenProvider`, submit→poll) | already **paid + networked**; heavyweight ML/GPU/API OK | fal: Tripo / Meshy / Hunyuan3D + FLUX image-gen |

**The headline:** of 21 repos, **most are already-covered, superseded, or off-topic.** The genuine
finds are few and concrete:

1. **StepForge's Scaled-Chamfer-Distance fidelity metric** → drop-in **T2** reconstruction-quality
   gate (Apache-2.0, pure Python, NET-NEW). *Highest-confidence, lowest-friction win.*
2. **BRepNet's deterministic B-rep traversal substrate** (half-edge walks + dihedral convexity) →
   **T2** feature-recognition + **T1** "select tangent faces / fillet chain" selection (clean-room
   only — CC-BY-NC-SA — NET-NEW).
3. **DLR-RM `shape-completion`** → **T2** "complete my partial scan into a watertight mesh"
   (MIT, modern, NET-NEW capability — but ships no weights; a real GPU/training lift).
4. **nerfstudio / sdfstudio photogrammetry** → documented **external-tool→import** capture workflow
   (real-object photos → mesh → reconstruct; Apache-2.0; NET-NEW but organic output, weak for
   mechanical parts).

Everything else is design-inspiration (ideas, not code) or a reject. Details below.

---

## 1. Per-repo cards

Each card: **what it IS** · **license** (load-bearing — a non-commercial/no-license repo means
*idea-only*, never copy) · **model/workflow** · **liftable algorithm vs heavyweight dependency** ·
**tier + NET-NEW vs ALREADY-COVERED verdict** · **evidence**.

### Group A — CAD kernels & authoring workflows

#### A1. CADmium — *study-only; behind us*

- **What** — From-scratch browser parametric CAD (Rust→WASM + SvelteKit/Threlte), hobbyist-focused.
  README marks it **inactive / pre-MVP**.
- **License** — **Elastic-2.0** (source-available, **NOT** OSI; forbids offering as a hosted/managed
  service). Plastiq is a hosted browser editor → **code is unusable**; only clean-room idea reuse is
  legal. Evidence: `ref/CADmium/LICENSE.md:17-20`, README License FAQ.
- **Model/workflow** — Event-sourced `Message` enum → `Workbench`/`Step`s → `truck` (pure-Rust,
  OCCT-free B-rep kernel) → mesh/STEP. **Its 2D constraint solver is a spring/penalty relaxation
  solver** (`kp`/`kd`/`error` per constraint) — *weaker* than Plastiq's planegcs (real geometric
  GCS), with ~4 constraint types vs our full set. Evidence: `src/sketch/constraints.rs:8-120`,
  `src/message.rs`.
- **Liftable** — The CADmium wrapper is **ALREADY-COVERED and behind** `@plastiq/cad`. The only
  forward-looking asset is **`truck`** — the pure-Rust WASM kernel it wraps — as a hypothetical
  smaller-WASM alternative to OCCT (separate repo, **license unchecked**).
- **Verdict** — **No tier. Study-only.** Note `truck` as a future kernel candidate; do not treat
  CADmium as an upgrade path.

#### A2. StepForge — ⭐ *the SCD fidelity metric is the best lift in the corpus*

- **What** — Independent reimplementation of the **STEP-LLM** paper: an ML training pipeline
  (SFT+GRPO) fine-tuning an LLM to emit raw STEP from text. **Not a CAD tool** — HPC training/eval
  infra. Evidence: `ref/StepForge/README.md:1-21`.
- **License** — **Apache-2.0** repo-wide. The **LLM path** carries secondary encumbrances (Llama-3.2
  weights = Meta license; Text2CAD dataset terms) — but we **do not want the LLM path**. The piece we
  want (the metric) is plain Apache-2.0. Evidence: `LICENSE`, `ATTRIBUTION.md`.
- **Model/workflow** — Two pipelines. (1) text→STEP LLM (T3 at best, encumbered, *unreproduced* — its
  own RL is "in progress, eval pending"; the README's metric table is the *paper's* numbers). (2) **A
  pose/scale-invariant geometric fidelity metric, pure Python on OCC/scipy/open3d:**
  `step_to_pointcloud.py` (OCC `STEPControl_Reader` → adaptive `BRepMesh_IncrementalMesh` →
  area-weighted barycentric surface sampling, **SHA-256-seeded → deterministic**) → `alignment.py`
  (centroid → **FPFH+RANSAC** global registration → 3× coarse-to-fine **ICP**, scale-pre-normalized) →
  `scd_reward.py` (**Scaled Chamfer Distance** = bidirectional Chamfer normalized by GT RMS radius).
  Hardened with subprocess-isolated OCC (survives native SIGSEGV on malformed STEP). Evidence:
  `ref/StepForge/reward/{step_to_pointcloud,alignment,scd_reward}.py`.
- **Liftable** — The metric is **a liftable algorithm, near-zero porting.** Reconstruct's stack is
  **pythonocc-core + trimesh + numpy + scipy** (verified `services/reconstruct/pyproject.toml` +
  `environment.yml` — **no open3d**). StepForge's pose-alignment stage (FPFH+RANSAC+ICP, the only part
  needing open3d) exists because it compares an LLM-generated STEP against ground truth in an
  *arbitrary* pose — **but our reconstructed B-rep is built *from* the input mesh, already in the same
  frame**, so we'd lift only the **surface sampling + `scipy.spatial.cKDTree` bidirectional Chamfer**
  (numpy/scipy/trimesh — all already present); alignment is optional.
- **Verdict** — **T2, NET-NEW.** Verified against our code: reconstruct today validates **only by
  volume** (`detect.py:125 _volume_ok`; `csg.py:244`, `revolution.py:114`, `fitted.py:194`,
  `topology.py:208`) and a coarse **per-region RMS** (`fitted.py:140,184`). There is **no**
  chamfer/hausdorff/ICP/registration anywhere (grep: zero hits). SCD is a *finer, surface-level,
  pose/scale-robust* fidelity score that **complements** (does not duplicate) the volume gate — it
  would let reconstruct report "how faithfully did this B-rep reproduce the mesh surface," and could
  gate the accuracy ladder on surface deviation, not just volume.

#### A3. partcad — *idea-only; far from our core*

- **What** — **Not a CAD/drawing tool** (README says so): a **package manager / lightweight PLM for
  hardware** — versions, caches, renders, sources manufacturable part/assembly packages. Evidence:
  `ref/partcad/README.md:13-23`.
- **License** — **Apache-2.0** (`LICENSE.txt`). Clean.
- **Model/workflow** — `Context` loads git/tarball "packages"; pluggable factories delegate geometry
  to **CadQuery / build123d / OpenSCAD** (it runs them, implements no geometry); **AI part factories**
  do prompt→CAD-script→geometry (Gemini/OpenAI/Ollama); **`.assy` YAML** declares assemblies
  (`links:` with `part`/`package`/`location:[[xyz],[axis],angle]`, recursive) with **auto-BOM**; a
  provider subsystem quotes/orders from manufacturers. Evidence:
  `src/partcad/part_factory_ai_cadquery.py`, `examples/produce_assembly_assy/*.assy`.
- **Liftable** — No novel geometry algorithm (delegated). AI-script-to-part is **ALREADY-COVERED** by
  our agent (Anthropic+Ollama). NET-NEW *concepts* only: **declarative `.assy` YAML + mating + auto-BOM**
  and **git-versioned CAD packages**.
- **Verdict** — **T2, low fit. Design-inspiration only** — the `.assy`+BOM idea could inform Plastiq's
  assembly layer; do not adopt partcad as a dependency.

#### A4. voxel-editor — *paradigm mismatch*

- **What** — A small but **real, working** native Rust voxel editor (place/erase colored cubes,
  mouse-pick). Genuine workflow, but a dense-voxel paradigm orthogonal to parametric B-rep.
- **License** — **Apache-2.0** (`Cargo.toml`/`LICENSE`). Clean.
- **Model/workflow** — Dense `Vec<Vec<Vec<Voxel>>>` grid; **6-neighbor occlusion culling**
  (`visible() = neighbours != 6`); screen-**ray → work-plane/box pick** for add/erase; RON
  serialize. Native-only (no WASM), pinned to **stale forked iced/winit (~2020)** → not directly
  buildable. Evidence: `src/voxel_manager.rs:1-90`, `src/geometry.rs:91-315`.
- **Liftable** — The ray-pick + work-plane-selection + grid-cull *idea* is cleanly reimplementable in
  TS/three.js (~few hundred lines, **T1**). The crate itself is stale/native and not worth wholesale.
- **Verdict** — **T1 if ever, low priority.** NET-NEW (no voxel mode in Plastiq) but a new product
  direction, not a gap-fill. Keep as a ray-picking UX reference only.

### Group B — B-rep & CAD-specific ML

#### B1. BRepNet — ⭐ *the deterministic traversal substrate is the net-new structural find*

- **What** — Autodesk's topological message-passing CNN for **per-face segmentation directly on a
  B-rep** (CVPR 2021), operating on faces/edges/coedges via UV-grids + topological walks.
- **License** — **CC BY-NC-SA 4.0** (NonCommercial + ShareAlike). **Code unusable commercially** —
  any use is **clean-room reimplementation of the (uncopyrightable) algorithm in OCCT**, never a copy.
  Evidence: `ref/BRepNet/LICENSE`, README §License.
- **Model/workflow** — Two halves. (a) **ML-free OCCT featurizer** (`pipeline/extract_brepnet_data_from_step.py`,
  pure pythonocc + `occwl`, deterministic): per-face surface-type one-hots + area + a 7×10×10 **UV-grid**;
  per-edge **convexity via 5° dihedral-angle sign** + curve-type + length; per-coedge tangent grid +
  local frame; topology as **half-edge incidence arrays** `next`/`mate`/`face`/`edge`. (b) **ML conv**
  (`models/brepnet.py`): "kernel" files (e.g. `kernels/winged_edge_plus.json`) encode neighborhoods as
  **topological-walk instructions** over coedges → MLP. Input: one STEP solid. Output: per-face class.
- **Liftable** — The **network** is a trained dependency (ML, checkpoint, GPU) → **ALREADY-COVERED /
  rejected** (same family as ParseNet/HPNet/SED-Net already named in our research; ML-for-determinism
  already rejected; and NC license blocks it). The **featurizer + walk substrate is fully liftable and
  deterministic** — it's already OCCT, and **we have OCCT on both sides** (opencascade.js + pythonocc).
- **Verdict** — **NET-NEW: the deterministic, no-ML B-rep traversal primitive.** Verified against our
  code: `select/predicates.ts` stops at `topFace`/`largestPlanarFace`/`faceByNormal`/`verticalEdges`;
  we have `adjacentFaceNormals` (`mesh/normals.ts:126`) as a *seed* but **no** half-edge walk, no
  coedge traversal, no convex/concave classification, no tangent-connected face grouping.
  - **T2** (`services/reconstruct`) — half-edge adjacency + dihedral convexity to **steer the
    segment-then-fit pipeline**: group tangent-connected faces before fitting, flag fillets/holes,
    surface-type hints. Deterministic, fits NFR-2.
  - **T1** (`@plastiq/cad`) — power **"select tangent faces / select fillet chain / select convex
    edges"** selectors (a real authoring-UX gap). Reimplement `uvgrid`-sampling + the 5° dihedral test
    in TS/WASM.

#### B2. Graph-CAD — *text→CAD LLM; mis-suggestive name*

- **What** — **A text→CAD LLM** (ICLR 2026) that emits **Blender `bpy` code** via a 3-stage pipeline,
  using a hierarchical decomposition "graph" as a text IR. **Not a learned GNN, not over a B-rep.**
- **License** — **No LICENSE file → all rights reserved by default. Code not reusable; ideas only.**
- **Model/workflow** — 3 sequential LLM stages (Qwen3-8B + per-stage LoRA): instruction → decomposition
  **graph** (a serialized DSL: layered nodes with `Align/offset/polar/connect` constraints,
  `create_method=primitive/boolean/bevel/extrude`, `pattern=grid/polar`) → action sequence → `bpy`.
  GPU, non-deterministic. Evidence: `ref/Graph-CAD/prompt_sft/graph_prompt.txt`, `infer_api.py`.
- **Liftable** — Trained-model dependency; nothing standalone/deterministic. Only the **graph-DSL
  schema** is a transferable *concept*.
- **Verdict** — **T3, ALREADY-COVERED** (DeepCAD/Text2CAD family; targets Blender meshes, not our OCCT
  CadDocument). One honest sliver: **decomposition-graph-as-planning-IR** could inform our **agent
  orchestrator** — have `build_part` emit a hierarchical constraint graph *before* tool calls to cut
  long-horizon error. Idea-only (no license).

#### B3. NURBGen — *text→CAD LLM; does NO surface fitting (key correction)*

- **What** — **A text→CAD LLM** (AAAI 2026) emitting **NURBS surface parameters as JSON**, then
  OCCT-deserializing to STEP. The name suggests mesh→NURBS fitting; **it is not** — there is no
  point/mesh→surface fitting anywhere.
- **License** — **No LICENSE file → all rights reserved. Ideas only.** Weights/dataset HF-gated.
- **Model/workflow** — LLM (Qwen3-4B+LoRA, non-deterministic) text → JSON `BsplineParameters`
  (poles/knots/degrees) → `Geom_BSplineSurface` → `BRepBuilderAPI_MakeFace` → STEP. The only geometry-IN
  path (`shape_extraction.py`) needs an **existing B-rep** and just runs OCCT's built-in
  `BRepBuilderAPI_NurbsConvert`. Evidence: `ref/NURBGen/src/nurbs_representation/{model/Bspline.py,
  functions/reconstruct_shape.py,functions/shape_extraction.py}`.
- **Liftable** — **Explicitly NOT liftable into reconstruct's freeform stage** — it fits nothing. We
  already do freeform BSpline fitting + STEP export. Only novel piece: `normalize.py`'s NURBS-param→token
  compression (relevant only if we trained our own CAD LLM — out of scope).
- **Verdict** — **T3, ALREADY-COVERED.**

### Group C — Shape completion & 3D-GAN reconstruction

#### C1. shape-completion (DLR-RM) — ⭐ *the one modern, MIT, net-new completion path*

- **What** — Actively-maintained (2026-05) **research platform** hosting 30+ completion architectures
  (ONet, ConvONet, IF-Net, PCN, SnowflakeNet, a reimplemented **ShapeFormer/VQDIF**, latent diffusion).
  Use case: **partial depth image / partial point cloud → full watertight mesh** (robotic grasping).
- **License** — **MIT** (Copyright 2023-2026 Matthias Humt). The only repo here that is **modern AND
  commercially licensed**. Evidence: `ref/shape-completion/LICENSE`.
- **Model/workflow** — Input: partial `.ply` or depth `.png`+intrinsics (with plane-removal/clustering
  preprocessing). Output: **watertight mesh** via MISE marching cubes from a predicted occupancy/implicit
  field (adaptive resolution). Real `inference` CLI. Notably predicts **uncertain regions**
  (occupied/uncertain/free). Evidence: `README.md`, `docs/reproduction.md`.
- **Liftable** — **Heavyweight runnable dependency** (CUDA, PyTorch3D, custom C++ Chamfer/EMD/MISE) →
  server-only, **not** T1. It is the **MIT reference implementation of methods otherwise locked behind
  research-only repos** (ShapeFormer, VQDIF, ConvONet).
- **Verdict** — **T2 (separate optional GPU service), NET-NEW.** Concrete workflow: a **"Complete
  Scan / Fill Gaps"** action — user uploads a partial/holey mesh or depth scan, gets a watertight mesh,
  which then feeds reconstruct→B-rep. This is *completion of the user's existing input* — different from
  the creative path (mesh-from-scratch) and from reconstruct (assumes watertight in). **Caveats are
  real:** (a) **ships NO checkpoints** (`docs/reproduction.md:5`) → you must **train on ShapeNet
  yourself** (multi-GPU, days); (b) quality is **class-dependent** (good on trained categories, poor on
  arbitrary mechanical parts); (c) heavy GPU, non-deterministic → must be its *own* service, never
  inside the deterministic reconstruct. **Verdict: worth deeper evaluation, not build-now.**

#### C2. ShapeFormer — *good method, unusable repo*

- **What** — Official impl of **transformer shape completion via sparse VQDIF** (2022): partial point
  cloud → a *distribution* of full-shape completions.
- **License** — **NONE. README: "academic research use only." Not usable commercially as-is.**
- **Model/workflow** — VQDIF (VQ-VAE over an implicit field) + minGPT autoregressive transformer over
  the discrete codes → occupancy → marching-cubes mesh (64³). Pretrained checkpoint on HF. 2022-era
  stack (torch 1.7/CUDA 10.1, needs its Docker). Evidence: `ref/ShapeFormer/README.md:47,61,144`.
- **Liftable** — Method is liftable **but via C1** — DLR-RM `shape-completion` reimplements both
  ShapeFormer and VQDIF **under MIT**. Use that, not this repo.
- **Verdict** — **Avoid the repo (no license); the method is reachable via C1.**

#### C3. 3D-RecGAN — *superseded; dead stack*

- **What** — Single depth view → full **64³ occupancy voxel** via 3D-CNN autoencoder + WGAN-GP (ICCV-W
  2017).
- **License** — **MIT** (clean) — but irrelevant.
- **Model/workflow** — 64³ voxel in → 64³ voxel out, per-class. **Python 2.7 + TensorFlow 1.1.0** (both
  EOL; confirmed Py2 `print` at `main_3D-RecGAN.py:213`). 64³ is coarse/blocky; voxel→mesh needs
  marching cubes. No checkpoint shipped.
- **Verdict** — **DO NOT integrate. SUPERSEDED** by C1 (completion) and the cloud creative path
  (image→3D). Historical interest only.

#### C4. 3D-IWGAN — *superseded; dead stack*

- **What** — Improved-Wasserstein-GAN **32³ voxel** generation + image/Kinect→voxel variants (2017).
- **License** — **MIT** (clean) — but irrelevant.
- **Model/workflow** — 32³ occupancy (even coarser than C3), 200-d `z`, WGAN-GP, on **TensorFlow 1.x +
  abandoned `tensorlayer`**. No checkpoints. Evidence: `3D-Generation/32-3D-IWGan.py:29,53-60`.
- **Verdict** — **DO NOT integrate. SUPERSEDED** (generation → cloud path; Kinect-completion → weaker
  32³ version of C1).

#### C5. ABC-GAN — *off-topic (name confusion)*

- **What** — **NOT 3D/CAD.** "ABC" = **A**daptive **B**lur + **C**ontroller GAN — a 2017 ETH thesis on
  **2D image generation** (CelebA faces, CIFAR, LSUN bedrooms) on DCGAN. **Nothing to do with the ABC
  CAD dataset.** Evidence: `ref/ABC-GAN/README.md`.
- **License** — MIT — irrelevant.
- **Verdict** — **OFF-TOPIC. Drop from the reference set.** Pulled in by name-confusion with the ABC
  CAD dataset.

### Group D — Neural 3D / radiance fields / text→3D

#### D1. nerfstudio — *photogrammetry capture → mesh (external-tool handoff)*

- **What** — The de-facto modular **NeRF** framework: posed images/video → radiance field; `ns-export`
  meshes.
- **License** — **Apache-2.0** (clean, commercial-OK). Evidence: `ref/nerfstudio/LICENSE`.
- **Model/workflow** — Input: posed images/video (poses from COLMAP/Polycam/Record3D). **Native output
  is a density field**; `ns-export` does pointcloud / TSDF / **Poisson** / **marching-cubes** / gaussian-splat.
  A **mesh CAN be exported (PLY)** but is **organic and not guaranteed watertight** (README itself notes
  NeRFs aren't designed for point clouds). NVIDIA-GPU-only, **per-scene optimization** (minutes-to-tens).
  Evidence: `nerfstudio/scripts/exporter.py`, `nerfstudio/exporter/`.
- **Liftable** — **Heavyweight dependency** (Open3D/torch/CUDA + trained field); no liftable snippet.
  The value is the **workflow**, not a function.
- **Verdict** — **External-tool handoff (T2 stretch), NET-NEW.** The one new thread in this group:
  **real-object photos/video → mesh**, which the cloud creative path does *not* offer. Best framed as a
  *documented external capture step* → export PLY → import into reconstruct (it'd hit the
  faceted/freeform path). Honest caveat: GPU-only, per-scene, organic output → **weak for
  mechanical/parametric parts.** Too heavy to bundle as a managed provider.

#### D2. sdfstudio — *cleaner (watertight) photogrammetry meshes; stale base*

- **What** — Neural-implicit **surface** reconstruction on the nerfstudio base (UniSurf/VolSDF/NeuS/…):
  optimizes an **SDF** instead of density.
- **License** — **Apache-2.0** (clean). Evidence: `ref/sdfstudio/LICENSE`.
- **Model/workflow** — Posed images → SDF; `ns-extract-mesh` = marching cubes on the **zero level-set →
  watertight-by-construction PLY** (cleaner than D1's density mesh — and **watertight meshes feed our
  reconstruct→B-rep better**). NVIDIA-GPU, ~15 min/scene. **Caveat: unmaintained since 2023-09, vendors
  an old nerfstudio** → maintenance liability. Evidence: `scripts/extract_mesh.py`,
  `nerfstudio/utils/marching_cubes.py`.
- **Verdict** — **External-tool handoff (T2 stretch), NET-NEW (marginal over D1 but real for us:
  watertight output).** Prefer the SDF *output* if doing photogrammetry; treat the repo itself as a
  stale reference, not a dependency. Same organic-surface limit for mechanical parts.

#### D3. stable-dreamfusion — *superseded; do not build*

- **What** — Open impl of **DreamFusion**: text→3D via **Score Distillation Sampling** optimizing a
  NeRF/instant-ngp per prompt with a 2D diffusion prior.
- **License** — **Repo Apache-2.0**, but **inherits weight licenses** (Stable Diffusion = OpenRAIL-M;
  DeepFloyd-IF = HF-gated) and the **DreamFusion method is patent-adjacent (Google)** — external
  knowledge, flagged. Evidence: `ref/stable-dreamfusion/LICENSE`, README.
- **Model/workflow** — text (or image via Zero-1-to-3) → optimized NeRF; `--save_mesh` → OBJ+texture via
  marching cubes (+ optional DMTet). **Per-prompt optimization (tens-of-min to hours)** vs our
  feed-forward cloud (seconds-to-minutes). README **admits** "quality cannot match the paper, many
  prompts fail badly."
- **Verdict** — **T2 in principle; SUPERSEDED — DO NOT build.** A strictly-worse self-hosted text→3D
  than what we ship. Keep only as an SDS concept reference.

#### D4. forgent3d — ⚠️ *mis-batched: a CAD sibling, not a neural-3D repo*

- **What** — A **local AI-CAD desktop companion** (Electron) for **parametric code-CAD** with coding
  agents. **No NeRF/radiance/text→3D-mesh.** An architectural near-sibling of Plastiq.
- **License** — **MIT** (2026). Clean.
- **Model/workflow** — TS pnpm monorepo; CAD runtime = **Python `build123d` on OCP (pythonocc/OCCT)** —
  *the same kernel family Plastiq uses* — three.js viewer, **MJCF + optional MuJoCo** (we also have a
  MuJoCo sim backend). Agent edits `part.py`/`asm.xml` → **build runner** → STEP/BREP/STL/OBJ/GLB/3MF.
  Notable: a **warm `build123d`/OCP daemon** (`rebuild_daemon.py`) keeps OCP imported to avoid the
  ~2.2 s cold-import per rebuild. Evidence: `ref/forgent3d/packages/cad-runtime/python/{rebuild_daemon,
  export_runner}.py`.
- **Verdict** — **No generation tier; architectural reference.** Most directly comparable stack in the
  corpus. **Liftable idea: the warm-OCP rebuild-daemon pattern** — `services/reconstruct` could adopt a
  warm-process pool to cut OCCT/pythonocc cold-start (relevant to throughput). Also a reference for the
  agent↔geometry verify loop (rebuild → screenshot → bbox check).

#### D5. gaussian_gan_decoder — *reject (three independent disqualifiers)*

- **What** — Trains a decoder mapping a 3D-aware GAN's NeRF → **3D Gaussian Splats**, for **human
  faces/heads only** (PanoHead/EG3D/LPFF).
- **License** — **No top-level license; non-commercial research-only deps** (gaussian-splatting =
  INRIA/MPII non-commercial; EG3D = NVIDIA source license). **Hard commercial blocker.** Evidence:
  `ref/gaussian_gan_decoder/gaussian_splatting/LICENSE.md`, `PanoHead/LICENSES/`.
- **Model/workflow** — face latent → **Gaussian splats** (`.ply` of splats), faces only.
- **Verdict** — **REJECT.** (1) Domain = human heads only → zero CAD relevance; (2) **splats are a
  view-dependent radiance representation, NOT a mesh/surface** → cannot feed mesh→B-rep; (3)
  non-commercial license. Not something a parametric CAD tool wants.

### Group E — ML libraries & reference catalogs ("what could we lift")

#### E1. kornia — *narrow, niche lifts only*

- **What** — Differentiable CV library (PyTorch). For us only the **classical geometry** parts matter.
- **License** — **Apache-2.0** (clean, per-file headers). Evidence: `ref/kornia/LICENSE`.
- **Specifically liftable** —
  - `geometry/depth.py` → **`depth_to_normals` / `depth_to_3d`** (**T2**) — per-pixel normals from
    depth+intrinsics; simple to re-express in numpy. *Lowest-friction useful piece* (but Open3D also
    does normals → reference, not unique).
  - **Nister 5-point** (`epipolar/essential.py`), polynomial solvers (`solvers/polynomial_solver.py`),
    and **Kannala-Brandt fisheye** (`camera/distortion_kannala_brandt.py`) (**T2**) — the genuinely
    *hard-to-source* net-new pieces, but **only relevant if a photogrammetry/SfM front-end ever exists.**
  - Classical filters (Canny/Sobel/bilateral) (**T1**) — reference-only; the web platform already has these.
- **NOT a win** — PnP/homography/fundamental/triangulation/undistort/RANSAC are **OpenCV one-liners**;
  porting kornia's torch versions buys nothing. **Correction to a common assumption:** kornia has **NO
  ICP / Umeyama / point-cloud registration** (`geometry/pointcloud.py` is just PLY I/O) — that comes
  from Open3D/scipy.
- **Verdict** — **MIXED. No T1/T2 win lands today** because reconstruct ingests a *mesh*, not images;
  kornia's value is gated on a photogrammetry front-end Plastiq lacks. Bookmark `depth_to_normals` +
  the Nister/Kannala-Brandt solvers for if/when D1/D2-style capture is pursued.

#### E2. lab — *off-topic*

- **What** — **DeepMind Lab** — a Quake-III-based 3D **reinforcement-learning environment**. Not a
  generic "lab."
- **License** — **GPLv2 (copyleft)** — incompatible even if relevant. Evidence: `ref/lab/LICENSE`.
- **Verdict** — **OFF-TOPIC.** RL game engine; nothing for CAD.

#### E3. annotated_deep_learning_paper_implementations — *study reference; zero 3D*

- **What** — labml.ai's **annotated PyTorch** paper implementations (transformers, diffusion, GANs, RL).
- **License** — **MIT** (clean). Evidence: `ref/.../license`.
- **Liftable** — **Nothing CAD/3D.** Grep confirms **zero** point-cloud/mesh/NeRF/voxel/SDF content;
  the closest entry, `sketch_rnn`, is 2D pen-strokes. Clean diffusion/U-Net references exist but our T3
  uses hosted fal models → no code to port.
- **Verdict** — **Study-reference only; nothing to integrate.**

#### E4. the-gan-zoo — *a list, not code*

- **What** — A **markdown catalog** of GAN papers (README generated from `gans.tsv` via `update.py`).
- **License** — **MIT**. **No model/algorithm code whatsoever.**
- **Verdict** — **OFF-TOPIC / no integrable code.** Index only; mostly 2D image GANs.

---

## 2. Prioritized recommendation — what to actually do

Ranked by **(value × confidence) ÷ effort**, license-clean first.

| # | Action | Tier | License | Effort | Net-new? | Why |
|---|---|---|---|---|---|---|
| **1** | ✅ **SHIPPED** — Scaled-Chamfer-Distance fidelity metric (from StepForge's `step_to_pointcloud`+`scd_reward`; `alignment` stage skipped — same frame) in `services/reconstruct` (`app/fidelity.py`; `surface_deviation`/`fidelity_tol` on the report, surfaced in the convert UI; advisory not a gate — see `docs/adr/0001`) | T2 | **Apache-2.0** | **Low** (numpy/scipy/trimesh; no open3d) | **Yes** | *Surface*-level fidelity score; complements the volume-only + per-region-RMS gates. Lets reconstruct honestly report faithfulness. 12 pytest + 1 vitest. |
| **2** | ✅ **SHIPPED** — Clean-room deterministic B-rep traversal: face adjacency + 5° dihedral convexity over the tagged tessellation (`select/topology.ts`), **T1 selectors** `tangentFaces`/`filletChain`/`convexEdges`/`concaveEdges` (`select/predicates.ts`, wired through the worker + agent prompt), **T2 recognition** (`app/recognition.py` → `tangent_regions` on the report). SPEC-8 + ADR 0002. | T2 + T1 | **clean-room** (BRepNet = CC-BY-NC-SA; no source used) | **Med** | **Yes** | Real authoring-UX gap filled (we stopped at `faceByNormal`). 14 cad-select tests + 6 recognition pytest. |
| **3** | ✅ **SHIPPED** (M8) — **MLX shape completion** (`services/capture/` `/complete`): a conditional occupancy network (PointNet enc + occupancy dec) completes a partial scan → full watertight mesh → existing MeshDoc→reconstruct. Trains on the **M4 Max** (DLR-RM is CUDA-only → own MLX impl). | T2 | **MIT** | High | **Yes** | Completes the *user's* partial input (fills holes the scan never saw). Demo trains on synthetic spheres; general objects need ShapeNet training + a checkpoint (ADR 0008). 4 pytest incl. real MLX training that fills a missing hemisphere. |
| **4** | ✅ **SHIPPED** (M7) — **MLX neural-SDF capture service** (`services/capture/`): oriented point cloud → IGR Softplus SDF (MLX, trains on the **M4 Max**) → marching-cubes mesh → GLB → existing MeshDoc→reconstruct. FastAPI submit→poll. Not a CUDA nerfstudio port (won't run on Apple Silicon) — a self-contained MLX impl. | T2 | **Apache-2.0** | High | **Yes** | Real surface reconstruction from points/depth. SfM (photos→points) stays COLMAP's job (ADR 0007). 13 pytest (real MLX training on a sphere, ~6 s). SPEC-10 §capture. |
| **5** | ✅ **SHIPPED** (M6) — kornia `depth_to_normals`/`unproject_depth` + a pinhole camera, ported to numpy in `services/capture/app/geometry.py` (seeds the M7 capture path). Nister-5pt/Kannala-Brandt **deliberately deferred** (no consumer — pose is COLMAP/MLX's job; ADR 0006). | T2 | **Apache-2.0** | Low | partial→yes | The depth/point-cloud math the capture front-end (M7) needs. 6 pytest. |

**Design-inspiration (ideas, not code to integrate):**
- **partcad** — ✅ **SHIPPED** (M4): declarative `.assy` description + `realizeAssembly` + **auto-BOM** (`apps/plastiq/src/assembly/assy.ts` + `BomPanel.tsx`; own dependency-free JSON schema, not partcad's YAML/Python). SPEC-9 §assembly + ADR 0004; 11 tests. (Git-versioned CAD packages + multi-part geometry library remain future work.)
- **forgent3d** — **warm-OCP rebuild-daemon** pattern (MIT). ⚠️ *Evaluated → not applicable* (M3, [`docs/adr/0003`](docs/adr/0003-warm-ocp-pool.md)): the daemon solves cold-import for a per-rebuild CLI; `services/reconstruct` is a long-running server with module-level OCC imports, so OCC is already warm for the process lifetime and there is no per-request cold-import to remove. Kept as an agent↔geometry verify-loop reference only.
- **Graph-CAD** — ✅ **SHIPPED** (M5): **decomposition-graph planning-IR** — a `plan_part` tool the agent calls first for complex objects (validated nodes+relations graph via `ai/planning.ts`, recorded for the trace) before `build_part`. Own schema (Graph-CAD has no license → idea only). SPEC-9 §planning-ir + ADR 0005; 13 tests incl. a `runAgent` plan→build→answer orchestration.
- **CADmium** — **`truck`** (pure-Rust WASM B-rep kernel) evaluated (M9, [`docs/adr/0009`](docs/adr/0009-truck-kernel-eval.md)): license **verified Apache-2.0**, but **NO-GO** now — it lacks dress-ups / sketch-constraint solver / assemblies / IGES-glTF / persistent tagging that `@plastiq/cad` ships, and CADmium-on-truck is pre-MVP. Watch-list only; re-evaluate (with a real WASM-size prototype) if OCCT size/licensing ever blocks.
- **voxel-editor** — ✅ **core SHIPPED** (M10): the liftable algorithms — `VoxelGrid` (dense occupancy, 6-neighbour surface cull, voxels→mesh), DDA `rayVoxelHit` + work-plane pick (`apps/plastiq/src/voxel/`), and a `VoxelDoc` type whose mesh feeds reconstruct. SPEC-9 §voxel + ADR 0010; 14 tests. The full three.js editing UI/mode shell is deferred (low-priority new product direction; `VoxelDoc` not yet in `PersistedDoc`).

## 3. Do **not** pursue (with the reason, so it isn't re-litigated)

| Repo | Reason |
|---|---|
| **stable-dreamfusion** | SUPERSEDED — slow per-prompt SDS, README admits poor quality, vs our feed-forward cloud. |
| **3D-RecGAN** | SUPERSEDED — 64³ voxels, dead Py2.7/TF1.1 stack. |
| **3D-IWGAN** | SUPERSEDED — 32³ voxels, dead TF1/tensorlayer stack. |
| **gaussian_gan_decoder** | REJECT — faces-only domain + splats (not mesh) + non-commercial license. |
| **ShapeFormer (repo)** | No license / research-only — use the *method* via `shape-completion` (MIT) instead. |
| **NURBGen** | text→CAD LLM that does **no** surface fitting; not liftable into the freeform stage; no license. |
| **ABC-GAN** | OFF-TOPIC — 2D face/bedroom image GAN; name-confusion with the ABC CAD dataset. Drop from `ref/`. |
| **lab** | OFF-TOPIC — DeepMind Lab RL environment, GPLv2. |
| **annotated_deep_learning_paper_implementations** | Study reference only; zero 3D/geometry/CAD content. |
| **the-gan-zoo** | A markdown list; no integrable code. |
| **CADmium** | Elastic-2.0 (can't reuse code as a hosted service); inactive; sketch solver behind ours. Study-only. |

## 4. License ledger (load-bearing — verify before any code reuse)

| Repo | License | Code reuse for a hosted CAD product? |
|---|---|---|
| StepForge | **Apache-2.0** (LLM path adds Llama/Text2CAD terms) | ✅ metric yes; LLM path avoid |
| partcad | Apache-2.0 | ✅ |
| voxel-editor | Apache-2.0 | ✅ |
| kornia | Apache-2.0 | ✅ |
| nerfstudio | Apache-2.0 | ✅ |
| sdfstudio | Apache-2.0 | ✅ (but unmaintained) |
| stable-dreamfusion | Apache-2.0 + weight/patent baggage | ⚠️ encumbered |
| shape-completion | **MIT** | ✅ |
| 3D-RecGAN | MIT | ✅ (but dead/superseded) |
| 3D-IWGAN | MIT | ✅ (but dead/superseded) |
| ABC-GAN | MIT | ✅ (but off-topic) |
| forgent3d | **MIT** | ✅ |
| annotated_dl… | MIT | ✅ |
| the-gan-zoo | MIT | n/a (no code) |
| **BRepNet** | **CC BY-NC-SA 4.0** | ❌ code — **clean-room the algorithm only** |
| **lab** | **GPLv2** | ❌ copyleft |
| **CADmium** | **Elastic-2.0** | ❌ hosted-service clause |
| **Graph-CAD** | **none → all rights reserved** | ❌ ideas only |
| **NURBGen** | **none → all rights reserved** | ❌ ideas only |
| **ShapeFormer** | **none → research-only** | ❌ use method via shape-completion |
| **gaussian_gan_decoder** | **none + non-commercial deps** | ❌ |

## 5. Honest caveats & open questions

- **Anchored against prior work.** Plastiq's mesh→B-rep research already evaluated Point2CAD,
  ComplexGen, BrepGen, DeepCAD, P2CADNet, Point2Primitive and already named ParseNet/HPNet/SED-Net as
  the ML-segmentation escape-hatch, and already rejected ML-for-determinism (NFR-2). So "an ML B-rep
  segmenter could replace stage 1" is **not** a finding here — the BRepNet item is specifically the
  *deterministic, no-ML traversal substrate*, which is the net-new part.
- **shape-completion is the biggest "maybe."** It is the only modern+MIT path to a net-new capability,
  but it **ships no weights** — adopting it means a real training investment (multi-GPU ShapeNet) and
  accepting class-dependent quality. Verify checkpoint availability / fine-tuning feasibility before
  committing.
- **Photogrammetry quality on mechanical parts is unverified** and, per the NeRF/SDF nature, expected
  to be weak (organic surfaces → faceted/freeform path). Needs runtime data on real captures.
- **The named `ref/` set has stragglers.** `ABC-GAN` is off-topic (name confusion) and `forgent3d` was
  mis-grouped as neural-3D (it's a CAD sibling). `ref/` also contains repos **not** named in this task
  (CADAM, ai-engineering-from-scratch, awesome-* lists, Awesome-CoreML-Models, Awesome-Geospatial,
  awesome-self-supervised-learning) — **out of scope for this pass**; flag if you want them covered.
- **No code was changed.** This is an investigation; every "could integrate" above is a proposal with a
  tier, a license, and a net-new verdict — not an implementation.
