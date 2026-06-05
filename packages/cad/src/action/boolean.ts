// Boolean operations (BRepAlgoAPI). union/subtract/intersect return a result
// object so callers can surface a failure; `cut` throws (it is used inline in the
// rebuild loop where any failure should abort the feature).

import type { BRepAlgoAPI_BooleanOperation } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";

export type BooleanResult = { ok: true; solid: Solid } | { ok: false; error: string };

function finish(oc: Occt, op: BRepAlgoAPI_BooleanOperation, name: string): BooleanResult {
  try {
    if (op.HasErrors() || !op.IsDone()) {
      return { ok: false, error: `${name} produced no valid result` };
    }
    const shape = op.Shape();
    if (shape.IsNull()) return { ok: false, error: `${name} produced an empty shape` };
    return { ok: true, solid: new Solid(oc, shape) };
  } finally {
    op.delete();
  }
}

/** Fuse two solids (A ∪ B). */
export function union(oc: Occt, a: Solid, b: Solid): BooleanResult {
  const range = new oc.Message_ProgressRange_1();
  try {
    return finish(oc, new oc.BRepAlgoAPI_Fuse_3(a.shape, b.shape, range), "union");
  } finally {
    range.delete();
  }
}

/** Subtract B from A (A − B). */
export function subtract(oc: Occt, a: Solid, b: Solid): BooleanResult {
  const range = new oc.Message_ProgressRange_1();
  try {
    return finish(oc, new oc.BRepAlgoAPI_Cut_3(a.shape, b.shape, range), "subtract");
  } finally {
    range.delete();
  }
}

/** Intersect two solids (A ∩ B). */
export function intersect(oc: Occt, a: Solid, b: Solid): BooleanResult {
  const range = new oc.Message_ProgressRange_1();
  try {
    return finish(oc, new oc.BRepAlgoAPI_Common_3(a.shape, b.shape, range), "intersect");
  } finally {
    range.delete();
  }
}

/** Subtract `tool` from `base`, throwing on failure (returns a new Solid). */
export function cut(oc: Occt, base: Solid, tool: Solid): Solid {
  const r = subtract(oc, base, tool);
  if (!r.ok) throw new Error(`cut: ${r.error}`);
  return r.solid;
}
