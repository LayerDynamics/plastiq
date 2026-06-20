# Agent 3 Findings — pythonOCC / OpenCASCADE: Trimmed Analytic Faces & Freeform BSpline Faces

> Scope (Area 3): Concrete pythonOCC class/method sequences for (a) building **trimmed analytic
> faces** (cylinder / cone / sphere / plane) from a region's points & boundary, (b) the **p-curve
> requirement** for non-planar faces, (c) fitting **freeform BSpline faces from scattered points**,
> and (d) **tolerance / sewing-compatibility** of the produced faces. All API names are OCCT/OCC.Core
> names as exposed by `pythonocc-core` (module `OCC.Core.*`). Verified against OCCT class refs,
> forum threads, and pythonocc demos/wrappers — see `## Sources`.

---

## 0. TL;DR decision rules (read this first)

| Region type | Build with | Why |
|---|---|---|
| Plane / cylinder / cone / sphere, **rectangular** UV patch | `BRepBuilderAPI_MakeFace(surf, umin, umax, vmin, vmax, tol)` | Fast, exact; OCCT auto-builds the 4 seam/boundary edges WITH p-curves. |
| Plane / cylinder / cone / sphere, **non-rectangular** boundary (the real case from a mesh region) | Build a `TopoDS_Wire` of edges that carry **p-curves** on the surface, then `BRepBuilderAPI_MakeFace(surf, wire, Inside=True)` | The 5-arg ctor can only make a rectangular patch. Real region boundaries are arbitrary closed loops in UV. |
| Freeform region, **scattered** (non-grid) mesh points | `BRepOffsetAPI_MakeFilling` (boundary edges + interior `gp_Pnt` constraints) **or** `GeomPlate_BuildPlateSurface` + `GeomPlate_PointConstraint` → `GeomPlate_MakeApprox` | These are the only OCCT paths that accept unstructured point constraints. |
| Freeform region resampled to a **structured grid** (rows × cols) | `GeomAPI_PointsToBSplineSurface(TColgp_Array2OfPnt, ...)` | REQUIRES a rectangular `Array2` grid — cannot take raw scattered points. |

**Inverse parametrization (point → UV):** use `ElSLib::Parameters(...)` (closed-form, deterministic) for
analytic surfaces; use `GeomAPI_ProjectPointOnSurf` + `LowerDistanceParameters()` (iterative) for
BSpline / GeomPlate surfaces. See §2.

**Periodic-seam straddling is the #1 footgun.** ElSLib returns u in `[0, 2π)`; naive `min/max` over a
ring of projected u-values that crosses u=0 yields `[~0, ~2π]` and you build the WHOLE cylinder. Use the
**largest-angular-gap** rule (§3) to recover the true arc interval BEFORE you build the face.

---

## 1. Trimmed analytic faces

### 1.1 Build the analytic geometry (gp_* → Geom_*)

```python
from OCC.Core.gp import gp_Pnt, gp_Dir, gp_Ax3, gp_Ax2, gp_Cylinder, gp_Cone, gp_Sphere, gp_Pln
from OCC.Core.Geom import (
    Geom_CylindricalSurface, Geom_ConicalSurface, Geom_SphericalSurface, Geom_Plane,
)

ax3 = gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1), gp_Dir(1, 0, 0))  # location, Z (axis), X (u=0 ref)

cyl_geom    = Geom_CylindricalSurface(ax3, radius)                 # u: angle [0,2pi), v: along axis
cone_geom   = Geom_ConicalSurface(ax3, half_angle, ref_radius)     # u: angle [0,2pi), v: along slant
sphere_geom = Geom_SphericalSurface(ax3, radius)                   # u: long [0,2pi), v: lat [-pi/2,pi/2]
plane_geom  = Geom_Plane(ax3)                                       # u,v: cartesian, NON-periodic
```

