// Revolve a sketch profile about an axis.

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { Solid } from "../solid/solid.js";
import type { Sketch } from "../sketch/sketch.js";

/**
 * Revolve a sketch profile by `angle` radians about the axis through `origin`
 * along `axis`. A full 2π revolution makes a closed solid of revolution.
 */
export function revolve(
  oc: Occt,
  sketch: Sketch,
  origin: Vec3,
  axis: Vec3,
  angle: number,
): Solid {
  // A zero revolution angle sweeps nothing — OCCT returns an invalid shape; reject.
  if (!Number.isFinite(angle) || angle === 0) {
    throw new Error("revolve: angle must be non-zero");
  }
  // Reject a request beyond a full turn (§4.8 N6). OCCT's MakeRevol takes the
  // angle MODULO 2π WITHOUT warning, so a 3π request silently produced exactly
  // half a turn's volume as a "valid" solid. A revolution past 2π overlaps
  // itself and is never what the user meant; fail loudly instead of returning
  // quietly wrong geometry. Negative angles are legal (they revolve the other
  // way — §4.9), so the bound is on the magnitude, with a tiny epsilon so a
  // floating-point 2π (e.g. 2*Math.PI) still counts as a full turn.
  if (Math.abs(angle) > 2 * Math.PI + 1e-9) {
    throw new Error(
      `revolve: angle ${angle} exceeds a full turn (±2π); OCCT would silently wrap it modulo 2π`,
    );
  }
  // Validate the axis BEFORE allocating anything: a zero (or non-finite) axis
  // makes gp_Dir_4 raise an opaque Standard_Failure after `face`/`o` exist,
  // which would leak them. Failing here means there is nothing to clean up.
  const axisLen = Math.hypot(axis[0], axis[1], axis[2]);
  if (!Number.isFinite(axisLen) || axisLen === 0) {
    throw new Error("revolve: axis must be a non-zero vector");
  }
  const face = sketch.toFace(oc);
  const trash: Array<{ delete(): void }> = [face];
  // try/finally so a Standard_Failure from any OCCT constructor (e.g. MakeRevol
  // on a profile crossing the axis) still frees the face and gp_* temporaries.
  try {
    const o = new oc.gp_Pnt_3(origin[0], origin[1], origin[2]);
    trash.push(o);
    const d = new oc.gp_Dir_4(axis[0], axis[1], axis[2]);
    trash.push(d);
    const ax = new oc.gp_Ax1_2(o, d);
    trash.push(ax);
    const rev = new oc.BRepPrimAPI_MakeRevol_1(face, ax, angle, false);
    trash.push(rev);
    const shape = rev.Shape();
    // Guard the result for parity with loft/sweep/dress-up: should OCCT hand back a
    // null shape for a degenerate-but-nonzero profile (rather than throwing), reject
    // it rather than wrapping an empty Solid and returning it as a success.
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("revolve: produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    // Reverse order: the maker before the axis, the axis before its parts.
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}
