# Expanded Searches — Deterministic Mesh→B-rep (STEP) Reconstruction with Curved Surfaces (pythonOCC / OpenCASCADE)

> Purpose: a comprehensive, de-duplicated set of web-search queries for downstream Research Agents.
> Target backend: a Python service using **pythonocc-core** (OpenCASCADE / OCCT) that takes a triangle mesh
> (WITH per-vertex normals) and produces a watertight **SOLID** exported as **STEP**, recovering analytic
> faces (plane / cylinder / cone / sphere) and freeform BSpline faces where needed.
> Hard constraint: **deterministic / reproducible** detection (avoid randomized RANSAC where possible).
>
> Discovery searches already run by the QueryExpander confirmed the canonical names used below
> (OCCT class names, paper/library names). Each area lists precise queries plus discovered key terms.

---

## Area 1 — Topology / shared-edge problem (watertight SOLID from fitted faces)

Producing a watertight SOLID when smooth analytic faces are fitted region-by-region and their fitted
boundaries do NOT coincide with neighbors. Core sub-problems: extending and intersecting adjacent
analytic surfaces to derive the shared trimmed edge; sewing trimmed faces into a shell; healing gaps;
promoting a closed shell to a solid; setting OCCT sewing/healing tolerances correctly.

1. `OpenCASCADE BRepBuilderAPI_Sewing tolerance non-manifold faces shell from trimmed faces`
2. `OCCT ShapeFix_Shell ShapeFix_Solid convert sewed shell to closed solid BRepBuilderAPI_MakeSolid`
3. `OpenCASCADE Shape Healing ShapeFix_Shape ShapeUpgrade gaps tolerance reverse engineering watertight`
4. `reverse engineering B-rep topology reconstruction intersect adjacent fitted surfaces shared edge`
5. `surface-surface intersection trimming curve between fitted analytic faces CAD gaps overlaps common edge`
6. `"Algorithms for reverse engineering boundary representation models" topology edge vertex from fitted surfaces`
7. `local topological beautification reverse engineered model edge blend vertex consistency`
8. `OCCT BRepAlgoAPI_Section GeomAPI_IntSS intersection curve between two surfaces build trimmed edge`
9. `mesh to BREP watertight solid sewing tolerance manifold check ShapeAnalysis_FreeBounds open edges`

**Key terms / names discovered:** BRepBuilderAPI_Sewing, BRepOffsetAPI_Sewing, ShapeUpgrade_ShellSewing,
ShapeFix_Shell, ShapeFix_Solid, ShapeFix_Shape, ShapeBuild_ReShape, ShapeAnalysis_FreeBounds,
GeomAPI_IntSS, BRepAlgoAPI_Section, "Shape Healing" (OCCT user guide); reverse-engineering B-rep topology
via "extend and intersect" analytic surfaces; topological beautification.

---

## Area 2 — Deterministic primitive detection (plane / cylinder / cone / sphere) from a mesh WITH normals

Avoid randomized RANSAC for reproducibility. Prefer normal-based / Gaussian-sphere methods, deterministic
**region growing** segmentation, **Variational Shape Approximation (VSA)**, and least-squares primitive
fitting. Also catalog maintained Python libraries that pair well with pythonocc-core.

1. `deterministic primitive segmentation mesh region growing planes cylinders cones spheres normals reproducible`
2. `CGAL Shape Detection region growing planes cylinders spheres least squares fit point set normals`
3. `CGAL Triangulated Surface Mesh Approximation Variational Shape Approximation VSA proxies planar`
4. `Variational Shape Approximation Cohen-Steiner Alliez 2004 proxies cylinders spheres quadrics Wu Kobbelt Yan`
5. `Gaussian sphere normal clustering segmentation extract cylinder cone axis from mesh normals`
6. `Schnabel efficient RANSAC point cloud shape detection plane cylinder cone sphere torus determinism seed`
7. `least squares cylinder fit axis radius from points and normals; cone apex half-angle sphere center fit`
8. `trimesh facets coplanar grouping; Open3D segment_plane; libigl python normal-based segmentation primitive`
9. `python point cloud primitive fitting library pyransac3d Open3D point-cloud-utils pyvista trimesh reproducible`
10. `region growing curvature normal-deviation segmentation FreeCAD "Segmentation From Best-Fit Surfaces" parameters`
11. `CGAL Shape Detection region growing Python bindings availability SWIG pybind11 scikit-geometry CGAL-python callable`

