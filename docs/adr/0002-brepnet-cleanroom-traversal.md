# ADR 0002 — Clean-room B-rep traversal substrate (topological selection + feature-recognition)

**Status:** Accepted · **Date:** 2026-06-22 · **Plan:** `docs/plans/2026-06-21-expanse-ref-integrations.md` §M2
**Tier:** T1 (`@plastiq/cad` selectors) + T2 (`services/reconstruct` recognition)

## Context

`Expanse.md` identified BRepNet's deterministic, no-ML **B-rep traversal substrate** — face/edge
adjacency over coedges plus **dihedral-angle edge convexity** — as the one genuinely net-new,
liftable idea in that repo (the ML segmentation network itself is already-covered/rejected). Today
`@plastiq/cad`'s selectors (`select/predicates.ts`) stop at `faceByNormal` / `verticalEdges` /
`largestPlanarFace`; there is **no** tangent-face, fillet-chain, or convex/concave-edge selection.
The seed primitive exists (`mesh/normals.ts:126 adjacentFaceNormals`, an edge's two adjacent-face
normals) but is not assembled into an adjacency graph.

## Decision

Implement the traversal substrate **clean-room** and use it for two things: T1 editor selectors and
T2 reconstruction feature-recognition.

- **License / provenance — clean-room (binding).** BRepNet is **CC-BY-NC-SA 4.0**
  (`ref/BRepNet/LICENSE`) — NonCommercial, so its *code* is unusable in Plastiq. The *algorithm*
  (topological adjacency + dihedral convexity) is standard CAD geometry and not copyrightable. This
  substrate is written **from first principles**, from OCCT topology and the standard dihedral test —
  **BRepNet's source is not read, transcribed, or adapted.** No StepForge-style code port here.
- **Built over the tagged tessellation, not raw OCC coedge walks.** The kernel already computes
  edge→adjacent-face incidence at tessellation time via
  `TopExp.MapShapesAndAncestors(shape, EDGE, FACE)` and `adjacentFaceNormals` (`mesh/tessellate.ts:144-173`).
  `predicates.ts` already resolves selectors over that `tessellateTagged` output (face groups +
  edges carrying their two adjacent-face normals). We extend that substrate rather than introducing a
  second, parallel OCC topology walk: simpler, deterministic, and consistent with the existing
  selector architecture. This is the equivalent of BRepNet's incidence arrays adapted to our tagged
  tessellation — same information (which faces an edge joins, and how), different container.
- **One additive field.** `TaggedEdge` gains `faceIds: [number, number]` — the two adjacent face-group
  ids (aligned with the existing `faceNormals` order), so a selector can reach each adjacent face's
  normal *and* centroid. Additive; `EdgeRef` resolution (`mesh/resolve.ts`) is unaffected.
- **Convexity test (deterministic).** An edge's convexity is classified from its two adjacent face
  normals `(na, nb)`, the two face centroids `(ca, cb)`, and the edge midpoint `M`:
  - **smooth / tangent (G1)** when `|na·nb| ≥ cos(ε)` (the dihedral is ~flat) — fillets and blends;
  - **convex** when the faces fold *away* from each other's interior: `na·(cb−M) < 0` and `nb·(ca−M) < 0`;
  - **concave** otherwise (faces fold *toward* the material).
  Orientation-robust (uses centroids, not wire orientation) and deterministic (NFR-2). Validated on a
  box (all convex), a cut pocket (interior edges concave), and a filleted box (blend edges smooth).
- **T1 selectors:** `tangentFaces` (grow a face region across smooth edges), `filletChain`
  (tangent-connected *curved* faces — the blends), `convexEdges` / `concaveEdges`. Added to the
  `Selector` union + `resolveSelector`, wired into the editor's selection actions.
- **T2 recognition:** the same tangent-adjacency idea, computed mesh-side in
  `services/reconstruct/app/recognition.py` (trimesh face adjacency + dihedral angle →
  connected-components over smooth joins). It groups the mesh into tangent-connected regions and
  flags which are curved; the region count (`tangent_regions`) is reported on `ReconstructionReport`
  as a structural fingerprint (box → 6, cylinder → 3, organic blob → many) for honest UX, and the
  grouping is available to steer fitting. (Hole/boss detection stays with the existing CSG route, not
  this recogniser — distinguishing a hole from a boss from raw mesh regions is not reliable.)

## Consequences

- `TaggedEdge.faceIds` (additive); new `packages/cad/src/select/topology.ts` (adjacency + convexity);
  new selector kinds; editor wiring. New `services/reconstruct/app/recognition.py` + report counts.
- New `docs/specs/SPEC-8-feature-recognition.md`; `Expanse.md` rec #2 → shipped.
- No third-party code enters the tree; deterministic; no new runtime dependency.
