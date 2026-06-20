# Agent 2 Findings — Deterministic Primitive Detection (plane / cylinder / cone / sphere) from a Mesh WITH Normals

> Scope: reproducible (NON-randomized-RANSAC) detection of analytic primitives from a triangle mesh
> that carries per-vertex (or per-face) normals, plus maintained Python libraries usable alongside
> `pythonocc-core`. Target: a deterministic Python service feeding OCCT face construction.

---

## TL;DR / Recommendation

For a **deterministic** `pythonocc-core` backend, **do not depend on CGAL's Shape Detection / Region
Growing / Variational Shape Approximation** — those packages are **not exposed in any maintained Python
binding** (verified below). Instead build a small, self-contained, two-stage pipeline in **NumPy/SciPy
(+ trimesh for mesh I/O and `facets`)**:

1. **Deterministic segmentation by normal/Gauss-map clustering + region growing** (seed order fixed by a
   deterministic key, e.g. ascending vertex index or descending region-fit quality). Trimesh `facets`
   gives you planar regions for free, deterministically. Curved regions come from normal-coherence region
   growing.
2. **Closed-form / fixed-iteration least-squares primitive fits** per region, then pick the simplest
   primitive that fits within tolerance (plane → sphere → cylinder → cone), following the "increasing
   surface-type complexity" ordering of Besl & Jain used in Lukács et al.

Every fit below is either closed-form or a *fixed* deterministic iteration (no RNG, no random seeds),
so results are bit-reproducible. This makes the math the implementation spec — given in full in §3.

The only thing the libraries (pyransac3d, Open3D `segment_plane`) would buy you is RANSAC, which is the
exact thing the hard constraint forbids; both are non-deterministic unless you reimplement seeding.

---

## 1. Determinism & Python-availability table (the decisive evidence)

| Library / method | Detects plane | sphere | cylinder | cone | Deterministic? | Python? | Notes |
|---|---|---|---|---|---|---|---|
| **NumPy/SciPy closed-form fits** (this doc §3) | ✅ | ✅ | ✅ | ✅ | **Yes** (closed-form or fixed iteration) | ✅ (you write it) | The recommended core. No RNG. |
| **trimesh `.facets`** | ✅ (coplanar adjacent faces) | ❌ | ❌ | ❌ | **Yes** (graph grouping, no RNG) | ✅ native | Best deterministic planar segmenter; `facets`, `facets_normal`, `facets_origin`, `facets_area`. |
| **CGAL Region Growing** (C++) | ✅ point-set & **mesh** | ✅ point-set only | ✅ point-set only | ❌ | **Yes** (deterministic, unlike efficient-RANSAC) | **❌ NOT in SWIG bindings or scikit-geometry** (see §4) | Mesh variant is **planes-only**; sphere/cylinder are point-set only. |
| **CGAL Efficient RANSAC** (C++) | ✅ | ✅ | ✅ | ✅ + torus | **No** (randomized) | ❌ not in bindings | Forbidden by constraint anyway. |
| **CGAL VSA / Surface_mesh_approximation** (C++) | ✅ **planar proxies only** | ❌ | ❌ | ❌ | **Partly** — default seeding is random; result not fully reproducible w/o seed control | **❌ not in bindings** | Lloyd clustering; planar proxies only (position+normal). |
| **pyransac3d** | ✅ | ✅ | ✅ (unreliable) | ❌ (no cone) | **No** (RANSAC) | ✅ native | Maintainer: cylinder RANSAC "very unstable", "does NOT present good results on real data". No seed API. |
| **Open3D** | ✅ `segment_plane` only | ❌ | ❌ (`segment_cylinder` does not exist → AttributeError) | ❌ | **No** (RANSAC; users report differing coeffs across runs) | ✅ native | Plane only; randomized. |
| **point-cloud-utils (pcu)** | normals/sampling/distance/IO only | ❌ | ❌ | ❌ | n/a | ✅ native | **No primitive fitting.** Estimates normals (kNN/radius plane fit), sampling, Hausdorff/Chamfer. |
| **PyVista** | `fit_plane_to_points` only | ❌ | ❌ | ❌ | **Yes** (PCA/SVD plane) | ✅ native | Plane fit via PCA only; no curved primitives. |
| **libigl python (`igl`)** | ❌ (no primitive fitting) | ❌ | ❌ | ❌ | n/a | ✅ native | Geometry-processing ops (normals, Laplacian, curvature, geodesics). **No primitive/shape detection.** |

