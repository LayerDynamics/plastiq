// The constrained-sketch model (SPEC-5 M3). This is the parametric graph the
// `sketch` feature persists in its `data` (per ADR-0013's principle: persist the
// constraints, derive the geometry). The kernel's `solveSketch` consumes a
// numeric-index form; this model uses stable string ids so the UI can reference
// points/entities/constraints directly. `toSolverInput` bridges the two.
//
// Geometry is derived: the solved point positions feed `rebuild.ts`'s profile
// (line/arc/circle wire), never stored as a dumb polyline.

import type {
  Constraint as SolverConstraint,
  SolverArc,
  SolverEllipse,
  SolverPoint,
  FaceRef,
} from "@plastiq/cad";

export type DatumPlaneId = "XY" | "XZ" | "YZ";

/** A sketch on a base datum (XY/XZ/YZ), shifted `offset` metres along its normal. */
export interface SketchDatumSpec {
  base: DatumPlaneId;
  /** Distance along the base plane's normal, in SI metres. */
  offset: number;
}

/** A sketch on a MODEL FACE's plane, shifted `offset` metres along the face
 * normal — re-resolved against the upstream solid at rebuild (parametric). */
export interface SketchFacePlaneSpec {
  kind: "face";
  face: FaceRef;
  offset: number;
}

/** A sketch feature's compiled `data.plane`, resolved to a kernel DatumPlane at
 * rebuild. Absent ⇒ XY at offset 0 (back-compat with pre-plane documents). */
export type SketchPlaneSpec = SketchDatumSpec | SketchFacePlaneSpec;

/** Discriminate the face variant (it needs the solid to resolve, unlike a datum). */
export function isFaceSketchPlane(spec: SketchPlaneSpec | undefined): spec is SketchFacePlaneSpec {
  return spec != null && "kind" in spec && spec.kind === "face";
}

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

/** A solver-native ellipse: centre + one focus + semi-minor radius. */
export interface EllipseEntity {
  id: string;
  kind: "ellipse";
  center: string;
  focus1: string;
  radmin: number;
  construction?: boolean;
}

/** A parametric derived offset of one sketch curve. `distance` is signed: a
 * positive line offset is to the curve's left; for closed curves it expands the
 * radius. The source remains the authority, so moving/solving it moves this
 * entity without baking a second, stale copy. */
export interface OffsetEntity {
  id: string;
  kind: "offset";
  source: string;
  distance: number;
  construction?: boolean;
}

/**
 * Sketch geometry kinds.
 *
 * Ellipses are native planegcs primitives. Offset curves are deliberately
 * DERIVED entities because planegcs has no offset primitive: they retain a
 * source id + signed distance and are resolved from the latest solved source for
 * rendering, picking, and profile extraction instead of pretending to be an
 * independently solvable curve.
 */
export type SketchEntity =
  | LineEntity
  | CircleEntity
  | ArcEntity
  | SplineEntity
  | EllipseEntity
  | OffsetEntity;

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
  | { id: string; kind: "lineAngle"; line: string; value: number; driven?: boolean }
  | { id: string; kind: "radius"; circle: string; value: number; driven?: boolean }
  | { id: string; kind: "diameter"; circle: string; value: number; driven?: boolean }
  | { id: string; kind: "concentric"; circle1: string; circle2: string }
  | { id: string; kind: "equalRadius"; curve1: string; curve2: string }
  | { id: string; kind: "tangent"; curve1: string; curve2: string }
  /** Backward-compatible shape persisted by pre-curve-tangency documents. */
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
  | "lineAngle"
  | "radius"
  | "diameter";

export interface SketchModel {
  plane: DatumPlaneId;
  /** Offset of the sketch plane along its base normal, in SI metres (default 0).
   * Optional so documents saved before sketch offsets still load (back-compat). */
  offset?: number;
  /** When set, the sketch is on this model FACE (offset along its normal) instead
   * of the base datum; `plane` is then an inert placeholder. */
  face?: FaceRef;
  points: SketchPoint[];
  entities: SketchEntity[];
  constraints: SketchConstraint[];
}

