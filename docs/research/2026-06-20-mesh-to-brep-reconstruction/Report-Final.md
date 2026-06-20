# Final Report — Deterministic Mesh→B-rep (STEP) Reconstruction with Curved Surfaces (pythonOCC)

**Date:** 2026-06-20 · **Target:** `services/reconstruct` (FastAPI + `pythonocc-core` / OCCT)
**Question:** how to deterministically reconstruct a triangle mesh (with normals) into a watertight, analytic **STEP SOLID** — recovering plane/cylinder/cone/sphere faces and freeform BSpline faces — and why our current "fit planar facet → trimmed face → sew" approach cannot reach a curved solid on its own.

Synthesizes four research agents (A1 topology/shared-edge; A2 deterministic detection + Python libs; A3 pythonOCC face construction; A4 existing pipelines), grounded in our backend (`fitted.py`, `segment.py`, `pipeline.py`, `occ_step.py`) and the prior investigation (`docs/investigations/2026-06-20-r6-curved-reconstruction-and-tail.md`). Per-agent findings: `Agent{1..4}Findings.md`; queries: `ExpandedSearches.md`.

---

## 1. Executive recommendation

Build the proven **segment-then-fit** pipeline (the family every mature tool shares — A4), keeping our planar path and adding curved/freeform fitting where `leftover` triangles die today at `fitted.py:96`. The headline decision: **make the topology explicit — do not rely on "fit-then-sew-by-tolerance"** — because an analytic face built to the *ideal* boundary no longer coincides with neighbors' mesh-vertex rims, so sewing leaves free edges and the solid regresses to a shell (A1 §1; investigation §5). The robust method (Point2CAD, Várady/Benko) is **adjacency-graph → extend each fitted surface → intersect adjacent surfaces for the exact shared edge → intersect edges for corners → trim to those shared edges → only then sew + heal → solid** (A1 §2, A4 Part E). Detection: **self-implemented deterministic normal/Gauss-map region-growing + closed-form least-squares fits** in numpy/scipy (CGAL's deterministic Region Growing is not in any Python binding; every Python lib that fits curved primitives uses non-deterministic RANSAC — A2 §1, §4). Face construction uses OCCT analytic surfaces with **p-curves** and the **largest-angular-gap** seam rule (A3 §1.3, §3). **Reuse Point2CAD's classical tail logic** (Apache-2.0, liftable) but **own the analytic-STEP export and OCCT topology tail**, which Point2CAD defers (A4 Part C). **The single biggest risk is the topology tail** (shared-edge across sharp *and* tangential joins) — the part Fusion fails on, Point2CAD side-steps, and no OSS tool has automated.

## 2. Canonical pipeline (5 stages + stage-0)

| # | Stage | Deterministic/classical vs ML |
|---|-------|-------------------------------|
| 0 | **Mesh cleanup** (weld/winding/normals/slivers/holes) | Classical — already done (`cleanup.py`, R6.2) |
| 1 | **Segmentation** → one region per CAD face | Classical (region growing / coplanar grouping); ML escape hatch only for organic/noisy (ParseNet/HPNet/SED-Net) |
| 2 | **Per-region fit** (simplest type within tol; else freeform) | Classical for analytic + BSpline; ML only for freeform INR (Point2Primitive argues it hurts editability) |
| 3 | **Edge recovery** = intersect adjacent fitted surfaces (NOT mesh boundary lines) | Classical (`GeomAPI_IntSS` / `BRepAlgoAPI_Section`) |
| 4 | **Corner recovery** = intersect adjacent edges → vertices | Classical |
| 5 | **Trim + sew + heal → solid → STEP** | Classical (`MakeFace`, `Sewing`, `ShapeFix_*`, `MakeSolid`, STEP writer) |

Load-bearing insight: stages 3–5 are classical in *every* pipeline examined, even the ML ones, and map 1:1 onto OCCT. ML, when present, replaces only stage 1 and the freeform half of stage 2. Family (B) — ComplexGen/BrepGen/P2CADNet/DeepCAD — learns topology inside the network; a different architecture we are not building. Our NFR-2 determinism + no-training goal makes family (A) the only fit.

## 3. Stage-by-stage for `services/reconstruct`

