# SPEC-8 — Topological selection & feature recognition (clean-room B-rep traversal)

**Status:** Shipped (M2) · **Date:** 2026-06-22
**ADR:** [`docs/adr/0002-brepnet-cleanroom-traversal.md`](../adr/0002-brepnet-cleanroom-traversal.md)
**Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M2 · **Source idea:** BRepNet (CC-BY-NC-SA,
clean-room — algorithm only, no source used)

## 1. Goal

Give Plastiq a deterministic, no-ML **B-rep traversal substrate** — face adjacency + dihedral edge
convexity — and build two things on it: **topology-aware selectors** in the browser kernel (T1) and
**mesh-side feature recognition** in the reconstruction service (T2). This is the net-new, liftable
idea `Expanse.md` found in BRepNet; the ML segmentation network is out of scope (already-covered, and
NonCommercial-licensed).

## 2. The substrate (T1 — `packages/cad/src/select/topology.ts`)

Pure functions over the tagged tessellation (`TaggedMesh`: face groups + edges carrying their two
adjacent-face normals/ids/centroids — `mesh/tagged.ts`, with `TaggedEdge.faceIds` added in M2):

- **`edgeConvexity(mesh, edge) → "convex" | "concave" | "smooth"`** — from the LOCAL face normals at
  the edge (nearest-triangle normals, so curved fillet faces are handled) and the adjacent face
  centroids:
  - **smooth/tangent (G1)** when the faces are near-tangent at the edge (`na·nb ≥ cos 5°`) or it is a
    seam — fillets and blends;
  - **convex** when each face folds away from the other's interior (`na·(cb−m) < 0 ∧ nb·(ca−m) < 0`);
  - **concave** otherwise.
  Orientation-robust (centroids, not wire orientation), deterministic (NFR-2). Tangent detection on
  curved faces requires a curvature-resolving tessellation (fine angular deflection) — `resolveSelector`
  tessellates at `angularDeflection 0.1 rad`.
- **`faceAdjacency(mesh)`** — face id → neighbours, each tagged with the shared edge and its convexity.
- **`growTangentFaces(mesh, seedFaceId)`** — the tangent-continuous patch reachable from a seed across
  smooth edges (connected component).
- **`filletFaces(mesh)`** — curved faces that join a neighbour tangentially (the rounded blends).

## 3. Selectors (T1 — `packages/cad/src/select/predicates.ts`)

Added to the `Selector` union + `resolveSelector` + `isSelector`, so they flow through the existing
worker dress-up path (`apps/plastiq/src/worker/rebuild.ts` resolves a feature's `data.selector`) and
are documented to the AI agent (`apps/plastiq/src/ai/prompt.ts`):

| Selector | Result |
|---|---|
| `{ kind: "tangentFaces", seed: FaceRef }` | all faces tangent-connected to the seed face |
| `{ kind: "filletChain" }` | the fillet/blend faces |
| `{ kind: "convexEdges" }` / `{ kind: "concaveEdges" }` | edges by dihedral classification |

These compose with the prior selectors (`topFace`, `faceByNormal`, `verticalEdges`, …) and survive a
parametric rebuild (resolved fresh each rebuild, like all selectors — FR-14).

## 4. Recognition (T2 — `services/reconstruct/app/recognition.py`)

The same tangent-adjacency idea over a triangle mesh (trimesh face adjacency + dihedral angle →
connected components over smooth joins):

- **`group_tangent_regions(vertices, faces)`** — per-triangle tangent-region labels (deterministic).
- **`recognize(vertices, faces) → { tangent_regions, curved_regions }`** — the part's structural
  fingerprint. The pipeline reports **`tangent_regions`** on every `ReconstructionReport` (box → 6,
  cylinder → 3, organic blob → many) for honest UX (NFR-4). Curved-region detection flags non-planar
  patches. Hole/boss recovery stays with the CSG route (this recogniser does not claim it).

## 5. Determinism, license, tests

- **Deterministic** end to end (fixed 5°/20° thresholds, scipy connected-components, fixed traversal).
- **Clean-room:** implemented from the standard dihedral test and connected-component growth; BRepNet's
  source was not read or transcribed. No third-party code in the tree.
- **Tests:** `packages/cad/src/select/topology.unit.test.ts` (box convex / notch concave / fillet
  smooth / tangentFaces / filletChain / convex|concaveEdges, real OCCT); `services/reconstruct/tests/
  test_recognition.py` (box=6, cylinder=3 regions, curved detection, determinism, report field).

## 6. Report contract addition

`ReconstructionReport` (SPEC-7 §6) gains `tangent_regions: int` — the recognised tangent-region count
of the input mesh. Surfaced on the client `ReconstructReport` (optional, older-server compatible).
