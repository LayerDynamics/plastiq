// Persistent topological naming (SPEC-4 FR-16 / R2). The hard problem: a feature
// selects "this face/edge", but a parametric rebuild regenerates the topology so
// raw handles/indices change. We identify geometry by a GEOMETRIC SIGNATURE that
// survives rebuilds:
//
//   • a FACE by its outward normal direction;
//   • an EDGE by the (unordered) pair of its adjacent faces' normals.
//
// For an axis-aligned box, changing width/height/depth preserves every face
// normal and every edge's adjacent-normal pair, so selections re-resolve to the
// same logical geometry. This is robust for solids whose faces have distinct
// normals (boxes, prisms, most machined parts). Solids with many coplanar faces
// need a finer signature (documented limit of this scheme).

import type { TopoDS_Edge, TopoDS_Face } from "opencascade.js";
import { normalize, sub, type Vec3 } from "../math/index.js";
import { massProperties } from "../lower/massprops.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";

export interface FaceRef {
  readonly normal: Vec3;
}

export interface EdgeRef {
  /** The two adjacent faces' normals (order-independent). */
  readonly faceNormals: readonly [Vec3, Vec3];
}

const ALIGN_TOL = 1e-6; // 1 − dot must be below this for two unit normals to "match"

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function aligned(a: Vec3, b: Vec3): boolean {
  return 1 - dot(a, b) < ALIGN_TOL;
}

/** Centre of mass of a single face (its area centroid), in world coordinates. */
function faceCentroid(oc: Occt, face: TopoDS_Face): Vec3 {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const c = props.CentreOfMass();
    const v: Vec3 = [c.X(), c.Y(), c.Z()];
    c.delete();
    return v;
  } finally {
    props.delete();
  }
}

/**
 * Outward unit normal of `face`, oriented to point away from `solidCenter`
 * (the solid's centroid). This is robust for convex solids and avoids depending
 * on OCCT face orientation flags (whose embind enum comparison is unreliable).
 * Evaluated at the surface origin — exact for planar faces.
 */
export function faceNormal(oc: Occt, face: TopoDS_Face, solidCenter: Vec3): Vec3 {
  const gprop = new oc.BRepGProp_Face_2(face, false);
  const p = new oc.gp_Pnt_3(0, 0, 0);
  const vn = new oc.gp_Vec_4(0, 0, 1);
  let n: Vec3;
  try {
    gprop.Normal(0, 0, p, vn);
    n = normalize([vn.X(), vn.Y(), vn.Z()]);
  } finally {
    vn.delete();
    p.delete();
    gprop.delete();
  }
  // Flip so the normal points outward (away from the solid centroid).
  const outward = sub(faceCentroid(oc, face), solidCenter);
  return dot(n, outward) < 0 ? [-n[0], -n[1], -n[2]] : n;
}

interface FaceEntry {
  face: TopoDS_Face;
  normal: Vec3;
}

/** All faces of `solid` with their outward normals. Caller owns the returned face handles. */
export function listFaces(oc: Occt, solid: Solid): FaceEntry[] {
  const c = massProperties(oc, solid, 1).com; // solid centroid (unit density)
  const center: Vec3 = [c[0], c[1], c[2]];
  const faces: FaceEntry[] = [];
  const exp = new oc.TopExp_Explorer_2(
    solid.shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE as never,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
  );
  try {
    for (; exp.More(); exp.Next()) {
      const face = oc.TopoDS.Face_1(exp.Current());
      faces.push({ face, normal: faceNormal(oc, face, center) });
    }
  } finally {
    exp.delete();
  }
  return faces;
}

interface EdgeEntry {
  edge: TopoDS_Edge;
  normals: Vec3[];
}

/** Unique edges of `solid`, each with its adjacent faces' normals. Caller owns the edge handles. */
export function buildEdgeAdjacency(oc: Occt, solid: Solid): EdgeEntry[] {
  const faces = listFaces(oc, solid);
  const edges: EdgeEntry[] = [];
  try {
    for (const { face, normal } of faces) {
      const exp = new oc.TopExp_Explorer_2(
        face,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE as never,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never,
      );
      try {
        for (; exp.More(); exp.Next()) {
          const e = oc.TopoDS.Edge_1(exp.Current());
          const existing = edges.find((entry) => entry.edge.IsSame(e));
          if (existing) {
            existing.normals.push(normal);
            e.delete();
          } else {
            edges.push({ edge: e, normals: [normal] });
          }
        }
      } finally {
        exp.delete();
      }
    }
  } finally {
    for (const f of faces) f.face.delete();
  }
  return edges;
}

/**
 * Resolve a face by its normal signature against `solid`. Returns the matching
 * face (caller owns it) or null if no face aligns (an unresolvable selection →
 * the caller surfaces a typed rebuild error, FR-16/R2).
 */
export function resolveFace(oc: Occt, solid: Solid, ref: FaceRef): TopoDS_Face | null {
  const faces = listFaces(oc, solid);
  let bestIdx = -1;
  let bestDot = -Infinity;
  faces.forEach((f, i) => {
    const d = dot(f.normal, ref.normal);
    if (d > bestDot) {
      bestDot = d;
      bestIdx = i;
    }
  });
  const matched = bestIdx >= 0 && 1 - bestDot < ALIGN_TOL;
  const result = matched ? faces[bestIdx]!.face : null;
  faces.forEach((f, i) => {
    if (i !== bestIdx || !matched) f.face.delete();
  });
  return result;
}

/**
 * Resolve an edge by its adjacent-face-normal-pair signature. Returns the
 * matching edge (caller owns it) or null if unresolvable.
 */
export function resolveEdge(oc: Occt, solid: Solid, ref: EdgeRef): TopoDS_Edge | null {
  const edges = buildEdgeAdjacency(oc, solid);
  const [r0, r1] = ref.faceNormals;
  let matchIdx = -1;
  edges.forEach((entry, i) => {
    if (matchIdx >= 0 || entry.normals.length < 2) return;
    // The edge's two adjacent normals must equal the ref pair (either order).
    const [n0, n1] = entry.normals;
    const direct = aligned(n0!, r0) && aligned(n1!, r1);
    const swapped = aligned(n0!, r1) && aligned(n1!, r0);
    if (direct || swapped) matchIdx = i;
  });
  const result = matchIdx >= 0 ? edges[matchIdx]!.edge : null;
  edges.forEach((entry, i) => {
    if (i !== matchIdx) entry.edge.delete();
  });
  return result;
}

/** World centroid of the face matching `ref` on `solid`, or null if unresolved. */
export function resolveFaceCenter(oc: Occt, solid: Solid, ref: FaceRef): Vec3 | null {
  const face = resolveFace(oc, solid, ref);
  if (!face) return null;
  try {
    return faceCentroid(oc, face);
  } finally {
    face.delete();
  }
}

/** Unit direction (first→last endpoint) of the edge matching `ref`, or null. */
export function resolveEdgeDirection(oc: Occt, solid: Solid, ref: EdgeRef): Vec3 | null {
  const edge = resolveEdge(oc, solid, ref);
  if (!edge) return null;
  const curve = new oc.BRepAdaptor_Curve_2(edge);
  try {
    const p0 = curve.Value(curve.FirstParameter());
    const p1 = curve.Value(curve.LastParameter());
    const d: Vec3 = [p1.X() - p0.X(), p1.Y() - p0.Y(), p1.Z() - p0.Z()];
    p0.delete();
    p1.delete();
    if (Math.hypot(d[0], d[1], d[2]) < 1e-12) return null;
    return normalize(d);
  } finally {
    curve.delete();
    edge.delete();
  }
}
