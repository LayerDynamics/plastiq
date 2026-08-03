// @plastiq/cad — freeform pillar: control-lattice generators for the primitive
// freeform bodies (plane / cylinder / sphere) plus a symmetry (mirror) op.
//
// These are the "Sources of freeform bodies: primitives (plane/cylinder/sphere
// control-lattice generators)" and the "symmetry option" of FablesFindings.md
// §15 Lane A(c). Everything here is PURE MATH — an exact rational-NURBS
// construction with the correct weights and knot vectors, so the results are the
// same self-contained `NurbsSurface` the de Boor evaluator (deBoor.ts) consumes.
// No OCCT, no @plastiq/nurbs.
//
// The circle/cylinder/sphere use the standard rational-quadratic circular-arc
// representation (The NURBS Book, Algorithm A7.1 MakeNurbsCircle): each ≤ 90°
// arc is a rational Bézier whose endpoints sit on the circle (weight 1) and whose
// middle control point is the tangent-line intersection (weight cos(Δθ/2)). A
// full circle is four such arcs → 9 control points, weights 1, √2/2, 1, …. The
// sphere is the tensor product of a full-circle revolution (u) with a semicircle
// meridian (v); because both factors are exact circles and the weight grid is the
// outer product of the two weight vectors, every evaluated point lands exactly on
// the sphere (proof: the surface separates into meridian·revolution — see the
// exactness tests in generators.test.ts).

import {
  makeNurbsSurface,
  type NurbsSurface,
  type Vec3,
} from "./nurbsSurface.js";

// ---------------------------------------------------------------------------
// Small vector helpers (kept local — the freeform pillar has no vec-math dep).
// ---------------------------------------------------------------------------

