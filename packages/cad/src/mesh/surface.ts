// Analytic per-surface-type face signatures (§2.1).
//
// WHY THIS EXISTS
// ---------------
// A FaceRef's original identity was its area-weighted average triangulation
// normal (`normalFromTriangulation`). For a CLOSED curved face — a hole wall, a
// cylindrical boss, a 360° revolve, a sphere — the true integral of the normal
// over the surface is ZERO: the radial components cancel. What got stored was
// normalized floating-point residue, and `|| 1` in the normalize step returned
// that residue instead of failing. Two consequences:
//
//   • `resolveFaceRef` requires dot(candidate, ref.normal) ≥ 0.999. Noise dotted
//     with noise ≈ 0, so a closed curved face could NEVER re-match itself after
//     the mesh changed — a fillet on a hole rim was guaranteed to break the first
//     time any upstream parameter moved.
//   • Within one session the identical cached triangulation reproduced the
//     identical noise, so such refs DID resolve at creation — which is exactly
//     what made the defect invisible until a rebuild.
//
// THE FIX
// -------
// Ask the ACTUAL surface what it is (`BRepAdaptor_Surface.GetType()`) and store
// its analytic parameters: a plane's normal+origin, a cylinder/cone's axis and
// radius, a sphere's centre and radius, a torus's axes and radii. These are
// exact, mesh-independent, and stable across retessellation — a cylinder of
// radius 8 mm is still a cylinder of radius 8 mm after any upstream edit, and
// when the radius changes to 9 mm the ref correctly FAILS to match rather than
// silently matching noise.
//
// Requires `BRepAdaptor_Surface` + the gp_ surface types, which were absent from
// the trimmed wasm until the 2026-07-17 rebuild (see occt.build.yml and
// oc/bindings.test.ts, which pins them).

import type { TopoDS_Face } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";

/**
 * A face's analytic identity, discriminated by OCCT's surface type.
 *
 * Every variant holds only mesh-INDEPENDENT quantities, so it is stable across
 * retessellation. Axes/normals are unit vectors; lengths are SI metres.
 */
export type SurfaceSignature =
  | { readonly kind: "plane"; readonly normal: Vec3; readonly origin: Vec3 }
  | {
      readonly kind: "cylinder";
      readonly axis: Vec3;
      readonly axisPoint: Vec3;
      readonly radius: number;
    }
  | {
      readonly kind: "cone";
      readonly axis: Vec3;
      readonly axisPoint: Vec3;
      readonly radius: number;
      readonly semiAngle: number;
    }
  | { readonly kind: "sphere"; readonly centre: Vec3; readonly radius: number }
  | {
      readonly kind: "torus";
      readonly axis: Vec3;
      readonly centre: Vec3;
      readonly majorRadius: number;
      readonly minorRadius: number;
    }
  /** Anything OCCT does not classify analytically (B-spline, Bezier, revolution,
   * offset…). Identified by its type tag only; the caller still disambiguates
   * positionally by centroid. */
  | { readonly kind: "other"; readonly type: number };

/** Read a gp_Ax1's direction as a unit Vec3, freeing the OCCT handles. */
function axisDir(ax: { Direction(): { X(): number; Y(): number; Z(): number; delete(): void }; delete(): void }): Vec3 {
  const d = ax.Direction();
  const out: Vec3 = [d.X(), d.Y(), d.Z()];
  d.delete();
  return out;
}

