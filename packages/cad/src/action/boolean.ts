// Boolean operations (BRepAlgoAPI). union/subtract/intersect return a result
// object so callers can surface a failure; `cut` throws (it is used inline in the
// rebuild loop where any failure should abort the feature).
//
// ROBUSTNESS (§2.2)
// -----------------
// Every boolean here runs the mainstream OCCT pipeline rather than the bare
// `BRepAlgoAPI_Fuse(a, b)` this module used to be:
//
//   SetFuzzyValue → SetNonDestructive → Build → HasErrors → UnifySameDomain
//
// The load-bearing step is the last one. `BRepAlgoAPI` returns the raw boolean
// result, in which coincident faces of the two operands survive as SEPARATE
// fragments: fusing two flush 30 mm boxes yields a shape with TEN faces, two of
// which are coplanar halves of what the user sees as one top face. Everything
// downstream then silently operates on half of it — `resolveSelector(topFace)`
// picks one fragment, so "shell the top", "fillet the top edges",
// `largestPlanarFace` and any pre-union FaceRef act on half the geometric face
// and produce a wrong result with no error. `ShapeUpgrade_UnifySameDomain` merges
// same-surface faces (and their edges) back into one, restoring the six faces a
// 60×30×30 box actually has. This is verified in boolean.test.ts, not assumed.
//
// Two of §2.2's recommendations are NOT implementable against this wasm, and are
// deliberately absent rather than faked (both pinned by oc/bindings.test.ts):
//
//   • BOPAlgo_ArgumentAnalyzer pre-check — MEASURED as impossible, not assumed.
//     Its base chain (BOPAlgo_Algo → BOPAlgo_Options) was added to the trim and
//     it now CONSTRUCTS; but embind binds only SetShape1/SetShape2, because OCCT
//     exposes each check mode as a `Standard_Boolean&` (C++ writes
//     `analyzer.SelfInterMode() = Standard_True`) and a reference-returning
//     accessor degrades to a READ-ONLY getter. Every mode defaults to false, so
//     `Perform()` would analyse nothing and report no faults — strictly worse
//     than no pre-check, since it would LOOK like validation.
//   • OCCT's own report text on failure — `DumpErrors` needs a `Standard_OStream`,
//     which is not bound (the same limitation that keeps `Standard_Failure`'s
//     message unreachable; see oc/error.ts). Errors are therefore reported by
//     operation name and stage, not by OCCT's internal text.

import type { BRepAlgoAPI_BooleanOperation, TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { shapeEnums } from "../mesh/normals.js";
import { Solid } from "../solid/solid.js";

export type BooleanResult =
  | {
      ok: true;
      solid: Solid;
      /** Number of disjoint solids (lumps) in the result.
       *
       * Normally 1. A cut CAN legitimately split a body in two (and an N-ary
       * union of disjoint tools legitimately yields several), in which case the
       * result is a COMPOUND while most downstream code — mass properties, a
       * single-body rebuild accumulator, export — assumes one solid. This is
       * reported rather than rejected: refusing `lumps !== 1` would forbid the
       * legitimate cases (the same over-strict rejection §4.2 already flags in
       * `extrudeToFace`). Callers that require one body should check it. */
      lumps: number;
    }
  | { ok: false; error: string };

/**
 * Fuzzy tolerance applied to every boolean, SI metres — OCCT's
 * `Precision::Confusion()` baseline, set EXPLICITLY so the kernel's tolerance is
 * a stated contract rather than an inherited default.
 *
 * §2.2 suggested 1e-7…1e-6; the top of that range was measured and rejected.
 * Fuzzy does not merely widen intersection matching — OCCT stamps it onto the
 * RESULT's vertices/edges as their tolerance, and that propagates: at 1e-6 the
 * up-to-face pads' bounding boxes grew by exactly 6e-7 m per side (four kernel
 * tests went red asserting micron-exact geometry). That is the same mechanism as
 * the 1 mm shell-tolerance defect in §4.8 N1, three decades smaller — and buying
 * a decade of extra fuzz by giving up the kernel's verified exactness (§4.9) is a
 * bad trade. Near-coincident operands are better served by SetNonDestructive +
 * UnifySameDomain below, which cost no precision.
 */
const BOOLEAN_FUZZY = 1e-7;

/** Count the disjoint solids in a result shape. */
function countLumps(oc: Occt, shape: TopoDS_Shape): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(shape, S.TopAbs_SOLID, S.TopAbs_SHAPE);
  let n = 0;
  try {
    while (exp.More()) {
      n++;
      exp.Next();
    }
  } finally {
    exp.delete();
  }
  return n;
}

/**
 * Merge same-surface faces/edges of a boolean result (§2.2).
 *
 * Takes ownership of `shape`: it is freed here, and a NEW shape is returned. On
 * any failure the input is returned untouched — a unify that cannot run must not
 * lose the caller's geometry, since the un-unified result is still valid (merely
 * fragmented). `ConcatBSplines` stays false: concatenating spline faces changes
 * their parameterisation for no benefit here.
 */
