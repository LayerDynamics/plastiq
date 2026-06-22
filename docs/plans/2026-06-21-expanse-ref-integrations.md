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

- **M8 (shape-completion)** ships **no pretrained weights** (`ref/shape-completion/docs/reproduction.md:5`).
  "Full build" therefore includes **training on ShapeNet** — needs **multi-GPU + CUDA + the ShapeNet
  dataset (license acceptance)** and days of compute the local box may not have. The milestone is
  written to deliver a *working trained service*; if GPU/dataset access is unavailable, its gate task
  blocks and we ship the service skeleton + a documented "bring your own checkpoint" path rather than
  a fake result.
- **M7 (photogrammetry)** needs an **NVIDIA GPU + COLMAP** for capture→pose→train. Same honesty: the
  import + service-contract half runs anywhere; the actual NeRF/SDF training half needs the GPU box.
- These two are sequenced **last among the build items** precisely because their confidence is
  gated on infrastructure we must confirm.

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

## M3 — forgent3d warm-OCP process pool · T2 perf · MIT · NET-NEW (throughput)

**Why third:** removes the ~2.2 s pythonOCC cold-import per request; high confidence, MIT,
self-contained; also speeds M8/M7 service ergonomics.

- [ ] **M3.0 — ADR.** `docs/adr/0003-warm-ocp-pool.md` (MIT, attribution; pattern, not code copy).
- [ ] **M3.1 — TDD: warm worker.** Failing `tests/test_pool.py::test_worker_reuses_imported_occ`
      (two sequential jobs in one worker import OCC once; a malformed-STEP job that SIGSEGVs is
      isolated and the pool recovers) → implement `app/pool.py`: a `multiprocessing` spawn pool of
      pre-warmed workers (OCC imported at boot), job dispatch, crash-restart → green.
- [ ] **M3.2 — TDD: wire `jobs.py`.** Failing test (submit→poll still returns correct STEP, now via
      the pool) → route `jobs.py` through the pool, preserving the existing API contract → green.
- [ ] **M3.3 — Bench + docs.** Record cold-start delta in `README.md`; update Docker notes (R6.8).
      Full pytest green, no API change.

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

## M7 — Photogrammetry capture (nerfstudio / sdfstudio) → mesh import · T2 self-hosted · Apache-2.0 · NET-NEW

**Honest prerequisite: NVIDIA GPU + COLMAP for the training half.** Built as a *self-hosted capture
service* + an import path; SDF (sdfstudio) preferred for watertight output that feeds reconstruct.

- [ ] **M7.0 — ADR + service contract.** `docs/adr/0007-photogrammetry-capture.md`; a new sibling
      service `services/capture/` (FastAPI submit→poll, mirroring reconstruct's shape) — contract first.
- [ ] **M7.1 — TDD: import path (no GPU).** Failing `mesh/importPly`/glb test (a NeRF/SDF-exported PLY
      mesh imports as a `MeshDoc`, then routes into the existing reconstruct→B-rep path) → implement the
      PLY import + handoff → green. *This half runs anywhere.*
- [ ] **M7.2 — TDD: capture-service contract.** Failing service test (submit posed-images job → poll →
      returns a mesh URL; mocked trainer) → implement `services/capture/app/*` wrapping
      `ns-process-data`/`ns-train`/`ns-extract-mesh` (sdfstudio) behind the API → green.
- [ ] **M7.3 — GPU integration (gated).** With a GPU box: a real photos→SDF→watertight-mesh run on a
      fixture object, asserted watertight, fed to reconstruct. **If no GPU is available, this task
      blocks**; we ship M7.1–M7.2 + a documented "run sdfstudio yourself, import the PLY" workflow and
      mark the GPU task explicitly pending (no fake pass).
- [ ] **M7.4 — Docs.** `docs/specs/SPEC-10-capture-and-completion.md` (capture half); honest
      organic-vs-mechanical caveat; update `Expanse.md` rec #4 + README.

## M8 — shape-completion "Complete Scan / Fill Gaps" · T2 GPU service · MIT · NET-NEW

**Honest prerequisite: ships NO weights → requires training on ShapeNet (multi-GPU + dataset
license).** Lowest confidence × highest effort → built last among capability items.

- [ ] **M8.0 — ADR + dataset/GPU gate.** `docs/adr/0008-shape-completion-service.md`: MIT; record the
      training requirement and **confirm GPU + ShapeNet access**. If unavailable, scope drops to
      "service skeleton + bring-your-own-checkpoint" (documented, not faked).
- [ ] **M8.1 — TDD: service contract (no GPU).** Failing service test (submit a partial mesh →
      poll → completed-mesh URL; mocked model) → implement `services/complete/app/*` (separate service;
      **never** inside deterministic reconstruct) → green.
- [ ] **M8.2 — TDD: client "Complete Scan / Fill Gaps" action.** Failing vitest (a partial `MeshDoc`
      submits to the completion service, receives a watertight mesh, which then offers "Convert to CAD")
      → implement the client + UI → green.
- [ ] **M8.3 — Model integration (gated).** Fork/depend on DLR-RM `shape-completion`; wire its
      `inference` CLI behind M8.1's API. **Train** (ConvONet/IF-Net on ShapeNet) **or** load a
      user-supplied checkpoint. With weights present: a partial-scan fixture → asserted watertight
      completion. **No weights/GPU → this task blocks**; ship skeleton + BYO-checkpoint docs, task
      explicitly pending.
- [ ] **M8.4 — Docs.** `SPEC-10` completion half; class-dependence + non-determinism caveats (why it's
      a *separate* service from reconstruct); update `Expanse.md` rec #3 + README.

## M9 — `truck` alt-WASM-kernel evaluation spike · T1 research · license-gated · SPECULATIVE

**Scope is honestly a feasibility spike + prototype, not an OCCT replacement** (that is its own epic).

- [ ] **M9.0 — License gate (hard stop).** Confirm `truck`'s actual license (separate repo from
      CADmium/Elastic-2.0). **If non-permissive, stop here and record the finding** in
      `docs/adr/0009-truck-kernel-eval.md`. CADmium's own code stays unusable (hosted-service clause).
- [ ] **M9.1 — Prototype (if license clears).** A throwaway branch: compile a minimal `truck`
      WASM build, extrude one profile, measure WASM size vs our trimmed OCCT (~5.6 MB gz) and feature
      coverage gaps.
- [ ] **M9.2 — Go/no-go ADR.** Record size/coverage/risk vs OCCT; recommendation. No production code
      this milestone. Update `Expanse.md`.

## M10 — voxel-editor ray-pick voxel-editing mode · T1 · Apache-2.0 · NET-NEW (new product direction)

**Lowest priority — a net-new mode orthogonal to parametric B-rep; included because "all", scoped honestly.**

- [ ] **M10.0 — ADR.** `docs/adr/0010-voxel-mode.md` (Apache-2.0; net-new mode, opt-in).
- [ ] **M10.1 — TDD: occupancy grid + cull.** Failing test (dense grid; 6-neighbor visibility cull:
      fully-enclosed cells hidden) → implement a TS occupancy grid + surface extraction → green.
- [ ] **M10.2 — TDD: ray-pick add/erase.** Failing test (screen ray → work-plane/box intersection →
      add/erase region) → implement picking over three.js → green.
- [ ] **M10.3 — Mode shell + export.** A `VoxelDoc` mode (gated like `MeshDoc`), voxels→mesh export
      into the existing reconstruct path; `SPEC-9` §voxel; update `Expanse.md`. Suites green.

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