You can equivalently build the `gp_Cylinder` / `gp_Cone` / `gp_Sphere` / `gp_Pln` value object first (you
need it anyway for `ElSLib`, §2) and pass it to the `Geom_*` ctor or to `BRepBuilderAPI_MakeFace`.

**Parametrization formulas (from ElSLib / gp docs):**
- Cylinder: `P(u,v) = Loc + v*Zdir + R*(cos(u)*Xdir + sin(u)*Ydir)`
- Cone:     `P(u,v) = Loc + v*Zdir + (R + v*tan(semiAngle))*(cos(u)*Xdir + sin(u)*Ydir)`
- Sphere:   longitude `u ∈ [0,2π)`, latitude `v ∈ [-π/2, π/2]`.

### 1.2 Rectangular patch — the simple ctor

```python
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeFace
# tol = tolerance for resolution of degenerate edges (e.g. sphere pole). ~1e-6..1e-7 typical.
mk = BRepBuilderAPI_MakeFace(cyl_geom, umin, umax, vmin, vmax, 1.0e-6)
face = mk.Face()
```

OCCT auto-creates the bounding wire (up to 4 edges / 4 vertices) **with valid p-curves**, including the
seam edge if the patch spans the full period. This is the easiest correct path — use it whenever the
region's UV footprint is (or can be safely approximated by) an axis-aligned UV box.

### 1.3 Non-rectangular region — surface + wire ctor (the realistic path)

**Critical constraint (verified, quoted from OCCT ref):** *"If the surface S is not plane, it must
contain pcurves for all edges in W, otherwise the wrong shape will be created."* So the wire's edges must
each carry a 2D p-curve on the surface. Build each boundary edge from a `Geom2d_Curve` **and** the
surface so the p-curve exists from the start:

```python
from OCC.Core.Geom2d import Geom2d_BSplineCurve  # or Geom2d_TrimmedCurve / Geom2d_Line / Geom2d_BezierCurve
from OCC.Core.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire, BRepBuilderAPI_MakeFace
from OCC.Core.BRepLib import breplib  # breplib.BuildCurves3d(...)

# pcurve2d is a Geom2d curve in (u,v) space tracing the region boundary; surf is the Geom_* surface.
edge = BRepBuilderAPI_MakeEdge(pcurve2d, surf).Edge()   # edge has a p-curve but NO 3D curve yet
breplib.BuildCurve3d(edge)                               # singular: compute 3D curve for ONE edge from its p-curve
# (use breplib.BuildCurves3d(shape) — plural — to do this for every edge of a whole shape at once)

wire = BRepBuilderAPI_MakeWire(e0, e1, e2, e3).Wire()   # closed loop in UV
face = BRepBuilderAPI_MakeFace(surf, wire, True).Face()  # Inside=True => keep material inside the wire
```

- `BRepBuilderAPI_MakeEdge(Geom2d_Curve, Geom_Surface[, p1, p2])` is the constructor that *"build[s] an
  edge out of a curve described in the 2D parametric space of a surface."* This is how you guarantee
  p-curves exist.
- `breplib.BuildCurves3d(shape)` (pythonocc namespace: `from OCC.Core.BRepLib import breplib`) computes
  the missing 3D curves for all edges that have only p-curves. Without it the edges have no 3D geometry.
- Three valid strategies (forum-confirmed):
  1. **Analytical (most robust):** define both 2D and 3D curves explicitly.
  2. **2D-first:** define p-curves, call `breplib.BuildCurves3d`. (shown above — preferred for our case)
  3. **3D-first + heal:** define 3D curves only, then project to get p-curves via Shape Healing
     (`ShapeFix_Face` / `ShapeFix_Wire`). Less reliable; only the *planar* case can auto-project.

> NOTE the modeling-algos guide warning: *"If there is no parametric curve for an edge of the wire on the
> face it is computed by projection, moreover, the calculation is possible only for the planar face."* —
> i.e. you CANNOT rely on OCCT to auto-project p-curves for a curved face. You must supply them.