**3.1 Segmentation** — keep `trimesh.facets` for planes (deterministic, already in `segment.py:26`); add **deterministic seeded region-growing** over curved faces, keyed by fixed traversal order, **growing-and-splitting on fit residual** (a component spans cylinder→fillet→sphere and fits none otherwise). Gauss map drives type proposal (plane=point, cylinder=great circle/pole=axis, cone=small circle, sphere=2-D patch). **Why not the libraries:** CGAL RG is deterministic but has *no Python binding* (cgal-swig issue #150 open; not in scikit-geometry), is mesh-planes-only, no cone RG at all; pyransac3d/Open3D are RANSAC (non-deterministic; pyransac3d's own maintainer calls its cylinder "very unstable"); pcu/PyVista/libigl fit no curved primitives.

**3.2 Per-region fit (Eberly, deterministic):** plane = covariance smallest-eigenvector; sphere = closed-form linear (eqn 49) or normal-line intersection; cylinder = Gauss-map plane-of-normals seeds axis W, then closed-form center/radius (eqns 79/92) + Kåsa circle cross-check; cone = third-moment axis (eqn 120) or centered-normal-scatter with α=arcsin(|N̄|), apex via multi-tangent-plane LSQ, fixed-iteration LM polish. Accept simplest within tolerance (Lukács/Besl-Jain ordering). Matches investigation §5 and Point2CAD's classical fits.

**3.3 Face construction:** rectangular patch → `BRepBuilderAPI_MakeFace(surf,umin,umax,vmin,vmax,tol)` (auto p-curves). Real non-rectangular boundary → build edges from `Geom2d_Curve+Geom_Surface` (`MakeEdge`), `breplib.BuildCurves3d`, `MakeWire`, `MakeFace(surf,wire,True)` — non-planar faces **must** carry p-curves (OCCT auto-projects only for planar). Point→UV via `elslib.Parameters(...)` (closed-form, returns (U,V) tuple) for analytic; `GeomAPI_ProjectPointOnSurf.LowerDistanceParameters()` for BSpline. **Periodic-seam largest-gap rule** (A3 §3.1) to avoid building the whole cylinder; then `FixShifted`/`FixMissingSeam`/`FixAddNaturalBound` + `breplib.SameParameter`. Freeform (R6.5): prefer `BRepOffsetAPI_MakeFilling` (scattered, no grid), `GeomAPI_PointsToBSplineSurface` only when grid-resamplable, `GeomPlate` for energy-min (cannot close a surface); faceted fallback (`fitted.py:80`) never drops geometry.

**3.4 Topology (the crux):** our `fitted.py` only makes solids because planar neighbors share byte-identical mesh-vertex loops; an analytic rim deviates by the sagitta (~8.6e-5 m at r=10mm, ~86× the 1e-6 sew tol) → free edges → shell. Fix: adjacency graph → extend surfaces by ε margin → `GeomAPI_IntSS` (unbounded analytic) or `BRepAlgoAPI_Section` (trimmed faces, w/ `ComputePCurveOn1/2`+`Approximation`) → corners by edge intersection → trim so adjacent faces use the *same* edge. **Sharp-vs-tangent (design-critical):** intersect only **sharp** joins; for **tangential/G1** joins snap/project the mesh boundary polyline onto both surfaces' UV and share one edge (this is why organic meshes reconstruct poorly). Then heal→sew(tight)→`MakeSolid`, with explicit closure checks — `MakeSolid` does NOT validate closure: assert `NbFreeEdges()==0`, `BRepCheck_Analyzer.IsValid()`, `ShapeAnalysis_FreeBounds` zero open wires, positive volume; explicit `topods.Shell(...)` downcast required. Later upgrade: Várady/Benko constrained fitting.

## 4. Reuse vs own

**Reuse — Point2CAD (arXiv 2312.04962, Apache-2.0, verified by LICENSE fetch):** its classical topology tail (extend→intersect→corner→trim + connected-component drop) and classical primitive fits (reimplement deterministically per §3.2). **Do NOT adopt** its freeform INR. **Must own:** analytic STEP export (Point2CAD defers true B-rep to future work, discretizes to side-step it — we have `occ_step.py`) and the OCCT topology tail on real `Geom_*` surfaces. Fallback if exact intersection is fragile: intersect tessellations, snap surfaces to polyline edges, trim. Other OSS converters are tail-reference only (proprietary or planes-only).

## 5. Phased plan

**FIRST SPIKE (gate everything):** single closed cylinder — collapse 24 side quads into one cylindrical face, **rebuild each cap as a circle-bounded planar face sharing the cylinder's exact rim edge** (plane∩cylinder), sew tight, **assert `is_solid` SURVIVES** (does not drop to shell). If it drops, finish shared-edge handling before any sphere/cone/freeform. **R6.4-curved:** adjacency+region-growing over `leftover` → closed-form fits/classify → trimmed analytic faces w/ p-curves + seam rule → extend/intersect (sharp) or snap (tangent) → corners → trim → heal/sew/MakeSolid+verify; report gains `curved_faces`. **R6.5:** MakeFilling/GeomPlate/grid-BSpline for smooth non-primitives, faceted fallback otherwise. **Honest organic scope:** few primitives + mostly tangential joins → most faces land in MakeFilling/faceted, topology relies on snap-projected boundaries; quality fundamentally limited but fallback keeps it correct. Mechanical/prismatic meshes win big (mirrors Fusion's tiered behavior).

