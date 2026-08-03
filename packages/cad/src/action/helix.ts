// Helical wire builder (§13.2).
//
// Spec route (FablesFindings §13.2) — NOW LIVE after gp_Pnt2d / gp_Dir2d bind:
//   Geom_CylindricalSurface / Geom_ConicalSurface
//   + Geom2d_Line on that surface
//   → BRepBuilderAPI_MakeEdge_31(curve2d, surface, p1, p2)
//   → BRepLib.BuildCurves3d
//
// The helix is a straight line in (U,V) on the cylinder/cone: U = ±turns·2π·s,
// V = height·s (or generatrix parameter for a cone). That is an exact pcurve,
// not a sampled B-spline approximation.
//
// Consumption by sweep: the returned TopoDS_Wire is a ready-made spine. Pass it
// to `sweepAlongWire(oc, sketch, wire, opts)`, which TAKES OWNERSHIP of the wire
// (frees it on success and on throw). Do not route through `buildSpineWire` —
// helix is intentionally not a SpinePath kind; the prebuilt wire is the spine.

import type { TopoDS_Wire } from "opencascade.js";

import type { Occt } from "../oc/init.js";

/** Sense of the helix about its +Z axis (right-hand rule). */
export type HelixHandedness = "right" | "left";

/**
 * Parameters for a helical wire of `turns` revolutions about +Z through the
 * origin, starting at `(radius, 0, 0)`.
 *
 * Lengths are SI metres; angles are radians.
 */
export interface HelixSpec {
  /** Cylinder (or cone-at-V=0) radius — must be finite and > 0. */
  readonly radius: number;
  /** Axial advance per full turn along +Z — finite and non-zero. */
  readonly pitch: number;
  /** Number of revolutions (may be fractional); finite and > 0. */
  readonly turns: number;
  /** Winding sense about +Z. */
  readonly handedness: HelixHandedness;
  /**
   * Optional cone semi-angle (radians). Absent / 0 → pure cylinder. Positive
   * opens the radius with height; negative closes it. Must keep the radius
   * strictly positive over the full run, and |angle| < π/2.
   */
  readonly taperAngle?: number;
}

function assertPositiveFinite(v: number, label: string): void {
  if (!Number.isFinite(v) || !(v > 0)) {
    throw new Error(`helix: ${label} must be a positive finite number (got ${v})`);
  }
}

/**
 * Build an open helical wire per `spec`.
 *
 * Exact pcurve-on-surface: a Geom2d_Line in UV on a cylinder/cone, edged via
 * MakeEdge, then BuildCurves3d. Caller owns the returned `TopoDS_Wire` and must
 * `.delete()` it — or hand it to {@link sweepAlongWire}, which consumes it.
 */
export function helix(oc: Occt, spec: HelixSpec): TopoDS_Wire {
  // ---- Validate everything BEFORE allocating any OCCT object. ----
  const { radius, pitch, turns, handedness } = spec;
  assertPositiveFinite(radius, "radius");
  if (!Number.isFinite(pitch) || pitch === 0) {
    throw new Error(`helix: pitch must be a finite non-zero number (got ${pitch})`);
  }
  assertPositiveFinite(turns, "turns");
  if (handedness !== "right" && handedness !== "left") {
    throw new Error(`helix: handedness must be "right" or "left" (got ${String(handedness)})`);
  }

  const taper = spec.taperAngle ?? 0;
  if (!Number.isFinite(taper)) {
    throw new Error(`helix: taperAngle must be finite (got ${taper})`);
  }
  if (Math.abs(taper) >= Math.PI / 2) {
    throw new Error(`helix: |taperAngle| must be < π/2 (got ${taper})`);
  }

  // Axial run and end radius. For a cone, radius(z) = radius + z * tan(taper).
  const height = pitch * turns;
  const endRadius = radius + height * Math.tan(taper);
  if (!(endRadius > 0)) {
    throw new Error(
      `helix: taper collapses the radius to non-positive over the run (end radius ${endRadius})`,
    );
  }

  // Angular sign: right-hand advances +U with +V; left-hand reverses U.
  const uSign = handedness === "right" ? 1 : -1;
  const uEnd = uSign * turns * 2 * Math.PI;
  const useCone = Math.abs(taper) > 0;
  // Cone V is along the generatrix so z = V·cos(α); set V_end = height/cos(α).
  const vEnd = useCone ? height / Math.cos(taper) : height;
  // Line length in UV parameter space (Geom2d_Line parameter is arc length in UV).
  const uvLen = Math.hypot(uEnd, vEnd);
  if (!(uvLen > 0)) {
    throw new Error("helix: zero UV run (degenerate turns/pitch)");
  }
  const du = uEnd / uvLen;
  const dv = vEnd / uvLen;

  const trash: Array<{ delete(): void }> = [];
  const own = <T extends { delete(): void }>(t: T): T => {
    trash.push(t);
    return t;
  };

  try {
    // Axis: origin at (0,0,0), main direction +Z. X-direction defaults to +X via
    // gp_Ax3_4's auto-complete, so U=0 lands on (radius, 0, ·) — the natural start.
    const origin = own(new oc.gp_Pnt_3(0, 0, 0));
    const zDir = own(new oc.gp_Dir_4(0, 0, 1));
    const ax3 = own(new oc.gp_Ax3_4(origin, zDir));

    const surface = useCone
      ? own(new oc.Geom_ConicalSurface_1(ax3, taper, radius))
      : own(new oc.Geom_CylindricalSurface_1(ax3, radius));

    // Exact helix as a straight line in UV: from (0,0) along (du,dv).
    const p0 = own(new oc.gp_Pnt2d_3(0, 0));
    const d2 = own(new oc.gp_Dir2d_4(du, dv));
    const line2d = own(new oc.Geom2d_Line_3(p0, d2));
    const hCurve2d = own(new oc.Handle_Geom2d_Curve_2(line2d));
    const hSurf = own(new oc.Handle_Geom_Surface_2(surface));

    // Parameter range [0, uvLen] covers the full helix once.
    const edgeMaker = own(new oc.BRepBuilderAPI_MakeEdge_31(hCurve2d, hSurf, 0, uvLen));
    if (!edgeMaker.IsDone()) {
      throw new Error("helix: could not build a pcurve-on-surface edge for the helix");
    }
    const edge = own(edgeMaker.Edge());
    if (edge.IsNull()) {
      throw new Error("helix: produced an empty edge");
    }

    // Materialise the 3d curve on the edge (required for tessellation/sweep).
    if (!oc.BRepLib.BuildCurves3d_2(edge)) {
      throw new Error("helix: BRepLib.BuildCurves3d failed on the helical edge");
    }

    const wireMaker = own(new oc.BRepBuilderAPI_MakeWire_1());
    wireMaker.Add_1(edge);
    if (!wireMaker.IsDone()) {
      throw new Error("helix: failed to build a helix wire");
    }
    const wire = wireMaker.Wire();
    if (wire.IsNull()) {
      wire.delete();
      throw new Error("helix: produced an empty wire");
    }
    // Caller owns `wire`. Temporaries free in finally.
    return wire;
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}
