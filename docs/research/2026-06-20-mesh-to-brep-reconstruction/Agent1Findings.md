# Agent 1 Findings — Topology / Shared-Edge Problem in Mesh→B-rep Reconstruction

> Area 1 of the deterministic mesh→B-rep (pythonOCC / OpenCASCADE) research run.
> Question: when smooth analytic faces are fitted **region-by-region** and their fitted
> boundaries do **not** coincide with neighbors, how do you produce a watertight,
> editable **SOLID** (not just a shell)?

---

## TL;DR — The Verdict (read this first)

**Per-region surface fitting followed by "sew everything by tolerance" is NOT sufficient
to make a watertight solid, and practitioners do not rely on it for the curved/smooth
case.** It only works when the fitted regions already overlap or abut within a small,
roughly uniform gap — i.e., when faces were originally trimmed to a shared boundary
(STEP/IGES re-import) and the gaps are sub-millimeter. When you fit each region
*independently* to a mesh, the fitted analytic surfaces extend to slightly different
places, so the region boundaries are genuinely **non-coincident**: gaps and overlaps are
**non-uniform** and frequently exceed any sewing tolerance you can safely set. Cranking
the sewing tolerance up to swallow the worst gap distorts good edges, merges things that
shouldn't merge, and still leaves free edges where the gap is larger than tolerance — and
even with the *right* tolerance, a fetched OCCT forum account shows sewing two cubes that
share a face produced **two unclosed shells with the shared face in neither** (see §7).

**The robust approach used by every serious reverse-engineering pipeline is explicit
shared-edge construction: extend each fitted surface past its region, intersect adjacent
surfaces to get the *exact* shared edge curve, intersect adjacent edges to get the shared
corners, trim each surface with those shared edges, and only *then* sew — at which point
sewing has almost nothing to do because the edges are already geometrically identical.**
This is the "extend-and-intersect" / "intersection-aware" / "constrained-fitting" family
of methods (Várady & Benko; Point2CAD; Mesh2Brep). Sewing + shape-healing is the
*finishing/insurance* stage, not the topology-building stage.

There is one hard caveat that shapes the whole design (Benko/Várady — per the indexed
paper abstracts/snippets; full text was 403-blocked, so treat as strongly-supported but
not full-text-confirmed): **you can only intersect two surfaces to get a clean edge where
they meet in a SHARP edge. Where two
regions join with tangential (smooth/G1) continuity, surface–surface intersection is
numerically unstable/ill-defined and will NOT give you a usable edge.** Tangential joins
must be handled by snapping the segmentation boundary (project the mesh region-boundary
polyline onto both surfaces and share it) or by a fitted blend/fillet surface — not by
intersection. For "organic" meshes that are mostly smooth, this is exactly why naive
reconstruction produces garbage: there are few sharp edges to intersect on.

So for this project: **build shared edges explicitly for sharp adjacencies (intersect),
snap shared boundaries for smooth adjacencies (project/merge), then sew + heal as a
safety net, then promote to solid with an explicit closure check.** Do not ship
"fit-then-sew-by-tolerance" as the primary mechanism.

---

## 1. Why sew-by-tolerance fails on independently fitted faces

### 1.1 What sewing actually does
`BRepBuilderAPI_Sewing` finds pairs of edges from different faces whose geometry lies
within `tolerance` of each other and *merges them into one shared edge*, producing a
`TopoDS_Shell` (or face/solid/compound) from a pile of `TopoDS_Face`s. It does **not**
move or re-fit the underlying surfaces; it only stitches boundaries that are *already
close*. Key reported behavior:

- **Default tolerance is 1.0e-06.** Sewing closes a gap only when
  `tolerance >= gap size`. Any boundary pair farther apart than tolerance stays a
  **free edge** (an edge used by exactly one face).
- Reporting after `Perform()`: `NbFreeEdges()` / `FreeEdge(i)` (unsewn boundaries),
  `NbContigousEdges()` (successfully merged), `NbMultipleEdges()` (edge shared by >2 faces;
  blocks manifold sewing), `NbDegeneratedShapes()`.