### 1.4 Self-heal pass (recommended after the wire+surface build)

```python
from OCC.Core.ShapeFix import ShapeFix_Face
from OCC.Core.BRepLib import breplib

sff = ShapeFix_Face(face)
sff.SetPrecision(tol)
sff.FixAddNaturalBound()   # for a periodic surface bounded only by inner wires, add the natural bound
sff.FixMissingSeam()       # reconstruct the seam edge if a closed-surface face lacks it (invalid in OCCT)
sff.FixOrientation()       # fix wire orientation (outer vs hole)
sff.Perform()
face = sff.Face()
breplib.SameParameter(face, tol)  # enforce SameParameter so 3D curve and p-curve agree within tol
```

---

## 2. Computing UV bounds from region points (point → parametric space)

### 2.1 Analytic surfaces — `ElSLib::Parameters` (deterministic, closed-form — PREFERRED)

`ElSLib` = "Elementary Surfaces Library". It performs **closed-form analytic inversion** — no iteration,
fully deterministic (matches the project's hard determinism constraint), and fast for the thousands of
region points you'll project.

```python
from OCC.Core.ElSLib import elslib   # static methods exposed as a module-level object in pythonocc
from OCC.Core.gp import gp_Cylinder, gp_Cone, gp_Sphere, gp_Pln, gp_Pnt2d

# C++ signatures (outputs U,V by reference -> in pythonocc these are returned / via out-args):
# ElSLib::Parameters(const gp_Cylinder& C, const gp_Pnt& P, double& U, double& V)
# ElSLib::Parameters(const gp_Cone&     C, const gp_Pnt& P, double& U, double& V)
# ElSLib::Parameters(const gp_Sphere&   S, const gp_Pnt& P, double& U, double& V)
# ElSLib::Parameters(const gp_Pln&      Pl,const gp_Pnt& P, double& U, double& V)
# ElSLib::Parameters(const gp_Torus&    T, const gp_Pnt& P, double& U, double& V)
```

**pythonocc binding convention (verified against `src/SWIG_files/wrapper/ElSLib.i`):** the C++ class
`ElSLib` is exposed lowercase as `elslib` (`%rename(elslib) ElSLib`), and the `Standard_Real& U, V`
out-params are mapped by the `OutValue` typemap to a **returned Python tuple `(U, V)`** — NOT a `gp_Pnt2d`.
The autodoc docstring states `Return: U: float, V: float`. So:

```python
u, v = elslib.Parameters(gp_cyl, p)   # tuple (U, V); u in [0, 2pi), v along axis
```

There are also canonical-form helpers when you have the `gp_Ax3` directly:
`ElSLib::CylinderParameters(Ax3, R, P, U, V)`, `ConeParameters(Ax3, R, semiAngle, P, U, V)`,
`SphereParameters(Ax3, R, P, U, V)`, `PlaneParameters(Ax3, P, U, V)`,
`TorusParameters(Ax3, majorR, minorR, P, U, V)`.

For the angular (u) direction on cylinder/cone/sphere/torus the result is in `[0, 2π)` — **this is what
makes §3 mandatory.**

### 2.2 Freeform / BSpline / GeomPlate surfaces — `GeomAPI_ProjectPointOnSurf` (iterative fallback)

For non-analytic surfaces (the fitted BSpline / GeomPlate result), there is no closed form; use the
orthogonal-projection class:

```python
from OCC.Core.GeomAPI import GeomAPI_ProjectPointOnSurf
proj = GeomAPI_ProjectPointOnSurf(p, surf_handle)   # optionally pass Umin,Usup,Vmin,Vsup to bound search
proj.Perform(p)
if proj.NbPoints() > 0:
    u, v = proj.LowerDistanceParameters()           # (U,V) of the nearest projected point
    d    = proj.LowerDistance()                      # distance (use to validate the fit / membership)
```

`LowerDistanceParameters()` returns the (U,V) of the closest solution; `NearestPoint()` /
`LowerDistance()` give the point and residual. The projection is computed within `[Umin,Usup]×[Vmin,Vsup]`.
Note: on periodic surfaces this too can return a wrapped parameter — same §3 caveat applies if you ever
project onto a periodic BSpline.

---

## 3. The periodic-seam straddling pitfall (DETECT & FIX at the UV-bounds step)

**Symptom.** A cylindrical/conical/spherical region that is a *partial* arc but happens to **cross the
u=0 / u=2π seam** (e.g. a slot on the "front" of a tube). Projected u-values come back as a cluster near
0 AND a cluster near 2π. Naive `umin=min(u), umax=max(u)` ⇒ `[≈0, ≈2π]` ⇒ you trim the surface to the
**entire** circumference (the complement of what you want), producing a wrong / self-overlapping face.

This is an **upstream pre-processing problem at parameter-extraction time** — distinct from OCCT's
post-hoc seam healing (`ShapeFix_Wire::FixShifted`, `ShapeFix_Face::FixMissingSeam`), which fix an
already-built face whose seam p-curve got shifted by an integer number of periods. You want to never
build the wrong patch in the first place.

### 3.1 The largest-angular-gap rule (deterministic)

For the periodic (u) coordinate of a region:

1. Project all region points → collect `u_i ∈ [0, 2π)` (via `ElSLib::Parameters`).
2. **Sort** the `u_i` ascending.
3. Compute the consecutive gaps `g_i = u_{i+1} - u_i`, plus the **wrap gap** `g_wrap = (u_0 + 2π) - u_{n-1}`.
4. Find the **largest** gap. The region occupies the **complement** of that gap:
   - If the largest gap is an interior gap between `u_k` and `u_{k+1}`, then the arc is
     `umin = u_{k+1}`, `umax = u_k + 2π` (unwrap by adding a full period so `umax > umin`).
   - If the largest gap is the wrap gap, the region does NOT straddle the seam: just use
     `umin = u_0`, `umax = u_{n-1}` (the ordinary case).
5. Build the Geom surface as usual; pass `umin..umax` (which may exceed 2π) to the 5-arg
   `BRepBuilderAPI_MakeFace`, or trace the boundary p-curve in this unwrapped interval. A near-full
   sweep (gap ≈ 0) means "use the natural full-period bound and let OCCT place the seam edge."

This is the standard CAD technique for "unrolling a closed/periodic parameter domain"; OCCT does not
provide a one-call helper for it, so it must live in our pre-processing code. Apply the same idea to the
sphere longitude. Sphere **latitude (v)** is NOT periodic — plain min/max is correct there. Cone/cylinder
**v** (axial) is non-periodic — plain min/max.

### 3.2 Belt-and-suspenders: post-build healing

After building, still run `ShapeFix_Wire::FixShifted()` (shifts 2D curves back if they were placed an
integer number of periods off so the wire stays connected) and `ShapeFix_Face::FixMissingSeam()` /
`FixAddNaturalBound()` (§1.4). `FixAddNaturalBound` must run *before* `FixMissingSeam`. These catch
residual seam issues but are NOT a substitute for §3.1.

### 3.3 Non-rectangular UV regions

The 5-arg `MakeFace(surf, umin,umax,vmin,vmax, tol)` only yields a rectangular UV box — fine for a full
cylinder band or a simple patch. For an arbitrary region outline (curved/zig-zag boundary, interior
holes) you MUST use the surface+wire path (§1.3): trace the region's boundary as `Geom2d_*` p-curves in
the (possibly unwrapped, §3.1) UV space, add interior loops as hole wires, then `MakeFace(surf, wire)`.

---

## 4. Freeform faces from SCATTERED points (no grid)

### 4.1 `GeomAPI_PointsToBSplineSurface` — requires a STRUCTURED grid (NOT scattered)

Cannot be used directly on raw scattered mesh-region points. It approximates/interpolates a surface
through a **rectangular `TColgp_Array2OfPnt`** where *"first index corresponds U parameter of surface,
second - V parameter."* Only usable if you first **resample the region onto a grid** (e.g. project onto a
base plane/parameterization and sample rows×cols).