**Bottom line on libraries:** every maintained Python library that detects *curved* primitives
(pyransac3d, Open3D) does it with RANSAC (non-deterministic), and the one robust deterministic engine
(CGAL) is **not callable from Python**. Hence: self-implement (§3). trimesh/pcu/pyvista/igl are useful
*adjuncts* (mesh IO, normal estimation, deterministic planar facets) but none fits cylinders/cones/spheres.

---

## 2. Normal-based / Gauss-map classification (how primitives map onto the Gauss sphere)

The **Gauss map** sends each surface point to its unit normal, i.e. a point on the unit sphere S². For the
four analytic types the image is characteristic, which is what makes normal-based detection both a
*classifier* and a *fitter*:

- **Plane** → a **single point** on S² (all normals identical). The Gauss image is 0-dimensional
  ("point-form" cluster).
- **Cylinder** → a **great circle** on S² (1-dimensional, "curve-form"). All normals are perpendicular to
  the axis **W**, so they lie in the plane through the origin with normal **W**; their intersection with
  S² is the great circle ⟂ **W**. ⇒ **the cylinder axis is the normal of the best-fit plane through the
  normal vectors.**
- **Cone** (half-angle α, axis **W**) → a **small circle** on S² at angular distance (π/2 − α) from **W**
  (1-dimensional). Normals make a constant angle with the axis. Fitting a *plane* (through the origin) to
  the normals still recovers a direction parallel to **W** as that plane's normal; the offset of the
  small circle's supporting plane from the origin encodes α.
- **Sphere** → covers a **2-dimensional patch** of S² (the normal at point **X** is (**X**−**C**)/r, so
  the Gauss image is an "area-form" cluster; for a full sphere it is all of S²).

This 0/1/2-dimensional classification of Gauss-sphere clusters into **point-form / curve-form / area-form**
is the basis of deterministic normal-clustering segmentation (Yan-type Gaussian-map segmentation): cluster
normals on S², measure the intrinsic dimension of each cluster to *propose* the primitive type, then run the
exact least-squares fit (§3) to *confirm* and parameterize. (Sources: Liu/Yan Gaussian-map segmentation;
"Segmentation methods for smooth point regions of conventional engineering objects".)

---

## 3. The exact least-squares fits (codeable math)

Conventions: points **Xᵢ** (i = 1..n) in a region, optional unit normals **Nᵢ**. **A** = centroid
(1/n)Σ**Xᵢ**. "Covariance" C = Σ(**Xᵢ**−**A**)(**Xᵢ**−**A**)ᵀ. SVD/eigendecomposition is deterministic.
Primary source for the linear/closed-form fits: **Eberly, "Least Squares Fitting of Data by Linear or
Quadratic Structures" (Geometric Tools)**; the geometric-distance framework and the
plane→sphere→cylinder→cone *ordering* from **Lukács, Marshall & Martin, "Faithful Least-Squares Fitting…"**.

### 3.1 Plane (and line) — covariance eigenvector (closed form, deterministic)

Center the points, form C = Σ diff·diffᵀ (diff = **Xᵢ** − **A**), eigendecompose C with eigenvalues sorted
nondecreasing.
- **Plane**: normal = eigenvector of the **smallest** eigenvalue; the plane passes through **A**. (This is
  total-least-squares / orthogonal regression — minimizes Σ(orthogonal distance)².)
- **Line**: direction = eigenvector of the **largest** eigenvalue, through **A**.
- Fit residual / planarity = smallest eigenvalue (mean square orthogonal distance after /n).

This is Eberly Listing 6 (`FitOrthogonalFlat`) and exactly what trimesh `facets` / PyVista
`fit_plane_to_points` do.

### 3.2 Sphere — closed-form linear fit ("differences of squared lengths"), no iteration

Minimize E(**C**,r²) = Σ(|**C**−**Xᵢ**|² − r²)². Setting ∂E/∂r² = 0 gives r² = (1/n)Σ|**C**−**Xᵢ**|²
(radius² = mean squared distance to center). Substituting and using **A** = mean, **Yᵢ** = **Xᵢ** − **A**,
the center is the **closed-form linear solution** (Eberly eqn 49):

