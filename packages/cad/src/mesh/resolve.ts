// Persistent-ref resolution (SPEC-4 FR-16). The inverse of signature generation:
// given a FaceRef/EdgeRef captured before an edit, find the matching face/edge in
// the *current* solid by its signature (face outward normal; edge adjacent-face
// normal pair). This is what lets a fillet/chamfer/shell re-resolve to the same
// topology after an upstream parameter rebuild.
//
// Returned shapes are owned by the caller (call `.delete()` when done).

import type { TopoDS_Edge, TopoDS_Face } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { dot, normalize, sub, type Vec3 } from "../math/index.js";
import type { Solid } from "../solid/solid.js";
import {
  adjacentFaceNormals,
  edgeMidpoint,
  ensureMeshed,
  faceCentroid,
  faceNormal,
  shapeEnums,
} from "./normals.js";
import { faceSurfaceSignature, surfacesMatch, type SurfaceSignature } from "./surface.js";
import type { EdgeRef, FaceRef } from "./tagged.js";

// A face matches if its normal aligns to within ~2.6° (dot ≥ 0.999).
const FACE_DOT_TOL = 0.999;
// An edge matches if both adjacent normals align (summed dot ≥ 2·tol).
const EDGE_SCORE_TOL = 2 * FACE_DOT_TOL;

/** Squared distance between two points (cheaper than distance for comparison). */
function sqDist(a: Vec3, b: Vec3): number {
  const d = sub(a, b);
  return d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
}

/**
 * The current solid's face matching `ref`, or null (caller deletes).
 *
 * The normal is the primary filter (only faces aligned within tolerance are
 * candidates). When `ref.centroid` is present it disambiguates among those
 * candidates by closest area-centroid — so two faces sharing a normal (coplanar
 * faces, a step, parallel walls) resolve to the RIGHT one rather than whichever
 * OCCT enumerated first. Without a centroid (refs persisted before it existed) it
 * falls back to the best normal alignment.
 */
export function resolveFaceRef(oc: Occt, solid: Solid, ref: FaceRef): TopoDS_Face | null {
  ensureMeshed(oc, solid.shape);
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  // Cap for the positional tie-break, scaled to the model (§2.1). Without it a
  // ref whose face a boolean DELETED silently rebound to any same-signature face
  // arbitrarily far away — a wrong result with no error.
  const cap = centroidCap(oc, solid);
  let best: TopoDS_Face | null = null;
  let bestScore = -Infinity;
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    let score: number;
    if (ref.surface) {
      // PRIMARY path (§2.1): match the analytic surface. Exact and mesh-
      // independent, and the only thing that works for a closed curved face.
      if (!surfacesMatch(ref.surface, faceSurfaceSignature(oc, face))) {
        face.delete();
        continue;
      }
      // Same surface can still be several faces (coplanar fragments; the two
      // walls of a through-hole are ONE cylinder). Closest centroid wins.
      score = ref.centroid ? -sqDist(faceCentroid(oc, face), ref.centroid) : 0;
    } else {
      // LEGACY path: refs persisted before `surface` existed. Normal-first.
      const aligned = dot(faceNormal(oc, face), ref.normal);
      if (aligned < FACE_DOT_TOL) {
        face.delete();
        continue;
      }
      score = ref.centroid ? -sqDist(faceCentroid(oc, face), ref.centroid) : aligned;
    }
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = face;
    } else {
      face.delete();
    }
  }
  exp.delete();
  // Enforce the cap: a candidate whose centroid is implausibly far from the
  // ref's is not the referenced face. Fail LOUDLY (null) rather than rebind.
  if (best && ref.centroid && bestScore !== -Infinity && -bestScore > cap * cap) {
    best.delete();
    return null;
  }
  return best;
}

/**
 * Max distance a re-resolved face/edge's centroid may sit from the ref's, in
 * SI metres — the diagonal of the solid's bounding box, so it scales with the
 * model instead of hard-coding a length.
 *
 * The bound is deliberately generous: a legitimate face can travel a long way
 * when an upstream parameter changes (that is the point of a parametric ref).
 * It exists to reject the pathological case — the referenced face was DELETED
 * and the nearest same-signature candidate is somewhere else entirely.
 */
function centroidCap(oc: Occt, solid: Solid): number {
  void oc;
  const { min, max } = solid.boundingBox();
  return Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
}

/**
 * The current solid's edge matching `ref`, or null (caller deletes).
 *
 * When `ref.faceSurfaces` is present the adjacent faces' ANALYTIC surfaces are
 * the filter (§2.1) — the only signature that works for an edge bordering a
 * closed curved wall (a hole rim, a boss edge), whose averaged normal on that
 * side is meaningless residue. Older refs fall back to the adjacent-normal pair.
 * Either way `ref.midpoint` separates parallel edges sharing the same adjacent
 * faces, and the same distance cap as {@link resolveFaceRef} applies.
 */
