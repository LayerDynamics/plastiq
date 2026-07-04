// Sketch hit-testing + select-then-constrain logic (SPEC-5 M3.4). Pure functions:
// map a screen click to the nearest sketch entity/point, and turn a selection +
// a constraint kind into the SketchConstraint to add (or null if the selection
// doesn't fit that constraint). Solving is the kernel's job (useSketchStore.solve).

import { circumcircle, type SketchConstraint, type SketchModel } from "./model.js";
import { catmullRomPoints } from "./spline2d.js";
import { toScreen, type Px, type View2D } from "./transform2d.js";

export interface Hit {
  kind: "point" | "line" | "circle" | "arc" | "spline";
  id: string;
}

/** Distance (px) from point `p` to segment `a`→`b`. Exported for direct unit
 * tests of the degenerate-segment guard (hitTest can't observe it — a degenerate
 * line's coincident endpoints always win the point rank first). */
export function distToSegment(p: Px, a: Px, b: Px): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  // Degenerate (near-zero-length) segment → treat as a point instead of dividing
  // by ~0. Epsilon follows the sketch module's length guards (model.ts uses
  // `len < 1e-9`); len2 is a SQUARED px length, hence 1e-18.
  if (len2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Distance (px) from `p` to the arc through screen points a → through → b. */
function distToArc(p: Px, a: Px, through: Px, b: Px): number {
  const cc = circumcircle([a.x, a.y], [b.x, b.y], [through.x, through.y]);
  if (!cc) return distToSegment(p, a, b); // collinear → treat as a chord
  const { u: cx, v: cy, r } = cc;
  const ang = (q: Px): number => Math.atan2(q.y - cy, q.x - cx);
  const norm = (x: number): number => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(a);
  const dAB = norm(ang(b) - a0);
  const span = norm(ang(through) - a0) < dAB ? dAB : dAB - 2 * Math.PI;
  const N = 24;
  let best = Infinity;
  let prev: Px = a;
  for (let i = 1; i <= N; i++) {
    const t = a0 + (span * i) / N;
    const cur = { x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) };
    best = Math.min(best, distToSegment(p, prev, cur));
    prev = cur;
  }
  return best;
}

/** Distance (px) from `p` to the Catmull-Rom polyline through screen `pts`. */
function distToSpline(p: Px, pts: Px[]): number {
  const samples = catmullRomPoints(pts);
  let best = Infinity;
  for (let i = 1; i < samples.length; i++) {
    best = Math.min(best, distToSegment(p, samples[i - 1]!, samples[i]!));
  }
  return best;
}

/**
 * The nearest sketch entity under `px` within `tol` pixels. Points win ties
 * (they sit on top of lines), then lines/circles.
 */
export function hitTest(model: SketchModel, view: View2D, px: Px, tol = 7): Hit | null {
  const screen = (id: string): Px | null => {
    const p = model.points.find((q) => q.id === id);
    return p ? toScreen(view, { u: p.u, v: p.v }) : null;
  };

  let best: { hit: Hit; d: number; rank: number } | null = null;
  const consider = (hit: Hit, d: number, rank: number): void => {
    if (d <= tol && (!best || rank < best.rank || (rank === best.rank && d < best.d))) {
      best = { hit, d, rank };
    }
  };

  for (const p of model.points) {
    consider(
      { kind: "point", id: p.id },
      Math.hypot(
        px.x - toScreen(view, { u: p.u, v: p.v }).x,
        px.y - toScreen(view, { u: p.u, v: p.v }).y,
      ),
      0,
    );
  }
  for (const e of model.entities) {
    if (e.kind === "line") {
      const a = screen(e.a);
      const b = screen(e.b);
      if (a && b) consider({ kind: "line", id: e.id }, distToSegment(px, a, b), 1);
    } else if (e.kind === "circle") {
      const c = screen(e.center);
      if (c)
        consider(
          { kind: "circle", id: e.id },
          Math.abs(Math.hypot(px.x - c.x, px.y - c.y) - e.radius * view.scale),
          1,
        );
    } else if (e.kind === "arc") {
      // Arc: distance to the tessellated arc through its three screen points.
      const a = screen(e.a);
      const b = screen(e.b);
      const t = screen(e.through);
      if (a && b && t) consider({ kind: "arc", id: e.id }, distToArc(px, a, t, b), 1);
    } else {
      // Spline: distance to the Catmull-Rom polyline through its screen points.
      const pts = e.points.map(screen);
      if (pts.every((p): p is Px => p !== null) && pts.length >= 2) {
        consider({ kind: "spline", id: e.id }, distToSpline(px, pts), 1);
      }
    }
  }
  return best ? (best as { hit: Hit }).hit : null;
}

