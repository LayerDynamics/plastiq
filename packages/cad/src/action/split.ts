// Body split and section-curve ops (§13.2).
//
//   split(oc, body, tool)         → Solid[]   via BRepAlgoAPI_Splitter
//   sectionCurves(oc, body, plane) → Solid     via BRepAlgoAPI_Section
//
// `split` keeps BOTH sides of a cut: the tool (a datum plane, a face Solid, or a
// body Solid) slices the argument and every resulting lump is returned as its own
// owned Solid. Contrast with `subtract`, which discards the tool-side material.
//
// Pipeline mirrors boolean.ts (§2.2): default-construct → SetArguments/SetTools →
// SetFuzzyValue(1e-7) → SetNonDestructive → Build → HasErrors → UnifySameDomain
// → bodiesOf. The convenience ctors that build inside the constructor are avoided
// so the fuzzy/NonDestructive knobs are not silent no-ops.
//
// `sectionCurves` returns the intersection of a body with a datum plane as a
// Solid whose underlying shape is a compound of edges (the section curves). The
// caller owns and frees it; LinearProperties on that shape is the total perimeter.

import type { TopoDS_Shape } from "opencascade.js";

import type { Occt } from "../oc/init.js";
import type { Vec3 } from "../math/index.js";
import { sub, dot, length } from "../math/index.js";
import type { DatumPlane } from "../env/plane.js";
import { planeYAxis } from "../env/plane.js";
import { Solid, bodiesOf } from "../solid/solid.js";

/** Fuzzy tolerance applied to split/section — same contract as boolean.ts. */
const BOOLEAN_FUZZY = 1e-7;

/**
 * A split tool: a datum plane (turned into a covering face), a face Solid, or a
 * body Solid. Planes and faces cut through; a solid tool splits along its skin
 * (pieces of the argument that fall outside the tool stay whole).
 */
export type SplitTool = DatumPlane | Solid;

function isDatumPlane(tool: SplitTool): tool is DatumPlane {
  // Solid carries a live `shape`; DatumPlane is pure data with origin/normal/xAxis.
  return !("shape" in tool);
}

/** Reject a non-finite or zero-length plane normal with a NAMED error. */
function assertPlane(plane: DatumPlane, op: string): void {
  if (!plane.origin.every((c) => Number.isFinite(c))) {
    throw new Error(`${op}: plane origin must be a finite point`);
  }
  if (!plane.normal.every((c) => Number.isFinite(c))) {
    throw new Error(`${op}: plane normal must be a finite vector`);
  }
  if (!plane.xAxis.every((c) => Number.isFinite(c))) {
    throw new Error(`${op}: plane xAxis must be a finite vector`);
  }
  if (length(plane.normal) === 0) {
    throw new Error(`${op}: plane normal must be a non-zero vector`);
  }
  if (length(plane.xAxis) === 0) {
    throw new Error(`${op}: plane xAxis must be a non-zero vector`);
  }
}

/**
 * Merge same-surface faces/edges of a splitter result (§2.2 / boolean.ts).
 *
 * Takes ownership of `shape`: freed here on a successful merge; returned
 * untouched (with `degraded: true`) when unify cannot run. Same K4 contract as
 * the boolean pipeline — a failed unify must not lose the caller's geometry.
 */
function unifySameDomain(
  oc: Occt,
  shape: TopoDS_Shape,
): { shape: TopoDS_Shape; degraded: boolean } {
  const usd = new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false);
  try {
    usd.SetSafeInputMode(true);
    usd.Build();
    const merged = usd.Shape();
    if (merged.IsNull()) {
      merged.delete();
      return { shape, degraded: true };
    }
    shape.delete();
    return { shape: merged, degraded: false };
  } catch {
    return { shape, degraded: true };
  } finally {
    usd.delete();
  }
}

/**
 * A rectangular face on `plane` large enough to fully cut through `body`.
 *
 * UV extents are the body's AABB corners projected onto the plane frame, plus a
 * margin — so a plane origin far from the body still covers it (a fixed halfSize
 * centered on the origin would miss). Caller owns the returned face shape.
 */