export function resolveEdgeRef(oc: Occt, solid: Solid, ref: EdgeRef): TopoDS_Edge | null {
  ensureMeshed(oc, solid.shape);
  const S = shapeEnums(oc);
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(solid.shape, S.TopAbs_EDGE, S.TopAbs_FACE, map);
  const cap = centroidCap(oc, solid);
  let best: TopoDS_Edge | null = null;
  let bestScore = -Infinity;
  const count = map.Extent();
  for (let i = 1; i <= count; i++) {
    const faceList = map.FindFromIndex(i);
    const edge = oc.TopoDS.Edge_1(map.FindKey(i));
    let score: number;
    if (ref.faceSurfaces) {
      const pair = adjacentFaceSurfaces(oc, faceList);
      if (!pair || !surfacePairMatches(pair, ref.faceSurfaces)) {
        edge.delete();
        continue;
      }
      score = ref.midpoint ? -sqDist(edgeMidpoint(oc, edge), ref.midpoint) : 0;
    } else {
      const [a, b] = adjacentFaceNormals(oc, faceList);
      // Order-independent: the ref's two normals may be stored in either order.
      const s1 = dot(a, ref.faceNormals[0]) + dot(b, ref.faceNormals[1]);
      const s2 = dot(a, ref.faceNormals[1]) + dot(b, ref.faceNormals[0]);
      const normalScore = Math.max(s1, s2);
      if (normalScore < EDGE_SCORE_TOL) {
        edge.delete();
        continue;
      }
      score = ref.midpoint ? -sqDist(edgeMidpoint(oc, edge), ref.midpoint) : normalScore;
    }
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = edge;
    } else {
      edge.delete();
    }
  }
  map.delete();
  if (best && ref.midpoint && bestScore !== -Infinity && -bestScore > cap * cap) {
    best.delete();
    return null;
  }
  return best;
}

/** The two adjacent faces' analytic surfaces for an edge, or null if it does
 * not border exactly two faces (a seam/free edge). */
function adjacentFaceSurfaces(
  oc: Occt,
  faceList: { Extent(): number; First_1(): { delete(): void }; Last_1(): { delete(): void } },
): [SurfaceSignature, SurfaceSignature] | null {
  if (faceList.Extent() < 2) return null;
  const f1 = oc.TopoDS.Face_1(faceList.First_1() as never);
  const f2 = oc.TopoDS.Face_1(faceList.Last_1() as never);
  try {
    return [faceSurfaceSignature(oc, f1), faceSurfaceSignature(oc, f2)];
  } finally {
    f1.delete();
    f2.delete();
  }
}

/** Order-independent match of an adjacent-surface pair. */
function surfacePairMatches(
  a: readonly [SurfaceSignature, SurfaceSignature],
  b: readonly [SurfaceSignature, SurfaceSignature],
): boolean {
  return (
    (surfacesMatch(a[0], b[0]) && surfacesMatch(a[1], b[1])) ||
    (surfacesMatch(a[0], b[1]) && surfacesMatch(a[1], b[0]))
  );
}

/** The unit tangent direction of the edge matching `ref` (start→end). */
export function resolveEdgeDirection(
  oc: Occt,
  solid: Solid,
  ref: EdgeRef,
): [number, number, number] {
  const d = resolveEdgeAxis(oc, solid, ref).direction;
  return [d[0], d[1], d[2]];
}

/**
 * Origin (edge midpoint) + unit tangent of the edge matching `ref`.
 * Used for revolve-about-edge and any axis-from-edge feature (C2).
 */
export function resolveEdgeAxis(
  oc: Occt,
  solid: Solid,
  ref: EdgeRef,
): { origin: Vec3; direction: Vec3 } {
  const edge = resolveEdgeRef(oc, solid, ref);
  if (!edge) throw new Error("resolveEdgeAxis: no edge matched the EdgeRef signature");
  try {
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    try {
      const p0 = curve.Value(curve.FirstParameter());
      const p1 = curve.Value(curve.LastParameter());
      const a: Vec3 = [p0.X(), p0.Y(), p0.Z()];
      const b: Vec3 = [p1.X(), p1.Y(), p1.Z()];
      p0.delete();
      p1.delete();
      const direction = normalize(sub(b, a));
      // Prefer the geometric midpoint; fall back to ref.midpoint only if needed
      // (both endpoints coincide would already fail normalize above).
      const origin: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      return { origin, direction };
    } finally {
      curve.delete();
    }
  } finally {
    edge.delete();
  }
}
