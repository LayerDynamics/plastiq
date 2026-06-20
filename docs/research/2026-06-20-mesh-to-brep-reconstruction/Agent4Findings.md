# Agent 4 Findings — Existing Mesh→CAD(STEP) Reverse-Engineering Pipelines, End-to-End

> Area 4 of the deterministic mesh→B-rep (STEP) research run.
> Goal: extract the **proven, canonical pipeline architecture** from existing open-source tools, research
> papers, and commercial reverse-engineering software — and separate the **classical/deterministic stages
> (reusable for our pythonocc service)** from the **ML-only stages**.

---

## TL;DR — the single most important finding

There are **two distinct architectural families** in this field, and they answer different problems:

- **(A) Segment-then-fit reconstruction** — the approach we are building. **Every mature pipeline in this family
  shares the SAME five-stage backbone:**
  1. **Segment** the surface into regions, one region per intended CAD face.
  2. **Fit a surface** to each region (analytic primitive *or* freeform patch), keeping the simplest type that fits.
  3. **Recover edges** = intersect adjacent fitted surfaces (surface–surface intersection), NOT by reusing mesh boundary lines.
  4. **Recover corners/vertices** = intersect adjacent edges.
  5. **Trim + sew into topology** = clip each surface to its edges/corners, sew trimmed faces into a shell, promote to a solid.

  In this family the ML methods only ever replace **stage 1 (segmentation)** and **the freeform half of stage 2**;
  **stages 3–5 are classical geometry (deterministic) in every member examined** — Point2CAD, FreeCAD's stitched
  workflow, Fusion's Prismatic mode, Geomagic, and the OSS tools. This is the strongest single signal for our design:
  **the topology/edge/trim/sew tail is the proven-reusable, deterministic core, and it is exactly what OCCT/pythonocc
  gives us.** The "extend surfaces → intersect → topology emerges → clip primitives" recipe in our Area 1 is
  *identical* to Point2CAD's published method.

- **(B) End-to-end-learned generation/sequence** — a **different architecture we are NOT building.** ComplexGen
  (learns geometry *and* topology), BrepGen (diffusion synthesis of the B-rep), and the sketch-and-extrude *sequence*
  models (DeepCAD, P2CADNet, Point2Primitive) **do not have the surface-intersection backbone at all** — the
  topology is produced by the network, not by classical geometry. They require training, are mostly non-deterministic,
  and target either direct B-rep synthesis or a construction program rather than a fitted-surface B-rep.

That these two families exist — and that family (B) cannot give us a deterministic, no-training, OCCT-native tail —
**reinforces choosing family (A): segment-then-fit with the classical OCCT topology tail.**

---

## Part A — Open-source GitHub tools (what they REALLY do)

### Danxtream/Mesh2CAD-Converter — most-marketed, but shallow
- **Claim:** STL → STEP, "automatically detecting and reconstructing planes and cylinders."
- **Reality:** Detects **only planes + cylinders**. Cylinder detection is *gated on* prior plane detection (STL only).
  Plane detection = **region growing**. Has "automatic face stitching with configurable tolerances" (i.e. sewing).
- **Surface output:** Crucially, its baseline path **converts triangulated STL to *exact triangular* STEP** — i.e.
  a **faceted shell**, with analytic fitting layered on top only for the detected plane/cylinder regions. Not a
  fully analytic reconstruction.
- **Kernel:** Library undocumented; **source is proprietary/closed**, so not directly reusable.
- **Maturity:** v1.1, "initial release," author explicitly will not support it. Mesh cap ~10M triangles.
- **Takeaway for us:** Confirms the two-tier "analytic where possible, faceted fallback" strategy and the
  plane→cylinder dependency ordering — but it's a black box, not a code source.

### TheTesla/stl2step — honest, tiny, analytic-output
- **Approach:** Segments mesh into basic shapes, emits a STEP of **analytic primitives** (planes) rather than
  triangles → much smaller files. Notably has **hole support** in faces.
- **Reality:** **Only planes implemented.** Cylinders/spheres named as future work. Experimental (v0.1.2, Apr 2025).
  No documented topology analysis. Kernel not stated (no OCCT mention).
- **Takeaway:** Proof that even "just planes, done well, with holes" is a coherent first milestone. It validates
  starting analytic-only on planes and adding curved primitives incrementally — exactly the staged plan our spec wants.

