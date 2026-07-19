// Where a NEW sketch lands when the user did not pick a face (§13.8 P0).
//
// Every "start a sketch" entry point used to call `enterSketch("XY", 0)` — a
// plane chosen blind to the geometry already on screen. With the seeded
// 60×40×30 starter box occupying z = 0…30, the XY plane at offset 0 is the box's
// BOTTOM face, buried inside the solid: a rectangle drawn there and extruded UP
// lands entirely within the box, join-by-default adds nothing, and the user's
// very first operation appears to do nothing at all.
//
// The plane was never the user's choice, so nothing is taken away by choosing it
// well. A sketch started on a datum now lands on the model's OUTER FACE along
// that datum's normal — the surface you can actually see and draw on, which is
// what "sketch on XY" means when a body sits on XY, and what picking the top
// face by hand would have given. An empty document keeps the bare datum.
//
// It resolves to a FACE spec, not a baked offset: `SketchFacePlaneSpec` is
// re-resolved against the upstream solid on every rebuild, so raising the box
// carries the sketch (and anything extruded from it) with it. A frozen
// `offset: 0.03` would silently detach the moment the box changed height.

import type { FaceRef } from "@plastiq/cad";
import { emptySketch, type DatumPlaneId, type SketchModel } from "./model.js";

type V3 = readonly [number, number, number];

/** Outward normal of each base datum (kernel `planeXY`/`planeXZ`/`planeYZ`). */
const DATUM_NORMAL: Record<DatumPlaneId, V3> = {
  XY: [0, 0, 1],
  XZ: [0, 1, 0],
  YZ: [1, 0, 0],
};

/** How closely a face's normal must align with the datum's to count as facing
 * the same way. cos 30° — generous enough for tessellation-averaged normals,
 * tight enough that a side wall never qualifies. */
const ALIGN_TOL = 0.866;

function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * The face a new sketch on `datum` should land on, or `null` when the document
 * has no geometry facing that way (draw on the bare datum instead).
 *
 * Picks the OUTERMOST face whose normal points the same way as the datum's:
 * among the candidates, the one whose centroid sits furthest along that normal.
 * That is the surface the user is looking at from the datum's side — the top
 * face for XY, the front face for XZ, the right face for YZ.
 *
 * `faces` is the live build's persistent face refs (`selectionRefs.faces`), so
 * the returned ref is exactly the kind a hand-pick produces and re-resolves the
 * same way at rebuild. Refs without a centroid cannot be ranked and are skipped:
 * a face that cannot be placed cannot be shown to be the outermost one.
 */
export function defaultSketchFace(
  datum: DatumPlaneId,
  faces: Readonly<Record<number, FaceRef>>,
): FaceRef | null {
  const n = DATUM_NORMAL[datum];
  let best: FaceRef | null = null;
  let bestDepth = -Infinity;
  for (const face of Object.values(faces)) {
    if (!face.centroid) continue;
    if (dot(face.normal as V3, n) < ALIGN_TOL) continue;
    const depth = dot(face.centroid as V3, n);
    if (depth > bestDepth) {
      bestDepth = depth;
      best = face;
    }
  }
  return best;
}

/**
 * The starting model for a new sketch on `datum`.
 *
 * With no offset given, it lands on the model's outer face along that datum's
 * normal (see {@link defaultSketchFace}) — the orientation the user asked for,
 * on a surface they can actually draw on. An EXPLICIT non-zero offset is an
 * exact instruction ("30 mm above XY"), so it is honoured against the bare
 * datum and never silently re-based onto a face.
 */
export function startingSketchModel(
  datum: DatumPlaneId,
  faces: Readonly<Record<number, FaceRef>>,
  offset = 0,
): SketchModel {
  const base = emptySketch(datum, offset);
  if (offset !== 0) return base;
  const face = defaultSketchFace(datum, faces);
  return face ? { ...base, face } : base;
}