```
C = A + (1/2) ( Σ Yᵢ Yᵢᵀ )⁻¹ ( Σ (YᵢᵀYᵢ) Yᵢ )          # 3×3 linear solve, fully deterministic
r = sqrt( (1/n) Σ |Xᵢ − C|² )
```

(`Σ Yᵢ Yᵢᵀ` is 3×3; invert/solve once. This is non-iterative and bounded-time.) Singular matrix ⇒ points
are coplanar ⇒ reject sphere (it would be a plane / infinite radius).

There is also a "differences of lengths" geometric-distance variant (Eberly eqn 36–38) solved by a *fixed*
fixed-point iteration **C₀ = A; Cᵢ₊₁ = A + L̄·Ū** (L̄ = mean distance, Ū = mean of unit vectors
(**C**−**Xᵢ**)/|·|) — also deterministic. Prefer the closed form (eqn 49) for speed; it is "faithful"
(stable as curvature → 0, degrading gracefully toward a plane).

**Sphere from normals (alternative, if normals are trustworthy):** every surface normal line passes through
the center, so **C** is the least-squares intersection of the lines **Xᵢ** + t**Nᵢ**. Minimizing
Σ ‖(I − **NᵢNᵢᵀ**)(**C** − **Xᵢ**)‖² gives the normal-equations 3×3 linear system

```
( Σ (I − Nᵢ Nᵢᵀ) ) C = Σ (I − Nᵢ Nᵢᵀ) Xᵢ      # solve 3×3, deterministic
```

This is the "line-intersection" form and is the cheapest when normals are reliable.

### 3.3 Cylinder — axis **W**, point **C** on axis, radius r (Eberly §7, eqns 73–99)

Parameterize: axis line through **C** with unit direction **W**; projection matrix **P = I − WWᵀ**;
rᵢ² = (**C**−**Xᵢ**)ᵀ**P**(**C**−**Xᵢ**). Error E = Σ(rᵢ² − r²)². The clean result: **once W is fixed,
both the center and radius are closed-form**, so the only real unknown is the 2-DOF direction **W**.

Precondition by subtracting the mean (set Σ**Xᵢ** = 0). For a given **W**:
- Radius: r² = (1/n) Σ rᵢ² (eqn 79).
- Center (the component ⟂ **W**): with skew matrix **S** of **W** and
  Â = **S** A **Sᵀ** where A = **P**(1/n Σ **XᵢXᵢᵀ**)**P**,

```
PC = Â / Trace(Â·A) · ( (1/n) Σ (Xᵢᵀ P Xᵢ) Xᵢ )      # eqn 92, closed form given W
```

- **Direction W** is found by minimizing the scalar function **G(W)** = (1/n)Σ(rᵢ²−r²)² (eqn 94), which
  Eberly reduces to a rational polynomial in the components of **W** (eqns 95–99) so it can be evaluated
  cheaply. **Make it deterministic by sampling W over a fixed hemisphere grid** (the sample code partitions
  (s₀,s₁) ∈ [0,2π)×[0,π/2] into a fixed grid and takes the argmin) — *no RNG* — optionally polishing the
  best grid point with a few fixed Gauss–Newton/Levenberg–Marquardt steps. With reliable normals you do
  not even need the grid: seed **W** from the **Gauss-map plane fit of the normals** (§2: axis = normal of
  the best-fit plane through {**Nᵢ**}), then polish. The pure covariance-eigenvector seed (largest
  eigenvalue of Σ**XᵢXᵢᵀ**) is also available (§7.6) but Eberly warns it can be poor for short cylinder
  sections — the **normal-based seed is preferred**.

Practical deterministic recipe: **W₀ = unit normal of plane fit to {Nᵢ}** (great-circle ⇒ axis); then
solve eqn 92 for **C**, eqn 79 for r; optionally 3–5 LM steps minimizing G. Reproducible end to end.

### 3.4 Cone — axis **W**, apex **V**, half-angle α (deterministic)

The full cone fit is a **6-parameter nonlinear least squares** (apex **V** + axis-vector
**Û** = **U**/cos θ), minimizing E = (1/n)Σ F(**Xᵢ**)², F = **Δᵀ**(I − **Û Ûᵀ**)**Δ**, **Δ** = **X**−**V**
(Eberly eqns 102–107), solved by Gauss–Newton / Levenberg–Marquardt. LM with a fixed starting point and
fixed iteration count is deterministic. The work is getting a good **initial axis** without RNG; two
deterministic options, depending on whether you trust normals:

**(a) Point-based initial axis — Eberly §8.1/§8.2 (the authoritative method).** Eberly deliberately
*avoids* eigenvalue selection (for a true cone the point covariance **ZZᵀ** has a single eigenvalue of
multiplicity 1 along the axis and a doubled one, so "which eigenvector is the axis" is numerically
unreliable). Instead, with C̄ = mean(**Xᵢ**) and **Zᵢ** = **Xᵢ** − C̄, the axis is obtained from the
**third moment** (eqn 120 / Listing 18):

```
U = normalize( Σᵢ Zᵢ (Zᵢᵀ Zᵢ) )      # third-moment direction; sign may need flipping (use −U) — deterministic
```

Then (Listing 19) project points onto the axis line C̄ + t·**U**, fit a line to (signed height hᵢ, radial
distance) pairs to get the **cone angle** θ, decide the axis sign, and back out the **apex V** from where
that line's radius → 0. Feed **V**, **Û** = **U**/cos θ into the LM refinement.

**(b) Normal-based initial axis (when normals are reliable; consistent with §2).** A cone's normals form a
**small circle on S² that is offset from the origin** (N·**W** = −sin α, constant ≠ 0), so fitting a plane
*through the origin* to {**Nᵢ**} does **not** give the axis. Use the **centered** normal scatter: with
N̄ = mean(**Nᵢ**), **W** = eigenvector of the **smallest** eigenvalue of Σ(**Nᵢ**−N̄)(**Nᵢ**−N̄)ᵀ (the
small circle is planar, so its in-plane spread dominates and the out-of-plane eigenvector is the axis), and
the **half-angle comes for free**: α = arcsin(|N̄|) (since each normal's component along **W** is the
constant −sin α, the mean normal has length sin α). This is self-consistent with the §2 Gauss-map picture.

**Apex (refinement / normals form).** Every tangent plane (point **Xᵢ**, normal **Nᵢ**) passes through the
apex, so **V** is the least-squares intersection of those planes — solve the 3×3 normal equations

```
( Σ Nᵢ Nᵢᵀ ) V = Σ (Nᵢ · Xᵢ) Nᵢ        # multi-tangent-plane LSQ intersection, deterministic
```