/** Read a gp_Ax1's location as a Vec3, freeing the OCCT handles. */
function axisLoc(ax: { Location(): { X(): number; Y(): number; Z(): number; delete(): void }; delete(): void }): Vec3 {
  const p = ax.Location();
  const out: Vec3 = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/** Read a gp_Pnt as a Vec3, freeing it. */
function pntVec(p: { X(): number; Y(): number; Z(): number; delete(): void }): Vec3 {
  const out: Vec3 = [p.X(), p.Y(), p.Z()];
  p.delete();
  return out;
}

/**
 * The face's analytic surface signature.
 *
 * Never throws for an unclassifiable surface — it degrades to `{kind:"other"}`
 * so an exotic face still has a stable type tag to filter on (and the caller's
 * centroid disambiguation still applies).
 */
export function faceSurfaceSignature(oc: Occt, face: TopoDS_Face): SurfaceSignature {
  const ad = new oc.BRepAdaptor_Surface_2(face, true);
  try {
    const T = oc.GeomAbs_SurfaceType;
    const t = ad.GetType();
    if (t === T.GeomAbs_Plane) {
      const pl = ad.Plane();
      try {
        const ax = pl.Axis();
        const sig: SurfaceSignature = { kind: "plane", normal: axisDir(ax), origin: axisLoc(ax) };
        ax.delete();
        return sig;
      } finally {
        pl.delete();
      }
    }
    if (t === T.GeomAbs_Cylinder) {
      const cy = ad.Cylinder();
      try {
        const ax = cy.Axis();
        const sig: SurfaceSignature = {
          kind: "cylinder",
          axis: axisDir(ax),
          axisPoint: axisLoc(ax),
          radius: cy.Radius(),
        };
        ax.delete();
        return sig;
      } finally {
        cy.delete();
      }
    }
    if (t === T.GeomAbs_Cone) {
      const co = ad.Cone();
      try {
        const ax = co.Axis();
        const sig: SurfaceSignature = {
          kind: "cone",
          axis: axisDir(ax),
          axisPoint: axisLoc(ax),
          radius: co.RefRadius(),
          semiAngle: co.SemiAngle(),
        };
        ax.delete();
        return sig;
      } finally {
        co.delete();
      }
    }
    if (t === T.GeomAbs_Sphere) {
      const sp = ad.Sphere();
      try {
        return { kind: "sphere", centre: pntVec(sp.Location()), radius: sp.Radius() };
      } finally {
        sp.delete();
      }
    }
    if (t === T.GeomAbs_Torus) {
      const to = ad.Torus();
      try {
        const ax = to.Axis();
        const sig: SurfaceSignature = {
          kind: "torus",
          axis: axisDir(ax),
          centre: axisLoc(ax),
          majorRadius: to.MajorRadius(),
          minorRadius: to.MinorRadius(),
        };
        ax.delete();
        return sig;
      } finally {
        to.delete();
      }
    }
    return { kind: "other", type: t as unknown as number };
  } finally {
    ad.delete();
  }
}

/** Unit-vector alignment tolerance (~0.26°). Axes are exact, so this is tight. */
const DIR_TOL = 0.99999;
/** Radius/length agreement, SI metres (1 µm — far below any real CAD feature). */
const LEN_TOL = 1e-6;
/** Angle agreement, radians (~0.006°). */
const ANG_TOL = 1e-4;

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** True when two unit vectors point the same way OR exactly opposite.
 * A surface's axis has no inherent sign — OCCT may hand back either
 * orientation for the same geometry after a rebuild. */
const sameAxis = (a: Vec3, b: Vec3): boolean => Math.abs(dot3(a, b)) >= DIR_TOL;

/** Distance from `p` to the infinite line (point `q`, unit direction `d`). */
function distToAxis(p: Vec3, q: Vec3, d: Vec3): number {
  const v: Vec3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const t = dot3(v, d);
  const perp: Vec3 = [v[0] - t * d[0], v[1] - t * d[1], v[2] - t * d[2]];
  return Math.hypot(perp[0], perp[1], perp[2]);
}

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/**
 * True when two signatures describe the SAME analytic surface.
 *
 * Compares only intrinsic quantities, never the parameterisation: axis sign is
 * ignored (`sameAxis`), and an axis POINT is compared by its distance to the
 * other's axis line rather than by coordinates — OCCT is free to report a
 * different point on the same axis after a rebuild, and that must still match.
 * Radii must agree exactly (to 1 µm): a hole re-cut at a different radius is a
 * DIFFERENT surface and must not match, which is the whole point.
 */
export function surfacesMatch(a: SurfaceSignature, b: SurfaceSignature): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "plane": {
      const o = b as Extract<SurfaceSignature, { kind: "plane" }>;
      if (!sameAxis(a.normal, o.normal)) return false;
      // Same plane ⇔ the other's origin lies in this plane.
      const d: Vec3 = [
        o.origin[0] - a.origin[0],
        o.origin[1] - a.origin[1],
        o.origin[2] - a.origin[2],
      ];
      return Math.abs(dot3(d, a.normal)) <= LEN_TOL;
    }
    case "cylinder": {
      const o = b as Extract<SurfaceSignature, { kind: "cylinder" }>;
      return (
        sameAxis(a.axis, o.axis) &&
        near(a.radius, o.radius, LEN_TOL) &&
        distToAxis(o.axisPoint, a.axisPoint, a.axis) <= LEN_TOL
      );
    }
    case "cone": {
      const o = b as Extract<SurfaceSignature, { kind: "cone" }>;
      return (
        sameAxis(a.axis, o.axis) &&
        near(a.radius, o.radius, LEN_TOL) &&
        near(Math.abs(a.semiAngle), Math.abs(o.semiAngle), ANG_TOL) &&
        distToAxis(o.axisPoint, a.axisPoint, a.axis) <= LEN_TOL
      );
    }
    case "sphere": {
      const o = b as Extract<SurfaceSignature, { kind: "sphere" }>;
      return (
        near(a.radius, o.radius, LEN_TOL) &&
        Math.hypot(a.centre[0] - o.centre[0], a.centre[1] - o.centre[1], a.centre[2] - o.centre[2]) <=
          LEN_TOL
      );
    }
    case "torus": {
      const o = b as Extract<SurfaceSignature, { kind: "torus" }>;
      return (
        sameAxis(a.axis, o.axis) &&
        near(a.majorRadius, o.majorRadius, LEN_TOL) &&
        near(a.minorRadius, o.minorRadius, LEN_TOL) &&
        Math.hypot(a.centre[0] - o.centre[0], a.centre[1] - o.centre[1], a.centre[2] - o.centre[2]) <=
          LEN_TOL
      );
    }
    case "other": {
      const o = b as Extract<SurfaceSignature, { kind: "other" }>;
      // No analytic parameters to compare: the type tag alone is a filter, and
      // the caller disambiguates positionally.
      return a.type === o.type;
    }
  }
}

/**
 * True when a signature carries no usable direction for the LEGACY normal path.
 *
 * A closed curved face (cylinder/cone/sphere/torus) is exactly the case whose
 * averaged triangulation normal is meaningless — callers use this to refuse to
 * fall back to normal matching for such a face.
 */
export function isClosedCurved(sig: SurfaceSignature): boolean {
  return sig.kind === "cylinder" || sig.kind === "cone" || sig.kind === "sphere" || sig.kind === "torus";
}
