// Persistent-ref resolution (SPEC-4 FR-16). The inverse of signature generation:
// given a FaceRef/EdgeRef captured before an edit, find the matching face/edge in
// the *current* solid by its signature (face outward normal; edge adjacent-face
// normal pair). This is what lets a fillet/chamfer/shell re-resolve to the same
// topology after an upstream parameter rebuild.
//
// Returned shapes are owned by the caller (call `.delete()` when done).

import type { TopoDS_Edge, TopoDS_Face } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { dot, normalize, sub } from "../math/index.js";
import type { Solid } from "../solid/solid.js";
import { adjacentFaceNormals, ensureMeshed, faceNormal, shapeEnums } from "./normals.js";
import type { EdgeRef, FaceRef } from "./tagged.js";

// A face matches if its normal aligns to within ~2.6° (dot ≥ 0.999).
const FACE_DOT_TOL = 0.999;
// An edge matches if both adjacent normals align (summed dot ≥ 2·tol).
const EDGE_SCORE_TOL = 2 * FACE_DOT_TOL;

/** The current solid's face best matching `ref`, or null (caller deletes). */
export function resolveFaceRef(oc: Occt, solid: Solid, ref: FaceRef): TopoDS_Face | null {
  ensureMeshed(oc, solid.shape);
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(solid.shape, S.TopAbs_FACE, S.TopAbs_SHAPE);
  let best: TopoDS_Face | null = null;
  let bestDot = -Infinity;
  for (; exp.More(); exp.Next()) {
    const face = oc.TopoDS.Face_1(exp.Current());
    const d = dot(faceNormal(oc, face), ref.normal);
    if (d > bestDot) {
      bestDot = d;
      if (best) best.delete();
      best = face;
    } else {
      face.delete();
    }
  }
  exp.delete();
  if (best && bestDot >= FACE_DOT_TOL) return best;
  if (best) best.delete();
  return null;
}

/** The current solid's edge best matching `ref`, or null (caller deletes). */
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
    const score = Math.max(s1, s2);
    const edge = oc.TopoDS.Edge_1(map.FindKey(i));
    if (score > bestScore) {
      bestScore = score;
      if (best) best.delete();
      best = edge;
    } else {
      edge.delete();
    }
  }
  map.delete();
  if (best && bestScore >= EDGE_SCORE_TOL) return best;
  if (best) best.delete();
  return null;
}

/** The unit tangent direction of the edge matching `ref` (start→end). */
export function resolveEdgeDirection(oc: Occt, solid: Solid, ref: EdgeRef): Vec3 {
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
  return dir;
}
