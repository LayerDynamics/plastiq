// 2D parametric sketch (SPEC-4 FR-2). A sketch is a closed profile on a datum
// plane; `toFace` builds the OCCT planar face that extrude/revolve/sweep consume.
//
// Profiles are built from ordered *segments*: straight lines, circular arcs,
// and B-splines, plus the standalone full circle. A line-only profile keeps the
// fast `BRepBuilderAPI_MakePolygon` path (identical topology to before curved
// segments existed); any curved segment switches to an edge-by-edge
// `BRepBuilderAPI_MakeWire`. This is the geometry the editor's sketch model
// lowers to (apps/cad-studio): persist the constraints, derive the wire here.

import type { TopoDS_Edge, TopoDS_Face, TopoDS_Wire } from "opencascade.js";
import { pointOnPlane, type DatumPlane } from "../environment/plane.js";
import type { Occt } from "../oc/init.js";

export type Point2D = readonly [u: number, v: number];

/** An ordered piece of the profile, starting at the previous segment's end. */
type Segment =
  | { kind: "line"; to: Point2D }
  | { kind: "arc"; through: Point2D; to: Point2D }
  | { kind: "spline"; through: readonly Point2D[] };

/** Anything OCCT-owned that must be `.delete()`d after a build. */
interface Deletable {
  delete(): void;
}

export class Sketch {
  private start: Point2D | null = null;
  private readonly segments: Segment[] = [];
  /** A standalone full circle profile (mutually exclusive with segments). */
  private circleDef: { center: Point2D; radius: number } | null = null;

  constructor(readonly plane: DatumPlane) {}

  /**
   * Append a straight segment. The first call sets the profile's start vertex;
   * each subsequent call adds a line from the running point to (u,v). A
   * line-only chain reproduces the polygon profile exactly.
   */
  lineTo(u: number, v: number): this {
    if (this.start === null) this.start = [u, v];
    else this.segments.push({ kind: "line", to: [u, v] });
    return this;
  }

  /**
   * Append a circular arc from the running point, passing through (tu,tv) and
   * ending at (eu,ev) — the three-point arc (FR-16). Requires a prior start
   * vertex (call `lineTo` first).
   */
  arcTo(tu: number, tv: number, eu: number, ev: number): this {
    if (this.start === null) throw new Error("arcTo needs a start point (call lineTo first)");
    this.segments.push({ kind: "arc", through: [tu, tv], to: [eu, ev] });
    return this;
  }

  /**
   * Append a B-spline from the running point through the given interpolation
   * points (ending at the last) — the spline tool (FR-16). Requires a prior
   * start vertex.
   */
  splineTo(through: readonly Point2D[]): this {
    if (this.start === null) throw new Error("splineTo needs a start point (call lineTo first)");
    if (through.length < 1) throw new Error("splineTo needs ≥ 1 point");
    this.segments.push({ kind: "spline", through: through.map(([u, v]) => [u, v] as Point2D) });
    return this;
  }

  /** A standalone full-circle profile centred at (cu,cv) with the given radius. */
  static circle(plane: DatumPlane, cu: number, cv: number, radius: number): Sketch {
    if (!(radius > 0)) throw new Error(`circle radius must be > 0, got ${radius}`);
    const s = new Sketch(plane);
    s.circleDef = { center: [cu, cv], radius };
    return s;
  }

  /** A centred rectangle profile of the given width (u) × height (v). */
  static rectangle(plane: DatumPlane, width: number, height: number): Sketch {
    const hw = width / 2;
    const hh = height / 2;
    return new Sketch(plane).lineTo(-hw, -hh).lineTo(hw, -hh).lineTo(hw, hh).lineTo(-hw, hh);
  }

  /** A regular polygon profile (n sides, circumradius r) — also useful for revolve. */
  static regularPolygon(plane: DatumPlane, sides: number, radius: number): Sketch {
    if (sides < 3) throw new Error("a polygon needs ≥ 3 sides");
    const s = new Sketch(plane);
    for (let i = 0; i < sides; i++) {
      const a = (2 * Math.PI * i) / sides;
      s.lineTo(radius * Math.cos(a), radius * Math.sin(a));
    }
    return s;
  }

  get vertexCount(): number {
    if (this.circleDef) return 0;
    let n = this.start ? 1 : 0;
    for (const seg of this.segments) n += seg.kind === "spline" ? seg.through.length : 1;
    return n;
  }

  /** The straight-line vertex sequence (only meaningful for a line-only profile). */
  private polylinePoints(): Point2D[] {
    const pts: Point2D[] = [];
    if (this.start) pts.push(this.start);
    for (const seg of this.segments) if (seg.kind === "line") pts.push(seg.to);
    return pts;
  }

  /**
   * Build the closed planar profile wire (OCCT). 2D vertices are mapped to 3D
   * via the datum plane. A line-only profile is polygonized; a profile with any
   * arc/spline segment (or a full circle) is assembled edge-by-edge. This is the
   * section input for loft (FR-12) and the profile for sweep (FR-13); `toFace`
   * faces it.
   *
   * Throws on a degenerate profile or an OCCT build failure (NFR-3). The
   * returned wire is owned by the caller (`.delete()` it).
   */
  toWire(oc: Occt): TopoDS_Wire {
    if (this.circleDef) return this.circleWire(oc, this.circleDef);
    if (this.segments.every((s) => s.kind === "line")) return this.polygonWire(oc);
    return this.curvedWire(oc);
  }