(equivalently, intersect the normal lines' supporting tangent planes). Use this as the apex when normals
are good; otherwise take **V** from option (a).

All initializers are closed-form linear/eigensolves; the LM polish is fixed-iteration → **deterministic**.
(Point-based axis = Eberly §8.1 eqn 120 / §8.2 Listings 18–19; the centered-normal-scatter axis with
α = arcsin|N̄| and the apex tangent-plane intersection are the normal-based equivalents, standard in
SPFN/ParseNet primitive fitting.)

### 3.5 Kåsa circle fit (used for cylinder radius after projecting onto the plane ⟂ axis)

After projecting region points onto the plane ⟂ **W**, the projections lie on a circle of radius r. The
**Kåsa fit** is a one-shot linear least squares: with 2D projected points (uⱼ,vⱼ), solve for (a,b,c) in

```
[ Σu²  Σuv  Σu ] [a]   [ Σu(u²+v²) ]
[ Σuv  Σv²  Σv ] [b] = [ Σv(u²+v²) ]      # 3×3 linear, deterministic (algebraic LSQ)
[ Σu   Σv   n  ] [c]   [ Σ(u²+v²)  ]
```

then center = (a/2, b/2), radius = sqrt(c + (a²+b²)/4). Kåsa is biased for short arcs but is the standard
deterministic cross-check for the cylinder radius (Eberly's circle pseudocode §5.2.2 derives the same
algebraic circle fit). Use it as a redundant/initial radius; prefer eqn 79 as the final value.

---

## 4. CGAL Region Growing — deterministic, but NOT callable from Python (resolved definitively)

**Algorithm (deterministic).** Region Growing iterates: pick the next available item (deterministic order)
→ find its neighbors (kNN or fuzzy `sphere_radius`) → include neighbors that satisfy the region
requirements → recurse → start a new region when none satisfy. CGAL's own user manual states Region Growing
is **deterministic and reproducible, unlike Efficient RANSAC** which uses randomized sampling. This is the
property we want.

**Parameters** (exact names from CGAL docs):
- Neighborhood: `sphere_radius` (fuzzy-sphere search) **or** `k_neighbors` (kNN).
- Region validation: `maximum_distance` (max point-to-primitive distance), `maximum_angle` (deg, between
  point normal and primitive normal), `minimum_region_size` (min #points).

**Region/fit classes available:** `Least_squares_line_fit_region`, `Least_squares_circle_fit_region`
(2D); `Least_squares_plane_fit_region`, `Least_squares_sphere_fit_region`, `Least_squares_cylinder_fit_region`
(3D point sets). Sorting variants (`*_fit_sorting`) order seeds by fit quality → makes seeding
deterministic-by-quality.

**CRITICAL CAVEATS for our use case:**
1. On a **polygon mesh** (`FaceListGraph`), CGAL Region Growing detects **planes only**. Sphere/cylinder
   region growing exist **only for point sets** (`Point_set_3`), not for meshes. So even in C++ you'd run
   it on the mesh *vertices as a point set*, not on the faces, to get curved primitives.
2. CGAL has **no cone region-growing** at all (cones only via Efficient RANSAC, which is randomized).

**Python availability — DEFINITIVE.** Two routes, both negative:
- **CGAL SWIG bindings** (`CGAL/cgal-swig-bindings`): the wrapped-package list is —
  Kernel, 2D/3D Triangulations, 2D Alpha Shapes, 2D/3D Convex Hulls, dD Spatial Searching, 3D AABB Tree,
  3D Polyhedral Surfaces, 2D Conforming Triangulations/Meshes, 3D Surface Mesh Generation, 3D Mesh
  Generation, Function Interpolation, 2D Voronoi Adaptor, Halfedge DS, **Point Set Processing**, Box
  Intersection, **Polygon Mesh Processing**, 2D Polyline Simplification, **Advancing Front Surface
  Reconstruction**, **3D Alpha Wrapping**. **Shape Detection / Region Growing / Point Set Shape Detection /
  Surface Mesh Approximation are NOT in the list.** (Issue #150 separately shows even the deprecated
  `Shape_detection_3::Region_growing` binding attempt broke on a CGAL upgrade and is unresolved/open.)
- **scikit-geometry**: "exposes only a small fraction of the rich API of CGAL"; shape detection / region
  growing is **not** among the exposed packages.

⇒ To use CGAL Region Growing from Python you would have to **write your own pybind11/SWIG wrapper around
the C++ header** and ship CGAL as a native build dependency — heavy, and it still wouldn't give you cones.
This is the decisive reason to self-implement (§3) for a `pythonocc-core` service.

---

## 5. Variational Shape Approximation (VSA / Cohen-Steiner) and CGAL Surface_mesh_approximation

VSA (Cohen-Steiner, Alliez & Desbrun 2004) partitions a mesh into clusters, each approximated by a **proxy**,
via **Lloyd-style iterations** alternating *partition* (assign each face to nearest proxy) and *fit*
(recompute proxy from its region) until error converges or max iterations.

- **Metrics:** L² (Euclidean, point-to-proxy-plane) and **L²,¹** (normal-based; recommended — better
  anisotropy, cheaper).
- **Proxies are PLANAR ONLY** in CGAL's `Surface_mesh_approximation` (proxy = position + normal). It does
  **not** fit cylinders/spheres/cones — only piecewise-planar approximation. (General-quadric VSA exists in
  the literature — Wu & Kobbelt 2005 cylinders/spheres, Yan et al. 2006 quadrics — but **not** in CGAL.)
- **Determinism:** seeding = random / incremental / **hierarchical (default)**. The random component means
  results are **not fully deterministic** unless seeds are fixed; incremental/hierarchical reduce but don't
  guarantee reproducibility across builds. So VSA is *weaker* than Region Growing on the determinism axis.
- **Output:** full meshing (anchors on region boundaries + constrained Delaunay triangulation), parameters
  `max_number_of_proxies`, `min_error_drop`, `number_of_iterations`, `subdivision_ratio`, `seeding_method`.
- **Python:** **not in the SWIG bindings** (see §4 list) and not in scikit-geometry.

**Verdict:** VSA is appealing for clean planar partitioning but (a) planar-only in CGAL, (b) not fully
deterministic, (c) no Python binding. Not the right tool here; trimesh `facets` covers the planar case
deterministically and natively.

---

## 6. Why these libraries don't change the recommendation

- **pyransac3d** (native Python): fits plane/sphere/cylinder/cuboid/line/circle but is **RANSAC**
  (non-deterministic, no seed API exposed); maintainer states the **cylinder fit is "very unstable" and
  "does NOT present good results on real data"**, recommending adding normals — i.e. exactly the
  normal-based approach in §3 that you'd implement directly anyway.
- **Open3D** (native): `segment_plane` only (RANSAC, users report differing coefficients run-to-run);
  **no `segment_cylinder`** (AttributeError). Plane-only and randomized.
- **point-cloud-utils**: **no primitive fitting** — only normal estimation (kNN/radius plane fit),
  sampling, Hausdorff/Chamfer, mesh IO. Useful only as a normal estimator.
- **PyVista**: `fit_plane_to_points` (PCA/SVD, deterministic) — plane only.
- **libigl python (`igl`)**: geometry processing (normals, Laplacian, curvature, geodesics) — **no shape
  detection / primitive fitting**.
- **trimesh**: `.facets` = groups of **coplanar adjacent faces** (+ `facets_normal/origin/area`),
  computed by face-adjacency graph grouping (no RNG) → **deterministic planar segmentation, native, free.**
  This is the one to actually use for the planar stage.

---

## 7. Concrete deterministic pipeline recommendation (for the pythonocc-core backend)

1. **Mesh IO + normals:** trimesh (and/or point-cloud-utils for robust normal estimation if the mesh lacks
   them).
2. **Planar regions:** trimesh `.facets` (deterministic) → each facet group is a candidate **plane**
   (parameterize via §3.1 covariance fit on its vertices/centroids).
3. **Curved regions:** deterministic **region growing over remaining faces** keyed by ascending face index
   (or by descending local-fit quality, à la CGAL `*_fit_sorting`), merging faces whose normals are
   coherent (Gauss-map proximity / `maximum_angle` test). Optionally pre-cluster normals on S² (§2) to
   propose type (point/curve/area-form).
4. **Fit + classify each region (simplest-first):** try **plane (3.1) → sphere (3.2) → cylinder (3.3) →
   cone (3.4)**; accept the lowest-complexity primitive whose max/mean residual is within tolerance
   (the Lukács/Besl-Jain ordering). Use normal-based seeds (Gauss-map plane-of-normals for cylinder/cone
   axis; normal-line intersection for sphere center) so fits are both fast and seed-free.
5. **Hand parameters to OCCT** (Agent 3's area): `Geom_Plane`, `Geom_SphericalSurface`,
   `Geom_CylindricalSurface`, `Geom_ConicalSurface`, then trim.

All steps are RNG-free → **bit-reproducible**, satisfying the hard constraint, with zero dependence on
unavailable CGAL Python bindings.

---

## Sources

- https://doc.cgal.org/latest/Shape_detection/index.html — CGAL Shape Detection user manual; Region Growing algorithm, parameters (`maximum_distance`, `maximum_angle`, `minimum_region_size`, `sphere_radius`, `k_neighbors`), and explicit statement that Region Growing is deterministic/reproducible vs randomized Efficient RANSAC; mesh region growing is planes-only; sphere/cylinder fit-region classes are point-set only.
- https://doc.cgal.org/latest/Shape_detection/group__PkgShapeDetectionRG.html — Region Growing reference; `Least_squares_{plane,sphere,cylinder}_fit_region` and `*_fit_sorting` classes.
- https://www.cgal.org/2019/07/30/Shape_detection/ — blog: efficient-RANSAC (5 shapes incl. cone/torus) vs deterministic Region Growing distinction.
- https://github.com/CGAL/cgal-swig-bindings/issues/150 — deprecated `Shape_detection_3::Region_growing` binding broke on CGAL upgrade; issue open, no maintainer fix → not usable.
- https://github.com/cgal/cgal-swig-bindings/wiki — SWIG bindings wiki; "Available CGAL Packages" — wrapped list does NOT include Shape Detection / Region Growing / Surface Mesh Approximation (confirmed via Package_wrappers_available).
- https://arxiv.org/pdf/2202.13889 — Goren, Fogel, Halperin "CGAL Made More Accessible": scikit-geometry "exposes only a small fraction" of CGAL; SWIG bindings cover a "limited range" — corroborates the binding gap.
- https://doc.cgal.org/latest/Surface_mesh_approximation/index.html — VSA: Lloyd iterations, L²/L²,¹ metrics, planar-proxy-only, random/incremental/hierarchical seeding (not fully deterministic), parameters, meshing/anchors.
- https://www.cgal.org/2019/01/29/VSA/ — VSA package announcement (Cohen-Steiner method).
- https://www.geometrictools.com/Documentation/LeastSquaresFitting.pdf — Eberly: closed-form sphere fit (eqn 49) and iterative geometric form (eqn 36–38); cylinder fit eqns 73–99 (axis W, center eqn 92, radius eqn 79, direction via G(W) hemisphere sampling — deterministic); cone fit §8 (6-param nonlinear LSQ eqns 102–107; point-based axis initializer via third moment eqn 120/Listing 18; apex+angle Listing 19 — explicitly avoids unreliable eigenvalue selection); plane/line via covariance eigenvector (Listing 6); circle/Kåsa algebraic fit §5.2.2.
- https://link.springer.com/content/pdf/10.1007/BFb0055697.pdf — Lukács, Marshall & Martin, "Faithful Least-Squares Fitting of Spheres, Cylinders, Cones and Tori": geometric-distance LSQ framework (eqns 1–4), recover-and-select segmentation (area / error-of-fit / quality / surface-type), simplest-surface-first ordering (Besl & Jain) — the classification policy used in §7.
- https://www.sciencedirect.com/science/article/abs/pii/S0010448508000419 — "Automatic segmentation of unorganized noisy point clouds based on the Gaussian map": Gauss-sphere clusters as point-form / curve-form / area-form (0/1/2-D) → primitive-type proposal (§2).
- https://www.sciencedirect.com/science/article/abs/pii/S0010448503001593 — "Segmentation methods for smooth point regions of conventional engineering objects": axis of surface-of-revolution via least-squares penalty (normals coplanar with axis) → cylinder/cone axis recovery.
- https://onlinelibrary.wiley.com/doi/10.1155/2018/8904653 — Wu 2018, fast cylinder fitting using point-cloud normals: cylinder axis from least-squares on normals (normals ⟂ axis), then circle LSQ for radius — corroborates §3.3 normal-based seed.
- https://github.com/leomariga/pyRANSAC-3D — pyransac3d: plane/sphere/cylinder/cuboid/line/circle, RANSAC (non-deterministic), no cone.
- https://github.com/leomariga/pyRANSAC-3D/issues/13 — maintainer: cylinder RANSAC "very unstable", "does NOT present good results on real data", suggests using normals.
- https://www.open3d.org/docs/release/python_api/open3d.geometry.PointCloud.html — Open3D `segment_plane` (RANSAC); no `segment_cylinder`.
- https://github.com/isl-org/Open3D/issues/7270 — `segment_plane` gives random/differing results across runs (non-deterministic without seed control).
- https://github.com/isl-org/Open3D/issues/6602 — feature request: Open3D has no RANSAC cylinder fitting.
- https://trimesh.org/trimesh.base.html — trimesh `.facets` (coplanar adjacent face groups), `facets_normal`, `facets_origin`, `facets_area`.
- https://deepwiki.com/mikedh/trimesh/6-mesh-analysis-and-processing — trimesh facets via face-adjacency graph grouping (deterministic), useful for CAD planar features.
- https://github.com/fwilliams/point-cloud-utils — pcu: normal estimation (kNN/radius plane fit), sampling, distances, IO; no primitive fitting.
- https://docs.pyvista.org/api/utilities/_autosummary/pyvista.fit_plane_to_points — PyVista plane fit via PCA (deterministic), plane only.
- https://libigl.github.io/libigl-python-bindings/ — libigl python: geometry processing (normals, Laplacian, curvature), no shape/primitive detection.
- https://arxiv.org/pdf/1811.08988 — SPFN "Supervised Fitting of Geometric Primitives to 3D Point Clouds": cone axis = normal of plane through point-normals; apex = multi-tangent-plane LSQ intersection; half-angle = averaged angle — corroborates §3.4.
