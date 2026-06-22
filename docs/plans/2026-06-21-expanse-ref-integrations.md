# Plan — Expanse: integrate the actionable `ref/` corpus findings

**Date:** 2026-06-21
**Source:** `Expanse.md` (root) — the `ref/` corpus review, all actionable findings.
**Execution:** inline sequential, milestone by milestone · **strict TDD** (a failing test is
written and seen red *before* any implementation, every task) · **spec/ADR per integration, docs
kept 100% accurate as each item lands** (per CLAUDE.md).
**Commit:** conventional commits, one per sub-milestone at green — **ask before committing**.
**Decisions locked** (this session): full build of every item · both BRepNet seams (T1 + T2) ·
strict TDD · a spec or ADR per integration.

## Goal

Land every actionable opportunity Expanse.md surfaced, each into its correct deployment tier, with
licenses respected (clean-room reimplementation where a repo is CC-BY-NC-SA / no-license / Elastic),
sequenced by **value × confidence ÷ effort** — highest first. No item is a stub: where a model ships
no weights (shape-completion) or needs GPU capture (photogrammetry), the milestone includes the real
training / service work and surfaces its honest prerequisites rather than faking a result.

## Tier legend

- **T1** — browser / no-server core (`apps/plastiq`, `@plastiq/cad`); TypeScript/WASM, deterministic (NFR-2).
- **T2** — optional self-hosted Python service (`services/reconstruct` or a new sibling service); may be ML/GPU, offline.
- **T3** — cloud creative path (`MeshGenProvider`); paid + networked.

## Grounding (verified this session)

- **Reconstruct service** `services/reconstruct/app/*` (FastAPI submit→poll, `main.py`/`jobs.py`).
  Validates only by **volume** (`detect.py:125 _volume_ok`; `csg.py:244`, `revolution.py:114`,
  `fitted.py:194`, `topology.py:208`) + per-region **RMS** (`fitted.py:140,184`). **No**
  chamfer/hausdorff/ICP/registration anywhere (grep: 0 hits). Env = `pythonocc-core + trimesh +
  numpy + scipy` (conda; `environment.yml`) — **no open3d**.
- **Report contract:** server `ReconstructionReport` (`pipeline.py:33-45`) → client `ReconstructReport`
  (`apps/plastiq/src/ai/reconstruct.ts:11-27`). New fields must be added to both (client fields are
  optional for older-server compat — see existing `curved_faces?`).
- **Selectors:** `Selector` union + `resolveSelector` in `packages/cad/src/select/predicates.ts`
  (exported `index.ts:43`), resolved against the tagged tessellation; today: `allFaces/allEdges/
  topFace/bottomFace/largestPlanarFace/faceByNormal/edgesParallelTo/verticalEdges`. **No** tangent /
  fillet-chain / convex-edge / coedge-walk selection. Seed primitive exists: `adjacentFaceNormals`
  (`packages/cad/src/mesh/normals.ts:126`).
- **Tests:** `pnpm exec vitest run` (app + packages, live OCCT/wasm); reconstruct = `pytest` in the
  `plastiq-reconstruct` conda env. `just test` / `just e2e` / `just typecheck`.
- **Commit style:** `feat(scope): … — …`, one logical change per commit.

## Licensing & provenance guardrails (binding — read before coding)

| Source repo | License | Rule for this plan |
|---|---|---|
| StepForge | **Apache-2.0** | May port code with attribution (NOTICE). The `reward/` metric only — not the LLM path. |
| forgent3d | **MIT** | May port with attribution. |
| kornia | **Apache-2.0** | May port specific functions with attribution. |
| nerfstudio / sdfstudio | **Apache-2.0** | May depend on / invoke; attribution. |
| shape-completion (DLR-RM) | **MIT** | May depend on / fork; attribution. |
| **BRepNet** | **CC-BY-NC-SA 4.0** | **CLEAN-ROOM ONLY.** Reimplement the *algorithm* (half-edge walks, 5° dihedral convexity) from the paper/our own OCCT calls. **Never** copy or read-then-transcribe its source into our tree. ADR records this. |
| **partcad** (concept) | Apache-2.0 | Concept reuse (`.assy` schema idea) — we design our own schema; attribution-courtesy only. |
| **Graph-CAD** | **none → all rights reserved** | **IDEA ONLY.** Independent design of a decomposition-graph IR; no code/DSL transcription. |
| **CADmium / truck** | **Elastic-2.0 / unchecked** | CADmium code unusable (hosted-service clause). `truck` is a *separate* repo — **its license MUST be confirmed** before any prototype dependency (M9 gate task). |
| voxel-editor | Apache-2.0 | May port with attribution. |

