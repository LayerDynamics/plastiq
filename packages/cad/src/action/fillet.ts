// Fillet feature (SPEC-4 FR-8): constant- and variable-radius rounding of
// selected edges, via OCCT BRepFilletAPI_MakeFillet. Edges are addressed by
// persistent EdgeRefs (FR-16), so a fillet survives upstream parameter rebuilds;
// an unresolvable reference throws a typed rebuild error (R2).

import type { TopAbs_ShapeEnum, TopoDS_Edge } from "opencascade.js";
import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { resolveEdge, type EdgeRef } from "./selection.js";

function resolveOrThrow(oc: Occt, solid: Solid, ref: EdgeRef): TopoDS_Edge {
  const edge = resolveEdge(oc, solid, ref);
  if (!edge) {
    throw new Error("fillet: edge reference unresolvable on the current solid (R2)");
  }
  return edge;
}

/** Constant-radius fillet of the referenced edges. */
export function fillet(oc: Occt, solid: Solid, edges: readonly EdgeRef[], radius: number): Solid {
  const mk = new oc.BRepFilletAPI_MakeFillet(
    solid.shape,
    oc.ChFi3d_FilletShape.ChFi3d_Rational as never,
  );
  const resolved: TopoDS_Edge[] = [];
  try {
    for (const ref of edges) {
      const e = resolveOrThrow(oc, solid, ref);
      resolved.push(e);
      mk.Add_2(radius, e);
    }
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("fillet produced an invalid solid");
    }
    return result;
  } finally {
    for (const e of resolved) e.delete();
    mk.delete();
  }
}

/**
 * Constant-radius fillet of EVERY edge of the solid — the "round all edges"
 * operation an interactive editor offers when no specific edge is picked. Robust
 * for an arbitrary extruded profile (a prism's vertical + cap edges all round).
 */
export function filletAllEdges(oc: Occt, solid: Solid, radius: number): Solid {
  const mk = new oc.BRepFilletAPI_MakeFillet(
    solid.shape,
    oc.ChFi3d_FilletShape.ChFi3d_Rational as never,
  );
  const edgeEnum = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    // Unique edges (TopExp::MapShapes), so each edge is added exactly once.
    oc.TopExp.MapShapes_1(solid.shape, edgeEnum, map);
    for (let i = 1; i <= map.Extent(); i++) {
      const edge = oc.TopoDS.Edge_1(map.FindKey(i));
      mk.Add_2(radius, edge);
      edge.delete();
    }
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("fillet-all produced an invalid solid (radius too large?)");
    }
    return result;
  } finally {
    map.delete();
    mk.delete();
  }
}

/** Variable-radius fillet of a single edge (radius blends from `r1` to `r2`). */
export function filletVariable(
  oc: Occt,
  solid: Solid,
  edge: EdgeRef,
  r1: number,
  r2: number,
): Solid {
  const mk = new oc.BRepFilletAPI_MakeFillet(
    solid.shape,
    oc.ChFi3d_FilletShape.ChFi3d_Rational as never,
  );
  const e = resolveOrThrow(oc, solid, edge);
  try {
    mk.Add_3(r1, r2, e);
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("variable fillet produced an invalid solid");
    }
    return result;
  } finally {
    e.delete();
    mk.delete();
  }
}
