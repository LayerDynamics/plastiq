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
  let best: TopoDS_Face | null = null;
  let bestScore = -Infinity;
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const aligned = dot(faceNormal(oc, face), ref.normal);
    if (aligned < FACE_DOT_TOL) {
      // Not a normal match — never a candidate (preserves the normal contract).
      face.delete();
      continue;
    }
    // Among normal-matches: closer centroid wins; without a ref centroid, the
    // better normal alignment wins (the legacy behavior).
    const score = ref.centroid ? -sqDist(faceCentroid(oc, face), ref.centroid) : aligned;
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = face;
    } else {
      face.delete();
    }
  }
  exp.delete();
  return best;
}

/**
 * The current solid's edge matching `ref`, or null (caller deletes).
 *
 * The adjacent-normal pair is the primary filter; when `ref.midpoint` is present
 * it disambiguates parallel edges sharing that pair by closest mid-point. Without
 * a midpoint it falls back to the best normal-pair score.
 */
export function resolveEdgeRef(oc: Occt, solid: Solid, ref: EdgeRef): TopoDS_Edge | null {
  ensureMeshed(oc, solid.shape);
  const S = shapeEnums(oc);
  const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
  oc.TopExp.MapShapesAndAncestors(solid.shape, S.TopAbs_EDGE, S.TopAbs_FACE, map);
  let best: TopoDS_Edge | null = null;
  let bestScore = -Infinity;
  const count = map.Extent();
  for (let i = 1; i <= count; i++) {
    const [a, b] = adjacentFaceNormals(oc, map.FindFromIndex(i));
    // Order-independent: the ref's two normals may be stored in either order.
    const s1 = dot(a, ref.faceNormals[0]) + dot(b, ref.faceNormals[1]);
    const s2 = dot(a, ref.faceNormals[1]) + dot(b, ref.faceNormals[0]);
    const normalScore = Math.max(s1, s2);
    const edge = oc.TopoDS.Edge_1(map.FindKey(i));
    if (normalScore < EDGE_SCORE_TOL) {
      // Not a normal-pair match — never a candidate.
      edge.delete();
      continue;
    }
    const score = ref.midpoint ? -sqDist(edgeMidpoint(oc, edge), ref.midpoint) : normalScore;
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = edge;
    } else {
      edge.delete();
    }
  }
  map.delete();
  return best;
}

/** The unit tangent direction of the edge matching `ref` (start→end). */
export function resolveEdgeDirection(
  oc: Occt,
  solid: Solid,
  ref: EdgeRef,
): [number, number, number] {
  const edge = resolveEdgeRef(oc, solid, ref);
  if (!edge) throw new Error("resolveEdgeDirection: no edge matched the EdgeRef signature");
  const curve = new oc.BRepAdaptor_Curve_2(edge);
  const p0 = curve.Value(curve.FirstParameter());
  const p1 = curve.Value(curve.LastParameter());
  const dir = normalize(sub([p1.X(), p1.Y(), p1.Z()], [p0.X(), p0.Y(), p0.Z()]));
  p0.delete();
  p1.delete();
  curve.delete();
  edge.delete();
  return [dir[0], dir[1], dir[2]];
}
