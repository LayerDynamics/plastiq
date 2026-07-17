// B-rep primitive solids on OCCT.
//
// Box was long the ONLY primitive (§4.11), which made the sketcher a single point
// of failure for ALL round geometry: the only way to get a cylinder was to extrude
// a circle sketch, so every defect in the sketch/profile path (§2.6, §2.7) took
// round solids down with it, and a user could not produce so much as a shaft
// without a working sketcher.
//
// These build round solids analytically. Their faces carry EXACT cylinder / cone /
// sphere / torus surfaces, which is also precisely what §2.1's per-surface-type
// FaceRefs identify a face by — so a fillet on a primitive cylinder's wall
// re-resolves across a rebuild, where the extruded-circle equivalent depended on
// the sketch surviving unchanged.
//
// Every maker here derives from BRepPrimAPI_MakeOneAxis, whose whole base chain
// must be bound or construction throws an embind UnboundTypeError at first call —
// see occt.build.yml and oc/bindings.test.ts, which pins them.

import type { gp_Ax2, TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "./solid.js";

/** An axis-aligned box of size dx×dy×dz (SI metres) with a corner at the origin. */
export function makeBox(oc: Occt, dx: number, dy: number, dz: number): Solid {
  const maker = new oc.BRepPrimAPI_MakeBox_2(dx, dy, dz);
  const solid = maker.Solid();
  maker.delete();
  return new Solid(oc, solid);
}

/** An axis-aligned box of size dx×dy×dz with its minimum corner at `corner`. */
export function makeBoxAt(
  oc: Occt,
  corner: Vec3,
  dx: number,
  dy: number,
  dz: number,
): Solid {
  const p = new oc.gp_Pnt_3(corner[0], corner[1], corner[2]);
  const maker = new oc.BRepPrimAPI_MakeBox_3(p, dx, dy, dz);
  const solid = maker.Solid();
  maker.delete();
  p.delete();
  return new Solid(oc, solid);
}

/** Placement of a round primitive: where its base sits and which way its axis points. */
export interface AxisPlacement {
  /** Base-circle centre (cylinder/cone) or centre (sphere/torus). Default origin. */
  readonly origin?: Vec3;
  /** Axis direction; normalized by OCCT. Default +Z. */
  readonly axis?: Vec3;
}

/**
 * Build a `gp_Ax2` for a placement — the caller MUST delete it.
 *
 * A gp_Ax2 needs a reference X direction perpendicular to its axis. Rather than
 * make the caller supply one, pick any perpendicular: which one is chosen only
 * rotates the surface's parameterisation, never its geometry, and OCCT's own
 * 2-argument gp_Ax2 does exactly this.
 */
function placementAxes(oc: Occt, place: AxisPlacement | undefined): gp_Ax2 {
  const o = place?.origin ?? [0, 0, 0];
  const a = place?.axis ?? [0, 0, 1];
  const len = Math.hypot(a[0], a[1], a[2]);
  if (!(len > 0)) throw new Error("primitive: axis must be a non-zero vector");
  const p = new oc.gp_Pnt_3(o[0], o[1], o[2]);
  const d = new oc.gp_Dir_4(a[0] / len, a[1] / len, a[2] / len);
  try {
    return new oc.gp_Ax2_3(p, d);
  } finally {
    d.delete();
    p.delete();
  }
}

/** Run a primitive maker to a Solid, freeing the maker and the axes. */
function finishPrimitive(
  oc: Occt,
  make: (axes: gp_Ax2) => { Shape(): TopoDS_Shape; delete(): void },
  place: AxisPlacement | undefined,
  name: string,
): Solid {
  const axes = placementAxes(oc, place);
  try {
    const maker = make(axes);
    try {
      const shape = maker.Shape();
      // A maker's Shape() is an owned handle EVEN WHEN NULL; free it before the
      // throw or it leaks in the long-lived worker (cf. extrude.ts / boolean.ts).
      if (shape.IsNull()) {
        shape.delete();
        throw new Error(`${name}: produced an empty shape`);
      }
      return new Solid(oc, shape);
    } finally {
      maker.delete();
    }
  } finally {
    axes.delete();
  }
}

/**
 * A cylinder of `radius` and `height` (SI metres).
 *
 * The base circle sits at `place.origin` (default origin) and it extends along
 * `place.axis` (default +Z). `angle` (radians, default 2π) sweeps a partial
 * cylinder — a pie wedge — rather than a full one.
 */
export function makeCylinder(
  oc: Occt,
  radius: number,
  height: number,
  place?: AxisPlacement & { readonly angle?: number },
): Solid {
  if (!(radius > 0)) throw new Error("cylinder: radius must be > 0");
  if (!(height > 0)) throw new Error("cylinder: height must be > 0");
  const angle = place?.angle;
  return finishPrimitive(
    oc,
    (axes) =>
      angle === undefined
        ? new oc.BRepPrimAPI_MakeCylinder_3(axes, radius, height)
        : new oc.BRepPrimAPI_MakeCylinder_4(axes, radius, height, angle),
    place,
    "cylinder",
  );
}

/**
 * A sphere of `radius` centred at `place.origin` (default origin).
 *
 * `angle` (radians, default 2π) sweeps a partial sphere about the axis.
 */
export function makeSphere(
  oc: Occt,
  radius: number,
  place?: AxisPlacement & { readonly angle?: number },
): Solid {
  if (!(radius > 0)) throw new Error("sphere: radius must be > 0");
  const angle = place?.angle;
  return finishPrimitive(
    oc,
    (axes) =>
      // _9/_10 are the gp_Ax2 overloads; _5/_6 take a gp_Pnt centre and would
      // silently drop the axis.
      angle === undefined
        ? new oc.BRepPrimAPI_MakeSphere_9(axes, radius)
        : new oc.BRepPrimAPI_MakeSphere_10(axes, radius, angle),
    place,
    "sphere",
  );
}

/**
 * A (truncated) cone of base radius `r1` and top radius `r2` over `height`.
 *
 * `r2 === 0` gives a true point-tipped cone; `r1 === r2` would be a cylinder and
 * is rejected — OCCT builds a degenerate cone from it, and `makeCylinder` is the
 * honest way to ask for that.
 */
export function makeCone(
  oc: Occt,
  r1: number,
  r2: number,
  height: number,
  place?: AxisPlacement & { readonly angle?: number },
): Solid {
  if (!(r1 >= 0) || !(r2 >= 0)) throw new Error("cone: radii must be >= 0");
  if (r1 === 0 && r2 === 0) throw new Error("cone: at least one radius must be > 0");
  if (r1 === r2) throw new Error("cone: equal radii describe a cylinder — use makeCylinder");
  if (!(height > 0)) throw new Error("cone: height must be > 0");
  const angle = place?.angle;
  return finishPrimitive(
    oc,
    (axes) =>
      angle === undefined
        ? new oc.BRepPrimAPI_MakeCone_3(axes, r1, r2, height)
        : new oc.BRepPrimAPI_MakeCone_4(axes, r1, r2, height, angle),
    place,
    "cone",
  );
}

/**
 * A torus: a tube of radius `minorRadius` swept around a circle of
 * `majorRadius`, centred at `place.origin` about `place.axis`.
 *
 * `minorRadius >= majorRadius` self-intersects (the tube swallows its own axis),
 * which OCCT will happily build as an invalid solid — so it is rejected here.
 */
export function makeTorus(
  oc: Occt,
  majorRadius: number,
  minorRadius: number,
  place?: AxisPlacement & { readonly angle?: number },
): Solid {
  if (!(majorRadius > 0) || !(minorRadius > 0)) {
    throw new Error("torus: both radii must be > 0");
  }
  if (minorRadius >= majorRadius) {
    throw new Error("torus: minorRadius must be < majorRadius (the tube would self-intersect)");
  }
  const angle = place?.angle;
  return finishPrimitive(
    oc,
    (axes) =>
      angle === undefined
        ? new oc.BRepPrimAPI_MakeTorus_5(axes, majorRadius, minorRadius)
        : new oc.BRepPrimAPI_MakeTorus_6(axes, majorRadius, minorRadius, angle),
    place,
    "torus",
  );
}
