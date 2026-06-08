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

/** Whether a dimension of `kind` can apply to the current selection. */
export function canDimension(
  kind: DimensionKind,
  model: SketchModel,
  sel: readonly string[],
): boolean {
  if (kind === "distance" || kind === "hDistance" || kind === "vDistance") {
    return pointSel(model, sel).length === 2;
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
    const [a, b] = pointSel(model, sel);
    const pa = a ? point(model, a) : undefined;
    const pb = b ? point(model, b) : undefined;
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
    const [a, b] = pointSel(model, sel);
    return a && b ? { id, kind, a, b, value } : null;
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
