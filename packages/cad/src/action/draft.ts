// Draft feature (SPEC-4 FR-17): taper selected face(s) by a draft angle about a
// neutral plane (the plane that stays fixed), via OCCT BRepOffsetAPI_DraftAngle.
// Draft is the mold-/cast-release taper: a face is rotated about its line of
// intersection with the neutral plane so it pulls cleanly along `pullDirection`.

import { normalize, type Vec3 } from "../math/index.js";
import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { resolveFace, type FaceRef } from "./selection.js";

export interface DraftSpec {
  /** The face to taper (persistent reference, FR-16). */
  readonly face: FaceRef;
  /** Demolding / pull direction (the face tilts to release along it). */
  readonly pullDirection: Vec3;
  /** A point on the neutral plane (the cross-section that stays fixed). */
  readonly neutralOrigin: Vec3;
  /** Neutral plane normal. */
  readonly neutralNormal: Vec3;
  /** Draft angle, radians. */
  readonly angle: number;
}

/** Apply a draft taper to the referenced face. */
export function draft(oc: Occt, solid: Solid, spec: DraftSpec): Solid {
  const face = resolveFace(oc, solid, spec.face);
  if (!face) {
    throw new Error("draft: face reference unresolvable on the current solid (R2)");
  }
  const [px, py, pz] = normalize(spec.pullDirection);
  const [nx, ny, nz] = normalize(spec.neutralNormal);
  const pull = new oc.gp_Dir_4(px, py, pz);
  const planeOrigin = new oc.gp_Pnt_3(
    spec.neutralOrigin[0],
    spec.neutralOrigin[1],
    spec.neutralOrigin[2],
  );
  const planeNormal = new oc.gp_Dir_4(nx, ny, nz);
  const neutral = new oc.gp_Pln_3(planeOrigin, planeNormal);
  const mk = new oc.BRepOffsetAPI_DraftAngle_2(solid.shape);
  const range = new oc.Message_ProgressRange_1();
  try {
    mk.Add(face, pull, spec.angle, neutral, true);
    if (!mk.AddDone()) {
      throw new Error("draft: OCCT could not add the draft to the face");
    }
    mk.Build(range);
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("draft produced an invalid solid");
    }
    return result;
  } finally {
    range.delete();
    mk.delete();
    neutral.delete();
    planeNormal.delete();
    planeOrigin.delete();
    pull.delete();
    face.delete();
  }
}