```python
from OCC.Core.TColgp import TColgp_Array2OfPnt
from OCC.Core.GeomAbs import GeomAbs_C2
from OCC.Core.GeomAPI import GeomAPI_PointsToBSplineSurface

grid = TColgp_Array2OfPnt(1, n_rows, 1, n_cols)   # rectangular grid, 1-based
# grid.SetValue(i, j, gp_Pnt(...))  for each cell
bld = GeomAPI_PointsToBSplineSurface(grid, 3, 8, GeomAbs_C2, 1.0e-3)  # DegMin,DegMax,Continuity,Tol3D
# (overloads: + Approx_ParametrizationType; + variational Weight1/2/3; + Z-height Array2OfReal w/ X0,dX,Y0,dY)
surf = bld.Surface()       # Geom_BSplineSurface
ok   = bld.IsDone()
# bld.Interpolate(grid, periodic=False)  # interpolation variant (passes exactly through points)
```

Properties guaranteed: degree ∈ [DegMin, DegMax]; continuity ≥ Continuity; max deviation ≤ Tol3D.

### 4.2 `BRepOffsetAPI_MakeFilling` — boundary edges + interior point constraints (accepts scattered)

Fills an N-sided region bounded by edges, optionally pinned to interior `gp_Pnt` constraints. Good when
you already have the region's boundary edges (e.g. shared with neighbor faces) plus a sparse set of
interior points to keep the surface from billowing.

