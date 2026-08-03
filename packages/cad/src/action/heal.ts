// Shape healing and surface-pillar closure ops (§13.2 `heal`, §14 `sew`/`solidify`).
//
// `sew` stitches faces into a shell via BRepBuilderAPI_Sewing and reports free
// (naked) edges through ShapeAnalysis_FreeBounds — the closure gate the freeform
// and mesh→B-rep paths need before solidify. `solidify` promotes a closed shell
// to a Solid (BRep_Builder.MakeSolid + Add; see API discovery below) and verifies
// with BRepCheck_Analyzer + free-edge + positive volume — MakeSolid alone does
// NOT validate closure. `heal` is the import-time repair: optional sew +
// ShapeFix_Shape, and optionally ShapeFix_Solid for solid orientation/shell fixup.
//
// Bindings (verified against packages/cad/vendor/occt/plastiq-occt.d.ts + runtime):
//   - BRepBuilderAPI_Sewing — single 5-arg ctor (no overload suffixes)
//   - ShapeFix_Shape_2, ShapeFix_Solid_2, ShapeAnalysis_FreeBounds_3
//   - Message_ProgressRange_1, BRepLib.OrientClosedSolid
//
// API discovery (runtime, 2026-07-28): TopoDS_Shell is UNBOUND in this trimmed
// wasm — `TopoDS.Shell_1`, `BRepBuilderAPI_MakeSolid_3(shell)`,
// `BRepBuilderAPI_MakeSolid.Add(shell)`, and `ShapeFix_Solid.SolidFromShell`
// all throw UnboundTypeError ("unbound types: 12TopoDS_Shell"). The solidify
// route that works is BRep_Builder.MakeSolid + BRep_Builder.Add(solid, shellAsShape),
// where Add takes TopoDS_Shape/TopoDS_Shape and does not need a Shell downcast.
// BRepBuilderAPI_MakeSolid remains bound (and is the §14-named route) but is
// unusable for a lone shell until TopoDS_Shell is added to the embind trim.

import type { TopAbs_ShapeEnum, TopoDS_Shape, TopoDS_Solid } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import { shapeEnums } from "../mesh/normals.js";
import { Solid } from "../solid/solid.js";

/** Options for {@link heal}. */
export interface HealOptions {
  /**
   * Sewing tolerance (SI metres) for the BRepBuilderAPI_Sewing pass that runs
   * before ShapeFix. Default `1e-6`. Pass a non-positive value to skip sewing
   * and run ShapeFix alone on the input shape.
   */
  readonly sewTolerance?: number;
  /**
   * When true, also run ShapeFix_Solid on every solid found in the fixed shape
   * (shell orientation / solid repair). Default `false`.
   */
  readonly fixSolid?: boolean;
}

/**
 * Free-edge report for a sewn (or otherwise assembled) shape.
 *
 * Counts come from ShapeAnalysis_FreeBounds — the same gate the Python
 * reconstruct/nurbs pipelines use. A watertight shell has `freeEdgeCount === 0`.
 */
export interface FreeEdgeReport {
  /** Total free (naked) edges across open + closed free wires. */
  readonly freeEdgeCount: number;
  /** Free wires that form closed loops (holes / outer loops of open shells). */
  readonly closedFreeWires: number;
  /** Free wires that are open polylines. */
  readonly openFreeWires: number;
  /**
   * Sewing's own free-edge tally (`BRepBuilderAPI_Sewing.NbFreeEdges`). Present
   * only when the report was produced right after a sew pass; useful as a
   * cross-check against FreeBounds.
   */
  readonly sewingFreeEdges?: number;
}

/** Result of {@link sew}: a shell body plus its free-edge report. */
export interface SewResult {
  /** Sewn shape (typically a `TopoDS_Shell`, or a compound if faces did not fully stitch). Caller owns. */
  readonly shell: Solid;
  readonly freeEdges: FreeEdgeReport;
}

/**
 * Sew faces into a shell and report free edges.
 *
 * Inputs are NOT consumed. `tolerance` is the sewing tolerance in SI metres
 * (typical range 1e-7 … 1e-4 for SI geometry).
 */