- **Manifold mode (default): "Sewing will not be done in case of multiple edges."**
  Non-manifold mode (`option4=True`) is required if three faces meet an edge — which
  happens spuriously when overlaps stack up.
- `LocalTolerancesMode` makes the working tolerance per-edge:
  `WorkTolerance = myTolerance + tolEdge1 + tolEdge2`. `MinTolerance`/`MaxTolerance`
  bound it.

### 1.2 The structural problem
Independently fitted surfaces don't share a boundary at all — each surface was trimmed to
its *own* region boundary (e.g., the convex hull / UV bbox of its inlier points), so two
neighbors' boundary curves are two *different* curves in space, offset by a non-uniform
gap. Sewing can only paper over that if the gap is everywhere `< tolerance`. In practice:

- **A single global tolerance can't fit:** small gaps need a tight tolerance (or unrelated
  nearby edges get wrongly merged); the worst gaps need a loose one. Forum practice for
  imported geometry is to bump tolerance from `1e-6` to as high as `1e-2`, but that is a
  band-aid for *already-trimmed* faces with small gaps, not for independently fitted ones.
- **Too-loose tolerance corrupts geometry:** it merges edges that shouldn't merge, creates
  multiple (non-manifold) edges, and inflates vertex/edge tolerances so the model is
  "valid" but sloppy and unfit for editing.
- **Sewing ≠ fusing.** A repeated forum confusion: `BRepBuilderAPI_Sewing` makes two faces
  *share* an edge but keeps two faces; it does not unify or re-trim them. If boundaries
  don't already line up, there is nothing for it to share.

**Conclusion:** sew-by-tolerance presupposes shared boundaries. Independent fitting
destroys that precondition, so sewing alone cannot make the shell watertight.

---

## 2. The robust path: explicit shared-edge construction (extend → intersect → trim → sew)

This is the consensus method across the reverse-engineering literature (Várady & Benko;
Point2CAD; the generic "Topology Reconstruction for B-Rep" 5-step pipeline). Steps:

### 2.1 Build the adjacency graph
From the segmented mesh, two regions are *adjacent* if their triangle patches share mesh
edges. This region-adjacency graph tells you which surface pairs to intersect and, later,
which faces must share a B-rep edge. (Canonical 5 steps: primitive extraction → adjacency
graph → edge extraction → wire construction → B-rep creation.)

### 2.2 Extend each surface past its region (the margin trick)
Fit the analytic/freeform surface, then **extend it by a margin** beyond the supporting
points before intersecting. Point2CAD: "trimmed to form a margin of width ε around the
supporting points to ensure enough space for the subsequent steps." Without the margin,
two surfaces fitted to abutting regions may not even reach each other to intersect.
- For analytic surfaces this is trivial: a `Geom_Plane` / `Geom_CylindricalSurface` /
  `Geom_ConicalSurface` / `Geom_SphericalSurface` is unbounded (or periodic) in its
  natural domain — you simply *don't* trim it tightly until after intersection.

### 2.3 Intersect adjacent surfaces → shared edge curve (SHARP joins only)
For each adjacent pair that meets in a **sharp** edge, intersect the two (extended)
surfaces to get the exact shared 3D curve. Two OCCT routes, with a critical difference:

- **`GeomAPI_IntSS(S1, S2, tol)`** — pure geometric surface–surface intersection on
  `Geom_Surface`s. Returns `Geom_Curve`(s) via `NbLines()` / `Line(i)`.
  **Caveat (verified on the OCCT forum):** with a `Geom_RectangularTrimmedSurface`, IntSS
  intersects the **base (untrimmed) surface**, not the trim — which is actually *fine and
  desirable* here, because for analytic primitives you *want* the full unbounded
  intersection and you trim afterwards. But IntSS was reported to produce "strange wavy /
  distorted curves" on some shell cases.
