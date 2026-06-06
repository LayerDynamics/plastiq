// The constrained-sketch model (SPEC-5 M3). This is the parametric graph the
// `sketch` feature persists in its `data` (per ADR-0013's principle: persist the
// constraints, derive the geometry). The kernel's `solveSketch` consumes a
// numeric-index form; this model uses stable string ids so the UI can reference
// points/entities/constraints directly. `toSolverInput` bridges the two.
//
// Geometry is derived: the solved point positions feed `rebuild.ts`'s profile
// (line/arc/circle wire), never stored as a dumb polyline.

import type { Constraint as SolverConstraint, SolverPoint } from "@plastiq/cad";

export type DatumPlaneId = "XY" | "XZ" | "YZ";

export interface SketchPoint {
  id: string;
  u: number;
  v: number;
  /** Anchored (the solver treats it as fixed). */
  fixed?: boolean;
}

/** A straight segment between two points. */
export interface LineEntity {
  id: string;
  kind: "line";
  a: string;
  b: string;
  construction?: boolean;
}

/** A circle: a centre point + a radius (a true arc edge at profile-build time). */
export interface CircleEntity {
  id: string;
  kind: "circle";
  center: string;
  radius: number;
  construction?: boolean;
}

/**
 * A circular arc as a profile edge: endpoints `a`,`b` plus a third point
 * `through` lying on the arc (the three points define it — see the kernel's
 * `GC_MakeArcOfCircle`). All three are ordinary sketch points the solver moves.
 */
export interface ArcEntity {
  id: string;
  kind: "arc";
  a: string;
  b: string;
  through: string;
  construction?: boolean;
}

/**
 * A B-spline as a profile edge through an ordered list of ≥2 sketch points
 * (the kernel interpolates them — see `GeomAPI_PointsToBSpline`). The edge runs
 * from `points[0]` to the last point.
 */
export interface SplineEntity {
  id: string;
  kind: "spline";
  points: string[];
  construction?: boolean;
}

export type SketchEntity = LineEntity | CircleEntity | ArcEntity | SplineEntity;

/** A constraint, referencing points/entities by id (mapped to solver indices). */
export type SketchConstraint =
  | { id: string; kind: "horizontal"; line: string }
  | { id: string; kind: "vertical"; line: string }
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "parallel"; line1: string; line2: string }
  | { id: string; kind: "perpendicular"; line1: string; line2: string }
  | { id: string; kind: "equalLength"; line1: string; line2: string }
  | { id: string; kind: "distance"; a: string; b: string; value: number; driven?: boolean }
  | { id: string; kind: "hDistance"; a: string; b: string; value: number; driven?: boolean }
  | { id: string; kind: "vDistance"; a: string; b: string; value: number; driven?: boolean }
  | { id: string; kind: "angle"; line1: string; line2: string; value: number; driven?: boolean }
  | { id: string; kind: "radius"; circle: string; value: number; driven?: boolean }
  | { id: string; kind: "diameter"; circle: string; value: number; driven?: boolean }
  | { id: string; kind: "concentric"; circle1: string; circle2: string }
  | { id: string; kind: "tangent"; line: string; circle: string }
  | { id: string; kind: "midpoint"; point: string; line: string }
  | { id: string; kind: "pointOnObject"; point: string; object: string }
  | { id: string; kind: "symmetric"; a: string; b: string; axis: string };

/** Valued (dimension) constraint kinds — those the properties UI can edit. */
export type ValuedConstraintKind =
  | "distance"
  | "hDistance"
  | "vDistance"
  | "angle"
  | "radius"
  | "diameter";

export interface SketchModel {
  plane: DatumPlaneId;
  points: SketchPoint[];
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export function emptySketch(plane: DatumPlaneId = "XY"): SketchModel {
  return { plane, points: [], entities: [], constraints: [] };
}

/** The circle through three points (the circumcircle), or null if collinear. */
export function circumcircle(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
): { u: number; v: number; r: number } | null {
  const [ax, ay] = a;
  const [bx, by] = b;
  const [cx, cy] = c;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-12) return null; // collinear
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const u = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const v = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { u, v, r: Math.hypot(ax - u, ay - v) };
}

/**
 * A point on the circle (centre `c`, radius |c→start|) at the angle bisecting
 * the CCW sweep from `start` to `end`. Used to place an arc's `through` point for
 * the centre-arc tool so the arc bulges the correct way.
 */