```python
from OCC.Core.BRepOffsetAPI import BRepOffsetAPI_MakeFilling
from OCC.Core.GeomAbs import GeomAbs_C0, GeomAbs_G1, GeomAbs_G2

# ctor params: Degree=3, NbPtsOnCur=15, NbIter=2, Anisotropie=False,
#              Tol2d=1e-5, Tol3d=1e-4, TolAng=1e-2, TolCurv=1e-2, MaxDeg=8, MaxSegments=9
fill = BRepOffsetAPI_MakeFilling(3, 15, 2, False, 1.0e-5, 1.0e-4, 1.0e-2, 1.0e-2, 8, 9)

fill.Add(edge0, GeomAbs_C0, True)          # boundary edge, IsBound=True; pass-through (C0)
fill.Add(edge1, neighbor_face, GeomAbs_G1, True)  # boundary + tangency to an adjacent face (G1)
for p in interior_points:                  # interior POINT constraints (scattered ok)
    fill.Add(p)                            # gp_Pnt overload
fill.Build()
if fill.IsDone():
    face = fill.Face()
```

**Stability caveat (documented & forum-confirmed):** results are non-unique and *"not very stable in
complex cases"* — the surface can look "bumpy"; fairness improves with more/denser constraints. Use it
for moderate freeform patches, not pathological organic blobs.

### 4.3 `GeomPlate_BuildPlateSurface` + `GeomPlate_PointConstraint` → `GeomPlate_MakeApprox` (scattered, energy-min)

The most general scattered-point path: minimizes a plate (bending) energy subject to point/curve
constraints, then approximates the implicit `GeomPlate_Surface` into a real `Geom_BSplineSurface`.

