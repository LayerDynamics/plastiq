// SpinePath — an open 3D path (world coords) used as a sweep spine. The editor
// builds a polyline or a mixed line/arc path; buildSpineWire turns it into an
// OCCT wire of edges. A spine can also come from edges picked on the model
// (buildWireFromEdges), which keeps the sweep parametric: the edges are
// re-resolved from the rebuilt body each pass rather than baked to points.

import type { TopoDS_Edge, TopoDS_Wire } from "opencascade.js";

import type { Occt } from "../oc/init.js";

type Point3 = readonly [number, number, number];

/**
 * Minimum spine-segment length, in metres (the kernel's SI length unit). Two
 * points closer than 0.1 µm are treated as coincident — far below any real CAD
 * feature (µm and up) yet comfortably above floating-point noise. Revisit if the
 * kernel ever changes its length unit away from metres.
 */
const MIN_SEGMENT_LENGTH_M = 1e-7;

/** A straight or 3-point arc segment ending at `to` (world coords). */
export type SpineSegment =
  | { readonly kind: "line"; readonly to: Point3 }
  | { readonly kind: "arc"; readonly through: Point3; readonly to: Point3 };

/** A polyline sweep path through a sequence of world-space points. */
export interface SpinePolyline {
  readonly kind: "polyline";
  readonly points: readonly Point3[];
}

/**
 * A mixed line/arc sweep path: starts at `start`, then walks each segment.
 * Arc segments use the same 3-point construction as sketch arcs
 * (`GC_MakeArcOfCircle` through start → through → end).
 */
export interface SpineSegmented {
  readonly kind: "path";
  readonly start: Point3;
  readonly segments: readonly SpineSegment[];
}

/** Any spine the sweep builder accepts (polyline or mixed line/arc). */
export type SpinePath = SpinePolyline | SpineSegmented;

function pnt(oc: Occt, p: Point3) {
  return new oc.gp_Pnt_3(p[0], p[1], p[2]);
}

function dist(a: Point3, b: Point3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/** Expand a SpinePath into an ordered chain of consecutive points/arcs for building. */
function polylinePoints(path: SpinePolyline): readonly Point3[] {
  return path.points;
}

/** Build an OPEN OCCT wire (no auto-close) from a polyline or line/arc spine path. */
export function buildSpineWire(oc: Occt, path: SpinePath): TopoDS_Wire {
  if (path.kind === "polyline") {
    return buildPolylineWire(oc, polylinePoints(path));
  }
  return buildSegmentedWire(oc, path);
}

function buildPolylineWire(oc: Occt, points: readonly Point3[]): TopoDS_Wire {
  if (points.length < 2) throw new Error("SpinePath: needs at least two points");
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const trash: Array<{ delete(): void }> = [];
  let segments = 0;
  // try/finally so a Standard_Failure thrown mid-loop (BRepBuilderAPI_MakeEdge_3
  // on a pathological segment, or Add_1) still frees the wireMaker and every
  // temporary made so far — a bare throw would leak them in the worker.
  try {
    for (let i = 1; i < points.length; i++) {
      const p0 = points[i - 1]!;
      const p1 = points[i]!;
      // Skip a zero-length segment (coincident consecutive points): OCCT would
      // build a degenerate edge from it that corrupts the swept solid. A spine of
      // ENTIRELY coincident points leaves no real segment and is rejected below —
      // the points.length check alone can't catch a 2-identical-point spine.
      if (dist(p0, p1) < MIN_SEGMENT_LENGTH_M) continue;
      const a = pnt(oc, p0);
      const b = pnt(oc, p1);
      trash.push(a, b);
      const em = new oc.BRepBuilderAPI_MakeEdge_3(a, b);
      trash.push(em);
      const edge = em.Edge();
      trash.push(edge);
      wireMaker.Add_1(edge);
      segments++;
    }
    if (segments === 0) {
      throw new Error("SpinePath: zero-length spine (all points coincide)");
    }
    if (!wireMaker.IsDone()) {
      throw new Error("SpinePath: failed to build a spine wire");
    }
    return wireMaker.Wire();
  } finally {
    wireMaker.delete();
    for (const t of trash) t.delete();
  }
}

function buildSegmentedWire(oc: Occt, path: SpineSegmented): TopoDS_Wire {
  if (path.segments.length === 0) {
    throw new Error("SpinePath: needs at least one segment");
  }
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const trash: Array<{ delete(): void }> = [];
  const own = <T extends { delete(): void }>(t: T): T => {
    trash.push(t);
    return t;
  };
  let segments = 0;
  let current = path.start;
  try {
    for (const seg of path.segments) {
      if (seg.kind === "line") {
        if (dist(current, seg.to) < MIN_SEGMENT_LENGTH_M) {
          current = seg.to;
          continue;
        }
        const a = own(pnt(oc, current));
        const b = own(pnt(oc, seg.to));
        const em = own(new oc.BRepBuilderAPI_MakeEdge_3(a, b));
        const edge = own(em.Edge());
        wireMaker.Add_1(edge);
        segments++;
        current = seg.to;
      } else {
        // 3-point arc: current → through → to (same construction as Sketch.arcTo).
        if (
          dist(current, seg.through) < MIN_SEGMENT_LENGTH_M ||
          dist(seg.through, seg.to) < MIN_SEGMENT_LENGTH_M ||
          dist(current, seg.to) < MIN_SEGMENT_LENGTH_M
        ) {
          throw new Error("SpinePath: arc segment has coincident control points");
        }
        const a = own(pnt(oc, current));
        const m = own(pnt(oc, seg.through));
        const b = own(pnt(oc, seg.to));
        const arc = own(new oc.GC_MakeArcOfCircle_4(a, m, b));
        const trimmed = own(arc.Value());
        const handle = own(new oc.Handle_Geom_Curve_2(trimmed.get()));
        const em = own(new oc.BRepBuilderAPI_MakeEdge_24(handle));
        const edge = own(em.Edge());
        wireMaker.Add_1(edge);
        segments++;
        current = seg.to;
      }
    }
    if (segments === 0) {
      throw new Error("SpinePath: zero-length spine (all segments degenerate)");
    }
    if (!wireMaker.IsDone()) {
      throw new Error("SpinePath: failed to build a spine wire");
    }
    return wireMaker.Wire();
  } finally {
    wireMaker.delete();
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Build an OPEN spine wire from edges already resolved on a model body (a picked
 * edge chain). Unlike a baked polyline this preserves each edge's exact curve —
 * an arc stays an arc instead of being sampled into chords.
 *
 * `Add_3` takes the whole list at once so the edges connect regardless of the
 * order they were picked in; edges that share no vertex leave the maker
 * not-done, which surfaces as an explicit error rather than a partial spine.
 * The caller owns `edges`; the returned wire is owned by the caller.
 */
export function buildWireFromEdges(oc: Occt, edges: readonly TopoDS_Edge[]): TopoDS_Wire {
  if (edges.length === 0) throw new Error("SpinePath: needs at least one edge");
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  const list = new oc.TopTools_ListOfShape_1();
  try {
    for (const e of edges) list.Append_1(e);
    wireMaker.Add_3(list);
    if (!wireMaker.IsDone()) {
      throw new Error("SpinePath: the picked edges do not form one connected chain");
    }
    return wireMaker.Wire();
  } finally {
    wireMaker.delete();
    list.delete();
  }
}
