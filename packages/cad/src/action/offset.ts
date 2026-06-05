// Offset feature (SPEC-4 FR-11): grow/shrink a solid's boundary by a distance,
// via OCCT BRepOffsetAPI_MakeOffsetShape (positive = outward).

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";

/** Offset `solid`'s faces outward (positive) or inward (negative) by `distance` (SI). */
export function offsetShape(oc: Occt, solid: Solid, distance: number): Solid {
  const mk = new oc.BRepOffsetAPI_MakeOffsetShape();
  const range = new oc.Message_ProgressRange_1();
  try {
    mk.PerformByJoin(
      solid.shape,
      distance,
      1e-6,
      oc.BRepOffset_Mode.BRepOffset_Skin as never,
      false,
      false,
      oc.GeomAbs_JoinType.GeomAbs_Arc as never,
      false,
      range,
    );
    const result = new Solid(oc, mk.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("offset produced an invalid solid");
    }
    return result;
  } finally {
    range.delete();
    mk.delete();
  }
}