export function emptySketch(plane: DatumPlaneId = "XY", offset = 0): SketchModel {
  return { plane, offset, points: [], entities: [], constraints: [] };
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

function ellipseIndex(model: SketchModel, id: string): number {
  return model.entities.filter((e) => e.kind === "ellipse").findIndex((e) => e.id === id);
}

/** Exact plane-space ellipse axes derived from its planegcs representation. */
export function ellipseGeometry(
  model: SketchModel,
  ellipse: EllipseEntity,
): {
  center: [number, number];
  focus1: [number, number];
  majorRadius: number;
  minorRadius: number;
  majorDir: [number, number];
} | null {
  const c = model.points.find((p) => p.id === ellipse.center);
  const f = model.points.find((p) => p.id === ellipse.focus1);
  if (!c || !f || !(ellipse.radmin > 0)) return null;
  const du = f.u - c.u;
  const dv = f.v - c.v;
  const focal = Math.hypot(du, dv);
  if (focal <= 1e-12) return null;
  return {
    center: [c.u, c.v],
    focus1: [f.u, f.v],
    majorRadius: Math.hypot(focal, ellipse.radmin),
    minorRadius: ellipse.radmin,
    majorDir: [du / focal, dv / focal],
  };
}

/** Sample an exact ellipse for viewport rendering and pixel hit-testing. */
export function ellipsePoints(
  model: SketchModel,
  ellipse: EllipseEntity,
  segments = 96,
): [number, number][] {
  const g = ellipseGeometry(model, ellipse);
  if (!g) return [];
  const [ux, uy] = g.majorDir;
  const vx = -uy;
  const vy = ux;
  const out: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    out.push([
      g.center[0] + ux * g.majorRadius * Math.cos(t) + vx * g.minorRadius * Math.sin(t),
      g.center[1] + uy * g.majorRadius * Math.cos(t) + vy * g.minorRadius * Math.sin(t),
    ]);
  }
  return out;
}

export type ResolvedOffsetCurve =
  | { kind: "line"; a: [number, number]; b: [number, number] }
  | { kind: "circle"; center: [number, number]; radius: number }
  | { kind: "arc"; a: [number, number]; through: [number, number]; b: [number, number] }
  | { kind: "ellipse"; points: [number, number][] };

/** Resolve a derived offset against the latest source geometry. */
export function resolveOffsetCurve(
  model: SketchModel,
  offset: OffsetEntity,
): ResolvedOffsetCurve | null {
  const source = model.entities.find((e) => e.id === offset.source);
  if (!source || source.kind === "offset" || !Number.isFinite(offset.distance)) return null;
  const point = (id: string): [number, number] | null => {
    const p = model.points.find((q) => q.id === id);
    return p ? [p.u, p.v] : null;
  };
  if (source.kind === "line") {
    const a = point(source.a);
    const b = point(source.b);
    if (!a || !b) return null;
    const du = b[0] - a[0];
    const dv = b[1] - a[1];
    const len = Math.hypot(du, dv);
    if (len <= 1e-12) return null;
    const ou = (-dv / len) * offset.distance;
    const ov = (du / len) * offset.distance;
    return { kind: "line", a: [a[0] + ou, a[1] + ov], b: [b[0] + ou, b[1] + ov] };
  }
  if (source.kind === "circle") {
    const c = point(source.center);
    const radius = source.radius + offset.distance;
    return c && radius > 1e-12 ? { kind: "circle", center: c, radius } : null;
  }
  if (source.kind === "arc") {
    const a = point(source.a);
    const through = point(source.through);
    const b = point(source.b);
    if (!a || !through || !b) return null;
    const cc = circumcircle(a, b, through);
    if (!cc) return null;
    const radius = cc.r + offset.distance;
    if (radius <= 1e-12) return null;
    const shift = (p: [number, number]): [number, number] => {
      const du = p[0] - cc.u;
      const dv = p[1] - cc.v;
      const inv = 1 / Math.hypot(du, dv);
      return [cc.u + du * inv * radius, cc.v + dv * inv * radius];
    };
    return { kind: "arc", a: shift(a), through: shift(through), b: shift(b) };
  }
  if (source.kind === "ellipse") {
    const g = ellipseGeometry(model, source);
    if (!g) return null;
    const [ux, uy] = g.majorDir;
    const vx = -uy;
    const vy = ux;
    const points: [number, number][] = [];
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2;
      const ct = Math.cos(t);
      const st = Math.sin(t);
      const du = ux * g.majorRadius * ct + vx * g.minorRadius * st;
      const dv = uy * g.majorRadius * ct + vy * g.minorRadius * st;
      const nx0 = ux * (ct / g.majorRadius) + vx * (st / g.minorRadius);
      const ny0 = uy * (ct / g.majorRadius) + vy * (st / g.minorRadius);
      const inv = 1 / Math.hypot(nx0, ny0);
      points.push([
        g.center[0] + du + nx0 * inv * offset.distance,
        g.center[1] + dv + ny0 * inv * offset.distance,
      ]);
    }
    return { kind: "ellipse", points };
  }
  return null;
}

