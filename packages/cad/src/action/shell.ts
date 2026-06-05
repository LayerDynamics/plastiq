// Shell feature (SPEC-4 FR-10): hollow a solid to a wall thickness, removing the
// referenced open faces, via OCCT BRepOffsetAPI_MakeThickSolid (inward offset).

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";
import { resolveFace, type FaceRef } from "./selection.js";

/**
 * Hollow `solid` to wall `thickness` (SI), opening the faces named by
 * `openFaces`. Throws a typed error if a face reference is unresolvable (R2) or
 * the result is invalid (NFR-3).
 */
export function shell(
  oc: Occt,
  solid: Solid,
  openFaces: readonly FaceRef[],
  thickness: number,
): Solid {
  const list = new oc.TopTools_ListOfShape_1();
  const resolved = [];
  try {
    for (const ref of openFaces) {
      const face = resolveFace(oc, solid, ref);
      if (!face)
        throw new Error("shell: open-face reference unresolvable on the current solid (R2)");
      resolved.push(face);
      list.Append_1(face);
    }
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    const range = new oc.Message_ProgressRange_1();
    try {
      // Negative offset hollows inward, leaving walls of `thickness`.
      mk.MakeThickSolidByJoin(
        solid.shape,
        list,
        -thickness,
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
        throw new Error("shell produced an invalid solid");
      }
      return result;
    } finally {
      range.delete();
      mk.delete();
    }
  } finally {
    for (const f of resolved) f.delete();
    list.delete();
  }
}