### DalessandroJ/PythonOCC-CAD-Converter & yaneony/2STEP-Converter — format converters, NOT reconstructors
- These are **batch file-format converters** (STEP/IGES/BREP/STL ↔) built on **pythonocc-core**. 2STEP uses OCCT
  for "sewing, fixing, and STEP export." **Neither does surface fitting / reverse engineering** — they tessellate
  or transcode, they do not recover analytic faces from a mesh.
- **Takeaway:** Good *reference code* for the OCCT **sew → ShapeFix → STEP write** tail (our Area 1), not for the
  fitting front-end.

### rdevaul/yapCAD — relevant as a kernel-integration reference
- A procedural/parametric CAD DSL with **full pythonocc-core (OCCT) integration**: analytic solid modeling, exact
  booleans, and **production STEP/STL/DXF export**. v1.0 ships "OCC BREP kernel integration" + validation schemas.
- **Not** a mesh→B-rep reverse-engineering tool, but a clean example that pythonocc-core is a viable, maintained
  base for building solids and writing STEP from a Python service.

### fuzemobi/MeshConverter — the anti-pattern
- STL→CAD primitives via **voxelization or GPT-4 Vision**. Mentioned only to flag it: this is *not* analytic
  surface fitting; it's coarse/heuristic. Not a model for a deterministic pipeline.

**Net for GitHub OSS:** There is **no mature, open, one-click mesh→analytic-STEP reconstructor** among the dedicated
converter tools. The closest credible building blocks are (a) **stl2step**'s segment→fit→emit shape for the front-end
concept, and (b) the **pythonocc converters/yapCAD** for the OCCT sew/fix/STEP-export tail. **However**, the research
code **Point2CAD (Apache 2.0, see Part C)** is the most complete reusable codebase — its classical fitting + edge/
corner/trim logic can be lifted directly. So: **assemble, with Point2CAD's classical tail as a liftable starting point.**

---

## Part B — FreeCAD Reverse Engineering Workbench (the canonical "official" answer is: mostly empty)

- **Official wiki, verbatim:** *"At the moment there is no functionality present in this workbench. It is used as
  a sandbox by the programmers."* The only documented command is **"Approximate a B-spline surface" (FitSurface)**.
- The **real** FreeCAD reverse-engineering capability lives across **other** workbenches, not this one. *(The
  per-WB specifics below come from the FreeCAD-RE search summaries / DeepWiki, not a direct fetch of each Mesh-WB
  page — treat as likely-but-unverified, unlike the verified "RE Workbench is an empty sandbox" finding above):*
  - **Mesh WB → Segmentation / "Segmentation From Best-Fit Surfaces"**: partitions a mesh into regions using
    **region growing** (curvature + normal deviation) and/or **RANSAC** for plane/cylinder/sphere.
  - **Part WB → "Shape from Mesh"**: builds a Shape (a faceted shell) from triangles, which can then be made a solid.
- **What it actually produces:** Practically, the easy path yields a **faceted shell** ("Shape from Mesh" → solid);
  true analytic fitting is per-region and manual (fit a B-spline / detected primitive to a segment).
- **Limits:** No robust one-click mesh→analytic-STEP. The pieces (segmentation, primitive detection, B-spline fit,
  shape healing) exist but are **not wired into an automated pipeline** — the user stitches the stages by hand.
- **Takeaway:** FreeCAD validates the **stage decomposition** (segment → fit primitive/B-spline → make shape →
  heal → solid) but confirms nobody in OSS has automated the *topology-reconciliation* tail. That gap is our work.

---

## Part C — Research pipelines (stage breakdown, code, classical-vs-ML)

### Point2CAD (Liu/Obukhov/Wegner/Schindler; CVPR-area; arXiv 2312.04962) — THE reference architecture for us
This is the most directly transferable paper because its **entire topology tail is classical geometry**, matching
our pythonocc plan, and its "topology emerges from extend+intersect+clip" is exactly our Area-1 strategy.

Exact stages (verified from the paper body):
1. **Segmentation — NEURAL.** Pretrained backbone (ParseNet / HPNet / or GT) clusters points → one cluster per face.
   *Backbone-agnostic.*