```python
from OCC.Core.GeomPlate import (
    GeomPlate_BuildPlateSurface, GeomPlate_PointConstraint, GeomPlate_MakeApprox,
    GeomPlate_PlateG0Criterion,
)
from OCC.Core.gp import gp_Pnt

# Verified ctor (GeomPlate.i overload 3): GeomPlate_BuildPlateSurface(
#   Degree=3, NbPtsOnCur=10, NbIter=3, Tol2d=1e-5, Tol3d=1e-4, TolAng=1e-2, TolCurv=0.1, Anisotropie=False)
builder = GeomPlate_BuildPlateSurface(3, 15, 2)    # Degree, NbPtsOnCur, NbIter
for p in scattered_points:                         # gp_Pnt
    builder.Add(GeomPlate_PointConstraint(p, 0))   # GeomPlate_PointConstraint(Pt, Order, TolDist=1e-4);
                                                   # Order 0 = pass through the point (G0)
# builder.Add(GeomPlate_CurveConstraint(...))      # optional boundary-curve constraints (G0/G1/G2)
builder.Perform()
plate = builder.Surface()                          # Handle(GeomPlate_Surface) — implicit, must approximate

# Convert plate surface -> Geom_BSplineSurface.
# GeomPlate_MakeApprox overload (verified, src/SWIG_files/wrapper/GeomPlate.i):
#   GeomPlate_MakeApprox(SurfPlate, Tol3d, Nbmax, dgmax, dmax, CritOrder=0,
#                        Continuity=GeomAbs_C1, EnlargeCoeff=1.1)
nb_max, deg_max, dmax = 9, 8, 0.001
mkapp = GeomPlate_MakeApprox(plate, 1.0e-4, nb_max, deg_max, dmax)   # Tol3d, Nbmax, dgmax, dmax
bspl  = mkapp.Surface()                             # Geom_BSplineSurface
# (A criterion-driven overload also exists: GeomPlate_MakeApprox(SurfPlate, PlateCrit,
#  Tol3d, Nbmax, dgmax, Continuity=C1, EnlargeCoeff=1.1) — build PlateCrit via
#  GeomPlate_PlateG0Criterion from builder.Disc2dContour / Disc3dContour.)
```

(A `GeomPlate_PlateG0Criterion(S2d, S3d, seuil)` can be built from `builder.Disc2dContour` /
`Disc3dContour` and passed to a `GeomPlate_MakeApprox` overload for criterion-driven approximation.)

**Key limitation (forum + docs):** *"it is not possible to reconstruct a closed surface with Plate."*
So GeomPlate can't directly produce a closed/periodic patch — use the analytic path (§1) for those.

### 4.4 Choosing among the three

- Region resamples cleanly to a grid → **PointsToBSplineSurface** (cleanest, most controllable).
- Region has good boundary edges + a few interior points → **MakeFilling** (watch stability).
- Region is genuinely scattered with no grid and you want energy-minimizing fairing → **GeomPlate** (but
  cannot close a surface).

---

## 5. Tolerances & sewing-compatibility of produced faces

- **MakeFace TolDegen** (`~1e-6..1e-7`): resolution for degenerate edges (e.g. the sphere pole / cone
  apex). Too large collapses real geometry; too small leaves invalid micro-edges.
- **`breplib.SameParameter(shape, tol)`**: after building edges from p-curves, enforce that the 3D curve
  and the p-curve agree within `tol`. OCCT requires the SameParameter flag for valid edges; sewing and
  boolean ops misbehave otherwise. Run it (and/or `ShapeFix`) before sewing.
- **Sewing tolerance** (`BRepBuilderAPI_Sewing(tol)`): pick it consistent with the per-face/edge
  tolerances and the reconstruction's geometric noise — large enough to bridge the gaps between
  independently-fitted neighbor faces, small enough not to merge distinct features. (Topology/sewing into
  a watertight shell is Area 1's deliverable; from Area 3's side the requirement is: every produced face
  must have valid p-curves, SameParameter enforced, and a consistent tolerance so the faces are
  *sewing-ready*.)
- **Fit residual gating:** use `GeomAPI_ProjectPointOnSurf.LowerDistance()` / `MakeFilling`/`GeomPlate`
  error reporters (`G0Error()`) to verify the fitted face actually matches the region within tolerance
  before accepting it.

---

