// Face-normal computation shared by tessellation (signature generation) and ref
// resolution (signature matching). A face's signature is its outward unit normal
// — the area-weighted average of its triangulation's geometric normals, flipped
// for REVERSED faces so it points out of the solid.

import type {
  TopoDS_Face,
  TopoDS_Shape,
  Poly_Triangulation,
  gp_Trsf,
  TopTools_ListOfShape,
  TopAbs_ShapeEnum,
} from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";

// Poly_MeshPurpose is neither exported as a type nor exposed as an enum value by
// this opencascade.js build; the binding accepts 0 (== Poly_MeshPurpose_NONE).
// Derive the exact parameter type from the method signature rather than name it.
type MeshPurposeArg = Parameters<Occt["BRep_Tool"]["Triangulation"]>[2];
export const MESH_PURPOSE = 0 as unknown as MeshPurposeArg;

/** The shape-enum members, typed (opencascade.js types each member as `{}`). */
export interface ShapeEnums {
  TopAbs_SOLID: TopAbs_ShapeEnum;
  TopAbs_SHELL: TopAbs_ShapeEnum;
  TopAbs_FACE: TopAbs_ShapeEnum;
  TopAbs_WIRE: TopAbs_ShapeEnum;
  TopAbs_EDGE: TopAbs_ShapeEnum;
  TopAbs_VERTEX: TopAbs_ShapeEnum;
  TopAbs_SHAPE: TopAbs_ShapeEnum;
}

/** Access the (correctly-typed) TopAbs_ShapeEnum members off the instance. */
export function shapeEnums(oc: Occt): ShapeEnums {
  return oc.TopAbs_ShapeEnum as unknown as ShapeEnums;
}

/**
 * Ensure a shape carries a triangulation (idempotent — OCCT caches it, so a
 * second call on an already-meshed shape is cheap). Face-normal signatures are
 * derived from the triangulation, so resolution must mesh a freshly-built solid
 * before matching against it.
 */
export function ensureMeshed(oc: Occt, shape: TopoDS_Shape, deflection = 1e-4): void {
  const mesher = new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.5, false);
  mesher.delete();
}

/** World-space coordinates of triangulation node `i` (1-based). */
export function nodeWorld(
  tri: Poly_Triangulation,
  i: number,
  identity: boolean,
  trsf: gp_Trsf,
): Vec3 {
  const p = tri.Node(i);
  let out: Vec3;
  if (identity) {
    out = [p.X(), p.Y(), p.Z()];
  } else {
    const q = p.Transformed(trsf);
    out = [q.X(), q.Y(), q.Z()];
    q.delete();
  }
  p.delete();
  return out;
}

/** Area-weighted average geometric normal of a triangulation, oriented out. */
export function normalFromTriangulation(
  tri: Poly_Triangulation,
  identity: boolean,
  trsf: gp_Trsf,
  reversed: boolean,
): Vec3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  const nbt = tri.NbTriangles();
  for (let i = 1; i <= nbt; i++) {
    const t = tri.Triangle(i);
    const a = nodeWorld(tri, t.Value(1), identity, trsf);
    const b = nodeWorld(tri, t.Value(2), identity, trsf);
    const c = nodeWorld(tri, t.Value(3), identity, trsf);
    nx += (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    ny += (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    nz += (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    t.delete();
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  const n: Vec3 = [nx / len, ny / len, nz / len];
  return reversed ? [-n[0], -n[1], -n[2]] : n;
}

/** A face's outward unit normal (its FaceRef signature). */
export function faceNormal(oc: Occt, face: TopoDS_Face): Vec3 {
  const loc = new oc.TopLoc_Location_1();
  const handle = oc.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE);
  if (handle.IsNull()) {
    handle.delete();
    loc.delete();
    return [0, 0, 1];
  }
  const tri = handle.get();
  const identity = loc.IsIdentity();
  const trsf = loc.Transformation();
  const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
  const n = normalFromTriangulation(tri, identity, trsf, reversed);
  trsf.delete();
  handle.delete();
  loc.delete();
  return n;
}

/** The (up to two) adjacent-face normals of an edge, from its ancestors list. */
export function adjacentFaceNormals(
  oc: Occt,
  faces: TopTools_ListOfShape,
): readonly [Vec3, Vec3] {
  const f1 = oc.TopoDS.Face_1(faces.First_1());
  const n1 = faceNormal(oc, f1);
  f1.delete();
  if (faces.Size() >= 2) {
    const f2 = oc.TopoDS.Face_1(faces.Last_1());
    const n2 = faceNormal(oc, f2);
    f2.delete();
    return [n1, n2];
  }
  return [n1, n1];
}
