// Sweep feature (SPEC-4 FR-13): a solid by sweeping a closed profile along a
// spine path, via OCCT BRepOffsetAPI_MakePipe. The spine is either a polyline
// (straight segments) or a circular arc through three points; the profile face
// is swept maintaining its orientation relative to the path.

import type { TopoDS_Face, TopoDS_Wire } from "opencascade.js";
import { normalize, type Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import { Sketch } from "../sketch/sketch.js";
import { Solid } from "../solid/solid.js";

/** The path a profile is swept along. */
export type SpinePath =
  /** Connected straight segments through `points` (≥ 2). */
  | { readonly kind: "polyline"; readonly points: readonly Vec3[] }
  /** A single circular arc from `start` through `through` to `end`. */
  | { readonly kind: "arc"; readonly start: Vec3; readonly through: Vec3; readonly end: Vec3 };

/**
 * A circular sweep profile (a pipe cross-section). Its `normal` should match the
 * path tangent at the start; unlike a polygonal sketch profile a circle sweeps
 * cleanly along curved paths.
 */
export interface CircleProfile {
  readonly center: Vec3;
  readonly normal: Vec3;
  readonly radius: number;
}

/** A sweep profile is either a closed sketch (faced) or a circle (a pipe). */
export type SweepProfile = Sketch | CircleProfile;

function isCircleProfile(p: SweepProfile): p is CircleProfile {
  return !(p instanceof Sketch);
}

/** Build the profile face. Caller owns (`.delete()`) the result. */
function buildProfileFace(oc: Occt, profile: SweepProfile): TopoDS_Face {
  if (!isCircleProfile(profile)) {
    return profile.toFace(oc);
  }
  const [cx, cy, cz] = profile.center;
  const [nx, ny, nz] = normalize(profile.normal);
  const pnt = new oc.gp_Pnt_3(cx, cy, cz);
  const dir = new oc.gp_Dir_4(nx, ny, nz);
  const ax = new oc.gp_Ax2_3(pnt, dir);
  const circ = new oc.gp_Circ_2(ax, profile.radius);
  const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ);
  const wire = new oc.BRepBuilderAPI_MakeWire_2(edge.Edge());
  const mkFace = new oc.BRepBuilderAPI_MakeFace_15(wire.Wire(), true);
  try {
    if (!mkFace.IsDone()) throw new Error("failed to build circular profile face");
    return mkFace.Face();
  } finally {
    mkFace.delete();
    wire.delete();
    edge.delete();
    circ.delete();
    ax.delete();
    dir.delete();
    pnt.delete();
  }
}

/** Build the OCCT spine wire for a path. Caller owns (`.delete()`) the result. */
function buildSpine(oc: Occt, path: SpinePath): TopoDS_Wire {
  if (path.kind === "polyline") {
    if (path.points.length < 2) {
      throw new Error(`a polyline spine needs ≥ 2 points, got ${path.points.length}`);
    }
    const mk = new oc.BRepBuilderAPI_MakeWire_1();
    try {
      for (let i = 0; i + 1 < path.points.length; i++) {
        const a = path.points[i]!;
        const b = path.points[i + 1]!;
        const pa = new oc.gp_Pnt_3(a[0], a[1], a[2]);
        const pb = new oc.gp_Pnt_3(b[0], b[1], b[2]);
        const me = new oc.BRepBuilderAPI_MakeEdge_3(pa, pb);
        try {
          mk.Add_1(me.Edge());
        } finally {
          me.delete();
          pb.delete();
          pa.delete();
        }
      }
      if (!mk.IsDone()) throw new Error("failed to build polyline spine");
      return mk.Wire();
    } finally {
      mk.delete();
    }
  }
  // arc
  const p1 = new oc.gp_Pnt_3(path.start[0], path.start[1], path.start[2]);
  const p2 = new oc.gp_Pnt_3(path.through[0], path.through[1], path.through[2]);
  const p3 = new oc.gp_Pnt_3(path.end[0], path.end[1], path.end[2]);
  const arc = new oc.GC_MakeArcOfCircle_4(p1, p2, p3);
  // GC returns a Handle_Geom_TrimmedCurve; upcast to Handle_Geom_Curve for the edge.
  const trimmed = arc.Value();
  const curve = new oc.Handle_Geom_Curve_2(trimmed.get());
  const me = new oc.BRepBuilderAPI_MakeEdge_24(curve);
  const mk = new oc.BRepBuilderAPI_MakeWire_2(me.Edge());
  try {
    return mk.Wire();
  } finally {
    mk.delete();
    me.delete();
    curve.delete();
    trimmed.delete();
    arc.delete();
    p3.delete();
    p2.delete();
    p1.delete();
  }
}

/**
 * Sweep the closed `profile` along `path`. The profile is faced and swept to a
 * solid pipe. For a clean result the profile plane should be roughly
 * perpendicular to the path tangent at the start; a circular profile tolerates
 * curved paths where a polygonal sketch profile would self-intersect.
 */
export function sweep(oc: Occt, profile: SweepProfile, path: SpinePath): Solid {
  const spine = buildSpine(oc, path);
  const face = buildProfileFace(oc, profile);
  const pipe = new oc.BRepOffsetAPI_MakePipe_1(spine, face);
  try {
    const result = new Solid(oc, pipe.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("sweep produced an invalid solid");
    }
    return result;
  } finally {
    pipe.delete();
    face.delete();
    spine.delete();
  }
}
