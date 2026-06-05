// Cut / pocket feature (SPEC-4 FR-6): remove material. `cut` is the boolean
// subtraction of a tool solid from a target; `pocket` is the sketch-driven form
// — extrude a profile and subtract it — recording the driving sketch + depth.

import type { Occt } from "../oc/init.js";
import type { Sketch } from "../sketch/sketch.js";
import { Solid } from "../solid/solid.js";
import { extrude } from "./extrude.js";

/** Subtract `tool` from `target` (target − tool). Returns a typed error solid? No — throws on a failed/invalid boolean (NFR-3). */
export function cut(oc: Occt, target: Solid, tool: Solid): Solid {
  const range = new oc.Message_ProgressRange_1();
  const op = new oc.BRepAlgoAPI_Cut_3(target.shape, tool.shape, range);
  try {
    const result = new Solid(oc, op.Shape());
    if (!result.isValid()) {
      result.delete();
      throw new Error("boolean cut produced an invalid solid");
    }
    return result;
  } finally {
    op.delete();
    range.delete();
  }
}

/**
 * Pocket: extrude `profile` by `depth` along its plane normal and subtract it
 * from `target` (a sketch-driven material removal, FR-6). The driving sketch +
 * depth are the feature's parameters.
 */
export function pocket(oc: Occt, target: Solid, profile: Sketch, depth: number): Solid {
  const tool = extrude(oc, profile, depth);
  try {
    return cut(oc, target, tool);
  } finally {
    tool.delete();
  }
}
