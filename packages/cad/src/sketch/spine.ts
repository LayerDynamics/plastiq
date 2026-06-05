// SpinePath — an open 3D path (world coords) used as a sweep spine.

import type { TopoDS_Wire } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";

export interface SpineLineSegment {
  readonly kind: "line";
  readonly to: Vec3;
}
export interface SpineArcSegment {
  readonly kind: "arc";
  readonly through: Vec3;
  readonly to: Vec3;
}
export type SpineSegment = SpineLineSegment | SpineArcSegment;

export interface SpinePath {
  readonly start: Vec3;
  readonly segments: readonly SpineSegment[];
}

function pnt(oc: Occt, p: Vec3) {
  return new oc.gp_Pnt_3(p[0], p[1], p[2]);
}

/** Build an OPEN OCCT wire (no auto-close) from a 3D spine path. */
export function buildSpineWire(oc: Occt, path: SpinePath): TopoDS_Wire {
  if (path.segments.length === 0) throw new Error("SpinePath: needs at least one segment");
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const trash: Array<{ delete(): void }> = [];
  let current = path.start;
  for (const seg of path.segments) {
    if (seg.kind === "line") {
      const a = pnt(oc, current);
      const b = pnt(oc, seg.to);
      const em = new oc.BRepBuilderAPI_MakeEdge_3(a, b);
      const edge = em.Edge();
      wireMaker.Add_1(edge);
      trash.push(a, b, em, edge);
      current = seg.to;
    } else {
      const a = pnt(oc, current);
      const m = pnt(oc, seg.through);
      const b = pnt(oc, seg.to);
      const arc = new oc.GC_MakeArcOfCircle_4(a, m, b);
      const handle = arc.Value();
      const em = new oc.BRepBuilderAPI_MakeEdge_24(handle);
      const edge = em.Edge();
      wireMaker.Add_1(edge);
      trash.push(a, m, b, arc, handle, em, edge);
      current = seg.to;
    }
  }
  if (!wireMaker.IsDone()) {
    wireMaker.delete();
    for (const t of trash) t.delete();
    throw new Error("SpinePath: failed to build a spine wire");
  }
  const wire = wireMaker.Wire();
  wireMaker.delete();
  for (const t of trash) t.delete();
  return wire;
}