## 6. Concrete end-to-end recipe for ONE trimmed cylindrical region (synthesis)

```python
# 0. inputs: region_points (list[gp_Pnt]), fitted gp_Cylinder gp_cyl (axis+radius from Area 2)
from OCC.Core.Geom import Geom_CylindricalSurface
from OCC.Core.ElSLib import elslib

surf = Geom_CylindricalSurface(gp_cyl.Position(), gp_cyl.Radius())

# 1. invert every point -> (u in [0,2pi), v)   [DETERMINISTIC, closed-form]
#    elslib.Parameters returns a tuple (U, V) in pythonocc (OutValue typemap).
uvs = [elslib.Parameters(gp_cyl, p) for p in region_points]   # list of (u, v) tuples

# 2. periodic-seam-safe u interval via largest-angular-gap (see §3.1); v via plain min/max
umin, umax = largest_gap_interval([u for (u, _) in uvs])     # our helper; umax may exceed 2pi
vmin = min(v for (_, v) in uvs); vmax = max(v for (_, v) in uvs)

# 3a. rectangular footprint -> simple ctor:
face = BRepBuilderAPI_MakeFace(surf, umin, umax, vmin, vmax, 1.0e-6).Face()

# 3b. OR non-rectangular boundary -> trace boundary as Geom2d curves in (u,v),
#     MakeEdge(geom2d, surf) for each, breplib.BuildCurves3d, MakeWire, MakeFace(surf, wire, True)

# 4. heal + SameParameter (see §1.4) so the face is sewing-ready
```

---

## Sources