export function sew(oc: Occt, faces: readonly Solid[], tolerance: number): SewResult {
  if (faces.length === 0) {
    throw new Error("sew: no faces to sew");
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new Error(`sew: tolerance must be a finite positive number (got ${tolerance})`);
  }

  // BRepBuilderAPI_Sewing(tol, sewing, analysis, cutting, nonmanifold) — the only
  // bound ctor takes all five args (no defaulted overloads in this wasm).
  const sewing = new oc.BRepBuilderAPI_Sewing(tolerance, true, true, true, false);
  const progress = new oc.Message_ProgressRange_1();
  const trash: Array<{ delete(): void }> = [sewing, progress];
  try {
    for (const f of faces) sewing.Add(f.shape);
    sewing.Perform(progress);

    const sewed = sewing.SewedShape();
    // SewedShape() is an owned handle even when null — free before throw.
    if (sewed.IsNull()) {
      sewed.delete();
      throw new Error("sew: produced an empty shape");
    }

    const sewingFreeEdges = sewing.NbFreeEdges();
    let freeEdges: FreeEdgeReport;
    try {
      freeEdges = analyzeFreeBounds(oc, sewed, sewingFreeEdges);
    } catch (e) {
      sewed.delete();
      throw e;
    }

    return { shell: new Solid(oc, sewed), freeEdges };
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Promote a closed shell to a solid.
 *
 * Intended OCCT route is `BRepBuilderAPI_MakeSolid` (§14), but `TopoDS_Shell` is
 * unbound in this wasm so every MakeSolid overload that takes a shell throws at
 * the embind boundary. The working route is `BRep_Builder.MakeSolid` +
 * `BRep_Builder.Add(solid, shellShape)` — Add accepts `TopoDS_Shape` and needs
 * no Shell downcast. See file header for the binding pin.
 *
 * Closure is verified, never assumed: free edges must be zero, the builder must
 * produce a non-null solid, BRepCheck_Analyzer must accept it, and signed volume
 * must be positive (inward shells are flipped via BRepLib.OrientClosedSolid /
 * reverse).
 *
 * `closedShell` is not consumed.
 */
export function solidify(oc: Occt, closedShell: Solid): Solid {
  const free = analyzeFreeBounds(oc, closedShell.shape);
  if (free.freeEdgeCount !== 0) {
    throw new Error(
      `solidify: shell is not closed (${free.freeEdgeCount} free edge(s); ` +
        `${free.closedFreeWires} closed free wire(s), ${free.openFreeWires} open)`,
    );
  }

  // Require a single shell (or a shape that IS a shell). Without TopoDS.Shell_1
  // we cannot downcast a compound's sole shell child — reject compounds so the
  // caller sews to a bare shell first (BRepBuilderAPI_Sewing returns a bare
  // shell when faces stitch into one connected surface).
  const S = shapeEnums(oc);
  const shapeType = closedShell.shape.ShapeType();
  if (shapeType !== S.TopAbs_SHELL) {
    // A solid is already solid — refuse rather than double-wrap.
    if (shapeType === S.TopAbs_SOLID) {
      throw new Error("solidify: shape is already a solid (expected a shell)");
    }
    throw new Error(
      "solidify: shape is not a TopoDS_Shell (sew faces first; multi-shell " +
        "compounds cannot be downcast in this wasm — TopoDS_Shell is unbound)",
    );
  }

  const trash: Array<{ delete(): void }> = [];
  // solidShape is the candidate return value — only freed on failure paths.
  let solidShape: TopoDS_Shape | null = null;
  try {
    // BRep_Builder.MakeSolid + Add(shellAsShape): the only shell→solid path that
    // does not require a bound TopoDS_Shell type (Add takes TopoDS_Shape).
    const builder = new oc.BRep_Builder();
    trash.push(builder);
    const solid = new oc.TopoDS_Solid();
    // solid is the out-param; after MakeSolid+Add it holds the solid. We transfer
    // ownership to the returned Solid on success (or free it on failure).
    builder.MakeSolid(solid);
    builder.Add(solid, closedShell.shape);
    if (solid.IsNull()) {
      solid.delete();
      throw new Error("solidify: BRep_Builder produced an empty solid");
    }
    solidShape = solid;

    // Orient outward when possible so volume is positive (Python reconstruct chain).
    try {
      oc.BRepLib.OrientClosedSolid(solid);
    } catch {
      // OrientClosedSolid can raise on non-closed/odd input; fall through to
      // analyzer + volume sign flip below rather than failing the whole op.
    }

    const analyzer = new oc.BRepCheck_Analyzer(solid, true, false);
    trash.push(analyzer);
    if (!analyzer.IsValid_2()) {
      throw new Error("solidify: resulting solid failed BRepCheck_Analyzer");
    }

    // Guarantee positive signed volume (same discipline as thicken).
    const props = new oc.GProp_GProps_1();
    let signed: number;
    try {
      oc.BRepGProp.VolumeProperties_1(solid, props, false, false, false);
      signed = props.Mass();
    } finally {
      props.delete();
    }
    if (!(signed > 0)) {
      if (signed < 0) {
        const rev = solid.Reversed();
        solid.delete();
        solidShape = null;
        return new Solid(oc, rev);
      }
      throw new Error(`solidify: solid has non-positive volume (${signed})`);
    }

    solidShape = null; // transferred
    return new Solid(oc, solid);
  } finally {
    if (solidShape) solidShape.delete();
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Heal a shape: optional sew (default tol 1e-6) + ShapeFix_Shape, then optional
 * ShapeFix_Solid. Returns a new owned Solid; the input is not consumed.
 */
export function heal(oc: Occt, shape: Solid, opts?: HealOptions): Solid {
  const sewTolerance = opts?.sewTolerance ?? 1e-6;
  const fixSolid = opts?.fixSolid ?? false;

  // 0 / negative skips sewing; NaN / ±Inf always rejected.
  if (!Number.isFinite(sewTolerance)) {
    throw new Error(`heal: sewTolerance must be finite (got ${sewTolerance})`);
  }

  const trash: Array<{ delete(): void }> = [];
  // Shapes we allocated that are intermediate (not the final return) go here so
  // they free on every exit; the returned Solid's shape is deliberately NOT on
  // this list.
  let owned: TopoDS_Shape | null = null;
  try {
    let current: TopoDS_Shape = shape.shape;

    // ── optional sew ────────────────────────────────────────────────────────
    if (sewTolerance > 0) {
      const sewing = new oc.BRepBuilderAPI_Sewing(sewTolerance, true, true, true, false);
      trash.push(sewing);
      const progress = new oc.Message_ProgressRange_1();
      trash.push(progress);
      sewing.Add(current);
      sewing.Perform(progress);
      const sewed = sewing.SewedShape();
      if (sewed.IsNull()) {
        sewed.delete();
        throw new Error("heal: sewing produced an empty shape");
      }
      owned = sewed;
      current = sewed;
    }

    // ── ShapeFix_Shape ──────────────────────────────────────────────────────
    // ShapeFix_Shape_2(shape) seeds the fixer; Perform needs a progress range.
    const fixer = new oc.ShapeFix_Shape_2(current);
    trash.push(fixer);
    const fixProgress = new oc.Message_ProgressRange_1();
    trash.push(fixProgress);
    fixer.SetPrecision(sewTolerance > 0 ? sewTolerance : 1e-6);
    fixer.Perform(fixProgress);
    const fixed = fixer.Shape();
    if (fixed.IsNull()) {
      fixed.delete();
      throw new Error("heal: ShapeFix_Shape produced an empty shape");
    }
    // Drop the sewed intermediate if it is a different handle than fixed.
    if (owned && owned !== fixed) {
      owned.delete();
    }
    owned = fixed;
    current = fixed;

    // ── optional ShapeFix_Solid ─────────────────────────────────────────────
    if (fixSolid) {
      current = applyFixSolid(oc, current, trash, sewTolerance > 0 ? sewTolerance : 1e-6);
      // applyFixSolid returns either the same shape or a new owned solid shape;
      // track ownership carefully.
      if (current !== owned) {
        owned.delete();
        owned = current;
      }
    }

    // Transfer ownership to the returned Solid.
    const out = new Solid(oc, owned);
    owned = null;
    return out;
  } finally {
    if (owned) owned.delete();
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Free-edge report via ShapeAnalysis_FreeBounds.
 *
 * Uses FreeBounds_3 (topological: edges not shared by two faces). After a sew
 * pass the shared-topology view is the right gate; FreeBounds_2 (geometric with
 * a tolerance) is available if a future caller needs pre-sew gap forecasting.
 */
export function analyzeFreeBounds(
  oc: Occt,
  shape: TopoDS_Shape,
  sewingFreeEdges?: number,
): FreeEdgeReport {
  // FreeBounds_3(shape, splitclosed, splitopen, checkinternaledges)
  const bounds = new oc.ShapeAnalysis_FreeBounds_3(shape, false, true, false);
  const S = shapeEnums(oc);
  const trash: Array<{ delete(): void }> = [bounds];
  try {
    const closed = bounds.GetClosedWires();
    trash.push(closed);
    const open = bounds.GetOpenWires();
    trash.push(open);

    const closedFreeWires = countSubshapes(oc, closed, S.TopAbs_WIRE, trash);
    const openFreeWires = countSubshapes(oc, open, S.TopAbs_WIRE, trash);
    const freeEdgeCount =
      countSubshapes(oc, closed, S.TopAbs_EDGE, trash) +
      countSubshapes(oc, open, S.TopAbs_EDGE, trash);

    return {
      freeEdgeCount,
      closedFreeWires,
      openFreeWires,
      ...(sewingFreeEdges !== undefined ? { sewingFreeEdges } : {}),
    };
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

function countSubshapes(
  oc: Occt,
  shape: TopoDS_Shape,
  kind: TopAbs_ShapeEnum,
  trash: Array<{ delete(): void }>,
): number {
  const S = shapeEnums(oc);
  const exp = new oc.TopExp_Explorer_2(shape, kind, S.TopAbs_SHAPE);
  trash.push(exp);
  let n = 0;
  while (exp.More()) {
    n++;
    exp.Next();
  }
  return n;
}

/**
 * Run ShapeFix_Solid over every solid in `shape`. Returns either the original
 * shape (no solids / no change) or a new owned shape the caller must free.
 *
 * Temporaries go on `trash`; the returned shape is NOT pushed to trash.
 */
function applyFixSolid(
  oc: Occt,
  shape: TopoDS_Shape,
  trash: Array<{ delete(): void }>,
  precision: number,
): TopoDS_Shape {
  const S = shapeEnums(oc);

  // Fast path: shape itself is a solid.
  if (shape.ShapeType() === S.TopAbs_SOLID) {
    const s = oc.TopoDS.Solid_1(shape);
    trash.push(s);
    return fixOneSolid(oc, s, trash, precision);
  }

  // Multi-body / compound: fix each solid in place via ShapeFix_Shape's solid
  // tool when possible. Walking solids and rebuilding a compound would re-own
  // topology; ShapeFix_Solid on a lone solid is the common import case.
  const exp = new oc.TopExp_Explorer_2(shape, S.TopAbs_SOLID, S.TopAbs_SHAPE);
  trash.push(exp);
  if (!exp.More()) {
    // No solids (e.g. a bare shell) — nothing for ShapeFix_Solid to do.
    return shape;
  }
  // If there is exactly one solid and the shape IS that solid's TShape (or a
  // compound of one), fix it; otherwise fix the first solid only when the whole
  // shape is itself a solid (handled above). For compounds with solids, re-run
  // ShapeFix_Shape which already has FixSolidTool, or fix the single solid and
  // return it when the shape is solely that solid.
  const first = oc.TopoDS.Solid_1(exp.Current());
  trash.push(first);
  exp.Next();
  if (exp.More()) {
    // Multiple solids: leave the ShapeFix_Shape result as-is (its FixSolidTool
    // already ran during Perform). Avoid silently dropping sibling bodies.
    return shape;
  }
  // Single solid inside a non-solid container (e.g. compound of one) — fix it
  // and return the fixed solid shape.
  return fixOneSolid(oc, first, trash, precision);
}

function fixOneSolid(
  oc: Occt,
  solid: TopoDS_Solid,
  trash: Array<{ delete(): void }>,
  precision: number,
): TopoDS_Shape {
  // ShapeFix_Solid_2(solid) seeds; Solid() returns the fixed solid as a shape.
  const fixer = new oc.ShapeFix_Solid_2(solid);
  trash.push(fixer);
  fixer.SetPrecision(precision);
  const progress = new oc.Message_ProgressRange_1();
  trash.push(progress);
  fixer.Perform(progress);
  const out = fixer.Solid();
  if (out.IsNull()) {
    out.delete();
    // Fall back to Shape() if Solid() is empty.
    const alt = fixer.Shape();
    if (alt.IsNull()) {
      alt.delete();
      throw new Error("heal: ShapeFix_Solid produced an empty shape");
    }
    return alt;
  }
  return out;
}