export function arcMidpoint(
  c: readonly [number, number],
  start: readonly [number, number],
  end: readonly [number, number],
): { u: number; v: number } {
  const r = Math.hypot(start[0] - c[0], start[1] - c[1]);
  const a0 = Math.atan2(start[1] - c[1], start[0] - c[0]);
  let a1 = Math.atan2(end[1] - c[1], end[0] - c[0]);
  while (a1 <= a0) a1 += 2 * Math.PI; // CCW sweep start → end
  const am = (a0 + a1) / 2;
  return { u: c[0] + r * Math.cos(am), v: c[1] + r * Math.sin(am) };
}

/** Vertices of a regular `sides`-gon centred at `c`, with `first` as one vertex. */
export function regularPolygonVertices(
  c: readonly [number, number],
  first: readonly [number, number],
  sides: number,
): { u: number; v: number }[] {
  const r = Math.hypot(first[0] - c[0], first[1] - c[1]);
  const a0 = Math.atan2(first[1] - c[1], first[0] - c[0]);
  const out: { u: number; v: number }[] = [];
  for (let i = 0; i < sides; i++) {
    const a = a0 + (2 * Math.PI * i) / sides;
    out.push({ u: c[0] + r * Math.cos(a), v: c[1] + r * Math.sin(a) });
  }
  return out;
}

/** The six defining points of a slot: a straight centre line `a`→`b`, radius
 * `r`, with two parallel sides and two semicircular end caps. Null if degenerate. */
export interface SlotOutline {
  a1: { u: number; v: number }; // A, +normal side
  b1: { u: number; v: number }; // B, +normal side
  capB: { u: number; v: number }; // arc apex past B
  b2: { u: number; v: number }; // B, −normal side
  a2: { u: number; v: number }; // A, −normal side
  capA: { u: number; v: number }; // arc apex past A
}
export function slotOutline(
  a: readonly [number, number],
  b: readonly [number, number],
  r: number,
): SlotOutline | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || !(r > 0)) return null;
  const ux = dx / len;
  const uy = dy / len; // unit direction
  const nx = -uy;
  const ny = ux; // left normal
  return {
    a1: { u: a[0] + nx * r, v: a[1] + ny * r },
    b1: { u: b[0] + nx * r, v: b[1] + ny * r },
    capB: { u: b[0] + ux * r, v: b[1] + uy * r },
    b2: { u: b[0] - nx * r, v: b[1] - ny * r },
    a2: { u: a[0] - nx * r, v: a[1] - ny * r },
    capA: { u: a[0] - ux * r, v: a[1] - uy * r },
  };
}

/** Perpendicular distance from point `p` to the line through `a`,`b` (0 if a==b). */
export function perpDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / len;
}

/** Project `toward` onto the circle (centre `c`, radius `r`) — radial snap. */
export function projectToCircle(
  c: readonly [number, number],
  r: number,
  toward: readonly [number, number],
): { u: number; v: number } {
  const a = Math.atan2(toward[1] - c[1], toward[0] - c[0]);
  return { u: c[0] + r * Math.cos(a), v: c[1] + r * Math.sin(a) };
}

/** Index of point `id` in the points array (−1 if missing). */
function pointIndex(model: SketchModel, id: string): number {
  return model.points.findIndex((p) => p.id === id);
}

function line(model: SketchModel, id: string): LineEntity | undefined {
  return model.entities.find((e): e is LineEntity => e.id === id && e.kind === "line");
}

function circleIndex(model: SketchModel, id: string): number {
  return model.entities.filter((e) => e.kind === "circle").findIndex((e) => e.id === id);
}

function circleEntity(model: SketchModel, id: string): CircleEntity | undefined {
  return model.entities.find((e): e is CircleEntity => e.id === id && e.kind === "circle");
}