function planeFaceCoveringBody(oc: Occt, plane: DatumPlane, body: Solid): TopoDS_Shape {
  const { min, max } = body.boundingBox();
  const corners: Vec3[] = [
    [min[0], min[1], min[2]],
    [min[0], min[1], max[2]],
    [min[0], max[1], min[2]],
    [min[0], max[1], max[2]],
    [max[0], min[1], min[2]],
    [max[0], min[1], max[2]],
    [max[0], max[1], min[2]],
    [max[0], max[1], max[2]],
  ];
  const yAxis = planeYAxis(plane);
  let uMin = Infinity;
  let uMax = -Infinity;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (const c of corners) {
    const d = sub(c, plane.origin);
    const u = dot(d, plane.xAxis);
    const v = dot(d, yAxis);
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  // Empty / degenerate bbox: give the face a tiny but non-zero span so MakeFace
  // still builds; a body with zero extent can't be cut usefully anyway.
  if (!Number.isFinite(uMin) || !Number.isFinite(vMin)) {
    uMin = -1e-3;
    uMax = 1e-3;
    vMin = -1e-3;
    vMax = 1e-3;
  }
  const span = Math.max(uMax - uMin, vMax - vMin, 1e-6);
  const margin = span * 0.1 + 1e-3;

  const trash: Array<{ delete(): void }> = [];
  try {
    // Build gp_Pln from the DatumPlane's own (origin, normal, xAxis) frame so the
    // UV bounds computed above match MakeFace's parametric axes. gp_Pln_3(P, N)
    // invents its own X direction, which can disagree with plane.xAxis and leave
    // the face not covering the body (e.g. planeYZ mid-splits returning 1 lump).
    const p = new oc.gp_Pnt_3(plane.origin[0], plane.origin[1], plane.origin[2]);
    trash.push(p);
    const n = new oc.gp_Dir_4(plane.normal[0], plane.normal[1], plane.normal[2]);
    trash.push(n);
    const vx = new oc.gp_Dir_4(plane.xAxis[0], plane.xAxis[1], plane.xAxis[2]);
    trash.push(vx);
    const ax3 = new oc.gp_Ax3_3(p, n, vx);
    trash.push(ax3);
    const pln = new oc.gp_Pln_2(ax3);
    trash.push(pln);
    const maker = new oc.BRepBuilderAPI_MakeFace_9(
      pln,
      uMin - margin,
      uMax + margin,
      vMin - margin,
      vMax + margin,
    );
    trash.push(maker);
    if (!maker.IsDone()) {
      throw new Error("split: failed to build a planar face for the plane tool");
    }
    return maker.Face();
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}

/**
 * Split `body` by `tool`, returning every resulting solid lump as its own owned
 * {@link Solid}. Both sides of the cut are kept.
 *
 * `body` (and a Solid tool) are NOT consumed — the splitter runs NonDestructive.
 * The caller still owns them and must free each returned Solid.
 *
 * Throws a named error when the plane tool is ill-formed, the splitter reports
 * errors, or the result is empty.
 */
export function split(oc: Occt, body: Solid, tool: SplitTool): Solid[] {
  // Plane pre-validation BEFORE any OCCT allocation (revolve.ts / hole.ts pattern).
  if (isDatumPlane(tool)) {
    assertPlane(tool, "split");
  }

  const argList = new oc.TopTools_ListOfShape_1();
  const toolList = new oc.TopTools_ListOfShape_1();
  const range = new oc.Message_ProgressRange_1();
  // Plane tools allocate a covering face the splitter borrows; free it after Build.
  let ownedPlaneFace: TopoDS_Shape | null = null;
  const op = new oc.BRepAlgoAPI_Splitter_1();
  try {
    argList.Append_1(body.shape);

    if (isDatumPlane(tool)) {
      ownedPlaneFace = planeFaceCoveringBody(oc, tool, body);
      toolList.Append_1(ownedPlaneFace);
    } else {
      toolList.Append_1(tool.shape);
    }

    op.SetArguments(argList);
    op.SetTools(toolList);
    op.SetFuzzyValue(BOOLEAN_FUZZY);
    // Operands must survive: the rebuild accumulator reuses the same Solid across
    // successive ops, and per-feature shape caching depends on input immutability.
    op.SetNonDestructive(true);
    op.Build(range);

    if (op.HasErrors() || !op.IsDone()) {
      throw new Error("split: splitter produced no valid result");
    }
    const shape = op.Shape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("split: splitter produced an empty shape");
    }

    // Unify coplanar fragments, then lift each solid out as an owned handle.
    // bodiesOf copies the solid handles (TShape refcounted); free the compound
    // after extraction so the intermediate does not leak in the long-lived worker.
    const unified = unifySameDomain(oc, shape);
    const compound = new Solid(oc, unified.shape);
    try {
      const parts = bodiesOf(oc, compound);
      if (parts.length === 0) {
        // A splitter that returns only shells/faces (no solid lumps) is a hard
        // failure for this op — the contract is Solid[].
        throw new Error("split: result contained no solid bodies");
      }
      return parts;
    } finally {
      compound.delete();
    }
  } finally {
    op.delete();
    range.delete();
    toolList.delete();
    argList.delete();
    if (ownedPlaneFace) ownedPlaneFace.delete();
  }
}

/**
 * Intersection of `body` with `plane` as a compound of edges (section curves).
 *
 * Returns a new owned {@link Solid} whose shape is the section result — typically
 * a compound of edges forming closed or open wires. Callers that need the total
 * perimeter use `BRepGProp.LinearProperties` on the shape; callers that need
 * individual edges explore `TopAbs_EDGE`. `body` is not consumed.
 *
 * Throws a named error when the plane is ill-formed or the section is empty /
 * failed.
 */
export function sectionCurves(oc: Occt, body: Solid, plane: DatumPlane): Solid {
  assertPlane(plane, "sectionCurves");

  const trash: Array<{ delete(): void }> = [];
  try {
    const p = new oc.gp_Pnt_3(plane.origin[0], plane.origin[1], plane.origin[2]);
    trash.push(p);
    const d = new oc.gp_Dir_4(plane.normal[0], plane.normal[1], plane.normal[2]);
    trash.push(d);
    const pln = new oc.gp_Pln_3(p, d);
    trash.push(pln);

    // PerformNow=false so SetFuzzyValue/SetNonDestructive apply before Build
    // (same trap as boolean convenience ctors — see boolean.ts:152-155).
    const op = new oc.BRepAlgoAPI_Section_5(body.shape, pln, false);
    trash.push(op);
    op.SetFuzzyValue(BOOLEAN_FUZZY);
    op.SetNonDestructive(true);
    const range = new oc.Message_ProgressRange_1();
    trash.push(range);
    op.Build(range);

    if (op.HasErrors() || !op.IsDone()) {
      throw new Error("sectionCurves: section produced no valid result");
    }
    const shape = op.Shape();
    if (shape.IsNull()) {
      shape.delete();
      throw new Error("sectionCurves: section produced an empty shape");
    }
    return new Solid(oc, shape);
  } finally {
    for (let i = trash.length - 1; i >= 0; i--) trash[i]!.delete();
  }
}
