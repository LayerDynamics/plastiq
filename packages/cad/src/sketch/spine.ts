// SpinePath — an open 3D path (world coords) used as a sweep spine. The editor
// builds a polyline path; buildSpineWire turns it into an OCCT wire of segments.

import type { TopoDS_Wire } from "opencascade.js";

import type { Occt } from "../oc/init.js";

type Point3 = readonly [number, number, number];

/** A polyline sweep path through a sequence of world-space points. */
export interface SpinePath {
  readonly kind: "polyline";
  readonly points: readonly Point3[];
}

function pnt(oc: Occt, p: Point3) {
  return new oc.gp_Pnt_3(p[0], p[1], p[2]);
}

/** Build an OPEN OCCT wire (no auto-close) from a polyline spine path. */
export function buildSpineWire(oc: Occt, path: SpinePath): TopoDS_Wire {
  if (path.points.length < 2) throw new Error("SpinePath: needs at least two points");
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const trash: Array<{ delete(): void }> = [];
  const cleanup = (): void => {
    wireMaker.delete();
    for (const t of trash) t.delete();
  };
  let segments = 0;
  for (let i = 1; i < path.points.length; i++) {
    const p0 = path.points[i - 1]!;
    const p1 = path.points[i]!;
    // Skip a zero-length segment (coincident consecutive points): OCCT would
    // build a degenerate edge from it that corrupts the swept solid. A spine of
    // ENTIRELY coincident points leaves no real segment and is rejected below —
    // the points.length check alone can't catch a 2-identical-point spine.
    if (Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]) < 1e-7) continue;
    const a = pnt(oc, p0);
    const b = pnt(oc, p1);
    const em = new oc.BRepBuilderAPI_MakeEdge_3(a, b);
    const edge = em.Edge();
    wireMaker.Add_1(edge);
    trash.push(a, b, em, edge);
    segments++;
  }
  if (segments === 0) {
    cleanup();
    throw new Error("SpinePath: zero-length spine (all points coincide)");
  }
  if (!wireMaker.IsDone()) {
    cleanup();
    throw new Error("SpinePath: failed to build a spine wire");
  }
  const wire = wireMaker.Wire();
  cleanup();
  return wire;
}