/** Bridge the id-based model to the kernel solver's index-based input. */
export function toSolverInput(model: SketchModel): {
  points: SolverPoint[];
  constraints: SolverConstraint[];
  circles: { center: number; radius: number }[];
  ellipses: SolverEllipse[];
  arcs: SolverArc[];
  arcEntityIds: string[];
} {
  const points: SolverPoint[] = model.points.map((p) => ({ x: p.u, y: p.v, fixed: p.fixed }));

  const circleEntities = model.entities.filter((e): e is CircleEntity => e.kind === "circle");
  const circles = circleEntities.map((c) => ({
    center: pointIndex(model, c.center),
    radius: c.radius,
  }));
  const ellipseEntities = model.entities.filter((e): e is EllipseEntity => e.kind === "ellipse");
  const ellipses: SolverEllipse[] = ellipseEntities.map((e) => ({
    center: pointIndex(model, e.center),
    focus1: pointIndex(model, e.focus1),
    radmin: e.radmin,
  }));
  const arcEntityIds: string[] = [];
  const arcs: SolverArc[] = [];
  for (const e of model.entities) {
    if (e.kind !== "arc") continue;
    const a = model.points.find((p) => p.id === e.a);
    const b = model.points.find((p) => p.id === e.b);
    const through = model.points.find((p) => p.id === e.through);
    if (!a || !b || !through) continue;
    const cc = circumcircle([a.u, a.v], [b.u, b.v], [through.u, through.v]);
    if (!cc) continue;
    const center = points.length;
    points.push({ x: cc.u, y: cc.v });
    arcs.push({
      center,
      start: pointIndex(model, e.a),
      end: pointIndex(model, e.b),
      radius: cc.r,
    });
    arcEntityIds.push(e.id);
  }
  const arcIndex = (id: string): number => arcEntityIds.indexOf(id);

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
      case "lineAngle": {
        const l = line(model, c.line);
        if (l)
          constraints.push({
            kind: "lineAngle",
            a: pointIndex(model, l.a),
            b: pointIndex(model, l.b),
            value: c.value,
          });
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
        if ("line" in c) {
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
        const c1 = circleIndex(model, c.curve1);
        const c2 = circleIndex(model, c.curve2);
        const a1 = arcIndex(c.curve1);
        const a2 = arcIndex(c.curve2);
        if (c1 >= 0 && c2 >= 0) constraints.push({ kind: "tangentCircles", a: c1, b: c2 });
        else if (a1 >= 0 && a2 >= 0) constraints.push({ kind: "tangentArcs", a: a1, b: a2 });
        else if (c1 >= 0 && a2 >= 0)
          constraints.push({ kind: "tangentArcCircle", circle: c1, arc: a2 });
        else if (c2 >= 0 && a1 >= 0)
          constraints.push({ kind: "tangentArcCircle", circle: c2, arc: a1 });
        else {
          const ids = [c.curve1, c.curve2];
          const lineId = ids.find((id) => line(model, id));
          const circleId = ids.find((id) => circleIndex(model, id) >= 0);
          const l = lineId ? line(model, lineId) : undefined;
          const ci = circleId ? circleIndex(model, circleId) : -1;
          if (l && ci >= 0)
            constraints.push({
              kind: "tangentLineCircle",
              a: pointIndex(model, l.a),
              b: pointIndex(model, l.b),
              circle: ci,
            });
        }
        break;
      }
      case "equalRadius": {
        const c1 = circleIndex(model, c.curve1);
        const c2 = circleIndex(model, c.curve2);
        const a1 = arcIndex(c.curve1);
        const a2 = arcIndex(c.curve2);
        if (c1 >= 0 && c2 >= 0) constraints.push({ kind: "equalRadius", a: c1, b: c2 });
        else if (a1 >= 0 && a2 >= 0) constraints.push({ kind: "equalRadiusArc", a: a1, b: a2 });
        else if (c1 >= 0 && a2 >= 0)
          constraints.push({ kind: "equalRadiusCircleArc", circle: c1, arc: a2 });
        else if (c2 >= 0 && a1 >= 0)
          constraints.push({ kind: "equalRadiusCircleArc", circle: c2, arc: a1 });
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
          else {
            const ei = ellipseIndex(model, c.object);
            if (ei >= 0)
              constraints.push({
                kind: "pointOnEllipse",
                p: pointIndex(model, c.point),
                ellipse: ei,
              });
          }
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
  return { points, constraints, circles, ellipses, arcs, arcEntityIds };
}