2. **Surface fitting — HYBRID, "fit all types, keep the simplest with lowest error":**
   - **Plane** — eigen-decomposition of the covariance matrix (classical, closed-form).
   - **Sphere** — fixed-point iteration on normal equations (classical).
   - **Cylinder** — Powell optimizer minimizing geometric error (classical).
   - **Cone** — Levenberg–Marquardt (classical).
   - **Freeform** — **INR** (implicit neural rep): a 1-layer MLP encoder/decoder with a **2-D bottleneck**, mixed
     **SiLU + sinusoidal** activations, optimized **at test time** (Adam, ~1000 steps). *This is the only ML in fitting.*
3. **Edge recovery — CLASSICAL.** Tessellate fitted surfaces to meshes, **compute pairwise mesh intersections →
   poly-line edges.**
4. **Corner recovery — CLASSICAL.** **Intersect adjacent edge poly-lines → corner points.**
5. **Topology + trimming — CLASSICAL.** Trim each surface by (a) distance margin around supporting points,
   (b) intersection edges, (c) corners; then **connected-component analysis** drops unsupported regions.
- **Output:** a B-rep (analytic surfaces + edge polylines + corners + adjacency). **STEP export is explicitly
  future work** — the paper sidesteps true B-rep by working on discretized intersections and notes "it is possible
  to compute the true analytical intersections... left for future work." The README lists **STEP export via
  PythonOCC** as planned.
- **Code:** Released (prs-eth/point2cad and YujiaLiu76/point2cad). Deps: PyTorch, PyMesh, **geomfitty** (primitive
  fitting), ParseNet (separate). **License = Apache 2.0** (verified by fetching the repo's LICENSE file directly:
  commercial use permitted). *(One search-result summary claimed CC-BY-NC; that almost certainly refers to the
  ABC-dataset / paper terms, not the code — the LICENSE file in the repo is Apache 2.0.)* This means the code is
  **usable as a direct dependency or a fork**, not merely a reference — its classical primitive-fit + edge/corner/
  trim logic (and the planned PythonOCC STEP export) can be lifted, subject to attribution.
- **Performance:** Beats ComplexGen on geometric metrics (e.g. Chamfer 0.018 vs 0.042 with HPNet).
- **Reusable for us:** stages **3, 4, 5 wholesale** (and these map 1:1 to OCCT: GeomAPI_IntSS / BRepAlgoAPI_Section
  for edges, surface trimming + BRepBuilderAPI_Sewing + ShapeFix for the tail); the **classical primitive fits** in
  stage 2 are standard least-squares we can reimplement deterministically. Only stage 1 + the freeform INR are ML.

### ComplexGen (SIGGRAPH 2022; arXiv 2205.14573) — direct B-rep generation (less reusable)
- Represents a B-rep as a **chain complex**; a network **directly predicts** vertices/edges/faces + their
  **adjacency matrices**, then a **topological optimization** enforces a valid B-rep.
- **End-to-end learned** (geometry *and* topology), so the deterministic tail we want is mostly absorbed into the
  network. Heavier to train, less of a fit for a classical service. Useful as evidence that explicit topology +
  adjacency is the right *target representation*.

### Segmentation backbones — ParseNet / HPNet / SED-Net (the front-end menu)
- All implement **"segmentation + primitive fitting" paradigm**: cluster points by learned features into primitive
  patches. They are the **stage-1 supplier** that Point2CAD plugs into. SED-Net (edge-aware) and HPNet (hybrid
  representations) are the stronger ones. These are **ML-only** and require trained weights.
- **Takeaway:** stage-1 segmentation is where ML clearly beats classical on *organic/complex* shapes — which is
  precisely the case our memory note flags ("organic meshes reconstruct poorly" with classical region-growing).