## 6. Pitfalls (with fix)
1. Fit-then-sew-by-tolerance ≠ curved solid → explicit shared edges (sewing is insurance).
2. `MakeSolid` doesn't validate closure → check NbFreeEdges/BRepCheck/FreeBounds/volume.
3. Missing p-curves on non-planar faces → "wrong shape"; build from Geom2d+surface, BuildCurves3d, SameParameter.
4. Periodic-seam straddling builds whole cylinder → largest-angular-gap rule + FixShifted/FixMissingSeam.
5. Intersecting tangential joins is unstable → snap/project boundary polyline; intersect only sharp.
6. Sewing downcast omitted → explicit `topods.Shell(...)`.
7. Non-deterministic detector breaks NFR-2 → self-implement closed-form fits + fixed order.
8. One-primitive-per-component assumption → grow-and-split on residual.
9. Over-cranking sew tolerance corrupts geometry → fix edges, keep tol tight, cap `SetMaxTolerance`.
10. GeomPlate can't close / MakeFilling unstable → analytic path for closed patches, denser constraints, faceted fallback.
11. Non-rectangular UV over-covered by bbox MakeFace → surface+wire traced p-curves or accept-for-v1/fallback.

## 7. Sources (consolidated, deduplicated)

The per-URL lists with one-line notes live in each `Agent{1..4}Findings.md` `## Sources` section. Key anchors:
- **Detection math:** Eberly "Least Squares Fitting of Data by Linear or Quadratic Surfaces" (LeastSquaresFitting.pdf); Lukács/Marshall/Martin "Faithful Least-Squares Fitting of Spheres, Cylinders, Cones and Tori" (Springer BFb0055697); Várady/Benko reverse-engineering + ConstrainedFitting.
- **Determinism/library availability:** CGAL Shape_detection docs + cgal-swig-bindings issue #150 (no Python RG); pyRANSAC-3D issue #13 (cylinder unstable); Open3D segment_plane docs.
- **OCCT/pythonOCC:** OCCT refs for BRepBuilderAPI_Sewing, ShapeFix_Face/Shell/Solid, ShapeAnalysis_FreeBounds, BRepBuilderAPI_MakeFace/MakeEdge, breplib BuildCurves3d/SameParameter, ElSLib, GeomAPI_IntSS, BRepAlgoAPI_Section, BRepOffsetAPI_MakeFilling, GeomPlate_BuildPlateSurface/MakeApprox, GeomAPI_PointsToBSplineSurface; pythonocc-demos + pythonocc-core SWIG wrappers; OCCT forum threads (sewing-faces-make-solids, stitching, convert-closed-shell, "some problems about sewing").
- **Pipelines:** Point2CAD arXiv 2312.04962 + repo Apache-2.0 LICENSE; P2CADNet 2310.02638; Point2Primitive 2505.02043; ComplexGen/BrepGen/DeepCAD; FreeCAD Reverse-Engineering WB docs/forum; Fusion mesh-to-BRep ("surfaces instead of solid"); Geomagic auto-surface workflow; GitHub stl2step / Mesh2CAD-Converter / PythonOCC-CAD-Converter.