function unifySameDomain(oc: Occt, shape: TopoDS_Shape): TopoDS_Shape {
  const usd = new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false);
  try {
    // Do not mutate the input shape in place — the caller may still own copies of
    // its sub-shapes, and NonDestructive above promised the operands survive.
    usd.SetSafeInputMode(true);
    usd.Build();
    const merged = usd.Shape();
    if (merged.IsNull()) {
      merged.delete();
      return shape;
    }
    shape.delete();
    return merged;
  } catch {
    // UnifySameDomain throws a raw Standard_Failure on exotic input. The boolean
    // itself already succeeded, so degrade to the fragmented-but-valid result.
    return shape;
  } finally {
    usd.delete();
  }
}

/**
 * Configure and run a boolean, then unify its result.
 *
 * `op` MUST be freshly default-constructed and NOT yet built: the convenience
 * ctors (`BRepAlgoAPI_Fuse_3(a, b, range)`) build inside the constructor, so any
 * SetFuzzyValue/SetNonDestructive call after them is a silent no-op. Arguments
 * and tools are therefore supplied here, before `Build`.
 */
function runBoolean(
  oc: Occt,
  op: BRepAlgoAPI_BooleanOperation,
  name: string,
  args: readonly Solid[],
  tools: readonly Solid[],
): BooleanResult {
  const argList = new oc.TopTools_ListOfShape_1();
  const toolList = new oc.TopTools_ListOfShape_1();
  const range = new oc.Message_ProgressRange_1();
  try {
    for (const s of args) argList.Append_1(s.shape);
    for (const s of tools) toolList.Append_1(s.shape);
    op.SetArguments(argList);
    op.SetTools(toolList);
    op.SetFuzzyValue(BOOLEAN_FUZZY);
    // The operands must survive the call unmodified: the rebuild accumulator and
    // the pattern/hole loops reuse the same Solid across successive booleans, and
    // per-feature shape caching (§2.5.5) depends on inputs being immutable.
    op.SetNonDestructive(true);
    op.Build(range);

    if (op.HasErrors() || !op.IsDone()) {
      return { ok: false, error: `${name} produced no valid result` };
    }
    let shape = op.Shape();
    // `Shape()` is an owned embind handle even when null — free it before the
    // failure return, or it leaks in the long-lived worker (cf. extrude/revolve,
    // which `shape.delete()` before throwing on `IsNull`). On success the returned
    // Solid takes ownership instead, so the handle is freed exactly once either way.
    if (shape.IsNull()) {
      shape.delete();
      return { ok: false, error: `${name} produced an empty shape` };
    }
    shape = unifySameDomain(oc, shape);
    return { ok: true, solid: new Solid(oc, shape), lumps: countLumps(oc, shape) };
  } finally {
    op.delete();
    range.delete();
    toolList.delete();
    argList.delete();
  }
}

/** Fuse two solids (A ∪ B). */
export function union(oc: Occt, a: Solid, b: Solid): BooleanResult {
  return runBoolean(oc, new oc.BRepAlgoAPI_Fuse_1(), "union", [a], [b]);
}

/**
 * Fuse many solids in ONE operation (A ∪ B ∪ C ∪ …).
 *
 * Folding an N-copy pattern pairwise re-runs the intersection machinery on the
 * ever-growing accumulator N−1 times; giving OCCT every operand at once lets it
 * intersect them in a single pass. Also more robust: pairwise fusing can strand
 * an intermediate result in a degenerate state that the next fuse then fails on.
 */
export function unionAll(oc: Occt, solids: readonly Solid[]): BooleanResult {
  if (solids.length === 0) return { ok: false, error: "union: no solids given" };
  const [first, ...rest] = solids as [Solid, ...Solid[]];
  if (rest.length === 0) {
    const solid = first.copy();
    return { ok: true, solid, lumps: countLumps(oc, solid.shape) };
  }
  return runBoolean(oc, new oc.BRepAlgoAPI_Fuse_1(), "union", [first], rest);
}

/** Subtract B from A (A − B). */
export function subtract(oc: Occt, a: Solid, b: Solid): BooleanResult {
  return runBoolean(oc, new oc.BRepAlgoAPI_Cut_1(), "subtract", [a], [b]);
}

/** Intersect two solids (A ∩ B). */
export function intersect(oc: Occt, a: Solid, b: Solid): BooleanResult {
  return runBoolean(oc, new oc.BRepAlgoAPI_Common_1(), "intersect", [a], [b]);
}

/** Subtract `tool` from `base`, throwing on failure (returns a new Solid). */
export function cut(oc: Occt, base: Solid, tool: Solid): Solid {
  const r = subtract(oc, base, tool);
  if (!r.ok) throw new Error(`cut: ${r.error}`);
  return r.solid;
}