### P2CADNet (arXiv 2310.02638) & Point2Primitive (arXiv 2505.02043) — the "sketch-and-extrude" school
- **Different target than ours.** These reconstruct a **construction sequence** (sketch curves + extrude), not a
  free B-rep of fitted surfaces.
  - **P2CADNet:** point feature extractor → CAD-sequence reconstructor (two transformer decoders, autoregressive)
    → parameter optimizer (cross-attention). First end-to-end point→featured-CAD net; code open (Blice0415/P2CADNet).
  - **Point2Primitive:** argues SDF/implicit methods (incl. Point2CAD's freeform INR) cause **imprecise, hard-to-edit
    curved edges**; instead **directly predicts explicit parametric sketch primitives** (curve type + params) via a
    transformer decoder with position queries, plus extrusion segmentation (PointNet++). Higher primitive-prediction
    fidelity, **editable** output.
- **Takeaway:** These confirm a second, *parametric-program* target (sketch→extrude) that's more editable but only
  covers prismatic/extrudable parts — i.e. the same "analytic where possible" lesson, reached from the program side.
  Both fully ML; not a deterministic-tail source.

### DeepCAD / BrepGen — generative, for context (not reconstruction-from-mesh)
- **DeepCAD:** pioneered learning **sketch-and-extrude sequences**; limited to line/arc/circle sketches + extrude.
- **BrepGen:** **diffusion** model that synthesizes B-reps directly via **structured latent geometry** (face/edge
  embeddings from uniformly sampled parameter-space grids), handling complex curves/surfaces beyond sketch-extrude.
- **Relevance:** generative, not mesh→CAD; included only to show the **target B-rep representation** (faces+edges+
  parametric grids+topology) the field converges on. Not part of our deterministic pipeline.

### Survey & Benchmark of Automatic Surface Reconstruction from Point Clouds (arXiv 2301.13656)
- Splits the field into **classical/traditional** (handcrafted priors: implicit/Poisson, Delaunay/alpha-shape,
  RANSAC primitives — tedious hyperparameter tuning) vs **deep-learning** (learn surface/point priors from data).
- Benchmarks both on **geometric precision, topological consistency, robustness to noise/outliers/non-uniform/missing
  data**. Core lesson: **real scans are noisy**, classical priors need tuning, learned priors generalize better on
  messy data — but **classical methods remain the deterministic, no-training option** and are what produce the
  *analytic CAD* output (general dense-surface methods like Poisson give smooth meshes, **not** B-rep faces).
- **Takeaway:** justifies our deterministic-first stance for clean/synthetic-ish meshes while flagging that an
  optional ML segmentation front-end is the standard escape hatch for organic/noisy input.

---

## Part D — Commercial reference architecture (Geomagic Design X, Fusion 360)

### Geomagic Design X — the gold-standard conceptual workflow
1. **Acquire/import** scan → mesh.
2. **Mesh segmentation / region definition** — auto-partition the scan into regions; each region tagged as a CAD
   feature region or a freeform region.
3. **Region-group + surface fitting** — fit accurate surfaces per region; "Auto-Surface" fits a **NURBS solid body**
   over freeform regions; "selective surfacing" for the rest.
4. **Feature extraction → parametric CAD** — wizards extract analytic features (planes, holes, fillets, extrudes)
   from prismatic regions, producing an **editable, history-based** model.
- Mirrors the canonical 5 stages, and crucially distinguishes **prismatic regions → analytic features** from
  **organic regions → NURBS auto-surface**, i.e. the same two-track output we should support.

### Fusion 360 "Convert Mesh → BRep" — three modes = three fidelity tiers
- **Faceted:** one BRep face per mesh triangle (literal faceted shell). Hard cap (~50k facets; <10k recommended).
- **Prismatic:** **identifies flat + cylindrical faces** and **merges coplanar/co-cylindrical face groups** into
  single analytic faces — needs **coplanarity within tolerance** and **sharp edges** to find boundaries. Best for
  mechanical parts.
- **Organic:** converts to **T-splines** (requires Product Design Extension).
- Failure mode documented: detail/texture/organic shapes "**Compute Failed**" or produce **surfaces instead of a
  solid** — i.e. the sew-to-solid step fails when faces don't reconcile. (Direct evidence the **topology/sew tail is
  the hard, failure-prone part** — exactly our Area 1.)
- **Takeaway:** validates a **mode-tiered design**: faceted (always works) → prismatic/analytic (planes+cylinders,
  needs tolerance) → organic/freeform (NURBS/T-spline). And it confirms "merge co-surface face groups" + "sharp-edge
  boundary detection" as the practical segmentation heuristic for prismatic parts.

---

## Part E — The synthesized CANONICAL pipeline (what every mature approach shares)