function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function lengthOf(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

/** Unit vector; throws on a (near-)zero input since a direction must be defined. */
function normalize(a: Vec3, what: string): Vec3 {
  const len = lengthOf(a);
  if (!(len > 1e-12)) {
    throw new RangeError(`${what} must be a non-zero direction (got length ${len})`);
  }
  return [a[0] / len, a[1] / len, a[2] / len];
}

/**
 * A right-handed orthonormal frame `{e1, e2}` spanning the plane perpendicular to
 * unit axis `a`, with `e1 × e2 = a` (so a circle traced `cos·e1 + sin·e2` runs
 * counter-clockwise about `+a`). `a` is assumed already unit-length.
 */
function planeFrame(a: Vec3): { e1: Vec3; e2: Vec3 } {
  // Pick a helper axis that is not (nearly) parallel to `a`.
  const helper: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(cross(helper, a), "frame e1");
  const e2 = cross(a, e1); // unit by construction: |a|=|e1|=1, a⊥e1
  return { e1, e2 };
}

// ---------------------------------------------------------------------------
// Exact rational circular arc (The NURBS Book, A7.1), used by cylinder + sphere.
// ---------------------------------------------------------------------------

interface ArcControlData {
  /** 2·narcs+1 control points in world space. */
  points: Vec3[];
  /** Parallel weights: 1 on the circle, cos(Δθ/2) at each tangent corner. */
  weights: number[];
  /** Clamped degree-2 knot vector over [0, 1]. */
  knots: number[];
}

/**
 * Control points of an exact rational-quadratic circular arc of `radius` swept
 * `sweep` radians (0 < sweep ≤ 2π) about `center`, starting at `center + radius·e1`
 * and turning toward `e2`.
 *
 * The arc is split into `narcs` equal sub-arcs of ≤ 90° each (1 for ≤ 90°, 2 for
 * ≤ 180°, 3 for ≤ 270°, else 4 — the A7.1 tiering). Each sub-arc contributes an
 * on-circle endpoint (weight 1) and a middle control point at the intersection of
 * the two endpoint tangents — which for a circle lies on the bisector at radial
 * distance `radius / cos(Δθ/2)` with weight `cos(Δθ/2)`.
 */
function circularArc(
  center: Vec3,
  e1: Vec3,
  e2: Vec3,
  radius: number,
  sweep: number,
): ArcControlData {
  const eps = 1e-9;
  const halfPi = Math.PI / 2;
  let narcs: number;
  if (sweep <= halfPi + eps) narcs = 1;
  else if (sweep <= Math.PI + eps) narcs = 2;
  else if (sweep <= 3 * halfPi + eps) narcs = 3;
  else narcs = 4;

  const dtheta = sweep / narcs;
  const wCorner = Math.cos(dtheta / 2);
  const cornerDist = radius / wCorner;

  // Point on the (center, e1, e2) plane at radial distance `d` and angle `ang`.
  const at = (d: number, ang: number): Vec3 => {
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    return add(center, add(scale(e1, d * c), scale(e2, d * s)));
  };

  const points: Vec3[] = [at(radius, 0)];
  const weights: number[] = [1];
  for (let i = 0; i < narcs; i++) {
    const a0 = i * dtheta;
    const a1 = (i + 1) * dtheta;
    points.push(at(cornerDist, (a0 + a1) / 2)); // tangent-intersection corner
    weights.push(wCorner);
    points.push(at(radius, a1)); // next on-circle endpoint
    weights.push(1);
  }

  // Clamped knots with a double knot at each interior sub-arc boundary.
  const knots: number[] = [0, 0, 0];
  for (let i = 1; i < narcs; i++) {
    knots.push(i / narcs, i / narcs);
  }
  knots.push(1, 1, 1);

  return { points, weights, knots };
}

// ---------------------------------------------------------------------------
// Primitive control-lattice generators.
// ---------------------------------------------------------------------------

/**
 * A degree-1 rectangular plane patch: four control points spanning
 * `origin → origin + û·uSize` (u) and `origin → origin + v̂·vSize` (v), where
 * `û`, `v̂` are the normalized `uDir`, `vDir`. Non-rational (no weights).
 *
 * Because a `(1,1)` patch is exact bilinear interpolation, `evaluate` lands at
 * `origin + û·uSize·u + v̂·vSize·v` over `(u, v) ∈ [0,1]²`.
 */
export function planeSurface(
  origin: Vec3,
  uDir: Vec3,
  vDir: Vec3,
  uSize: number,
  vSize: number,
): NurbsSurface {
  const u = scale(normalize(uDir, "planeSurface uDir"), uSize);
  const v = scale(normalize(vDir, "planeSurface vDir"), vSize);
  const p00 = origin;
  const p10 = add(origin, u);
  const p01 = add(origin, v);
  const p11 = add(add(origin, u), v);
  return makeNurbsSurface({
    degU: 1,
    degV: 1,
    knotsU: [0, 0, 1, 1],
    knotsV: [0, 0, 1, 1],
    // controlNet[i][j]: i = u-index, j = v-index.
    controlNet: [
      [p00, p01],
      [p10, p11],
    ],
  });
}

/**
 * A rational NURBS cylinder wall about `axis` through `axisPoint`, of the given
 * `radius` and `height`. The circular direction (u, degree 2) is the exact
 * rational full-circle representation (9 control points, weights 1, √2/2, 1, …);
 * the axial direction (v, degree 1) is a straight extrusion of `height` along the
 * axis. Pass `opts.sweep` (radians, 0 < sweep ≤ 2π) for a partial wall — the
 * u-control-point count is `2·ceilQuadrants(sweep)+1` (3 for a quarter, …, 9 for
 * the full circle). Every evaluated point lies exactly at `radius` from the axis.
 */
export function cylinderSurface(
  axisPoint: Vec3,
  axis: Vec3,
  radius: number,
  height: number,
  opts?: { sweep?: number },
): NurbsSurface {
  if (!(radius > 0)) {
    throw new RangeError(`cylinderSurface radius must be > 0 (got ${radius})`);
  }
  const sweep = opts?.sweep ?? 2 * Math.PI;
  if (!(sweep > 0) || sweep > 2 * Math.PI + 1e-9) {
    throw new RangeError(`cylinderSurface sweep must be in (0, 2π] (got ${sweep})`);
  }
  const a = normalize(axis, "cylinderSurface axis");
  const { e1, e2 } = planeFrame(a);
  const arc = circularArc(axisPoint, e1, e2, radius, sweep);
  const lift = scale(a, height);

  const controlNet: Vec3[][] = [];
  const weights: number[][] = [];
  for (let i = 0; i < arc.points.length; i++) {
    const base = arc.points[i]!;
    // controlNet[i][j]: j = 0 base ring, j = 1 top ring.
    controlNet.push([base, add(base, lift)]);
    const w = arc.weights[i]!;
    weights.push([w, w]);
  }

  return makeNurbsSurface({
    degU: 2,
    degV: 1,
    knotsU: arc.knots,
    knotsV: [0, 0, 1, 1],
    controlNet,
    weights,
  });
}

/**
 * A rational NURBS sphere of `radius` about `centre` (poles on the +z axis). It is
 * the tensor product of a full-circle revolution (u, degree 2, 9 control points)
 * with a semicircle meridian (v, degree 2, 5 control points). The weight grid is
 * the outer product of the revolution and meridian weight vectors, which makes the
 * surface separate exactly into (meridian circle)·(revolution circle) — so every
 * evaluated point satisfies `|p − centre| = radius` (see the exactness proof in
 * generators.test.ts). The two meridian endpoints collapse the revolution ring to
 * the poles (a degenerate but valid control row).
 */
export function sphereSurface(centre: Vec3, radius: number): NurbsSurface {
  if (!(radius > 0)) {
    throw new RangeError(`sphereSurface radius must be > 0 (got ${radius})`);
  }
  const r = radius;
  const h = Math.SQRT1_2; // √2/2 — the exact quarter-circle corner weight.

  // Semicircle meridian in (radial ρ, axial z), south pole → equator → north pole.
  // Two exact quarter arcs; corner points carry weight √2/2.
  const meridian: { rho: number; z: number; w: number }[] = [
    { rho: 0, z: -r, w: 1 }, // south pole
    { rho: r, z: -r, w: h }, // tangent corner
    { rho: r, z: 0, w: 1 }, // equator
    { rho: r, z: r, w: h }, // tangent corner
    { rho: 0, z: r, w: 1 }, // north pole
  ];
  const meridianKnots = [0, 0, 0, 0.5, 0.5, 1, 1, 1];

  // Full-circle revolution template in the xy-plane at unit radial distance.
  const revo = circularArc([0, 0, 0], [1, 0, 0], [0, 1, 0], 1, 2 * Math.PI);

  const numRevo = revo.points.length; // 9
  const numMerid = meridian.length; // 5

  // controlNet[i][j]: i = revolution index (u), j = meridian index (v).
  const controlNet: Vec3[][] = [];
  const weights: number[][] = [];
  for (let i = 0; i < numRevo; i++) {
    const t = revo.points[i]!; // unit-radial template point (tx, ty, 0)
    const cnRow: Vec3[] = [];
    const wRow: number[] = [];
    for (let j = 0; j < numMerid; j++) {
      const m = meridian[j]!;
      cnRow.push([
        centre[0] + m.rho * t[0],
        centre[1] + m.rho * t[1],
        centre[2] + m.z,
      ]);
      wRow.push(revo.weights[i]! * m.w);
    }
    controlNet.push(cnRow);
    weights.push(wRow);
  }

  return makeNurbsSurface({
    degU: 2,
    degV: 2,
    knotsU: revo.knots,
    knotsV: meridianKnots,
    controlNet,
    weights,
  });
}

// ---------------------------------------------------------------------------
// Symmetry: mirror the control net across a plane.
// ---------------------------------------------------------------------------

/**
 * Reflect every control point of `surf` across the plane through `planePoint` with
 * normal `planeNormal`, returning the mirrored surface. Weights are preserved
 * (reflection is an isometry, so the rational structure is unchanged).
 *
 * Orientation choice: a pure control-point reflection is orientation-REVERSING, so
 * `∂S/∂u × ∂S/∂v` would point the wrong way (the patch turns "inside out"). To
 * restore a sane normal sense — the mirrored surface's normal equal to the mirror
 * image of the original's normal — this reverses the **u** parameter direction
 * (rows reversed, u-knots complemented). Reflection reverses orientation once and
 * the u-reversal reverses it a second time, so the net result carries the true
 * reflected normal field. Consequently the mirrored surface is reparameterized in
 * u: `mirror(u, v) = reflect(surf(a+b − u, v))`, where `[a, b]` is the u-knot span.
 */
export function mirrorControlNet(
  surf: NurbsSurface,
  planePoint: Vec3,
  planeNormal: Vec3,
): NurbsSurface {
  const n = normalize(planeNormal, "mirrorControlNet planeNormal");

  // Reflect a point across the plane: p' = p − 2·((p − Q)·n)·n.
  const reflectPoint = (p: Vec3): Vec3 => {
    const d = dot([p[0] - planePoint[0], p[1] - planePoint[1], p[2] - planePoint[2]], n);
    return [p[0] - 2 * d * n[0], p[1] - 2 * d * n[1], p[2] - 2 * d * n[2]];
  };

  const nU = surf.controlNet.length;

  // Reflect every control point, then reverse the u (row) order so the resulting
  // surface normal is the mirror image of the original's (see the doc comment).
  const controlNet: Vec3[][] = [];
  const weights: number[][] | undefined = surf.weights ? [] : undefined;
  for (let i = 0; i < nU; i++) {
    const srcRow = surf.controlNet[nU - 1 - i]!;
    controlNet.push(srcRow.map(reflectPoint));
    if (weights && surf.weights) {
      weights.push(surf.weights[nU - 1 - i]!.slice());
    }
  }

  // Complement the u-knot vector for the reversal: U'[k] = U[0] + U[L] − U[L − k].
  const kU = surf.knotsU;
  const L = kU.length - 1;
  const span = (kU[0] ?? 0) + (kU[L] ?? 1);
  const knotsU: number[] = [];
  for (let k = 0; k <= L; k++) {
    knotsU.push(span - (kU[L - k] ?? 0));
  }

  const mirrored: NurbsSurface = {
    degU: surf.degU,
    degV: surf.degV,
    knotsU,
    knotsV: surf.knotsV.slice(),
    controlNet,
  };
  if (weights) mirrored.weights = weights;
  return makeNurbsSurface(mirrored);
}
