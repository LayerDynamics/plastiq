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
import { planePointToWorld, planeYAxis, type DatumPlane } from "../env/plane.js";

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
  private ellipse: { center: UV; focus1: UV; minorRadius: number } | null = null;

  constructor(plane: DatumPlane) {
    this.plane = plane;
  }

  /** A single-circle profile centred at (cx,cy) with radius r (plane space). */
  static circle(plane: DatumPlane, cx: number, cy: number, r: number): Sketch {
    const s = new Sketch(plane);
    s.circle = { center: [cx, cy], radius: r };
    return s;
  }

  /** A full ellipse parameterised like planegcs: centre, one focus, minor radius. */
  static ellipse(plane: DatumPlane, center: UV, focus1: UV, minorRadius: number): Sketch {
    const s = new Sketch(plane);
    s.ellipse = { center, focus1, minorRadius };
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
    if (this.ellipse) {
      const { center, focus1, minorRadius } = this.ellipse;
      const fu = focus1[0] - center[0];
      const fv = focus1[1] - center[1];
      const focal = Math.hypot(fu, fv);
      const majorRadius = Math.hypot(focal, minorRadius);
      if (
        !Number.isFinite(minorRadius) ||
        minorRadius <= 0 ||
        !Number.isFinite(majorRadius) ||
        majorRadius < minorRadius ||
        focal <= 1e-12
      ) {
        throw new Error("Sketch: ellipse needs a positive minor radius and a distinct focus");
      }
      const trash: Array<{ delete(): void }> = [];
      const own = <T extends { delete(): void }>(t: T): T => {
        trash.push(t);
        return t;
      };
      try {
        const c = own(pnt(oc, this.world(center)));
        const n = own(
          new oc.gp_Dir_4(this.plane.normal[0], this.plane.normal[1], this.plane.normal[2]),
        );
        const inv = 1 / focal;
        const yAxis = planeYAxis(this.plane);
        const x = own(
          new oc.gp_Dir_4(
            this.plane.xAxis[0] * fu * inv + yAxis[0] * fv * inv,
            this.plane.xAxis[1] * fu * inv + yAxis[1] * fv * inv,
            this.plane.xAxis[2] * fu * inv + yAxis[2] * fv * inv,
          ),
        );
        const ax = own(new oc.gp_Ax2_2(c, n, x));
        const ellipse = own(new oc.gp_Elips_2(ax, majorRadius, minorRadius));
        const edgeMaker = own(new oc.BRepBuilderAPI_MakeEdge_12(ellipse));
        const edge = own(edgeMaker.Edge());
        const wireMaker = own(new oc.BRepBuilderAPI_MakeWire_2(edge));
        if (!wireMaker.IsDone()) throw new Error("Sketch: failed to build ellipse wire");
        return wireMaker.Wire();
      } finally {
        for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
      }
    }

    if (this.circle) {
      // Reject a degenerate radius BEFORE allocating any OCCT temporaries:
      // gp_Circ_2 raises an opaque Standard_Failure for r < 0, and r = 0 (or a
      // non-finite r) would build an unusable degenerate edge. Failing here means
      // there is nothing to clean up.
      if (!Number.isFinite(this.circle.radius) || this.circle.radius <= 0) {
        throw new Error("Sketch: circle radius must be a positive finite number");
      }
      const trash: Array<{ delete(): void }> = [];
      // Track each temporary AS IT IS ALLOCATED so a Standard_Failure from any
      // OCCT constructor mid-build still frees everything already made.
      const own = <T extends { delete(): void }>(t: T): T => {
        trash.push(t);
        return t;
      };
      try {
        const center = this.world(this.circle.center);
        const c = own(pnt(oc, center));
        const n = own(
          new oc.gp_Dir_4(this.plane.normal[0], this.plane.normal[1], this.plane.normal[2]),
        );
        const ax = own(new oc.gp_Ax2_3(c, n));
        const circ = own(new oc.gp_Circ_2(ax, this.circle.radius));
        const edgeMaker = own(new oc.BRepBuilderAPI_MakeEdge_8(circ));
        const edge = own(edgeMaker.Edge());
        const wireMaker = own(new oc.BRepBuilderAPI_MakeWire_2(edge));
        return wireMaker.Wire();
      } finally {
        // Reverse order: makers before the primitives they were built from.
        for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
      }
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
    // Track each temporary AS IT IS ALLOCATED (not batched after the fact) so a
    // Standard_Failure thrown mid-segment — collinear arc points in
    // GC_MakeArcOfCircle_4, a failed spline fit in GeomAPI_PointsToBSpline_2 —
    // still frees everything already made (the try/finally below).
    const own = <T extends { delete(): void }>(t: T): T => {
      trash.push(t);
      return t;
    };

    const addSegment = (aUV: UV, bUV: UV): void => {
      const a = own(pnt(oc, this.world(aUV)));
      const b = own(pnt(oc, this.world(bUV)));
      const edgeMaker = own(new oc.BRepBuilderAPI_MakeEdge_3(a, b));
      const edge = own(edgeMaker.Edge());
      wireMaker.Add_1(edge);
    };
    const addArc = (aUV: UV, throughUV: UV, bUV: UV): void => {
      const a = own(pnt(oc, this.world(aUV)));
      const m = own(pnt(oc, this.world(throughUV)));
      const b = own(pnt(oc, this.world(bUV)));
      const arc = own(new oc.GC_MakeArcOfCircle_4(a, m, b));
      const trimmed = own(arc.Value());
      // Upcast Handle_Geom_TrimmedCurve → Handle_Geom_Curve for MakeEdge.
      const handle = own(new oc.Handle_Geom_Curve_2(trimmed.get()));
      const edgeMaker = own(new oc.BRepBuilderAPI_MakeEdge_24(handle));
      const edge = own(edgeMaker.Edge());
      wireMaker.Add_1(edge);
    };
    const addSpline = (aUV: UV, throughUVs: readonly UV[]): void => {
      const pts = [aUV, ...throughUVs];
      const arr = own(new oc.TColgp_Array1OfPnt_2(1, pts.length));
      pts.forEach((uv, i) => {
        const p = own(pnt(oc, this.world(uv)));
        arr.SetValue(i + 1, p);
      });
      const toBspline = own(
        new oc.GeomAPI_PointsToBSpline_2(
          arr,
          3,
          8,
          oc.GeomAbs_Shape.GeomAbs_C2 as unknown as GeomAbs_Shape,
          1e-6,
        ),
      );
      const bspline = own(toBspline.Curve());
      // Upcast Handle_Geom_BSplineCurve → Handle_Geom_Curve for MakeEdge.
      const curve = own(new oc.Handle_Geom_Curve_2(bspline.get()));
      const edgeMaker = own(new oc.BRepBuilderAPI_MakeEdge_24(curve));
      const edge = own(edgeMaker.Edge());
      wireMaker.Add_1(edge);
    };

    try {
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
        throw new Error("Sketch: failed to build a closed wire");
      }
      return wireMaker.Wire();
    } finally {
      wireMaker.delete();
      for (const t of trash) t.delete();
    }
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
