// Dress-up operations: fillet / chamfer / shell / draft. Each consumes persistent
// EdgeRef/FaceRef selections, re-resolving them against `base`'s current topology
// (SPEC-4 FR-16) so a dress-up survives an upstream parametric rebuild.

import type {
  ChFi3d_FilletShape,
  BRepOffset_Mode,
  GeomAbs_JoinType,
  TopoDS_Face,
} from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import { resolveEdgeRef, resolveFaceRef } from "../mesh/resolve.js";
import type { EdgeRef, FaceRef } from "../mesh/tagged.js";

/** Round the picked edges of `base` to a constant `radius` (SI metres). */
export function fillet(oc: Occt, base: Solid, edges: readonly EdgeRef[], radius: number): Solid {
  const shapeType = oc.ChFi3d_FilletShape.ChFi3d_Rational as unknown as ChFi3d_FilletShape;
  const maker = new oc.BRepFilletAPI_MakeFillet(base.shape, shapeType);
  let added = 0;
  for (const ref of edges) {
    const edge = resolveEdgeRef(oc, base, ref);
    if (edge) {
      maker.Add_2(radius, edge);
      edge.delete();
      added++;
    }
  }
  if (added === 0) {
    maker.delete();
    throw new Error("fillet: none of the selected edges resolved on the current body");
  }
  const shape = maker.Shape();
  maker.delete();
  if (shape.IsNull()) throw new Error("fillet: produced an empty shape");
  return new Solid(oc, shape);
}

/** Chamfer the picked edges of `base` by a symmetric setback `distance`. */
export function chamfer(
  oc: Occt,
  base: Solid,
  edges: readonly EdgeRef[],
  distance: number,
): Solid {
  const maker = new oc.BRepFilletAPI_MakeChamfer(base.shape);
  let added = 0;
  for (const ref of edges) {
    const edge = resolveEdgeRef(oc, base, ref);
    if (edge) {
      maker.Add_2(distance, edge);
      edge.delete();
      added++;
    }
  }
  if (added === 0) {
    maker.delete();
    throw new Error("chamfer: none of the selected edges resolved on the current body");
  }
  // BRepFilletAPI_MakeChamfer.IsDone() may stay false until Shape() builds; guard
  // on a non-null result instead.
  const shape = maker.Shape();
  maker.delete();
  if (shape.IsNull()) throw new Error("chamfer: produced an empty shape");
  return new Solid(oc, shape);
}

/** Hollow `base` to a wall `thickness`, opening the picked faces. */
export function shell(oc: Occt, base: Solid, faces: readonly FaceRef[], thickness: number): Solid {
  const list = new oc.TopTools_ListOfShape_1();
  const resolved: TopoDS_Face[] = [];
  for (const ref of faces) {
    const f = resolveFaceRef(oc, base, ref);
    if (f) {
      list.Append_1(f);
      resolved.push(f);
    }
  }
  if (resolved.length === 0) {
    list.delete();
    throw new Error("shell: none of the selected faces resolved on the current body");
  }
  const maker = new oc.BRepOffsetAPI_MakeThickSolid();
  const progress = new oc.Message_ProgressRange_1();
  // Negative offset hollows inward, leaving a wall of `thickness`.
  maker.MakeThickSolidByJoin(
    base.shape,
    list,
    -thickness,
    1e-3,
    oc.BRepOffset_Mode.BRepOffset_Skin as unknown as BRepOffset_Mode,
    false,
    false,
    oc.GeomAbs_JoinType.GeomAbs_Arc as unknown as GeomAbs_JoinType,
    false,
    progress,
  );
  const shape = maker.Shape();
  maker.delete();
  progress.delete();
  for (const f of resolved) f.delete();
  list.delete();
  if (shape.IsNull()) throw new Error("shell: produced an empty shape");
  return new Solid(oc, shape);
}

export interface DraftOptions {
  readonly face: FaceRef;
  /** Pull (mold-release) direction. */
  readonly pullDirection: Vec3;
  readonly neutralOrigin: Vec3;
  readonly neutralNormal: Vec3;
  /** Taper angle in radians. */
  readonly angle: number;
}

/** Taper the picked face of `base` about a neutral plane (mold draft). */
export function draft(oc: Occt, base: Solid, opts: DraftOptions): Solid {
  const face = resolveFaceRef(oc, base, opts.face);
  if (!face) throw new Error("draft: the selected face did not resolve on the current body");

  const da = new oc.BRepOffsetAPI_DraftAngle_2(base.shape);
  const dir = new oc.gp_Dir_4(opts.pullDirection[0], opts.pullDirection[1], opts.pullDirection[2]);
  const origin = new oc.gp_Pnt_3(opts.neutralOrigin[0], opts.neutralOrigin[1], opts.neutralOrigin[2]);
  const normal = new oc.gp_Dir_4(opts.neutralNormal[0], opts.neutralNormal[1], opts.neutralNormal[2]);
  const plane = new oc.gp_Pln_3(origin, normal);
  const progress = new oc.Message_ProgressRange_1();
  try {
    da.Add(face, dir, opts.angle, plane, true);
    da.Build(progress);
    if (!da.IsDone()) throw new Error("draft: the taper could not be applied");
    const shape = da.Shape();
    if (shape.IsNull()) throw new Error("draft: produced an empty shape");
    return new Solid(oc, shape);
  } finally {
    da.delete();
    plane.delete();
    normal.delete();
    origin.delete();
    dir.delete();
    face.delete();
    progress.delete();
  }
}
