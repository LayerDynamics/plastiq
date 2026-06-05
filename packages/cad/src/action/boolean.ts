// Boolean operations (SPEC-4 FR-7): union / subtract / intersect via OCCT
// BRepAlgoAPI. A failed or dirty boolean returns a typed error result rather
// than throwing (NFR-3) — callers branch on `ok`.

import type { TopoDS_Shape } from "opencascade.js";
import type { Occt } from "../oc/init.js";
import { Solid } from "../solid/solid.js";

export type BooleanResult = { ok: true; solid: Solid } | { ok: false; error: string };

interface BuiltOp {
  HasErrors(): boolean;
  Shape(): TopoDS_Shape;
}

function finish(oc: Occt, op: BuiltOp, label: string): BooleanResult {
  if (op.HasErrors()) {
    return { ok: false, error: `${label}: OCCT reported errors` };
  }
  const solid = new Solid(oc, op.Shape());
  if (!solid.isValid()) {
    solid.delete();
    return { ok: false, error: `${label}: produced an invalid solid` };
  }
  if (solid.countFaces() === 0) {
    solid.delete();
    return { ok: false, error: `${label}: empty result (no overlap)` };
  }
  return { ok: true, solid };
}

/** Union (fuse) a ∪ b. */
export function union(oc: Occt, a: Solid, b: Solid): BooleanResult {
  const range = new oc.Message_ProgressRange_1();
  const op = new oc.BRepAlgoAPI_Fuse_3(a.shape, b.shape, range);
  try {
    return finish(oc, op, "union");
  } finally {
    op.delete();
    range.delete();
  }
}

/** Subtract a − b. */
export function subtract(oc: Occt, a: Solid, b: Solid): BooleanResult {
  const range = new oc.Message_ProgressRange_1();
  const op = new oc.BRepAlgoAPI_Cut_3(a.shape, b.shape, range);
  try {
    return finish(oc, op, "subtract");
  } finally {
    op.delete();
    range.delete();
  }
}

/** Intersect a ∩ b (empty result → `ok: false`). */
export function intersect(oc: Occt, a: Solid, b: Solid): BooleanResult {
  const range = new oc.Message_ProgressRange_1();
  const op = new oc.BRepAlgoAPI_Common_3(a.shape, b.shape, range);
  try {
    return finish(oc, op, "intersect");
  } finally {
    op.delete();
    range.delete();
  }
}
