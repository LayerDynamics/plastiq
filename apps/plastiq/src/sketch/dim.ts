// Sketch dimensions (SPEC-5 M3.5, FR-19). A dimension is a valued constraint
// (distance / angle / radius) the solver enforces. The UI seeds a new dimension
// with the geometry's CURRENT measured value (so adding it doesn't jump the
// model), then the value is editable (double-click → re-solve). Pure measure +
// build helpers, unit-tested.

import type { SketchConstraint, SketchModel } from "./model.js";

export type DimensionKind =
  | "distance"
  | "hDistance"
  | "vDistance"
  | "radius"
  | "diameter"
  | "angle"
  | "lineAngle";

function point(model: SketchModel, id: string): { u: number; v: number } | undefined {
  return model.points.find((p) => p.id === id);
}
function lineSel(model: SketchModel, sel: readonly string[]): string[] {
  return sel.filter((id) => model.entities.some((e) => e.id === id && e.kind === "line"));
}
function pointSel(model: SketchModel, sel: readonly string[]): string[] {
  return sel.filter((id) => model.points.some((p) => p.id === id));
}
function circleSel(model: SketchModel, sel: readonly string[]): string[] {
  return sel.filter((id) => model.entities.some((e) => e.id === id && e.kind === "circle"));
}

/**
 * The two points a length dimension spans, or null if the selection doesn't name
 * a pair.
 *
 * Two selected points are the explicit form. A single selected SEGMENT is the
 * one every CAD app supports and this one used to drop on the floor: picking a
 * line and asking for its length means its two endpoints. Resolving that here —
 * rather than in each of measure/build/can — keeps all three agreeing on which
 * pair they are talking about, which is what stops a dimension being offered on
 * a selection it then silently refuses to build.
 *
 * Anything ambiguous (a line AND a loose point, two lines) returns null: two
 * lines is an ANGLE dimension, and guessing between readings would attach a
 * dimension to geometry the user did not pick.
 */
function dimPoints(model: SketchModel, sel: readonly string[]): [string, string] | null {
  const pts = pointSel(model, sel);
  if (pts.length === 2) return [pts[0]!, pts[1]!];
  if (pts.length === 0) {
    const lines = lineSel(model, sel);
    if (lines.length === 1) {
      const l = model.entities.find((e) => e.id === lines[0] && e.kind === "line");
      if (l && l.kind === "line") return [l.a, l.b];
    }
  }
  return null;
}

/** Whether a dimension of `kind` can apply to the current selection. */
export function canDimension(
  kind: DimensionKind,
  model: SketchModel,
  sel: readonly string[],
): boolean {
  if (kind === "distance" || kind === "hDistance" || kind === "vDistance") {
    return dimPoints(model, sel) !== null;
  }
  if (kind === "radius" || kind === "diameter") return circleSel(model, sel).length === 1;
  if (kind === "lineAngle") return lineSel(model, sel).length === 1; // one line ∠ to X axis
  return lineSel(model, sel).length === 2; // angle (between two lines)
}

/** Angle (radians) of the directed line a→b. */
function lineAngle(model: SketchModel, lineId: string): number | null {
  const l = model.entities.find((e) => e.id === lineId && e.kind === "line");
  if (!l || l.kind !== "line") return null;
  const a = point(model, l.a);
  const b = point(model, l.b);
  if (!a || !b) return null;
  return Math.atan2(b.v - a.v, b.u - a.u);
}

/** The geometry's current measured value for a dimension (SI m / radians). */
export function measure(
  kind: DimensionKind,
  model: SketchModel,
  sel: readonly string[],
): number | null {
  if (kind === "distance" || kind === "hDistance" || kind === "vDistance") {
    const pair = dimPoints(model, sel);
    const pa = pair ? point(model, pair[0]) : undefined;
    const pb = pair ? point(model, pair[1]) : undefined;
    if (!pa || !pb) return null;
    if (kind === "hDistance") return pb.u - pa.u; // signed Δx
    if (kind === "vDistance") return pb.v - pa.v; // signed Δy
    return Math.hypot(pb.u - pa.u, pb.v - pa.v);
  }
  if (kind === "radius" || kind === "diameter") {
    const [cid] = circleSel(model, sel);
    const c = model.entities.find((e) => e.id === cid && e.kind === "circle");
    if (!c || c.kind !== "circle") return null;
    return kind === "diameter" ? 2 * c.radius : c.radius;
  }
  if (kind === "lineAngle") {
    const [lid] = lineSel(model, sel);
    return lid != null ? lineAngle(model, lid) : null; // radians from +X
  }
  const [l1, l2] = lineSel(model, sel);
  const a1 = l1 ? lineAngle(model, l1) : null;
  const a2 = l2 ? lineAngle(model, l2) : null;
  if (a1 == null || a2 == null) return null;
  let d = Math.abs(a2 - a1) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d; // acute angle between the lines
  return d;
}

/** Build the dimension constraint for the selection at `value`, or null. */
export function buildDimension(
  kind: DimensionKind,
  model: SketchModel,
  sel: readonly string[],
  value: number,
  id: string,
): SketchConstraint | null {
  if (kind === "distance" || kind === "hDistance" || kind === "vDistance") {
    const pair = dimPoints(model, sel);
    return pair ? { id, kind, a: pair[0], b: pair[1], value } : null;
  }
  if (kind === "radius" || kind === "diameter") {
    const [circle] = circleSel(model, sel);
    return circle ? { id, kind, circle, value } : null;
  }
  if (kind === "lineAngle") {
    const [line] = lineSel(model, sel);
    return line ? { id, kind: "lineAngle", line, value } : null;
  }
  const [line1, line2] = lineSel(model, sel);
  return line1 && line2 ? { id, kind: "angle", line1, line2, value } : null;
}
