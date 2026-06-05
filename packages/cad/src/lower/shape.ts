// Shape lowering policy (SPEC-4 FR-26, decision Q7): collapse a B-rep `Solid`
// into a `ShapeData` collision proxy for the sim seam.
//
// Policy (V1):
//   1. Primitive fit — recognise an axis-aligned box (6 planar faces whose
//      volume fills the bounding box) and a sphere (cube bounding box whose
//      volume matches 4/3·π·r³). These are exact, cheap, and the sim's fastest
//      collision shapes.
//   2. Otherwise — the convex hull of the solid's tessellation (FR-26). This is
//      correct for any convex solid and is the documented single-hull proxy for
//      a concave solid in V1 (multi-hull convex decomposition is a noted TODO,
//      R6); the hull strictly contains a concave part.
//
// FRAME CONVENTION (shared with export, Task 3.4): shape geometry is expressed
// in the body frame whose origin is the solid's centre of mass (COM). The export
// pairs every shape with `translation = world COM`, so geo-bindgen's
// `pos = translation + shapeCenter` places the body exactly at its COM for all
// four shape kinds. Capsule auto-recognition from a general B-rep is out of scope
// for V1 (a capsule is normally an authored proxy, not a modelled solid).

import type { Bnd_Box } from "opencascade.js";
import { sub, type Vec3 } from "../math/index.js";
import { tessellate } from "../mesh/tessellate.js";
import type { Occt } from "../oc/init.js";
import type { Solid } from "../solid/solid.js";
import { convexHull } from "./hull.js";
import type { ShapeData } from "./manifest.js";
import { massProperties } from "./massprops.js";

export interface LowerShapeOptions {
  /** Relative tolerance for a primitive volume match (default 1e-3). */
  readonly fitTolerance?: number;
  /** Tessellation chord deviation for the hull fallback, SI m (default auto). */
  readonly linearDeflection?: number;
}

interface BBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** Tight axis-aligned bounding box of the solid (optimal, no tolerance gap). */
function boundingBox(oc: Occt, solid: Solid): BBox {
  const box: Bnd_Box = new oc.Bnd_Box_1();
  try {
    // AddOptimal(useTriangulation=false, useShapeTolerance=false) gives the
    // exact extent (no mesh/tolerance inflation), so primitive half-extents and
    // radii lower exactly.
    oc.BRepBndLib.AddOptimal(solid.shape, box, false, false);
    const lo = box.CornerMin();
    const hi = box.CornerMax();
    const min: Vec3 = [lo.X(), lo.Y(), lo.Z()];
    const max: Vec3 = [hi.X(), hi.Y(), hi.Z()];
    lo.delete();
    hi.delete();
    return { min, max };
  } finally {
    box.delete();
  }
}

/** Read a tessellation's flat vertex buffer into Vec3 points. */
function meshPoints(oc: Occt, solid: Solid, linearDeflection: number): Vec3[] {
  const mesh = tessellate(oc, solid, { linearDeflection });
  const pts: Vec3[] = [];
  for (let i = 0; i + 2 < mesh.vertices.length; i += 3) {
    pts.push([mesh.vertices[i]!, mesh.vertices[i + 1]!, mesh.vertices[i + 2]!]);
  }
  return pts;
}

/**
 * Lower `solid` to a `ShapeData` collision proxy (COM-relative). See the module
 * header for the policy and frame convention.
 */
export function lowerShape(oc: Occt, solid: Solid, opts: LowerShapeOptions = {}): ShapeData {
  const tol = opts.fitTolerance ?? 1e-3;
  const mp = massProperties(oc, solid, 1);
  const com: Vec3 = [mp.com[0], mp.com[1], mp.com[2]];
  const bb = boundingBox(oc, solid);
  const dx = bb.max[0] - bb.min[0];
  const dy = bb.max[1] - bb.min[1];
  const dz = bb.max[2] - bb.min[2];
  const bboxVol = dx * dy * dz;
  const bboxCenter: Vec3 = [
    (bb.min[0] + bb.max[0]) / 2,
    (bb.min[1] + bb.max[1]) / 2,
    (bb.min[2] + bb.max[2]) / 2,
  ];

  // --- box: 6 faces and volume fills the bounding box ------------------------
  if (solid.countFaces() === 6 && bboxVol > 0 && Math.abs(mp.volume - bboxVol) / bboxVol < tol) {
    return { kind: "box", halfExtents: [dx / 2, dy / 2, dz / 2] };
  }

  // --- sphere: cube-ish bounding box, volume matches 4/3·π·r³ ----------------
  const maxDim = Math.max(dx, dy, dz);
  const cubeLike =
    maxDim > 0 &&
    Math.abs(dx - dy) / maxDim < tol &&
    Math.abs(dy - dz) / maxDim < tol &&
    Math.abs(dx - dz) / maxDim < tol;
  if (cubeLike) {
    const r = dx / 2;
    const sphereVol = (4 / 3) * Math.PI * r * r * r;
    if (sphereVol > 0 && Math.abs(mp.volume - sphereVol) / sphereVol < tol) {
      // Centre relative to COM (≈ 0 for a true sphere; robust to slight offset).
      return { kind: "sphere", center: sub(bboxCenter, com), radius: r };
    }
  }

  // --- fallback: convex hull of the tessellation, COM-relative ---------------
  const deflection = opts.linearDeflection ?? (maxDim || 1) / 50;
  const points = meshPoints(oc, solid, deflection);
  const hull = convexHull(points);
  const vertices = hull.vertices.map((v) => sub(v, com));
  return { kind: "convexHull", vertices, faces: hull.faces };
}
