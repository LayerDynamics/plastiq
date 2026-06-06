// Sketch inference + snapping (SPEC-5 M3.3, FR-17). Pure functions that, given
// the model + the cursor, predict where a click should land (snap to
// origin/endpoint/centre/grid) and which constraint the user likely intends
// (horizontal / vertical of the segment being drawn). The overlay renders the
// snap marker + guides and, on accept, persists the inferred constraint (unless
// Shift suppresses it). Pure → unit-tested without the DOM.

import { circumcircle, type LineEntity, type SketchModel } from "./model.js";
import { gridStep, toScreen, type Px, type Vec2, type View2D } from "./transform2d.js";

export type SnapKind = "origin" | "point" | "midpoint" | "center" | "grid";

export interface Snap {
  kind: SnapKind;
  /** The snapped plane coordinate. */
  u: number;
  v: number;
  /** Existing point id when snapping onto one (so the chain truly connects). */
  pointId?: string;
}

/** Pixel distance between two screen points. */
function dist(a: Px, b: Px): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The best snap target under `cursorPx`, within `pixelTol`. Priority:
 * origin > existing points > grid intersection (grid always available as a
 * fallback, so a click is never unconstrained-by-pixels).
 */
export function nearestSnap(model: SketchModel, view: View2D, cursorPx: Px, pixelTol = 10): Snap {
  let best: { snap: Snap; px: number } | null = null;
  const consider = (snap: Snap): void => {
    const d = dist(cursorPx, toScreen(view, { u: snap.u, v: snap.v }));
    if (d <= pixelTol && (!best || d < best.px)) best = { snap, px: d };
  };

  const coord = (id: string): Vec2 | null => {
    const p = model.points.find((q) => q.id === id);
    return p ? { u: p.u, v: p.v } : null;
  };

  consider({ kind: "origin", u: 0, v: 0 });
  for (const p of model.points) consider({ kind: "point", u: p.u, v: p.v, pointId: p.id });

  // Midpoint of each line segment, and the centre of each circle/arc.
  for (const e of model.entities) {
    if (e.construction) continue;
    if (e.kind === "line") {
      const a = coord(e.a);
      const b = coord(e.b);
      if (a && b) consider({ kind: "midpoint", u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 });
    } else if (e.kind === "circle") {
      const c = coord(e.center);
      if (c) consider({ kind: "center", u: c.u, v: c.v });
    } else if (e.kind === "arc") {
      const a = coord(e.a);
      const b = coord(e.b);
      const t = coord(e.through);
      if (a && b && t) {
        const cc = circumcircle([a.u, a.v], [b.u, b.v], [t.u, t.v]);
        if (cc) consider({ kind: "center", u: cc.u, v: cc.v });
      }
    }
  }

  if (best) return (best as { snap: Snap }).snap;

  // Fallback: snap to the nearest grid intersection.
  const step = gridStep(view.scale);
  const world: Vec2 = {
    u: (cursorPx.x - view.panX) / view.scale,
    v: -(cursorPx.y - view.panY) / view.scale,
  };
  return {
    kind: "grid",
    u: Math.round(world.u / step) * step,
    v: Math.round(world.v / step) * step,
  };
}

export type LineHint = "horizontal" | "vertical" | null;

/**
 * Predict an H/V constraint for the segment `start`→`end` when it is within
 * `angleTolDeg` of an axis. Returns null for diagonal segments.
 */
export function lineHint(start: Vec2, end: Vec2, angleTolDeg = 4): LineHint {
  const du = end.u - start.u;
  const dv = end.v - start.v;
  if (du === 0 && dv === 0) return null;
  const deg = (Math.atan2(Math.abs(dv), Math.abs(du)) * 180) / Math.PI;
  if (deg <= angleTolDeg) return "horizontal";
  if (deg >= 90 - angleTolDeg) return "vertical";
  return null;
}

/** The constraint an inferred segment relation implies (to attach on accept). */
export type InferredConstraint =
  | { kind: "horizontal" }
  | { kind: "vertical" }
  | { kind: "parallel"; refLine: string }
  | { kind: "perpendicular"; refLine: string }
  | { kind: "tangent"; circle: string };

export interface SegHint {
  glyph: "H" | "V" | "∥" | "⟂" | "T";
  constraint: InferredConstraint;
}

/** Angle of a vector in [0,180) degrees (undirected line orientation). */
function orientDeg(du: number, dv: number): number {
  let a = (Math.atan2(dv, du) * 180) / Math.PI;
  a = ((a % 180) + 180) % 180;
  return a;
}

/**
 * Predict the strongest constraint for the segment `start`→`end`: axis H/V wins;
 * otherwise the segment being parallel / perpendicular to a nearby existing line
 * (the closest in orientation within `angleTolDeg`). Null when it's a free
 * diagonal unrelated to any edge.
 */
export function segmentHint(
  model: SketchModel,
  start: Vec2,
  end: Vec2,
  angleTolDeg = 4,
): SegHint | null {
  const du = end.u - start.u;
  const dv = end.v - start.v;
  if (du === 0 && dv === 0) return null;
  const hv = lineHint(start, end, angleTolDeg);
  if (hv === "horizontal") return { glyph: "H", constraint: { kind: "horizontal" } };
  if (hv === "vertical") return { glyph: "V", constraint: { kind: "vertical" } };

  const mine = orientDeg(du, dv);
  let bestParallel: { line: LineEntity; diff: number } | null = null;
  let bestPerp: { line: LineEntity; diff: number } | null = null;
  for (const e of model.entities) {
    if (e.kind !== "line" || e.construction) continue;
    const a = model.points.find((p) => p.id === e.a);
    const b = model.points.find((p) => p.id === e.b);
    if (!a || !b) continue;
    const theirs = orientDeg(b.u - a.u, b.v - a.v);
    const diff = Math.abs(((mine - theirs + 90) % 180) - 90); // 0 = parallel, 90 = perp
    if (diff <= angleTolDeg && (!bestParallel || diff < bestParallel.diff)) {
      bestParallel = { line: e, diff };
    }
    const perpDiff = Math.abs(90 - diff);
    if (perpDiff <= angleTolDeg && (!bestPerp || perpDiff < bestPerp.diff)) {
      bestPerp = { line: e, diff: perpDiff };
    }
  }
  if (bestParallel && (!bestPerp || bestParallel.diff <= bestPerp.diff)) {
    return { glyph: "∥", constraint: { kind: "parallel", refLine: bestParallel.line.id } };
  }
  if (bestPerp) {
    return { glyph: "⟂", constraint: { kind: "perpendicular", refLine: bestPerp.line.id } };
  }

  // Tangent: the segment's infinite line grazes a nearby circle (|dist−r|/r small).
  const len = Math.hypot(du, dv);
  for (const e of model.entities) {
    if (e.kind !== "circle" || e.construction || !(e.radius > 0)) continue;
    const c = model.points.find((p) => p.id === e.center);
    if (!c) continue;
    const dist = Math.abs((c.u - start.u) * dv - (c.v - start.v) * du) / len;
    if (Math.abs(dist - e.radius) / e.radius <= 0.05) {
      return { glyph: "T", constraint: { kind: "tangent", circle: e.id } };
    }
  }
  return null;
}