**Key terms / names discovered:** CGAL `Shape_detection` (Region Growing: least-squares plane/sphere/cylinder
fit region types; FaceListGraph region types for meshes); CGAL `Surface_mesh_approximation` (VSA);
Cohen-Steiner & Alliez VSA (CAD04), Wu & Kobbelt 2005 (cylinders/spheres), Yan et al. 2006 (quadrics);
Schnabel efficient RANSAC (for contrast); trimesh "facets"; Open3D `segment_plane`; pyransac3d; libigl/igl;
pyvista; point-cloud-utils; Gaussian-sphere / normal clustering for axis recovery.

---

## Area 3 — pythonOCC / OpenCASCADE: building trimmed analytic faces and freeform BSpline faces

Construct `Geom_Plane`/`Geom_CylindricalSurface`/`Geom_ConicalSurface`/`Geom_SphericalSurface` and trim
them to non-rectangular UV regions; fit freeform BSpline surfaces from scattered (non-grid) points; handle
periodic seams; build p-curves so non-planar faces are valid.

1. `pythonocc-core Geom_CylindricalSurface Geom_ConicalSurface Geom_SphericalSurface BRepBuilderAPI_MakeFace trim`
2. `OpenCASCADE BRepBuilderAPI_MakeFace from surface and wire non-rectangular UV trimming face boundary`
3. `GeomAPI_PointsToBSplineSurface TColgp_Array2OfPnt grid requirement degree continuity tolerance pythonocc`
4. `OpenCASCADE fit BSpline surface scattered unorganized points GeomPlate_BuildPlateSurface GeomFill_AppSurf`
5. `BRepOffsetAPI_MakeFilling from edges and interpolation points continuity G1 G2 stability pythonocc`
6. `OpenCASCADE periodic cylindrical sphere surface seam UV parameter face wrap-around handling SetUResolution`
7. `OCCT BRepLib::BuildCurves3d ShapeFix_Face FixMissingSeam add pcurve non-planar face valid edge on surface`
8. `pythonocc create trimmed cylinder face from edges project boundary to UV ShapeFix_Wire p-curve`
9. `OpenCASCADE GeomPlate constrained surface fitting interior points boundary curves freeform patch`

**Key terms / names discovered:** Geom_Plane / Geom_CylindricalSurface / Geom_ConicalSurface /
Geom_SphericalSurface; BRepBuilderAPI_MakeFace (surface + wire); GeomAPI_PointsToBSplineSurface (needs
TColgp_Array2OfPnt grid; degree 3–8, GeomAbs_C0/G1/G2); BRepOffsetAPI_MakeFilling (edges + interpolation
points, "not very stable in complex cases"); GeomPlate_BuildPlateSurface; GeomFill_AppSurf;
BRepLib::BuildCurves3d; ShapeFix_Face (FixMissingSeam / FixAddNaturalBound); ShapeFix_Wire; p-curves.

---

## Area 4 — Existing open-source mesh→CAD/STEP pipelines, end-to-end

Catalog working pipelines and reference papers that go from STL/mesh/point-cloud all the way to STEP with
analytic + freeform surfaces, so the design can borrow architecture and pitfalls.

1. `FreeCAD Reverse Engineering Workbench mesh to parametric shape region growing RANSAC primitives workflow`
2. `github STL to STEP converter analytic surfaces detect planes cylinders pythonocc (stl2step, Mesh2CAD-Converter)`
3. `CGAL polygonal surface mesh to B-rep / polyhedron to NURBS reverse engineering pipeline`
4. `Point2CAD reverse engineering CAD from point clouds freeform implicit neural surface topology github prs-eth`
5. `ComplexGen / SED-Net / HPNet / ParseNet point cloud CAD surface segmentation reconstruction comparison`
6. `P2CADNet Point2Primitive end-to-end parametric CAD model reconstruction from point cloud`
7. `Geomagic Design X / Fusion 360 reverse engineering auto-surface fit-to-mesh workflow analytic patches`
8. `survey automatic surface reconstruction from point clouds B-rep STEP benchmark methods comparison`
9. `BrepGen / DeepCAD B-rep generative model structured latent geometry CAD construction sequence`

**Key terms / names discovered:** FreeCAD Reverse Engineering Workbench + Mesh Workbench "Segmentation"
and "Segmentation From Best-Fit Surfaces"; GitHub: `TheTesla/stl2step`, `Danxtream/Mesh2CAD-Converter`,
`DalessandroJ/PythonOCC-CAD-Converter`, `rdevaul/yapCAD`; Point2CAD (prs-eth, CVPR 2024, arXiv 2312.04962);
ComplexGen, SED-Net, HPNet, ParseNet (segmentation backbones); P2CADNet (arXiv 2310.02638), Point2Primitive
(arXiv 2505.02043); BrepGen (arXiv 2401.15563), DeepCAD; "A Survey and Benchmark of Automatic Surface
Reconstruction from Point Clouds" (arXiv 2301.13656).