  private polygonWire(oc: Occt): TopoDS_Wire {
    const pts = this.polylinePoints();
    if (pts.length < 3) throw new Error(`profile needs ≥ 3 points, got ${pts.length}`);
    const poly = new oc.BRepBuilderAPI_MakePolygon_1();
    try {
      for (const [u, v] of pts) {
        const [x, y, z] = pointOnPlane(this.plane, u, v);
        const pnt = new oc.gp_Pnt_3(x, y, z);
        poly.Add_1(pnt);
        pnt.delete();
      }
      poly.Close();
      if (!poly.IsDone()) throw new Error("failed to build profile wire");
      return poly.Wire();
    } finally {
      poly.delete();
    }
  }

  /** A single full-circle edge → wire, oriented on the datum plane. */
  private circleWire(oc: Occt, def: { center: Point2D; radius: number }): TopoDS_Wire {
    const [cx, cy, cz] = pointOnPlane(this.plane, def.center[0], def.center[1]);
    const [nx, ny, nz] = this.plane.normal;
    const [ux, uy, uz] = this.plane.uAxis;
    const ctr = new oc.gp_Pnt_3(cx, cy, cz);
    const nrm = new oc.gp_Dir_4(nx, ny, nz);
    const vx = new oc.gp_Dir_4(ux, uy, uz);
    const ax = new oc.gp_Ax2_2(ctr, nrm, vx);
    const circ = new oc.gp_Circ_2(ax, def.radius);
    const me = new oc.BRepBuilderAPI_MakeEdge_8(circ);
    try {
      if (!me.IsDone()) throw new Error("failed to build circle edge");
      const mw = new oc.BRepBuilderAPI_MakeWire_2(me.Edge());
      try {
        if (!mw.IsDone()) throw new Error("failed to build circle wire");
        return mw.Wire();
      } finally {
        mw.delete();
      }
    } finally {
      me.delete();
      circ.delete();
      ax.delete();
      vx.delete();
      nrm.delete();
      ctr.delete();
    }
  }

  /** Assemble line/arc/spline segments (closing the loop) into one wire. */
  private curvedWire(oc: Occt): TopoDS_Wire {
    if (this.start === null) throw new Error("profile needs a start point");
    const trash: Deletable[] = [];
    const pnt = (p: Point2D) => {
      const [x, y, z] = pointOnPlane(this.plane, p[0], p[1]);
      const g = new oc.gp_Pnt_3(x, y, z);
      trash.push(g);
      return g;
    };
    const lineEdge = (a: Point2D, b: Point2D): TopoDS_Edge => {
      const me = new oc.BRepBuilderAPI_MakeEdge_3(pnt(a), pnt(b));
      trash.push(me);
      if (!me.IsDone()) throw new Error("failed to build line edge");
      return me.Edge();
    };
    const wire = new oc.BRepBuilderAPI_MakeWire_1();
    try {
      let cur: Point2D = this.start;
      for (const seg of this.segments) {
        if (seg.kind === "line") {
          wire.Add_1(lineEdge(cur, seg.to));
          cur = seg.to;
        } else if (seg.kind === "arc") {
          const arc = new oc.GC_MakeArcOfCircle_4(pnt(cur), pnt(seg.through), pnt(seg.to));
          trash.push(arc);
          if (!arc.IsDone()) throw new Error("failed to build arc");
          // GC returns a Handle_Geom_TrimmedCurve; upcast for the edge.
          const trimmed = arc.Value();
          const curve = new oc.Handle_Geom_Curve_2(trimmed.get());
          const me = new oc.BRepBuilderAPI_MakeEdge_24(curve);
          trash.push(trimmed, curve, me);
          if (!me.IsDone()) throw new Error("failed to build arc edge");
          wire.Add_1(me.Edge());
          cur = seg.to;
        } else {
          const all: Point2D[] = [cur, ...seg.through];
          const arr = new oc.TColgp_Array1OfPnt_2(1, all.length);
          trash.push(arr);
          for (let i = 0; i < all.length; i++) arr.SetValue(i + 1, pnt(all[i]!));
          const fit = new oc.GeomAPI_PointsToBSpline_2(
            arr,
            3,
            8,
            oc.GeomAbs_Shape.GeomAbs_C2 as never,
            1e-6,
          );
          trash.push(fit);
          if (!fit.IsDone()) throw new Error("failed to fit spline");
          const bspline = fit.Curve();
          const curve = new oc.Handle_Geom_Curve_2(bspline.get());
          const me = new oc.BRepBuilderAPI_MakeEdge_24(curve);
          trash.push(bspline, curve, me);
          if (!me.IsDone()) throw new Error("failed to build spline edge");
          wire.Add_1(me.Edge());
          cur = seg.through[seg.through.length - 1]!;
        }
      }
      // Close the loop back to the start if the last segment didn't land there.
      if (cur[0] !== this.start[0] || cur[1] !== this.start[1]) {
        wire.Add_1(lineEdge(cur, this.start));
      }
      if (!wire.IsDone()) throw new Error("failed to build profile wire");
      return wire.Wire();
    } finally {
      for (const t of trash) t.delete();
      wire.delete();
    }
  }

  /**
   * Build the closed planar face for this profile (OCCT). The profile wire is
   * built (line/arc/spline/circle) and faced.
   *
   * Throws on a degenerate profile or an OCCT build failure (NFR-3). The
   * returned face is owned by the caller (`.delete()` it).
   */
  toFace(oc: Occt): TopoDS_Face {
    const wire = this.toWire(oc);
    const makeFace = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
    try {
      if (!makeFace.IsDone()) throw new Error("failed to build profile face");
      return makeFace.Face();
    } finally {
      makeFace.delete();
      wire.delete();
    }
  }
}