```text
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ 0. PRECONDITION: clean mesh (manifold, oriented normals, fill tiny holes,     │  CLASSICAL
 │    weld dup verts, remove degenerate/sliver tris)                             │  (CGAL PMP / OCCT)
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 1. SEGMENTATION → one region per intended CAD face                            │  CLASSICAL (region
 │    classical: region growing on normal/curvature + coplanar face grouping;    │  growing / VSA / RANSAC)
 │    ML escape hatch: ParseNet / HPNet / SED-Net (organic, noisy input)         │  OR NEURAL
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 2. PER-REGION SURFACE FITTING — "fit all candidate types, keep simplest fit"  │  CLASSICAL for analytic
 │    plane (covariance eig), sphere (normal-eqn), cylinder (Powell),            │  primitives;
 │    cone (Lev-Marq); freeform → B-spline/NURBS (or INR/T-spline)               │  ML only for freeform INR
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 3. EDGE RECOVERY = intersect ADJACENT fitted surfaces (extend → intersect)    │  CLASSICAL
 │    (NOT the mesh's own boundary lines)                                         │  (OCCT GeomAPI_IntSS /
 │                                                                               │   BRepAlgoAPI_Section)
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 4. CORNER/VERTEX RECOVERY = intersect adjacent edges                          │  CLASSICAL
 ├─────────────────────────────────────────────────────────────────────────────┤
 │ 5. TRIM + TOPOLOGY + SEW + SOLIDIFY                                           │  CLASSICAL
 │    clip each surface to its edges/corners (drop unsupported via conn-comp);    │  (BRepBuilderAPI_MakeFace,
 │    sew trimmed faces → shell; heal gaps (ShapeFix); shell → SOLID; → STEP      │   Sewing, ShapeFix_*, STEP)
 └─────────────────────────────────────────────────────────────────────────────┘
```

### Classical/deterministic (REUSABLE for our pythonocc service) — the majority
- Mesh cleanup (stage 0).
- Analytic primitive **fitting** — closed-form/least-squares for plane/sphere, iterative for cylinder/cone
  (Point2CAD proves these are standard, deterministic, no training).
- **Stages 3, 4, 5 in full** — edge-by-intersection, corner-by-intersection, trim/sew/heal/solidify/STEP. This is
  the entire OCCT sweet spot (Area 1 + Area 3 of our spec) and is classical in *every* pipeline, even the ML ones.
- B-spline freeform **fitting** is classical too (GeomAPI_PointsToBSplineSurface / GeomPlate) — the INR/T-spline
  variants are the only freeform pieces that are ML.

### ML-only (NOT deterministic) — two sub-cases
**Within family (A), ML is optional and only at the front:**
- **Stage 1 segmentation** on organic/noisy meshes (ParseNet/HPNet/SED-Net) — the proven differentiator for messy
  input; everything downstream is still classical.
- **Freeform INR** surface fitting (Point2CAD) — optional, and Point2Primitive argues it hurts editability.

**Family (B) is ML end-to-end and is a different architecture (not our target):**
- Direct B-rep generation incl. learned topology (ComplexGen, BrepGen) — the topology tail is *inside* the network,
  so there is no deterministic OCCT tail to reuse.
- Sketch-and-extrude *program* reconstruction (P2CADNet / Point2Primitive / DeepCAD) — reconstructs a construction
  sequence, a different output than a fitted-surface B-rep; fully ML.