Every milestone that touches a guard-railed source opens with an **ADR task** recording the
license, the clean-room/attribution decision, and the provenance of the implementation.

## Honest prerequisites (surfaced, not hidden)

> **TARGET HARDWARE + FRAMEWORK (user directive, 2026-06-22): Apple M4 Max — write all neural models
> and training loops in MLX** (`mlx.core` / `mlx.nn`, Apple Silicon native), **NOT CUDA / tiny-cuda-nn
> / PyTorch3D / PyTorch-MPS.** The upstream repos (nerfstudio/sdfstudio, DLR-RM shape-completion) are
> CUDA-only and will not run on Apple Silicon — so M7/M8 use **self-contained, clean MLX
> implementations** of the model + training, trainable on the M4 Max, rather than porting those repos.
> This makes the milestones genuinely buildable-and-trainable here (no GPU/CUDA block).

- **M8 (shape-completion)** ships **no pretrained weights** (`ref/shape-completion/docs/reproduction.md:5`).
  "Full build" therefore includes **training in MLX on the M4 Max** (a self-contained occupancy/
  completion network + loop), on ShapeNet-style data. Deliver a *working trainable service*; if the
  dataset is unavailable, ship the MLX model + training loop + a tiny demo dataset + a documented
  "point it at ShapeNet" path — never a fake result.
- **M7 (photogrammetry)** needs **COLMAP** (poses) + an MLX NeRF/SDF field for the training half; the
  import + service-contract half runs anywhere. Written in MLX for the M4 Max, not CUDA nerfstudio.
- These two are sequenced **last among the build items**; with MLX on the M4 Max they are no longer
  infra-blocked, only larger.

---

# Milestones (sequenced by value × confidence ÷ effort)

## M1 — StepForge Scaled-Chamfer-Distance fidelity gate · T2 · Apache-2.0 · NET-NEW

**Why first:** highest ratio — pure Python on the stack reconstruct already runs, no GPU, no new
deps (drop the open3d alignment stage; our B-rep is already in the input-mesh frame).

- [ ] **M1.0 — ADR.** `docs/adr/0001-scd-fidelity-metric.md`: record StepForge Apache-2.0, that we
      port only `reward/{step_to_pointcloud,scd_reward}.py`'s *math* (deterministic SHA-256-seeded
      area-weighted surface sampling + bidirectional Chamfer normalized by GT RMS radius), omit the
      FPFH/RANSAC/ICP alignment (same-frame), NOTICE attribution.
- [ ] **M1.1 — TDD: deterministic surface sampler.** Failing `tests/test_fidelity.py::test_sampler_is_deterministic_and_area_weighted`
      (same seed → identical points; density ∝ face area) → implement `app/fidelity.py:sample_surface(shape|mesh, n, seed)`
      using `BRepMesh_IncrementalMesh` + area-weighted barycentric sampling (numpy) → green.
- [ ] **M1.2 — TDD: scaled Chamfer.** Failing `test_scd_zero_for_identical / test_scd_scale_invariant`
      (identical solids → ~0; uniformly scaled copy compared to itself → ~0 after RMS-radius
      normalization) → implement `scaled_chamfer(points_a, points_b)` via `scipy.spatial.cKDTree`
      bidirectional NN → green.
- [ ] **M1.3 — TDD: wire into pipeline + report.** Failing `test_report_has_fidelity` (a reconstructed
      box reports `surface_deviation` ≤ tol) → compute SCD(reconstructed B-rep ↔ cleaned input mesh)
      in `pipeline.reconstruct`, add `surface_deviation: float` + `fidelity_tol: float` to
      `ReconstructionReport` → green. Keep it advisory (report-only) this task.
