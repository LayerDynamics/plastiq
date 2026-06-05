// Sketch — a 2D profile on a DatumPlane, recorded as plane-space moves and built
// lazily into an OCCT wire/face when a feature operation consumes it.
//
// The app constructs a Sketch WITHOUT the engine (`new Sketch(plane)`,
// `.lineTo(u,v)`, …); the OCCT geometry is materialised on demand via
// `toWire(oc)` / `toFace(oc)`. Coordinates are plane-space (u along xAxis, v along
// the in-plane Y axis); the wire auto-closes back to the start point.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Wire, GeomAbs_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { planePointToWorld, type DatumPlane } from "../env/plane.js";

type UV = readonly [number, number];

type SketchOp =
  | { kind: "line"; to: UV }
  | { kind: "arc"; through: UV; to: UV }
  | { kind: "spline"; through: readonly UV[] };

function pnt(oc: Occt, p: Vec3) {
  return new oc.gp_Pnt_3(p[0], p[1], p[2]);
}

export class Sketch {
  readonly plane: DatumPlane;
  private readonly ops: SketchOp[] = [];
  private circle: { center: UV; radius: number } | null = null;

  constructor(plane: DatumPlane) {
    this.plane = plane;
  }

  /** A single-circle profile centred at (cx,cy) with radius r (plane space). */
  static circle(plane: DatumPlane, cx: number, cy: number, r: number): Sketch {
    const s = new Sketch(plane);
    s.circle = { center: [cx, cy], radius: r };
    return s;
  }

  /** Set the start point (first call) or add a straight segment to (u,v). */
  lineTo(u: number, v: number): this {
    this.ops.push({ kind: "line", to: [u, v] });
    return this;
  }

  /** Add a 3-point arc through (tu,tv) ending at (u,v). */
  arcTo(tu: number, tv: number, u: number, v: number): this {
    this.ops.push({ kind: "arc", through: [tu, tv], to: [u, v] });
    return this;
  }

  /** Add a B-spline through the given plane-space points. */
  splineTo(points: readonly UV[]): this {
    this.ops.push({ kind: "spline", through: points });
    return this;
  }

  private world(uv: UV): Vec3 {
    return planePointToWorld(this.plane, uv[0], uv[1]);
  }

  /** Build the closed OCCT wire for this profile (caller owns the result). */
  toWire(oc: Occt): TopoDS_Wire {
    if (this.circle) {
      const center = this.world(this.circle.center);
      const c = pnt(oc, center);
      const n = new oc.gp_Dir_4(this.plane.normal[0], this.plane.normal[1], this.plane.normal[2]);
      const ax = new oc.gp_Ax2_3(c, n);
      const circ = new oc.gp_Circ_2(ax, this.circle.radius);
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_8(circ);
      const edge = edgeMaker.Edge();
      const wireMaker = new oc.BRepBuilderAPI_MakeWire_2(edge);
      const wire = wireMaker.Wire();
      edgeMaker.delete();
      wireMaker.delete();
      edge.delete();
      circ.delete();
      ax.delete();
      n.delete();
      c.delete();
      return wire;
    }

    if (this.ops.length < 2) {
      throw new Error("Sketch: a profile needs a start move and at least one segment");
    }
    const first = this.ops[0]!;
    if (first.kind !== "line") {
      throw new Error("Sketch: the first move must set the start point via lineTo");
    }
    const startUV = first.to;
    const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
    const trash: Array<{ delete(): void }> = [];

    const addSegment = (aUV: UV, bUV: UV): void => {
      const a = pnt(oc, this.world(aUV));
      const b = pnt(oc, this.world(bUV));
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_3(a, b);
      const edge = edgeMaker.Edge();
      wireMaker.Add_1(edge);
      trash.push(a, b, edgeMaker, edge);
    };
    const addArc = (aUV: UV, throughUV: UV, bUV: UV): void => {
      const a = pnt(oc, this.world(aUV));
      const m = pnt(oc, this.world(throughUV));
      const b = pnt(oc, this.world(bUV));
      const arc = new oc.GC_MakeArcOfCircle_4(a, m, b);
      const trimmed = arc.Value();
      // Upcast Handle_Geom_TrimmedCurve → Handle_Geom_Curve for MakeEdge.
      const handle = new oc.Handle_Geom_Curve_2(trimmed.get());
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_24(handle);
      const edge = edgeMaker.Edge();
      wireMaker.Add_1(edge);
      trash.push(a, m, b, arc, trimmed, handle, edgeMaker, edge);
    };
    const addSpline = (aUV: UV, throughUVs: readonly UV[]): void => {
      const pts = [aUV, ...throughUVs];
      const arr = new oc.TColgp_Array1OfPnt_2(1, pts.length);
      const made: Array<{ delete(): void }> = [];
      pts.forEach((uv, i) => {
        const p = pnt(oc, this.world(uv));
        arr.SetValue(i + 1, p);
        made.push(p);
      });
      const toBspline = new oc.GeomAPI_PointsToBSpline_2(
        arr,
        3,
        8,
        oc.GeomAbs_Shape.GeomAbs_C2 as unknown as GeomAbs_Shape,
        1e-6,
      );
      const bspline = toBspline.Curve();
      // Upcast Handle_Geom_BSplineCurve → Handle_Geom_Curve for MakeEdge.
      const curve = new oc.Handle_Geom_Curve_2(bspline.get());
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_24(curve);
      const edge = edgeMaker.Edge();
      wireMaker.Add_1(edge);
      trash.push(arr, ...made, toBspline, bspline, curve, edgeMaker, edge);
    };

    let current: UV = startUV;
    for (let i = 1; i < this.ops.length; i++) {
      const op = this.ops[i]!;
      if (op.kind === "line") {
        addSegment(current, op.to);
        current = op.to;
      } else if (op.kind === "arc") {
        addArc(current, op.through, op.to);
        current = op.to;
      } else {
        addSpline(current, op.through);
        current = op.through[op.through.length - 1] ?? current;
      }
    }
    // Auto-close back to the start if the profile didn't already return there.
    if (current[0] !== startUV[0] || current[1] !== startUV[1]) {
      addSegment(current, startUV);
    }

    if (!wireMaker.IsDone()) {
      wireMaker.delete();
      for (const t of trash) t.delete();
      throw new Error("Sketch: failed to build a closed wire");
    }
    const wire = wireMaker.Wire();
    wireMaker.delete();
    for (const t of trash) t.delete();
    return wire;
  }

  /** Build the planar face bounded by this profile (caller owns the result). */
  toFace(oc: Occt): TopoDS_Face {
    const wire = this.toWire(oc);
    const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    if (!faceMaker.IsDone()) {
      faceMaker.delete();
      wire.delete();
      throw new Error("Sketch: failed to build a planar face from the profile");
    }
    const face = faceMaker.Face();
    faceMaker.delete();
    wire.delete();
    return face;
  }
}

/** An edge of an OCCT wire built from a sketch (exported for sweep spines). */
export type { TopoDS_Edge };