- **`BRepAlgoAPI_Section(shape1, shape2)`** — topological section; result is a
  `TopoDS_Compound` of `TopoDS_Edge`s that "smoothly follow the boundary of the
  intersection." Practitioners prefer Section when the inputs are already topological
  faces/shells (it respects trimming) and report it gives cleaner curves than IntSS for
  plane-vs-shell. Use `.ComputePCurveOn1(True)` / `.ComputePCurveOn2(True)` and
  `.Approximation(True)` so the resulting edges carry p-curves on both faces.

**Practical rule:** intersect the *unbounded analytic* `Geom_Surface`s with
`GeomAPI_IntSS` to get the master curve, then build the edge and project it onto both
faces; reserve `BRepAlgoAPI_Section` for when you already have trimmed topological faces
and want OCCT to manage p-curves for you.

### 2.4 Intersect adjacent edges → shared corners (vertices)
Where three+ surfaces meet, intersect the adjacent *edge curves* to get the corner point,
then trim all incident edges to that shared vertex. Point2CAD: "intersect adjacent
poly-line edges to obtain corner points" and trim edges accordingly. This guarantees the
wires close exactly at shared vertices — the thing sewing-by-tolerance can never
guarantee.

### 2.5 Trim each surface with the shared edges → faces with shared boundaries
Now build each face from its surface + a wire made of the **shared** edges/vertices. Two
adjacent faces are constructed from *the same edge object* (or two edges that are
geometrically identical to machine precision), so there is **no gap to sew**. Region
boundaries that were *not* a sharp adjacency (open boundaries, smooth joins) are handled in
§3. Point2CAD's two trimming modes are worth copying: **distance-based** (keep only
surface near input points) and **topology-aware** (connected-component analysis to discard
regions the point cloud doesn't support).

### 2.6 The SHARP-edge-only caveat (design-critical)
Benko/Várady (paraphrase from the indexed paper snippet — *not* full-text-confirmed, see
Sources): *once primary surfaces have been fitted, where two meet in a sharp edge they can
be intersected to produce the edge between them; this cannot be done if they meet with
tangential continuity, as surface–surface intersection is not robust.* So:
- **Sharp adjacency** → intersect (§2.3).
- **Tangential / smooth (G1) adjacency** → do **not** intersect. Instead, take the mesh
  region-boundary polyline, **project/snap it onto both surfaces' UV**, and build one
  shared edge from it (so both faces use the same boundary), or fit an explicit blend
  surface between them. This is the make-or-break detail for organic/smooth meshes.

### 2.7 Constrained fitting (the "do it right at fit time" upgrade)
Várady/Benko "constrained fitting" goes further: instead of fitting each surface
independently and *then* fixing up topology, it **jointly re-fits** groups of surfaces
under geometric constraints — coaxial cylinders, parallel/orthogonal planes, equal radii,
concentricity, symmetry, and *coincident intersections*. Result: a "perfected" B-rep where
intersections line up by construction and "a valid B-rep model can be constructed without a
lot of manual post-processing on topology correction." This is more work but is the
difference between a sloppy reconstruction and a clean editable one. For a first version,
plain extend→intersect→trim is enough; constrained re-fit is the quality upgrade.

---

## 3. Snapping / projecting region boundaries (for joins you can't intersect)

For open boundaries and tangential joins, the region-boundary **polyline from the mesh
segmentation** is the source of truth. To turn it into a valid B-rep edge on a fitted
surface:
1. **Project the polyline onto the fitted surface** (`GeomAPI_ProjectPointOnSurf` per
   point, or `ShapeAnalysis_Surface::ValueOfUV`) to get UV.
2. **Fit a boundary curve** (3D `GeomAPI_PointsToBSpline`, plus the 2D p-curve in UV) and
   build the edge.
3. **Share that one edge between both adjacent faces** so they are watertight along the
   smooth join.
4. Use `BRepLib::BuildCurves3D` / `ShapeFix_Edge::FixAddCurve3d` to backfill any missing
   3D curve, and `ShapeFix_Face::FixMissingSeam` for periodic (cylinder/sphere) seams.

This is the deterministic alternative to intersection where intersection fails.

---

## 4. Sewing as the *finishing* stage (after edges are built)

Once faces already share (near-)identical edges, sew with a **tight** tolerance to snap
the last machine-epsilon discrepancies and to actually wire up the `TopoDS_Shell`:

```python
sew = BRepBuilderAPI_Sewing(tol)        # tol small, e.g. ~1e-6..1e-4 model units
sew.SetNonManifoldMode(False)           # keep it manifold for a solid
for f in faces:
    sew.Add(f)
sew.Perform()
shell = sew.SewedShape()                # may be Shell / Compound / Solid
n_free = sew.NbFreeEdges()              # MUST be 0 for a closed shell
```

Tolerance strategy:
- **Default `1e-6`** is for already-coincident geometry. A fetched forum account confirms
  `1.0e-06` was too small to stitch STL triangles, and that "the tolerance value should be
  equal to or greater than the gap size" — i.e., you must measure your actual inter-region
  gaps and set tolerance to bracket them (use `ShapeAnalysis_FreeBounds` predictive mode,
  §5, to get the gap distribution first).
- Importers (STEP/IGES) raise tolerance to absorb file gaps — but treat any large value as
  a *smell* of unsolved gaps, not a target. (The often-quoted "bump to `1e-2`" figure
  appeared only in a WebSearch summary, not in a forum thread I read end-to-end, so I'm not
  asserting a specific number; the safe rule is the measured-gap-size rule above.)
- Mirror OCCT's own STEP reader healing logic: it does **not** apply a flat tolerance; it
  starts from `Precision::Confusion()` (~1e-7) and *grows tolerance locally per geometry*,
  capped by `read.maxprecision.val` (default 1.0). The pythonOCC equivalents are
  `ShapeFix_Wire::FixConnected()` (force adjacent edges to share a vertex, raising
  tolerance as needed), `FixLacking()` (close UV gaps), `FixSelfIntersection()`. Set
  `SetMaxTolerance()` so healing can't inflate tolerances arbitrarily.
- `BRepOffsetAPI_Sewing` is an alias/older entry point to the same sewing; use
  `BRepBuilderAPI_Sewing`. `ShapeUpgrade_ShellSewing` wraps sewing for shape-upgrade flows.

If `NbFreeEdges() > 0` after sewing, the shell is **not** closed — go back and fix the edge
construction (or snap that boundary); do **not** just raise tolerance.

---

## 5. Shape healing: close residual gaps & fix p-curves (heal → sew → solid)

Recommended OCCT sequence (each tool: set tolerances, set flags, `Perform()`, check
`Status()`):

1. **Per-face validity first** — `ShapeFix_Face` on each face:
   `FixMissingSeam` (periodic surfaces: add the seam edge), `FixAddNaturalBound`
   (e.g. sphere with holes), `FixOrientation` (wires bound the correct area),
   `FixSmallAreaWire`. Ensure every non-planar face has valid **p-curves**
   (`ShapeFix_Edge::FixAddPCurve` / `BRepLib::BuildCurves3D` for missing 3D curves).
2. **Wires** — `ShapeFix_Wire` runs, in order: `FixReorder`, `FixSmall`, `FixConnected`,
   `FixEdgeCurves`, `FixDegenerated`, `FixSelfIntersection`, `FixLacking` (closes
   parametric gaps by inserting edges or bumping vertex tolerance).
3. **Sew** (§4) into a shell.
4. **Shell** — `ShapeFix_Shell` with `FixFaceMode` + `FixOrientationMode` to make face
   orientations **coherent** (required before MakeSolid gives a meaningful in/out).
5. **Solid** — see §6.

Cross-cutting tools:
- **`ShapeFix_Shape`** — the high-level orchestrator that runs the whole hierarchy
  (shape→solid→shell→face→wire→edge); set `SetPrecision()`, `SetMaxTolerance()`,
  `SetMinTolerance()` once and it propagates. Good as a final blanket pass.
- **`ShapeAnalysis_FreeBounds`** — diagnostic: finds wires of edges referenced by only one
  face. Two modes: *predictive* (given a tolerance, forecasts what free bounds sewing
  *would* leave — run this BEFORE sewing to know your gap distribution) and *existing*
  (actual free edges in a built shell). Returns `GetClosedWires()` / `GetOpenWires()`.
  Use the open-wires result to localize exactly where reconstruction left holes.
- **`ShapeBuild_ReShape`** — the modification context; `SetContext()` it into the fix tools
  so all replacements are tracked, then `context->Apply(originalSubshape)` to map old→new.
- **`ShapeFix_Wireframe`** — `FixWireGaps()` (2D/3D curve discontinuities),
  `FixSmallEdges()` (`ModeDropSmallEdges`).
- **`ShapeUpgrade_*`** — e.g. `ShapeUpgrade_UnifySameDomain` to merge co-surface faces
  (clean up over-segmentation), `ShapeUpgrade_ShellSewing`.

Tolerance knobs everywhere: `SetPrecision()` (detection precision), `SetMaxTolerance()`
(cap on how loose a fix may get — set this to your real-world allowed gap, e.g. a few
× the mesh resolution), `SetMinTolerance()` (small-edge floor).

---

## 6. Shell → Solid (and verifying closure)

```python
# sewedShape is a TopoDS_Shape that reports TopAbs_SHELL
shell = topods.Shell(sewedShape)         # explicit downcast REQUIRED
mk = BRepBuilderAPI_MakeSolid(shell)
solid = mk.Solid()
fix = ShapeFix_Solid(solid)              # orientation / closure cleanup
fix.Perform()
solid = fix.Solid()
```

Verified gotchas:
- **`BRepBuilderAPI_MakeSolid` does NOT validate closure.** It will happily wrap an open
  shell. You must check independently. (Confirmed on the OCCT forum: "the conversion can
  succeed even if the shell doesn't form a closed space.")
- **The downcast is mandatory:** even though `SewedShape().ShapeType()` reports `SHELL`,
  `MakeSolid` needs an actual `TopoDS_Shell` via `topods.Shell(...)` (pythonOCC) /
  `TopoDS::Shell(...)` (C++). Passing the raw shape fails. (Thomas Paviot, pythonOCC.)
- **Closure / validity checks** (do at least the first two):
  - `sew.NbFreeEdges() == 0` (best early signal).
  - `BRepCheck_Analyzer(solid).IsValid()` — full topological/geometric validity.
  - `ShapeAnalysis_FreeBounds` → zero open wires.
  - `BRepClass3d_SolidClassifier` / `BRep_Tool::IsClosed(shell)` to confirm the shell
    encloses a volume; check `GProp` volume is positive/finite.
- **Orientation:** `ShapeFix_Solid` (and `ShapeFix_Shell` `FixOrientationMode`) makes the
  outward normals consistent so the solid's inside/outside is correct; without it a
  "closed" solid can be inside-out and break booleans/volume.

---

## 7. What practitioners actually do (reality check)

- **FreeCAD's Reverse Engineering Workbench is essentially empty** ("at the moment there is
  no functionality present"). Its real mesh→shape path is `Part ShapeFromMesh` → "create
  shape from mesh" (one triangle = one face) → optional **Sew shape** (for "small gaps") →
  convert to solid → refine. That is the *faceted* baseline, not analytic reconstruction,
  and even there sewing is only for *small* gaps and "may be computationally demanding." It
  explicitly warns a non-watertight mesh "cannot become a valid solid" without fixing open
  edges / non-manifold geometry / inverted normals first.
- **Point2CAD (CVPR 2024)** does exactly extend→mesh-intersect→edges→corners, and notably
  **converts surfaces to triangle meshes to do the intersections robustly** ("a generic
  solver … numerically stable computational tools"), then admits the discretization
  "temporarily side-steps the B-rep format" — i.e., producing a *clean analytic-edge*
  watertight B-rep is hard enough that a SOTA research system defers it. Lesson: if exact
  analytic surface–surface intersection is too fragile in OCCT WASM, a robust fallback is
  to intersect the *tessellations*, snap surfaces to those polyline edges, and trim.
- **Mesh2Brep (2024)** is named for the answer: "Robust Primitive Fitting and
  **Intersection-Aware Constraints**" — i.e., the fitting is *constrained so intersections
  are valid*, again confirming that fit-then-sew is not the path; intersection-awareness is
  baked into fitting/trimming.
- **Várady/Benko** is the textbook source for constrained fitting + topological
  beautification and the sharp-vs-tangential intersection rule.
- **First-hand OCCT failure-mode accounts (fetched, end-to-end):**
  - *"sewing-faces-make-solids"* forum thread: sewing 11 faces of two cubes that share one
    face returned **two unclosed shells, and the shared face appeared in neither** — a
    concrete demonstration that sewing-by-tolerance does not reliably yield closed solids
    even on trivial coincident geometry. Responder steered to a different construction
    (`BRepOffsetAPI_MakeThickSolid` after explicitly closing the shell).
  - *"stitching"* forum thread: sewing STL triangles with `BRepOffsetAPI_Sewing(1.0e-06,…)`
    failed to merge them; the consensus was **"sewing alone cannot eliminate common edges /
    create merged faces"** — geometric reconstruction beyond sewing is required. Exactly the
    verdict of this report.
- **CGAL (non-OCCT comparison):** the watertight-mesh primitives (border **stitching**,
  orientation, hole filling, `is_closed`, self-intersection removal, non-manifold-vertex
  duplication) live in CGAL's **Polygon Mesh Repair** package (split out of Polygon Mesh
  Processing in CGAL 6.2). CGAL stitching merges *duplicated boundary edges of a polygon
  soup* — it presumes the two sides are the same edge with duplicated vertices, i.e. it is
  the mesh-domain analogue of OCCT sewing and likewise does **not** invent shared topology
  where boundaries genuinely differ. Reinforces the verdict cross-toolkit: stitching/sewing
  is a *coincidence-merger*, never a topology-builder.

**Bottom line for the spec:** treat sewing+healing as the *closure-insurance* stage. The
*topology* must come from adjacency-graph-driven shared-edge construction (intersect sharp
joins; snap/project smooth & open boundaries), optionally upgraded with constrained
re-fitting. Always verify closure explicitly because OCCT's `MakeSolid` won't.

---

## Sources

- https://dev.opencascade.org/doc/occt-6.9.0/refman/html/class_b_rep_builder_a_p_i___sewing.html
  — `BRepBuilderAPI_Sewing` class ref: default tolerance 1e-6, manifold vs non-manifold
  ("sewing will not be done in case of multiple edges"), free/contiguous/multiple/
  degenerated edge reporting, `LocalTolerancesMode` (`WorkTol = tol + tolEdge1 + tolEdge2`),
  option flags, `SewedShape()`, `NbFreeEdges()`.
- https://dev.opencascade.org/doc/overview/html/occt_user_guides__shape_healing.html
  — Shape Healing user guide: `ShapeFix_Shape/Solid/Shell/Face/Wire/Wireframe`,
  per-class fixes (FixMissingSeam, FixAddNaturalBound, FixOrientation, FixLacking,
  FixConnected…), `ShapeAnalysis_FreeBounds` (predictive vs existing free-bound detection,
  GetClosedWires/GetOpenWires), `ShapeBuild_ReShape`, SetPrecision/Max/MinTolerance.
- https://dev.opencascade.org/content/difference-between-brepalgoapisection-and-geomapiintss-shell-plane-intersection
  — Forum: `BRepAlgoAPI_Section` follows the trimmed boundary smoothly; `GeomAPI_IntSS`
  can give wavy/distorted curves and operates on base (untrimmed) surfaces; OCCT dev
  recommends Section for plane-vs-shell.
- https://arxiv.org/html/2312.04962v1 — Point2CAD (CVPR 2024): extend primitives by margin
  ε, tessellate, compute pairwise *mesh* intersections → poly-line edges, intersect edges
  → corners, two trimming modes (distance-based, topology-aware); admits discretization
  "side-steps the B-rep format."
- https://dev.opencascade.org/content/making-solid-out-shell-pythonocc — pythonOCC forum
  (Thomas Paviot): sewing→`SewedShape()`→explicit `topods.Shell(...)` downcast→
  `BRepBuilderAPI_MakeSolid`; raw shape fails even though ShapeType reports SHELL.
- https://dev.opencascade.org/content/convert-closed-shell-solid — Forum: `MakeSolid` does
  NOT validate closure; must check `NbFreeEdges()` (and other checks) yourself.
- https://www.researchgate.net/publication/222529921_Algorithms_for_reverse_engineering_boundary_representation_models
  and Várady/Benko "Segmentation and Surface Fitting in Reverse Engineering"
  (https://link.springer.com/chapter/10.1007/978-0-387-35392-0_17) — sharp-edge surfaces
  can be intersected to produce edges, tangential/smooth joins cannot (intersection not
  robust); constrained fitting + topological beautification produce a perfected B-rep
  "without a lot of manual post-processing on topology correction." (Found via search;
  ResearchGate full text was 403-blocked — claims taken from the indexed abstracts/snippets.)
- https://orca.cardiff.ac.uk/id/eprint/1812/1/ConstrainedFitting.pdf — Benko & Kós,
  "Constrained fitting in reverse engineering" (intended primary source for joint
  multi-surface constrained fitting: coaxiality, parallelism, equal radius, coincident
  intersections). NOTE: 403-blocked at fetch time; cited from the search-result description
  and corroborating Várady/Benko abstracts — not read in full.
- https://dev.opencascade.org/doc/overview/html/occt_user_guides__step.html — STEP
  translator: `read.precision.mode/val` (default 0.0001 mm), `read.maxprecision.val`
  (default 1.0, Preferred vs Forced), tolerance starts at `Precision::Confusion()` and
  grows locally; reader auto-applies `ShapeFix_Wire::FixSelfIntersection/FixLacking/
  FixConnected`; solid made only when source has a closed shell — model for tolerance
  strategy.
- https://dev.opencascade.org/content/some-problems-about-brepbuilderapisewing — Forum:
  sewing makes two faces *share* an edge but keeps them two faces (it does not fuse);
  `BRepAlgoAPI_Fuse` is the tool to actually unify — clarifies what sewing can/can't do.
- https://dev.opencascade.org/content/sewing-faces-make-solids — Forum (fetched
  end-to-end): sewing 11 faces of two cubes sharing one face yielded **two unclosed shells,
  shared face in neither**; responder recommended explicitly closing the shell /
  `BRepOffsetAPI_MakeThickSolid` — first-hand free-edge/open-shell failure mode.
- https://dev.opencascade.org//content/stitching — Forum (fetched end-to-end): sewing STL
  triangles with `BRepOffsetAPI_Sewing(1.0e-06,…)` did not merge them; consensus "sewing
  alone cannot eliminate common edges / create merged faces"; "tolerance should be ≥ gap
  size" — grounds the measured-gap tolerance rule (§4).
- https://doc.cgal.org/latest/Polygon_mesh_processing/index.html — CGAL: watertight/repair
  ops (stitch_borders, orientation, hole filling, is_closed, self-intersection removal,
  non-manifold-vertex duplication) reorganized into the **Polygon Mesh Repair** package
  (CGAL 6.2); stitching merges *duplicated* boundary edges, i.e. a coincidence-merger like
  OCCT sewing — non-OCCT corroboration of the verdict.
- https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Reverse_Engineering_Workbench.md
  and https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Part_ShapeFromMesh.md
  — FreeCAD RE Workbench currently has no functionality; real path is `Part ShapeFromMesh`
  + optional "Sew shape" for *small* gaps; non-watertight mesh cannot become a valid solid
  without fixing open edges / non-manifold / inverted normals first (faceted baseline only).
- https://www.researchgate.net/publication/387764469_Mesh2Brep_B-Rep_Reconstruction_Via_Robust_Primitive_Fitting_and_Intersection-Aware_Constraints
  — Mesh2Brep (2024): name itself states the thesis — robust primitive fitting +
  *intersection-aware constraints* (not fit-then-sew). (Abstract/title only; full text
  403-blocked.)
