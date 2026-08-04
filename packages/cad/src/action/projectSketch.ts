// Project body section curves (or raw 3D edge polylines) into a sketch plane's
// 2D (u, v) frame — the kernel half of §13.3 project-body-edges-into-sketch.
//
// Consumes §13.2 `sectionCurves` for the exact body∩plane intersection, then
// lowers each resulting edge to a planar endpoint segment. Callers that already
// hold world-space edge polylines (e.g. a tessellated mesh) use
// {@link worldPolylinesToPlaneSegments} without OCCT.

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import type { DatumPlane } from "../env/plane.js";
import { worldPointToPlane } from "../env/plane.js";
import type { Solid } from "../solid/solid.js";
import { shapeEnums } from "../mesh/normals.js";
import { sectionCurves } from "./split.js";

/** A straight segment in sketch-plane (u, v) metres. */
export interface PlaneSegment2 {
  readonly a: readonly [number, number];
  readonly b: readonly [number, number];
}

export interface ProjectToPlaneOptions {
  /**
   * Drop segments shorter than this (SI metres). Default 1e-9 — rejects
   * numerically collapsed edges without discarding fine feature geometry.
   */
  readonly minLength?: number;
  /**
   * When projecting arbitrary world polylines, drop a chord whose endpoints
   * lie more than this far off the plane (SI metres). `sectionCurves` results
   * are already on-plane so this only applies to {@link worldPolylinesToPlaneSegments}.
   * Default 1e-4 (0.1 mm).
   */
  readonly maxOffPlane?: number;
}

const DEFAULT_MIN_LENGTH = 1e-9;
const DEFAULT_MAX_OFF_PLANE = 1e-4;

function segmentLength(s: PlaneSegment2): number {
  return Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
}

/**
 * Orthogonal projection of world-space polylines onto `plane` as 2D segments.
 *
 * Each polyline is a flat `[x,y,z, x,y,z, …]` array (≥2 points). Consecutive
 * pairs become segments; chords with either endpoint farther than
 * `maxOffPlane` from the plane are skipped (so edges that only glance the
 * sketch plane do not pollute the sketch).
 *
 * Pure — no OCCT. Used by the app when a tessellated mesh is already in hand.
 */
export function worldPolylinesToPlaneSegments(
  plane: DatumPlane,
  polylines: readonly ArrayLike<number>[],
  opts?: ProjectToPlaneOptions,
): PlaneSegment2[] {
  const minLen = opts?.minLength ?? DEFAULT_MIN_LENGTH;
  const maxOff = opts?.maxOffPlane ?? DEFAULT_MAX_OFF_PLANE;
  const out: PlaneSegment2[] = [];

  for (const poly of polylines) {
    const n = Math.floor(poly.length / 3);
    if (n < 2) continue;
    for (let i = 0; i < n - 1; i++) {
      const p0: Vec3 = [poly[i * 3]!, poly[i * 3 + 1]!, poly[i * 3 + 2]!];
      const p1: Vec3 = [poly[(i + 1) * 3]!, poly[(i + 1) * 3 + 1]!, poly[(i + 1) * 3 + 2]!];
      const a = worldPointToPlane(plane, p0);
      const b = worldPointToPlane(plane, p1);
      if (Math.abs(a.height) > maxOff || Math.abs(b.height) > maxOff) continue;
      const seg: PlaneSegment2 = { a: [a.u, a.v], b: [b.u, b.v] };
      if (segmentLength(seg) < minLen) continue;
      out.push(seg);
    }
  }
  return out;
}

/**
 * Body ∩ plane as sketch-plane segments via §13.2 {@link sectionCurves}.
 *
 * Explores every edge of the section compound, takes its endpoints, and maps
 * them into the plane's (u, v) frame. Section edges are already on-plane, so
 * height filtering is not applied. `body` is not consumed; the intermediate
 * section shape is freed before return.
 *
 * Throws named errors from `sectionCurves` when the plane is ill-formed or the
 * section is empty.
 */
export function sectionCurvesToPlaneSegments(
  oc: Occt,
  body: Solid,
  plane: DatumPlane,
  opts?: ProjectToPlaneOptions,
): PlaneSegment2[] {
  const minLen = opts?.minLength ?? DEFAULT_MIN_LENGTH;
  const section = sectionCurves(oc, body, plane);
  const out: PlaneSegment2[] = [];
  try {
    const S = shapeEnums(oc);
    const exp = new oc.TopExp_Explorer_2(section.shape, S.TopAbs_EDGE, S.TopAbs_SHAPE);
    try {
      while (exp.More()) {
        const edge = oc.TopoDS.Edge_1(exp.Current());
        try {
          const curve = new oc.BRepAdaptor_Curve_2(edge);
          try {
            const p0 = curve.Value(curve.FirstParameter());
            const p1 = curve.Value(curve.LastParameter());
            try {
              const a = worldPointToPlane(plane, [p0.X(), p0.Y(), p0.Z()]);
              const b = worldPointToPlane(plane, [p1.X(), p1.Y(), p1.Z()]);
              const seg: PlaneSegment2 = { a: [a.u, a.v], b: [b.u, b.v] };
              if (segmentLength(seg) >= minLen) out.push(seg);
            } finally {
              p0.delete();
              p1.delete();
            }
          } finally {
            curve.delete();
          }
        } finally {
          edge.delete();
        }
        exp.Next();
      }
    } finally {
      exp.delete();
    }
  } finally {
    section.delete();
  }
  return out;
}