### Hard, universally-acknowledged failure point (design accordingly)
The **stage-3→5 topology reconciliation** (fitted regions whose boundaries don't coincide → must extend, intersect,
trim, sew, heal into a watertight solid) is the part that **breaks** in Fusion ("Compute Failed / surfaces not
solid"), that Point2CAD **defers to future work** for true analytic STEP, and that **no OSS tool has automated**.
**This is the load-bearing, novel-for-OSS part of our service** — and it is squarely the classical OCCT territory
our Area 1/Area 3 already targets.

---

## Sources

- https://github.com/FreeCAD/FreeCAD-documentation/blob/main/wiki/Reverse_Engineering_Workbench.md — FreeCAD RE WB official wiki: "no functionality present... sandbox"; only FitSurface (B-spline) documented.
- https://deepwiki.com/FreeCAD/FreeCAD/5.4-openscad-and-reverse-engineering — FreeCAD RE data flow (Points/Mesh::Feature → approximation engine → parametric shapes); region-growing + RANSAC.
- https://hackaday.com/2025/10/21/reverse-engineering-stl-files-with-freecad/ — practical FreeCAD STL RE workflow context.
- https://github.com/Danxtream/Mesh2CAD-Converter — planes+cylinders, region growing, faceted-STEP baseline, cylinder-after-plane dependency, proprietary, v1.1, ~10M tri cap.
- https://github.com/TheTesla/stl2step — segment→analytic STEP, planes only + hole support, experimental v0.1.2, no documented topology.
- https://github.com/DalessandroJ/PythonOCC-CAD-Converter — pythonocc batch format converter (not a reconstructor).
- https://github.com/yaneony/2STEP-Converter — pythonocc-core for sew/fix/STEP export (tail reference, not fitting).
- https://github.com/rdevaul/yapCAD — pythonocc-core OCCT integration, exact booleans, production STEP/STL/DXF export (kernel-tail reference).
- https://github.com/fuzemobi/MeshConverter — STL→primitives via voxelization/GPT-4 Vision (anti-pattern, non-analytic).
- https://arxiv.org/abs/2312.04962 — Point2CAD abstract: hybrid analytic-neural, freeform INR, "segment → fit → extend+intersect → topology emerges → clip."
- https://www.obukhov.ai/point2cad — Point2CAD project page: 3-phase (segment → fit → topology-by-extend-intersect-clip), code link.
- https://github.com/prs-eth/point2cad — Point2CAD code: inputs (x,y,z,s), ParseNet segmentation, unclipped/clipped/topo outputs, geomfitty fits, PyMesh/torch.
- https://raw.githubusercontent.com/prs-eth/point2cad/main/LICENSE — Point2CAD repo LICENSE = **Apache 2.0** (commercial use permitted; corrects a search-summary CC-BY-NC claim that refers to dataset/paper, not code).
- https://ar5iv.labs.arxiv.org/html/2312.04962 — Point2CAD full text: exact stage list + which are classical (plane eig / sphere normal-eqn / cylinder Powell / cone LM; edge=mesh intersection; corner=line intersection; trim=margins+conn-comp) vs neural (segmentation, freeform INR); STEP export = future work.
- https://arxiv.org/pdf/2205.14573 — ComplexGen: B-rep chain complex, network predicts elements + adjacency + topo optimization (end-to-end learned topology).
- https://dl.acm.org/doi/10.1145/3528223.3530078 — ComplexGen (TOG 2022) reference.
- https://www.researchgate.net/publication/359002172 — HPNet: deep primitive segmentation, hybrid representations (segmentation backbone).
- https://arxiv.org/abs/2310.02638 — P2CADNet: end-to-end point→featured-CAD; feature extractor + autoregressive sequence reconstructor + parameter optimizer; code open.
- https://arxiv.org/html/2505.02043 — Point2Primitive: direct explicit parametric primitive prediction; critiques SDF/INR for imprecise/uneditable curved edges; extrusion segmentation + transformer sketch decoder.
- https://arxiv.org/abs/2301.13656 — Survey & Benchmark of Automatic Surface Reconstruction: classical (Poisson/Delaunay/RANSAC, handcrafted priors) vs deep; benchmarks precision/topology/robustness to noise.
- https://arxiv.org/pdf/2401.15563 — BrepGen: diffusion B-rep generation, structured latent (param-space grid embeddings) — target-representation context.
- https://hexagon.com/products/geomagic-design-x — Geomagic Design X: auto/selective surfacing, mesh→NURBS solid, history-based parametric output.
- https://precise3dm.com/blogs/3d-reverse-engineering-workflow-in-geomagic-design-x-software/ — Geomagic stages: import → segmentation/region → region-group surface fit → feature extraction → parametric model.
- https://help.autodesk.com/view/fusion360/ENU/?guid=MESH-CONVERT-TO-SOLID — Fusion convert mesh→BRep: Faceted / Prismatic (merge flat+cylindrical face groups, needs coplanarity+sharp edges) / Organic (T-spline).
- https://autocadeverything.com/fusion-360-mesh-to-solid/ — Fusion facet caps (~50k, <10k recommended); organic shapes unlikely to convert.
- https://knowledge.autodesk.com/support/fusion-360/troubleshooting/caas/sfdcarticles/sfdcarticles/Surfaces-are-created-instead-of-a-solid-body-converting-a-Mesh-to-BRep-in-Fusion-360.html — Fusion "Compute Failed / surfaces instead of solid" = sew-to-solid failure (evidence topology tail is the hard part).
- https://doc.cgal.org/latest/Polygon_mesh_processing/index.html — CGAL PMP: repair/orientation/hole-fill/stitch/booleans/remesh (stage-0 cleanup building blocks; no native NURBS B-rep export).