/** A constraint a selection supports (one-shot applicable / disabled in UI). */
export type ConstraintKind =
  | "horizontal"
  | "vertical"
  | "coincident"
  | "parallel"
  | "perpendicular"
  | "equalLength"
  | "concentric"
  | "tangent"
  | "midpoint"
  | "pointOnObject"
  | "symmetric";

const lineIds = (model: SketchModel, sel: readonly string[]): string[] =>
  sel.filter((id) => model.entities.some((e) => e.id === id && e.kind === "line"));
const circleIds = (model: SketchModel, sel: readonly string[]): string[] =>
  sel.filter((id) => model.entities.some((e) => e.id === id && e.kind === "circle"));
const pointIds = (model: SketchModel, sel: readonly string[]): string[] =>
  sel.filter((id) => model.points.some((p) => p.id === id));

/** Whether `kind` can apply to the current selection. */
export function canApply(
  kind: ConstraintKind,
  model: SketchModel,
  sel: readonly string[],
): boolean {
  const lines = lineIds(model, sel).length;
  const circles = circleIds(model, sel).length;
  const points = pointIds(model, sel).length;
  switch (kind) {
    case "horizontal":
    case "vertical":
      return lines >= 1;
    case "coincident":
      return points === 2;
    case "parallel":
    case "perpendicular":
    case "equalLength":
      return lines === 2;
    case "concentric":
      return circles === 2;
    case "tangent":
      return lines === 1 && circles === 1;
    case "midpoint":
      return points === 1 && lines === 1;
    case "pointOnObject":
      return points === 1 && lines + circles === 1;
    case "symmetric":
      return points === 2 && lines === 1;
  }
}

/**
 * Build the constraint(s) for a selection + kind (empty if it doesn't apply).
 * Horizontal/vertical apply to every selected line; the binary line/point
 * constraints take the first two selected.
 */
export function buildConstraints(
  kind: ConstraintKind,
  model: SketchModel,
  sel: readonly string[],
  nextId: () => string,
): SketchConstraint[] {
  const lines = lineIds(model, sel);
  const circles = circleIds(model, sel);
  const points = pointIds(model, sel);
  switch (kind) {
    case "horizontal":
    case "vertical":
      return lines.map((line) => ({ id: nextId(), kind, line }));
    case "coincident":
      return points.length === 2 ? [{ id: nextId(), kind, a: points[0]!, b: points[1]! }] : [];
    case "parallel":
    case "perpendicular":
    case "equalLength":
      return lines.length === 2 ? [{ id: nextId(), kind, line1: lines[0]!, line2: lines[1]! }] : [];
    case "concentric":
      return circles.length === 2
        ? [{ id: nextId(), kind, circle1: circles[0]!, circle2: circles[1]! }]
        : [];
    case "tangent":
      return lines.length === 1 && circles.length === 1
        ? [{ id: nextId(), kind, line: lines[0]!, circle: circles[0]! }]
        : [];
    case "midpoint":
      return points.length === 1 && lines.length === 1
        ? [{ id: nextId(), kind, point: points[0]!, line: lines[0]! }]
        : [];
    case "pointOnObject": {
      const objs = [...lines, ...circles];
      return points.length === 1 && objs.length === 1
        ? [{ id: nextId(), kind, point: points[0]!, object: objs[0]! }]
        : [];
    }
    case "symmetric":
      return points.length === 2 && lines.length === 1
        ? [{ id: nextId(), kind, a: points[0]!, b: points[1]!, axis: lines[0]! }]
        : [];
  }
}
