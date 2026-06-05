// Chamfer feature (SPEC-4 FR-9): bevel selected edges by a distance, via OCCT
// BRepFilletAPI_MakeChamfer. Edges are addressed by persistent EdgeRefs (FR-16).

import type { TopAbs_ShapeEnum, TopoDS_Edge } from "opencascade.js";
import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { resolveEdge, type EdgeRef } from "./selection.js";

/** Symmetric chamfer (equal setback `distance`) of the referenced edges. */
export function chamfer(
  oc: Occt,
  solid: Solid,
  edges: readonly EdgeRef[],
  distance: number,
): Solid {
  const mk = new oc.BRepFilletAPI_MakeChamfer(solid.shape);
  const resolved: TopoDS_Edge[] = [];
  try {
    for (const ref of edges) {
      const e = resolveEdge(oc, solid, ref);
      if (!e) {
        throw new Error("chamfer: edge reference unresolvable on the current solid (R2)");
      }
      resolved.push(e);
      mk.Add_2(distance, e);
    }
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("chamfer produced an invalid solid");
    }
    return result;
  } finally {
    for (const e of resolved) e.delete();
    mk.delete();
  }
}

/** Symmetric chamfer of EVERY edge of the solid (the editor's "bevel all"). */
export function chamferAllEdges(oc: Occt, solid: Solid, distance: number): Solid {
  const mk = new oc.BRepFilletAPI_MakeChamfer(solid.shape);
  const edgeEnum = oc.TopAbs_ShapeEnum.TopAbs_EDGE as TopAbs_ShapeEnum;
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_1(solid.shape, edgeEnum, map);
    for (let i = 1; i <= map.Extent(); i++) {
      const edge = oc.TopoDS.Edge_1(map.FindKey(i));
      mk.Add_2(distance, edge);
      edge.delete();
    }
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("chamfer-all produced an invalid solid (distance too large?)");
    }
    return result;
  } finally {
    map.delete();
    mk.delete();
  }
}