/** Bridge the id-based model to the kernel solver's index-based input. */
export function toSolverInput(model: SketchModel): {
  points: SolverPoint[];
  constraints: SolverConstraint[];
  circles: { center: number; radius: number }[];
} {
  const points: SolverPoint[] = model.points.map((p) => ({ x: p.u, y: p.v, fixed: p.fixed }));

  const circleEntities = model.entities.filter((e): e is CircleEntity => e.kind === "circle");
  const circles = circleEntities.map((c) => ({
    center: pointIndex(model, c.center),
    radius: c.radius,
  }));

  const constraints: SolverConstraint[] = [];
  for (const c of model.constraints) {
    // Driven (reference) dimensions don't constrain — they only report a value.
    if ("driven" in c && c.driven) continue;
    switch (c.kind) {
      case "horizontal": {
        const l = line(model, c.line);
        if (l)
          constraints.push({
            kind: "horizontal",
            a: pointIndex(model, l.a),
            b: pointIndex(model, l.b),
          });
        break;
      }
      case "vertical": {
        const l = line(model, c.line);
        if (l)
          constraints.push({
            kind: "vertical",
            a: pointIndex(model, l.a),
            b: pointIndex(model, l.b),
          });
        break;
      }
      case "coincident":
        constraints.push({
          kind: "coincident",
          a: pointIndex(model, c.a),
          b: pointIndex(model, c.b),
        });
        break;
      case "distance":
        constraints.push({
          kind: "distance",
          a: pointIndex(model, c.a),
          b: pointIndex(model, c.b),
          value: c.value,
        });
        break;
      case "hDistance":
        constraints.push({
          kind: "hDistance",
          a: pointIndex(model, c.a),
          b: pointIndex(model, c.b),
          value: c.value,
        });
        break;
      case "vDistance":
        constraints.push({
          kind: "vDistance",
          a: pointIndex(model, c.a),
          b: pointIndex(model, c.b),
          value: c.value,
        });
        break;
      case "parallel":
      case "perpendicular":
      case "equalLength": {
        const l1 = line(model, c.line1);
        const l2 = line(model, c.line2);
        if (l1 && l2) {
          const kind = c.kind === "equalLength" ? "equalLength" : c.kind;
          constraints.push({
            kind,
            a: pointIndex(model, l1.a),
            b: pointIndex(model, l1.b),
            c: pointIndex(model, l2.a),
            d: pointIndex(model, l2.b),
          });
        }
        break;
      }
      case "angle": {
        const l1 = line(model, c.line1);
        const l2 = line(model, c.line2);
        if (l1 && l2) {
          constraints.push({
            kind: "angle",
            a: pointIndex(model, l1.a),
            b: pointIndex(model, l1.b),
            c: pointIndex(model, l2.a),
            d: pointIndex(model, l2.b),
            value: c.value,
          });
        }
        break;
      }
      case "radius": {
        const ci = circleIndex(model, c.circle);
        if (ci >= 0) constraints.push({ kind: "radius", circle: ci, value: c.value });
        break;
      }
      case "diameter": {
        const ci = circleIndex(model, c.circle);
        // Diameter is a radius constraint at half the value.
        if (ci >= 0) constraints.push({ kind: "radius", circle: ci, value: c.value / 2 });
        break;
      }
      case "concentric": {
        const c1 = circleEntity(model, c.circle1);
        const c2 = circleEntity(model, c.circle2);
        if (c1 && c2) {
          constraints.push({
            kind: "concentric",
            a: pointIndex(model, c1.center),
            b: pointIndex(model, c2.center),
          });
        }
        break;
      }
      case "tangent": {
        const l = line(model, c.line);
        const ci = circleIndex(model, c.circle);
        if (l && ci >= 0) {
          constraints.push({
            kind: "tangentLineCircle",
            a: pointIndex(model, l.a),
            b: pointIndex(model, l.b),
            circle: ci,
          });
        }
        break;
      }
      case "midpoint": {
        const l = line(model, c.line);
        if (l) {
          constraints.push({
            kind: "midpoint",
            m: pointIndex(model, c.point),
            a: pointIndex(model, l.a),
            b: pointIndex(model, l.b),
          });
        }
        break;
      }
      case "pointOnObject": {
        const l = line(model, c.object);
        if (l) {
          constraints.push({
            kind: "pointOnLine",
            p: pointIndex(model, c.point),
            a: pointIndex(model, l.a),
            b: pointIndex(model, l.b),
          });
        } else {
          const ci = circleIndex(model, c.object);
          if (ci >= 0)
            constraints.push({ kind: "pointOnCircle", p: pointIndex(model, c.point), circle: ci });
        }
        break;
      }
      case "symmetric": {
        const l = line(model, c.axis);
        if (l) {
          constraints.push({
            kind: "symmetric",
            a: pointIndex(model, c.a),
            b: pointIndex(model, c.b),
            c: pointIndex(model, l.a),
            d: pointIndex(model, l.b),
          });
        }
        break;
      }
    }
  }
  return { points, constraints, circles };
}