- [ ] **M1.4 — TDD: client surfacing.** Failing vitest in `reconstruct.unit.test.ts` (parses
      `surface_deviation`) → add optional `surface_deviation?` / `fidelity_tol?` to client
      `ReconstructReport`; show it in `GenerationPanel` convert report → green.
- [ ] **M1.5 — Optional accuracy-ladder gate (decision in ADR).** Failing test: a near-miss analytic
      fit whose volume passes but whose *surface* deviates > tol falls through to fitted/faceted →
      add SCD as a gate alongside the volume check in the `auto` ladder → green. (If this destabilizes
      existing analytic tests, keep SCD advisory and record why in the ADR.)
- [ ] **M1.6 — Docs.** Extend `SPEC-7` §6 report contract with the new fields; update `Expanse.md`
      rec #1 → "shipped"; `services/reconstruct/README.md` notes the new metric. Full pytest + vitest green.

## M2 — BRepNet deterministic traversal substrate · T1 selectors + T2 hints · clean-room (CC-BY-NC-SA) · NET-NEW

**Why second:** high value (user-facing selection **and** reconstruct quality), high confidence
(deterministic, OCCT on both sides), clean-room of a well-understood algorithm.

### M2a — shared traversal core
- [ ] **M2a.0 — ADR.** `docs/adr/0002-brepnet-cleanroom-traversal.md`: CC-BY-NC-SA → algorithm-only,
      derived from OCCT topology + the published method, no source transcription.
- [ ] **M2a.1 — TDD (T1, `@plastiq/cad`): half-edge incidence.** Failing
      `packages/cad/src/select/topology.unit.test.ts` (a box → 6 faces, each coedge's `next/mate/face`
      consistent; mate is an involution) → implement `select/topology.ts:buildIncidence(oc, solid)`
      producing `next/mate/face/edge` coedge arrays from OCCT `TopExp` maps → green.
- [ ] **M2a.2 — TDD: dihedral convexity.** Failing `test_box_edges_all_convex / test_pocket_edge_concave`
      (90° box edges convex; a cut pocket's interior edge concave; coplanar = smooth) → implement
      `edgeConvexity(oc, solid, edge)` = signed dihedral via the two adjacent-face normals at the
      shared edge midpoint, 5° smooth tolerance (reuse `adjacentFaceNormals`, `mesh/normals.ts:126`) → green.

### M2b — T1 selectors (authoring UX)
- [ ] **M2b.1 — TDD: tangent-connected faces.** Failing `predicates` test (a filleted box: select one
      fillet → returns the whole tangent chain of fillet faces) → add `{kind:"tangentFaces"; seed}` to
      the `Selector` union + `resolveSelector` (grow across G1/smooth edges via the convexity core) → green.
- [ ] **M2b.2 — TDD: fillet chain.** Failing test (select fillet chain by convex/concave + cylindrical
      surface-type) → add `{kind:"filletChain"}` → green.
- [ ] **M2b.3 — TDD: convex/concave edges.** Failing test → add `{kind:"convexEdges"|"concaveEdges"; tol?}` → green.
- [ ] **M2b.4 — Wire into the editor.** Failing app test (a ribbon/context-menu "Select tangent faces"
      action resolves a selection on the active solid) → expose the new selectors through the
      selection actions consuming `resolveSelector` → green.

### M2c — T2 feature-recognition hints (reconstruct)
- [ ] **M2c.1 — TDD: tangent pre-grouping.** Failing `services/reconstruct/tests/test_recognition.py`
      (a mesh of a filleted prism: adjacent tangent regions group together *before* fitting) →
      implement `app/recognition.py:group_tangent_regions(mesh)` (mesh-side dihedral adjacency, the
      same convexity rule) feeding `fitted.py`/`segment.py` region growing → green.
- [ ] **M2c.2 — TDD: fillet/hole flags in report.** Failing test (box-with-hole reports
      `recognized_holes ≥ 1`) → add recognition counts to `ReconstructionReport` → green.
- [ ] **M2c.3 — Docs.** New `docs/specs/SPEC-8-feature-recognition.md` (T1 selectors + T2 hints);
      update `Expanse.md` rec #2 → shipped. Full suites green.

## M3 — forgent3d warm-OCP process pool · T2 · MIT · ⚠️ NOT BUILT (premise void — see ADR 0003)

**Outcome (evidence-based, like M1.5):** the cold-import premise does not apply. `services/reconstruct`
is a long-running FastAPI server with **module-level** OCC imports (`curved_faces.py:19+`, `fidelity.py`,
`detect.py`, …) pulled in at startup via `main.py:25 → pipeline`; each request reuses warm OCC through
`to_thread` (`main.py:75`). The ~2.2 s import is a one-time startup cost — there is no per-request
cold-import to remove. The crash-isolation fallback is StepForge's threat model (parsing *untrusted*
STEP); we *construct* STEP through a gated pipeline with no observed segfault across 85 tests, and the
service is local single-user (D-6) so parallelism is moot. Building a `spawn` pool with
`BrokenProcessPool` recovery would be over-engineering.