- https://dev.opencascade.org/doc/refman/html/class_b_rep_builder_a_p_i___make_face.html — `BRepBuilderAPI_MakeFace` ctor signatures: (surf, UMin,UMax,VMin,VMax,TolDegen); (surf, wire, Inside); (face, wire); the "must contain pcurves for non-planar S" rule.
- https://dev.opencascade.org/content/creating-face-cylindrical-surface — forum: making a trimmed face on a `Geom_CylindricalSurface`; p-curves required; 3 strategies; `BRepLib::BuildCurve3d`; `BRepTools::UVBounds`.
- https://dev.opencascade.org/content/not-able-create-face-nonplanar-wire — forum: why `MakeFace` fails on non-planar wires; fix via surface-arg ctor / `BRepFill_Filling` / `ShapeFix_Face`.
- https://dev.opencascade.org/content/topodsedge-built-geom2dcurve-and-geomsurface-has-not-pcurve-face — forum: building an edge from a `Geom2d_Curve` + `Geom_Surface` so a p-curve exists; common p-curve pitfalls.
- https://dev.opencascade.org/doc/occt-7.1.0/refman/html/class_el_s_lib.html — `ElSLib::Parameters` overloads (Cylinder/Cone/Sphere/Plane/Torus) + canonical `*Parameters(Ax3,...)` helpers; closed-form, u in [0,2π).
- https://dev.opencascade.org/content/how-get-u-v-coordinate-surface — forum: get (u,v) via `GeomAPI_ProjectPointOnSurf` + `LowerDistanceParameters`; periodic-wrap caveat.
- https://dev.opencascade.org/doc/refman/html/class_geom_a_p_i___project_point_on_surf.html — `GeomAPI_ProjectPointOnSurf`: `Perform`, `NbPoints`, `LowerDistanceParameters`, `LowerDistance`, `NearestPoint`; computed in [Umin,Usup]×[Vmin,Vsup].
- https://dev.opencascade.org/doc/refman/html/class_geom_a_p_i___points_to_b_spline_surface.html — `GeomAPI_PointsToBSplineSurface`: REQUIRES `TColgp_Array2OfPnt` structured grid; ctor (Points,DegMin=3,DegMax=8,Continuity=C2,Tol3D=1e-3) + ParType/weights/Z-height overloads; `Interpolate`, `Surface`, `IsDone`.
- https://neweopencascade.wordpress.com/2019/03/15/build-constrained-surfaces-with-brepoffsetapi_makefilling-part-i/ — `BRepOffsetAPI_MakeFilling` full ctor params; `Add(edge, GeomAbs_C0/G1/G2, isBound)`, `Add(edge, face, G1, isBound)`, interior `Add(gp_Pnt)`; `Build`/`Face`; "bumpy"/stability note.
- https://dev.opencascade.org/doc/refman/html/class_b_rep_offset_a_p_i___make_filling.html — `BRepOffsetAPI_MakeFilling` class ref (uses `BRepFill_Filling`); constraint continuity orders.
- https://dev.opencascade.org/content/geomplatesurface-point-constraints — forum: `GeomPlate_BuildPlateSurface`(deg,nbPts,nbIter), `GeomPlate_PointConstraint(P,0)`, `Perform`, `Surface`, then `GeomPlate_MakeApprox` → `Geom_BSplineSurface`; "cannot reconstruct a closed surface with Plate".
- https://dev.opencascade.org/doc/refman/html/class_geom_plate___make_approx.html — `GeomPlate_MakeApprox` converts a `GeomPlate_Surface` to `Geom_BSplineSurface` (tol3d, nbsegs, degMax).
- https://dev.opencascade.org/doc/overview/html/occt_user_guides__modeling_algos.html — modeling-algos guide: edges on a face must have a parametric (2D) curve; auto-projection only possible for PLANAR faces; Sewing / Tolerance Management; `BRepBuilderAPI_MakeEdge`.
- https://documentation.help/Open-Cascade/occt_user_guides__shape_healing.html — Shape Healing guide (403 on fetch, but corroborated via search snippets): `ShapeFix_Face` FixAddNaturalBound / FixMissingSeam / FixOrientation; `ShapeFix_Wire` FixShifted (integer-period 2D-curve shifting); seam reconstruction on periodic surfaces; precision/tolerance.
- https://old.opencascade.com/doc/occt-7.5.0/refman/html/class_shape_fix___face.html — `ShapeFix_Face` method list (FixMissingSeam, FixAddNaturalBound, null-area wire removal); FixAddNaturalBound must precede FixMissingSeam.
- https://github.com/tpaviot/pythonocc-core/blob/master/src/SWIG_files/wrapper/GeomAPI.i — pythonocc `OCC.Core.GeomAPI` SWIG wrapper confirming `PointsToBSplineSurface` / `ProjectPointOnSurf` bindings.
- https://raw.githubusercontent.com/tpaviot/pythonocc-core/master/src/SWIG_files/wrapper/ElSLib.i — pythonocc wrapper: `%rename(elslib) ElSLib`; `Parameters(C, P)` autodoc `Return: U: float, V: float` (OutValue typemap → returned tuple, NOT gp_Pnt2d).
- https://raw.githubusercontent.com/tpaviot/pythonocc-core/master/src/SWIG_files/wrapper/BRepLib.i — pythonocc wrapper: `%rename(breplib) BRepLib`; `BuildCurve3d(E, Tol=1e-5, ...)` singular vs `BuildCurves3d(S[, Tol, ...])` plural; `SameParameter(S, Tol=1e-5, forced=False)`.
- https://raw.githubusercontent.com/tpaviot/pythonocc-core/master/src/SWIG_files/wrapper/GeomPlate.i — pythonocc wrapper: exact `GeomPlate_BuildPlateSurface`, `GeomPlate_PointConstraint(Pt, Order, TolDist=1e-4)`, and `GeomPlate_MakeApprox(SurfPlate, Tol3d, Nbmax, dgmax, dmax, CritOrder=0, Continuity=C1, EnlargeCoeff=1.1)` signatures.
- https://github.com/tpaviot/pythonocc-demos/blob/master/examples/core_topology_face.py — pythonocc demo building faces / using GeomAPI surface fitting (Array2 grid usage pattern).