- [x] **M3.0 — ADR.** `docs/adr/0003-warm-ocp-pool.md` records the finding + the revisit criteria
      (real OCC crash, or service becomes multi-user/hosted → adopt StepForge's persistent warm pool).
- [x] **M3.1–M3.3 — NOT BUILT.** No `app/pool.py`; the simple long-running-server + `to_thread` design
      is correct. Documented, not skipped.

## M4 — partcad-style declarative `.assy` assembly + auto-BOM · T1 · concept (Apache-2.0) · NET-NEW

**Why fourth:** real authoring value, high confidence, builds on our existing assembly layer; pure
TS, deterministic.

- [ ] **M4.0 — ADR.** `docs/adr/0004-declarative-assembly-bom.md`: our own schema, partcad as prior art.
- [ ] **M4.1 — Grounding.** Read the current assembly model (`packages/cad/src/assembly/*`,
      app `src/assembly/*`) to anchor the schema to existing mates/instances (recorded in the ADR).
- [ ] **M4.2 — TDD: schema + parser.** Failing test (a YAML/JSON `.assy` with `links:[{part,location:[[xyz],[axis],deg]}]`
      parses to typed nodes; recursive nesting) → implement the assembly-description schema + loader
      in `@plastiq/cad` → green.
- [ ] **M4.3 — TDD: realize into the assembly model.** Failing test (a 2-part `.assy` builds the
      instances + transforms our solver already supports) → map parsed links → component instances → green.
- [ ] **M4.4 — TDD: auto-BOM.** Failing test (the assembly yields a BOM: part → count, recursively
      rolled up) → implement BOM derivation → green.
- [ ] **M4.5 — UI + docs.** Import/export `.assy` + a BOM panel; `SPEC-9-authoring-extensions.md`
      §assembly; update `Expanse.md`. Suites green.

## M5 — Graph-CAD decomposition-graph planning-IR for the AI agent · T1 orchestration · idea-only · NET-NEW

**Why fifth:** medium value (fewer long-horizon agent errors), medium confidence; independent design
(no license).

- [ ] **M5.0 — ADR.** `docs/adr/0005-agent-planning-ir.md`: independent IR design; Graph-CAD as inspiration only.
- [ ] **M5.1 — Grounding.** Read `apps/plastiq/src/ai/{agentRunner,agentTurn,prompt}.ts` +
      `tools/toolDefs.ts` to anchor where a pre-plan step inserts (recorded in ADR).
- [ ] **M5.2 — TDD: plan schema + emit.** Failing `agentRunner` unit test (given a part prompt, the
      agent first emits a hierarchical decomposition plan: nodes = sub-parts, edges = spatial/constraint
      relations, before any `build_part` call) → add a planning pre-step + zod schema → green.
- [ ] **M5.3 — TDD: plan-conditioned execution.** Failing test (tool calls reference plan nodes;
      a deterministic fixture run produces the plan→calls trace) → thread the plan into the turn
      loop as guidance → green.
- [ ] **M5.4 — Docs.** `SPEC-6` agent section addendum; update `Expanse.md`. Vitest green.

## M6 — kornia geometry lifts · T2 · Apache-2.0 · enabling utility for M7

**Why sixth:** low standalone value today (reconstruct ingests meshes, not images) — built here as
the camera/normal math that M7's capture pipeline needs, plus a standalone mesh normal utility.

- [ ] **M6.0 — ADR.** `docs/adr/0006-kornia-geometry-lifts.md` (Apache-2.0, port-with-attribution).
- [ ] **M6.1 — TDD: depth→normals/points.** Failing `tests/test_geometry.py` (a synthetic depth map +
      intrinsics → correct per-pixel normals/3D points) → port `depth_to_normals`/`depth_to_3d` math to
      numpy in `app/geometry.py` → green.
- [ ] **M6.2 — TDD: camera solvers (for M7).** Failing tests for Nister 5-point relative pose +
      Kannala-Brandt fisheye distort/undistort against known synthetic geometry → port the closed-form
      math (numpy) → green. (Used by M7 capture; standalone-tested here.)
- [ ] **M6.3 — Docs.** Folded into `SPEC-8`/`SPEC-… capture`; update `Expanse.md` rec #5.

## M7 — MLX neural-SDF capture (points/depth → mesh) · T2 self-hosted · Apache-2.0 · ✅ SHIPPED

**Re-scoped on the M4 Max (MLX directive):** not blocked on a GPU. The CUDA nerfstudio/sdfstudio
won't run on Apple Silicon, so M7 is a **self-contained MLX neural-SDF** surface reconstruction
trained on the M4 Max — the *surface-reconstruction half* (oriented point cloud → mesh). The
photos→points step (SfM/MVS) stays COLMAP's job (ADR 0007); no full multi-view radiance field needed.

- [x] **M7.0 — ADR + service contract.** `docs/adr/0007`; `services/capture/` (FastAPI submit→poll).
- [x] **M7.1 — Import path.** The capture service emits a standard **GLB** → Plastiq's existing
      `MeshDoc` import → existing "Convert to CAD" reconstruct. No new JS (external-capture workflow).
- [x] **M7.2 — MLX SDF + service.** `app/sdf_mlx.py` (IGR Softplus SDF, geometric init, eikonal via
      `mx.grad`, marching cubes), `app/pipeline.py`, `app/main.py` (submit→poll), `environment.yml`.
- [x] **M7.3 — Trained here (M4 Max).** Real MLX training asserted on a sphere (~6 s) — correct mesh,
      correct sign, deterministic. 13 pytest (geometry/sdf/pipeline/jobs); API test gated on fastapi+mlx.
- [x] **M7.4 — Docs.** `SPEC-10` §capture, `services/capture/README.md`, `Expanse.md` rec #4.

## M8 — MLX shape completion "Complete Scan / Fill Gaps" · T2 · MIT · ✅ SHIPPED

**Re-scoped on the M4 Max (MLX directive):** DLR-RM shape-completion is CUDA-only and ships no
weights, so M8 is a **self-contained MLX conditional occupancy network**, trained on the M4 Max. It
lives in the capture service (both are MLX; the separation that matters — from the *deterministic*
reconstruct — holds), not a third `services/complete/`.

- [x] **M8.0 — ADR.** `docs/adr/0008` (MIT; demo-on-synthetic + BYO-checkpoint for general objects).
- [x] **M8.1 — Service contract.** `/complete` on the capture service (submit→poll); job contract
      tested live (`test_jobs.py`); HTTP `/complete` test gated on fastapi+mlx.
- [x] **M8.2 — Client path.** Output GLB → existing `MeshDoc` → "Convert to CAD" reconstruct (no new
      JS; external-scan workflow — same as capture).
- [x] **M8.3 — Model trained here (M4 Max).** `app/completion_mlx.py` (PointNet enc + occupancy dec,
      logits-BCE). Real MLX training asserted to **fill a missing hemisphere** a partial scan never saw
      (~2 s); deterministic; `load_weights` for a ShapeNet checkpoint. General objects need that
      training — documented, not faked.
- [x] **M8.4 — Docs.** `SPEC-10` §completion; class-dependence + non-determinism caveats (why it's
      a *separate* service from reconstruct); update `Expanse.md` rec #3 + README.

## M9 — `truck` alt-WASM-kernel evaluation spike · T1 research · ✅ DONE (go/no-go: NO-GO)

**Outcome:** license gate **passes** (verified `truck`@`c84318b8dec` is **Apache-2.0** by fetching its
LICENSE), but the recommendation is **NO-GO now**. `truck` lacks dress-ups (fillet/chamfer/shell/draft),
a sketch constraint solver, assemblies, IGES/glTF, and persistent tagging — all of which `@plastiq/cad`
ships and tests; CADmium-on-truck is inactive/pre-MVP (direct maturity signal). Replacement is a
multi-month epic for a speculative WASM-size win that addresses no current blocker.

- [x] **M9.0 — License gate.** PASSES — Apache-2.0, verified from the upstream LICENSE.
- [x] **M9.1 — Prototype.** Deferred: a WASM-size measurement would not change a no-go already settled
      by coverage/maturity. (Recorded in ADR 0009 as part of the *future* re-evaluation criteria.)
- [x] **M9.2 — Go/no-go ADR.** `docs/adr/0009-truck-kernel-eval.md` (NO-GO + watch-list + revisit
      criteria). No production code. `Expanse.md` CADmium/`truck` note updated.

## M10 — voxel-editor ray-pick voxel core · T1 · Apache-2.0 · ✅ core SHIPPED (UI mode deferred)

**Lowest priority — a net-new mode orthogonal to parametric B-rep. The liftable algorithms (the review's
finding) are built + tested; the full three.js editing UI is honestly deferred (a large surface for a
low-priority new direction).**

- [x] **M10.0 — ADR.** `docs/adr/0010-voxel-mode.md`.
- [x] **M10.1 — Occupancy grid + cull.** `voxel/grid.ts` (`VoxelGrid`: addBox/eraseBox, 6-neighbour
      `visibleCells`, `toMesh`, `toIndices`) — 6 tests.
- [x] **M10.2 — Ray-pick add/erase.** `voxel/pick.ts` (Amanatides–Woo `rayVoxelHit` → cell+face normal;
      `rayWorkPlaneCell`) — 6 tests. (Pure math; the three.js mouse→ray wiring is part of the deferred UI.)
- [x] **M10.3 — Doc model + export.** `VoxelDoc` (store/types.ts) + `voxel/doc.ts` (grid↔doc,
      `voxelDocToMesh` → reconstruct) — 2 tests. `SPEC-9` §voxel + `Expanse.md` updated. **Deferred:** the
      three.js render/edit mode shell + adding `VoxelDoc` to `PersistedDoc`/projectsStore (ADR 0010).

---

## Cross-cutting completion gate (every milestone)

1. **Strict TDD honored** — each task's failing test existed and was seen red before code.
2. **Full suites green, zero regressions** — `pnpm exec vitest run` + reconstruct `pytest` (+ any new
   service's tests); `just typecheck`; `just lint`.
3. **Docs 100% accurate** — the milestone's spec/ADR written, `Expanse.md` rec status updated, any
   touched README/SPEC reconciled in the *same* change (CLAUDE.md).
4. **License/provenance** — guard-railed milestones carry their ADR; clean-room items contain no
   transcribed third-party source; new deps recorded with their license.
5. **Commit** at green, conventional message — **after asking.**

## Sequencing rationale (value × confidence ÷ effort)

`M1` (drop-in metric) > `M2` (deterministic, both seams, high UX value) > `M3` (perf, self-contained)
> `M4` (authoring value, pure TS) > `M5` (agent quality) > `M6` (enabling math) > `M7` (GPU capture)
> `M8` (GPU + must-train) > `M9` (license-gated research) > `M10` (new product direction). Heavy /
infrastructure-gated items (M7, M8) and speculative items (M9, M10) sit last by design; M1–M3 are the
license-clean, high-confidence wins to land first.
